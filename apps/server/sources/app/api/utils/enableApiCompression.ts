import compress from '@fastify/compress';
import type { FastifyBaseLogger, FastifyInstance, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from 'fastify';

import { isServerApiPathname } from './serverApiPath';

export async function enableApiCompression<Logger extends FastifyBaseLogger>(
    app: FastifyInstance<RawServerDefault, RawRequestDefaultExpression, RawReplyDefaultExpression, Logger>,
): Promise<void> {
    const encodings = ['br', 'gzip', 'identity'] satisfies NonNullable<Parameters<typeof compress>[1]['encodings']>;
    app.addHook('onRoute', (route) => {
        // UI sidecars and Engine.IO own their encodings and streaming lifetimes.
        if (!isServerApiPathname(route.url)
            || route.url === '/v1/updates'
            || route.url.startsWith('/v1/updates/')) {
            route.compress = false;
        } else if (route.url === '/v2/usage/query-batch' && route.compress !== false) {
            // Finite Usage batches carry JSON lines, which the MIME database
            // does not classify as compressible. Other API types keep defaults.
            route.compress = {
                // Route options are normalized with plugin defaults, so carry
                // the API encoding policy rather than enabling extra codecs.
                encodings,
                ...(typeof route.compress === 'object' ? route.compress : {}),
                customTypes: /^application\/x-ndjson(?:\s*;|$)/i,
            };
        }
    });

    await app.register(compress, {
        globalDecompression: false,
        encodings,
        // Retain the plugin's 1 KiB threshold, Brotli quality 4 and gzip defaults.
        // Incremental API streams opt out at their route owner with compress: false.
    });
}
