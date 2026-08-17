import type { Settings } from '@/sync/domains/settings/settings';

import {
    parseLocalAccountSettings,
} from '@/sync/domains/settings/registry/local/localAccountSettingDefinitions';

/**
 * Runtime projections are non-persisted Settings facts.
 * Keep this defensive boundary for values that bypass TypeScript (recovered
 * pending state or JavaScript callers) before they can reach writeback.
 */
export function stripDerivedAccountSettingsProjections(
    settings: Partial<Settings>,
): Partial<Settings> {
    const {
        currentSecretBindingsByProfileId: _currentSecretBindingsByProfileId,
        currentFavoriteModelSelectionsV1: _currentFavoriteModelSelectionsV1,
        currentRememberedEngineSelectionsByScopeV1: _currentRememberedEngineSelectionsByScopeV1,
        ...rest
    } = settings;
    return rest;
}

export function stripLocalOnlyAccountSettings(settings: Partial<Settings>): Partial<Settings> {
    const {
        lastUsedAgent: _lastUsedAgent,
        lastUsedBackendTarget: _lastUsedBackendTarget,
        lastNewSessionAgentPickerViewV1: _lastNewSessionAgentPickerView,
        serverSelectionGroups: _serverSelectionGroups,
        serverSelectionActiveTargetKind: _serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId: _serverSelectionActiveTargetId,
        terminalConnectLegacySecretExportEnabled: _terminalConnectLegacySecretExportEnabled,
        ...rest
    } = stripDerivedAccountSettingsProjections(settings);
    return rest;
}

export function pickLocalOnlyAccountSettings(settings: Settings): Partial<Settings> {
    return parseLocalAccountSettings(settings);
}
