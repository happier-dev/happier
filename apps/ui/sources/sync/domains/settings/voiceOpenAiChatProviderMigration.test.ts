import { describe, expect, it } from 'vitest';

import { readLocalConversationVoiceSettings, voiceSettingsDefaults, writeLocalConversationVoiceSettings } from './voiceSettings';
import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderSettingsV1Schema } from '@happier-dev/protocol/providers/settings/v1';
import { normalizeCustomProviderTemplateV1 } from '@happier-dev/protocol/providers/connections/normalizeCustomTemplateV1';
import { settingsParse } from './settings';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { readSavedSecretTransferSourceV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { normalizeVoiceSettingsLocalDelta, normalizeVoiceSettingsServerDelta } from './voiceSettingsPersistence';

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
    it('derives predecessor generation settings only from the acknowledged Provider connection', () => {
        const id = 'voice-openai-compatible-chat';
        const target = 'agent:happier.agent.opencode/opencode';
        const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const voice = writeLocalConversationVoiceSettings(voiceSettingsDefaults, { ...local, agent: {
            ...local.agent, agentSource: 'agent', agentId: 'opencode', providerChat: {
                status: 'configured',
                chat: { agentTargetKey: target, providerConnectionId: id, modelId: 'chat' },
                commit: { agentTargetKey: target, providerConnectionId: id, modelId: 'commit' },
            },
        } });
        const providerSettings = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{
            v: 1, id, role: 'named', displayName: 'Voice Chat', displayNameMode: 'custom',
            revision: 1, createdAt: 0, updatedAt: 0,
            source: { kind: 'custom', template: normalizeCustomProviderTemplateV1({
                name: 'Voice Chat', protocol: 'openai-chat', baseUrl: 'https://chat.example.test/v1', catalog: 'manual',
            }) },
            modelSettings: { chat: { temperature: 0.4, maxTokens: 2048 }, commit: { temperature: 0.2, maxTokens: 2048 } },
        }] });
        expect(normalizeVoiceSettingsServerDelta({ voiceSettingsV1: voice }, undefined, providerSettings))
            .toMatchObject({ voice: { adapters: { local_conversation: { agent: { openaiCompat: {
                temperature: 0.4, maxTokens: 2048,
            } } } } } });
    });

    it('keeps the actual promoted Resource identity with the original pending Chat carrier until Provider acknowledgment', () => {
        const predecessor = legacyAccount({ agentSource: 'agent', agentId: 'opencode' });
        const personal = { ...LEGACY_CHAT_SECRET, id: 'my-existing-chat-key' };
        const resourceRef = formatSharedSavedSecretRefV1('2cd702f5-1111-4222-8333-444455556666');
        const source = { ...predecessor, secrets: [personal], voice: { ...predecessor.voice,
            credentialBindings: [{ providerId: 'openai_compat', credentialBindings: { account: { chat_api_key: personal.id } } }],
        } };
        // The observed full S2 preparation changes only this reference and removes
        // its personal record. Material admission is not the serializer's role.
        const prepared = { ...source, secrets: [], voice: { ...source.voice,
            credentialBindings: [{ providerId: 'openai_compat', credentialBindings: { account: { chat_api_key: resourceRef } } }],
        } };
        const normalized = normalizeVoiceSettingsServerDelta(prepared, source);
        expect(readSavedSecretTransferSourceV1(normalized).legacyChatCredential?.source)
            .toEqual({ kind: 'existing-resource-reference', resourceRef });
        expect(readLocalConversationVoiceSettings(settingsParse(normalized).voice).agent.providerChat)
            .toEqual({ status: 'migration_required', reason: 'provider_catalog_import_required' });
        expect(Reflect.get(normalized, 'secrets')).toEqual([]);
        const voice = settingsParse(normalized).voice;
        const local = readLocalConversationVoiceSettings(voice);
        for (const providerChat of [null, { status: 'needs_selection' as const,
            providerConnectionId: 'voice-openai-compatible-chat', chatModelId: 'qwen-chat', commitModelId: 'qwen-commit',
        }]) {
            const changedVoice = writeLocalConversationVoiceSettings(voice, { ...local, agent: { ...local.agent, providerChat } });
            const retired = normalizeVoiceSettingsServerDelta({ ...normalized,
                ...normalizeVoiceSettingsLocalDelta({ voice: changedVoice }, normalized),
            }, normalized);
            expect(readSavedSecretTransferSourceV1(retired).legacyChatCredential).toBeUndefined();
            expect(JSON.stringify(Reflect.get(retired, 'voice'))).not.toContain('chat_api_key');
            expect(Reflect.get(retired, 'voice')).toMatchObject({ adapters: { local_conversation: {
                agent: expect.not.objectContaining({ openaiCompat: expect.anything() }),
            } } });
        }
    });
    it('preserves an unchanged non-Chat inline credential source without publishing a GET annotation', () => {
        const source = { voice: { providerId: 'realtime_elevenlabs', adapters: { realtime_elevenlabs: {
            byo: { apiKey: { _isSecretValue: true, value: 'retained-elevenlabs-value' } },
        } } }, untouched: { preserve: true } };
        expect(normalizeVoiceSettingsServerDelta(source, source)).toEqual(source);
    });
    it.each(['material', 'url', 'personal-identity'] as const)('does not preserve unchanged-source authority after an explicit %s change', change => {
        const predecessor = legacyAccount({ agentSource: 'agent', agentId: 'opencode' });
        const bound = { ...LEGACY_CHAT_SECRET, id: 'my-existing-chat-key' };
        const alternate = { ...bound, id: 'another-existing-chat-key' };
        const source = { ...predecessor, secrets: [bound, alternate], voice: { ...predecessor.voice,
            credentialBindings: [{ providerId: 'openai_compat', credentialBindings: { account: { chat_api_key: bound.id } } }],
        } };
        const local = source.voice.adapters.local_conversation;
        const next = { ...source, voice: { ...source.voice,
            credentialBindings: [{ providerId: 'openai_compat', credentialBindings: { account: {
                chat_api_key: change === 'personal-identity' ? alternate.id : bound.id,
            } } }],
            adapters: { local_conversation: { ...local, agent: { ...local.agent, openaiCompat: {
                ...local.agent.openaiCompat,
                chatBaseUrl: change === 'url' ? 'https://changed-chat.test/v1' : local.agent.openaiCompat.chatBaseUrl,
                chatApiKey: change === 'material' ? { _isSecretValue: true, value: 'changed-key' } : local.agent.openaiCompat.chatApiKey,
            } } } },
        } };
        expect(() => normalizeVoiceSettingsServerDelta(next, source)).toThrow('voice_provider_catalog_unavailable');
    });
    it.each(['none', 'inline', 'resource', 'invalid-url'] as const)('preserves the actual raw GET source before Resource and Provider acknowledgment (%s)', credential => {
        const predecessor = legacyAccount({ agentSource: 'agent', agentId: 'opencode' });
        const local = predecessor.voice.adapters.local_conversation;
        const source = { ...predecessor, secrets: [], voice: { ...predecessor.voice,
            ...(credential === 'resource' ? { credentialBindings: [{ providerId: 'openai_compat', credentialBindings: {
                account: { chat_api_key: formatSharedSavedSecretRefV1('2cd702f5-1111-4222-8333-444455556666') },
            } }] } : {}),
            adapters: { local_conversation: { ...local, agent: { ...local.agent,
                openaiCompat: { ...local.agent.openaiCompat,
                    chatBaseUrl: credential === 'invalid-url' ? '' : local.agent.openaiCompat.chatBaseUrl,
                    chatApiKey: credential === 'none' ? null : LEGACY_CHAT_SECRET.encryptedValue },
            } } },
        } };
        const normalized = normalizeVoiceSettingsServerDelta(source, source);
        expect(Reflect.get(normalized, 'voice')).toMatchObject({ adapters: { local_conversation: { agent: {
            backend: 'openai_compat', openaiCompat: source.voice.adapters.local_conversation.agent.openaiCompat,
        } } } });
        expect(Reflect.get(normalized, 'secrets')).toEqual([]);
        // A runtime pending annotation is not a source transfer or a reason for GET writeback.
        expect(normalized).toEqual(source);
    });
    it('keeps an existing Resource-bound genuine inline Chat source pending material admission rather than inventing a personal alias', () => {
        const source = legacyAccount({ agentSource: 'agent', agentId: 'opencode' });
        const parsed = settingsParse({ ...source, secrets: [], voice: { ...source.voice,
            credentialBindings: [{ providerId: 'openai_compat', credentialBindings: { account: {
                chat_api_key: formatSharedSavedSecretRefV1('2cd702f5-1111-4222-8333-444455556666'),
            } } }],
        } });
        expect(parsed.secrets).toEqual([]);
        expect(readLocalConversationVoiceSettings(parsed.voice).agent.providerChat).toEqual({
            status: 'migration_required', reason: 'provider_catalog_import_required',
        });
    });
    it('does not migrate an inactive Chat configuration carried by the predecessor daemon selection', () => {
        const source = legacyAccount({ agentSource: 'agent', agentId: 'opencode' });
        const local = source.voice.adapters.local_conversation;
        const parsed = settingsParse({ ...source, voice: { ...source.voice, adapters: {
            local_conversation: { ...local, agent: { ...local.agent, backend: 'daemon' } },
        } } });
        expect(readLocalConversationVoiceSettings(parsed.voice).agent.providerChat).toBeNull();
        expect(Reflect.get(parsed, 'providerSettingsV1')).toBeUndefined();
    });

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

        expect(Reflect.get(parsed, 'providerSettingsV1')).toBeUndefined();
        expect(readLocalConversationVoiceSettings(parsed.voice).agent.providerChat).toBeNull();
    });

    it('retains the genuine source and blocks execution until the Provider import is acknowledged', () => {
        const parsed = settingsParse(legacyAccount({ agentSource: 'agent', agentId: 'opencode' }));
        expect(parsed.secrets).toEqual([LEGACY_CHAT_SECRET]);
        expect(JSON.stringify(parsed.voice.credentialBindings)).not.toContain('chat_api_key');
        expect(Reflect.get(parsed, 'providerSettingsV1')).toBeUndefined();
        expect(readLocalConversationVoiceSettings(parsed.voice).agent.providerChat).toEqual({
            status: 'migration_required',
            reason: 'provider_catalog_import_required',
        });
    });

    it.each([true, false])('uses the actual predecessor Chat binding only when its material matches the inline source (%s)', (matches) => {
        const source = legacyAccount({ agentSource: 'agent', agentId: 'opencode' });
        const existing = {
            ...LEGACY_CHAT_SECRET,
            id: 'my-existing-chat-key',
            encryptedValue: matches ? LEGACY_CHAT_SECRET.encryptedValue : { _isSecretValue: true as const, value: 'different-key' },
        };
        const parsed = settingsParse({
            ...source,
            secrets: [existing],
            voice: {
                ...source.voice,
                credentialBindings: [{
                    providerId: 'openai_compat',
                    credentialBindings: { account: { chat_api_key: existing.id } },
                }],
            },
        });

        expect(parsed.secrets).toEqual([existing]);
        expect(readLocalConversationVoiceSettings(parsed.voice).agent.providerChat).toEqual({
            status: 'migration_required',
            reason: matches ? 'provider_catalog_import_required' : 'invalid_legacy_configuration',
        });
    });

    it('does not publish a selection request before the default Claude source has been imported', () => {
        const parsed = settingsParse(legacyAccount({ agentSource: 'session', agentId: 'claude' }));
        expect(readLocalConversationVoiceSettings(parsed.voice).agent.providerChat).toEqual({
            status: 'migration_required',
            reason: 'provider_catalog_import_required',
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
        expect(Reflect.get(parsed, 'providerSettingsV1')).toBeUndefined();
    });

    it('is idempotent after canonical state has been written', () => {
        const once = settingsParse(legacyAccount({ agentSource: 'agent', agentId: 'opencode' }));
        const twice = settingsParse(once);
        expect(Reflect.get(twice, 'providerSettingsV1')).toBeUndefined();
        expect(twice.secrets).toEqual(once.secrets);
        expect(readLocalConversationVoiceSettings(twice.voice).agent.providerChat).toEqual(
            readLocalConversationVoiceSettings(once.voice).agent.providerChat,
        );
    });

});
