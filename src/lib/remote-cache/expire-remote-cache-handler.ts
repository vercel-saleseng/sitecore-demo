import { getCache } from '@vercel/functions';
import type { NextApiRequest, NextApiResponse } from 'next';

export function createExpireRemoteCacheHandler(
  secret: string
): (req: NextApiRequest, res: NextApiResponse) => void {
  return async function handler(req, res) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', ['POST']);
      return res.status(405).json({ success: false, message: `Method ${req.method} Not Allowed` });
    }

    const urlSecret = req.query.secret as string;
    const tag = req.query.tag as string;

    if (!urlSecret || urlSecret !== secret) {
      return res
        .status(401)
        .json({ success: false, message: 'Unauthorized: Invalid secret parameter' });
    }

    if (!tag) {
      return res
        .status(400)
        .json({ success: false, message: 'Bad Request: Missing tag parameter' });
    }

    const cache = getCache();
    await cache.expireTag(tag);

    return res.status(200).json({
      success: true,
    });
  };
}
