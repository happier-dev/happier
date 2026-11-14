import { core } from 'zod/mini';

import { HappyError } from '@/utils/errors/errors';
import { ACCOUNT_MODE_DOWNGRADE_UNVERIFIED } from '@happier-dev/sync-client';

export type AccountStorageCurrentnessUnavailableReason =
    | 'encryption-material-unavailable'
    | 'scope-retired'
    | 'unauthorized'
    | 'forbidden'
    | 'unsupported'
    | 'unreachable';

/** The Account-storage owner’s typed currentness refusal, shared by readers and custody adapters. */
export class AccountStorageCurrentnessUnavailableError extends Error {
    constructor(
        readonly cause?: unknown,
        readonly reason: AccountStorageCurrentnessUnavailableReason = 'unreachable',
        readonly code: 'account_storage_currentness_unavailable' | 'action_home_signed_out' = 'account_storage_currentness_unavailable',
    ) {
        super(code === 'action_home_signed_out' ? code : 'Account storage currentness is unavailable');
        this.name = 'AccountStorageCurrentnessUnavailableError';
    }
}

export type AccountStorageReadFailureReason = AccountStorageCurrentnessUnavailableReason
    | 'cancelled'
    | 'account-mode-mismatch'
    | 'invalid-stored-content';

function authorizationDenialReason(error: unknown): 'unauthorized' | 'forbidden' | null {
    if (!(error instanceof HappyError)) return null;
    return error.status === 401 ? 'unauthorized' : error.status === 403 ? 'forbidden' : null;
}

/** Private catalog readers share the Account admission boundary, not an offline fallback. */
export function classifyAccountStorageReadFailure(error: unknown, signal?: AbortSignal): AccountStorageReadFailureReason {
    if (signal?.aborted) return 'cancelled';
    if (error instanceof AccountStorageCurrentnessUnavailableError) return error.reason;
    const denial = authorizationDenialReason(error);
    if (denial) return denial;
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code
        : error instanceof Error ? error.message : undefined;
    switch (code) {
        case 'action_account_scope_changed': case 'action_home_not_found': case 'scope-retired':
            return 'scope-retired';
        case 'action_home_signed_out': case 'unauthorized': return 'unauthorized';
        case 'forbidden': case 'unsupported': case 'account-mode-mismatch': case 'encryption-material-unavailable':
        case 'invalid-stored-content': return code;
        case 'account_storage_currentness_unavailable': case 'account_encryption_currentness_unavailable':
        case 'account-encryption-recovery-required': case 'account_settings_encryption_material_unavailable':
        case ACCOUNT_MODE_DOWNGRADE_UNVERIFIED:
            return 'encryption-material-unavailable';
        case 'account_settings_content_invalid': case 'account_settings_content_unreadable':
            return 'invalid-stored-content';
        default: return error instanceof core.$ZodError ? 'invalid-stored-content' : 'unreachable';
    }
}
