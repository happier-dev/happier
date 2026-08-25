import { describe, expect, it } from 'vitest';
import { ACCOUNT_SETTING_ARTIFACTS } from '@happier-dev/protocol';

import { settingsParse } from '@/sync/domains/settings/settings';
import {
    clearNewSessionOrdinaryEntryDraftIdExact,
    pickLocalOnlyAccountSettings,
    readNewSessionOrdinaryEntryDraftId,
    setNewSessionOrdinaryEntryDraftId,
    stripLocalOnlyAccountSettings,
} from '@/sync/domains/settings/localOnlyAccountSettings';
import { LOCAL_ACCOUNT_SETTING_DEFINITIONS } from '@/sync/domains/settings/registry/local/localAccountSettingDefinitions';

describe('localOnlyAccountSettings', () => {
    it('strips UI-local lastUsedAgent from server-synced settings', () => {
        const stripped = stripLocalOnlyAccountSettings({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            lastNewSessionAgentPickerViewV1: { kind: 'favoriteModels' },
            newSessionOrdinaryEntryDraftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
            analyticsOptOut: true,
        } as any);

        expect(stripped).toEqual({ analyticsOptOut: true });
    });

    it('drops every derived runtime projection from untyped pending input', () => {
        const stripped = stripLocalOnlyAccountSettings(JSON.parse(JSON.stringify({
            analyticsOptOut: true,
            currentSecretBindingsByProfileId: {
                profile: { OPENAI_API_KEY: 'secret-1' },
            },
            currentFavoriteModelSelectionsV1: [{ selection: { v: 1 } }],
            currentRememberedEngineSelectionsByScopeV1: {
                'server:backend:codex': { v: 1 },
            },
        })));

        expect(stripped).toEqual({ analyticsOptOut: true });
    });

    it('picks UI-local lastUsedAgent for merge overlays', () => {
        const settings = settingsParse({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            lastNewSessionAgentPickerViewV1: { kind: 'favoriteModels' },
        });
        const picked = pickLocalOnlyAccountSettings(settings);
        expect(picked).toMatchObject({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            lastNewSessionAgentPickerViewV1: { kind: 'favoriteModels' },
        });
    });

    it('declares last-used session creation settings as local-only in the canonical registry metadata', () => {
        expect(LOCAL_ACCOUNT_SETTING_DEFINITIONS.lastUsedAgent.storageScope).toBe('local');
        expect(LOCAL_ACCOUNT_SETTING_DEFINITIONS.lastUsedBackendTarget.storageScope).toBe('local');
        expect(LOCAL_ACCOUNT_SETTING_DEFINITIONS.lastNewSessionAgentPickerViewV1.storageScope).toBe('local');
        expect(LOCAL_ACCOUNT_SETTING_DEFINITIONS.newSessionOrdinaryEntryDraftId.storageScope).toBe('local');
    });

    it('keeps every device-local Account setting out of the Protocol persistence catalog', () => {
        const localOnlyKeys = [
            'lastUsedAgent',
            'lastUsedBackendTarget',
            'lastNewSessionAgentPickerViewV1',
            'newSessionOrdinaryEntryDraftId',
            'serverSelectionGroups',
            'serverSelectionActiveTargetKind',
            'serverSelectionActiveTargetId',
            'terminalConnectLegacySecretExportEnabled',
        ];

        for (const key of localOnlyKeys) {
            expect(ACCOUNT_SETTING_ARTIFACTS.definitions).not.toHaveProperty(key);
        }
    });

    it('owns exact read, set, and clear operations for the scoped ordinary-entry pointer', () => {
        const firstDraftId = '4a506d8a-85bd-4c42-a662-6f502f3acc45';
        const secondDraftId = '23c4d625-58a3-499d-bd2c-a7dd13e352e8';

        expect(readNewSessionOrdinaryEntryDraftId({ newSessionOrdinaryEntryDraftId: firstDraftId }))
            .toBe(firstDraftId);
        expect(setNewSessionOrdinaryEntryDraftId(firstDraftId)).toEqual({
            newSessionOrdinaryEntryDraftId: firstDraftId,
        });
        expect(setNewSessionOrdinaryEntryDraftId('not-a-uuid')).toBeNull();
        expect(clearNewSessionOrdinaryEntryDraftIdExact(
            { newSessionOrdinaryEntryDraftId: firstDraftId },
            secondDraftId,
        )).toBeNull();
        expect(clearNewSessionOrdinaryEntryDraftIdExact(
            { newSessionOrdinaryEntryDraftId: firstDraftId },
            firstDraftId,
        )).toEqual({ newSessionOrdinaryEntryDraftId: null });
    });
});
