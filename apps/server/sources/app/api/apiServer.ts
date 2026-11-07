import fastify from 'fastify';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { SERVER_HTTP_KEEP_ALIVE_TIMEOUT_MS_V1 } from '@happier-dev/protocol/server/http/connectionLifetimeV1';
import { ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { logger } from '@/utils/logging/log';
import { resolveApiTrustProxy } from './utils/apiRateLimitPolicy';

/** The HTTP server construction shared by Home startup and route-level checks. */
export function createApiServer() {
    const trustProxy = resolveApiTrustProxy(process.env);
    return fastify({
        loggerInstance: logger,
        bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
        // Deployment ids share the operation-id schema's UTF-16
        // ceiling (also exported for request ids), the largest bounded route id.
        // A BMP unit can occupy three UTF-8 bytes, each percent-encoded as %XX.
        // This also covers code-point-bounded Session/Automation ids in full.
        routerOptions: {
            maxParamLength: ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1 * encodeURIComponent('\uFFFF').length,
        },
        keepAliveTimeout: SERVER_HTTP_KEEP_ALIVE_TIMEOUT_MS_V1,
        forceCloseConnections: 'idle',
        ...(typeof trustProxy !== 'undefined' ? { trustProxy } : null),
    });
}
