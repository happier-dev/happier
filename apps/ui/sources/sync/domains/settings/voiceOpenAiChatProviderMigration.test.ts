import { describe, expect, it } from 'vitest';

import {
    ProviderSettingsV1Schema,
    readProviderSettingsFromAccountSettingsV1,
} from '@happier-dev/protocol';

import { readLocalConversationVoiceSettings } from './voiceSettings';
import { settingsParse } from './settings';

const LEGACY_CHAT_SECRET = {
    id: 'voice:openai_compat:chat_api_key',
    name: 'Voice: openai_compat',
    kind: 'apiKey' as const,
    encryptedValue: { _isSecretValue: true as const, value: 'sk-existing' },
    createdAt: 0,
    updatedAt: 0,
};

function legacyAccount(agent: Readonly<{ agentSource: 'session' | 'agent'; agentId: string }>) {
    return {
        voice: {
            providerId: 'local_conversation',
            adapters: {
                local_conversation: {
                    conversationMode: 'agent',
                    agent: {
                        backend: 'openai_compat',
                        ...agent,
                        permissionPolicy: 'read_only',
                        openaiCompat: {
                            chatBaseUrl: 'http://127.0.0.1:11434/v1',
                            chatApiKey: LEGACY_CHAT_SECRET.encryptedValue,
                            chatModel: 'qwen-chat',
                            commitModel: 'qwen-commit',
                            temperature: 0.25,
                            maxTokens: 2048,
                        },
                    },
                },
            },
        },
    } as const;
}

describe('legacy Voice OpenAI-compatible Chat Provider migration', () => {
    it('does not treat the unshipped voiceSettingsV1 intermediary as a compatibility source', () => {
        const parsed = settingsParse({
            secrets: [LEGACY_CHAT_SECRET],
            voiceSettingsV1: {
                credentialBindings: [{
                    providerId: 'openai_compat',
                    credentialBindings: {
                        account: { chat_api_key: LEGACY_CHAT_SECRET.id },
                    },
                }],
                providers: {
                    local_conversation: {
                        schemaVersion: 1,
                        config: {
                            conversationMode: 'agent',
                            agent: {
                                backend: 'openai_compat',
                                agentSource: 'agent',
                                agentId: 'opencode',
                                openaiCompat: {
                                    chatBaseUrl: 'http://127.0.0.1:11434/v1',
                                    chatModel: 'qwen-chat',
                                    commitModel: 'qwen-commit',
                                    temperature: 0.25,
                                    maxTokens: 2048,
                                },
                            },
                        },
                    },
                },
            },
        });

        expect(readProviderSettingsFromAccountSettingsV1(parsed).settings.connections).toEqual([]);
        expect(readLocalConversationVoiceSettings(parsed.voice).agent.providerChat).toBeNull();
    });

    it('rebinds the existing SavedSecret and imports both models without copying secret material', () => {
        const parsed = settingsParse(legacyAccount({ agentSource: 'agent', agentId: 'opencode' }));
        const providerSettings = readProviderSettingsFromAccountSettingsV1(parsed).settings;

        expect(ProviderSettingsV1Schema.safeParse(providerSettings).success).toBe(true);
        expect(providerSettings.connections).toHaveLength(1);
        const connection = providerSettings.connections[0]!;
        expect(connection).toMatchObject({
            source: {
                kind: 'custom',
                template: {
                    endpointTemplates: [{
                        protocol: 'openai-chat',
                        baseUrl: 'http://127.0.0.1:11434/v1',
                    }],
                },
            },
        });
        expect(providerSettings.secretBindingsByConnectionId[connection.id]).toEqual({
            account: { apiKey: LEGACY_CHAT_SECRET.id },
        });
        expect(providerSettings.manualModelsByConnectionId[connection.id]).toEqual([
            { id: 'qwen-chat', addedAt: 0 },
            { id: 'qwen-commit', addedAt: 0 },
        ]);
        expect(parsed.secrets).toEqual([LEGACY_CHAT_SECRET]);
        expect(JSON.stringify(parsed.voice.credentialBindings)).not.toContain('chat_api_key');

        const providerChat = readLocalConversationVoiceSettings(parsed.voice).agent.providerChat;
        expect(providerChat).toEqual({
            status: 'configured',
            chat: {
                agentTargetKey: 'backend:opencode',
                providerConnectionId: connection.id,
                modelId: 'qwen-chat',
            },
            commit: {
                agentTargetKey: 'backend:opencode',
                providerConnectionId: connection.id,
                modelId: 'qwen-commit',
            },
            configuration: {
                temperature: 0.25,
            },
        });
        expect(providerChat?.status).toBe('configured');
        if (providerChat?.status !== 'configured') throw new Error('Expected configured Provider Chat');
        expect(providerChat.configuration).not.toHaveProperty('maxTokens');
    });

    it('fails closed into one typed selection request for the default Claude target', () => {
        const parsed = settingsParse(legacyAccount({ agentSource: 'session', agentId: 'claude' }));
        const providerSettings = readProviderSettingsFromAccountSettingsV1(parsed).settings;
        const connection = providerSettings.connections[0]!;

        expect(readLocalConversationVoiceSettings(parsed.voice).agent.providerChat).toEqual({
            status: 'needs_selection',
            providerConnectionId: connection.id,
            chatModelId: 'qwen-chat',
            commitModelId: 'qwen-commit',
            configuration: {
                temperature: 0.25,
            },
        });
        const migratedAgent = readLocalConversationVoiceSettings(parsed.voice).agent;
        expect(migratedAgent.agentId).toBe('claude');
        expect(migratedAgent.providerChat).not.toHaveProperty('chat');
        expect(migratedAgent.providerChat).not.toHaveProperty('commit');
    });

    it('marks malformed legacy direct Chat configuration as requiring migration instead of falling back', () => {
        const base = legacyAccount({ agentSource: 'agent', agentId: 'opencode' });
        const input = {
            ...base,
            voice: {
                ...base.voice,
                adapters: {
                    local_conversation: {
                        ...base.voice.adapters.local_conversation,
                        agent: {
                            ...base.voice.adapters.local_conversation.agent,
                            openaiCompat: {
                                ...base.voice.adapters.local_conversation.agent.openaiCompat,
                                chatBaseUrl: '   ',
                            },
                        },
                    },
                },
            },
        };

        const parsed = settingsParse(input);

        expect(readLocalConversationVoiceSettings(parsed.voice).agent.providerChat).toEqual({
            status: 'migration_required',
            reason: 'invalid_legacy_configuration',
        });
        expect(readProviderSettingsFromAccountSettingsV1(parsed).settings.connections).toEqual([]);
    });

    it('is idempotent after canonical state has been written', () => {
        const once = settingsParse(legacyAccount({ agentSource: 'agent', agentId: 'opencode' }));
        const twice = settingsParse(once);
        const onceProvider = readProviderSettingsFromAccountSettingsV1(once).settings;
        const twiceProvider = readProviderSettingsFromAccountSettingsV1(twice).settings;

        expect(twiceProvider).toEqual(onceProvider);
        expect(twice.secrets).toEqual(once.secrets);
        expect(readLocalConversationVoiceSettings(twice.voice).agent.providerChat).toEqual(
            readLocalConversationVoiceSettings(once.voice).agent.providerChat,
        );
    });

});
