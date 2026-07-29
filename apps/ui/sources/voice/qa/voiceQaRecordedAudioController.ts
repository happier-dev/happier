import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storage';
import type { Machine, MachineMetadata, Metadata, Session } from '@/sync/domains/state/storageTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
    readLocalConversationVoiceSettings,
    voiceSettingsParse,
    writeLocalConversationVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import { prepareDaemonVoiceInferenceSttSource } from '@/voice/input/prepareDaemonVoiceInferenceSttSource';
import {
    DaemonVoiceInferenceClient,
    type DaemonVoiceInferenceClientDeps,
} from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import { DaemonSttController } from '@/voice/runtime/daemonInference/DaemonSttController';
import { recordedAudioTranscriptionController } from '@/voice/runtime/input/recordedAudioTranscriptionController';

import { normalizeVoiceQaText } from './voiceQaSessionResolution';
import {
    createVoiceQaTemporarySettingsScopeCoordinator,
    type VoiceQaTemporarySettingsScopeCoordinator,
} from './voiceQaTemporarySettingsScope';

const DEFAULT_RECORDED_AUDIO_DAEMON_STT_LANGUAGE = 'en';

export type VoiceQaRecordedAudioTranscriptionRequest = Readonly<{
    sessionId: string;
    uri: string;
    packId: string;
    machineId: string;
    basePath: string;
    webFile?: File | null;
    settingsScopeOwnerId?: string | null;
    signal?: AbortSignal | null;
}>;

export type VoiceQaRecordedAudioController = Readonly<{
    transcribe: (params: VoiceQaRecordedAudioTranscriptionRequest) => Promise<string | null>;
    releaseTemporarySettingsForOwner: (ownerId: string) => void;
}>;

export type VoiceQaRecordedAudioTranscriptionMode = 'explicit_daemon' | 'configured_runtime';

export function resolveRecordedAudioQaTranscriptionMode(params: Readonly<{
    sessionId: string;
    machineId: string;
    basePath: string;
    packId: string;
}>): VoiceQaRecordedAudioTranscriptionMode {
    return normalizeVoiceQaText(params.sessionId)
        && normalizeVoiceQaText(params.machineId)
        && normalizeVoiceQaText(params.basePath)
        && normalizeVoiceQaText(params.packId)
        ? 'explicit_daemon'
        : 'configured_runtime';
}

export function createRecordedAudioQaDaemonMachineResolver(params: Readonly<{
    machineId: string;
}>): Readonly<{
    resolveVoiceHomeDaemonMachineId: () => string;
}> {
    return {
        resolveVoiceHomeDaemonMachineId: () => params.machineId,
    };
}

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
    const executionMetadata = buildRecordedAudioQaSessionMetadata(
        existingSession ? readSessionOwnerMetadataView(existingSession) : null,
        params,
    );

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
        ...(existingSession?.metadataLayoutVersion === 1
            ? {
                metadata: existingSession.metadata,
                ownerMetadataView: executionMetadata,
            }
            : { metadata: executionMetadata }),
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

function buildRecordedAudioQaSettingsDelta(currentSettings: Settings, packId: string): Partial<Settings> {
    const currentVoice = voiceSettingsParse(currentSettings.voice);
    const currentConversation = readLocalConversationVoiceSettings(currentVoice);
    const currentStt = currentConversation.stt;
    const nextVoice = writeLocalConversationVoiceSettings(
        voiceSettingsParse({
            ...currentVoice,
            providerId: 'local_conversation',
            assistantLanguage: DEFAULT_RECORDED_AUDIO_DAEMON_STT_LANGUAGE,
        }),
        {
            ...currentConversation,
            conversationMode: 'agent',
            networkTimeoutMs: currentConversation.networkTimeoutMs ?? 15_000,
            stt: {
                ...currentStt,
                provider: 'local_neural',
                openaiCompat: currentStt.openaiCompat ?? { baseUrl: null, apiKey: null, model: 'whisper-1' },
                localNeural: {
                    ...currentStt.localNeural,
                    assetId: packId,
                    language: DEFAULT_RECORDED_AUDIO_DAEMON_STT_LANGUAGE,
                    execution: 'daemon',
                },
            },
        },
    );

    return {
        experiments: true,
        featureToggles: {
            ...(currentSettings.featureToggles ?? {}),
            voice: true,
            'execution.runs': true,
            'voice.agent': true,
            'voice.daemonInference': true,
        },
        voice: nextVoice,
    };
}

async function transcribeRecordedAudioWithExplicitDaemonQaTarget(
    params: Readonly<{
        sessionId: string;
        uri: string;
        packId: string;
        machineId: string;
        basePath: string;
        webFile?: File | null;
        signal?: AbortSignal | null;
    }>,
    daemonClientDeps?: Partial<DaemonVoiceInferenceClientDeps>,
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
            ...daemonClientDeps,
            isRuntimeFeatureEnabled: async () => true,
            ...createRecordedAudioQaDaemonMachineResolver(params),
        }),
    }).transcribeRecordedAudio({
        sessionId: params.sessionId,
        source: preparedSource.source,
        inputMimeType: preparedSource.inputMimeType,
        packId: params.packId,
        language: DEFAULT_RECORDED_AUDIO_DAEMON_STT_LANGUAGE,
        normalization: preparedSource.normalization,
        signal: params.signal ?? null,
    });

    return transcription.text.trim() || null;
}

export function createVoiceQaRecordedAudioController(options?: Readonly<{
    daemonClientDeps?: Partial<DaemonVoiceInferenceClientDeps>;
    settingsScopeCoordinator?: VoiceQaTemporarySettingsScopeCoordinator;
}>): VoiceQaRecordedAudioController {
    const settingsScopeCoordinator = options?.settingsScopeCoordinator
        ?? createVoiceQaTemporarySettingsScopeCoordinator({
            readSettings: () => storage.getState().settings,
            applySettingsLocal: (delta) => storage.getState().applySettingsLocal(delta),
        });

    const transcribeConfiguredRuntime = async (params: VoiceQaRecordedAudioTranscriptionRequest): Promise<string | null> => {
        const transcription = await recordedAudioTranscriptionController.transcribe({
            sessionId: params.sessionId,
            uri: params.uri,
            settings: storage.getState().settings,
        });
        return transcription || null;
    };

    return {
        transcribe: async (params): Promise<string | null> => {
            const sessionId = normalizeVoiceQaText(params.sessionId);
            const machineId = normalizeVoiceQaText(params.machineId);
            const basePath = normalizeVoiceQaText(params.basePath);
            const packId = normalizeVoiceQaText(params.packId);
            const mode = resolveRecordedAudioQaTranscriptionMode({ sessionId, machineId, basePath, packId });

            if (sessionId && machineId && basePath) {
                primeRecordedAudioQaState(storage.getState() as VoiceQaRecordedAudioState, {
                    sessionId,
                    machineId,
                    basePath,
                });
            }

            if (mode === 'explicit_daemon') {
                return await transcribeRecordedAudioWithExplicitDaemonQaTarget({
                    sessionId,
                    uri: params.uri,
                    packId,
                    machineId,
                    basePath,
                    webFile: params.webFile ?? null,
                    signal: params.signal ?? null,
                }, options?.daemonClientDeps);
            }

            if (!packId) {
                return await transcribeConfiguredRuntime(params);
            }

            const state = storage.getState() as VoiceQaRecordedAudioState;
            return await settingsScopeCoordinator.run({
                ownerId: normalizeVoiceQaText(params.settingsScopeOwnerId) || 'voiceQaRecordedAudioController',
                delta: buildRecordedAudioQaSettingsDelta(state.settings, packId),
                signal: params.signal ?? null,
            }, async () => await transcribeConfiguredRuntime(params));
        },
        releaseTemporarySettingsForOwner: (ownerId) => {
            settingsScopeCoordinator.releaseOwner(ownerId);
        },
    };
}

export const voiceQaRecordedAudioController = createVoiceQaRecordedAudioController();
