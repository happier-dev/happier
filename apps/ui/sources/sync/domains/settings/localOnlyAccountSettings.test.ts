import { describe, expect, it } from 'vitest';
import { ACCOUNT_SETTING_ARTIFACTS } from '@happier-dev/protocol/account/settings/accountSettings';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';

import { settingsParse } from '@/sync/domains/settings/settings';
import {
    pickLocalOnlyAccountSettings,
    stripLocalOnlyAccountSettings,
} from '@/sync/domains/settings/localOnlyAccountSettings';
import { LOCAL_ACCOUNT_SETTING_DEFINITIONS, parseLocalAccountSettings } from '@/sync/domains/settings/registry/local/localAccountSettingDefinitions';
import { normalizeAccountSettingsForLocalStorage } from './accountSettingsNormalization';

describe('localOnlyAccountSettings', () => {
    it('reads nested device targets with extras through their stored projection and keeps writer schemas strict', () => {
        const target = { serverIdentityId: 'srv_one', machineId: 'machine-a' };
        const agent = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
        const retainedAgent = { ...agent, retired: true, identity: { ...agent.identity, retired: true } };
        const retainedTarget = { ...target, retired: true };
        expect(parseLocalAccountSettings({
            machineAdministrationTargetsLocalV1: { plugins: retainedTarget }, lastUsedBackendTarget: retainedAgent,
        })).toMatchObject({ machineAdministrationTargetsLocalV1: { plugins: target }, lastUsedBackendTarget: agent });
        expect(LOCAL_ACCOUNT_SETTING_DEFINITIONS.machineAdministrationTargetsLocalV1.schema.safeParse({ plugins: retainedTarget }).success)
            .toBe(false);
        expect(parseLocalAccountSettings({ machineAdministrationTargetsLocalV1: { plugins: { ...retainedTarget, machineId: null } } })
            .machineAdministrationTargetsLocalV1).toEqual({});
    });

    it('keeps device Administration memory out of Account writes without changing execution-origin policy', () => {
        const input = JSON.parse(JSON.stringify({
            machineAdministrationTargetsLocalV1: {},
            machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} },
        }));
        expect(stripLocalOnlyAccountSettings(input)).toEqual({
            machineAdministrationSelectionsV1: input.machineAdministrationSelectionsV1,
        });
    });

    it('preserves a deliberately cleared local target map across remote settings hydration', () => {
        const hydrated = normalizeAccountSettingsForLocalStorage({
            mode: 'plain', settingsSecretsKey: null,
            raw: { machineAdministrationSelectionsV1: {
                v: 1, pluginExecutionOriginsByPluginId: { 'acme.plugin': {
                    serverIdentityId: 'srv_one', materializationRef: {
                        machineId: 'remote', materializationId: 'materialization', pluginId: 'acme.plugin',
                    },
                } },
            } },
            localSettings: { machineAdministrationTargetsLocalV1: {} },
        });
        expect(pickLocalOnlyAccountSettings(hydrated)).toMatchObject({
            machineAdministrationTargetsLocalV1: {},
        });
        expect(hydrated.machineAdministrationSelectionsV1.pluginExecutionOriginsByPluginId['acme.plugin']).toMatchObject({
            materializationRef: { machineId: 'remote' },
        });
    });

    it('strips UI-local lastUsedAgent from server-synced settings', () => {
        const stripped = stripLocalOnlyAccountSettings({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            lastNewSessionAgentPickerViewV1: { kind: 'favoriteModels' },
            newSessionOrdinaryEntryDraftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45',
            clientEncryptionRequirementLocalV1: 'require_e2ee',
            clientEncryptionRequirementV1: 'require_e2ee',
            analyticsOptOut: true,
        } as any);

        expect(stripped).toEqual({
            clientEncryptionRequirementV1: 'require_e2ee',
            analyticsOptOut: true,
        });
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
            clientEncryptionRequirementLocalV1: 'require_e2ee',
        });
        const picked = pickLocalOnlyAccountSettings(settings);
        expect(picked).toMatchObject({
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: {
                kind: 'agent', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: 'review-bot',
            },
            clientEncryptionRequirementLocalV1: 'require_e2ee',
        });
        expect(picked).not.toHaveProperty('lastNewSessionAgentPickerViewV1');
    });

    it('declares last-used session creation settings as local-only in the canonical registry metadata', () => {
        expect(LOCAL_ACCOUNT_SETTING_DEFINITIONS.lastUsedAgent.storageScope).toBe('local');
        expect(LOCAL_ACCOUNT_SETTING_DEFINITIONS.lastUsedBackendTarget.storageScope).toBe('local');
        expect(LOCAL_ACCOUNT_SETTING_DEFINITIONS).not.toHaveProperty('lastNewSessionAgentPickerViewV1');
        expect(LOCAL_ACCOUNT_SETTING_DEFINITIONS).not.toHaveProperty('newSessionOrdinaryEntryDraftId');
        expect(LOCAL_ACCOUNT_SETTING_DEFINITIONS.clientEncryptionRequirementLocalV1.storageScope).toBe('local');
        expect(ACCOUNT_SETTING_ARTIFACTS.definitions.clientEncryptionRequirementV1.storageScope).toBe('account');
    });

    it('keeps every device-local Account setting out of the Protocol persistence catalog', () => {
        const localOnlyKeys = [
            'machineAdministrationTargetsLocalV1',
            'lastUsedAgent',
            'lastUsedBackendTarget',
            'lastNewSessionAgentPickerViewV1',
            'newSessionOrdinaryEntryDraftId',
            'serverSelectionGroups',
            'serverSelectionActiveTargetKind',
            'serverSelectionActiveTargetId',
            'terminalConnectLegacySecretExportEnabled',
            'clientEncryptionRequirementLocalV1',
        ];

        for (const key of localOnlyKeys) {
            expect(ACCOUNT_SETTING_ARTIFACTS.definitions).not.toHaveProperty(key);
        }
    });

});
