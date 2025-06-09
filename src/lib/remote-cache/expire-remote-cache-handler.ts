import { getCache } from '@vercel/functions';
import type { NextApiRequest, NextApiResponse } from 'next';

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ success: false, message: `Method ${req.method} Not Allowed` });
  }

  const headerSecret = req.headers['x-remote-cache-secret'] as string;
  const tag = req.query.tag as string;

  if (!headerSecret || headerSecret !== process.env.EXPIRE_REMOTE_CACHE_SECRET) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid secret header' });
  }

  if (!tag) {
    return res.status(400).json({ success: false, message: 'Bad Request: Missing tag parameter' });
  }

  const cache = getCache();
  await cache.expireTag(tag);

  return res.status(200).json({
    success: true,
  });
}
