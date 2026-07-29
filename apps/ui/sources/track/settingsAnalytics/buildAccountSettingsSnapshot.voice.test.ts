import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';
import {
    readLocalConversationVoiceSettings,
    readLocalDirectVoiceSettings,
    voiceSettingsDefaults,
    voiceSettingsParse,
} from '@/sync/domains/settings/voiceSettings';

import { buildAccountSettingsSnapshot } from './buildAccountSettingsSnapshot';
import { buildSecretValue } from './settingsAnalytics.testkit';

describe('buildAccountSettingsSnapshot', () => {
    it('tracks voice settings through canonical structured analytics serializers', () => {
        const localDirectDefaults = readLocalDirectVoiceSettings(voiceSettingsDefaults);
        const localConversationDefaults = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            voice: voiceSettingsParse({
                ...settingsDefaults.voice,
                providerId: 'local_conversation',
                assistantLanguage: 'fr',
                welcome: {
                    enabled: true,
                    mode: 'on_first_turn',
                    templateId: 'welcome-template',
                },
                executionMachine: {
                    mode: 'fixed',
                    machineId: 'machine-1',
                    autoMachineId: null,
                },
                ui: {
                    ...settingsDefaults.voice.ui,
                    scopeDefault: 'session',
                    surfaceLocation: 'session',
                    activityFeedEnabled: true,
                    activityFeedAutoExpandOnStart: true,
                    updates: {
                        ...settingsDefaults.voice.ui.updates,
                        activeSession: 'activity',
                        otherSessions: 'snippets',
                        snippetsMaxMessages: 7,
                        includeUserMessagesInSnippets: true,
                        otherSessionsSnippetsMode: 'auto',
                    },
                },
                privacy: {
                    ...settingsDefaults.voice.privacy,
                    shareSessionSummary: false,
                    shareRecentMessages: false,
                    recentMessagesCount: 12,
                    shareToolNames: false,
                    sharePermissionRequests: false,
                    shareDeviceInventory: false,
                },
                providers: {
                    ...voiceSettingsDefaults.providers,
                    realtime_elevenlabs: { schemaVersion: 2, config: {
                        billingMode: 'byo',
                        tts: {
                            voiceId: 'custom-voice',
                            modelId: 'eleven_turbo_v2',
                            voiceSettings: {
                                stability: 0.2,
                                similarityBoost: 0.85,
                                style: 0.6,
                                useSpeakerBoost: true,
                                speed: 1.1,
                            },
                        },
                        byo: {
                            agentId: 'byo-agent',
                        },
                    } },
                    local_direct: { schemaVersion: 1, config: {
                        ...localDirectDefaults,
                        networkTimeoutMs: 25_000,
                        handsFree: {
                            enabled: true,
                            endpointing: {
                                silenceMs: 900,
                                minSpeechMs: 250,
                            },
                        },
                    } },
                    local_conversation: { schemaVersion: 1, config: {
                        ...localConversationDefaults,
                        conversationMode: 'agent',
                        networkTimeoutMs: 30_000,
                        handsFree: {
                            enabled: true,
                            endpointing: {
                                silenceMs: 1_200,
                                minSpeechMs: 300,
                            },
                        },
                        agent: {
                            ...localConversationDefaults.agent,
                            backend: 'openai_compat',
                            agentSource: 'agent',
                            stayInVoiceHome: true,
                            teleportEnabled: false,
                            rootSessionPolicy: 'keep_warm',
                            maxWarmRoots: 5,
                            voiceHomeSubdirName: 'custom-home',
                            permissionIntent: 'read-only',
                            idleTtlSeconds: 7_200,
                            prewarmOnConnect: false,
                            resumabilityMode: 'provider_resume',
                            providerResume: {
                                fallbackToReplay: false,
                            },
                            replay: {
                                strategy: 'summary_plus_recent',
                                recentMessagesCount: 32,
                            },
                            commitIsolation: true,
                            transcript: {
                                persistenceMode: 'persistent',
                                epoch: 0,
                            },
                            chatModelSource: 'custom',
                            chatModelId: 'gpt-4o-mini',
                            commitModelSource: 'custom',
                            commitModelId: 'gpt-4.1',
                            openaiCompat: {
                                chatBaseUrl: 'https://api.example.com',
                                chatApiKey: buildSecretValue('secret-value'),
                                chatModel: 'custom-chat',
                                commitModel: 'custom-commit',
                                temperature: 1.4,
                                maxTokens: 4_096,
                            },
                            verbosity: 'balanced',
                        },
                        streaming: {
                            enabled: false,
                            ttsEnabled: false,
                            ttsChunkChars: 800,
                            turnReadPollIntervalMs: 200,
                            turnReadMaxEvents: 128,
                            turnStreamTimeoutMs: 600_000,
                        },
                    } },
                },
            }),
        });

        expect(snapshot.properties.acct_setting__voice__providerId).toBe('local_conversation');
        expect(snapshot.properties.acct_setting__voice__uiScopeDefault).toBe('session');
        expect(snapshot.properties.acct_setting__voice__uiSurfaceLocation).toBe('session');
        expect(snapshot.properties.acct_setting__voice__uiActivityFeedEnabled).toBe(true);
        expect(snapshot.properties.acct_setting__voice__uiUpdatesOtherSessions).toBe('snippets');
        expect(snapshot.properties.acct_setting__voice__uiUpdatesSnippetsMaxMessagesBucket).toBe('large');
        expect(snapshot.properties.acct_setting__voice__privacyShareDeviceInventory).toBe(false);
        expect(snapshot.properties.acct_setting__voice__privacyRecentMessagesCountBucket).toBe('large');
        expect(snapshot.properties.acct_setting__voice__realtimeElevenLabsBillingMode).toBe('byo');
        expect(snapshot.properties.acct_setting__voice__assistantLanguageConfigured).toBe(true);
        expect(snapshot.properties.acct_setting__voice__welcomeEnabled).toBe(true);
        expect(snapshot.properties.acct_setting__voice__welcomeMode).toBe('on_first_turn');
        expect(snapshot.properties.acct_setting__voice__welcomeTemplateConfigured).toBe(true);
        expect(snapshot.properties).not.toHaveProperty('acct_setting__voice__realtimeElevenLabsWelcomeEnabled');
        expect(snapshot.properties).not.toHaveProperty('acct_setting__voice__localConversationAgentWelcomeEnabled');
        expect(snapshot.properties.acct_setting__voice__realtimeElevenLabsTtsVoiceIdKind).toBe('custom');
        expect(snapshot.properties.acct_setting__voice__realtimeElevenLabsByoAgentConfigured).toBe(true);
        expect(snapshot.properties.acct_setting__voice__localDirectHandsFreeEnabled).toBe(true);
        expect(snapshot.properties.acct_setting__voice__localDirectNetworkTimeoutBucket).toBe('large');
        expect(snapshot.properties.acct_setting__voice__localConversationConversationMode).toBe('agent');
        expect(snapshot.properties.acct_setting__voice__localConversationAgentBackend).toBe('openai_compat');
        expect(snapshot.properties.acct_setting__voice__localConversationAgentFixedMachineConfigured).toBe(true);
        expect(snapshot.properties.acct_setting__voice__localConversationAgentCustomVoiceHomeConfigured).toBe(true);
        expect(snapshot.properties.acct_setting__voice__localConversationAgentResumabilityMode).toBe('provider_resume');
        expect(snapshot.properties.acct_setting__voice__localConversationAgentOpenaiCompatChatBaseUrlConfigured).toBe(true);
        expect(snapshot.properties.acct_setting__voice__localConversationAgentOpenaiCompatTemperatureBucket).toBe('high');
        expect(snapshot.properties.acct_setting__voice__localConversationStreamingTurnStreamTimeoutBucket).toBe('large');
    });

    it('never serializes unknown provider config into generic analytics properties', () => {
        const secretSentinel = 'do-not-export-open-provider-config';
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            voice: voiceSettingsParse({
                providerId: 'future_vendor',
                providers: {
                    future_vendor: {
                        schemaVersion: 9,
                        config: { nested: { secretSentinel } },
                    },
                },
            }),
        });

        expect(snapshot.properties.acct_setting__voice__providerId).toBe('future_vendor');
        expect(JSON.stringify(snapshot.properties)).not.toContain(secretSentinel);
    });
});
