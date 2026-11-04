import { EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES_V2, EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES_V2, EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2 } from '@happier-dev/protocol/actions/externalActionLimits';

export const DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE = EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2;

export function resolveSocketMaxHttpBufferSizeFromEnv(env: Record<string, string | undefined>): number {
    const raw = (env.HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE ?? env.HAPPY_SOCKET_MAX_HTTP_BUFFER_SIZE ?? '').trim();
    if (!raw) return DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SOCKET_MAX_HTTP_BUFFER_SIZE;
    if (
        parsed < EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES_V2
        || parsed < EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES_V2
    ) {
        throw new Error(
            'Socket.IO maxHttpBufferSize must be at least '
            + EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES_V2
            + ' bytes for external Action relay requests and '
            + EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES_V2
            + ' bytes for responses',
        );
    }
    return parsed;
}
