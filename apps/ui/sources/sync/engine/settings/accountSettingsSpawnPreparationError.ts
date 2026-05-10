const ACCOUNT_SETTINGS_SCOPE_CHANGED_DURING_SPAWN_PREPARATION =
    'ACCOUNT_SETTINGS_SCOPE_CHANGED_DURING_SPAWN_PREPARATION';

export class AccountSettingsScopeChangedDuringSpawnPreparationError extends Error {
    readonly code = ACCOUNT_SETTINGS_SCOPE_CHANGED_DURING_SPAWN_PREPARATION;

    constructor() {
        super('Account settings scope changed while preparing session spawn');
        this.name = 'AccountSettingsScopeChangedDuringSpawnPreparationError';
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
