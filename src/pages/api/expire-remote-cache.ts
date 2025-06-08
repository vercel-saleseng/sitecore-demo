import { createExpireRemoteCacheHandler } from 'lib/remote-cache/expire-remote-cache-handler';

const handler = createExpireRemoteCacheHandler(process.env.EXPIRE_REMOTE_CACHE_SECRET!);

export default handler;
