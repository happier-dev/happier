import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { CredentialRequestRedirectError } from '@happier-dev/cli-common/homeTarget';
import { isMachineStoppedAnsweringError, MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcTimeoutError';
import {
    DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE_ERROR_CODE,
    DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE,
    TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE,
} from './directTransferImportClient';

/**
 * The typed code a thrown transfer error keeps when a layer flattens it into a failure response: its own, else the
 * Machine timeout for an abort or deadline, so a caller can word "isn't answering" instead of the transport's text.
 */
export function readTransferFailureCode(error: unknown): string | undefined {
    if (error instanceof CredentialRequestRedirectError) return error.code;
    if (error && typeof error === 'object' && typeof (error as { errorCode?: unknown }).errorCode === 'string') {
        return (error as { errorCode: string }).errorCode;
    }
    return isMachineStoppedAnsweringError(error) ? MACHINE_RPC_TIMEOUT_ERROR_CODE : undefined;
}

/**
 * Why a finite transfer ended, in the words a transfer surface has for it. Every failure has exactly one reason, so a
 * status line never says only that something failed: the Machine stopped answering, the person did not approve it, a
 * permission refused it, its carrier is unavailable/interrupted, it is too large, the result is not known, or the
 * Machine could not take it. A carrier failure is not evidence of a Machine-side refusal.
 */
export type TransferFailureReason =
    | 'unreachable' | 'carrierUnavailable' | 'carrierInterrupted' | 'declined' | 'accessRefused' | 'teamSignIn'
    | 'updateRequired' | 'executionUnavailable' | 'permission' | 'tooLarge' | 'sourceUnavailable' | 'sessionUnavailable' | 'unconfirmed' | 'other';

const REACHABILITY_CODES: ReadonlySet<string> = new Set([MACHINE_RPC_TIMEOUT_ERROR_CODE, 'server_unreachable', 'home_unreachable']);
// Happier refused this caller's access (its credential, grant or role), so only the owner can change it.
const ACCESS_REFUSED_CODES: ReadonlySet<string> = new Set([
    RPC_ERROR_CODES.FORBIDDEN, 'credential_scope_denied', 'forbidden', 'access_denied', 'role_policy_denied',
    'project_context_access_denied',
]);
// The Machine's own file system refused the write.
const PERMISSION_CODES: ReadonlySet<string> = new Set(['permission_denied', 'EACCES', 'EPERM']);
// An acknowledgement that never arrived, or a finalize the Machine may have committed: the result is not known.
const UNCONFIRMED_CODES: ReadonlySet<string> = new Set([
    'outcome_uncertain', 'outcome_unknown', 'action_outcome_unknown', 'approval_execution_outcome_unknown', 'indeterminate',
    DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE_ERROR_CODE, DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE,
    TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE,
]);
const TOO_LARGE_CODE = /too_large|max_bytes|quota_exceeded/i;

/**
 * The one place a transfer failure's typed code (a failure response's `errorCode`, or what a thrown transfer error
 * keeps) becomes a reason. A transport's own abort or deadline that the person did not cause is the Machine not
 * answering (the caller checks its own cancellation first); a code this does not name is `other`, never a guess.
 */
export function classifyTransferFailure(failure: Readonly<{ errorCode?: string | undefined; thrown?: unknown }>): TransferFailureReason {
    const code = failure.errorCode ?? readTransferFailureCode(failure.thrown);
    if (code === undefined) return 'other';
    if (code === 'attachment_source_unavailable') return 'sourceUnavailable';
    if (code === 'attachment_session_unavailable') return 'sessionUnavailable';
    if (code === 'machine_carrier_unavailable') return 'carrierUnavailable';
    if (code === 'machine_carrier_transport_failed') return 'carrierInterrupted';
    if (REACHABILITY_CODES.has(code)) return 'unreachable';
    if ((isActionApprovalDeclinedErrorCode(code) || code === 'approval_stale')) return 'declined';
    if (ACCESS_REFUSED_CODES.has(code)) return 'accessRefused';
    if (code === RPC_ERROR_CODES.TEAM_AUTHENTICATION_REQUIRED) return 'teamSignIn';
    if (code === RPC_ERROR_CODES.UPDATE_REQUIRED) return 'updateRequired';
    if (code === 'agent_isolation_unavailable') return 'executionUnavailable';
    if (PERMISSION_CODES.has(code)) return 'permission';
    if (UNCONFIRMED_CODES.has(code)) return 'unconfirmed';
    return TOO_LARGE_CODE.test(code) ? 'tooLarge' : 'other';
}
