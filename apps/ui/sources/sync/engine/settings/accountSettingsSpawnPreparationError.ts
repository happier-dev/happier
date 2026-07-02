const ACCOUNT_SETTINGS_SCOPE_CHANGED_DURING_SPAWN_PREPARATION =
    'ACCOUNT_SETTINGS_SCOPE_CHANGED_DURING_SPAWN_PREPARATION';
const ACCOUNT_SETTINGS_PENDING_FLUSH_FAILED_BEFORE_SPAWN =
    'ACCOUNT_SETTINGS_PENDING_FLUSH_FAILED_BEFORE_SPAWN';

export class AccountSettingsScopeChangedDuringSpawnPreparationError extends Error {
    readonly code = ACCOUNT_SETTINGS_SCOPE_CHANGED_DURING_SPAWN_PREPARATION;

    constructor() {
        super('Account settings scope changed while preparing session spawn');
        this.name = 'AccountSettingsScopeChangedDuringSpawnPreparationError';
    }
}

export class AccountSettingsPendingFlushFailedBeforeSpawnError extends Error {
    readonly code = ACCOUNT_SETTINGS_PENDING_FLUSH_FAILED_BEFORE_SPAWN;
    readonly cause?: unknown;

    constructor(cause: unknown) {
        super('Account settings changes could not be synced before spawning');
        this.name = 'AccountSettingsPendingFlushFailedBeforeSpawnError';
        this.cause = cause;
    }
}

export function isAccountSettingsScopeChangedDuringSpawnPreparationError(
    error: unknown,
): error is AccountSettingsScopeChangedDuringSpawnPreparationError {
    if (error instanceof AccountSettingsScopeChangedDuringSpawnPreparationError) return true;
    if (!error || typeof error !== 'object') return false;
    const maybeError = error as { code?: unknown; message?: unknown };
    return maybeError.code === ACCOUNT_SETTINGS_SCOPE_CHANGED_DURING_SPAWN_PREPARATION
        || maybeError.message === 'Account settings scope changed while preparing session spawn';
}

export function isAccountSettingsPendingFlushFailedBeforeSpawnError(
    error: unknown,
): error is AccountSettingsPendingFlushFailedBeforeSpawnError {
    if (error instanceof AccountSettingsPendingFlushFailedBeforeSpawnError) return true;
    if (!error || typeof error !== 'object') return false;
    const maybeError = error as { code?: unknown; message?: unknown };
    return maybeError.code === ACCOUNT_SETTINGS_PENDING_FLUSH_FAILED_BEFORE_SPAWN
        || maybeError.message === 'Account settings changes could not be synced before spawning';
}
