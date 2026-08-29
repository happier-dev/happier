import { storage } from '@/sync/domains/state/storage';
import {
    resolveVoiceAgentRunBackendId,
    type VoiceAssistantAction,
} from '@happier-dev/protocol';
import type { VoiceAgentHandle } from '@/voice/agent/types';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { isVoiceAgentNotFoundError } from '@/voice/agent/voiceAgentErrorGuards';
import { readPersistedVoiceConversationRuntimeState } from '@/voice/binding/voiceConversationBindingPersistence';
import { readVoiceAgentRunMetadataFromSession } from '@/voice/persistence/voiceAgentRunMetadata';
import { sessionExecutionRunGet, sessionExecutionRunList, sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import {
    clearVoiceAgentRunMetadata,
    persistVoiceAgentRunMetadata,
    resolveVoiceRunMetadataSessionId,
} from '@/voice/agent/voiceAgentRunState';

type SendTurnResult = Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>;

export function createVoiceRunRecovery(args: Readonly<{
    createHandle: (sessionId: string) => Promise<VoiceAgentHandle>;
    voiceAgentBySessionId: Map<string, VoiceAgentHandle>;
    voiceAgentInitBySessionId: Map<string, Promise<VoiceAgentHandle>>;
    voiceAgentPendingSessionContextBySessionId: Map<string, string[]>;
    deferredTargetSessionContextBySessionId: Map<string, string | null>;
    latestAutomaticUiContextBySessionId: Map<string, string>;
}>): Readonly<{
    appendContextUpdate: (sessionId: string, update: string) => void;
    appendAutomaticUiContextUpdate: (sessionId: string, update: string) => void;
    commit: (sessionId: string) => Promise<string>;
    ensureRunning: (sessionId: string) => Promise<void>;
    getVoiceAgentHandle: (sessionId: string) => Promise<VoiceAgentHandle>;
    isActive: (sessionId: string) => boolean;
    resetCachedHandle: (sessionId: string) => void;
    stop: (sessionId: string) => Promise<void>;
}> {
    const getVoiceAgentHandle = async (sessionId: string): Promise<VoiceAgentHandle> => {
        const existing = args.voiceAgentBySessionId.get(sessionId);
        if (existing) return existing;
        const pending = args.voiceAgentInitBySessionId.get(sessionId);
        if (pending) return await pending;

        const init = args.createHandle(sessionId);
        args.voiceAgentInitBySessionId.set(sessionId, init);
        try {
            const handle = await init;
            args.voiceAgentBySessionId.set(sessionId, handle);
            return handle;
        } finally {
            args.voiceAgentInitBySessionId.delete(sessionId);
        }
    };

    const commit = async (sessionId: string): Promise<string> => {
        const commitWithHandle = async () => {
            const handle = await getVoiceAgentHandle(sessionId);
            const response = await handle.client.commit({
                sessionId: handle.rpcSessionId,
                voiceAgentId: handle.voiceAgentId,
                kind: 'session_instruction',
            });

            if (handle.backend === 'daemon') {
                const persistedRuntimeState = readPersistedVoiceConversationRuntimeState({
                    managedSessionId: sessionId,
                    conversationSessionId: handle.rpcSessionId,
                });
                const metadataSessionId =
                    persistedRuntimeState?.metadataSessionId
                    ?? resolveVoiceRunMetadataSessionId(sessionId, handle.backend);
                if (metadataSessionId) {
                    try {
                        const getRes = await sessionExecutionRunGet(handle.rpcSessionId, {
                            runId: handle.voiceAgentId,
                            includeStructured: false,
                        });
                        if ('run' in getRes) {
                            await persistVoiceAgentRunMetadata(metadataSessionId, {
                                runId: handle.voiceAgentId,
                                backendTarget: getRes.run.backendTarget,
                                resumeHandle: getRes.run.resumeHandle ?? null,
                            });
                        }
                    } catch {
                        // best-effort only
                    }
                }
            }
            return response.commitText;
        };

        try {
            return await commitWithHandle();
        } catch (error) {
            if (!isVoiceAgentNotFoundError(error)) {
                throw error;
            }
            args.voiceAgentBySessionId.delete(sessionId);
            return await commitWithHandle();
        }
    };

    const stop = async (sessionId: string): Promise<void> => {
        const persistedRuntimeState = readPersistedVoiceConversationRuntimeState({
            managedSessionId: sessionId,
        });
        const metadataSessionId = persistedRuntimeState?.metadataSessionId ?? resolveVoiceRunMetadataSessionId(sessionId, 'daemon');
        const persistedRunMeta = persistedRuntimeState?.runMetadata ?? (metadataSessionId
            ? readVoiceAgentRunMetadataFromSession({ sessionId: metadataSessionId })
            : null);
        const existingHandle = args.voiceAgentBySessionId.get(sessionId) ?? null;
        const pendingInit = args.voiceAgentInitBySessionId.get(sessionId) ?? null;
        args.voiceAgentInitBySessionId.delete(sessionId);

        const handle = existingHandle
            ? existingHandle
            : pendingInit
                ? await pendingInit.catch(() => null)
                : null;

        args.voiceAgentBySessionId.delete(sessionId);
        args.voiceAgentPendingSessionContextBySessionId.delete(sessionId);
        args.deferredTargetSessionContextBySessionId.delete(sessionId);
        args.latestAutomaticUiContextBySessionId.delete(sessionId);

        const fallbackRpcSessionId =
            sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
                ? (metadataSessionId ?? sessionId)
                : sessionId;
        const daemonRpcSessionId = handle?.backend === 'daemon' ? handle.rpcSessionId : fallbackRpcSessionId;
        const daemonBackendId = normalizeNonEmptyString(
            handle?.backend === 'daemon'
                ? handle.agentBackendId
                : persistedRunMeta?.backendId ?? null,
        );

        if (handle) {
            try {
                await handle.client.stop({ sessionId: handle.rpcSessionId, voiceAgentId: handle.voiceAgentId });
            } catch {
                // best-effort only
            }
        } else if (persistedRunMeta?.runId) {
            await sessionExecutionRunStop(fallbackRpcSessionId, { runId: persistedRunMeta.runId }).catch(() => {});
        }

        if (daemonBackendId) {
            const listed = await Promise.resolve(sessionExecutionRunList(daemonRpcSessionId, {})).catch(() => null);
            const runs = listed && 'runs' in listed ? listed.runs : [];
            const matchingRunIds: string[] = Array.from(
                new Set(
                    runs
                        .filter((run) =>
                            run.intent === 'voice_agent'
                            && run.status === 'running'
                            && resolveVoiceAgentRunBackendId(run.backendTarget) === daemonBackendId,
                        )
                        .map((run) => run.runId),
                ),
            );
            for (const runId of matchingRunIds) {
                await sessionExecutionRunStop(daemonRpcSessionId, { runId }).catch(() => {});
            }
        }

        await clearVoiceAgentRunMetadata(metadataSessionId).catch(() => {});
    };

    const appendContextUpdate = (sessionId: string, update: string): void => {
        const text = update.trim();
        if (!text) return;

        const existing = args.voiceAgentPendingSessionContextBySessionId.get(sessionId) ?? [];
        existing.push(text);
        args.voiceAgentPendingSessionContextBySessionId.set(sessionId, existing.slice(Math.max(0, existing.length - 8)));
    };

    const appendAutomaticUiContextUpdate = (sessionId: string, update: string): void => {
        const text = update.trim();
        if (!text) return;
        args.latestAutomaticUiContextBySessionId.set(sessionId, text);
    };

    return {
        appendContextUpdate,
        appendAutomaticUiContextUpdate,
        commit,
        ensureRunning: async (sessionId: string) => {
            await getVoiceAgentHandle(sessionId);
        },
        getVoiceAgentHandle,
        isActive: (sessionId: string) => args.voiceAgentBySessionId.has(sessionId),
        resetCachedHandle: (sessionId: string) => {
            args.voiceAgentBySessionId.delete(sessionId);
        },
        stop,
    };
}
