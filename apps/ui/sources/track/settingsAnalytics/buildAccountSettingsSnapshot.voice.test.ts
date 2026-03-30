import { describe, expect, it } from 'vitest';

import { settingsDefaults } from '@/sync/domains/settings/settings';

import { buildAccountSettingsSnapshot } from './buildAccountSettingsSnapshot';
import { buildSecretValue } from './settingsAnalytics.testkit';

describe('buildAccountSettingsSnapshot', () => {
    it('tracks voice settings through canonical structured analytics serializers', () => {
        const snapshot = buildAccountSettingsSnapshot({
            ...settingsDefaults,
            voice: {
                ...settingsDefaults.voice,
                providerId: 'local_conversation',
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
                adapters: {
                    ...settingsDefaults.voice.adapters,
                    realtime_elevenlabs: {
                        ...settingsDefaults.voice.adapters.realtime_elevenlabs,
                        assistantLanguage: 'fr',
                        billingMode: 'byo',
                        welcome: {
                            enabled: true,
                            mode: 'on_first_turn',
                            templateId: 'welcome-template',
                        },
                        tts: {
                            ...settingsDefaults.voice.adapters.realtime_elevenlabs.tts,
                            voiceId: 'custom-voice',
                            modelId: 'eleven_turbo_v2',
                            voiceSettings: {
                                ...settingsDefaults.voice.adapters.realtime_elevenlabs.tts.voiceSettings,
                                stability: 0.2,
                                similarityBoost: 0.85,
                                style: 0.6,
                                useSpeakerBoost: true,
                                speed: 1.5,
                            },
                        },
                        byo: {
                            agentId: 'byo-agent',
                            apiKey: buildSecretValue('secret-value'),
                        },
                    },
                    local_direct: {
                        ...settingsDefaults.voice.adapters.local_direct,
                        networkTimeoutMs: 25_000,
                        handsFree: {
                            enabled: true,
                            endpointing: {
                                silenceMs: 900,
                                minSpeechMs: 250,
                            },
                        },
                    },
                    local_conversation: {
                        ...settingsDefaults.voice.adapters.local_conversation,
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
                            ...settingsDefaults.voice.adapters.local_conversation.agent,
                            backend: 'openai_compat',
                            agentSource: 'agent',
                            machineTargetMode: 'fixed',
                            machineTargetId: 'machine-1',
                            stayInVoiceHome: true,
                            teleportEnabled: false,
                            rootSessionPolicy: 'keep_warm',
                            maxWarmRoots: 5,
                            voiceHomeSubdirName: 'custom-home',
                            permissionPolicy: 'no_tools',
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
                            welcome: {
                                enabled: true,
                                mode: 'on_first_turn',
                                templateId: 'voice-welcome',
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
                    },
                },
            },
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
        expect(snapshot.properties.acct_setting__voice__realtimeElevenLabsAssistantLanguageConfigured).toBe(true);
        expect(snapshot.properties.acct_setting__voice__realtimeElevenLabsWelcomeTemplateConfigured).toBe(true);
        expect(snapshot.properties.acct_setting__voice__realtimeElevenLabsTtsVoiceIdKind).toBe('custom');
        expect(snapshot.properties.acct_setting__voice__realtimeElevenLabsByoApiKeyConfigured).toBe(true);
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
});

