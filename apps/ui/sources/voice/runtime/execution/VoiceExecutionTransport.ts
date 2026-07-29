import { DaemonVoiceAgentClient } from '@/voice/agent/daemonVoiceAgentClient';
import { initializeVoiceAgentHandle } from '@/voice/agent/initializeVoiceAgentHandle';
import { OpenAiCompatVoiceAgentClient } from '@/voice/agent/openaiCompatVoiceAgentClient';
import type { VoiceAgentHandle, VoiceAgentSendTurnOptions } from '@/voice/agent/types';
import type { VoiceAssistantAction } from '@happier-dev/protocol';
import { clearRetainedLocalVoiceEffectOutcomes } from '@/voice/tools/localVoiceEffectOutcomeCustody';

import { createVoiceRunRecovery } from './voiceRunRecovery';
import { createVoiceTurnStreaming } from './voiceTurnStreaming';
import { createVoiceWelcomePolicy } from './voiceWelcomePolicy';

export type VoiceExecutionTransport = Readonly<{
    appendContextUpdate: (sessionId: string, update: string) => void;
    commitUserTranscript: (sessionId: string, text: string, localId: string) => Promise<void>;
    commit: (sessionId: string) => Promise<string>;
    ensureRunning: (sessionId: string) => Promise<void>;
    ensureRunningAndMaybeWelcome: (sessionId: string) => Promise<string | null>;
    isActive: (sessionId: string) => boolean;
    sendInterruptingTextUpdate: (
        sessionId: string,
        update: string,
        options?: VoiceAgentSendTurnOptions,
    ) => Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>>;
    sendTextUpdate: (
        sessionId: string,
        update: string,
    ) => Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>>;
    sendTurn: (
        sessionId: string,
        userText: string,
        options?: VoiceAgentSendTurnOptions,
    ) => Promise<Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>>;
    stop: (sessionId: string) => Promise<void>;
}>;

export function createVoiceExecutionTransport(): VoiceExecutionTransport {
    const voiceAgentBySessionId = new Map<string, VoiceAgentHandle>();
    const voiceAgentInitBySessionId = new Map<string, Promise<VoiceAgentHandle>>();
    const voiceAgentPendingContextBySessionId = new Map<string, string[]>();
    const voiceAgentTurnBarrierBySessionId = new Map<string, Promise<void>>();
    const voiceAgentTurnAbortControllerBySessionId = new Map<string, AbortController>();

    let openaiCompatVoiceAgentClient: OpenAiCompatVoiceAgentClient | null = null;
    let daemonVoiceAgentClient: DaemonVoiceAgentClient | null = null;

    const runSerializedTurn = async <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
        const previousBarrier = voiceAgentTurnBarrierBySessionId.get(sessionId) ?? Promise.resolve();
        const taskPromise = previousBarrier.catch(() => undefined).then(task);
        const nextBarrier = taskPromise.then(() => undefined, () => undefined);
        voiceAgentTurnBarrierBySessionId.set(sessionId, nextBarrier);

        try {
            return await taskPromise;
        } finally {
            if (voiceAgentTurnBarrierBySessionId.get(sessionId) === nextBarrier) {
                voiceAgentTurnBarrierBySessionId.delete(sessionId);
            }
        }
    };

    const interruptActiveTurn = (sessionId: string): void => {
        const controller = voiceAgentTurnAbortControllerBySessionId.get(sessionId);
        if (!controller) return;
        try {
            controller.abort();
        } catch {
            // ignore
        }
    };

    const recovery = createVoiceRunRecovery({
        createHandle: (sessionId: string) =>
            initializeVoiceAgentHandle({
                sessionId,
                getDaemonVoiceAgentClient: () => {
                    daemonVoiceAgentClient ??= new DaemonVoiceAgentClient();
                    return daemonVoiceAgentClient;
                },
                getOpenAiCompatVoiceAgentClient: () => {
                    openaiCompatVoiceAgentClient ??= new OpenAiCompatVoiceAgentClient();
                    return openaiCompatVoiceAgentClient;
                },
                enqueuePendingContextUpdate: (pendingSessionId, update) => {
                    const existingPendingContext = voiceAgentPendingContextBySessionId.get(pendingSessionId) ?? [];
                    existingPendingContext.push(update);
                    voiceAgentPendingContextBySessionId.set(
                        pendingSessionId,
                        existingPendingContext.slice(Math.max(0, existingPendingContext.length - 8)),
                    );
                },
            }),
        voiceAgentBySessionId,
        voiceAgentInitBySessionId,
        voiceAgentPendingContextBySessionId,
    });

    const welcomePolicy = createVoiceWelcomePolicy({
        getVoiceAgentHandle: recovery.getVoiceAgentHandle,
        resetCachedHandle: recovery.resetCachedHandle,
    });

    const turnStreaming = createVoiceTurnStreaming({
        getVoiceAgentHandle: recovery.getVoiceAgentHandle,
        interruptActiveTurn,
        resetCachedHandle: recovery.resetCachedHandle,
        runSerializedTurn,
        stop: recovery.stop,
        voiceAgentPendingContextBySessionId,
        voiceAgentTurnAbortControllerBySessionId,
    });

    const stop = async (sessionId: string): Promise<void> => {
        interruptActiveTurn(sessionId);
        await runSerializedTurn(sessionId, async () => {
            try {
                await recovery.stop(sessionId);
            } finally {
                clearRetainedLocalVoiceEffectOutcomes(sessionId);
            }
        });
    };

    const commitUserTranscript = async (sessionId: string, text: string, localId: string): Promise<void> => {
        const handle = await recovery.getVoiceAgentHandle(sessionId);
        if (!handle.client.commitUserTranscript) {
            throw new Error('voice_user_transcript_commit_required');
        }
        await handle.client.commitUserTranscript({
            sessionId: handle.rpcSessionId,
            voiceAgentId: handle.voiceAgentId,
            text,
            localId,
        });
    };

    return {
        appendContextUpdate: recovery.appendContextUpdate,
        commitUserTranscript,
        commit: recovery.commit,
        ensureRunning: recovery.ensureRunning,
        ensureRunningAndMaybeWelcome: welcomePolicy.ensureRunningAndMaybeWelcome,
        isActive: recovery.isActive,
        sendInterruptingTextUpdate: turnStreaming.sendInterruptingTextUpdate,
        sendTextUpdate: turnStreaming.sendTextUpdate,
        sendTurn: turnStreaming.sendTurn,
        stop,
    };
}
