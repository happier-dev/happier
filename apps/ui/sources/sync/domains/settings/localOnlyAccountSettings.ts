import type { Settings } from '@/sync/domains/settings/settings';
import { isAccountSettingsReadOnlySourceKeyV1, isRetiredAccountSettingsRootKey } from '@happier-dev/protocol/account/settings/accountSettings';

import {
    parseLocalAccountSettings,
} from '@/sync/domains/settings/registry/local/localAccountSettingDefinitions';

/**
 * Runtime projections are non-persisted Settings facts.
 * Keep this defensive boundary for values that bypass TypeScript (recovered
 * pending state or JavaScript callers) before they can reach writeback.
 */
export function stripDerivedAccountSettingsProjections(
    settings: Partial<Settings> & Readonly<{ currentSecretBindingsByProfileId?: unknown }>,
): Partial<Settings> {
    const {
        currentSecretBindingsByProfileId: _currentSecretBindingsByProfileId,
        currentFavoriteModelSelectionsV1: _currentFavoriteModelSelectionsV1,
        ...rest
    } = settings;
    const stripped = rest as Record<string, unknown>;
    delete stripped.currentRememberedEngineSelectionsByScopeV1;
    return stripped as Partial<Settings>;
}

/** Only sparse pending/input deltas use this; authoritative raw roots survive until import commits. */
export function stripReadOnlyAccountSettingsDelta<T extends object>(delta: T): T {
    const next = { ...delta } as T & Record<string, unknown>;
    for (const key of Object.keys(next)) {
        if (isAccountSettingsReadOnlySourceKeyV1(key) || isRetiredAccountSettingsRootKey(key)
            || key === 'currentRememberedEngineSelectionsByScopeV1') delete next[key];
    }
    return next;
}

/** Retained device import seeds are never current preference projections or Account writes. */
export function stripRetiredNewSessionSettings<T extends object>(settings: T): T {
    if (!Object.hasOwn(settings, 'lastNewSessionAgentPickerViewV1') && !Object.hasOwn(settings, 'newSessionOrdinaryEntryDraftId')) return settings;
    const { lastNewSessionAgentPickerViewV1: _picker, newSessionOrdinaryEntryDraftId: _draft, ...retained } = settings as Record<string, unknown>;
    return retained as T;
}

export function stripLocalOnlyAccountSettings(settings: Partial<Settings>): Partial<Settings> {
    const {
        machineAdministrationTargetsLocalV1: _machineAdministrationTargetsLocalV1,
        lastUsedAgent: _lastUsedAgent,
        lastUsedBackendTarget: _lastUsedBackendTarget,
        serverSelectionGroups: _serverSelectionGroups,
        serverSelectionActiveTargetKind: _serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId: _serverSelectionActiveTargetId,
        terminalConnectLegacySecretExportEnabled: _terminalConnectLegacySecretExportEnabled,
        clientEncryptionRequirementLocalV1: _clientEncryptionRequirementLocalV1,
        ...rest
    } = stripDerivedAccountSettingsProjections(settings);
    return stripRetiredNewSessionSettings(rest);
}

export function pickLocalOnlyAccountSettings(settings: Settings): Partial<Settings> {
    return parseLocalAccountSettings(settings);
}
