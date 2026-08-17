import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

const mocks = vi.hoisted(() => ({
    tracking: {
        capture: vi.fn(),
        identify: vi.fn(),
        flush: vi.fn(() => Promise.resolve()),
    },
}));

vi.mock('@/track', () => ({
    tracking: mocks.tracking,
    getTrackingAnonymousUserId: () => 'anon-user',
}));

import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import {
    readLocalConversationVoiceSettings,
    voiceSettingsParse,
    voiceSettingsDefaults,
} from '@/sync/domains/settings/voiceSettings';

import {
    emitAccountSettingChangedEvents,
    emitLocalSettingChangedEvents,
} from './emitSettingChangedEvent';

describe('emitAccountSettingChangedEvents', () => {
    beforeEach(() => {
        mocks.tracking.capture.mockReset();
        mocks.tracking.identify.mockReset();
        mocks.tracking.flush.mockReset();
        mocks.tracking.flush.mockResolvedValue(undefined);
    });

    it('captures feature preference changes separately from account setting changes', () => {
        const nextSettings = {
            ...settingsDefaults,
            experiments: true,
            featureToggles: {
                voice: true,
            },
        };

        emitAccountSettingChangedEvents({
            previousSettings: settingsDefaults,
            nextSettings,
            source: 'ui',
        });

        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'voice',
                scope: 'feature_pref',
                identity_scope: 'person',
                source: 'ui',
                prev_value: false,
                next_value: true,
            }),
        );
        expect(mocks.tracking.flush).toHaveBeenCalledTimes(1);
    });

    it('does not emit the opaque provider settings subtree', () => {
        emitAccountSettingChangedEvents({
            previousSettings: settingsDefaults,
            nextSettings: {
                ...settingsDefaults,
                providerSettingsV1: {
                    v: 1,
                    providers: { opencode: { serverBaseUrl: 'https://example.com/' } },
                },
            },
            source: 'ui',
        });

        expect(mocks.tracking.capture).not.toHaveBeenCalled();
        expect(mocks.tracking.flush).not.toHaveBeenCalled();
    });

    it('captures structured account settings through canonical analytics property serializers', () => {
        const claudeTargetKey = buildAgentUniverseBackendTargetKey('claude');
        const nextSettings = {
            ...settingsDefaults,
            backendEnabledByTargetKey: {
                [claudeTargetKey]: false,
            },
        };

        emitAccountSettingChangedEvents({
            previousSettings: settingsDefaults,
            nextSettings,
            source: 'ui',
        });

        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: `backendEnabledByTargetKey__${claudeTargetKey}`,
                scope: 'account_setting',
                identity_scope: 'person',
                source: 'ui',
                prev_value: true,
                next_value: false,
                was_default_before: true,
                is_default_after: false,
            }),
        );
        expect(mocks.tracking.flush).toHaveBeenCalledTimes(1);
    });

    it('captures configured backend transcript-storage overrides through canonical target-key analytics', () => {
        const configuredTargetKey = resolveBackendTargetKeyV2({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
        emitAccountSettingChangedEvents({
            previousSettings: settingsDefaults,
            nextSettings: {
                ...settingsDefaults,
                newSessionDefaultPersistenceModeByTargetKeyV1: {
                    [configuredTargetKey]: 'direct',
                },
            },
            source: 'ui',
        });

        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: `newSessionDefaultPersistenceModeByTargetKeyV1__${configuredTargetKey}`,
                scope: 'account_setting',
                identity_scope: 'person',
                source: 'ui',
                prev_value: null,
                next_value: 'direct',
            }),
        );
    });

    it('captures structured voice settings through canonical account analytics serializers', () => {
        const localConversation = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const nextSettings = {
            ...settingsDefaults,
            voice: voiceSettingsParse({
                ...voiceSettingsDefaults,
                providerId: 'local_conversation',
                providers: {
                    ...voiceSettingsDefaults.providers,
                    local_conversation: {
                        schemaVersion: 1,
                        config: {
                    ...localConversation,
                    agent: {
                        ...localConversation.agent,
                        providerChat: {
                            status: 'needs_selection',
                            providerConnectionId: ProviderConnectionIdSchema.parse('voice-openai-compatible-chat'),
                            chatModelId: 'custom-chat',
                            commitModelId: 'custom-commit',
                            configuration: { temperature: 1.4 },
                        },
                    },
                        },
                    },
                },
            }),
        };

        emitAccountSettingChangedEvents({
            previousSettings: settingsDefaults,
            nextSettings: nextSettings as typeof settingsDefaults,
            source: 'ui',
        });

        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'voice__providerId',
                scope: 'account_setting',
                identity_scope: 'person',
                source: 'ui',
                prev_value: 'off',
                next_value: 'local_conversation',
            }),
        );

        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'voice__localConversationAgentProviderChatStatus',
                scope: 'account_setting',
                identity_scope: 'person',
                source: 'ui',
                prev_value: 'none',
                next_value: 'needs_selection',
            }),
        );
        expect(mocks.tracking.flush).toHaveBeenCalledTimes(1);
    });

    it('captures bucketed numeric account settings through canonical analytics serializers', () => {
        emitAccountSettingChangedEvents({
            previousSettings: settingsDefaults,
            nextSettings: {
                ...settingsDefaults,
                attachmentsUploadsMaxFileBytes: 100 * 1024 * 1024,
            },
            source: 'ui',
        });

        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'attachmentsUploadsMaxFileBytes',
                scope: 'account_setting',
                identity_scope: 'person',
                source: 'ui',
                value_kind: 'bucket',
                prev_value: 'medium',
                next_value: 'large',
            }),
        );
        expect(mocks.tracking.flush).toHaveBeenCalledTimes(1);
    });

    it('captures runtime and tool override summary settings through canonical analytics serializers', () => {
        emitAccountSettingChangedEvents({
            previousSettings: settingsDefaults,
            nextSettings: {
                ...settingsDefaults,
                sessionReplaySummaryRunnerV1: {
                    v: 1,
                    backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                    modelId: 'claude-sonnet-4-5',
                },
                sessionTmuxIsolated: false,
                toolViewDetailLevelByToolName: {
                    ReadFile: 'summary',
                },
            } as typeof settingsDefaults,
            source: 'ui',
        });

        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'sessionReplaySummaryRunnerV1',
                scope: 'account_setting',
                identity_scope: 'person',
                source: 'ui',
                prev_value: false,
                next_value: true,
            }),
        );

        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'sessionTmuxIsolated',
                scope: 'account_setting',
                identity_scope: 'person',
                source: 'ui',
                prev_value: true,
                next_value: false,
            }),
        );

        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'toolViewDetailLevelByToolName__overrideCount',
                scope: 'account_setting',
                identity_scope: 'person',
                source: 'ui',
                prev_value: 0,
                next_value: 1,
            }),
        );
        expect(mocks.tracking.flush).toHaveBeenCalledTimes(1);
    });

    it('does not flush when no tracked analytics properties changed', () => {
        emitAccountSettingChangedEvents({
            previousSettings: settingsDefaults,
            nextSettings: {
                ...settingsDefaults,
                inferenceOpenAIKey: 'sk-test',
            },
            source: 'ui',
        });

        expect(mocks.tracking.capture).not.toHaveBeenCalled();
        expect(mocks.tracking.identify).not.toHaveBeenCalled();
        expect(mocks.tracking.flush).not.toHaveBeenCalled();
    });

    it('captures derived compact-view analytics with the correct boolean value kind', () => {
        emitAccountSettingChangedEvents({
            previousSettings: {
                ...settingsDefaults,
                sessionListDensity: 'detailed',
            },
            nextSettings: {
                ...settingsDefaults,
                sessionListDensity: 'cozy',
            },
            source: 'ui',
        });

        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'compact_session_view',
                scope: 'derived',
                identity_scope: 'person',
                source: 'ui',
                value_kind: 'boolean',
                prev_value: false,
                next_value: true,
            }),
        );
    });
});

describe('emitLocalSettingChangedEvents', () => {
    beforeEach(() => {
        mocks.tracking.capture.mockReset();
        mocks.tracking.identify.mockReset();
        mocks.tracking.flush.mockReset();
        mocks.tracking.flush.mockResolvedValue(undefined);
    });

    it('captures bucketed pane size and acknowledged CLI count changes through canonical local analytics serializers', () => {
        emitLocalSettingChangedEvents({
            previousSettings: localSettingsDefaults,
            nextSettings: {
                ...localSettingsDefaults,
                sidebarWidthPx: 220,
                sidebarWidthBasisPx: 1_200,
                acknowledgedCliVersions: {
                    'machine-a': '1.2.3',
                    'machine-b': '2.0.0',
                },
            },
            source: 'ui',
        });

        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'sidebarWidthPx',
                scope: 'local_setting',
                identity_scope: 'device_user',
                source: 'ui',
                value_kind: 'bucket',
                prev_value: 'medium',
                next_value: 'small',
            }),
        );

        expect(mocks.tracking.capture).toHaveBeenCalledWith(
            'setting_changed',
            expect.objectContaining({
                setting_key: 'acknowledgedCliVersions',
                scope: 'local_setting',
                identity_scope: 'device_user',
                source: 'ui',
                prev_value: 0,
                next_value: 2,
            }),
        );
        expect(mocks.tracking.flush).toHaveBeenCalledTimes(1);
    });
});
