/**
 * Captured with the released/predecessor Voice parser, not reconstructed from
 * the current Voice types. The same source blob is present in the listed
 * released refs and in the inspected remote-dev worktree.
 *
 * `sourceBlob` is the provenance anchor and stays re-verifiable
 * (`git -C ../remote-dev hash-object <sourcePath>`).
 * `inspectedRemoteDevHead` is the capture-time sibling commit, not a claim
 * about that moving frontier's current HEAD; it advancing is expected and is
 * not vector staleness.
 *
 * Capture procedure: bundle the pinned `voiceSettings.ts`, execute its
 * `voiceSettingsParse` over a current-writer sidecar, then serialize the
 * returned value. A predecessor whole-object write serializes this same closed
 * shape. Plain and E2EE captures differ only at the legacy ElevenLabs apiKey.
 * This is source-vector provenance; it does not attest an EAS/OTA launch
 * artifact identity.
 */
export const PREDECESSOR_VOICE_VECTOR_PROVENANCE = {
    sourcePath: 'apps/ui/sources/sync/domains/settings/voiceSettings.ts',
    sourceBlob: '89eaf1dff3766e316f226970f970aa8fe24155cb',
    releasedRefs: [
        'dc5203145dea46a1280286eb74d90f20d8b9e817',
        '4913c1e533c872a0712ba1c25b3104fd470aacc2',
        'e25a74bcc6c7032e2ced52cefdbd60c53636900e',
    ],
    inspectedRemoteDevHead: 'cc456326037c778ea126b1ee3b6ebfe5d773239e',
} as const;

export type CapturedPredecessorCredentialMode = 'plain' | 'e2ee';

/** Exact persisted predecessor ids and their approved current identities. */
export const PREDECESSOR_VOICE_IDENTITY_VECTORS = Object.freeze([
    Object.freeze({
        predecessorProviderId: 'realtime_elevenlabs',
        contribution: Object.freeze({
            pluginId: 'happier.voice.elevenlabs',
            localId: 'realtime-elevenlabs',
        }),
    }),
    Object.freeze({
        predecessorProviderId: 'google_gemini',
        contribution: Object.freeze({
            pluginId: 'happier.voice.google',
            localId: 'gemini-stt',
        }),
    }),
    Object.freeze({
        predecessorProviderId: 'google_cloud',
        contribution: Object.freeze({
            pluginId: 'happier.voice.google',
            localId: 'google-cloud-tts',
        }),
    }),
] as const);

const capturedCredentialByMode = {
    plain: { _isSecretValue: true, value: 'xi-plain' },
    e2ee: {
        _isSecretValue: true,
        encryptedValue: { t: 'enc-v1', c: 'cipher-eleven' },
    },
} as const;

/** Exact closed Voice value returned and written by the pinned predecessor. */
export function capturedPredecessorVoice(
    mode: CapturedPredecessorCredentialMode,
): Record<string, unknown> {
    return {
        providerId: 'realtime_elevenlabs',
        assistantLanguage: 'de',
        ui: {
            scopeDefault: 'global',
            surfaceLocation: 'auto',
            activityFeedEnabled: false,
            activityFeedAutoExpandOnStart: false,
            updates: {
                activeSession: 'summaries',
                otherSessions: 'activity',
                snippetsMaxMessages: 3,
                includeUserMessagesInSnippets: false,
                otherSessionsSnippetsMode: 'on_demand_only',
            },
        },
        privacy: {
            shareSessionSummary: true,
            shareRecentMessages: true,
            recentMessagesCount: 3,
            shareToolNames: true,
            sharePermissionRequests: true,
            shareDeviceInventory: true,
            shareFilePaths: false,
            shareToolArgs: false,
        },
        adapters: {
            realtime_elevenlabs: {
                assistantLanguage: 'de',
                billingMode: 'byo',
                welcome: { enabled: false, mode: 'immediate', templateId: null },
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
                byo: {
                    agentId: 'agent-real',
                    apiKey: capturedCredentialByMode[mode],
                },
            },
            local_direct: {
                stt: {
                    provider: 'openai_compat',
                    openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                    googleGemini: {
                        apiKey: null,
                        model: 'gemini-2.5-flash',
                        language: null,
                    },
                    localNeural: {
                        assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                        language: null,
                    },
                },
                tts: {
                    provider: 'openai_compat',
                    openaiCompat: {
                        baseUrl: null,
                        apiKey: null,
                        model: 'tts-1',
                        voice: 'alloy',
                        format: 'mp3',
                    },
                    localNeural: {
                        model: 'kokoro',
                        assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                        voiceId: null,
                        speed: null,
                    },
                    googleCloud: {
                        apiKey: null,
                        androidCertSha1: null,
                        voiceName: null,
                        languageCode: null,
                        format: 'mp3',
                        speakingRate: null,
                        pitch: null,
                    },
                    autoSpeakReplies: true,
                    bargeInEnabled: true,
                },
                networkTimeoutMs: 15_000,
                handsFree: {
                    enabled: false,
                    endpointing: { silenceMs: 5_000, minSpeechMs: 1_000 },
                },
            },
            local_conversation: {
                conversationMode: 'direct_session',
                stt: {
                    provider: 'openai_compat',
                    openaiCompat: { baseUrl: null, apiKey: null, model: 'whisper-1' },
                    googleGemini: {
                        apiKey: null,
                        model: 'gemini-2.5-flash',
                        language: null,
                    },
                    localNeural: {
                        assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                        language: null,
                    },
                },
                tts: {
                    provider: 'openai_compat',
                    openaiCompat: {
                        baseUrl: null,
                        apiKey: null,
                        model: 'tts-1',
                        voice: 'alloy',
                        format: 'mp3',
                    },
                    localNeural: {
                        model: 'kokoro',
                        assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                        voiceId: null,
                        speed: null,
                    },
                    googleCloud: {
                        apiKey: null,
                        androidCertSha1: null,
                        voiceName: null,
                        languageCode: null,
                        format: 'mp3',
                        speakingRate: null,
                        pitch: null,
                    },
                    autoSpeakReplies: true,
                    bargeInEnabled: true,
                },
                networkTimeoutMs: 15_000,
                handsFree: {
                    enabled: false,
                    endpointing: { silenceMs: 5_000, minSpeechMs: 1_000 },
                },
                agent: {
                    backend: 'daemon',
                    agentSource: 'session',
                    agentId: 'claude',
                    machineTargetMode: 'auto',
                    machineTargetId: null,
                    autoTargetMachineId: null,
                    stayInVoiceHome: false,
                    teleportEnabled: true,
                    rootSessionPolicy: 'single',
                    maxWarmRoots: 3,
                    voiceHomeSubdirName: 'voice-agent',
                    permissionPolicy: 'read_only',
                    idleTtlSeconds: 1_800,
                    bootstrapTimeoutMs: 60_000,
                    prewarmOnConnect: true,
                    resumabilityMode: 'replay',
                    providerResume: { fallbackToReplay: true },
                    replay: { strategy: 'recent_messages', recentMessagesCount: 16 },
                    welcome: { enabled: false, mode: 'immediate', templateId: null },
                    commitIsolation: false,
                    transcript: { persistenceMode: 'ephemeral', epoch: 0 },
                    chatModelSource: 'custom',
                    chatModelId: 'default',
                    commitModelSource: 'chat',
                    commitModelId: 'default',
                    openaiCompat: {
                        chatBaseUrl: null,
                        chatApiKey: null,
                        chatModel: 'default',
                        commitModel: 'default',
                        temperature: 0.4,
                        maxTokens: null,
                    },
                    verbosity: 'short',
                },
                streaming: {
                    enabled: true,
                    ttsEnabled: true,
                    ttsChunkChars: 200,
                    turnReadPollIntervalMs: 25,
                    turnReadMaxEvents: 64,
                    turnStreamTimeoutMs: 1_800_000,
                },
            },
        },
    };
}
