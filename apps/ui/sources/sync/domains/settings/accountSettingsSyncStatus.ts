import { HappyError } from '@/utils/errors/errors';

export type AccountSettingsSyncStatusKind = 'auth' | 'config' | 'network' | 'server' | 'unknown';

export type AccountSettingsSyncStatus =
    | { state: 'idle' | 'synced'; lastSyncedAt: number | null }
    | {
        state: 'retrying' | 'failed';
        message: string;
        retryable: boolean;
        kind: AccountSettingsSyncStatusKind;
        at: number;
        failuresCount?: number;
        nextRetryAt?: number;
        pendingServerKeys?: string[];
    };

export type AccountSettingsSyncRetryInfo = Readonly<{
    failuresCount: number;
    nextRetryAt: number;
}>;

function classifyAccountSettingsSyncError(error: unknown): Readonly<{
    message: string;
    retryable: boolean;
    kind: AccountSettingsSyncStatusKind;
}> {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = !(error instanceof HappyError && error.canTryAgain === false);
    const kind: AccountSettingsSyncStatusKind =
        error instanceof HappyError && error.kind ? error.kind : 'unknown';

    return { message, retryable, kind };
}

export function createAccountSettingsRetryingStatus(params: Readonly<{
    error: unknown;
    retryInfo: AccountSettingsSyncRetryInfo;
    pendingServerKeys?: ReadonlyArray<string>;
}>): AccountSettingsSyncStatus {
    const classified = classifyAccountSettingsSyncError(params.error);
    const pendingServerKeys = params.pendingServerKeys?.slice().sort();

    return {
        state: 'retrying',
        ...classified,
        at: Date.now(),
        failuresCount: params.retryInfo.failuresCount,
        nextRetryAt: params.retryInfo.nextRetryAt,
        ...(pendingServerKeys && pendingServerKeys.length > 0 ? { pendingServerKeys } : {}),
    };
}

export function createAccountSettingsFailedStatus(params: Readonly<{
    error: unknown;
    pendingServerKeys?: ReadonlyArray<string>;
}>): AccountSettingsSyncStatus {
    const classified = classifyAccountSettingsSyncError(params.error);
    const pendingServerKeys = params.pendingServerKeys?.slice().sort();

    return {
        state: 'failed',
        ...classified,
        at: Date.now(),
        ...(pendingServerKeys && pendingServerKeys.length > 0 ? { pendingServerKeys } : {}),
    };
}

export function createAccountSettingsSyncedStatus(lastSyncedAt: number): AccountSettingsSyncStatus {
    return { state: 'synced', lastSyncedAt };
}

export function createAccountSettingsIdleStatus(): AccountSettingsSyncStatus {
    return { state: 'idle', lastSyncedAt: null };
}

export function isAccountSettingsSyncAttentionStatus(
    status: AccountSettingsSyncStatus,
): status is Extract<AccountSettingsSyncStatus, { state: 'retrying' | 'failed' }> {
    return status.state === 'retrying' || status.state === 'failed';
}
