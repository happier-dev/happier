import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { ensureVoiceConversationSessionForVoiceHome } from '@/voice/persistence/voiceConversationSession';
import {
    parseLocalVoiceSttSettings,
    parseLocalVoiceTtsSettings,
    resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import { resolveKokoroDaemonTtsPackId } from '@/voice/kokoro/assets/resolveKokoroDaemonTtsPackId';

import { resolveDaemonVoiceInferenceExecution } from './daemonVoiceInferencePolicy';

export type WarmDaemonVoiceInferenceOnVoiceHomeAttachDeps = Readonly<{
    warmModels: (packIds: readonly string[]) => Promise<void>;
}>;

export type WarmDaemonVoiceInferenceOnVoiceHomeAttachParams = Readonly<{
    settings: any;
    sessionId?: string | null;
    warmModels?: (packIds: readonly string[]) => Promise<void>;
}>;

async function warmDaemonVoiceInferenceModels(packIds: readonly string[]): Promise<void> {
    const sessionId = await ensureVoiceConversationSessionForVoiceHome();
    const machineTarget = readMachineTargetForSession(sessionId);
    if (!machineTarget?.machineId) {
        return;
    }

    await machineRpcWithServerScope({
        machineId: machineTarget.machineId,
        method: RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM,
        payload: { packIds },
    });
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

    await warmModels(packIds);
}
