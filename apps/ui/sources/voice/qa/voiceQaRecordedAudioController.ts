import { storage } from '@/sync/domains/state/storage';
import type { Settings } from '@/sync/domains/settings/settings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
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
            applySettingsLocal: (delta) => {
                const state = storage.getState();
                state.applySettingsLocal(
                    normalizeVoiceSettingsLocalDelta(delta, state.settings),
                );
            },
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

            const state = storage.getState();
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
