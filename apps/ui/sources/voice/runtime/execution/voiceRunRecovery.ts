import { storage } from '@/sync/domains/state/storage';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import type { VoiceAssistantAction } from '@happier-dev/protocol';
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
import { readLocalConversationSettingsFromAccountSettings } from '@/voice/local/localVoiceSettings';

function resolveExecutionRunBackendId(run: Readonly<Record<string, unknown>> | null | undefined): string | null {
    const backendIdRaw = typeof run?.backendId === 'string' ? run.backendId.trim() : '';
    if (backendIdRaw) return backendIdRaw;

    const backendTarget = run?.backendTarget as Record<string, unknown> | undefined;
    if (backendTarget?.kind === 'builtInAgent' && typeof backendTarget.agentId === 'string' && backendTarget.agentId.trim()) {
        return backendTarget.agentId.trim();
    }
    if (
        backendTarget?.kind === 'configuredAcpBackend'
        && typeof backendTarget.backendId === 'string'
        && backendTarget.backendId.trim()
    ) {
        return backendTarget.backendId.trim();
    }

    const resumeHandle = run?.resumeHandle as Record<string, unknown> | undefined;
    const backendTargetFromHandle = resumeHandle?.backendTarget as Record<string, unknown> | undefined;
    if (
        backendTargetFromHandle?.kind === 'builtInAgent'
        && typeof backendTargetFromHandle.agentId === 'string'
        && backendTargetFromHandle.agentId.trim()
    ) {
        return backendTargetFromHandle.agentId.trim();
    }
    if (
        backendTargetFromHandle?.kind === 'configuredAcpBackend'
        && typeof backendTargetFromHandle.backendId === 'string'
        && backendTargetFromHandle.backendId.trim()
    ) {
        return backendTargetFromHandle.backendId.trim();
    }

    const backendIdFromHandle = typeof resumeHandle?.backendId === 'string' ? resumeHandle.backendId.trim() : '';
    return backendIdFromHandle || null;
}

function resolveExecutionRunBackendTarget(
    run: Readonly<Record<string, unknown>> | null | undefined,
): { kind: 'builtInAgent'; agentId: string } | { kind: 'configuredAcpBackend'; backendId: string } | null {
    const backendTarget = run?.backendTarget as Record<string, unknown> | undefined;
    if (backendTarget?.kind === 'builtInAgent' && typeof backendTarget.agentId === 'string' && backendTarget.agentId.trim()) {
        return { kind: 'builtInAgent', agentId: backendTarget.agentId.trim() };
    }
    if (
        backendTarget?.kind === 'configuredAcpBackend'
        && typeof backendTarget.backendId === 'string'
        && backendTarget.backendId.trim()
    ) {
        return { kind: 'configuredAcpBackend', backendId: backendTarget.backendId.trim() };
    }

    const resumeHandle = run?.resumeHandle as Record<string, unknown> | undefined;
    const targetFromHandle = resumeHandle?.backendTarget as Record<string, unknown> | undefined;
    if (targetFromHandle?.kind === 'builtInAgent' && typeof targetFromHandle.agentId === 'string' && targetFromHandle.agentId.trim()) {
        return { kind: 'builtInAgent', agentId: targetFromHandle.agentId.trim() };
    }
    if (
        targetFromHandle?.kind === 'configuredAcpBackend'
        && typeof targetFromHandle.backendId === 'string'
        && targetFromHandle.backendId.trim()
    ) {
        return { kind: 'configuredAcpBackend', backendId: targetFromHandle.backendId.trim() };
    }

    const backendId = resolveExecutionRunBackendId(run);
    return backendId ? { kind: 'builtInAgent', agentId: backendId } : null;
}

type SendTurnResult = Readonly<{ assistantText: string; actions: VoiceAssistantAction[] }>;

export function createVoiceRunRecovery(args: Readonly<{
    createHandle: (sessionId: string) => Promise<VoiceAgentHandle>;
    voiceAgentBySessionId: Map<string, VoiceAgentHandle>;
    voiceAgentInitBySessionId: Map<string, Promise<VoiceAgentHandle>>;
    voiceAgentPendingContextBySessionId: Map<string, string[]>;
}>): Readonly<{
    appendContextUpdate: (sessionId: string, update: string) => void;
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
                        const getRes: any = await sessionExecutionRunGet(handle.rpcSessionId, {
                            runId: handle.voiceAgentId,
                            includeStructured: false,
                        });
                        const resumeHandle = getRes?.run?.resumeHandle ?? null;
                        const backendId = resolveExecutionRunBackendId(getRes?.run ?? null);
                        const backendTarget = resolveExecutionRunBackendTarget(getRes?.run ?? null);
                        if (backendId && backendTarget) {
                            await persistVoiceAgentRunMetadata(metadataSessionId, {
                                runId: handle.voiceAgentId,
                                backendTarget,
                                resumeHandle,
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
        const agentCfg = readLocalConversationSettingsFromAccountSettings(storage.getState().settings).agent;
        const requestedBackend = (agentCfg?.backend ?? 'daemon') as 'daemon' | 'openai_compat';
        const persistedRuntimeState =
            requestedBackend === 'daemon'
                ? readPersistedVoiceConversationRuntimeState({
                    managedSessionId: sessionId,
                })
                : null;
        const metadataSessionId = persistedRuntimeState?.metadataSessionId ?? resolveVoiceRunMetadataSessionId(sessionId, requestedBackend);
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
        args.voiceAgentPendingContextBySessionId.delete(sessionId);

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
        } else if (requestedBackend === 'daemon' && persistedRunMeta?.runId) {
            await sessionExecutionRunStop(fallbackRpcSessionId, { runId: persistedRunMeta.runId }).catch(() => {});
        }

        if (requestedBackend === 'daemon' && daemonBackendId) {
            const listed: any = await Promise.resolve(sessionExecutionRunList(daemonRpcSessionId, {})).catch(() => null);
            const runs = Array.isArray(listed?.runs) ? listed.runs : [];
            const matchingRunIds: string[] = Array.from(
                new Set(
                    runs
                        .filter((run: any) =>
                            run
                            && run.intent === 'voice_agent'
                            && run.status === 'running'
                            && typeof run.runId === 'string'
                            && run.runId.trim().length > 0
                            && resolveExecutionRunBackendId(run) === daemonBackendId,
                        )
                        .map((run: any) => String(run.runId).trim())
                        .filter((runId: string) => runId.length > 0),
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

        const existing = args.voiceAgentPendingContextBySessionId.get(sessionId) ?? [];
        existing.push(text);
        args.voiceAgentPendingContextBySessionId.set(sessionId, existing.slice(Math.max(0, existing.length - 8)));
    };

    return {
        appendContextUpdate,
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
