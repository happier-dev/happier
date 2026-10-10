import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';

import { t } from '@/text';

/**
 * The one sentence a filesystem listing failure gives as its cause, for the tree's root state and for a
 * folder inside it. The raw error stays on the diagnostic channel; it is never the sentence.
 */
export function resolveFilesystemErrorReason(error: string | null | undefined): string {
    if (error === RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE || error === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return t('errors.daemonUnavailableBody');
    if (error === 'EACCES' || error === 'EPERM' || error === RPC_ERROR_CODES.FORBIDDEN) return t('errors.permissionDenied');
    if (error === MACHINE_RPC_TIMEOUT_ERROR_CODE) return t('errors.connectionTimeout');
    if (error === 'MACHINE_RPC_UNREACHABLE') return t('errors.networkError');
    if (error === 'not_authenticated' || error === RPC_ERROR_CODES.TEAM_AUTHENTICATION_REQUIRED) return t('errors.authenticationFailed');
    if (error === 'MACHINE_RPC_INVALID_RESPONSE') return t('errors.invalidFormat');
    if (error === 'ENOENT') return t('errors.fileNotFound');
    return t('errors.operationFailed');
}
