import { DaemonVoiceAgentClient } from '@/voice/agent/daemonVoiceAgentClient';
import { initializeVoiceAgentHandle } from '@/voice/agent/initializeVoiceAgentHandle';
import type { VoiceAgentHandle, VoiceAgentSendTurnOptions } from '@/voice/agent/types';
import type { VoiceAssistantAction } from '@happier-dev/protocol';
import { clearRetainedLocalVoiceEffectOutcomes } from '@/voice/tools/localVoiceEffectOutcomeCustody';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createAbortRacer } from '@/voice/agent/voiceAgentAbort';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import type { BackendTargetRefV1 } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { readLocalConversationSettingsFromAccountSettings } from '@/voice/local/localVoiceSettings';
import { resolveBoundConversationSessionId, resolveBoundTargetSessionAddress } from '@/voice/agent/voiceAgentRunState';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { requireVoiceSessionAgentSelection, resolveVoiceSessionAgentSelection } from '@/voice/agent/resolveVoiceSessionAgentSelection';

import { createVoiceRunRecovery } from './voiceRunRecovery';
import { VoiceRunStopUnconfirmedError } from './voiceRunStopReconciliation';
import { createVoiceTurnStreaming } from './voiceTurnStreaming';
import { createVoiceWelcomePolicy } from './voiceWelcomePolicy';

export type VoiceExecutionTransport = Readonly<{
    /** Explicit context scoped to the current Voice attempt (QA/manual injection only). */
    appendAttemptContextUpdate: (sessionId: string, update: string) => void;
    appendAutomaticUiContextUpdate: (sessionId: string, update: string) => void;
    commitUserTranscript: (sessionId: string, text: string, localId: string) => Promise<void>;
    commit: (sessionId: string) => Promise<string>;
    ensureRunning: (sessionId: string) => Promise<void>;
    prepareAgentSelection: (sessionId: string, signal: AbortSignal) => Promise<void>;
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
    stop: (sessionId: string, reason?: 'continued_elsewhere', signal?: AbortSignal) => Promise<void>;
}>;

export function createVoiceExecutionTransport(): VoiceExecutionTransport {
    const voiceAgentBySessionId = new Map<string, VoiceAgentHandle>();
    const voiceAgentInitBySessionId = new Map<string, Promise<VoiceAgentHandle>>();
    const voiceAttemptExplicitContextBySessionId = new Map<string, string[]>();
    // A null entry records that this attempt has already admitted its deferred
    // target context, so a recovered handle cannot queue it for the next turn.
    const deferredTargetSessionContextBySessionId = new Map<string, string | null>();
    const latestAutomaticUiContextBySessionId = new Map<string, string>();
    const voiceAgentActiveTurnSettlementsBySessionId = new Map<string, Set<Promise<void>>>();
    const voiceAgentTurnAbortControllerBySessionId = new Map<string, AbortController>();
    const voiceAgentStopPromiseBySessionId = new Map<string, {
        completion: Promise<void>;
        cleanup: ReturnType<ReturnType<typeof createVoiceRunRecovery>['prepareStop']>;
        failed: boolean;
        signal: AbortSignal | undefined;
    }>();
    const voiceAgentLifetimeBySessionId = new Map<string, AbortController>();
    const admittedSessionAgents = new Map<string, Readonly<{ backendTarget: BackendTargetRefV1; dispose(): void }>>();

    const clearAgentSelection = (sessionId: string): void => {
        admittedSessionAgents.get(sessionId)?.dispose();
        admittedSessionAgents.delete(sessionId);
    };

    const prepareAgentSelection = async (sessionId: string, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (admittedSessionAgents.has(sessionId)) return;
        const agent = readLocalConversationSettingsFromAccountSettings(storage.getState().settings).agent;
        if (agent.agentSource === 'agent' || agent.providerChat?.status === 'configured') return;
        const account = captureActiveServerAccountScopeLifetime();
        if (!account) throw new Error('voice_agent_account_scope_unavailable');
        const target = resolveBoundTargetSessionAddress(sessionId) ?? {
            serverId: account.scope.serverId,
            sessionId: resolveBoundConversationSessionId(sessionId) ?? sessionId,
        };
        if (!readVoiceSessionOwnerMetadataFromState(storage.getState(), target)) {
            await sync.ensureSessionVisibleForMessageRoute(target.sessionId, {
                serverId: target.serverId, forceRefresh: true,
            }).catch(() => {});
        }
        signal.throwIfAborted();
        if (!account.isCurrent()) throw new Error('voice_agent_account_scope_retired');
        const backendTarget = requireVoiceSessionAgentSelection(resolveVoiceSessionAgentSelection(
            readVoiceSessionOwnerMetadataFromState(storage.getState(), target),
        ));
        // Capture and Send are separate gestures. Keep this admitted choice for
        // their shared attempt, including handle recovery, without starting a model.
        const retirement = account.onRetire(() => clearAgentSelection(sessionId));
        admittedSessionAgents.set(sessionId, { backendTarget, dispose: () => retirement.dispose() });
    };

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
        createHandle: async (sessionId: string) => {
            voiceAgentLifetimeBySessionId.get(sessionId)?.abort();
            const lifetime = new AbortController();
            voiceAgentLifetimeBySessionId.set(sessionId, lifetime);
            const retirement = captureActiveServerAccountScopeLifetime()?.onRetire(() => lifetime.abort());
            lifetime.signal.addEventListener('abort', () => retirement?.dispose(), { once: true });
            try {
                const retiringStop = voiceAgentStopPromiseBySessionId.get(sessionId);
                if (retiringStop && retiringStop.cleanup.accountLifetime?.isCurrent()) {
                    // A cancelled acknowledgement did not prove cleanup. The
                    // next explicit activation repeats the same ordered Stop.
                    await createAbortRacer(lifetime.signal).race(retiringStop.failed
                        ? runStop(sessionId, undefined, lifetime.signal)
                        : retiringStop.completion);
                } else if (retiringStop) {
                    // A different Account cannot retry the old Account's Stop.
                    voiceAgentStopPromiseBySessionId.delete(sessionId);
                }
                return await initializeVoiceAgentHandle({
                    sessionId,
                    signal: lifetime.signal,
                    admittedSessionAgentTarget: admittedSessionAgents.get(sessionId)?.backendTarget,
                    getDaemonVoiceAgentClient: (scope) => new DaemonVoiceAgentClient(scope, lifetime.signal),
                    getCleanupSignal: () => voiceAgentStopPromiseBySessionId.get(sessionId)?.signal,
                    onPreparedInstructionsFor: preparedInstructionsFor => {
                        if (lifetime.signal.aborted || voiceAgentLifetimeBySessionId.get(sessionId) !== lifetime) return;
                        voiceConversationRuntimeMachine.setPreparedInstructionsFor({ controlSessionId: sessionId, preparedInstructionsFor });
                    },
                    setDeferredTargetSessionContext: (pendingSessionId, update) => {
                        const text = update.trim();
                        if (!text) return;
                        if (deferredTargetSessionContextBySessionId.get(pendingSessionId) === null) return;
                        deferredTargetSessionContextBySessionId.set(pendingSessionId, text);
                    },
                });
            } catch (error) {
                lifetime.abort();
                if (voiceAgentLifetimeBySessionId.get(sessionId) === lifetime) voiceAgentLifetimeBySessionId.delete(sessionId);
                throw error;
            }
        },
        voiceAgentBySessionId,
        voiceAgentInitBySessionId,
        voiceAttemptExplicitContextBySessionId,
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
        voiceAttemptExplicitContextBySessionId,
        deferredTargetSessionContextBySessionId,
        latestAutomaticUiContextBySessionId,
        voiceAgentTurnAbortControllerBySessionId,
    });

    const runStop = (sessionId: string, reason?: 'continued_elsewhere', signal?: AbortSignal): Promise<void> => {
        const existingStop = voiceAgentStopPromiseBySessionId.get(sessionId);
        if (existingStop && !existingStop.failed) return existingStop.completion;
        const cleanup = existingStop?.cleanup ?? recovery.prepareStop(sessionId, () => waitForActiveTurns(sessionId), reason);

        const stopPromise = (async () => {
            try {
                await cleanup.run(signal);
            } finally {
                clearRetainedLocalVoiceEffectOutcomes(sessionId);
            }
        })();
        const stop = { completion: stopPromise, cleanup, failed: false, signal };
        voiceAgentStopPromiseBySessionId.set(sessionId, stop);
        void stopPromise.then(
            () => {
                if (voiceAgentStopPromiseBySessionId.get(sessionId) === stop) {
                    voiceAgentStopPromiseBySessionId.delete(sessionId);
                }
            },
            (error: unknown) => {
                if (error instanceof VoiceRunStopUnconfirmedError) {
                    // End may retire this client's custody without claiming a
                    // remote acknowledgement. Recovery keeps its persisted Run;
                    // the next explicit activation uses normal current admission.
                    if (voiceAgentStopPromiseBySessionId.get(sessionId) === stop) {
                        voiceAgentStopPromiseBySessionId.delete(sessionId);
                    }
                } else {
                    stop.failed = true;
                }
            },
        );
        return stopPromise;
    };

    const stop = (sessionId: string, reason?: 'continued_elsewhere', signal?: AbortSignal): Promise<void> => {
        clearAgentSelection(sessionId);
        interruptActiveTurn(sessionId);
        voiceAgentLifetimeBySessionId.get(sessionId)?.abort();
        voiceAgentLifetimeBySessionId.delete(sessionId);
        return runStop(sessionId, reason, signal);
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
        appendAttemptContextUpdate: recovery.appendAttemptContextUpdate,
        appendAutomaticUiContextUpdate: recovery.appendAutomaticUiContextUpdate,
        commitUserTranscript,
        commit: recovery.commit,
        ensureRunning: recovery.ensureRunning,
        prepareAgentSelection,
        ensureRunningAndMaybeWelcome: welcomePolicy.ensureRunningAndMaybeWelcome,
        isActive: recovery.isActive,
        sendInterruptingTextUpdate: turnStreaming.sendInterruptingTextUpdate,
        sendTextUpdate: turnStreaming.sendTextUpdate,
        sendTurn: turnStreaming.sendTurn,
        stop,
    };
}
