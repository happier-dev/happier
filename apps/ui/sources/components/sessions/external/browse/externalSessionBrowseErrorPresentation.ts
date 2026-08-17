import {
    RPC_ERROR_CODES,
    type ExternalSessionsRpcErrorCode,
} from '@happier-dev/protocol';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { t } from '@/text';

export type ExternalSessionBrowseOperation = 'list' | 'link';

function fallbackMessage(operation: ExternalSessionBrowseOperation): string {
    return t(operation === 'link'
        ? 'externalSessions.browseLinkFailed'
        : 'externalSessions.browseFailedToLoad');
}

export function resolveExternalSessionBrowseRpcErrorMessage(
    errorCode: ExternalSessionsRpcErrorCode,
    operation: ExternalSessionBrowseOperation,
): string {
    switch (errorCode) {
        case 'machine_offline':
            return t('newSession.machineOfflineInlineBody');
        case 'agent_unavailable':
            return t('externalSessions.browseAgentUnavailable');
        case 'invalid_request':
        case 'internal_error':
            return fallbackMessage(operation);
    }
}

export function resolveExternalSessionBrowseThrownErrorMessage(
    error: unknown,
    operation: ExternalSessionBrowseOperation,
): string {
    const rpcErrorCode = readRpcErrorCode(error);
    const transportCode = error && typeof error === 'object'
        ? (error as { code?: unknown }).code
        : null;
    if (
        rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        || rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
        || transportCode === 'MACHINE_RPC_TIMEOUT'
    ) {
        return t('newSession.daemonRpcUnavailableBody');
    }
    return fallbackMessage(operation);
}
