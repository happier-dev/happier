import {
    SPAWN_SESSION_ERROR_DETAIL_KINDS,
    type ProviderErrorV1,
} from '@happier-dev/protocol';

import {
    SPAWN_SESSION_ERROR_CODES,
    type SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';

export function buildProviderSpawnErrorResult(
    error: ProviderErrorV1,
): Extract<SpawnSessionResult, { type: 'error' }> {
    return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: error.code,
        errorDetail: {
            kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.PROVIDER_ERROR,
            providerError: error,
        },
    };
}
