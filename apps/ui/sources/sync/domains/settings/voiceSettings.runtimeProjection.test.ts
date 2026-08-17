import {
    describe,
    expect,
    expectTypeOf,
    it,
} from 'vitest';
import {
    accountSettingsParse,
    type AccountSettings,
    type SavedSecret,
    type VoiceSpeechDiagnosticsSettingsV1,
} from '@happier-dev/protocol';

import {
    applySettings,
    projectRuntimeAccountSettings,
    settingsDefaults,
    settingsParse,
    type SettingsWriteDelta,
    type WritableSettingsKey,
} from './settings';
import type { useSettingMutable } from '@/sync/store/hooks';
import type { useApplySettings } from '@/sync/store/settingsWriters';
import type { VoiceSettings } from './voiceSettings';
import {
    LOCAL_ACCOUNT_SETTING_ARTIFACTS,
    type LocalAccountSettings,
} from './registry/local/localAccountSettingDefinitions';
import {
    projectVoiceSettingsIntoRuntimeSettings,
    type VoiceSettingsPersistenceV1,
} from './voiceSettingsPersistence';
import {
    readRetainedSecretBindingsByProfileId,
    type CurrentSecretBindingsByProfileId,
} from './secretBindings';
import type { FavoriteModelSelectionV1 } from '@/sync/domains/models/favoriteModelSelections';
import type { RememberedEngineSelectionsByScopeV1 } from '@/sync/domains/session/authoring/rememberedEngineSelections';

function projectProtocolSettingsForTypeContract(parsed: AccountSettings) {
    return projectRuntimeAccountSettings(projectVoiceSettingsIntoRuntimeSettings({ parsed, raw: {} }));
}

type DirectProtocolProjection = ReturnType<typeof projectProtocolSettingsForTypeContract>;

function projectProtocolAndLocalSettingsForTypeContract(
    parsed: AccountSettings & LocalAccountSettings,
) {
    return projectRuntimeAccountSettings(projectVoiceSettingsIntoRuntimeSettings({ parsed, raw: {} }));
}

type DirectProtocolAndLocalProjection = ReturnType<typeof projectProtocolAndLocalSettingsForTypeContract>;

describe('Voice Account Settings runtime projection', () => {
    it('projects bounded persisted roots into the typed Voice consumer contract', () => {
        const parsed = settingsParse({
            voice: {
                providerId: 'off',
                assistantLanguage: 'de',
            },
        });

        expect(parsed.voice.providerId).toBeNull();
        expect(parsed.voice.assistantLanguage).toBe('de');
        expect(parsed.voice.diagnostics).toEqual(parsed.voiceDiagnosticsV1);
        expect(parsed.voiceSettingsV1.assistantLanguage).toBe('de');

        // Protocol deliberately keeps these persisted legacy roots as bounded
        // JSON. The UI Settings facade must expose only the projection that
        // `projectVoiceSettingsIntoRuntimeSettings` actually produces.
        expectTypeOf(settingsDefaults.voice).not.toBeAny();
        expectTypeOf(settingsDefaults.voice).toEqualTypeOf<VoiceSettings>();
        expectTypeOf(settingsDefaults.voiceSettingsV1).not.toBeAny();
        expectTypeOf(settingsDefaults.voiceSettingsV1).toEqualTypeOf<VoiceSettingsPersistenceV1>();
        expectTypeOf(settingsDefaults.voiceDiagnosticsV1).not.toBeAny();
        expectTypeOf(settingsDefaults.voiceDiagnosticsV1).toEqualTypeOf<VoiceSpeechDiagnosticsSettingsV1>();
        expectTypeOf(settingsDefaults.secrets).not.toBeAny();
        expectTypeOf(settingsDefaults.secrets).toEqualTypeOf<SavedSecret[]>();
        expectTypeOf(settingsDefaults.connectedServicesDefaultProfileByServiceId).not.toBeAny();
        expectTypeOf(settingsDefaults.connectedServicesDefaultProfileByServiceId).toEqualTypeOf<Record<string, string>>();
        expectTypeOf(settingsDefaults.currentSecretBindingsByProfileId).not.toBeAny();
        expectTypeOf(settingsDefaults.currentSecretBindingsByProfileId)
            .toEqualTypeOf<CurrentSecretBindingsByProfileId>();
        expectTypeOf(settingsDefaults.currentFavoriteModelSelectionsV1).not.toBeAny();
        expectTypeOf(settingsDefaults.currentFavoriteModelSelectionsV1)
            .toEqualTypeOf<readonly FavoriteModelSelectionV1[]>();
        expectTypeOf(settingsDefaults.currentRememberedEngineSelectionsByScopeV1).not.toBeAny();
        expectTypeOf(settingsDefaults.currentRememberedEngineSelectionsByScopeV1)
            .toEqualTypeOf<RememberedEngineSelectionsByScopeV1>();
        expectTypeOf<Extract<'currentSecretBindingsByProfileId', WritableSettingsKey>>()
            .toEqualTypeOf<never>();
        expectTypeOf<Extract<'currentFavoriteModelSelectionsV1', WritableSettingsKey>>()
            .toEqualTypeOf<never>();
        expectTypeOf<Extract<'currentRememberedEngineSelectionsByScopeV1', WritableSettingsKey>>()
            .toEqualTypeOf<never>();
        expectTypeOf<Extract<'currentSecretBindingsByProfileId', keyof SettingsWriteDelta>>()
            .toEqualTypeOf<never>();
        expectTypeOf<Extract<'currentFavoriteModelSelectionsV1', keyof SettingsWriteDelta>>()
            .toEqualTypeOf<never>();
        expectTypeOf<Extract<'currentRememberedEngineSelectionsByScopeV1', keyof SettingsWriteDelta>>()
            .toEqualTypeOf<never>();
        expectTypeOf<Extract<'currentSecretBindingsByProfileId', Parameters<typeof useSettingMutable>[0]>>()
            .toEqualTypeOf<never>();
        expectTypeOf<Extract<'currentFavoriteModelSelectionsV1', Parameters<typeof useSettingMutable>[0]>>()
            .toEqualTypeOf<never>();
        expectTypeOf<Extract<'currentRememberedEngineSelectionsByScopeV1', Parameters<typeof useSettingMutable>[0]>>()
            .toEqualTypeOf<never>();
        expectTypeOf<Extract<'currentSecretBindingsByProfileId', keyof Parameters<ReturnType<typeof useApplySettings>>[0]>>()
            .toEqualTypeOf<never>();
        expectTypeOf<Extract<'secretBindingsByProfileId', keyof typeof settingsDefaults>>()
            .toEqualTypeOf<never>();
        expectTypeOf<Extract<'favoriteModelSelectionsV1', keyof typeof settingsDefaults>>()
            .toEqualTypeOf<never>();
        expectTypeOf<Extract<'lastEngineSelectionsByScopeV1', keyof typeof settingsDefaults>>()
            .toEqualTypeOf<never>();
        expectTypeOf(settingsDefaults.lastUsedAgent).toEqualTypeOf<LocalAccountSettings['lastUsedAgent']>();
        expectTypeOf<Extract<'sessionFoldersV1', keyof typeof settingsDefaults>>().toEqualTypeOf<never>();
        expectTypeOf(parsed.voice).toEqualTypeOf<VoiceSettings>();
        expectTypeOf(parsed.voiceSettingsV1).toEqualTypeOf<VoiceSettingsPersistenceV1>();
        expectTypeOf(parsed.voiceDiagnosticsV1).toEqualTypeOf<VoiceSpeechDiagnosticsSettingsV1>();
        expectTypeOf<DirectProtocolProjection['voice']>().toEqualTypeOf<VoiceSettings>();
        expectTypeOf<DirectProtocolProjection['voiceSettingsV1']>().toEqualTypeOf<VoiceSettingsPersistenceV1>();
        expectTypeOf<DirectProtocolProjection['voiceDiagnosticsV1']>().toEqualTypeOf<VoiceSpeechDiagnosticsSettingsV1>();
        expectTypeOf<DirectProtocolProjection['secrets']>().toEqualTypeOf<SavedSecret[]>();
        expectTypeOf<DirectProtocolProjection['connectedServicesDefaultProfileByServiceId']>().toEqualTypeOf<Record<string, string>>();
        expectTypeOf<DirectProtocolProjection['currentSecretBindingsByProfileId']>()
            .toEqualTypeOf<CurrentSecretBindingsByProfileId>();
        expectTypeOf<DirectProtocolProjection['currentFavoriteModelSelectionsV1']>()
            .toEqualTypeOf<readonly FavoriteModelSelectionV1[]>();
        expectTypeOf<DirectProtocolProjection['currentRememberedEngineSelectionsByScopeV1']>()
            .toEqualTypeOf<RememberedEngineSelectionsByScopeV1>();
        expectTypeOf<Extract<'secretBindingsByProfileId', keyof DirectProtocolProjection>>()
            .toEqualTypeOf<never>();
        expectTypeOf<Extract<'sessionFoldersV1', keyof DirectProtocolProjection>>().toEqualTypeOf<never>();
        expectTypeOf<Extract<'futureWriterKey', keyof DirectProtocolProjection>>().toEqualTypeOf<never>();
        expectTypeOf<DirectProtocolAndLocalProjection['lastUsedAgent']>()
            .toEqualTypeOf<LocalAccountSettings['lastUsedAgent']>();
        expectTypeOf<DirectProtocolAndLocalProjection['voice']>()
            .toEqualTypeOf<VoiceSettings>();
    });

    it('strips retired organization roots at the direct projection boundary', () => {
        const raw = {
            voice: {
                assistantLanguage: 'de',
            },
        };
        const projected = projectVoiceSettingsIntoRuntimeSettings({
            parsed: {
                ...accountSettingsParse(raw),
                ...LOCAL_ACCOUNT_SETTING_ARTIFACTS.defaults,
                // Inject after canonical parsing so this test reaches the
                // exported projector with retired persisted roots present.
                pinnedSessionKeysV1: ['session-a'],
                workspaceLabelsV1: { 'workspace-a': 'Workspace A' },
                sessionFoldersV1: { v: 1, folders: [] },
                futureWriterKey: 'preserved-at-runtime',
            },
            raw,
        });

        expect(projected).not.toHaveProperty('pinnedSessionKeysV1');
        expect(projected).not.toHaveProperty('workspaceLabelsV1');
        expect(projected).not.toHaveProperty('sessionFoldersV1');
        expect(projected).toHaveProperty('futureWriterKey', 'preserved-at-runtime');
        expect(projected.secrets).toEqual([]);
        expect(projected.lastUsedAgent)
            .toEqual(LOCAL_ACCOUNT_SETTING_ARTIFACTS.defaults.lastUsedAgent);
        expect(projected.voice.assistantLanguage).toBe('de');
        expect(projected.voiceSettingsV1.assistantLanguage).toBe('de');
    });

    it('keeps opaque secret-binding carriers for writeback while exposing only current maps', () => {
        const opaqueCarrier = {
            OPENAI_API_KEY: 's1',
            futureBindingRevision: 2,
        };
        const parsed = settingsParse({
            profiles: [
                {
                    id: 'opaque-profile',
                    name: 'Opaque profile',
                    environmentVariables: [],
                    compatibility: { claude: true, codex: true, gemini: true },
                    envVarRequirements: [{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }],
                    isBuiltIn: false,
                    createdAt: 0,
                    updatedAt: 0,
                    version: '1.0.0',
                },
                {
                    id: 'current-profile',
                    name: 'Current profile',
                    environmentVariables: [],
                    compatibility: { claude: true, codex: true, gemini: true },
                    envVarRequirements: [{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }],
                    isBuiltIn: false,
                    createdAt: 0,
                    updatedAt: 0,
                    version: '1.0.0',
                },
            ],
            secrets: [{
                id: 's1',
                name: 'S1',
                kind: 'apiKey',
                encryptedValue: {
                    _isSecretValue: true,
                    encryptedValue: { t: 'enc-v1', c: 'Zm9v' },
                },
                createdAt: 0,
                updatedAt: 0,
            }],
            secretBindingsByProfileId: {
                'opaque-profile': opaqueCarrier,
                'current-profile': { openai_api_key: 's1' },
            },
        });

        expect(readRetainedSecretBindingsByProfileId(parsed)).toEqual({
            'opaque-profile': opaqueCarrier,
            'current-profile': { OPENAI_API_KEY: 's1' },
        });
        expect(parsed).toHaveProperty('currentSecretBindingsByProfileId', {
            'current-profile': { OPENAI_API_KEY: 's1' },
        });
        expect(JSON.parse(JSON.stringify(parsed))).not.toHaveProperty('currentSecretBindingsByProfileId');

        const afterUnrelatedMutation = applySettings(parsed, { useProfiles: true });
        expect(readRetainedSecretBindingsByProfileId(afterUnrelatedMutation)).toEqual({
            'opaque-profile': opaqueCarrier,
            'current-profile': { OPENAI_API_KEY: 's1' },
        });
        expect(afterUnrelatedMutation).toHaveProperty('currentSecretBindingsByProfileId', {
            'current-profile': { OPENAI_API_KEY: 's1' },
        });
        expect(JSON.parse(JSON.stringify(afterUnrelatedMutation))).not.toHaveProperty('currentSecretBindingsByProfileId');
    });
});
