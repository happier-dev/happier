import { describe, expect, it } from 'vitest';

import { applySettings, settingsParse } from './settings';
import {
    VOICE_LEGACY_CREDENTIAL_RECOVERY_MARKER,
    voiceSettingsParse,
    type VoiceSettings,
} from './voiceSettings';
import {
    normalizeVoiceDiagnosticsLocalDelta,
    normalizeVoiceDiagnosticsServerDelta,
    normalizeVoiceSettingsServerDelta,
} from './voiceSettingsPersistence';

const ENABLED_DIAGNOSTICS = {
    v: 1,
    enabled: true,
    consentVersion: 1,
    captureSttInput: true,
    captureTtsOutput: false,
    maxAgeMs: 12 * 60 * 60 * 1_000,
    maxFiles: 7,
    maxBytes: 4 * 1024 * 1024,
    maxDurationMs: 60_000,
} as const;

const DISABLED_DIAGNOSTICS = {
    v: 1,
    enabled: false,
    consentVersion: null,
    captureSttInput: false,
    captureTtsOutput: false,
    maxAgeMs: 24 * 60 * 60 * 1_000,
    maxFiles: 20,
    maxBytes: 100 * 1024 * 1024,
    maxDurationMs: 5 * 60 * 1_000,
} as const;

describe('voice settings mixed-version persistence', () => {
    it('round-trips Dictation only through the canonical Voice root without leaking inline credentials', () => {
        const parsed = settingsParse({
            voice: {
                dictation: {
                    sttBinding: 'explicit',
                    language: 'de-CH',
                    stt: {
                        provider: 'openai_compat',
                        openaiCompat: {
                            baseUrl: 'https://speech.example.test/v1',
                            model: 'whisper-dictation',
                            apiKey: { _isSecretValue: true, value: 'must-not-persist' },
                        },
                    },
                },
            },
        });

        const persisted = normalizeVoiceSettingsServerDelta(parsed) as Record<string, unknown>;
        const canonical = persisted.voiceSettingsV1 as Record<string, unknown>;
        const predecessor = persisted.voice as Record<string, unknown>;
        expect(canonical.dictation).toMatchObject({
            sttBinding: 'explicit',
            language: 'de-CH',
            stt: {
                provider: 'openai_compat',
                openaiCompat: {
                    baseUrl: 'https://speech.example.test/v1',
                    model: 'whisper-dictation',
                    apiKey: null,
                },
            },
        });
        expect(predecessor).not.toHaveProperty('dictation');
        expect(JSON.stringify(persisted)).not.toContain('must-not-persist');

        expect(settingsParse(persisted).voice.dictation).toMatchObject({
            sttBinding: 'explicit',
            language: 'de-CH',
            stt: { provider: 'openai_compat' },
        });
    });

    it('converts released Voice secret fields into SavedSecrets and canonical bindings', () => {
        const legacySecret = { _isSecretValue: true as const, value: 'legacy-key' };
        const parsed = settingsParse({
            schemaVersion: 7,
            voice: {
                providerId: 'realtime_elevenlabs',
                adapters: {
                    realtime_elevenlabs: { billingMode: 'byo', byo: { agentId: 'agent-1', apiKey: legacySecret } },
                    local_direct: {
                        stt: { provider: 'google_gemini', googleGemini: { apiKey: legacySecret, model: 'gemini-2.5-flash' }, openaiCompat: { apiKey: legacySecret } },
                        tts: { provider: 'google_cloud', googleCloud: { apiKey: legacySecret, voiceName: 'en-US-Test-A' }, openaiCompat: { apiKey: legacySecret } },
                    },
                    local_conversation: {
                        agent: { openaiCompat: { chatApiKey: legacySecret } },
                    },
                },
            },
        });

        expect(parsed.secrets.map((secret) => secret.id).sort()).toEqual([
            'voice:google_cloud:api_key',
            'voice:google_gemini:api_key',
            'voice:openai_compat:chat_api_key',
            'voice:openai_compat:stt_api_key',
            'voice:openai_compat:tts_api_key',
            'voice:realtime_elevenlabs:api_key',
        ]);
        expect(parsed.voice.credentialBindings).toEqual(expect.arrayContaining([
            expect.objectContaining({ providerId: 'realtime_elevenlabs', credentialBindings: { account: { api_key: 'voice:realtime_elevenlabs:api_key' } } }),
            expect.objectContaining({ providerId: 'google_gemini', credentialBindings: { account: { api_key: 'voice:google_gemini:api_key' } } }),
            expect.objectContaining({ providerId: 'google_cloud', credentialBindings: { account: { api_key: 'voice:google_cloud:api_key' } } }),
            expect.objectContaining({ providerId: 'openai_compat' }),
        ]));
        expect(parsed.voice.credentialBindings.find((binding) => binding.providerId === 'openai_compat')?.credentialBindings.account).toEqual({
            stt_api_key: 'voice:openai_compat:stt_api_key',
            tts_api_key: 'voice:openai_compat:tts_api_key',
            chat_api_key: 'voice:openai_compat:chat_api_key',
        });
        expect(JSON.stringify(parsed.voice)).not.toContain('legacy-key');
    });

    it('preserves a malformed legacy Voice secret as an opaque migration source', () => {
        const input = {
            voice: {
                providerId: 'realtime_elevenlabs',
                adapters: {
                    realtime_elevenlabs: { billingMode: 'byo', byo: { agentId: 'agent-1', apiKey: { malformed: true } } },
                },
            },
        };
        const parsed = settingsParse(input) as Record<string, unknown>;
        expect(parsed.secrets).toEqual([]);
        expect(JSON.stringify(parsed.voice)).toContain('malformed');

        const persisted = normalizeVoiceSettingsServerDelta(parsed);
        const reparsed = settingsParse(persisted);
        expect(JSON.stringify((persisted as Record<string, unknown>).voiceSettingsV1)).toContain('malformed');
        expect(JSON.stringify(reparsed.voice)).toContain('malformed');
    });

    it('drops an unbounded malformed legacy Voice secret instead of persisting it', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const parsed = settingsParse({
            voice: {
                adapters: {
                    realtime_elevenlabs: {
                        byo: {
                            apiKey: cyclic,
                        },
                    },
                },
            },
        }) as Record<string, unknown>;

        expect(parsed.voice).not.toHaveProperty('adapters');
        expect(() => normalizeVoiceSettingsServerDelta(parsed)).not.toThrow();
    });

    it('bounds the aggregate malformed legacy credential recovery carrier', () => {
        const malformed = (marker: string) => ({ malformed: `${marker}:${'x'.repeat(12_000)}` });
        const parsed = voiceSettingsParse({
            adapters: {
                realtime_elevenlabs: { byo: { apiKey: malformed('elevenlabs') } },
                local_direct: {
                    stt: {
                        googleGemini: { apiKey: malformed('gemini') },
                        openaiCompat: { apiKey: malformed('openai-stt') },
                    },
                    tts: {
                        googleCloud: { apiKey: malformed('google-cloud') },
                        openaiCompat: { apiKey: malformed('openai-tts') },
                    },
                },
                local_conversation: {
                    agent: { openaiCompat: { chatApiKey: malformed('openai-chat') } },
                },
            },
        }) as VoiceSettings & { adapters?: unknown };

        const serialized = JSON.stringify(parsed.adapters);
        expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(65_536);
        expect(serialized).not.toContain('openai-chat');
    });

    it('round-trips a colliding valid legacy Voice secret as an inert recovery carrier', () => {
        const existingSecret = { _isSecretValue: true as const, value: 'existing-key' };
        const collidingLegacySecret = { _isSecretValue: true as const, value: 'legacy-key' };
        const parsed = settingsParse({
            secrets: [{
                id: 'voice:realtime_elevenlabs:api_key',
                name: 'Existing Voice key',
                kind: 'apiKey',
                encryptedValue: existingSecret,
                createdAt: 1,
                updatedAt: 1,
            }],
            voice: {
                providerId: 'realtime_elevenlabs',
                adapters: {
                    realtime_elevenlabs: {
                        billingMode: 'byo',
                        byo: { agentId: 'agent-1', apiKey: collidingLegacySecret },
                    },
                },
            },
        });

        expect(parsed.secrets).toHaveLength(1);
        expect(parsed.voice.credentialBindings).toEqual([]);
        expect((parsed.voice as VoiceSettings & { adapters?: unknown }).adapters).toEqual({
            realtime_elevenlabs: {
                byo: { apiKey: collidingLegacySecret },
            },
        });
        expect((parsed.voice as VoiceSettings & Record<string, unknown>)[VOICE_LEGACY_CREDENTIAL_RECOVERY_MARKER]).toBe(true);
        expect(JSON.stringify(parsed.voice.providers)).not.toContain('legacy-key');

        const persisted = normalizeVoiceSettingsServerDelta(parsed);
        const reparsed = settingsParse(persisted);
        expect(((persisted as Record<string, unknown>).voiceSettingsV1 as { adapters?: unknown }).adapters).toEqual({
            realtime_elevenlabs: {
                byo: { apiKey: collidingLegacySecret },
            },
        });
        expect((reparsed.voice as VoiceSettings & { adapters?: unknown }).adapters).toEqual({
            realtime_elevenlabs: {
                byo: { apiKey: collidingLegacySecret },
            },
        });
        expect(reparsed.voice.credentialBindings).toEqual([]);
    });

    it('does not let a raw predecessor marker suppress normal legacy migration', () => {
        const parsed = settingsParse({
            voice: {
                [VOICE_LEGACY_CREDENTIAL_RECOVERY_MARKER]: true,
                adapters: {
                    realtime_elevenlabs: {
                        billingMode: 'byo',
                        byo: {
                            agentId: 'agent-from-predecessor',
                            apiKey: { _isSecretValue: true, value: 'legacy-key' },
                        },
                    },
                },
            },
        });

        expect(parsed.secrets).toHaveLength(1);
        expect(parsed.voice.credentialBindings).toEqual([
            expect.objectContaining({
                providerId: 'realtime_elevenlabs',
                credentialBindings: { account: { api_key: 'voice:realtime_elevenlabs:api_key' } },
            }),
        ]);
        expect((parsed.voice as VoiceSettings & { adapters?: unknown }).adapters).toBeUndefined();
        expect((parsed.voice as VoiceSettings & Record<string, unknown>)[VOICE_LEGACY_CREDENTIAL_RECOVERY_MARKER]).toBeUndefined();
        expect(parsed.voice.providers.realtime_elevenlabs?.config).toMatchObject({
            billingMode: 'byo',
            byo: { agentId: 'agent-from-predecessor' },
        });
    });

    it('keeps a predecessor key that conflicts with an existing binding inert', () => {
        const parsed = settingsParse({
            secrets: [{
                id: 'saved:elevenlabs',
                name: 'Current ElevenLabs key',
                kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'current-key' },
                createdAt: 1,
                updatedAt: 1,
            }],
            voice: {
                credentialBindings: [{
                    providerId: 'realtime_elevenlabs',
                    credentialBindings: { account: { api_key: 'saved:elevenlabs' } },
                }],
                adapters: {
                    realtime_elevenlabs: {
                        billingMode: 'byo',
                        byo: {
                            agentId: 'predecessor-agent',
                            apiKey: { _isSecretValue: true, value: 'predecessor-key' },
                        },
                    },
                },
            },
        });

        expect(parsed.voice.credentialBindings[0]?.credentialBindings.account?.api_key).toBe('saved:elevenlabs');
        expect(JSON.stringify(parsed.voice.providers)).not.toContain('predecessor-key');
        expect(JSON.stringify((parsed.voice as VoiceSettings & { adapters?: unknown }).adapters)).toContain('predecessor-key');
    });

    it('reads the diagnostics account field retained by the released whole-object writer', () => {
        // Provenance-pinned golden output from the released writer shape:
        // - web stable v0.2.0 @ dc5203145dea46a1280286eb74d90f20d8b9e817
        // - web preview @ 4913c1e533c872a0712ba1c25b3104fd470aacc2
        // Their closed voice parser drops nested future fields, while the account
        // parser preserves unknown top-level settings before the whole-object write.
        const releasedWriterOutput = {
            schemaVersion: 7,
            voiceDiagnosticsV1: ENABLED_DIAGNOSTICS,
            voice: {
                providerId: 'off',
                assistantLanguage: 'fr',
                privacy: {
                    shareSessionSummary: false,
                    shareRecentMessages: true,
                    recentMessagesCount: 3,
                    shareToolNames: true,
                    sharePermissionRequests: true,
                    shareDeviceInventory: true,
                    shareFilePaths: false,
                    shareToolArgs: false,
                },
            },
        };

        const parsed = settingsParse(releasedWriterOutput);

        expect(parsed.voice.assistantLanguage).toBe('fr');
        expect(parsed.voice.diagnostics).toEqual(ENABLED_DIAGNOSTICS);
        expect(parsed.voiceDiagnosticsV1).toEqual(ENABLED_DIAGNOSTICS);
    });

    it('migrates legacy nested diagnostics to one serialized top-level owner', () => {
        const parsed = settingsParse({
            voice: {
                providerId: 'local_conversation',
                diagnostics: ENABLED_DIAGNOSTICS,
            },
        });

        expect(parsed.voice.diagnostics).toEqual(ENABLED_DIAGNOSTICS);
        expect(parsed.voiceDiagnosticsV1).toEqual(ENABLED_DIAGNOSTICS);
        const persisted = normalizeVoiceDiagnosticsServerDelta(parsed);
        expect(JSON.parse(JSON.stringify(persisted))).toMatchObject({
            voiceDiagnosticsV1: ENABLED_DIAGNOSTICS,
            voice: { providerId: 'local_conversation' },
        });
        expect(JSON.parse(JSON.stringify(persisted)).voice).not.toHaveProperty('diagnostics');
    });

    it('keeps an explicit diagnostics disable authoritative over stale nested data', () => {
        const current = settingsParse({
            voiceDiagnosticsV1: ENABLED_DIAGNOSTICS,
            voice: { diagnostics: ENABLED_DIAGNOSTICS },
        });

        const next = applySettings(current, {
            voiceDiagnosticsV1: DISABLED_DIAGNOSTICS,
            voice: {
                ...current.voice,
                assistantLanguage: 'de',
            },
        });

        expect(next.voice.assistantLanguage).toBe('de');
        expect(next.voice.diagnostics).toEqual(DISABLED_DIAGNOSTICS);
        const persisted = normalizeVoiceDiagnosticsServerDelta(next);
        expect(JSON.parse(JSON.stringify(persisted))).toMatchObject({
            voiceDiagnosticsV1: DISABLED_DIAGNOSTICS,
            voice: { assistantLanguage: 'de' },
        });
        expect(JSON.parse(JSON.stringify(persisted)).voice).not.toHaveProperty('diagnostics');
    });

    it('retains canonical diagnostics when a current writer patches voice without a diagnostics view', () => {
        const current = settingsParse({
            voiceDiagnosticsV1: ENABLED_DIAGNOSTICS,
            voice: { assistantLanguage: 'en' },
        });
        const localDelta = normalizeVoiceDiagnosticsLocalDelta({
            voice: { assistantLanguage: 'de' },
        }, current);
        const persistedDelta = normalizeVoiceDiagnosticsServerDelta(localDelta);

        expect((localDelta as Record<string, unknown>).voiceDiagnosticsV1).toEqual(ENABLED_DIAGNOSTICS);
        expect((localDelta.voice as Record<string, unknown>).diagnostics).toEqual(ENABLED_DIAGNOSTICS);
        expect((persistedDelta as Record<string, unknown>).voiceDiagnosticsV1).toEqual(ENABLED_DIAGNOSTICS);
        expect(persistedDelta.voice).not.toHaveProperty('diagnostics');
    });

    it('survives a new-write, released-client edit, and new-reader downgrade cycle', () => {
        const current = settingsParse({
            voice: {
                providerId: 'local_conversation',
                diagnostics: ENABLED_DIAGNOSTICS,
            },
        });
        const newWriterOutput = normalizeVoiceDiagnosticsServerDelta(current);

        // The released parser/writer preserves unknown account-root fields, but
        // serializes only the voice keys it knows. This is its observable output
        // after changing assistantLanguage on the new writer's payload.
        const releasedWriterOutput = {
            ...newWriterOutput,
            voice: {
                providerId: 'local_conversation',
                assistantLanguage: 'it',
                privacy: current.voice.privacy,
            },
        };
        const reparsed = settingsParse(releasedWriterOutput);

        expect(reparsed.voice.assistantLanguage).toBe('it');
        expect(reparsed.voice.diagnostics).toEqual(ENABLED_DIAGNOSTICS);
        expect((reparsed as Record<string, unknown>).voiceDiagnosticsV1).toEqual(ENABLED_DIAGNOSTICS);
    });

    it('fails closed when the canonical diagnostics field is explicitly malformed', () => {
        const parsed = settingsParse({
            voiceDiagnosticsV1: {
                enabled: true,
                consentVersion: null,
                maxFiles: Number.MAX_SAFE_INTEGER,
            },
            voice: { diagnostics: ENABLED_DIAGNOSTICS },
        });

        expect(parsed.voice.diagnostics).toEqual(DISABLED_DIAGNOSTICS);
        expect(parsed.voiceDiagnosticsV1).toEqual(DISABLED_DIAGNOSTICS);
    });

    it('preserves bounded future voice namespaces inertly and drops unsafe or oversized values', () => {
        const oversized = 'x'.repeat(65_537);
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const tooDeep: Record<string, unknown> = {};
        let depthCursor = tooDeep;
        for (let depth = 0; depth < 34; depth += 1) {
            const next: Record<string, unknown> = {};
            depthCursor.next = next;
            depthCursor = next;
        }
        const tooManyEntries = Object.fromEntries(
            Array.from({ length: 4_097 }, (_, index) => [`key_${index}`, index]),
        );
        const input = JSON.parse(JSON.stringify({
            providerId: 'local_conversation',
            future_namespace_v2: {
                schemaVersion: 2,
                config: { mode: 'future', nested: [1, 2, 3] },
            },
            constructor: { polluted: true },
            toString: 'shadowed',
            oversized_namespace: oversized,
        })) as Record<string, unknown>;
        input.cyclic_namespace = cyclic;
        input.too_deep_namespace = tooDeep;
        input.too_many_entries_namespace = tooManyEntries;
        input.non_json_namespace = { value: undefined };

        const parsed = voiceSettingsParse(input) as VoiceSettings & Record<string, unknown>;
        const persisted = normalizeVoiceDiagnosticsServerDelta({ voice: parsed });

        expect(parsed.future_namespace_v2).toEqual(input.future_namespace_v2);
        expect((persisted.voice as Record<string, unknown>).future_namespace_v2).toEqual(input.future_namespace_v2);
        expect(parsed).not.toHaveProperty('constructor');
        expect(Object.prototype.hasOwnProperty.call(parsed, 'toString')).toBe(false);
        expect(parsed).not.toHaveProperty('oversized_namespace');
        expect(parsed).not.toHaveProperty('cyclic_namespace');
        expect(parsed).not.toHaveProperty('too_deep_namespace');
        expect(parsed).not.toHaveProperty('too_many_entries_namespace');
        expect(parsed).not.toHaveProperty('non_json_namespace');
    });
});
