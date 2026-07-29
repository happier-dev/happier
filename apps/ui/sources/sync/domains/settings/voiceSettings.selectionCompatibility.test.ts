import { describe, expect, it } from 'vitest';

import {
    sealSecretsDeep,
    unsealSecretsDeepWithKeys,
} from '@/sync/encryption/secretSettings';

import { parsePendingSettings } from '../state/persistence';
import {
    readLocalConversationVoiceSettings,
    writeLocalConversationVoiceSettings,
} from './voiceSettings';
import { settingsParse } from './settings';
import {
    VOICE_SETTINGS_CURRENT_WRITER_MARKER,
    normalizeVoiceSettingsLocalDelta,
    normalizeVoiceSettingsServerDelta,
} from './voiceSettingsPersistence';

const REMOTE_DEV_PREDECESSOR_HEAD = '1b32cdc6f3f978c06484be49e52c9e4039e0fd71';
const EXTERNAL_PROVIDER_ID = 'acme.synthetic-voice/conversation';
const EXTERNAL_CONFIG = {
    endpoint: 'https://voice.example.test/v1',
    voice: { kind: 'catalog', id: 'alloy' },
    strictMode: true,
} as const;
const REALTIME_CODEX_GLOBAL_CONNECTED_SERVICES = {
    v: 1,
    bindingsByServiceId: {
        'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'codex-work-profile',
        },
    },
} as const;
const CURRENT_ELEVENLABS_BYO_CONFIG = {
    mode: 'default',
    billingMode: 'byo',
    tts: {
        voiceId: 'EST9Ui6982FZPSi7gCHi',
        modelId: null,
        voiceSettings: {
            stability: null,
            similarityBoost: null,
            style: null,
            useSpeakerBoost: null,
            speed: null,
        },
    },
    byo: { agentId: 'agent_1' },
} as const;

function predecessorVoiceWrite(
    persisted: Readonly<Record<string, unknown>>,
    patch: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
    const currentVoice = persisted.voice as Readonly<Record<string, unknown>>;
    return {
        ...persisted,
        voice: {
            providerId: currentVoice.providerId,
            assistantLanguage: currentVoice.assistantLanguage,
            ui: currentVoice.ui,
            privacy: currentVoice.privacy,
            adapters: currentVoice.adapters,
            ...patch,
        },
    };
}

describe('Voice provider selection persistence compatibility', () => {
    it('makes current UI Dictation and Local Voice STT selections authoritative over the compatibility sidecar', () => {
        const current = settingsParse({
            voice: {
                providerId: 'local_conversation',
                dictation: {
                    sttBinding: 'explicit',
                    stt: { provider: 'local_neural' },
                },
                providers: {
                    local_conversation: {
                        schemaVersion: 1,
                        config: {
                            stt: { provider: 'local_neural' },
                            tts: { provider: 'device' },
                        },
                    },
                },
            },
        });
        const currentConversation = readLocalConversationVoiceSettings(current.voice);
        const nextVoice = writeLocalConversationVoiceSettings(
            {
                ...current.voice,
                dictation: {
                    ...current.voice.dictation,
                    stt: {
                        ...current.voice.dictation.stt,
                        provider: 'device',
                    },
                },
            },
            {
                ...currentConversation,
                stt: {
                    ...currentConversation.stt,
                    provider: 'device',
                },
            },
        );

        const normalized = normalizeVoiceSettingsLocalDelta(
            { voice: nextVoice },
            current,
        ) as Readonly<{
            voice: typeof nextVoice;
            voiceSettingsV1: typeof nextVoice;
        }>;

        expect(normalized.voice.dictation.stt.provider).toBe('device');
        expect(normalized.voiceSettingsV1.dictation.stt.provider).toBe('device');
        expect(readLocalConversationVoiceSettings(normalized.voice).stt.provider).toBe('device');
        expect(readLocalConversationVoiceSettings(normalized.voiceSettingsV1).stt.provider).toBe('device');
    });

    it('survives a predecessor whole-object write with the exact external config', () => {
        // Provenance-pinned vector from remote-dev at REMOTE_DEV_PREDECESSOR_HEAD:
        // accountSettingsParse preserves unknown account-root fields, while
        // voiceSettingsParse strips providers, credentialBindings, executionMachine,
        // welcome, diagnostics, and every other future nested Voice field.
        expect(REMOTE_DEV_PREDECESSOR_HEAD).toHaveLength(40);

        const runtimeSettings = settingsParse({
            voice: {
                providerId: EXTERNAL_PROVIDER_ID,
                dictation: {
                    sttBinding: 'explicit',
                    language: 'de',
                    stt: { provider: 'device' },
                },
                providers: {
                    [EXTERNAL_PROVIDER_ID]: {
                        schemaVersion: 1,
                        config: EXTERNAL_CONFIG,
                    },
                },
            },
        });
        const persisted = normalizeVoiceSettingsServerDelta(runtimeSettings) as Record<string, unknown>;
        const predecessorVisibleVoice = persisted.voice as Record<string, unknown>;

        expect(predecessorVisibleVoice.providerId).toBe('off');
        expect(predecessorVisibleVoice[VOICE_SETTINGS_CURRENT_WRITER_MARKER]).toBe(true);
        expect((persisted.voiceSettingsV1 as Record<string, unknown>).providerId).toBe(EXTERNAL_PROVIDER_ID);

        const unrelatedPredecessorWrite = { ...persisted, preferredLanguage: 'fr' };
        expect(settingsParse(unrelatedPredecessorWrite).voice.providerId).toBe(EXTERNAL_PROVIDER_ID);

        const predecessorWriterOutput = predecessorVoiceWrite(persisted, { assistantLanguage: 'fr' });
        const restored = settingsParse(predecessorWriterOutput);

        expect(restored.voice.providerId).toBeNull();
        expect(restored.voice.assistantLanguage).toBe('fr');
        expect(restored.voice.dictation).toMatchObject({
            sttBinding: 'explicit',
            language: 'de',
            stt: { provider: 'device' },
        });
        expect(restored.voice.providers[EXTERNAL_PROVIDER_ID]).toEqual({
            schemaVersion: 1,
            config: EXTERNAL_CONFIG,
        });

        const recoveredPending = parsePendingSettings(persisted) as Record<string, unknown>;
        expect((recoveredPending.voice as Record<string, unknown>).providerId).toBe('off');
        expect((recoveredPending.voiceSettingsV1 as Record<string, unknown>).providerId).toBe(EXTERNAL_PROVIDER_ID);
        expect(settingsParse(recoveredPending).voice.providers[EXTERNAL_PROVIDER_ID]?.config).toEqual(EXTERNAL_CONFIG);
    });

    it('preserves canonical current-only fields when the final writer sees a sparse predecessor Voice delta', () => {
        const persisted = normalizeVoiceSettingsServerDelta(settingsParse({
            voice: {
                providerId: EXTERNAL_PROVIDER_ID,
                dictation: {
                    sttBinding: 'explicit',
                    language: 'de',
                    stt: { provider: 'device' },
                },
                providers: {
                    [EXTERNAL_PROVIDER_ID]: {
                        schemaVersion: 1,
                        config: EXTERNAL_CONFIG,
                    },
                },
            },
        })) as Record<string, unknown>;
        expect((persisted.voiceSettingsV1 as Record<string, unknown>).providerId).toBe(EXTERNAL_PROVIDER_ID);

        // Crash-recovered pending settings are sparse top-level deltas. At the
        // final write boundary they overlay the raw account baseline before
        // compatibility normalization, so this is the exact mixed-version
        // object that must not replace voiceSettingsV1 with parser defaults.
        const finalWrite = normalizeVoiceSettingsServerDelta({
            ...persisted,
            voice: { assistantLanguage: 'fr' },
        }) as Record<string, unknown>;
        const canonical = finalWrite.voiceSettingsV1 as Record<string, unknown>;

        expect(canonical).toMatchObject({
            providerId: EXTERNAL_PROVIDER_ID,
            assistantLanguage: 'fr',
            dictation: {
                sttBinding: 'explicit',
                language: 'de',
                stt: { provider: 'device' },
            },
            providers: {
                [EXTERNAL_PROVIDER_ID]: {
                    schemaVersion: 1,
                    config: EXTERNAL_CONFIG,
                },
            },
        });
        expect((finalWrite.voice as Record<string, unknown>).providerId).toBe('off');
    });

    it('preserves the current-only Codex global binding when the predecessor writes Voice as off', () => {
        const current = settingsParse({
            voice: {
                providerId: 'realtime_codex',
                providers: {
                    realtime_codex: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: REALTIME_CODEX_GLOBAL_CONNECTED_SERVICES,
                        },
                    },
                },
            },
        });
        const persisted = normalizeVoiceSettingsServerDelta(current) as Record<string, unknown>;

        expect((persisted.voice as Record<string, unknown>).providerId).toBe('off');
        expect((persisted.voiceSettingsV1 as Record<string, unknown>).providerId).toBe('realtime_codex');

        const restored = settingsParse(predecessorVoiceWrite(persisted, {
            providerId: 'off',
            assistantLanguage: 'de',
        }));

        expect(restored.voice.providerId).toBeNull();
        expect(restored.voice.assistantLanguage).toBe('de');
        expect(restored.voice.providers.realtime_codex).toEqual({
            schemaVersion: 2,
            config: {
                globalConnectedServices: REALTIME_CODEX_GLOBAL_CONNECTED_SERVICES,
            },
        });
    });

    it('makes observable predecessor built-in and off selections authoritative', () => {
        const externalPersisted = normalizeVoiceSettingsServerDelta(settingsParse({
            voice: {
                providerId: EXTERNAL_PROVIDER_ID,
                providers: {
                    [EXTERNAL_PROVIDER_ID]: { schemaVersion: 1, config: EXTERNAL_CONFIG },
                },
            },
        })) as Record<string, unknown>;

        const selectedBuiltIn = settingsParse(predecessorVoiceWrite(externalPersisted, {
            providerId: 'local_direct',
        }));
        expect(selectedBuiltIn.voice.providerId).toBe('local_direct');

        const builtInPersisted = normalizeVoiceSettingsServerDelta(selectedBuiltIn) as Record<string, unknown>;
        expect((builtInPersisted.voiceSettingsV1 as Record<string, unknown>).providerId).toBe('local_direct');

        const selectedOff = settingsParse(predecessorVoiceWrite(builtInPersisted, {
            providerId: 'off',
        }));
        expect(selectedOff.voice.providerId).toBeNull();
        expect((selectedOff as unknown as Record<string, unknown>).voiceSettingsV1).toEqual(
            expect.objectContaining({ providerId: null }),
        );
    });

    it('round-trips pinned predecessor adapter edits through provider-owned migrations', () => {
        const current = settingsParse({
            voice: {
                providerId: 'local_conversation',
                welcome: { enabled: true, mode: 'on_first_turn', templateId: 'welcome-current' },
                executionMachine: { mode: 'fixed', machineId: 'machine-current', autoMachineId: null },
                providers: {
                    local_direct: {
                        schemaVersion: 1,
                        config: {
                            networkTimeoutMs: 21_000,
                            stt: { provider: 'device' },
                            tts: { provider: 'device' },
                        },
                    },
                    local_conversation: {
                        schemaVersion: 1,
                        config: {
                            conversationMode: 'agent',
                            networkTimeoutMs: 22_000,
                            agent: { verbosity: 'balanced' },
                        },
                    },
                },
            },
        });
        const persisted = normalizeVoiceSettingsServerDelta(current) as Record<string, unknown>;
        const predecessorVoice = persisted.voice as Readonly<{
            adapters: Readonly<{
                local_direct: Readonly<Record<string, unknown> & { networkTimeoutMs: number }>;
                local_conversation: Readonly<Record<string, unknown> & {
                    networkTimeoutMs: number;
                    agent: Readonly<Record<string, unknown>>;
                }>;
            }>;
        }>;

        expect(predecessorVoice.adapters.local_direct.networkTimeoutMs).toBe(21_000);
        expect(predecessorVoice.adapters.local_conversation).toMatchObject({
            networkTimeoutMs: 22_000,
            agent: {
                verbosity: 'balanced',
                welcome: { enabled: true, mode: 'on_first_turn', templateId: 'welcome-current' },
                machineTargetMode: 'fixed',
                machineTargetId: 'machine-current',
            },
        });

        const oldEdited = predecessorVoiceWrite(persisted, {
            providerId: 'local_conversation',
            adapters: {
                ...predecessorVoice.adapters,
                local_direct: {
                    ...predecessorVoice.adapters.local_direct,
                    networkTimeoutMs: 31_000,
                },
                local_conversation: {
                    ...predecessorVoice.adapters.local_conversation,
                    networkTimeoutMs: 32_000,
                    agent: {
                        ...predecessorVoice.adapters.local_conversation.agent,
                        welcome: { enabled: false, mode: 'immediate', templateId: null },
                        machineTargetMode: 'auto',
                        machineTargetId: null,
                        autoTargetMachineId: 'machine-auto',
                    },
                },
            },
        });
        const restored = settingsParse(oldEdited);
        const root = (restored as unknown as Record<string, unknown>).voiceSettingsV1 as Readonly<{
            providers: Readonly<Record<string, Readonly<{
                config: Readonly<{ networkTimeoutMs: number }>;
            }>>>;
        }>;

        expect(root.providers.local_direct.config.networkTimeoutMs).toBe(31_000);
        expect(root.providers.local_conversation.config.networkTimeoutMs).toBe(32_000);
        expect(restored.voice.welcome).toEqual({ enabled: false, mode: 'immediate', templateId: null });
        expect(restored.voice.executionMachine).toEqual({
            mode: 'auto', machineId: null, autoMachineId: 'machine-auto',
        });
    });

    it('retains current-only provider fields and unowned welcome across an unrelated predecessor Voice edit', () => {
        const current = settingsParse({
            voice: {
                providerId: 'local_direct',
                welcome: { enabled: true, mode: 'on_first_turn', templateId: 'current-only-welcome' },
                providers: {
                    local_direct: {
                        schemaVersion: 1,
                        config: {
                            stt: {
                                provider: 'local_neural',
                                localNeural: { execution: 'daemon' },
                            },
                            tts: {
                                provider: 'local_neural',
                                localNeural: { execution: 'device' },
                            },
                        },
                    },
                },
            },
        });
        const persisted = normalizeVoiceSettingsServerDelta(current) as Record<string, unknown>;
        const restored = settingsParse(predecessorVoiceWrite(persisted, {
            assistantLanguage: 'it',
        }));
        const localDirect = restored.voice.providers.local_direct?.config as Readonly<{
            stt: { localNeural: { execution: string } };
            tts: { localNeural: { execution: string } };
        }>;

        expect(restored.voice.assistantLanguage).toBe('it');
        expect(restored.voice.welcome).toEqual({
            enabled: true,
            mode: 'on_first_turn',
            templateId: 'current-only-welcome',
        });
        expect(localDirect.stt.localNeural.execution).toBe('daemon');
        expect(localDirect.tts.localNeural.execution).toBe('device');
    });

    it('projects encrypted SavedSecret credentials for old readers and merges removal fail-closed', () => {
        const encryptedCredential = {
            _isSecretValue: true as const,
            encryptedValue: { t: 'enc-v1' as const, c: 'encrypted-elevenlabs-key' },
        };
        const current = settingsParse({
            secrets: [{
                id: 'voice-elevenlabs-secret',
                name: 'Voice ElevenLabs',
                kind: 'apiKey',
                encryptedValue: encryptedCredential,
                createdAt: 1,
                updatedAt: 1,
            }],
            voice: {
                providerId: 'realtime_elevenlabs',
                assistantLanguage: 'de',
                welcome: { enabled: true, mode: 'immediate', templateId: null },
                credentialBindings: [{
                    providerId: 'realtime_elevenlabs',
                    credentialBindings: { account: { api_key: 'voice-elevenlabs-secret' } },
                }],
                providers: {
                    realtime_elevenlabs: {
                        schemaVersion: 2,
                        config: CURRENT_ELEVENLABS_BYO_CONFIG,
                    },
                },
            },
        });
        const persisted = normalizeVoiceSettingsServerDelta(current) as unknown as Readonly<{
            voice: Readonly<{
                adapters: Readonly<{
                    realtime_elevenlabs: Readonly<Record<string, unknown> & {
                        byo: Readonly<Record<string, unknown>>;
                    }>;
                }>;
            }>;
        }>;
        const legacyElevenLabs = persisted.voice.adapters.realtime_elevenlabs;

        expect(legacyElevenLabs).toMatchObject({
            assistantLanguage: 'de',
            billingMode: 'byo',
            byo: { agentId: 'agent_1', apiKey: encryptedCredential },
        });
        expect(JSON.stringify(legacyElevenLabs)).not.toContain('"value"');

        const removedByOldClient = predecessorVoiceWrite(persisted, {
            adapters: {
                ...persisted.voice.adapters,
                realtime_elevenlabs: {
                    ...legacyElevenLabs,
                    byo: { ...legacyElevenLabs.byo, apiKey: null },
                },
            },
        });
        const restored = settingsParse(removedByOldClient);
        expect(restored.voice.credentialBindings).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ providerId: 'realtime_elevenlabs' }),
        ]));
    });

    it('limits the predecessor sidecar to the pinned ElevenLabs credential representation', () => {
        // Old-reader/new-writer vector pinned to the deployed legacy readers:
        // ui-web-v0.2.0@dc5203145dea46a1280286eb74d90f20d8b9e817,
        // ui-web-v0.2.2-preview.1775585938.1@4913c1e533c872a0712ba1c25b3104fd470aacc2,
        // ui-mobile-stable@e25a74bcc6c7032e2ced52cefdbd60c53636900e,
        // ui-mobile-preview@86d1385864dd528b864a8ba72e4c3201f67aece3,
        // and remote-dev@REMOTE_DEV_PREDECESSOR_HEAD. All read the same
        // SecretString-shaped ElevenLabs apiKey from nested voice while
        // stripping voiceSettingsV1-owned nested fields.
        expect(REMOTE_DEV_PREDECESSOR_HEAD).toHaveLength(40);

        const secret = (ciphertext: string) => ({
            _isSecretValue: true as const,
            encryptedValue: { t: 'enc-v1' as const, c: ciphertext },
        });
        const current = settingsParse({
            secrets: [
                {
                    id: 'voice-elevenlabs-secret',
                    name: 'Voice ElevenLabs',
                    kind: 'apiKey',
                    encryptedValue: secret('encrypted-elevenlabs-key'),
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    id: 'voice-google-gemini-secret',
                    name: 'Voice Google Gemini',
                    kind: 'apiKey',
                    encryptedValue: secret('encrypted-google-gemini-key'),
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    id: 'voice-google-cloud-secret',
                    name: 'Voice Google Cloud',
                    kind: 'apiKey',
                    encryptedValue: secret('encrypted-google-cloud-key'),
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    id: 'voice-openai-secret',
                    name: 'Voice OpenAI compatible',
                    kind: 'apiKey',
                    encryptedValue: secret('encrypted-openai-key'),
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
            voice: {
                providerId: 'realtime_elevenlabs',
                credentialBindings: [
                    {
                        providerId: 'realtime_elevenlabs',
                        credentialBindings: { account: { api_key: 'voice-elevenlabs-secret' } },
                    },
                    {
                        providerId: 'google_gemini',
                        credentialBindings: { account: { api_key: 'voice-google-gemini-secret' } },
                    },
                    {
                        providerId: 'google_cloud',
                        credentialBindings: { account: { api_key: 'voice-google-cloud-secret' } },
                    },
                    {
                        providerId: 'openai_compat',
                        credentialBindings: {
                            account: {
                                stt_api_key: 'voice-openai-secret',
                                tts_api_key: 'voice-openai-secret',
                                chat_api_key: 'voice-openai-secret',
                            },
                        },
                    },
                ],
            },
        });
        const persisted = normalizeVoiceSettingsServerDelta(current) as Record<string, unknown>;
        const predecessorVoice = persisted.voice as Readonly<{
            adapters: Readonly<{
                realtime_elevenlabs: Readonly<{ byo: Readonly<{ apiKey: unknown }> }>;
                local_direct: Readonly<{
                    stt: Readonly<{
                        googleGemini: Readonly<{ apiKey: unknown }>;
                        openaiCompat: Readonly<{ apiKey: unknown }>;
                    }>;
                    tts: Readonly<{
                        googleCloud: Readonly<{ apiKey: unknown }>;
                        openaiCompat: Readonly<{ apiKey: unknown }>;
                    }>;
                }>;
                local_conversation: Readonly<{
                    agent: Readonly<{ openaiCompat: Readonly<{ chatApiKey: unknown }> }>;
                }>;
            }>;
        }>;

        expect(predecessorVoice.adapters.realtime_elevenlabs.byo.apiKey).toEqual(
            secret('encrypted-elevenlabs-key'),
        );
        expect(predecessorVoice.adapters.local_direct.stt.googleGemini.apiKey).toBeNull();
        expect(predecessorVoice.adapters.local_direct.stt.openaiCompat.apiKey).toBeNull();
        expect(predecessorVoice.adapters.local_direct.tts.googleCloud.apiKey).toBeNull();
        expect(predecessorVoice.adapters.local_direct.tts.openaiCompat.apiKey).toBeNull();
        expect(predecessorVoice.adapters.local_conversation.agent.openaiCompat.chatApiKey).toBeNull();

        const strippedCredentialSidecar = predecessorVoiceWrite(persisted, {
            adapters: {
                ...predecessorVoice.adapters,
                local_direct: {
                    ...predecessorVoice.adapters.local_direct,
                    stt: {
                        ...predecessorVoice.adapters.local_direct.stt,
                        googleGemini: {
                            ...predecessorVoice.adapters.local_direct.stt.googleGemini,
                            apiKey: null,
                        },
                        openaiCompat: {
                            ...predecessorVoice.adapters.local_direct.stt.openaiCompat,
                            apiKey: null,
                        },
                    },
                    tts: {
                        ...predecessorVoice.adapters.local_direct.tts,
                        googleCloud: {
                            ...predecessorVoice.adapters.local_direct.tts.googleCloud,
                            apiKey: null,
                        },
                        openaiCompat: {
                            ...predecessorVoice.adapters.local_direct.tts.openaiCompat,
                            apiKey: null,
                        },
                    },
                },
                local_conversation: {
                    ...predecessorVoice.adapters.local_conversation,
                    agent: {
                        ...predecessorVoice.adapters.local_conversation.agent,
                        openaiCompat: {
                            ...predecessorVoice.adapters.local_conversation.agent.openaiCompat,
                            chatApiKey: null,
                        },
                    },
                },
            },
        });
        const restored = settingsParse(strippedCredentialSidecar);

        expect(restored.voice.credentialBindings).toEqual(expect.arrayContaining([
            expect.objectContaining({ providerId: 'google_gemini' }),
            expect.objectContaining({ providerId: 'google_cloud' }),
            expect.objectContaining({ providerId: 'openai_compat' }),
        ]));
    });

    it('keeps predecessor credentials mode-correct at the final plain and e2ee write boundary', () => {
        const key = new Uint8Array(32).fill(7);
        const current = settingsParse({
            secrets: [{
                id: 'voice-elevenlabs-secret',
                name: 'Voice ElevenLabs',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'xi_plain_input' },
                createdAt: 1,
                updatedAt: 1,
            }],
            voice: {
                providerId: 'realtime_elevenlabs',
                credentialBindings: [{
                    providerId: 'realtime_elevenlabs',
                    credentialBindings: { account: { api_key: 'voice-elevenlabs-secret' } },
                }],
                providers: {
                    realtime_elevenlabs: {
                        schemaVersion: 2,
                        config: CURRENT_ELEVENLABS_BYO_CONFIG,
                    },
                },
            },
        });
        const sealed = sealSecretsDeep(current, key);
        const e2eeWrite = normalizeVoiceSettingsServerDelta(sealed) as unknown as Readonly<{
            voice: Readonly<{
                adapters: Readonly<{
                    realtime_elevenlabs: Readonly<{
                        byo: Readonly<{ apiKey: Readonly<Record<string, unknown>> }>;
                    }>;
                }>;
            }>;
        }>;
        const e2eeCredential = e2eeWrite.voice.adapters.realtime_elevenlabs.byo.apiKey;

        expect(e2eeCredential).toHaveProperty('encryptedValue');
        expect(e2eeCredential).not.toHaveProperty('value');

        const plainWrite = unsealSecretsDeepWithKeys(e2eeWrite, [key]);
        expect(plainWrite.voice.adapters.realtime_elevenlabs.byo.apiKey).toEqual({
            _isSecretValue: true,
            value: 'xi_plain_input',
        });
    });

    it('composes the separate diagnostics owner without persisting diagnostics twice', () => {
        const current = settingsParse({
            voiceDiagnosticsV1: { maxFiles: 7 },
            voice: { providerId: 'local_direct', diagnostics: { maxFiles: 3 } },
        });
        const persisted = normalizeVoiceSettingsServerDelta(current) as Readonly<Record<string, unknown> & {
            voice: Readonly<Record<string, unknown>>;
            voiceSettingsV1: Readonly<Record<string, unknown>>;
        }>;

        expect(current.voice.diagnostics).toEqual(current.voiceDiagnosticsV1);
        expect(persisted.voiceSettingsV1).not.toHaveProperty('diagnostics');
        expect(persisted.voice).not.toHaveProperty('diagnostics');
        expect(persisted).toHaveProperty('voiceDiagnosticsV1', current.voiceDiagnosticsV1);
    });

    it('persists every canonical field stripped by the predecessor under one account-root owner', () => {
        const parsed = settingsParse({
            voice: {
                providerId: EXTERNAL_PROVIDER_ID,
                dictation: {
                    sttBinding: 'explicit',
                    language: 'de',
                    stt: { provider: 'device' },
                },
                welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
                executionMachine: { mode: 'fixed', machineId: 'machine-1', autoMachineId: null },
                credentialBindings: [{
                    providerId: EXTERNAL_PROVIDER_ID,
                    credentialBindings: { account: { api_key: 'secret-1' } },
                }],
                providers: {
                    [EXTERNAL_PROVIDER_ID]: { schemaVersion: 1, config: EXTERNAL_CONFIG },
                },
                externalProviderStateV1: { opaque: ['preserved'] },
            },
        });
        const persisted = normalizeVoiceSettingsServerDelta(parsed) as Record<string, unknown>;
        const canonical = persisted.voiceSettingsV1 as Record<string, unknown>;
        const predecessorVisible = persisted.voice as Record<string, unknown>;

        expect(canonical).toEqual(expect.objectContaining({
            providerId: EXTERNAL_PROVIDER_ID,
            dictation: expect.objectContaining({
                sttBinding: 'explicit',
                language: 'de',
                stt: expect.objectContaining({ provider: 'device' }),
            }),
            welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
            executionMachine: { mode: 'fixed', machineId: 'machine-1', autoMachineId: null },
            credentialBindings: [expect.objectContaining({ providerId: EXTERNAL_PROVIDER_ID })],
            externalProviderStateV1: { opaque: ['preserved'] },
        }));
        expect(canonical.providers).toEqual(expect.objectContaining({
            [EXTERNAL_PROVIDER_ID]: { schemaVersion: 1, config: EXTERNAL_CONFIG },
        }));
        expect(predecessorVisible).not.toHaveProperty('providers');
        expect(predecessorVisible).not.toHaveProperty('dictation');
        expect(predecessorVisible).not.toHaveProperty('credentialBindings');
        expect(predecessorVisible).not.toHaveProperty('executionMachine');
        expect(predecessorVisible).not.toHaveProperty('welcome');
        expect(predecessorVisible).not.toHaveProperty('externalProviderStateV1');
    });

    it.each([
        ['off', null],
        ['realtime_elevenlabs', 'realtime_elevenlabs'],
        ['local_direct', 'local_direct'],
        ['local_conversation', 'local_conversation'],
    ] as const)('preserves predecessor provider id %s for the new reader', (providerId, expected) => {
        const parsed = settingsParse({ voice: { providerId } });
        expect(parsed.voice.providerId).toBe(expected);

        const persisted = normalizeVoiceSettingsServerDelta(parsed) as Record<string, unknown>;
        expect((persisted.voice as Record<string, unknown>).providerId).toBe(providerId);
        expect((persisted.voiceSettingsV1 as Record<string, unknown>).providerId).toBe(expected);
    });
});
