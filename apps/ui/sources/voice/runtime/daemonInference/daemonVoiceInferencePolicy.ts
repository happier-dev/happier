import { Platform } from 'react-native';
import type { LocalNeuralExecution } from '@happier-dev/protocol';

import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';
import { getVoiceSessionSnapshot, useVoiceSessionStore } from '@/voice/session/voiceSessionStore';

import {
    resolveDaemonVoiceInferenceTtsLatencyBudgetMs,
    resolveDaemonVoiceInferenceTtsLatencyDemotionThreshold,
} from './daemonVoiceInferenceConfig';
import { createDaemonVoiceInferenceClientError } from './daemonVoiceInferenceErrors';

type DaemonVoiceInferenceLatencyState = {
    consecutiveOverBudgetCount: number;
    demoted: boolean;
};

type VoiceSessionLifecycleSnapshot = Readonly<{
    sessionId: string;
    status: string;
}>;

const latencyStateBySessionId = new Map<string, DaemonVoiceInferenceLatencyState>();
let latencyStateLifecycleSubscriptionStarted = false;

function getLatencyState(sessionId: string): DaemonVoiceInferenceLatencyState {
    const existing = latencyStateBySessionId.get(sessionId);
    if (existing) {
        return existing;
    }
    const next = {
        consecutiveOverBudgetCount: 0,
        demoted: false,
    };
    latencyStateBySessionId.set(sessionId, next);
    return next;
}

function normalizeSessionId(sessionId: string | null | undefined): string {
    return typeof sessionId === 'string' ? sessionId.trim() : '';
}

function toVoiceSessionLifecycleSnapshot(
    snapshot: Readonly<{ sessionId?: string | null; status?: string | null }> | null | undefined,
): VoiceSessionLifecycleSnapshot {
    return {
        sessionId: normalizeSessionId(snapshot?.sessionId),
        status: typeof snapshot?.status === 'string' ? snapshot.status : '',
    };
}

function ensureDaemonVoiceInferenceLatencyStateLifecycleSubscription(): void {
    if (latencyStateLifecycleSubscriptionStarted) {
        return;
    }
    latencyStateLifecycleSubscriptionStarted = true;

    let previousSnapshot = toVoiceSessionLifecycleSnapshot(getVoiceSessionSnapshot());
    useVoiceSessionStore.subscribe((nextState) => {
        const nextSnapshot = toVoiceSessionLifecycleSnapshot(nextState);
        const previousSessionId = previousSnapshot.sessionId;
        if (previousSessionId) {
            const sessionChanged = previousSessionId !== nextSnapshot.sessionId;
            const disconnected = previousSnapshot.status !== 'disconnected' && nextSnapshot.status === 'disconnected';
            if (sessionChanged || disconnected) {
                clearDaemonVoiceInferenceLatencyState(previousSessionId);
            }
        }
        previousSnapshot = nextSnapshot;
    });
}

export function recordDaemonVoiceInferenceTtsLatencySample(params: Readonly<{
    sessionId: string | null | undefined;
    elapsedMs: number;
}>): void {
    const sessionId = normalizeSessionId(params.sessionId);
    if (!sessionId) {
        return;
    }
    ensureDaemonVoiceInferenceLatencyStateLifecycleSubscription();
    const state = getLatencyState(sessionId);
    if (params.elapsedMs > resolveDaemonVoiceInferenceTtsLatencyBudgetMs()) {
        state.consecutiveOverBudgetCount += 1;
        if (state.consecutiveOverBudgetCount >= resolveDaemonVoiceInferenceTtsLatencyDemotionThreshold()) {
            state.demoted = true;
        }
        return;
    }
    state.consecutiveOverBudgetCount = 0;
}

export function clearDaemonVoiceInferenceLatencyState(sessionId?: string | null): void {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
        latencyStateBySessionId.clear();
        return;
    }
    latencyStateBySessionId.delete(normalizedSessionId);
}

function isDaemonVoiceInferenceTtsLatencyDemoted(sessionId: string | null | undefined): boolean {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
        return false;
    }
    return latencyStateBySessionId.get(normalizedSessionId)?.demoted === true;
}

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
    if ((params.surface ?? 'tts') === 'tts' && normalizeSessionId(params.sessionId)) {
        ensureDaemonVoiceInferenceLatencyStateLifecycleSubscription();
    }
    const executionPolicy = resolveLocalNeuralExecutionPolicy({
        requestedExecution: params.requestedExecution,
    });
    if (executionPolicy.requestedExecution === 'device') {
        return 'device';
    }

    if (
        executionPolicy.requestedExecution === 'auto'
        && executionPolicy.allowDeviceSelection
        && (params.surface ?? 'tts') === 'tts'
        && isDaemonVoiceInferenceTtsLatencyDemoted(params.sessionId)
    ) {
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
