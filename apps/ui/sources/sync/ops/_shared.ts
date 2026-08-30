import {
    SPAWN_SESSION_ERROR_CODES,
    normalizeSpawnSessionErrorDetail as normalizeProtocolSpawnSessionErrorDetail,
    type SpawnSessionErrorCode,
    type SpawnSessionErrorDetail,
    type SpawnSessionResult,
} from '@happier-dev/protocol';
import { isSocketIoAckTimeoutError } from '@/sync/runtime/socketIoAckTimeout';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSpawnSessionErrorCode(value: unknown): value is SpawnSessionErrorCode {
    if (typeof value !== 'string') return false;
    return (Object.values(SPAWN_SESSION_ERROR_CODES) as string[]).includes(value);
}

/**
 * Carry only a RECOGNIZED structured spawn-error detail through normalization. Unknown/legacy detail
 * shapes are dropped so the UI never reacts to a detail it cannot interpret (D2: additive + safe).
 */
function normalizeSpawnSessionErrorDetail(value: unknown): SpawnSessionErrorDetail | undefined {
    return normalizeProtocolSpawnSessionErrorDetail(value);
}

function buildSpawnSessionErrorResult(params: Readonly<{
    errorCode: SpawnSessionErrorCode;
    errorMessage: string;
    errorDetail?: unknown;
}>): Extract<SpawnSessionResult, { type: 'error' }> {
    const errorDetail = normalizeSpawnSessionErrorDetail(params.errorDetail);
    return {
        type: 'error',
        errorCode: params.errorCode,
        errorMessage: params.errorMessage,
        ...(errorDetail ? { errorDetail } : {}),
    };
}

function normalizeSpawnSessionSuccess(record: Record<string, unknown>): Extract<SpawnSessionResult, { type: 'success' }> {
    const sessionId = typeof record.sessionId === 'string' && record.sessionId.trim().length > 0
        ? record.sessionId.trim()
        : typeof record.sid === 'string' && record.sid.trim().length > 0
            ? record.sid.trim()
            : undefined;
    const spawnNonce = typeof record.spawnNonce === 'string' && record.spawnNonce.trim().length > 0
        ? record.spawnNonce.trim()
        : undefined;
    const sessionIdStatus =
        record.sessionIdStatus === 'pending' || record.sessionIdStatus === 'available'
            ? record.sessionIdStatus
            : record.status === 'pending'
                ? 'pending'
            : undefined;
    const pendingFirstInputAccepted = typeof record.pendingFirstInputAccepted === 'boolean'
        ? record.pendingFirstInputAccepted
        : undefined;
    return {
        type: 'success',
        ...(sessionId ? { sessionId } : {}),
        ...(spawnNonce ? { spawnNonce } : {}),
        ...(sessionIdStatus ? { sessionIdStatus } : {}),
        ...(pendingFirstInputAccepted !== undefined ? { pendingFirstInputAccepted } : {}),
    };
}

export function normalizeSpawnSessionResult(value: unknown): SpawnSessionResult {
    if (!isPlainObject(value)) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'Malformed spawn result',
        };
    }

    const type = value.type;
    if (type === 'success') {
        return normalizeSpawnSessionSuccess(value);
    }

    if (type === 'requestToApproveDirectoryCreation') {
        const directory = typeof value.directory === 'string' ? value.directory : '';
        if (!directory) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'Missing directory in spawn result',
            };
        }
        return { type: 'requestToApproveDirectoryCreation', directory };
    }

    if (type === 'error') {
        const errorCode = isSpawnSessionErrorCode(value.errorCode)
            ? value.errorCode
            : SPAWN_SESSION_ERROR_CODES.UNEXPECTED;
        const errorMessage = typeof value.errorMessage === 'string' ? value.errorMessage : 'Failed to spawn session';
        return buildSpawnSessionErrorResult({ errorCode, errorMessage, errorDetail: value.errorDetail });
    }

    if (value.success === false || value.ok === false) {
        const errorCode = isSpawnSessionErrorCode(value.errorCode)
            ? value.errorCode
            : SPAWN_SESSION_ERROR_CODES.UNEXPECTED;
        const errorMessage = typeof value.errorMessage === 'string'
            ? value.errorMessage
            : typeof value.error === 'string'
                ? value.error
                : 'Failed to spawn session';
        return buildSpawnSessionErrorResult({ errorCode, errorMessage, errorDetail: value.errorDetail });
    }

    if (value.success === true || value.ok === true) {
        const nested =
            isPlainObject(value.result)
                ? value.result
                : isPlainObject(value.data)
                    ? value.data
                    : null;
        if (nested) {
            const normalizedNested = normalizeSpawnSessionResult(nested);
            if (normalizedNested.type !== 'error' || normalizedNested.errorMessage !== 'Unknown spawn result type') {
                return normalizedNested;
            }
        }

        return normalizeSpawnSessionSuccess(value);
    }

    return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Unknown spawn result type',
    };
}
