import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export type BranchSwitchSetting = 'ask' | 'always_bring' | 'always_stash';

export function normalizeBranchSwitchSetting(value: unknown): BranchSwitchSetting {
    if (value === 'always_bring' || value === 'always_stash' || value === 'ask') return value;
    return 'ask';
}

export function hasUncommittedChanges(snapshot: ScmWorkingSnapshot | null): boolean {
    const totals = snapshot?.totals;
    if (!totals) return false;
    return (totals.includedFiles ?? 0) > 0 || (totals.pendingFiles ?? 0) > 0 || (totals.untrackedFiles ?? 0) > 0;
}

export function isBranchStashAlreadyExistsError(
    response: Readonly<{ success: boolean; errorCode?: string; error?: string }>
): boolean {
    if (response.success) return false;
    if (response.errorCode !== SCM_OPERATION_ERROR_CODES.INVALID_REQUEST) return false;
    const message = typeof response.error === 'string' ? response.error.toLowerCase() : '';
    return message.includes('stash') && message.includes('already') && message.includes('branch');
}

export function isGitIndexLockError(
    response: Readonly<{ success: boolean; error?: string; stderr?: string }>
): boolean {
    if (response.success) return false;
    const message = `${response.error ?? ''}\n${response.stderr ?? ''}`.toLowerCase();
    return message.includes('index.lock');
}
