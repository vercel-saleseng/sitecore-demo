import { type NextRequest } from "next/server"
import { GraphQLRedirectsService, RedirectInfo } from "@sitecore-jss/sitecore-jss/site"
import { RedirectsMiddleware, type RedirectsMiddlewareConfig } from "@sitecore-jss/sitecore-jss-nextjs/middleware"
import { NextURL } from "next/dist/server/web/next-url"
import { getCache } from '@vercel/functions';
import { areURLSearchParamsEqual, escapeNonSpecialQuestionMarks, isRegexOrUrl } from "@sitecore-jss/sitecore-jss/utils";

interface CacheConfig {
  // Cache key
  key?: string;
  // Time to live in seconds
  ttl?: number; 
  // Cache tags for invalidation
  tag?: string; 
  // User-friendly name for the cache entry used for o11y
  name?: string;
}

/**
 * Default cache configuration
 * - key: 'redirects' - Default cache key for storing redirects
 * - ttl: 86400 (24 hours) - Default time to live in seconds
 * - tags: ['refresh-redirects'] - Default cache tags for invalidation
 * - name: 'redirect-urls' - Default name for observability
 */
const DEFAULT_CACHE_CONFIG = {
  key: 'redirects',
  ttl: 60 * 60 * 24,
  tag: 'refresh-redirects',
  name: "redirect-urls", 
} as const;

type RuntimeCacheRedirectsMiddlewareConfig = RedirectsMiddlewareConfig & {
  cacheConfig?: CacheConfig;
};

type RedirectResult = RedirectInfo & { matchedQueryString?: string };

export class RuntimeCacheRedirectsMiddleware extends RedirectsMiddleware {
  private siteRedirectsService: GraphQLRedirectsService;
  private siteLocales: string[];
  private cacheKey: string;
  private cacheOptions: {
    ttl: number;
    tags: string[];
    name: string;
  };

  constructor(protected config: RuntimeCacheRedirectsMiddlewareConfig) {
    super(config)
    this.siteRedirectsService = new GraphQLRedirectsService({ ...config, fetch: fetch });
    this.siteLocales = config.locales;
    this.cacheKey = config.cacheConfig?.key ?? DEFAULT_CACHE_CONFIG.key;
    this.cacheOptions = {
      ttl: config.cacheConfig?.ttl ?? DEFAULT_CACHE_CONFIG.ttl,
      tags: config.cacheConfig?.tag ? [config.cacheConfig.tag] : [DEFAULT_CACHE_CONFIG.tag],
      name: config.cacheConfig?.name ?? DEFAULT_CACHE_CONFIG.name,
    };
  }

  protected async getExistsRedirect(
    req: NextRequest,
    siteName: string
  ): Promise<RedirectResult | undefined> {
    const { pathname: incomingURL, search: incomingQS = '' } = this.normalizeURL(
      req.nextUrl.clone()
    );
    const locale = this.getLanguage(req);
    const normalizedPath = incomingURL.replace(/\/*$/gi, '');

    const cache = getCache();

    let redirects = (await cache.get(this.cacheKey)) as RedirectInfo[] | null;

    if (!redirects) {
      console.info('Redirects not in runtime cache. Retrieving redirects from Sitecore');
      redirects = await this.siteRedirectsService.fetchRedirects(siteName);
      await cache.set("redirects", redirects, this.cacheOptions);
    }

    const language = this.getLanguage(req);
    const modifyRedirects = structuredClone(redirects);
    let matchedQueryString: string | undefined;
    const localePath = `/${locale.toLowerCase()}${normalizedPath}`;

    return modifyRedirects.length
      ? modifyRedirects.find((redirect: RedirectResult) => {
          if (isRegexOrUrl(redirect.pattern) === 'url') {
            const urlArray = redirect.pattern.endsWith('/')
              ? redirect.pattern.slice(0, -1).split('?')
              : redirect.pattern.split('?');
            const patternQS = urlArray[1];
            let patternPath = urlArray[0];

            const patternParts = patternPath.split('/');
            const maybeLocale = patternParts[1].toLowerCase();
            
            if (new RegExp(this.siteLocales.join('|'), 'i').test(maybeLocale)) {
              patternPath = patternPath.replace(`/${patternParts[1]}`, `/${maybeLocale}`);
            }
            return (
              (patternPath === localePath || patternPath === normalizedPath) &&
              (!patternQS ||
                areURLSearchParamsEqual(
                  new URLSearchParams(patternQS),
                  new URLSearchParams(incomingQS)
                ))
            );
          }

          redirect.pattern = escapeNonSpecialQuestionMarks(
            redirect.pattern.replace(new RegExp(`^[^]?/${language}/`, 'gi'), '')
          );

          redirect.pattern = `/^\/${redirect.pattern
            .replace(/^\/|\/$/g, '') // Removes leading and trailing slashes
            .replace(/^\^\/|\/\$$/g, '') // Removes unnecessary start (^) and end ($) anchors
            .replace(/^\^|\$$/g, '') // Further cleans up anchors
            .replace(/\$\/gi$/g, '')}[\/]?$/i`; // Ensures the pattern allows an optional trailing slash

          matchedQueryString = [
            new RegExp(redirect.pattern).test(`${localePath}${incomingQS}`),
            new RegExp(redirect.pattern).test(`${normalizedPath}${incomingQS}`),
          ].some(Boolean)
            ? incomingQS
            : undefined;

          redirect.matchedQueryString = matchedQueryString || '';
          return (
            !!(
              new RegExp(redirect.pattern).test(`/${req.nextUrl.locale}${incomingURL}`) ||
              new RegExp(redirect.pattern).test(incomingURL) ||
              matchedQueryString
            ) && (redirect.locale ? redirect.locale.toLowerCase() === locale.toLowerCase() : true)
          );
        })
      : undefined;
  }

  private normalizeURL(url: NextURL): NextURL {
    if (!url.search) {
      return url;
    }

    const splittedPathname = url.pathname
      .split('/')
      .filter((route: string) => route)
      .map((route) => `path=${route}`);

    const newQueryString = url.search
      .replace(/^\?/, '')
      .split('&')
      .filter((param) => {
        if (!splittedPathname.includes(param)) {
          return param;
        }
        return false;
      })
      .join('&');

    const newUrl = new URL(`${url.pathname.toLowerCase()}?${newQueryString}`, url.origin);

    url.search = newUrl.search;
    url.pathname = newUrl.pathname.toLowerCase();
    url.href = newUrl.href;

    return url;
  }
}
