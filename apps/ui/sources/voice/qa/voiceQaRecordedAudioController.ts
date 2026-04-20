import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import type { Machine, MachineMetadata, Metadata, Session } from '@/sync/domains/state/storageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import { prepareDaemonVoiceInferenceSttSource } from '@/voice/input/prepareDaemonVoiceInferenceSttSource';
import { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import { DaemonSttController } from '@/voice/runtime/daemonInference/DaemonSttController';
import { recordedAudioTranscriptionController } from '@/voice/runtime/input/recordedAudioTranscriptionController';

import { normalizeVoiceQaText } from './voiceQaSessionResolution';

const DEFAULT_RECORDED_AUDIO_DAEMON_STT_LANGUAGE = 'en';

export type VoiceQaRecordedAudioTranscriptionRequest = Readonly<{
    sessionId: string;
    uri: string;
    packId: string;
    machineId: string;
    basePath: string;
    webFile?: File | null;
}>;

type VoiceQaRecordedAudioState = Readonly<{
    settings: Settings;
    sessions: Record<string, Session>;
    machines: Record<string, Machine>;
}> & {
    applySettingsLocal: (delta: Partial<Settings>) => void;
    applySessions: (sessions: Session[]) => void;
    applyMachines: (machines: Machine[]) => void;
};

function buildRecordedAudioQaSessionMetadata(existingMetadata: Metadata | null, params: Readonly<{ machineId: string; basePath: string }>): Metadata {
    return {
        ...(existingMetadata ?? {}),
        host: 'voice-qa',
        machineId: params.machineId,
        path: params.basePath,
        name: 'Recorded audio daemon STT target',
    };
}

function buildRecordedAudioQaMachineMetadata(existingMetadata: MachineMetadata | null): MachineMetadata {
    return {
        ...(existingMetadata ?? {
            host: 'voice-qa',
            platform: 'unknown',
            happyCliVersion: '0.0.0',
            happyHomeDir: '',
            homeDir: '',
        }),
        host: 'voice-qa',
        platform: existingMetadata?.platform ?? 'unknown',
        happyCliVersion: existingMetadata?.happyCliVersion ?? '0.0.0',
        happyHomeDir: existingMetadata?.happyHomeDir ?? '',
        homeDir: existingMetadata?.homeDir ?? '',
    };
}

function buildRecordedAudioQaSession(
    state: VoiceQaRecordedAudioState,
    params: Readonly<{ sessionId: string; machineId: string; basePath: string }>,
    now: number,
): Session {
    const existingSession = state.sessions[params.sessionId] ?? null;
    const activeServerId = normalizeVoiceQaText(getActiveServerSnapshot().serverId);
    const nextServerId = activeServerId || normalizeVoiceQaText(existingSession?.serverId) || undefined;

    return {
        ...(existingSession ?? {
            id: params.sessionId,
            seq: 0,
            createdAt: now,
            updatedAt: now,
            active: true,
            activeAt: now,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        }),
        id: params.sessionId,
        serverId: nextServerId,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: buildRecordedAudioQaSessionMetadata(existingSession?.metadata ?? null, params),
        metadataVersion: existingSession?.metadataVersion ?? 1,
        agentState: existingSession?.agentState ?? null,
        agentStateVersion: existingSession?.agentStateVersion ?? 0,
        thinking: existingSession?.thinking ?? false,
        thinkingAt: existingSession?.thinkingAt ?? 0,
        presence: 'online',
    };
}

function buildRecordedAudioQaMachine(
    state: VoiceQaRecordedAudioState,
    params: Readonly<{ machineId: string }>,
    now: number,
): Machine {
    const existingMachine = state.machines[params.machineId] ?? null;
    return {
        ...(existingMachine ?? {
            id: params.machineId,
            seq: 0,
            createdAt: now,
            updatedAt: now,
            active: true,
            activeAt: now,
            metadata: null,
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
        }),
        id: params.machineId,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: buildRecordedAudioQaMachineMetadata(existingMachine?.metadata ?? null),
        metadataVersion: existingMachine?.metadataVersion ?? 1,
        daemonState: existingMachine?.daemonState ?? null,
        daemonStateVersion: existingMachine?.daemonStateVersion ?? 0,
    };
}

function primeRecordedAudioQaState(
    state: VoiceQaRecordedAudioState,
    params: Readonly<{
        sessionId: string;
        machineId: string;
        basePath: string;
    }>,
): void {
    const now = Date.now();
    state.applySessions([
        buildRecordedAudioQaSession(state, params, now),
    ]);
    state.applyMachines([
        buildRecordedAudioQaMachine(state, params, now),
    ]);
}

function primeRecordedAudioQaSettings(state: VoiceQaRecordedAudioState, packId: string): void {
    const currentSettings = state.settings;
    const currentVoice = currentSettings.voice ?? null;
    const currentAdapters = currentVoice?.adapters ?? {};
    const currentConversation = currentAdapters.local_conversation ?? null;
    const currentStt = currentConversation?.stt ?? null;

    state.applySettingsLocal({
        experiments: true,
        featureToggles: {
            ...(currentSettings.featureToggles ?? {}),
            voice: true,
            'execution.runs': true,
            'voice.agent': true,
            'voice.daemonInference': true,
        },
        voice: {
            ...(currentVoice ?? {}),
            providerId: 'local_conversation',
            assistantLanguage: DEFAULT_RECORDED_AUDIO_DAEMON_STT_LANGUAGE,
            adapters: {
                ...currentAdapters,
                local_conversation: {
                    ...(currentConversation ?? {}),
                    conversationMode: 'agent',
                    networkTimeoutMs: currentConversation?.networkTimeoutMs ?? 15_000,
                    stt: {
                        ...(currentStt ?? {}),
                        provider: 'local_neural',
                        openaiCompat: currentStt?.openaiCompat ?? { baseUrl: null, apiKey: null, model: 'whisper-1' },
                        googleGemini: currentStt?.googleGemini ?? { apiKey: null, model: 'gemini-2.5-flash', language: null },
                        localNeural: {
                            ...(currentStt?.localNeural ?? {}),
                            assetId: packId,
                            language: DEFAULT_RECORDED_AUDIO_DAEMON_STT_LANGUAGE,
                            execution: 'daemon',
                        },
                    },
                },
            },
        },
    });
}

async function transcribeRecordedAudioWithExplicitDaemonQaTarget(
    params: Readonly<{
        sessionId: string;
        uri: string;
        packId: string;
        machineId: string;
        basePath: string;
        webFile?: File | null;
    }>,
): Promise<string | null> {
    const preparedSource = params.webFile
        ? {
            source: {
                kind: 'web' as const,
                file: params.webFile,
            },
            inputMimeType: params.webFile.type || 'audio/wav',
            normalization: {
                inputTransport: 'upload_transfer' as const,
                strategy: 'ui_pretranscoded_pcm16_fallback' as const,
                systemFfmpegAllowed: false as const,
            },
        }
        : await prepareDaemonVoiceInferenceSttSource({
            uri: params.uri,
        });

    const transcription = await new DaemonSttController({
        client: new DaemonVoiceInferenceClient({
            isRuntimeFeatureEnabled: async () => true,
            readMachineTargetForSession: (sessionId) => {
                if (normalizeVoiceQaText(sessionId) !== normalizeVoiceQaText(params.sessionId)) {
                    return null;
                }
                return {
                    machineId: params.machineId,
                    basePath: params.basePath,
                };
            },
        }),
    }).transcribeRecordedAudio({
        sessionId: params.sessionId,
        source: preparedSource.source,
        inputMimeType: preparedSource.inputMimeType,
        packId: params.packId,
        language: DEFAULT_RECORDED_AUDIO_DAEMON_STT_LANGUAGE,
        normalization: preparedSource.normalization,
    });

    return transcription.text.trim() || null;
}

export const voiceQaRecordedAudioController = {
    transcribe: async (params: VoiceQaRecordedAudioTranscriptionRequest): Promise<string | null> => {
        const sessionId = normalizeVoiceQaText(params.sessionId);
        const machineId = normalizeVoiceQaText(params.machineId);
        const basePath = normalizeVoiceQaText(params.basePath);
        const packId = normalizeVoiceQaText(params.packId);

        if (sessionId && machineId && basePath) {
            primeRecordedAudioQaState(storage.getState() as VoiceQaRecordedAudioState, {
                sessionId,
                machineId,
                basePath,
            });
        }
        if (packId) {
            primeRecordedAudioQaSettings(storage.getState() as VoiceQaRecordedAudioState, packId);
        }

        const transcription = await recordedAudioTranscriptionController.transcribe({
            sessionId: params.sessionId,
            uri: params.uri,
            settings: storage.getState().settings,
        });
        if (transcription) {
            return transcription;
        }

        if (sessionId && machineId && basePath && packId) {
            return await transcribeRecordedAudioWithExplicitDaemonQaTarget({
                sessionId,
                uri: params.uri,
                packId,
                machineId,
                basePath,
                webFile: params.webFile ?? null,
            });
        }

        return null;
    },
};
