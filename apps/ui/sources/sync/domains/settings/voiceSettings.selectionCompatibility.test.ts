import { describe, expect, it } from 'vitest';

import {
    readLocalConversationVoiceSettings,
    voiceSettingsDefaults,
    voiceSettingsParse,
    writeLocalConversationVoiceSettings,
} from './voiceSettings';
import { settingsParse } from './settings';
import {
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

/** A 0.2 whole-object Voice write beside the canonical root, from the provenance-pinned captured shape. */
function predecessorVoiceWrite(
    persisted: Readonly<Record<string, unknown>>,
    patch: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
    const captured = capturedPredecessorVoice('plain');
    return {
        ...persisted,
        voice: {
            providerId: captured.providerId,
            assistantLanguage: captured.assistantLanguage,
            ui: captured.ui,
            privacy: captured.privacy,
            adapters: captured.adapters,
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

/**
 * `voiceSettingsV1` is the canonical current owner. These helpers deliberately
 * cross only the raw persistence boundary to inspect its bounded predecessor
 * sidecar, which the typed runtime `voice` view does not expose.
 */
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

    it('retains a genuine predecessor Chat source on unrelated Settings writes before the Provider import is acknowledged', () => {
        const predecessor = capturedPredecessorVoice('plain');
        const adapters = readRequiredRecord(predecessor.adapters, 'captured predecessor adapters');
        const localConversation = readRequiredRecord(adapters.local_conversation, 'captured Local Conversation');
        const legacyChat = {
            chatBaseUrl: 'https://legacy-chat.example.test/v1', chatModel: 'legacy-chat',
            commitModel: 'legacy-commit', chatApiKey: null, temperature: 0.4,
        };
        // The pinned predecessor accepts and writes this direct Chat selection;
        // unlike a marked current-writer sidecar, it has no Provider row yet.
        const source = { voice: { ...predecessor, providerId: 'local_conversation', adapters: {
            ...adapters, local_conversation: { ...localConversation, agent: {
                ...readRequiredRecord(localConversation.agent, 'captured Agent'),
                backend: 'openai_compat', agentSource: 'agent', agentId: 'opencode', openaiCompat: legacyChat,
            } },
        } } };
        const admitted = settingsParse(source);
        const persisted = normalizeVoiceSettingsServerDelta({ ...admitted, uiFontSize: 'larger' }, source, null);
        expect(readRequiredRecord(readPredecessorAdapters(persisted).local_conversation, 'retained source').agent)
            .toMatchObject({ backend: 'openai_compat', openaiCompat: legacyChat });
        const rewritten = normalizeVoiceSettingsServerDelta(
            { ...settingsParse(persisted), uiFontSize: 'default' }, persisted, null,
        );
        expect(readRequiredRecord(readPredecessorAdapters(rewritten).local_conversation, 're-read source').agent)
            .toMatchObject({ backend: 'openai_compat', openaiCompat: legacyChat });
        const changedSource = { ...source, voice: { ...source.voice, adapters: {
            ...source.voice.adapters, local_conversation: { ...source.voice.adapters.local_conversation,
                agent: { ...source.voice.adapters.local_conversation.agent,
                    openaiCompat: { ...legacyChat, chatModel: 'changed-chat' } } },
        } } };
        expect(() => normalizeVoiceSettingsServerDelta(changedSource, source, null))
            .toThrow('voice_provider_catalog_unavailable');
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
            voiceSettingsV1: Readonly<Record<string, unknown>>;
        }>;

        expect(current.voice.diagnostics).toEqual(current.voiceDiagnosticsV1);
        expect(persisted.voiceSettingsV1).not.toHaveProperty('diagnostics');
        expect(persisted).not.toHaveProperty('voice');
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
                executionMachine: { mode: 'fixed', machineId: 'machine-1' },
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

        expect(canonical).toEqual(expect.objectContaining({
            providerId: EXTERNAL_PROVIDER_ID,
            dictation: expect.objectContaining({
                sttBinding: 'explicit',
                language: 'de',
                stt: expect.objectContaining({ provider: 'device' }),
            }),
            welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
            executionMachine: { mode: 'fixed', machineId: 'machine-1' },
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
        expect(persisted).not.toHaveProperty('voice');
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
            const adapters = capturedPredecessorVoice('plain').adapters as Readonly<Record<string, unknown>>;
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

describe('0.2 `voice` data through the read path', () => {
    const canonicalAccount = () => normalizeVoiceSettingsServerDelta(settingsParse({
        voice: {
            providerId: EXTERNAL_PROVIDER_ID,
            dictation: { sttBinding: 'explicit', language: 'de', stt: { provider: 'device' } },
            privacy: { currentUiContextMode: 'on_demand' },
            providers: {
                [EXTERNAL_PROVIDER_ID]: { schemaVersion: 1, config: EXTERNAL_CONFIG },
                'happier.agent.codex/realtime-codex': { schemaVersion: 2, config: {
                    globalConnectedServices: REALTIME_CODEX_GLOBAL_CONNECTED_SERVICES,
                } },
            },
        },
    })) as Record<string, unknown>;

    it.each(['plain', 'e2ee'] as const)('loads a captured released %s Voice document on its own', (mode) => {
        const captured = capturedPredecessorVoice(mode);
        const parsed = settingsParse({ voice: captured });
        expect(parsed.voice.assistantLanguage).toBe(captured.assistantLanguage);
        expect(parsed.voice.providerId).toBe(parsed.voiceSettingsV1.providerId);
        const persisted = normalizeVoiceSettingsServerDelta(parsed) as Record<string, unknown>;
        expect(settingsParse(persisted).voice.assistantLanguage).toBe(captured.assistantLanguage);
    });

    it('keeps canonical-only fields when a 0.2 whole-object write sits beside the canonical root', () => {
        const persisted = canonicalAccount();
        expect(persisted).not.toHaveProperty('voice');
        const captured = capturedPredecessorVoice('plain');
        const restored = settingsParse(predecessorVoiceWrite(persisted, {
            providerId: 'off', assistantLanguage: 'fr',
            privacy: { ...(captured.privacy as object), shareSessionSummary: false },
        }));
        expect(restored.voice.providerId).toBeNull();
        expect(restored.voice.assistantLanguage).toBe('fr');
        expect(restored.voice.privacy).toMatchObject({ currentUiContextMode: 'on_demand', shareSessionSummary: false });
        expect(restored.voice.dictation).toMatchObject({ sttBinding: 'explicit', language: 'de', stt: { provider: 'device' } });
        expect(restored.voice.providers[EXTERNAL_PROVIDER_ID]).toEqual({ schemaVersion: 1, config: EXTERNAL_CONFIG });
        expect(restored.voice.providers['happier.agent.codex/realtime-codex']).toEqual({ schemaVersion: 2, config: {
            globalConnectedServices: REALTIME_CODEX_GLOBAL_CONNECTED_SERVICES,
        } });
    });

    it('lets a 0.2 write select a built-in or off and edit its adapters through provider-owned migrations', () => {
        const persisted = canonicalAccount();
        expect(settingsParse(predecessorVoiceWrite(persisted, { providerId: 'local_direct' })).voice.providerId).toBe('local_direct');
        const off = settingsParse(predecessorVoiceWrite(persisted, { providerId: 'off' }));
        expect(off.voice.providerId).toBeNull();
        expect(off.voiceSettingsV1.providerId).toBeNull();

        const adapters = capturedPredecessorVoice('plain').adapters as Readonly<Record<string, Record<string, unknown>>>;
        const conversation = adapters.local_conversation!;
        const edited = settingsParse(predecessorVoiceWrite(persisted, {
            providerId: 'local_conversation',
            adapters: { ...adapters,
                local_direct: { ...adapters.local_direct, networkTimeoutMs: 31_000 },
                local_conversation: { ...conversation, networkTimeoutMs: 32_000, agent: {
                    ...(conversation.agent as object),
                    welcome: { enabled: false, mode: 'immediate', templateId: null },
                    machineTargetMode: 'auto', machineTargetId: null, autoTargetMachineId: 'machine-auto',
                } },
            },
        }));
        const providers = edited.voiceSettingsV1.providers;
        expect(providers.local_direct?.config).toMatchObject({ networkTimeoutMs: 31_000 });
        expect(providers.local_conversation?.config).toMatchObject({ networkTimeoutMs: 32_000 });
        expect(edited.voice.welcome).toEqual({ enabled: false, mode: 'immediate', templateId: null });
        expect(edited.voice.executionMachine).toEqual({ mode: 'auto', machineId: null });
    });
});

describe('Voice Agent selection target facts persistence', () => {
    it('round-trips an exact external Agent selection with its backend target key and qualified identity', () => {
        const defaults = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const written = writeLocalConversationVoiceSettings(voiceSettingsDefaults, {
            ...defaults,
            agent: {
                ...defaults.agent,
                agentSource: 'agent',
                agentId: 'acme-voice-agent',
                agentTargetKey: 'agent:acme.voice/agent',
                agentIdentity: { pluginId: 'acme.voice', localId: 'agent' },
            },
        });

        const roundTripped = readLocalConversationVoiceSettings(voiceSettingsParse(written));
        expect(roundTripped.agent.agentTargetKey).toBe('agent:acme.voice/agent');
        expect(roundTripped.agent.agentIdentity).toEqual({ pluginId: 'acme.voice', localId: 'agent' });
        expect(roundTripped.agent).not.toHaveProperty('agentProjectionGeneration');
        expect(roundTripped.agent.agentId).toBe('acme-voice-agent');
    });

    it('keeps a legacy persisted Agent selection valid when it carries no exact target facts', () => {
        // A profile written before exact target facts existed parses unchanged
        // so every existing bundled selection keeps working.
        const parsed = readLocalConversationVoiceSettings(voiceSettingsParse({
            providers: {
                local_conversation: {
                    schemaVersion: 1,
                    config: {
                        agent: {
                            agentSource: 'agent',
                            agentId: 'codex',
                        },
                    },
                },
            },
        }));

        expect(parsed.agent.agentId).toBe('codex');
        expect(parsed.agent.agentTargetKey ?? null).toBeNull();
        expect(parsed.agent.agentIdentity ?? null).toBeNull();
        expect(parsed.agent).not.toHaveProperty('agentProjectionGeneration');
    });

    it('discards malformed exact target facts instead of persisting an invalid target key', () => {
        const defaults = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const written = writeLocalConversationVoiceSettings(voiceSettingsDefaults, {
            ...defaults,
            agent: {
                ...defaults.agent,
                agentSource: 'agent',
                agentId: 'acme-voice-agent',
                agentTargetKey: 'agent:missing-separator',
                agentIdentity: { pluginId: '', localId: 'agent' },
            },
        });

        const roundTripped = readLocalConversationVoiceSettings(voiceSettingsParse(written));
        expect(roundTripped.agent.agentTargetKey ?? null).toBeNull();
        expect(roundTripped.agent.agentIdentity ?? null).toBeNull();
    });
});
