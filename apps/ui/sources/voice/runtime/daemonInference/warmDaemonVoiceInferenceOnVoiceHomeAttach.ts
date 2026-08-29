import {
    DaemonVoiceInferenceModelsWarmResponseSchema,
    VOICE_RUNTIME_WARM_DEFAULTS,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { resolveVoiceHomeDaemonMachineId } from '@/voice/persistence/voiceConversationSession';
import {
    parseLocalVoiceSttSettings,
    parseLocalVoiceTtsSettings,
    resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import { resolveKokoroDaemonTtsPackId } from '@/voice/kokoro/assets/resolveKokoroDaemonTtsPackId';

import { createDaemonVoiceInferenceClientError } from './daemonVoiceInferenceErrors';
import { resolveDaemonVoiceInferenceExecution } from './daemonVoiceInferencePolicy';

export type WarmDaemonVoiceInferenceOnVoiceHomeAttachDeps = Readonly<{
    warmModels: (packIds: readonly string[], signal?: AbortSignal | null) => Promise<void>;
}>;

export type WarmDaemonVoiceInferenceOnVoiceHomeAttachParams = Readonly<{
    settings: any;
    sessionId?: string | null;
    warmModels?: (packIds: readonly string[], signal?: AbortSignal | null) => Promise<void>;
    signal?: AbortSignal | null;
}>;

async function warmDaemonVoiceInferenceModels(
    packIds: readonly string[],
    signal?: AbortSignal | null,
): Promise<void> {
    const machineId = resolveVoiceHomeDaemonMachineId();
    if (!machineId) {
        return;
    }

    const parsed = DaemonVoiceInferenceModelsWarmResponseSchema.safeParse(
        await machineRpcWithServerScope({
            machineId,
            method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM,
            payload: { packIds },
            timeoutMs: VOICE_RUNTIME_WARM_DEFAULTS.warmRequestTimeoutMs,
            ...(signal ? { signal } : {}),
        }),
    );
    if (!parsed.success) {
        throw createDaemonVoiceInferenceClientError(
            'internal_error',
            'daemon_voice_inference_invalid_response',
        );
    }
    if (!parsed.data.ok) {
        throw createDaemonVoiceInferenceClientError(
            parsed.data.errorCode,
            parsed.data.error,
        );
    }
}

async function resolveWarmPackIds(params: Readonly<{
    settings: any;
    sessionId?: string | null;
}>): Promise<readonly string[]> {
    const { config } = resolveLocalVoiceAdapterSettings(params.settings);
    const packIds: string[] = [];

    const tts = parseLocalVoiceTtsSettings(config?.tts);
    if (tts.provider === 'local_neural' && tts.localNeural.model === 'kokoro') {
        const execution = await resolveDaemonVoiceInferenceExecution({
            requestedExecution: tts.localNeural.execution,
            sessionId: params.sessionId ?? null,
            surface: 'tts',
        });
        if (execution === 'daemon') {
            packIds.push(resolveKokoroDaemonTtsPackId(tts.localNeural.assetId));
        }
    }

    const stt = parseLocalVoiceSttSettings(config?.stt);
    if (stt.provider === 'local_neural') {
        const execution = await resolveDaemonVoiceInferenceExecution({
            requestedExecution: stt.localNeural.execution,
            sessionId: params.sessionId ?? null,
            surface: 'stt',
        });
        if (execution === 'daemon') {
            const packId = typeof stt.localNeural.assetId === 'string' ? stt.localNeural.assetId.trim() : '';
            if (packId) {
                packIds.push(packId);
            }
        }
    }

    return [...new Set(packIds)];
}

export async function warmDaemonVoiceInferenceOnVoiceHomeAttach(
    params: WarmDaemonVoiceInferenceOnVoiceHomeAttachParams,
): Promise<void> {
    const warmModels = params.warmModels ?? warmDaemonVoiceInferenceModels;
    const packIds = await resolveWarmPackIds({
        settings: params.settings,
        sessionId: params.sessionId ?? null,
    });
    if (packIds.length === 0) {
        return;
    }

    await warmModels(packIds, params.signal);
}
