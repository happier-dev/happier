import type { Settings } from '@/sync/domains/settings/settings';
import { LEGACY_AUTHORING_MEMORY_SETTINGS_KEYS } from '@happier-dev/protocol/account/settings/legacyAuthoringMemorySettingsV1';

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
        ...rest
    } = settings;
    const stripped = rest as Record<string, unknown>;
    delete stripped.currentRememberedEngineSelectionsByScopeV1;
    return stripped as Partial<Settings>;
}

/** Only sparse pending/input deltas use this; authoritative raw roots survive until import commits. */
export function stripLegacyAuthoringMemorySettingsDelta<T extends object>(delta: T): T {
    const next = { ...delta } as T & Record<string, unknown>;
    for (const key of [...LEGACY_AUTHORING_MEMORY_SETTINGS_KEYS, 'currentRememberedEngineSelectionsByScopeV1']) {
        delete next[key];
    }
    return next;
}

export function stripLocalOnlyAccountSettings(settings: Partial<Settings>): Partial<Settings> {
    const {
        sessionSplitCanvasLayoutsV1: _sessionSplitCanvasLayoutsV1,
        machineAdministrationTargetsLocalV1: _machineAdministrationTargetsLocalV1,
        lastUsedAgent: _lastUsedAgent,
        lastUsedBackendTarget: _lastUsedBackendTarget,
        lastNewSessionAgentPickerViewV1: _lastNewSessionAgentPickerView,
        newSessionOrdinaryEntryDraftId: _newSessionOrdinaryEntryDraftId,
        serverSelectionGroups: _serverSelectionGroups,
        serverSelectionActiveTargetKind: _serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId: _serverSelectionActiveTargetId,
        terminalConnectLegacySecretExportEnabled: _terminalConnectLegacySecretExportEnabled,
        clientEncryptionRequirementLocalV1: _clientEncryptionRequirementLocalV1,
        ...rest
    } = stripDerivedAccountSettingsProjections(settings);
    return rest;
}

export function pickLocalOnlyAccountSettings(settings: Settings): Partial<Settings> {
    return parseLocalAccountSettings(settings);
}
