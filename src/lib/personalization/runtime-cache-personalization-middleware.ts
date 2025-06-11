import {
  PersonalizeMiddleware,
  PersonalizeMiddlewareConfig,
} from '@sitecore-jss/sitecore-jss-nextjs/middleware';
import {
  GraphQLPersonalizeService,
  PersonalizeInfo,
  getPersonalizedRewrite,
} from '@sitecore-jss/sitecore-jss/personalize';
import { debug } from '@sitecore-jss/sitecore-jss';
import { NextRequest, NextResponse } from 'next/server';
import { personalize } from '@sitecore-cloudsdk/personalize/server';
import { ExperienceParams } from '@sitecore-jss/sitecore-jss-nextjs/types/middleware/personalize-middleware';
import { getCache } from '@vercel/functions';

const REWRITE_HEADER_NAME = 'x-sc-rewrite';

interface CacheConfig {
  // Time to live in seconds
  ttl?: number;
  // Cache tags for invalidation
  tag?: string;
}

const DEFAULT_CACHE_CONFIG = {
  ttl: 60 * 60 * 24,
  tag: 'refresh-personalize',
} as const;

type PersonalizeOptions = {
  geo?: {
    city?: string;
    country?: string;
    region?: string;
  };
};

type RuntimeCachePersonalizeMiddlewareConfig = PersonalizeMiddlewareConfig & {
  cacheConfig?: CacheConfig;
};

export class RuntimeCachePersonalizationMiddleware extends PersonalizeMiddleware {
  private sitePersonalizeService: GraphQLPersonalizeService;
  private cacheOptions: {
    ttl: number;
    tags: string[];
  };

  constructor(protected config: RuntimeCachePersonalizeMiddlewareConfig) {
    super(config);

    this.sitePersonalizeService = new GraphQLPersonalizeService({
      ...config.edgeConfig,
      fetch: fetch,
    });

    this.cacheOptions = {
      ttl: config.cacheConfig?.ttl ?? DEFAULT_CACHE_CONFIG.ttl,
      tags: config.cacheConfig?.tag ? [...config.cacheConfig.tag] : [...DEFAULT_CACHE_CONFIG.tag],
    };
  }

  public getHandler(): (
    req: NextRequest,
    res?: NextResponse,
    options?: PersonalizeOptions
  ) => Promise<NextResponse> {
    return async (req, res, options) => {
      try {
        return await this.personalizeHandler(req, res, options);
      } catch (error) {
        console.log('Personalize middleware failed:');
        console.log(error);
        return res || NextResponse.next();
      }
    };
  }

  private personalizeHandler = async (
    req: NextRequest,
    res?: NextResponse,
    options?: PersonalizeOptions
  ): Promise<NextResponse> => {
    const pathname = req.nextUrl.pathname;
    const language = this.getLanguage(req);
    const hostname = this.getHostHeader(req) || this.defaultHostname;
    const startTimestamp = Date.now();
    const timeout = this.config.cdpConfig.timeout;

    let response = res || NextResponse.next();

    debug.personalize('personalize middleware start: %o', {
      pathname,
      language,
      hostname,
      headers: this.extractDebugHeaders(req.headers),
    });

    if (this.config.disabled && this.config.disabled(req, response)) {
      debug.personalize('skipped (personalize middleware is disabled)');
      return response;
    }

    if (response.redirected || this.isPreview(req) || this.excludeRoute(pathname)) {
      debug.personalize(
        'skipped (%s)',
        response.redirected ? 'redirected' : this.isPreview(req) ? 'preview' : 'route excluded'
      );
      return response;
    }

    const site = this.getSite(req, response);

    const cache = getCache();

    const cacheKey = `personalize:${pathname}:${language}:${site.name}`;

    let personalizeInfo = (await cache.get(cacheKey)) as PersonalizeInfo | undefined;

    if (!personalizeInfo) {
      console.info('Personalize info not in runtime cache. Retrieving information from Sitecore');
      personalizeInfo = await this.sitePersonalizeService.getPersonalizeInfo(
        pathname,
        language,
        site.name
      );
      await cache.set(cacheKey, personalizeInfo, this.cacheOptions);
    }

    if (!personalizeInfo) {
      debug.personalize('skipped (personalize info not found)');
      return response;
    }

    if (personalizeInfo.variantIds.length === 0) {
      debug.personalize('skipped (no personalization configured)');
      return response;
    }

    if (this.isPrefetch(req)) {
      debug.personalize('skipped (prefetch)');
      response.headers.set('x-middleware-cache', 'no-cache');
      return response;
    }

    await this.initPersonalizeServer({
      hostname,
      siteName: site.name,
      request: req,
      response,
    });

    const params = this.getExperienceParams(req);
    const executions = this.getPersonalizeExecutions(personalizeInfo, language);
    const identifiedVariantIds: string[] = [];

    await Promise.all(
      executions.map((execution) =>
        this.personalize(
          {
            friendlyId: execution.friendlyId,
            variantIds: execution.variantIds,
            params,
            language,
            timeout,
            options,
          },
          req
        ).then((personalization) => {
          const variantId = personalization.variantId;
          if (variantId) {
            if (!execution.variantIds.includes(variantId)) {
              debug.personalize('invalid variant %s', variantId);
            } else {
              identifiedVariantIds.push(variantId);
            }
          }
        })
      )
    );

    if (identifiedVariantIds.length === 0) {
      debug.personalize('skipped (no variant(s) identified)');
      return response;
    }

    const basePath = res?.headers.get(REWRITE_HEADER_NAME) || pathname;

    const rewritePath = getPersonalizedRewrite(basePath, identifiedVariantIds);
    response = this.rewrite(rewritePath, req, response);

    response.headers.set('x-middleware-cache', 'no-cache');

    debug.personalize('personalize middleware end in %dms: %o', Date.now() - startTimestamp, {
      rewritePath,
      headers: this.extractDebugHeaders(response.headers),
    });

    return response;
  };

  protected async personalize(
    {
      params,
      friendlyId,
      language,
      timeout,
      variantIds,
      options,
    }: {
      params: ExperienceParams;
      friendlyId: string;
      language: string;
      timeout?: number;
      variantIds?: string[];
      options?: PersonalizeOptions;
    },
    request: NextRequest
  ) {
    debug.personalize('executing experience for %s %o', friendlyId, params);

    return (await personalize(
      request,
      {
        channel: this.config.cdpConfig.channel || 'WEB',
        currency: this.config.cdpConfig.currency ?? 'USD',
        friendlyId,
        params,
        language,
        pageVariantIds: variantIds,
        geo: options?.geo,
      },
      { timeout }
    )) as {
      variantId: string;
    };
  }
}
