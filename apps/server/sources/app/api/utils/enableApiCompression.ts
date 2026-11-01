import compress from '@fastify/compress';
import type { FastifyBaseLogger, FastifyInstance, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from 'fastify';

import { isServerApiPathname } from './serverApiPath';

export async function enableApiCompression<Logger extends FastifyBaseLogger>(
    app: FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, Logger>,
): Promise<void> {
    app.addHook('onRoute', (route) => {
        // UI sidecars and Engine.IO own their encodings and streaming lifetimes.
        if (!isServerApiPathname(route.url)
            || route.url === '/v1/updates'
            || route.url.startsWith('/v1/updates/')) {
            route.compress = false;
        }
    });

    await app.register(compress, {
        globalDecompression: false,
        encodings: ['br', 'gzip', 'identity'],
        // Keep the plugin's 1 KiB threshold, Brotli quality 4 and zlib defaults.
        // Streaming API routes can opt out with compress: false.
    });
}
