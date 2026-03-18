import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';
import { resolveDaemonVoiceAgentModelIds } from '@/voice/agent/resolveDaemonVoiceAgentModels';
import { ensureVoiceAgentInstallablesBackground } from '@/voice/agent/ensureVoiceAgentInstallablesBackground';
import { resolveVoiceAgentInitialContexts } from '@/voice/agent/resolveVoiceAgentInitialContexts';
import type { VoiceAgentClient, VoiceAgentHandle, VoiceAgentStartParams } from '@/voice/agent/types';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { ensureVoiceConversationSessionId } from '@/voice/sessionBinding/voiceConversationSession';
import {
    doesVoiceAgentRunMetadataMatchBackendTarget,
    readVoiceAgentRunMetadataFromSession,
    VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION,
} from '@/voice/persistence/voiceAgentRunMetadata';
import { resolveDisabledVoiceActionIdsFromState } from '@/voice/tools/resolveDisabledVoiceActionIds';
import { DEFAULT_AGENT_ID, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { sessionExecutionRunGet, sessionExecutionRunList, sessionExecutionRunStop } from '@/sync/ops/sessionExecutionRuns';
import { resolveVoiceAgentBootstrapTimeoutMs } from '@/voice/agent/resolveVoiceAgentBootstrapTimeoutMs';
import { assertDaemonVoiceAgentRuntimeSupported } from '@/voice/agent/assertDaemonVoiceAgentRuntimeSupported';
import { recoverUnavailableGlobalVoiceAutoMachine } from '@/voice/agent/recoverUnavailableGlobalVoiceAutoMachine';
import { applyRecoveredGlobalVoiceMachineDecision } from '@/voice/agent/applyRecoveredGlobalVoiceMachineDecision';
import {
    clearVoiceAgentRecoveryReplaySource,
    readVoiceAgentRecoveryReplaySource,
} from '@/voice/agent/voiceAgentRecoveryReplayState';
import { shouldRecoverUnavailableGlobalVoiceAutoMachine } from '@/voice/agent/shouldRecoverUnavailableGlobalVoiceAutoMachine';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import {
    assertActiveDaemonTargetSession,
    clearVoiceAgentRunMetadata,
    persistVoiceAgentRunMetadata,
    resolveBoundTargetSessionId,
    resolvePersistedDaemonConversationSessionId,
    resolveVoiceRunMetadataSessionId,
} from '@/voice/agent/voiceAgentRunState';

type InitializeVoiceAgentHandleParams = Readonly<{
    sessionId: string;
    getDaemonVoiceAgentClient: () => VoiceAgentClient;
    getOpenAiCompatVoiceAgentClient: () => VoiceAgentClient;
    enqueuePendingContextUpdate: (sessionId: string, update: string) => void;
}>;

export async function initializeVoiceAgentHandle({
    sessionId,
    getDaemonVoiceAgentClient,
    getOpenAiCompatVoiceAgentClient,
    enqueuePendingContextUpdate,
}: InitializeVoiceAgentHandleParams): Promise<VoiceAgentHandle> {
    const settings: any = storage.getState().settings;
    const voiceCfg = settings?.voice?.adapters?.local_conversation ?? null;
    const agentCfg = voiceCfg?.agent ?? null;
    const requestedBackend = (agentCfg?.backend ?? 'daemon') as 'daemon' | 'openai_compat';
    const permissionPolicy = (agentCfg?.permissionPolicy ?? 'read_only') as 'no_tools' | 'read_only';
    const idleTtlSeconds = Number(agentCfg?.idleTtlSeconds ?? 300);
    const verbosity = (agentCfg?.verbosity ?? 'short') as 'short' | 'balanced';
    const agentSource = (agentCfg?.agentSource ?? 'session') as 'session' | 'agent';
    const agentId = agentSource === 'agent' ? (agentCfg?.agentId ?? 'claude') : null;

    const transcriptCfg = agentCfg?.transcript ?? null;
    const configuredTranscriptPersistenceMode =
        transcriptCfg && (transcriptCfg as any).persistenceMode === 'persistent' ? 'persistent' : 'ephemeral';
    const transcriptEpochRaw = transcriptCfg ? Number((transcriptCfg as any).epoch ?? 0) : 0;
    const transcriptEpoch =
        Number.isFinite(transcriptEpochRaw) && transcriptEpochRaw >= 0 ? Math.floor(transcriptEpochRaw) : 0;
    const resolveTranscriptConfig = (backend: 'daemon' | 'openai_compat') => {
        if (backend === 'daemon') {
            return { persistenceMode: 'persistent' as const, epoch: transcriptEpoch };
        }
        if (configuredTranscriptPersistenceMode === 'persistent' || transcriptEpoch > 0) {
            return { persistenceMode: configuredTranscriptPersistenceMode, epoch: transcriptEpoch } as const;
        }
        return undefined;
    };

    const resolveModelIds = (backend: 'daemon' | 'openai_compat', daemonSessionId: string) => {
        if (backend === 'openai_compat') {
            const openaiCompatCfg = agentCfg?.openaiCompat ?? null;
            const chatModelId = String(openaiCompatCfg?.chatModel ?? 'default');
            const commitModelId = String(openaiCompatCfg?.commitModel ?? chatModelId);
            return { chatModelId, commitModelId };
        }

        const session = storage.getState().sessions?.[daemonSessionId] ?? null;
        if (!session) {
            const chatModelId = String(agentCfg?.chatModelId ?? 'default');
            const commitModelId = String(agentCfg?.commitModelId ?? chatModelId);
            return { chatModelId, commitModelId };
        }

        return resolveDaemonVoiceAgentModelIds({
            session,
            agent: agentCfg ?? {},
        });
    };

    const boundTargetSessionId = resolveBoundTargetSessionId(sessionId);
    const daemonTargetSessionId =
        requestedBackend === 'daemon'
            ? normalizeNonEmptyString(boundTargetSessionId ?? (sessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? null : sessionId))
            : null;
    if (daemonTargetSessionId) {
        await Promise.resolve(
            sync.ensureSessionVisibleForMessageRoute(daemonTargetSessionId, { forceRefresh: true } as any),
        ).catch(() => {});
        assertActiveDaemonTargetSession(daemonTargetSessionId);
        await Promise.resolve(sync.refreshSessionMessages(daemonTargetSessionId)).catch(() => {});
    } else if (boundTargetSessionId) {
        await Promise.resolve(sync.ensureSessionVisibleForMessageRoute(boundTargetSessionId)).catch(() => {});
        await Promise.resolve(sync.refreshSessionMessages(boundTargetSessionId)).catch(() => {});
    }

    const {
        bootstrapInitialContext,
        deferredTargetSessionContext,
    } = resolveVoiceAgentInitialContexts(sessionId, {
        targetSessionId: boundTargetSessionId,
    });

    const shouldFallbackFromDaemon = (error: unknown) => shouldRecoverUnavailableGlobalVoiceAutoMachine(error);

    if (requestedBackend === 'daemon') {
        if (daemonTargetSessionId == null) {
            assertActiveDaemonTargetSession(sessionId);
        }
        await assertDaemonVoiceAgentRuntimeSupported();
    }

    let backend: 'daemon' | 'openai_compat' = requestedBackend;
    const globalConversationSessionId =
        requestedBackend === 'daemon' ? resolvePersistedDaemonConversationSessionId() : null;
    const isGlobalVoiceAgent =
        sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
        || (requestedBackend === 'daemon' && sessionId === globalConversationSessionId);
    let daemonConversationSessionId =
        backend === 'daemon' && isGlobalVoiceAgent ? globalConversationSessionId : null;

    if (backend === 'daemon' && isGlobalVoiceAgent && !daemonConversationSessionId) {
        try {
            daemonConversationSessionId = await ensureVoiceConversationSessionId();
        } catch (error) {
            const recoveryDecision = await recoverUnavailableGlobalVoiceAutoMachine();
            if (recoveryDecision.kind === 'retry' || recoveryDecision.kind === 'switch') {
                applyRecoveredGlobalVoiceMachineDecision(recoveryDecision);
                daemonConversationSessionId = await ensureVoiceConversationSessionId();
            } else {
                throw error;
            }
        }
    }

    if (backend === 'daemon' && isGlobalVoiceAgent && !daemonConversationSessionId) {
        const baseUrl = String(agentCfg?.openaiCompat?.chatBaseUrl ?? '').trim();
        if (!baseUrl) {
            throw Object.assign(new Error('voice_agent_requires_session'), { code: 'VOICE_AGENT_REQUIRES_SESSION' });
        }
        backend = 'openai_compat';
    }

    const replayCfg = agentCfg?.replay ?? null;
    const replayStrategy: NonNullable<VoiceAgentStartParams['replay']>['strategy'] =
        replayCfg?.strategy === 'summary_plus_recent' ? 'summary_plus_recent' : 'recent_messages';
    const replayRecentMessagesCountRaw = Number(replayCfg?.recentMessagesCount ?? 16);
    const replayRecentMessagesCount =
        Number.isFinite(replayRecentMessagesCountRaw) && replayRecentMessagesCountRaw > 0
            ? Math.max(1, Math.min(100, Math.floor(replayRecentMessagesCountRaw)))
            : 16;

    const resumabilityMode =
        backend === 'daemon' && agentCfg?.resumabilityMode === 'provider_resume' ? 'provider_resume' : 'replay';
    const fallbackToReplay = agentCfg?.providerResume?.fallbackToReplay !== false;
    const shouldIncludeReplaySeed = resumabilityMode === 'replay' || (resumabilityMode === 'provider_resume' && fallbackToReplay);
    const replaySummaryRunner =
        replayStrategy === 'summary_plus_recent' ? ((settings as any)?.sessionReplaySummaryRunnerV1 ?? null) : null;
    const resolveReplaySeedRequest = (): VoiceAgentStartParams['replay'] => {
        const recoveryReplaySourceConversationSessionId = normalizeNonEmptyString(
            readVoiceAgentRecoveryReplaySource(sessionId),
        );
        const replaySeedConversationSessionId = recoveryReplaySourceConversationSessionId ?? daemonConversationSessionId;
        if (
            !shouldIncludeReplaySeed
            || !isGlobalVoiceAgent
            || configuredTranscriptPersistenceMode !== 'persistent'
            || !replaySeedConversationSessionId
        ) {
            return null;
        }
        return {
            kind: 'voice_session.v1' as const,
            previousSessionId: replaySeedConversationSessionId,
            transcriptEpoch,
            strategy: replayStrategy,
            recentMessagesCount: replayRecentMessagesCount,
            ...(replaySummaryRunner ? { summaryRunner: replaySummaryRunner } : {}),
        };
    };
    const effectiveInitialContext = bootstrapInitialContext;

    let rpcSessionId =
        backend === 'daemon'
            ? (isGlobalVoiceAgent ? (daemonConversationSessionId ?? sessionId) : sessionId)
            : sessionId;

    const resolveDaemonAgentId = (daemonSessionId: string): string => {
        if (agentSource === 'agent') {
            const explicit = String(agentId ?? '').trim();
            return explicit.length > 0 ? explicit : DEFAULT_AGENT_ID;
        }
        const session = storage.getState().sessions?.[daemonSessionId] ?? null;
        return resolveAgentIdFromFlavor(session?.metadata?.flavor) ?? DEFAULT_AGENT_ID;
    };
    let chatModelId = '';
    let commitModelId = '';
    let resolvedAgentId = '';
    let resolvedBackendTarget: BackendTargetRefV1 | null = null;
    let runMetadataSessionId: string | null = null;
    let persistedRunMeta: ReturnType<typeof readVoiceAgentRunMetadataFromSession> = null;
    let existingRunId: VoiceAgentStartParams['existingRunId'] = null;
    let startResumeHandle: VoiceAgentStartParams['resumeHandle'] = null;
    const retentionPolicy: NonNullable<VoiceAgentStartParams['retentionPolicy']> =
        backend === 'daemon' && configuredTranscriptPersistenceMode === 'persistent' ? 'resumable' : 'ephemeral';
    const resumeWhenInactive =
        backend === 'daemon' && configuredTranscriptPersistenceMode === 'persistent'
            ? resumabilityMode === 'provider_resume'
            : undefined;

    const refreshPersistedRunState = (metadataSessionId: string | null) => {
        persistedRunMeta = metadataSessionId
            ? readVoiceAgentRunMetadataFromSession({ sessionId: metadataSessionId })
            : null;
        const allowPersistedRunIdReuse =
            configuredTranscriptPersistenceMode !== 'persistent' || resumabilityMode === 'provider_resume';
        const matchesResolvedBackend =
            resolvedBackendTarget != null
                ? doesVoiceAgentRunMetadataMatchBackendTarget(persistedRunMeta, resolvedBackendTarget)
                : false;
        existingRunId =
            allowPersistedRunIdReuse && persistedRunMeta && matchesResolvedBackend
                ? persistedRunMeta.runId
                : null;
        const resumeHandle = persistedRunMeta && matchesResolvedBackend ? persistedRunMeta.resumeHandle : null;
        startResumeHandle =
            configuredTranscriptPersistenceMode === 'persistent' && resumabilityMode === 'provider_resume' ? resumeHandle : null;
    };

    const requiresGlobalDaemonTranscriptMigration = () =>
        backend === 'daemon'
        && sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
        && configuredTranscriptPersistenceMode !== 'persistent'
        && ((persistedRunMeta?.transcriptContractVersion ?? 0) < VOICE_AGENT_RUN_TRANSCRIPT_CONTRACT_VERSION);
    const requiresPersistentHiddenVoiceTranscript = () =>
        backend === 'daemon' && sessionId === VOICE_AGENT_GLOBAL_SESSION_ID;
    const hasPersistentTranscript = (run: any) => run?.transcript?.persistenceMode === 'persistent';
    const doesRunMatchResolvedBackendTarget = (run: any): boolean => {
        if (!resolvedBackendTarget) return false;
        const runTarget = run?.backendTarget;
        if (runTarget?.kind === 'builtInAgent' && typeof runTarget.agentId === 'string' && runTarget.agentId.trim()) {
            return buildBackendTargetKey(runTarget) === buildBackendTargetKey(resolvedBackendTarget);
        }
        return typeof run?.backendId === 'string' && run.backendId.trim() === resolvedAgentId;
    };

    const refreshStartState = (nextBackend: 'daemon' | 'openai_compat', nextRpcSessionId: string) => {
        backend = nextBackend;
        rpcSessionId = nextRpcSessionId;
        ({ chatModelId, commitModelId } = resolveModelIds(nextBackend, nextRpcSessionId));
        if (nextBackend !== 'daemon') {
            resolvedAgentId = String(agentId ?? '').trim();
            runMetadataSessionId = null;
            existingRunId = null;
            startResumeHandle = null;
            return;
        }

        resolvedAgentId = resolveDaemonAgentId(nextRpcSessionId);
        resolvedBackendTarget = { kind: 'builtInAgent', agentId: resolvedAgentId };
        runMetadataSessionId = resolveVoiceRunMetadataSessionId(sessionId, nextBackend, daemonConversationSessionId);
        refreshPersistedRunState(runMetadataSessionId);
    };
    refreshStartState(backend, rpcSessionId);
    const ensureInstallablesForCurrentStartState = async () => {
        await ensureVoiceAgentInstallablesBackground({
            agentId: backend === 'daemon' ? resolvedAgentId : null,
            sessionId: rpcSessionId,
        });
    };
    await ensureInstallablesForCurrentStartState();
    const canAutoSpeakLocalVoiceReplies =
        settings?.voice?.adapters?.local_conversation?.tts?.autoSpeakReplies !== false;
    const immediateWelcomeEnabled =
        canAutoSpeakLocalVoiceReplies &&
        agentCfg?.welcome?.enabled === true &&
        agentCfg?.welcome?.mode !== 'on_first_turn';
    const bootstrapMode =
        backend === 'daemon' && agentCfg?.prewarmOnConnect === true && !immediateWelcomeEnabled ? 'ready_handshake' : 'none';
    const bootstrapTimeoutMs = resolveVoiceAgentBootstrapTimeoutMs(settings?.voice?.adapters?.local_conversation);
    const disabledActionIds = resolveDisabledVoiceActionIdsFromState(storage.getState() as any);

    let client: VoiceAgentClient =
        backend === 'openai_compat'
            ? getOpenAiCompatVoiceAgentClient()
            : getDaemonVoiceAgentClient();

    const startArgsBase = {
        agentSource,
        profileId: normalizeNonEmptyString((storage.getState() as any)?.sessions?.[rpcSessionId]?.metadata?.profileId),
        verbosity,
        permissionPolicy,
        idleTtlSeconds,
        initialContext: effectiveInitialContext,
        bootstrapMode,
        bootstrapTimeoutMs,
        disabledActionIds,
    } satisfies Omit<
        VoiceAgentStartParams,
        'sessionId' | 'agentId' | 'chatModelId' | 'commitModelId' | 'commitIsolation' | 'existingRunId' | 'resumeWhenInactive' | 'resumeHandle' | 'retentionPolicy'
    >;
    const buildStartTranscript = (nextBackend: 'daemon' | 'openai_compat') => resolveTranscriptConfig(nextBackend);

    const started = await (async () => {
        const migrateLegacyGlobalDaemonTranscriptRun = async () => {
            if (!requiresGlobalDaemonTranscriptMigration()) return;
            const legacyRunId = typeof persistedRunMeta?.runId === 'string' ? persistedRunMeta.runId.trim() : '';
            if (legacyRunId) {
                await sessionExecutionRunStop(rpcSessionId, { runId: legacyRunId }).catch(() => {});
            }
            const listed: any = await sessionExecutionRunList(rpcSessionId, {});
            const runs = Array.isArray(listed?.runs) ? listed.runs : [];
            const legacyRuns = runs.filter((run: any) =>
                run
                && run.intent === 'voice_agent'
                && run.status === 'running'
                && typeof run.runId === 'string'
                && run.runId.trim().length > 0
                && doesRunMatchResolvedBackendTarget(run),
            );
            for (const legacyRun of legacyRuns) {
                await sessionExecutionRunStop(rpcSessionId, { runId: legacyRun.runId }).catch(() => {});
            }
            await clearVoiceAgentRunMetadata(runMetadataSessionId).catch(() => {});
            persistedRunMeta = null;
            existingRunId = null;
            startResumeHandle = null;
        };

        const ensureExistingGlobalDaemonRunHasPersistentTranscript = async () => {
            if (!requiresPersistentHiddenVoiceTranscript() || !existingRunId) return;
            const existingRunGet: any = await sessionExecutionRunGet(rpcSessionId, {
                runId: existingRunId,
                includeStructured: false,
            }).catch(() => null);
            if (hasPersistentTranscript(existingRunGet?.run)) return;
            await sessionExecutionRunStop(rpcSessionId, { runId: existingRunId }).catch(() => {});
            await clearVoiceAgentRunMetadata(runMetadataSessionId).catch(() => {});
            persistedRunMeta = null;
            existingRunId = null;
            startResumeHandle = null;
        };

        const reconcileExistingDaemonRuns = async () => {
            if (backend !== 'daemon' || !runMetadataSessionId || !resolvedAgentId) return;
            const listed: any = await sessionExecutionRunList(rpcSessionId, {});
            const runs = Array.isArray(listed?.runs) ? listed.runs : null;
            if (!runs) return;

            const matchingRuns = runs
                .filter((run: any) =>
                    run
                    && run.intent === 'voice_agent'
                    && run.status === 'running'
                    && typeof run.runId === 'string'
                    && run.runId.trim().length > 0
                    && doesRunMatchResolvedBackendTarget(run),
                )
                .sort((left: any, right: any) => {
                    const leftStartedAt = typeof left?.startedAtMs === 'number' && Number.isFinite(left.startedAtMs) ? left.startedAtMs : 0;
                    const rightStartedAt = typeof right?.startedAtMs === 'number' && Number.isFinite(right.startedAtMs) ? right.startedAtMs : 0;
                    if (rightStartedAt !== leftStartedAt) return rightStartedAt - leftStartedAt;
                    return String(left?.runId ?? '').localeCompare(String(right?.runId ?? ''));
                });
            if (matchingRuns.length === 0) return;

            const adoptedRun = matchingRuns[0] as any;
            existingRunId = adoptedRun.runId;

            const adoptedRunGet: any = await sessionExecutionRunGet(rpcSessionId, {
                runId: adoptedRun.runId,
                includeStructured: false,
            });
            if (requiresPersistentHiddenVoiceTranscript() && !hasPersistentTranscript(adoptedRunGet?.run)) {
                for (const matchingRun of matchingRuns) {
                    await sessionExecutionRunStop(rpcSessionId, { runId: matchingRun.runId }).catch(() => {});
                }
                await clearVoiceAgentRunMetadata(runMetadataSessionId).catch(() => {});
                persistedRunMeta = null;
                existingRunId = null;
                startResumeHandle = null;
                return;
            }
            const adoptedResumeHandle = adoptedRunGet?.run?.resumeHandle ?? adoptedRun.resumeHandle ?? null;
            startResumeHandle =
                configuredTranscriptPersistenceMode === 'persistent' && resumabilityMode === 'provider_resume'
                    ? adoptedResumeHandle
                    : null;
            await persistVoiceAgentRunMetadata(runMetadataSessionId, {
                runId: adoptedRun.runId,
                backendId: resolvedAgentId,
                backendTarget: resolvedBackendTarget ?? { kind: 'builtInAgent', agentId: resolvedAgentId },
                resumeHandle: adoptedResumeHandle,
            });

            const duplicateRuns = matchingRuns.slice(1);
            for (const duplicateRun of duplicateRuns) {
                await sessionExecutionRunStop(rpcSessionId, { runId: duplicateRun.runId }).catch(() => {});
            }
        };

        const buildStartParams = (overrides?: Partial<Pick<VoiceAgentStartParams, 'existingRunId' | 'resumeWhenInactive' | 'resumeHandle'>>) =>
            ({
                sessionId: rpcSessionId,
                ...startArgsBase,
                initialContext: effectiveInitialContext,
                ...(backend === 'daemon' ? { replay: resolveReplaySeedRequest() } : {}),
                ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
                chatModelId,
                commitModelId,
                ...(buildStartTranscript(backend) ? { transcript: buildStartTranscript(backend) } : {}),
                ...(backend === 'daemon'
                    ? {
                        commitIsolation: agentCfg?.commitIsolation === true,
                        existingRunId,
                        resumeWhenInactive,
                        resumeHandle: startResumeHandle,
                        retentionPolicy,
                    }
                    : {}),
                ...(overrides ?? {}),
            }) satisfies VoiceAgentStartParams;

        const startOnce = (overrides?: Partial<Pick<VoiceAgentStartParams, 'existingRunId' | 'resumeWhenInactive' | 'resumeHandle'>>) =>
            client.start({
                ...buildStartParams(overrides),
            });

        const startDaemonForCurrentSession = async () => {
            try {
                return await startOnce();
            } catch (error) {
                const err: any = error;
                const canRetryFreshStart = backend === 'daemon' && Boolean(existingRunId);
                const isNotFound = typeof err?.rpcErrorCode === 'string' && err.rpcErrorCode === 'execution_run_not_found';
                const isNotAllowed = typeof err?.rpcErrorCode === 'string' && err.rpcErrorCode === 'execution_run_not_allowed';

                if (canRetryFreshStart && isNotFound) {
                    if (resumabilityMode === 'provider_resume') {
                        if (!startResumeHandle && !fallbackToReplay) throw error;
                        return await startOnce({ existingRunId: null, resumeWhenInactive: true, resumeHandle: startResumeHandle });
                    }
                    return await startOnce({ existingRunId: null, resumeWhenInactive: false, resumeHandle: null });
                }
                if (canRetryFreshStart && isNotAllowed && resumabilityMode === 'provider_resume' && startResumeHandle) {
                    return await startOnce({ existingRunId: null, resumeWhenInactive: true, resumeHandle: startResumeHandle });
                }
                if (canRetryFreshStart && isNotAllowed) {
                    return await startOnce({ existingRunId: null, resumeWhenInactive: false, resumeHandle: null });
                }
                throw error;
            }
        };

        let attemptedGlobalMachineRecovery = false;
        try {
            await migrateLegacyGlobalDaemonTranscriptRun();
            await ensureExistingGlobalDaemonRunHasPersistentTranscript();
            await reconcileExistingDaemonRuns();
            return await startDaemonForCurrentSession();
        } catch (error) {
            if (requestedBackend !== 'daemon') throw error;
            if (
                !attemptedGlobalMachineRecovery
                && backend === 'daemon'
                && isGlobalVoiceAgent
                && sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
                && shouldFallbackFromDaemon(error)
            ) {
                attemptedGlobalMachineRecovery = true;
                const recoveryDecision = await recoverUnavailableGlobalVoiceAutoMachine();
                if (recoveryDecision.kind === 'retry' || recoveryDecision.kind === 'switch') {
                    applyRecoveredGlobalVoiceMachineDecision(recoveryDecision);
                    daemonConversationSessionId = await ensureVoiceConversationSessionId();
                    refreshStartState('daemon', daemonConversationSessionId ?? sessionId);
                    await ensureInstallablesForCurrentStartState();
                    await migrateLegacyGlobalDaemonTranscriptRun();
                    await ensureExistingGlobalDaemonRunHasPersistentTranscript();
                    await reconcileExistingDaemonRuns();
                    return await startDaemonForCurrentSession();
                }
            }
            if (!shouldFallbackFromDaemon(error)) throw error;

            const baseUrl = String(agentCfg?.openaiCompat?.chatBaseUrl ?? '').trim();
            if (!baseUrl) throw error;

            refreshStartState('openai_compat', sessionId);
            client = getOpenAiCompatVoiceAgentClient();
            return await startOnce();
        }
    })();

    if (runMetadataSessionId) {
        try {
            const getRes: any = await sessionExecutionRunGet(rpcSessionId, { runId: started.voiceAgentId, includeStructured: false });
            const resumeHandle = getRes?.run?.resumeHandle ?? null;
            await persistVoiceAgentRunMetadata(runMetadataSessionId, {
                runId: started.voiceAgentId,
                backendId: resolvedAgentId,
                backendTarget: resolvedBackendTarget ?? { kind: 'builtInAgent', agentId: resolvedAgentId },
                resumeHandle,
            });
        } catch {
            // best-effort; persistence should not block voice usage
        }
    }

    if (deferredTargetSessionContext.trim().length > 0) {
        enqueuePendingContextUpdate(sessionId, deferredTargetSessionContext);
    }

    clearVoiceAgentRecoveryReplaySource(sessionId);

    return {
        client,
        voiceAgentId: started.voiceAgentId,
        backend,
        rpcSessionId,
        agentBackendId: backend === 'daemon' ? resolvedAgentId : null,
    };
}
