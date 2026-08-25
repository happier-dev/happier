import { DaemonVoiceAgentClient } from '@/voice/agent/daemonVoiceAgentClient';
import { initializeVoiceAgentHandle } from '@/voice/agent/initializeVoiceAgentHandle';
import type { VoiceAgentHandle, VoiceAgentSendTurnOptions } from '@/voice/agent/types';
import type { VoiceAssistantAction } from '@happier-dev/protocol';
import { clearRetainedLocalVoiceEffectOutcomes } from '@/voice/tools/localVoiceEffectOutcomeCustody';

import { createVoiceRunRecovery } from './voiceRunRecovery';
import { createVoiceTurnStreaming } from './voiceTurnStreaming';
import { createVoiceWelcomePolicy } from './voiceWelcomePolicy';

export type VoiceExecutionTransport = Readonly<{
    appendContextUpdate: (sessionId: string, update: string) => void;
    appendAutomaticUiContextUpdate: (sessionId: string, update: string) => void;
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
    const voiceAgentPendingSessionContextBySessionId = new Map<string, string[]>();
    // A null entry records that this attempt has already admitted its deferred
    // target context, so a recovered handle cannot queue it for the next turn.
    const deferredTargetSessionContextBySessionId = new Map<string, string | null>();
    const latestAutomaticUiContextBySessionId = new Map<string, string>();
    const voiceAgentActiveTurnSettlementsBySessionId = new Map<string, Set<Promise<void>>>();
    const voiceAgentTurnAbortControllerBySessionId = new Map<string, AbortController>();
    const voiceAgentStopPromiseBySessionId = new Map<string, Promise<void>>();

    let daemonVoiceAgentClient: DaemonVoiceAgentClient | null = null;

    const trackActiveTurn = async <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
        let turn: Promise<T>;
        try {
            turn = task();
        } catch (error) {
            turn = Promise.reject(error);
        }
        const settlement = turn.then(() => undefined, () => undefined);
        const activeTurns = voiceAgentActiveTurnSettlementsBySessionId.get(sessionId) ?? new Set<Promise<void>>();
        activeTurns.add(settlement);
        voiceAgentActiveTurnSettlementsBySessionId.set(sessionId, activeTurns);
        try {
            return await turn;
        } finally {
            activeTurns.delete(settlement);
            if (activeTurns.size === 0 && voiceAgentActiveTurnSettlementsBySessionId.get(sessionId) === activeTurns) {
                voiceAgentActiveTurnSettlementsBySessionId.delete(sessionId);
            }
        }
    };

    const waitForActiveTurns = async (sessionId: string): Promise<void> => {
        const activeTurns = voiceAgentActiveTurnSettlementsBySessionId.get(sessionId);
        await Promise.all(activeTurns ? [...activeTurns] : []);
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
                setDeferredTargetSessionContext: (pendingSessionId, update) => {
                    const text = update.trim();
                    if (!text) return;
                    if (deferredTargetSessionContextBySessionId.get(pendingSessionId) === null) return;
                    deferredTargetSessionContextBySessionId.set(pendingSessionId, text);
                },
            }),
        voiceAgentBySessionId,
        voiceAgentInitBySessionId,
        voiceAgentPendingSessionContextBySessionId,
        deferredTargetSessionContextBySessionId,
        latestAutomaticUiContextBySessionId,
    });

    const welcomePolicy = createVoiceWelcomePolicy({
        getVoiceAgentHandle: recovery.getVoiceAgentHandle,
        resetCachedHandle: recovery.resetCachedHandle,
    });

    const turnStreaming = createVoiceTurnStreaming({
        getVoiceAgentHandle: recovery.getVoiceAgentHandle,
        interruptActiveTurn,
        resetCachedHandle: recovery.resetCachedHandle,
        trackActiveTurn,
        voiceAgentPendingSessionContextBySessionId,
        deferredTargetSessionContextBySessionId,
        latestAutomaticUiContextBySessionId,
        voiceAgentTurnAbortControllerBySessionId,
    });

    const stop = (sessionId: string): Promise<void> => {
        const existingStop = voiceAgentStopPromiseBySessionId.get(sessionId);
        if (existingStop) return existingStop;

        interruptActiveTurn(sessionId);
        const stopPromise = (async () => {
            await waitForActiveTurns(sessionId);
            try {
                await recovery.stop(sessionId);
            } finally {
                clearRetainedLocalVoiceEffectOutcomes(sessionId);
            }
        })();
        voiceAgentStopPromiseBySessionId.set(sessionId, stopPromise);
        void stopPromise.then(
            () => {
                if (voiceAgentStopPromiseBySessionId.get(sessionId) === stopPromise) {
                    voiceAgentStopPromiseBySessionId.delete(sessionId);
                }
            },
            () => {
                if (voiceAgentStopPromiseBySessionId.get(sessionId) === stopPromise) {
                    voiceAgentStopPromiseBySessionId.delete(sessionId);
                }
            },
        );
        return stopPromise;
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
        appendAutomaticUiContextUpdate: recovery.appendAutomaticUiContextUpdate,
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
