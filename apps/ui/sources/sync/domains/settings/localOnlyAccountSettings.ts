import type { Settings } from '@/sync/domains/settings/settings';

import {
    NewSessionOrdinaryEntryDraftIdSchema,
    parseLocalAccountSettings,
    type LocalAccountSettings,
} from '@/sync/domains/settings/registry/local/localAccountSettingDefinitions';

type NewSessionOrdinaryEntryDraftPointerSettings = Readonly<Pick<
    LocalAccountSettings,
    'newSessionOrdinaryEntryDraftId'
>>;

export type NewSessionOrdinaryEntryDraftPointerDelta = Readonly<Pick<
    LocalAccountSettings,
    'newSessionOrdinaryEntryDraftId'
>>;

export function readNewSessionOrdinaryEntryDraftId(
    settings: NewSessionOrdinaryEntryDraftPointerSettings,
): string | null {
    const parsed = NewSessionOrdinaryEntryDraftIdSchema.safeParse(settings.newSessionOrdinaryEntryDraftId);
    return parsed.success ? parsed.data : null;
}

export function setNewSessionOrdinaryEntryDraftId(
    draftId: string,
): NewSessionOrdinaryEntryDraftPointerDelta | null {
    const parsed = NewSessionOrdinaryEntryDraftIdSchema.safeParse(draftId);
    return parsed.success ? { newSessionOrdinaryEntryDraftId: parsed.data } : null;
}

export function clearNewSessionOrdinaryEntryDraftIdExact(
    settings: NewSessionOrdinaryEntryDraftPointerSettings,
    draftId: string,
): NewSessionOrdinaryEntryDraftPointerDelta | null {
    const currentDraftId = readNewSessionOrdinaryEntryDraftId(settings);
    const expectedDraftId = NewSessionOrdinaryEntryDraftIdSchema.safeParse(draftId);
    if (!expectedDraftId.success || currentDraftId !== expectedDraftId.data) return null;
    return { newSessionOrdinaryEntryDraftId: null };
}

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
        newSessionOrdinaryEntryDraftId: _newSessionOrdinaryEntryDraftId,
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
