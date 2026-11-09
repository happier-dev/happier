import { Platform } from 'react-native';
import type { LocalNeuralExecution } from '@happier-dev/protocol/daemon/voiceInference';

import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';
import { createDaemonVoiceInferenceClientError } from './daemonVoiceInferenceErrors';

export type LocalNeuralExecutionPolicy = Readonly<{
    allowDeviceSelection: boolean;
    preferredExecution: 'device' | 'daemon';
    requestedExecution: LocalNeuralExecution;
    selectableExecution: LocalNeuralExecution;
}>;

export function resolveLocalNeuralExecutionPolicy(params: Readonly<{
    requestedExecution: LocalNeuralExecution | null | undefined;
    platformOs?: string;
}>): LocalNeuralExecutionPolicy {
    const platformOs = params.platformOs ?? Platform.OS;
    const requestedExecution = params.requestedExecution ?? 'auto';
    const selectableExecution = requestedExecution;
    const preferredExecution = selectableExecution === 'auto'
        ? platformOs === 'web'
            ? 'daemon'
            : 'device'
        : selectableExecution;

    return {
        allowDeviceSelection: platformOs !== 'web',
        preferredExecution,
        requestedExecution,
        selectableExecution,
    };
}

export async function resolveDaemonVoiceInferenceExecution(params: Readonly<{
    requestedExecution: LocalNeuralExecution | null | undefined;
    sessionId?: string | null;
    surface?: 'tts' | 'stt';
}>): Promise<'device' | 'daemon'> {
    const executionPolicy = resolveLocalNeuralExecutionPolicy({
        requestedExecution: params.requestedExecution,
    });
    if (executionPolicy.requestedExecution === 'device') {
        return 'device';
    }

    if (executionPolicy.preferredExecution === 'device') {
        return 'device';
    }

    let daemonInferenceEnabled: boolean;
    try {
        daemonInferenceEnabled = await isRuntimeFeatureEnabled({
            featureId: 'voice.daemonInference',
        });
    } catch {
        throw createDaemonVoiceInferenceClientError(
            'internal_error',
            'daemon_voice_inference_feature_probe_failed',
        );
    }
    if (!daemonInferenceEnabled) {
        throw createDaemonVoiceInferenceClientError('feature_disabled');
    }

    return 'daemon';
}
