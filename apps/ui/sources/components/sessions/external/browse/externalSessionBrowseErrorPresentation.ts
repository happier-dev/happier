import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { ExternalSessionsRpcErrorCode } from '@happier-dev/protocol/sessions/external/rpcErrorCodes';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { t } from '@/text';

export type ExternalSessionBrowseOperation = 'list' | 'link' | 'delete';

function fallbackMessage(operation: ExternalSessionBrowseOperation): string {
    switch (operation) {
        case 'link':
            return t('externalSessions.browseLinkFailed');
        case 'delete':
            return t('externalSessions.browseDeleteCandidateFailed');
        case 'list':
            return t('externalSessions.browseFailedToLoad');
    }
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
        case 'agent_timeout':
            return t('externalSessions.browseAgentTimedOut');
        case 'agent_error':
            return t('externalSessions.browseAgentFailed');
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
