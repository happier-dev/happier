import { describe, expect, it } from 'vitest';

import {
    sealSecretsDeep,
    unsealSecretsDeepWithKeys,
} from '@/sync/encryption/secretSettings';

import { parsePendingSettings } from '../state/persistence';
import {
    readLocalConversationVoiceSettings,
    voiceSettingsParse,
    writeLocalConversationVoiceSettings,
} from './voiceSettings';
import { settingsParse } from './settings';
import {
    VOICE_SETTINGS_CURRENT_WRITER_MARKER,
    normalizeVoiceSettingsLocalDelta,
    normalizeVoiceSettingsServerDelta,
} from './voiceSettingsPersistence';
import {
    PREDECESSOR_VOICE_IDENTITY_VECTORS,
    capturedPredecessorVoice,
} from './voiceSettings.predecessorVectors';

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
    billingMode: 'byo',
    tts: {
        voiceId: 'EST9Ui6982FZPSi7gCHi',
        modelId: null,
        voiceSettings: {
            stability: null,
            similarityBoost: null,
            speed: null,
        },
    },
    agentId: 'agent_1',
} as const;

function predecessorVoiceWrite(
    persisted: Readonly<Record<string, unknown>>,
    patch: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
    const currentVoice = readPredecessorVoiceProjection(persisted);
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readRequiredRecord(value: unknown, description: string): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
        throw new Error(`Expected ${description} to be a record`);
    }
    return value;
}

function readRequiredArray(value: unknown, description: string): readonly unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`Expected ${description} to be an array`);
    }
    return value;
}

/**
 * `voiceSettingsV1` is the canonical current owner. These helpers deliberately
 * cross only the raw persistence boundary to inspect its bounded predecessor
 * sidecar, which the typed runtime `voice` view does not expose.
 */
function normalizePredecessorVoiceWrite(settings: Readonly<object>): Readonly<Record<string, unknown>> {
    return readRequiredRecord(
        normalizeVoiceSettingsServerDelta(settings),
        'normalized predecessor Voice write',
    );
}

function readCanonicalVoiceSettings(
    persisted: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
    return readRequiredRecord(persisted.voiceSettingsV1, 'canonical voiceSettingsV1');
}

function readPredecessorVoiceProjection(
    persisted: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
    return readRequiredRecord(persisted.voice, 'predecessor Voice projection');
}

function readPredecessorAdapters(
    persisted: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
    return readRequiredRecord(
        readPredecessorVoiceProjection(persisted).adapters,
        'predecessor Voice adapters',
    );
}

// The captured output supplies the predecessor's closed key set and defaults;
// current-writer values replace those defaults only at keys the old reader knew.
function projectCapturedPredecessorReaderOutput(
    input: unknown,
    capturedOutput: unknown,
): unknown {
    if (Array.isArray(capturedOutput)) {
        return Array.isArray(input) ? input : capturedOutput;
    }
    if (!isRecord(capturedOutput)) return input === undefined ? capturedOutput : input;

    const inputRecord = isRecord(input) ? input : {};
    return Object.fromEntries(Object.entries(capturedOutput).map(([key, capturedValue]) => [
        key,
        projectCapturedPredecessorReaderOutput(inputRecord[key], capturedValue),
    ]));
}

function normalizeCapturedCiphertext(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalizeCapturedCiphertext);
    if (!isRecord(value)) return value;

    if (value._isSecretValue === true && isRecord(value.encryptedValue)) {
        return {
            ...value,
            encryptedValue: {
                ...value.encryptedValue,
                c: '<captured-ciphertext>',
            },
        };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
        key,
        normalizeCapturedCiphertext(child),
    ]));
}

function currentWriterPredecessorVoice(
    mode: 'plain' | 'e2ee',
    elevenLabsAgentId = 'agent-real',
): Readonly<Record<string, unknown>> {
    const key = new Uint8Array(32).fill(11);
    const current = settingsParse({
        secrets: [{
            id: 'voice-elevenlabs-secret',
            name: 'Voice ElevenLabs',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: 'xi-plain' },
            createdAt: 1,
            updatedAt: 1,
        }],
        voice: {
            providerId: 'realtime_elevenlabs',
            assistantLanguage: 'de',
            credentialBindings: [{
                providerId: 'realtime_elevenlabs',
                credentialBindings: { account: { api_key: 'voice-elevenlabs-secret' } },
            }],
            providers: {
                realtime_elevenlabs: {
                    schemaVersion: 2,
                    config: {
                        ...CURRENT_ELEVENLABS_BYO_CONFIG,
                        agentId: elevenLabsAgentId,
                    },
                },
            },
        },
    });
    const encryptedWrite = normalizeVoiceSettingsServerDelta(
        sealSecretsDeep(current, key),
    ) as Readonly<{
        voice: Readonly<Record<string, unknown>>;
    }>;
    const persisted = mode === 'e2ee'
        ? encryptedWrite
        : unsealSecretsDeepWithKeys(encryptedWrite, [key]);
    return persisted.voice;
}

describe('Voice provider selection persistence compatibility', () => {
    it('normalizes every approved predecessor credential identity without changing settings or secret references', () => {
        const predecessorBindings = [
            ...PREDECESSOR_VOICE_IDENTITY_VECTORS.map((vector, index) => ({
                providerId: vector.predecessorProviderId,
                credentialBindings: {
                    account: { api_key: `secret-${index}-account` },
                    byMachineId: {
                        'machine-a': { api_key: `secret-${index}-machine-a` },
                        'machine-b': { api_key: `secret-${index}-machine-b` },
                    },
                },
            })),
            {
                providerId: 'openai_compat',
                credentialBindings: {
                    account: {
                        stt_api_key: 'secret-openai-stt-account',
                        tts_api_key: 'secret-openai-tts-account',
                        chat_api_key: 'secret-openai-chat-account',
                    },
                    byMachineId: {
                        'machine-a': {
                            stt_api_key: 'secret-openai-stt-machine-a',
                            tts_api_key: 'secret-openai-tts-machine-a',
                            chat_api_key: 'secret-openai-chat-machine-a',
                        },
                        'machine-b': {
                            stt_api_key: 'secret-openai-stt-machine-b',
                            tts_api_key: 'secret-openai-tts-machine-b',
                            chat_api_key: 'secret-openai-chat-machine-b',
                        },
                    },
                },
            },
        ];
        const parsed = settingsParse({
            voice: {
                providerId: 'realtime_elevenlabs',
                assistantLanguage: 'de',
                credentialBindings: predecessorBindings,
            },
        });
        expect(parsed.voice.credentialBindings).toEqual([]);
        expect(parsed.voice.credentialBindings).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ providerId: expect.any(String) }),
        ]));
        const originalProviderSettings = parsed.voice.providers;
        const persisted = normalizeVoiceSettingsServerDelta(parsed) as Readonly<{
            voiceSettingsV1: Readonly<{
                credentialBindings: readonly Readonly<Record<string, unknown>>[];
            }>;
        }>;

        for (const [index, vector] of PREDECESSOR_VOICE_IDENTITY_VECTORS.entries()) {
            expect(persisted.voiceSettingsV1.credentialBindings).toContainEqual({
                contribution: vector.contribution,
                credentialSlotId: 'api_key',
                credentialSource: { kind: 'savedSecret' },
                credentialBindings: {
                    account: { api_key: `secret-${index}-account` },
                    byMachineId: {
                        'machine-a': { api_key: `secret-${index}-machine-a` },
                        'machine-b': { api_key: `secret-${index}-machine-b` },
                    },
                },
            });
        }
        expect(persisted.voiceSettingsV1.credentialBindings).toHaveLength(
            PREDECESSOR_VOICE_IDENTITY_VECTORS.length,
        );
        expect(persisted.voiceSettingsV1.credentialBindings).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ providerId: expect.any(String) }),
        ]));
        expect(JSON.stringify(persisted.voiceSettingsV1.credentialBindings)).not.toContain('chat_api_key');
        expect(JSON.stringify(persisted.voiceSettingsV1.credentialBindings)).not.toContain('openai-compat');

        const restored = settingsParse(persisted);
        expect(restored.voice.providerId).toBe('happier.voice.elevenlabs/realtime-elevenlabs');
        expect(restored.voice.assistantLanguage).toBe('de');
        expect(restored.voice.providers).toEqual(originalProviderSettings);
        expect(restored.voice.credentialBindings).toEqual([]);
    });

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

    it('does not let an ordinary runtime Voice write replace canonical credential authority', () => {
        const currentBinding = {
            contribution: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' },
            credentialSlotId: 'api_key',
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { api_key: 'secret-current' } },
        } as const;
        const staleBinding = {
            ...currentBinding,
            credentialBindings: { account: { api_key: 'secret-stale' } },
        } as const;
        const current = settingsParse({
            voiceSettingsV1: {
                providerId: 'happier.voice.openai/realtime-openai',
                credentialBindings: [currentBinding],
            },
        });
        const normalized = normalizeVoiceSettingsLocalDelta({
            voice: {
                ...current.voice,
                assistantLanguage: 'de',
                credentialBindings: [staleBinding],
            },
        }, current) as Readonly<{
            voice: Readonly<{ credentialBindings: readonly unknown[] }>;
            voiceSettingsV1: Readonly<{ credentialBindings: readonly unknown[] }>;
        }>;

        expect(normalized.voiceSettingsV1.credentialBindings).toEqual([currentBinding]);
        expect(normalized.voice.credentialBindings).toEqual([]);
    });

    it('survives a predecessor whole-object write with the exact external config', () => {
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

    it.each(['off', 'on_demand', 'automatic'] as const)(
        'omits the current UI context mode %s from the predecessor sidecar and preserves it across a markerless predecessor write',
        (currentUiContextMode) => {
        const persisted = normalizeVoiceSettingsServerDelta(settingsParse({
            voiceSettingsV1: {
                privacy: { currentUiContextMode },
            },
        })) as Record<string, unknown>;
        const predecessorPrivacy = readRequiredRecord(
            readPredecessorVoiceProjection(persisted).privacy,
            'predecessor Voice privacy projection',
        );

        expect(readCanonicalVoiceSettings(persisted).privacy).toMatchObject({
            currentUiContextMode,
        });
        expect(predecessorPrivacy).not.toHaveProperty('currentUiContextMode');

        const restored = settingsParse(predecessorVoiceWrite(persisted, {
            privacy: {
                ...predecessorPrivacy,
                shareSessionSummary: false,
            },
        }));

        expect(restored.voice.privacy).toMatchObject({
            currentUiContextMode,
            shareSessionSummary: false,
        });
        },
    );

    it('preserves the current-only Codex global binding when the predecessor writes Voice as off', () => {
        const current = settingsParse({
            voice: {
                providerId: 'happier.agent.codex/realtime-codex',
                providers: {
                    'happier.agent.codex/realtime-codex': {
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
        expect((persisted.voiceSettingsV1 as Record<string, unknown>).providerId).toBe(
            'happier.agent.codex/realtime-codex',
        );

        const restored = settingsParse(predecessorVoiceWrite(persisted, {
            providerId: 'off',
            assistantLanguage: 'de',
        }));

        expect(restored.voice.providerId).toBeNull();
        expect(restored.voice.assistantLanguage).toBe('de');
        expect(restored.voice.providers['happier.agent.codex/realtime-codex']).toEqual({
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
                            stt: { provider: 'device' },
                            tts: { provider: 'device' },
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
        expect(current.voiceSettingsV1.providers[
            'happier.voice.elevenlabs/realtime-elevenlabs'
        ]).toEqual({ schemaVersion: 2, config: CURRENT_ELEVENLABS_BYO_CONFIG });
        const compatibilityVoice = capturedPredecessorVoice('e2ee');
        const compatibilityAdapter = (
            compatibilityVoice.adapters as Readonly<Record<string, unknown>>
        ).realtime_elevenlabs as Readonly<Record<string, unknown>>;
        const persisted = normalizeVoiceSettingsServerDelta(current, {
            ...current,
            voice: {
                ...compatibilityVoice,
                adapters: {
                    ...(compatibilityVoice.adapters as Readonly<Record<string, unknown>>),
                    realtime_elevenlabs: {
                        ...compatibilityAdapter,
                        tts: {
                            ...(compatibilityAdapter.tts as Readonly<Record<string, unknown>>),
                            voiceSettings: {
                                ...((compatibilityAdapter.tts as Readonly<Record<string, unknown>>)
                                    .voiceSettings as Readonly<Record<string, unknown>>),
                                style: 0.35,
                                useSpeakerBoost: true,
                            },
                        },
                        byo: {
                            ...(compatibilityAdapter.byo as Readonly<Record<string, unknown>>),
                            apiKey: encryptedCredential,
                        },
                    },
                },
            },
        }) as unknown as Readonly<{
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
            tts: { voiceSettings: { style: 0.35, useSpeakerBoost: true } },
            byo: { agentId: 'agent_1', apiKey: encryptedCredential },
        });
        expect(JSON.stringify(legacyElevenLabs)).not.toContain('"value"');

        const removedByOldClient = predecessorVoiceWrite(persisted, {
            adapters: {
                ...persisted.voice.adapters,
                realtime_elevenlabs: {
                    ...legacyElevenLabs,
                    tts: {
                        ...(legacyElevenLabs.tts as Readonly<Record<string, unknown>>),
                        voiceSettings: {
                            ...((legacyElevenLabs.tts as Readonly<Record<string, unknown>>)
                                .voiceSettings as Readonly<Record<string, unknown>>),
                            stability: 0.55,
                        },
                    },
                    byo: {
                        ...legacyElevenLabs.byo,
                        agentId: 'agent-edited-by-predecessor',
                        apiKey: null,
                    },
                },
            },
        });
        const restored = settingsParse(removedByOldClient);
        expect(restored.voiceSettingsV1.providers[
            'happier.voice.elevenlabs/realtime-elevenlabs'
        ]?.config).toEqual({
            ...CURRENT_ELEVENLABS_BYO_CONFIG,
            agentId: 'agent-edited-by-predecessor',
            tts: {
                ...CURRENT_ELEVENLABS_BYO_CONFIG.tts,
                voiceSettings: {
                    ...CURRENT_ELEVENLABS_BYO_CONFIG.tts.voiceSettings,
                    stability: 0.55,
                },
            },
        });
        const reprojected = normalizeVoiceSettingsServerDelta(
            restored,
            removedByOldClient,
        ) as unknown as Readonly<{
            voice: Readonly<{
                adapters: Readonly<{
                    realtime_elevenlabs: Readonly<{
                        tts: Readonly<{ voiceSettings: unknown }>;
                    }>;
                }>;
            }>;
        }>;
        expect(reprojected.voice.adapters.realtime_elevenlabs.tts.voiceSettings).toMatchObject({
            style: 0.35,
            useSpeakerBoost: true,
        });
        expect(restored.voice.credentialBindings).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ providerId: 'realtime_elevenlabs' }),
        ]));
    });

    it('merges a markerless predecessor ElevenLabs credential into the matching qualified binding exactly once', () => {
        const encryptedCredential = {
            _isSecretValue: true as const,
            encryptedValue: { t: 'enc-v1' as const, c: 'synthetic-elevenlabs-ciphertext' },
        };
        const current = settingsParse({
            secrets: [{
                id: 'saved:elevenlabs',
                name: 'Voice ElevenLabs',
                kind: 'apiKey',
                encryptedValue: encryptedCredential,
                createdAt: 1,
                updatedAt: 1,
            }],
            voice: {
                providerId: 'realtime_elevenlabs',
                credentialBindings: [{
                    providerId: 'realtime_elevenlabs',
                    credentialBindings: { account: { api_key: 'saved:elevenlabs' } },
                }],
                providers: {
                    realtime_elevenlabs: {
                        schemaVersion: 2,
                        config: CURRENT_ELEVENLABS_BYO_CONFIG,
                    },
                },
            },
        });
        const persisted = normalizeVoiceSettingsServerDelta(current) as Record<string, unknown>;

        const restored = settingsParse(predecessorVoiceWrite(persisted));

        expect(restored.secrets.map((secret) => secret.id)).toEqual(['saved:elevenlabs']);
        expect(restored.voiceSettingsV1.credentialBindings).toEqual([{
            contribution: {
                pluginId: 'happier.voice.elevenlabs',
                localId: 'realtime-elevenlabs',
            },
            credentialSlotId: 'api_key',
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: { account: { api_key: 'saved:elevenlabs' } },
        }]);
        expect(restored.voice.credentialBindings).toEqual([]);
    });

    it('projects the pinned released speech sidecar without projecting current-only authority', () => {
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
                    id: 'voice-openai-stt-secret',
                    name: 'Voice OpenAI-compatible STT',
                    kind: 'apiKey',
                    encryptedValue: secret('encrypted-openai-stt-key'),
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    id: 'voice-openai-tts-secret',
                    name: 'Voice OpenAI-compatible TTS',
                    kind: 'apiKey',
                    encryptedValue: secret('encrypted-openai-tts-key'),
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
            voice: {
                providerId: 'realtime_elevenlabs',
                providers: {
                    'happier.voice.google/gemini-stt': {
                        schemaVersion: 2,
                        config: { model: 'gemini-custom', language: 'de' },
                    },
                    'happier.voice.google/google-cloud-tts': {
                        schemaVersion: 2,
                        config: {
                            voiceName: 'de-DE-Test-A',
                            languageCode: 'de-DE',
                            format: 'wav',
                            speakingRate: 1.25,
                            pitch: -2,
                        },
                    },
                    'happier.voice.openai-compat/stt': {
                        schemaVersion: 2,
                        config: {
                            baseUrl: 'http://localhost:8101/v1',
                            insecureLocalOriginConsent: 'http://localhost:8101',
                            insecureLocalConsentMachineId: 'machine-a',
                            model: 'custom-whisper',
                            language: 'de',
                        },
                    },
                    'happier.voice.openai-compat/tts': {
                        schemaVersion: 2,
                        config: {
                            baseUrl: 'http://localhost:8102/v1',
                            insecureLocalOriginConsent: 'http://localhost:8102',
                            insecureLocalConsentMachineId: 'machine-a',
                            model: 'custom-tts',
                            voiceName: 'custom-voice',
                            format: 'wav',
                        },
                    },
                    local_direct: {
                        schemaVersion: 1,
                        config: {
                            stt: { provider: 'happier.voice.google/gemini-stt' },
                            tts: { provider: 'happier.voice.google/google-cloud-tts' },
                        },
                    },
                },
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
                        providerId: 'happier.voice.openai-compat/stt',
                        credentialBindings: { account: { api_key: 'voice-openai-stt-secret' } },
                    },
                    {
                        providerId: 'happier.voice.openai-compat/tts',
                        credentialBindings: { account: { api_key: 'voice-openai-tts-secret' } },
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
                        googleGemini: Readonly<{ apiKey: unknown; model: string; language: string }>;
                        openaiCompat: Readonly<{
                            apiKey: unknown;
                            baseUrl: string;
                            model: string;
                        }>;
                    }>;
                    tts: Readonly<{
                        googleCloud: Readonly<{
                            apiKey: unknown;
                            voiceName: string;
                            languageCode: string;
                            format: string;
                            speakingRate: number;
                            pitch: number;
                        }>;
                        openaiCompat: Readonly<{
                            apiKey: unknown;
                            baseUrl: string;
                            model: string;
                            voice: string;
                            format: string;
                        }>;
                    }>;
                }>;
            }>;
        }>;

        expect(predecessorVoice.adapters.realtime_elevenlabs.byo.apiKey).toEqual(
            secret('encrypted-elevenlabs-key'),
        );
        expect(predecessorVoice.adapters.local_direct.stt.googleGemini.apiKey).toBeNull();
        expect(predecessorVoice.adapters.local_direct.stt.googleGemini).toMatchObject({
            model: 'gemini-custom',
            language: 'de',
        });
        expect(predecessorVoice.adapters.local_direct.stt.openaiCompat).toEqual({
            apiKey: secret('encrypted-openai-stt-key'),
            baseUrl: 'http://localhost:8101/v1',
            model: 'custom-whisper',
        });
        expect(predecessorVoice.adapters.local_direct.stt.openaiCompat).not.toHaveProperty('language');
        expect(predecessorVoice.adapters.local_direct.stt.openaiCompat).not.toHaveProperty(
            'insecureLocalOriginConsent',
        );
        expect(predecessorVoice.adapters.local_direct.stt.openaiCompat).not.toHaveProperty(
            'insecureLocalConsentMachineId',
        );
        expect(predecessorVoice.adapters.local_direct.tts.googleCloud.apiKey).toBeNull();
        expect(predecessorVoice.adapters.local_direct.tts.googleCloud).toMatchObject({
            voiceName: 'de-DE-Test-A',
            languageCode: 'de-DE',
            format: 'wav',
            speakingRate: 1.25,
            pitch: -2,
        });
        expect(predecessorVoice.adapters.local_direct.tts.openaiCompat).toEqual({
            apiKey: secret('encrypted-openai-tts-key'),
            baseUrl: 'http://localhost:8102/v1',
            model: 'custom-tts',
            voice: 'custom-voice',
            format: 'wav',
        });
        expect(predecessorVoice.adapters.local_direct.tts.openaiCompat).not.toHaveProperty(
            'insecureLocalOriginConsent',
        );
        expect(predecessorVoice.adapters.local_direct.tts.openaiCompat).not.toHaveProperty(
            'insecureLocalConsentMachineId',
        );
        expect(JSON.stringify(predecessorVoice.adapters)).not.toContain('chatApiKey');

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
                    },
                    tts: {
                        ...predecessorVoice.adapters.local_direct.tts,
                        googleCloud: {
                            ...predecessorVoice.adapters.local_direct.tts.googleCloud,
                            apiKey: null,
                        },
                    },
                },
            },
        });
        const restored = settingsParse(strippedCredentialSidecar);

        expect(restored.voiceSettingsV1.credentialBindings).toEqual(expect.arrayContaining([
            expect.objectContaining({
                contribution: { pluginId: 'happier.voice.google', localId: 'gemini-stt' },
            }),
            expect.objectContaining({
                contribution: { pluginId: 'happier.voice.google', localId: 'google-cloud-tts' },
            }),
        ]));
        expect(restored.voice.credentialBindings).toEqual([]);
    });

    it('projects a released OpenAI-compatible Chat sidecar only from one exact Provider Chat binding', () => {
        const chatSecret = (ciphertext: string) => ({
            _isSecretValue: true as const,
            encryptedValue: { t: 'enc-v1' as const, c: ciphertext },
        });
        const connectionId = 'voice-openai-compatible-chat';
        const baseProviderSettings = (params: Readonly<{
            credentialMode?: 'none' | 'required';
            credentialStyle?: 'bearer' | 'x-api-key';
            endpointProtocol?: 'openai-chat' | 'openai-responses';
            secretBindings?: Readonly<Record<string, unknown>>;
            sourceKind?: 'custom' | 'contribution';
            omitSecretBinding?: boolean;
            role?: 'default' | 'named';
        }> = {}) => ({
            v: 1,
            connections: [{
                v: 1,
                id: connectionId,
                source: params.sourceKind === 'contribution'
                    ? {
                        kind: 'contribution',
                        contributionKey: 'happier.provider/openai-chat',
                    }
                    : {
                        kind: 'custom',
                        template: {
                            v: 1,
                            name: 'Voice OpenAI-compatible Chat',
                            endpointTemplates: [{
                                id: 'chat',
                                protocol: params.endpointProtocol ?? 'openai-chat',
                                baseUrl: 'https://chat.compatibility.test/v1',
                                capabilities: {
                                    streaming: 'unknown',
                                    toolRoundTrips: 'unknown',
                                    statefulResponses: 'unknown',
                                    reasoningControls: 'unknown',
                                },
                            }],
                            ...((params.credentialMode ?? 'required') === 'none'
                                ? {}
                                : {
                                    credential: {
                                        kind: 'apiKey',
                                        slotId: 'apiKey',
                                        required: true,
                                        transports: [{
                                            id: 'chat-runtime',
                                            protocols: [params.endpointProtocol ?? 'openai-chat'],
                                            uses: ['runtime'],
                                            destination: {
                                                kind: 'httpHeader',
                                                name: params.credentialStyle === 'x-api-key'
                                                    ? 'x-api-key'
                                                    : 'authorization',
                                                format: params.credentialStyle === 'x-api-key'
                                                    ? 'raw'
                                                    : 'bearer',
                                            },
                                        }],
                                    },
                                }),
                            catalog: { source: 'manual', manualModelPolicy: 'allowed' },
                        },
                    },
                role: params.role ?? 'named',
                displayName: 'Voice OpenAI-compatible Chat',
                displayNameMode: 'custom',
                deployment: { kind: 'external' },
                revision: 0,
                createdAt: 1,
                updatedAt: 1,
            }],
            connectionTombstones: [],
            accountGrants: [],
            machineGrants: [],
            secretBindingsByConnectionId: params.omitSecretBinding
                ? {}
                : {
                    [connectionId]: params.secretBindings ?? {
                        account: { apiKey: 'saved-openai-chat' },
                    },
                },
            manualModelsByConnectionId: {},
            modelVisibilityByRef: {},
            experimentalBindingConfirmations: [],
            defaultsByAgentTargetKey: {},
        });
        const currentAccount = (params: Readonly<{
            chatTargetKey?: string;
            commitConnectionId?: string;
            commitTargetKey?: string;
            credentialMode?: 'none' | 'required';
            credentialStyle?: 'bearer' | 'x-api-key';
            endpointProtocol?: 'openai-chat' | 'openai-responses';
            omitSecretBinding?: boolean;
            secretBindings?: Readonly<Record<string, unknown>>;
            sourceKind?: 'custom' | 'contribution';
            chatSecretId?: string;
            temperature?: number | null;
            role?: 'default' | 'named';
        }> = {}) => settingsParse({
            secrets: [
                {
                    id: 'saved-openai-chat',
                    name: 'Voice OpenAI-compatible Chat',
                    kind: 'apiKey',
                    encryptedValue: chatSecret('encrypted-openai-chat-key'),
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    id: 'saved-openai-stt',
                    name: 'Voice OpenAI-compatible STT',
                    kind: 'apiKey',
                    encryptedValue: chatSecret('encrypted-openai-stt-key'),
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    id: 'saved-openai-tts',
                    name: 'Voice OpenAI-compatible TTS',
                    kind: 'apiKey',
                    encryptedValue: chatSecret('encrypted-openai-tts-key'),
                    createdAt: 1,
                    updatedAt: 1,
                },
            ],
            providerSettingsV1: baseProviderSettings({
                credentialMode: params.credentialMode,
                credentialStyle: params.credentialStyle,
                endpointProtocol: params.endpointProtocol,
                omitSecretBinding: params.omitSecretBinding,
                secretBindings: params.secretBindings ?? {
                    account: { apiKey: params.chatSecretId ?? 'saved-openai-chat' },
                },
                sourceKind: params.sourceKind,
                role: params.role,
            }),
            voice: {
                providerId: 'local_conversation',
                credentialBindings: [
                    {
                        providerId: 'happier.voice.openai-compat/stt',
                        credentialBindings: { account: { api_key: 'saved-openai-stt' } },
                    },
                    {
                        providerId: 'happier.voice.openai-compat/tts',
                        credentialBindings: { account: { api_key: 'saved-openai-tts' } },
                    },
                ],
                providers: {
                    'happier.voice.openai-compat/stt': {
                        schemaVersion: 2,
                        config: {
                            baseUrl: 'https://stt.compatibility.test/v1',
                            insecureLocalOriginConsent: '',
                            insecureLocalConsentMachineId: '',
                            language: '',
                            model: 'compatibility-whisper',
                        },
                    },
                    'happier.voice.openai-compat/tts': {
                        schemaVersion: 2,
                        config: {
                            baseUrl: 'https://tts.compatibility.test/v1',
                            insecureLocalOriginConsent: '',
                            insecureLocalConsentMachineId: '',
                            model: 'compatibility-tts',
                            voiceName: 'compatibility-voice',
                            format: 'wav',
                        },
                    },
                    local_direct: {
                        schemaVersion: 1,
                        config: {
                            stt: { provider: 'happier.voice.openai-compat/stt' },
                            tts: { provider: 'happier.voice.openai-compat/tts' },
                        },
                    },
                    local_conversation: {
                        schemaVersion: 1,
                        config: {
                            conversationMode: 'agent',
                            stt: { provider: 'happier.voice.openai-compat/stt' },
                            tts: { provider: 'happier.voice.openai-compat/tts' },
                            agent: {
                                agentSource: 'agent',
                                agentId: 'opencode',
                                providerChat: {
                                    status: 'configured',
                                    chat: {
                                        agentTargetKey: params.chatTargetKey ?? 'backend:opencode',
                                        providerConnectionId: connectionId,
                                        modelId: 'compatibility-chat',
                                    },
                                    commit: {
                                        agentTargetKey: params.commitTargetKey
                                            ?? params.chatTargetKey
                                            ?? 'backend:opencode',
                                        providerConnectionId: params.commitConnectionId ?? connectionId,
                                        modelId: 'compatibility-commit',
                                    },
                                    configuration: {
                                        temperature: params.temperature === undefined
                                            ? 0.37
                                            : params.temperature,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });
        const projectLocalConversation = (current: Readonly<object>) => {
            const persisted = normalizePredecessorVoiceWrite(current);
            return readRequiredRecord(
                readPredecessorAdapters(persisted).local_conversation,
                'predecessor Local Conversation adapter',
            );
        };

        const adapter = projectLocalConversation(currentAccount());
        const agent = adapter.agent as Readonly<Record<string, unknown>>;
        const openAiCompat = agent.openaiCompat as Readonly<Record<string, unknown>>;

        expect(agent).toMatchObject({
            backend: 'openai_compat',
            agentSource: 'agent',
            agentId: 'opencode',
        });
        expect(openAiCompat).toEqual({
            chatBaseUrl: 'https://chat.compatibility.test/v1',
            chatApiKey: chatSecret('encrypted-openai-chat-key'),
            chatModel: 'compatibility-chat',
            commitModel: 'compatibility-commit',
            temperature: 0.37,
        });
        expect(agent).not.toHaveProperty('providerChat');
        expect(openAiCompat).not.toHaveProperty('maxTokens');

        const stt = adapter.stt as Readonly<Record<string, unknown>>;
        const tts = adapter.tts as Readonly<Record<string, unknown>>;
        expect((stt.openaiCompat as Readonly<Record<string, unknown>>).apiKey).toEqual(
            chatSecret('encrypted-openai-stt-key'),
        );
        expect((tts.openaiCompat as Readonly<Record<string, unknown>>).apiKey).toEqual(
            chatSecret('encrypted-openai-tts-key'),
        );

        const credentiallessAgent = projectLocalConversation(
            currentAccount({ credentialMode: 'none', omitSecretBinding: true }),
        ).agent as Readonly<Record<string, unknown>>;
        expect(credentiallessAgent.openaiCompat).toMatchObject({ chatApiKey: null });

        const noTemperatureAgent = projectLocalConversation(
            currentAccount({ temperature: null }),
        ).agent as Readonly<Record<string, unknown>>;
        const noTemperatureOpenAiCompat = (
            noTemperatureAgent.openaiCompat
        ) as Readonly<Record<string, unknown>>;
        expect(noTemperatureOpenAiCompat).not.toHaveProperty('temperature');

        const collisionSource = currentAccount();
        const matchingSecret = collisionSource.secrets.find(
            (candidate) => candidate.id === 'saved-openai-chat',
        );
        if (!matchingSecret) throw new Error('Expected OpenAI-compatible Chat SavedSecret');
        const collidingSecrets = {
            ...collisionSource,
            secrets: [...collisionSource.secrets, { ...matchingSecret }],
        };
        const malformedProviderSettings = {
            ...currentAccount(),
            providerSettingsV1: { v: 2 },
        };

        for (const current of [
            // The selected Provider target must agree with the surrounding released Agent target.
            currentAccount({ chatTargetKey: 'backend:codex' }),
            // Chat and commit must not diverge from each other either.
            currentAccount({ commitTargetKey: 'backend:codex' }),
            currentAccount({ commitConnectionId: 'another-chat-connection' }),
            currentAccount({ sourceKind: 'contribution' }),
            currentAccount({ role: 'default' }),
            currentAccount({ endpointProtocol: 'openai-responses' }),
            currentAccount({ credentialStyle: 'x-api-key' }),
            currentAccount({ omitSecretBinding: true }),
            currentAccount({ secretBindings: {
                byMachineId: { 'machine-a': { apiKey: 'saved-openai-chat' } },
            } }),
            currentAccount({ chatSecretId: 'missing-openai-chat-secret' }),
            collidingSecrets,
            malformedProviderSettings,
        ]) {
            const rejectedAgent = projectLocalConversation(current).agent as Readonly<Record<string, unknown>>;
            expect(rejectedAgent).not.toHaveProperty('backend');
            expect(rejectedAgent).not.toHaveProperty('openaiCompat');
            expect(rejectedAgent).not.toHaveProperty('providerChat');
        }

        // A current-writer update can carry its previous marked legacy
        // projection alongside newer canonical settings. The old Chat reader
        // must not keep that prior sidecar when the current binding stops
        // representing one released Agent target.
        const previouslyProjected = normalizePredecessorVoiceWrite(
            currentAccount(),
        );
        const previousVoice = readPredecessorVoiceProjection(previouslyProjected);
        const previousAdapters = readPredecessorAdapters(previouslyProjected);
        const previousCanonical = readCanonicalVoiceSettings(previouslyProjected);
        const previousProviders = readRequiredRecord(previousCanonical.providers, 'canonical Voice providers');
        const previousLocalConversation = readRequiredRecord(
            previousProviders.local_conversation,
            'canonical Local Conversation provider',
        );
        const previousConfig = readRequiredRecord(
            previousLocalConversation.config,
            'canonical Local Conversation config',
        );
        const previousAgent = readRequiredRecord(previousConfig.agent, 'canonical Local Conversation agent');
        const previousProviderChat = readRequiredRecord(previousAgent.providerChat, 'canonical Provider Chat');
        const previousChat = readRequiredRecord(previousProviderChat.chat, 'canonical Provider Chat selection');
        const retainedCurrentWriterAgent = (
            projectLocalConversation(previouslyProjected).agent
        ) as Readonly<Record<string, unknown>>;
        expect(retainedCurrentWriterAgent.openaiCompat).toEqual(openAiCompat);

        // A current writer's marked old-reader sidecar must never re-enter the
        // unmarked predecessor migration when the current reader loads it.
        const roundTrippedCurrentWriter = settingsParse(structuredClone(previouslyProjected));
        expect(readLocalConversationVoiceSettings(
            roundTrippedCurrentWriter.voice,
        ).agent.providerChat).toEqual(previousProviderChat);
        const repeatedlyReadCurrentWriter = settingsParse(roundTrippedCurrentWriter);
        expect(readLocalConversationVoiceSettings(
            repeatedlyReadCurrentWriter.voice,
        ).agent.providerChat).toEqual(previousProviderChat);

        // Crash recovery can retain the complete marked write but lose only
        // the Local Conversation adapter. Recreate that adapter from the
        // canonical Provider Chat selection without replacing other adapters.
        const {
            local_conversation: _missingLocalConversation,
            ...adaptersWithoutLocalConversation
        } = previousAdapters;
        const markedWriteMissingLocalConversation = {
            ...previouslyProjected,
            voice: {
                ...previousVoice,
                adapters: adaptersWithoutLocalConversation,
            },
        };
        const reconstructedMarkedWrite = normalizeVoiceSettingsServerDelta(
            markedWriteMissingLocalConversation,
        );
        const reconstructedAdapters = readPredecessorAdapters(readRequiredRecord(
            reconstructedMarkedWrite,
            'reconstructed current-writer persistence',
        ));
        expect(reconstructedAdapters).toHaveProperty('local_conversation');
        const reconstructedAgent = readRequiredRecord(
            readRequiredRecord(
                reconstructedAdapters.local_conversation,
                'reconstructed Local Conversation adapter',
            ).agent,
            'reconstructed Local Conversation agent',
        );
        expect(reconstructedAdapters.local_direct).toEqual(previousAdapters.local_direct);
        expect(reconstructedAgent).toMatchObject({ backend: 'openai_compat' });
        expect(reconstructedAgent.openaiCompat).toEqual(openAiCompat);
        const staleCurrentWriterDelta: Readonly<Record<string, unknown>> = {
            ...previouslyProjected,
            voiceSettingsV1: {
                ...previousCanonical,
                providers: {
                    ...previousProviders,
                    local_conversation: {
                        ...previousLocalConversation,
                        config: {
                            ...previousConfig,
                            agent: {
                                ...previousAgent,
                                providerChat: {
                                    ...previousProviderChat,
                                    chat: {
                                        ...previousChat,
                                        agentTargetKey: 'backend:codex',
                                    },
                                },
                            },
                        },
                    },
                },
            },
        };
        const staleCurrentWriterAgent = (
            projectLocalConversation(staleCurrentWriterDelta).agent
        ) as Readonly<Record<string, unknown>>;
        expect(staleCurrentWriterAgent).not.toHaveProperty('backend');
        expect(staleCurrentWriterAgent).not.toHaveProperty('openaiCompat');
        expect(staleCurrentWriterAgent).not.toHaveProperty('providerChat');

        const staleVoice = readPredecessorVoiceProjection(staleCurrentWriterDelta);
        const staleAdapters = readPredecessorAdapters(staleCurrentWriterDelta);
        const {
            local_conversation: _staleLocalConversation,
            ...staleAdaptersWithoutLocalConversation
        } = staleAdapters;
        const missingNonrepresentableMarkedWrite = {
            ...staleCurrentWriterDelta,
            voice: {
                ...staleVoice,
                adapters: staleAdaptersWithoutLocalConversation,
            },
        };
        const nonrepresentableProjection = normalizeVoiceSettingsServerDelta(
            missingNonrepresentableMarkedWrite,
        );
        const nonrepresentableAdapters = readPredecessorAdapters(readRequiredRecord(
            nonrepresentableProjection,
            'nonrepresentable current-writer persistence',
        ));
        expect(nonrepresentableAdapters.local_direct).toEqual(previousAdapters.local_direct);
        expect(nonrepresentableAdapters).not.toHaveProperty('local_conversation');
    });

    it('projects released OpenAI-compatible endpoint control without a credential', () => {
        const persisted = normalizePredecessorVoiceWrite(settingsParse({
            voice: {
                providerId: 'local_direct',
                providers: {
                    'happier.voice.openai-compat/stt': {
                        schemaVersion: 2,
                        config: {
                            baseUrl: 'https://credentialless-stt.test/v1',
                            insecureLocalOriginConsent: '',
                            insecureLocalConsentMachineId: '',
                            language: '',
                            model: 'credentialless-whisper',
                        },
                    },
                    'happier.voice.openai-compat/tts': {
                        schemaVersion: 2,
                        config: {
                            baseUrl: 'https://credentialless-tts.test/v1',
                            insecureLocalOriginConsent: '',
                            insecureLocalConsentMachineId: '',
                            model: 'credentialless-tts',
                            voiceName: 'credentialless-voice',
                            format: 'wav',
                        },
                    },
                    local_direct: {
                        schemaVersion: 1,
                        config: {
                            stt: { provider: 'happier.voice.openai-compat/stt' },
                            tts: { provider: 'happier.voice.openai-compat/tts' },
                        },
                    },
                },
            },
        }));
        const localDirect = readRequiredRecord(
            readPredecessorAdapters(persisted).local_direct,
            'predecessor Local Direct adapter',
        );
        const sttOpenAiCompat = readRequiredRecord(
            readRequiredRecord(localDirect.stt, 'predecessor Local Direct STT').openaiCompat,
            'predecessor Local Direct OpenAI-compatible STT',
        );
        const ttsOpenAiCompat = readRequiredRecord(
            readRequiredRecord(localDirect.tts, 'predecessor Local Direct TTS').openaiCompat,
            'predecessor Local Direct OpenAI-compatible TTS',
        );

        expect(sttOpenAiCompat).toEqual({
            apiKey: null,
            baseUrl: 'https://credentialless-stt.test/v1',
            model: 'credentialless-whisper',
        });
        expect(ttsOpenAiCompat).toEqual({
            apiKey: null,
            baseUrl: 'https://credentialless-tts.test/v1',
            model: 'credentialless-tts',
            voice: 'credentialless-voice',
            format: 'wav',
        });
    });

    it('does not project a Connected Account speech binding as a released inline key', () => {
        const secret = {
            _isSecretValue: true as const,
            encryptedValue: { t: 'enc-v1' as const, c: 'connected-account-secret' },
        };
        const persisted = normalizePredecessorVoiceWrite(settingsParse({
            secrets: [{
                id: 'saved-connected-stt',
                name: 'Connected Account STT fallback',
                kind: 'apiKey',
                encryptedValue: secret,
                createdAt: 1,
                updatedAt: 1,
            }],
            voice: {
                providerId: 'local_direct',
                credentialBindings: [{
                    contribution: {
                        pluginId: 'happier.voice.openai-compat',
                        localId: 'stt',
                    },
                    credentialSlotId: 'api_key',
                    credentialSource: { kind: 'connectedAccount' },
                    credentialBindings: { account: { api_key: 'saved-connected-stt' } },
                }],
                providers: {
                    'happier.voice.openai-compat/stt': {
                        schemaVersion: 2,
                        config: {
                            baseUrl: 'https://connected-account-stt.test/v1',
                            model: 'connected-account-whisper',
                        },
                    },
                    local_direct: {
                        schemaVersion: 1,
                        config: {
                            stt: { provider: 'happier.voice.openai-compat/stt' },
                            tts: { provider: 'device' },
                        },
                    },
                },
            },
        }));
        const localDirect = readRequiredRecord(
            readPredecessorAdapters(persisted).local_direct,
            'predecessor Local Direct adapter',
        );
        const sttOpenAiCompat = readRequiredRecord(
            readRequiredRecord(localDirect.stt, 'predecessor Local Direct STT').openaiCompat,
            'predecessor Local Direct OpenAI-compatible STT',
        );
        const credentialBindings = readRequiredArray(
            readCanonicalVoiceSettings(persisted).credentialBindings,
            'canonical Voice credential bindings',
        );

        expect(sttOpenAiCompat.apiKey).toBeNull();
        expect(credentialBindings).toContainEqual(expect.objectContaining({
            credentialSource: { kind: 'connectedAccount' },
        }));
    });

    it.each(['plain', 'e2ee'] as const)(
        'round-trips released OpenAI-compatible speech fields and account envelopes in %s mode',
        (mode) => {
            const key = new Uint8Array(32).fill(19);
            const current = settingsParse({
                secrets: [
                    {
                        id: 'saved-oai-stt-account',
                        name: 'OpenAI-compatible STT account',
                        kind: 'apiKey',
                        encryptedValue: { _isSecretValue: true, value: 'stt-account-secret' },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    {
                        id: 'saved-oai-stt-machine',
                        name: 'OpenAI-compatible STT machine',
                        kind: 'apiKey',
                        encryptedValue: { _isSecretValue: true, value: 'stt-machine-secret' },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    {
                        id: 'saved-oai-tts-account',
                        name: 'OpenAI-compatible TTS account',
                        kind: 'apiKey',
                        encryptedValue: { _isSecretValue: true, value: 'tts-account-secret' },
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                voice: {
                    providerId: 'local_direct',
                    credentialBindings: [
                        {
                            providerId: 'happier.voice.openai-compat/stt',
                            credentialBindings: {
                                account: { api_key: 'saved-oai-stt-account' },
                                byMachineId: {
                                    'machine-oai': { api_key: 'saved-oai-stt-machine' },
                                },
                            },
                        },
                        {
                            providerId: 'happier.voice.openai-compat/tts',
                            credentialBindings: { account: { api_key: 'saved-oai-tts-account' } },
                        },
                    ],
                    providers: {
                        'happier.voice.openai-compat/stt': {
                            schemaVersion: 2,
                            config: {
                                baseUrl: 'https://stt.initial.test/v1',
                                insecureLocalOriginConsent: 'http://localhost:8101',
                                insecureLocalConsentMachineId: 'machine-oai',
                                language: 'de',
                                model: 'initial-whisper',
                            },
                        },
                        'happier.voice.openai-compat/tts': {
                            schemaVersion: 2,
                            config: {
                                baseUrl: 'https://tts.initial.test/v1',
                                insecureLocalOriginConsent: 'http://localhost:8102',
                                insecureLocalConsentMachineId: 'machine-oai',
                                format: 'mp3',
                                model: 'initial-tts',
                                voiceName: 'initial-voice',
                            },
                        },
                        local_direct: {
                            schemaVersion: 1,
                            config: {
                                stt: { provider: 'happier.voice.openai-compat/stt' },
                                tts: { provider: 'happier.voice.openai-compat/tts' },
                            },
                        },
                    },
                },
            });
            const encryptedWrite = normalizeVoiceSettingsServerDelta(
                sealSecretsDeep(current, key),
            ) as Record<string, unknown>;
            const releasedWrite = (mode === 'e2ee'
                ? encryptedWrite
                : unsealSecretsDeepWithKeys(encryptedWrite, [key])) as Record<string, unknown>;
            const releasedVoice = releasedWrite.voice as Readonly<Record<string, unknown>>;
            const releasedAdapters = releasedVoice.adapters as Readonly<Record<string, unknown>>;
            const releasedLocalDirect = releasedAdapters.local_direct as Readonly<Record<string, unknown>>;
            const releasedStt = releasedLocalDirect.stt as Readonly<Record<string, unknown>>;
            const releasedTts = releasedLocalDirect.tts as Readonly<Record<string, unknown>>;
            const releasedSttOpenAiCompat = releasedStt.openaiCompat as Readonly<Record<string, unknown>>;
            const releasedTtsOpenAiCompat = releasedTts.openaiCompat as Readonly<Record<string, unknown>>;

            expect(releasedSttOpenAiCompat).toMatchObject({
                baseUrl: 'https://stt.initial.test/v1',
                model: 'initial-whisper',
            });
            expect(releasedTtsOpenAiCompat).toMatchObject({
                baseUrl: 'https://tts.initial.test/v1',
                model: 'initial-tts',
                voice: 'initial-voice',
                format: 'mp3',
            });
            expect(releasedSttOpenAiCompat).not.toHaveProperty('language');
            expect(releasedSttOpenAiCompat).not.toHaveProperty('insecureLocalOriginConsent');
            expect(releasedTtsOpenAiCompat).not.toHaveProperty('insecureLocalConsentMachineId');
            if (mode === 'plain') {
                expect(releasedSttOpenAiCompat.apiKey).toEqual({
                    _isSecretValue: true,
                    value: 'stt-account-secret',
                });
                expect(releasedTtsOpenAiCompat.apiKey).toEqual({
                    _isSecretValue: true,
                    value: 'tts-account-secret',
                });
            } else {
                expect(releasedSttOpenAiCompat.apiKey).toMatchObject({
                    _isSecretValue: true,
                    encryptedValue: { t: 'enc-v1' },
                });
                expect(releasedTtsOpenAiCompat.apiKey).toMatchObject({
                    _isSecretValue: true,
                    encryptedValue: { t: 'enc-v1' },
                });
            }

            const rewritten = predecessorVoiceWrite(releasedWrite, {
                adapters: {
                    ...releasedAdapters,
                    local_direct: {
                        ...releasedLocalDirect,
                        stt: {
                            ...releasedStt,
                            openaiCompat: {
                                ...releasedSttOpenAiCompat,
                                baseUrl: 'https://stt.rewritten.test/v1',
                                model: 'rewritten-whisper',
                            },
                        },
                        tts: {
                            ...releasedTts,
                            openaiCompat: {
                                ...releasedTtsOpenAiCompat,
                                baseUrl: 'https://tts.rewritten.test/v1',
                                model: 'rewritten-tts',
                                voice: 'rewritten-voice',
                                format: 'wav',
                            },
                        },
                    },
                },
            });
            const restored = settingsParse(rewritten);
            const sttBinding = restored.voiceSettingsV1.credentialBindings.find((binding) => (
                binding.contribution.pluginId === 'happier.voice.openai-compat'
                && binding.contribution.localId === 'stt'
            ));
            const ttsBinding = restored.voiceSettingsV1.credentialBindings.find((binding) => (
                binding.contribution.pluginId === 'happier.voice.openai-compat'
                && binding.contribution.localId === 'tts'
            ));

            expect(restored.voiceSettingsV1.providers['happier.voice.openai-compat/stt']).toMatchObject({
                config: {
                    baseUrl: 'https://stt.rewritten.test/v1',
                    model: 'rewritten-whisper',
                    language: 'de',
                    insecureLocalOriginConsent: 'http://localhost:8101',
                    insecureLocalConsentMachineId: 'machine-oai',
                },
            });
            expect(restored.voiceSettingsV1.providers['happier.voice.openai-compat/tts']).toMatchObject({
                config: {
                    baseUrl: 'https://tts.rewritten.test/v1',
                    model: 'rewritten-tts',
                    voiceName: 'rewritten-voice',
                    format: 'wav',
                    insecureLocalOriginConsent: 'http://localhost:8102',
                    insecureLocalConsentMachineId: 'machine-oai',
                },
            });
            expect(sttBinding).toMatchObject({
                credentialBindings: {
                    account: { api_key: 'saved-oai-stt-account' },
                    byMachineId: {
                        'machine-oai': { api_key: 'saved-oai-stt-machine' },
                    },
                },
            });
            expect(ttsBinding).toMatchObject({
                credentialBindings: { account: { api_key: 'saved-oai-tts-account' } },
            });
            expect(restored.secrets.map((secret) => secret.id).sort()).toEqual([
                'saved-oai-stt-account',
                'saved-oai-stt-machine',
                'saved-oai-tts-account',
            ]);

            const restoredAfterRepeatedPredecessorWrite = settingsParse(predecessorVoiceWrite(
                normalizeVoiceSettingsServerDelta(restored) as Record<string, unknown>,
            ));
            const repeatedSttBindings = restoredAfterRepeatedPredecessorWrite.voiceSettingsV1
                .credentialBindings
                .filter((binding) => (
                    binding.contribution.pluginId === 'happier.voice.openai-compat'
                    && binding.contribution.localId === 'stt'
                ));
            const repeatedTtsBindings = restoredAfterRepeatedPredecessorWrite.voiceSettingsV1
                .credentialBindings
                .filter((binding) => (
                    binding.contribution.pluginId === 'happier.voice.openai-compat'
                    && binding.contribution.localId === 'tts'
                ));

            expect(restoredAfterRepeatedPredecessorWrite.secrets.map((secret) => secret.id).sort()).toEqual([
                'saved-oai-stt-account',
                'saved-oai-stt-machine',
                'saved-oai-tts-account',
            ]);
            expect(repeatedSttBindings).toEqual([
                expect.objectContaining({
                    credentialBindings: {
                        account: { api_key: 'saved-oai-stt-account' },
                        byMachineId: {
                            'machine-oai': { api_key: 'saved-oai-stt-machine' },
                        },
                    },
                }),
            ]);
            expect(repeatedTtsBindings).toEqual([
                expect.objectContaining({
                    credentialBindings: { account: { api_key: 'saved-oai-tts-account' } },
                }),
            ]);
        },
    );

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

    it.each(['plain', 'e2ee'] as const)(
        'matches the captured %s predecessor reader output from the current writer',
        (mode) => {
            const persistedVoice = currentWriterPredecessorVoice(mode);
            const {
                [VOICE_SETTINGS_CURRENT_WRITER_MARKER]: marker,
                ...predecessorReaderInput
            } = persistedVoice;
            const capturedOutput = capturedPredecessorVoice(mode);

            expect(marker).toBe(true);
            expect(normalizeCapturedCiphertext(
                projectCapturedPredecessorReaderOutput(predecessorReaderInput, capturedOutput),
            )).toEqual(
                normalizeCapturedCiphertext(capturedOutput),
            );
        },
    );

    it('rejects an old-reader-visible ElevenLabs difference in the complete captured golden', () => {
        const persistedVoice = currentWriterPredecessorVoice('plain', 'agent-different');
        const {
            [VOICE_SETTINGS_CURRENT_WRITER_MARKER]: _marker,
            ...predecessorReaderInput
        } = persistedVoice;
        const capturedOutput = capturedPredecessorVoice('plain');

        expect(normalizeCapturedCiphertext(
            projectCapturedPredecessorReaderOutput(predecessorReaderInput, capturedOutput),
        )).not.toEqual(
            normalizeCapturedCiphertext(capturedOutput),
        );
    });

    it.each([
        ['plain', { _isSecretValue: true, value: 'xi-plain' }],
        ['e2ee', {
            _isSecretValue: true,
            encryptedValue: { t: 'enc-v1', c: 'cipher-eleven' },
        }],
    ] as const)(
        'reads the captured %s predecessor whole-object write into canonical settings',
        (mode, expectedCredential) => {
            const parsed = settingsParse({ voice: capturedPredecessorVoice(mode) });

            expect(parsed.voice.providerId).toBe('happier.voice.elevenlabs/realtime-elevenlabs');
            expect(parsed.voice.assistantLanguage).toBe('de');
            expect(parsed.voice.providers['happier.voice.elevenlabs/realtime-elevenlabs']).toEqual({
                schemaVersion: 2,
                config: {
                    billingMode: 'byo',
                    agentId: 'agent-real',
                    tts: {
                        voiceId: 'EST9Ui6982FZPSi7gCHi',
                        modelId: null,
                        voiceSettings: {
                            stability: null,
                            similarityBoost: null,
                            speed: null,
                        },
                    },
                },
            });
            expect(parsed.secrets).toEqual([
                expect.objectContaining({
                    id: 'voice:realtime_elevenlabs:api_key',
                    encryptedValue: expectedCredential,
                }),
            ]);
            expect(parsed.voiceSettingsV1.credentialBindings).toEqual([
                {
                    contribution: {
                        pluginId: 'happier.voice.elevenlabs',
                        localId: 'realtime-elevenlabs',
                    },
                    credentialSlotId: 'api_key',
                    credentialSource: { kind: 'savedSecret' },
                    credentialBindings: {
                        account: { api_key: 'voice:realtime_elevenlabs:api_key' },
                    },
                },
            ]);
            expect(parsed.voice.credentialBindings).toEqual([]);
        },
    );

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
            credentialBindings: [expect.objectContaining({
                contribution: {
                    pluginId: 'acme.synthetic-voice',
                    localId: 'conversation',
                },
                credentialSlotId: 'api_key',
            })],
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
        ['realtime_elevenlabs', 'happier.voice.elevenlabs/realtime-elevenlabs'],
        ['local_direct', 'local_direct'],
        ['local_conversation', 'local_conversation'],
    ] as const)('preserves predecessor provider id %s for the new reader', (providerId, expected) => {
        const parsed = settingsParse({
            voice: {
                providerId,
                ...(providerId === 'local_direct' || providerId === 'local_conversation'
                    ? {
                        providers: {
                            [providerId]: {
                                schemaVersion: 1,
                                config: {
                                    stt: { provider: 'device' },
                                    tts: { provider: 'device' },
                                },
                            },
                        },
                    }
                    : {}),
            },
        });
        expect(parsed.voice.providerId).toBe(expected);

        const persisted = normalizeVoiceSettingsServerDelta(parsed) as Record<string, unknown>;
        expect((persisted.voice as Record<string, unknown>).providerId).toBe(providerId);
        expect((persisted.voiceSettingsV1 as Record<string, unknown>).providerId).toBe(expected);
    });
    // A predecessor Voice write is a degraded read of `voiceSettingsV1`:
    // `remote-dev` rewrites the whole `voice` object from its own closed schema
    // and cannot see the canonical credential store. It may supply a credential
    // it carries; it must never retract a binding it does not carry.
    describe('predecessor Voice writes never retract canonical credential bindings', () => {
        const encryptedCredential = (ciphertext: string) => ({
            _isSecretValue: true as const,
            encryptedValue: { t: 'enc-v1' as const, c: ciphertext },
        });

        function multiProviderAccount(elevenLabsSource: 'savedSecret' | 'connectedAccount') {
            return settingsParse({
                secrets: [
                    {
                        id: 'voice-elevenlabs-secret',
                        name: 'Voice ElevenLabs',
                        kind: 'apiKey',
                        encryptedValue: encryptedCredential('encrypted-elevenlabs-key'),
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    {
                        id: 'voice-gemini-secret',
                        name: 'Voice Gemini',
                        kind: 'apiKey',
                        encryptedValue: encryptedCredential('encrypted-gemini-key'),
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
                voice: {
                    providerId: 'realtime_elevenlabs',
                    credentialBindings: [
                        {
                            contribution: {
                                pluginId: 'happier.voice.elevenlabs',
                                localId: 'realtime-elevenlabs',
                            },
                            credentialSlotId: 'api_key',
                            credentialSource: { kind: elevenLabsSource },
                            credentialBindings: elevenLabsSource === 'savedSecret'
                                ? { account: { api_key: 'voice-elevenlabs-secret' } }
                                : {},
                        },
                        {
                            providerId: 'google_gemini',
                            credentialBindings: { account: { api_key: 'voice-gemini-secret' } },
                        },
                        {
                            contribution: {
                                pluginId: 'happier.voice.openai',
                                localId: 'realtime-openai',
                            },
                            credentialSlotId: 'api_key',
                            credentialSource: { kind: 'connectedAccount' },
                            credentialBindings: {},
                        },
                    ],
                    providers: {
                        realtime_elevenlabs: {
                            schemaVersion: 2,
                            config: CURRENT_ELEVENLABS_BYO_CONFIG,
                        },
                    },
                },
            });
        }

        function predecessorWriteWithElevenLabsCredential(
            persisted: Record<string, unknown>,
            apiKey: unknown,
        ): Record<string, unknown> {
            const predecessorVoice = persisted.voice as Readonly<Record<string, unknown>>;
            const adapters = predecessorVoice.adapters as Readonly<Record<string, unknown>>;
            const elevenLabs = adapters.realtime_elevenlabs as Readonly<Record<string, unknown>>;
            const byo = elevenLabs.byo as Readonly<Record<string, unknown>>;
            const nextByo: Record<string, unknown> = { ...byo };
            if (apiKey === undefined) delete nextByo.apiKey;
            else nextByo.apiKey = apiKey;
            return predecessorVoiceWrite(persisted, {
                adapters: {
                    ...adapters,
                    realtime_elevenlabs: { ...elevenLabs, byo: nextByo },
                },
            });
        }

        function readBindingBySlot(
            bindings: readonly Readonly<Record<string, unknown>>[],
            pluginId: string,
            localId: string,
        ): Readonly<Record<string, unknown>> | undefined {
            return bindings.find((binding) => {
                const contribution = binding.contribution as Readonly<Record<string, unknown>>;
                return contribution?.pluginId === pluginId && contribution?.localId === localId;
            });
        }

        it.each([
            ['omits the credential field entirely', undefined],
            ['carries an explicitly empty credential', null],
        ])('keeps the ElevenLabs binding when a predecessor write %s', (_label, apiKey) => {
            const current = multiProviderAccount('savedSecret');
            const persisted = normalizeVoiceSettingsServerDelta(current) as Record<string, unknown>;

            const restored = settingsParse(
                predecessorWriteWithElevenLabsCredential(persisted, apiKey),
            );

            expect(readBindingBySlot(
                restored.voiceSettingsV1.credentialBindings,
                'happier.voice.elevenlabs',
                'realtime-elevenlabs',
            )).toEqual({
                contribution: {
                    pluginId: 'happier.voice.elevenlabs',
                    localId: 'realtime-elevenlabs',
                },
                credentialSlotId: 'api_key',
                credentialSource: { kind: 'savedSecret' },
                credentialBindings: { account: { api_key: 'voice-elevenlabs-secret' } },
            });
            // The write carried one adapter; nothing else may be touched.
            expect(readBindingBySlot(
                restored.voiceSettingsV1.credentialBindings,
                'happier.voice.google',
                'gemini-stt',
            )).toMatchObject({
                credentialBindings: { account: { api_key: 'voice-gemini-secret' } },
            });
            expect(readBindingBySlot(
                restored.voiceSettingsV1.credentialBindings,
                'happier.voice.openai',
                'realtime-openai',
            )).toMatchObject({ credentialSource: { kind: 'connectedAccount' } });
        });

        it('still adopts an ElevenLabs credential the predecessor actually carries', () => {
            const current = multiProviderAccount('savedSecret');
            const persisted = normalizeVoiceSettingsServerDelta(current) as Record<string, unknown>;

            const restored = settingsParse(predecessorWriteWithElevenLabsCredential(
                persisted,
                encryptedCredential('predecessor-entered-key'),
            ));

            const binding = readBindingBySlot(
                restored.voiceSettingsV1.credentialBindings,
                'happier.voice.elevenlabs',
                'realtime-elevenlabs',
            );
            expect(binding).toMatchObject({
                credentialSource: { kind: 'savedSecret' },
                credentialBindings: { account: { api_key: 'voice:realtime_elevenlabs:api_key' } },
            });
            expect(restored.secrets.find(
                (secret) => secret.id === 'voice:realtime_elevenlabs:api_key',
            )?.encryptedValue).toEqual(encryptedCredential('predecessor-entered-key'));
        });

        it('never demotes a Connected-Account credential source the predecessor cannot express', () => {
            const current = multiProviderAccount('connectedAccount');
            const persisted = normalizeVoiceSettingsServerDelta(current) as Record<string, unknown>;

            const restored = settingsParse(predecessorWriteWithElevenLabsCredential(
                persisted,
                encryptedCredential('predecessor-entered-key'),
            ));

            expect(readBindingBySlot(
                restored.voiceSettingsV1.credentialBindings,
                'happier.voice.elevenlabs',
                'realtime-elevenlabs',
            )).toMatchObject({ credentialSource: { kind: 'connectedAccount' } });
        });

        it('keeps every stored binding when a predecessor delta omits voiceSettingsV1', () => {
            const current = multiProviderAccount('savedSecret');
            const persisted = normalizeVoiceSettingsServerDelta(current) as Record<string, unknown>;
            const predecessorDelta = {
                voice: (predecessorWriteWithElevenLabsCredential(persisted, null)).voice,
            };

            const merged = normalizeVoiceSettingsServerDelta(
                predecessorDelta,
                persisted,
            ) as Record<string, unknown>;

            const bindings = (merged.voiceSettingsV1 as Readonly<{
                credentialBindings: readonly Readonly<Record<string, unknown>>[];
            }>).credentialBindings;
            expect(bindings.map((binding) => (
                binding.contribution as Readonly<Record<string, string>>
            ).localId).sort()).toEqual([
                'gemini-stt',
                'realtime-elevenlabs',
                'realtime-openai',
            ]);
        });
        // `voiceSettingsParse` validates `credentialBindings` all-or-nothing
        // (`VoiceCredentialBindingsSchema`) and falls back to `[]`. Every writer
        // that round-trips the canonical root through it — notably
        // `VoiceProviderSettingsActions.applyPatch` — would then persist the
        // empty array. What this owner emits must always be accepted there.
        it('emits canonical bindings a strict re-read can never reject', () => {
            const parsed = settingsParse({
                secrets: [{
                    id: 'voice-elevenlabs-secret',
                    name: 'Voice ElevenLabs',
                    kind: 'apiKey',
                    encryptedValue: encryptedCredential('encrypted-elevenlabs-key'),
                    createdAt: 1,
                    updatedAt: 1,
                }],
                voiceSettingsV1: {
                    providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                    credentialBindings: [
                        {
                            contribution: {
                                pluginId: 'happier.voice.elevenlabs',
                                localId: 'realtime-elevenlabs',
                            },
                            credentialSlotId: 'api_key',
                            credentialSource: { kind: 'savedSecret' },
                            credentialBindings: {
                                account: { api_key: 'voice-elevenlabs-secret' },
                            },
                        },
                        // The same identity arriving through the predecessor
                        // carrier — one duplicate is enough to void the array.
                        {
                            providerId: 'realtime_elevenlabs',
                            credentialBindings: {
                                account: { api_key: 'voice-elevenlabs-secret' },
                            },
                        },
                    ],
                },
            });

            expect(parsed.voiceSettingsV1.credentialBindings).toHaveLength(1);
            expect(voiceSettingsParse(parsed.voiceSettingsV1).credentialBindings).toEqual(
                parsed.voiceSettingsV1.credentialBindings,
            );
        });
    });
});
