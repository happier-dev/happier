import {
    stripLocalOnlyAccountSettings,
} from '@/sync/domains/settings/localOnlyAccountSettings';
import {
    areAccountSettingsScopesEqual,
    type AccountSettingsScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';
import type { Settings } from '@/sync/domains/settings/settings';
import {
    AccountSettingsPendingFlushFailedBeforeSpawnError,
    AccountSettingsScopeChangedDuringSpawnPreparationError,
} from './accountSettingsSpawnPreparationError';

export type PreparedAccountSettingsForDaemonSpawn = Readonly<{
    accountSettingsVersionHint?: number;
}>;

export type PrepareAccountSettingsForDaemonSpawnParams = Readonly<{
    settingsScope: AccountSettingsScope | null;
    pendingSettings: Partial<Settings>;
    getActiveSettingsScope: () => AccountSettingsScope | null;
    getCurrentSettingsVersion: () => number | null;
    flushPendingServerSettings: () => Promise<void>;
    clearPendingSettings: (submittedPendingSettings: Partial<Settings>) => void;
}>;

function toVersionHint(version: number | null): PreparedAccountSettingsForDaemonSpawn {
    return typeof version === 'number' && Number.isInteger(version) && version >= 0
        ? { accountSettingsVersionHint: version }
        : {};
}

function assertSettingsScopeUnchanged(params: Readonly<{
    currentScope: AccountSettingsScope | null;
    capturedScope: AccountSettingsScope | null;
}>): void {
    if (!areAccountSettingsScopesEqual(params.currentScope, params.capturedScope)) {
        throw new AccountSettingsScopeChangedDuringSpawnPreparationError();
    }
}

function requireVersionHint(version: number | null): PreparedAccountSettingsForDaemonSpawn {
    const hint = toVersionHint(version);
    if (typeof hint.accountSettingsVersionHint === 'number') return hint;
    throw new Error('Account settings version is not available for daemon session spawn');
}

async function flushPendingServerSettingsForSpawn(params: Readonly<{
    flushPendingServerSettings: () => Promise<void>;
    hasPendingServerSettings: boolean;
}>): Promise<void> {
    try {
        await params.flushPendingServerSettings();
    } catch (error) {
        if (params.hasPendingServerSettings) {
            throw new AccountSettingsPendingFlushFailedBeforeSpawnError(error);
        }
        throw error;
    }
}

export async function prepareAccountSettingsForDaemonSpawn(
    params: PrepareAccountSettingsForDaemonSpawnParams,
): Promise<PreparedAccountSettingsForDaemonSpawn> {
    const pendingServerSettings = stripLocalOnlyAccountSettings(params.pendingSettings);
    const capturedScope = params.settingsScope;

    if (Object.keys(pendingServerSettings).length === 0) {
        if (Object.keys(params.pendingSettings).length > 0) {
            params.clearPendingSettings(params.pendingSettings);
        }
        const currentHint = toVersionHint(params.getCurrentSettingsVersion());
        if (typeof currentHint.accountSettingsVersionHint === 'number') return currentHint;

        await flushPendingServerSettingsForSpawn({
            flushPendingServerSettings: params.flushPendingServerSettings,
            hasPendingServerSettings: false,
        });
        assertSettingsScopeUnchanged({
            currentScope: params.getActiveSettingsScope(),
            capturedScope,
        });
        return requireVersionHint(params.getCurrentSettingsVersion());
    }

    await flushPendingServerSettingsForSpawn({
        flushPendingServerSettings: params.flushPendingServerSettings,
        hasPendingServerSettings: true,
    });

    assertSettingsScopeUnchanged({
        currentScope: params.getActiveSettingsScope(),
        capturedScope,
    });

    return requireVersionHint(params.getCurrentSettingsVersion());
}
