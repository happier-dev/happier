import {
    resolveAgentIdFromSessionMetadata,
    type PermissionIntent,
} from '@happier-dev/agents';
import {
    storage,
} from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import { resolveDaemonVoiceAgentModelIds } from '@/voice/agent/resolveDaemonVoiceAgentModels';
import { ensureVoiceAgentInstallablesBackground } from '@/voice/agent/ensureVoiceAgentInstallablesBackground';
import { resolveVoiceAgentInitialContexts } from '@/voice/agent/resolveVoiceAgentInitialContexts';
import type {
    VoiceAgentClient,
    VoiceAgentHandle,
    VoiceAgentStartParams,
} from '@/voice/agent/types';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { ensureVoiceConversationSessionId } from '@/voice/persistence/voiceConversationSession';
import {
    doesVoiceAgentRunMetadataMatchBackendTarget,
    readVoiceAgentRunMetadataFromSession,
} from '@/voice/persistence/voiceAgentRunMetadata';
import { backendTargetsMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
import { resolveDisabledVoiceActionIdsFromState } from '@/voice/tools/resolveDisabledVoiceActionIds';
import {
    DEFAULT_AGENT_ID,
} from '@/agents/catalog/catalog';
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
import { readPersistedVoiceConversationRuntimePublication } from '@/voice/binding/voiceConversationBindingPersistence';
import {
    assertActiveDaemonTargetSession,
    clearVoiceAgentRunMetadata,
    resolveBoundConversationSessionId,
    persistVoiceAgentRunMetadata,
    resolveBoundTargetSessionId,
    resolvePersistedDaemonConversationSessionId,
    resolveVoiceRunMetadataSessionId,
} from '@/voice/agent/voiceAgentRunState';
import { findSessionListLookupSession } from '@/sync/domains/session/listing/sessionListLookupState';
import { readLocalConversationSettingsFromAccountSettings } from '@/voice/local/localVoiceSettings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';

type InitializeVoiceAgentHandleParams = Readonly<{
    sessionId: string;
    getDaemonVoiceAgentClient: () => VoiceAgentClient;
    setDeferredTargetSessionContext: (sessionId: string, update: string) => void;
}>;

type VoiceAgentSessionLike = Readonly<{
    id: string;
    modelMode?: unknown;
    metadataLayoutVersion?: number;
    metadata: Readonly<{
        flavor?: unknown;
        profileId?: unknown;
    }> | null;
    ownerMetadataView?: unknown;
}> | null;

type VoiceAgentBootstrapConfig = Readonly<{
    bootstrapMode: 'ready_handshake' | 'none';
    bootstrapTimeoutMs: number;
    disabledActionIds: readonly string[];
    initialContext: string;
}>;

function shouldUseImmediateVoiceWelcome(settings: any, agentCfg: any): boolean {
    const localConversation = readLocalConversationSettingsFromAccountSettings(settings);
    const welcome = voiceSettingsParse(settings?.voice).welcome;
    const canAutoSpeakLocalVoiceReplies =
        localConversation.tts.autoSpeakReplies !== false;
    return (
        canAutoSpeakLocalVoiceReplies
        && welcome.enabled === true
        && welcome.mode !== 'on_first_turn'
    );
}

function resolveVoiceAgentBootstrapConfig(args: Readonly<{
    settings: any;
    agentCfg: any;
    backend: 'daemon';
    initialContext: string;
}>): VoiceAgentBootstrapConfig {
    return {
        bootstrapMode:
            args.backend === 'daemon'
            && args.agentCfg?.prewarmOnConnect === true
            && !shouldUseImmediateVoiceWelcome(args.settings, args.agentCfg)
                ? 'ready_handshake'
                : 'none',
        bootstrapTimeoutMs: resolveVoiceAgentBootstrapTimeoutMs(readLocalConversationSettingsFromAccountSettings(args.settings)),
        disabledActionIds: resolveDisabledVoiceActionIdsFromState(storage.getState() as any),
        initialContext: args.initialContext,
    };
}

function buildVoiceAgentStartArgsBase(args: Readonly<{
    agentSource: 'session' | 'agent';
    profileId: string | null;
    verbosity: 'short' | 'balanced';
    permissionIntent: PermissionIntent;
    idleTtlSeconds: number;
    bootstrap: VoiceAgentBootstrapConfig;
}>): Omit<
    VoiceAgentStartParams,
    'sessionId'
    | 'agentId'
    | 'chatModelId'
    | 'commitModelId'
    | 'commitIsolation'
    | 'existingRunId'
    | 'resumeWhenInactive'
    | 'resumeHandle'
    | 'retentionPolicy'
> {
    return {
        agentSource: args.agentSource,
        profileId: args.profileId,
        verbosity: args.verbosity,
        permissionIntent: args.permissionIntent,
        idleTtlSeconds: args.idleTtlSeconds,
        initialContext: args.bootstrap.initialContext,
        bootstrapMode: args.bootstrap.bootstrapMode,
        bootstrapTimeoutMs: args.bootstrap.bootstrapTimeoutMs,
        disabledActionIds: args.bootstrap.disabledActionIds,
    };
}

export async function initializeVoiceAgentHandle({
    sessionId,
    getDaemonVoiceAgentClient,
    setDeferredTargetSessionContext,
}: InitializeVoiceAgentHandleParams): Promise<VoiceAgentHandle> {
    const settings: any = storage.getState().settings;
    const voiceCfg = readLocalConversationSettingsFromAccountSettings(settings);
    const agentCfg = voiceCfg.agent;
    const providerChatState = agentCfg?.providerChat ?? null;
    if (providerChatState?.status === 'needs_selection') {
        throw Object.assign(new Error('voice_agent_selection_required'), {
            code: 'VOICE_AGENT_SELECTION_REQUIRED',
        });
    }
    if (providerChatState?.status === 'migration_required') {
        throw Object.assign(new Error('voice_agent_provider_chat_migration_required'), {
            code: 'VOICE_AGENT_PROVIDER_CHAT_MIGRATION_REQUIRED',
        });
    }
    const providerChat = providerChatState?.status === 'configured' ? providerChatState : null;
    const backend = 'daemon' as const;
    const permissionIntent = (agentCfg?.permissionIntent ?? 'read-only') as PermissionIntent;
    const idleTtlSeconds = Number(agentCfg?.idleTtlSeconds ?? 300);
    const verbosity = (agentCfg?.verbosity ?? 'short') as 'short' | 'balanced';
    const agentSource = providerChat
        ? 'agent' as const
        : (agentCfg?.agentSource ?? 'session') as 'session' | 'agent';
    const agentId = agentSource === 'agent' ? (agentCfg?.agentId ?? DEFAULT_AGENT_ID) : null;
    if (providerChat) {
        const selectedAgentId = String(agentId ?? '').trim();
        const expectedTargetKey = selectedAgentId
            ? buildAgentUniverseBackendTargetKey(selectedAgentId)
            : null;
        if (
            !expectedTargetKey
            || providerChat.chat.agentTargetKey !== expectedTargetKey
            || providerChat.commit.agentTargetKey !== expectedTargetKey
        ) {
            throw Object.assign(new Error('voice_agent_provider_selection_mismatch'), {
                code: 'VOICE_AGENT_PROVIDER_SELECTION_MISMATCH',
            });
        }
    }

    const transcriptCfg = agentCfg?.transcript ?? null;
    const configuredTranscriptPersistenceMode =
        transcriptCfg && (transcriptCfg as any).persistenceMode === 'persistent' ? 'persistent' : 'ephemeral';
    const transcriptEpochRaw = transcriptCfg ? Number((transcriptCfg as any).epoch ?? 0) : 0;
    const transcriptEpoch =
        Number.isFinite(transcriptEpochRaw) && transcriptEpochRaw >= 0 ? Math.floor(transcriptEpochRaw) : 0;
    const resolveTranscriptConfig = (backend: 'daemon') => {
        if (backend === 'daemon') {
            return { persistenceMode: 'persistent' as const, epoch: transcriptEpoch };
        }
        if (configuredTranscriptPersistenceMode === 'persistent' || transcriptEpoch > 0) {
            return { persistenceMode: configuredTranscriptPersistenceMode, epoch: transcriptEpoch } as const;
        }
        return undefined;
    };

    const resolveDaemonSessionFromState = (daemonSessionId: string): VoiceAgentSessionLike => {
        const state = storage.getState() as any;
        const directSession = state?.sessions?.[daemonSessionId] ?? null;
        if (directSession && (directSession.metadataLayoutVersion ?? 0) !== 0) {
            return directSession;
        }
        const lookupSession = findSessionListLookupSession(state, daemonSessionId)?.session ?? null;
        if (lookupSession) return lookupSession as VoiceAgentSessionLike;
        return directSession;
    };

    const hydratedSessionIds = new Set<string>();
    const ensureSessionTranscriptReady = async (
        nextSessionId: string | null,
        options?: Readonly<{ forceRefresh?: boolean }>,
    ): Promise<void> => {
        const normalizedSessionId = normalizeNonEmptyString(nextSessionId);
        if (!normalizedSessionId || hydratedSessionIds.has(normalizedSessionId)) {
            return;
        }
        hydratedSessionIds.add(normalizedSessionId);
        await Promise.resolve(
            sync.ensureSessionVisibleForMessageRoute(normalizedSessionId, options as any),
        ).catch(() => {});
        await Promise.resolve(sync.refreshSessionMessages(normalizedSessionId)).catch(() => {});
    };

    // The configured voice models are the one model fact that does not depend on
    // reading the target Session's Agent. They answer both cases where no Session
    // Agent fact exists: no Session in state, and a Session whose Agent identity
    // is unreadable.
    const resolveConfiguredModelIds = () => {
        const chatModelId = String(agentCfg?.chatModelId ?? 'default');
        const commitModelId = String(agentCfg?.commitModelId ?? chatModelId);
        return { chatModelId, commitModelId };
    };

    const resolveModelIds = (backend: 'daemon', daemonSessionId: string) => {
        if (providerChat) {
            return {
                chatModelId: providerChat.chat.modelId,
                commitModelId: providerChat.commit.modelId,
            };
        }

        const session = resolveDaemonSessionFromState(daemonSessionId);
        if (!session) return resolveConfiguredModelIds();

        return resolveDaemonVoiceAgentModelIds({
            session: session as any,
            agent: agentCfg ?? {},
        }) ?? resolveConfiguredModelIds();
    };

    const boundTargetSessionId = resolveBoundTargetSessionId(sessionId);
    const boundConversationSessionId = resolveBoundConversationSessionId(sessionId);
    const daemonTargetSessionId = normalizeNonEmptyString(
        boundTargetSessionId ?? (sessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? null : sessionId),
    );
    if (daemonTargetSessionId) {
        await ensureSessionTranscriptReady(daemonTargetSessionId, { forceRefresh: true });
        assertActiveDaemonTargetSession(daemonTargetSessionId);
    } else if (boundTargetSessionId) {
        await ensureSessionTranscriptReady(boundTargetSessionId);
    }
    await ensureSessionTranscriptReady(boundConversationSessionId, { forceRefresh: true });

    const {
        bootstrapInitialContext,
        deferredTargetSessionContext,
    } = resolveVoiceAgentInitialContexts(sessionId, {
        targetSessionId: boundTargetSessionId,
    });

    const shouldFallbackFromDaemon = (error: unknown) => shouldRecoverUnavailableGlobalVoiceAutoMachine(error);

    if (daemonTargetSessionId == null) {
        assertActiveDaemonTargetSession(sessionId);
    }
    await assertDaemonVoiceAgentRuntimeSupported();

    const globalConversationSessionId = resolvePersistedDaemonConversationSessionId();
    const isGlobalVoiceAgent =
        sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
        || sessionId === globalConversationSessionId;
    let daemonConversationSessionId =
        backend === 'daemon' && isGlobalVoiceAgent
            ? normalizeNonEmptyString(globalConversationSessionId ?? boundConversationSessionId)
            : null;

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
        throw Object.assign(new Error('voice_agent_requires_session'), { code: 'VOICE_AGENT_REQUIRES_SESSION' });
    }

    if (backend === 'daemon') {
        await ensureSessionTranscriptReady(daemonConversationSessionId, { forceRefresh: true });
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

    /**
     * The Agent this voice run targets, or `null` when no Agent fact exists.
     *
     * A configured voice Agent is a settings default; an unreadable Session Agent
     * identity is not. Substituting the default Agent there would start the run on
     * a different Agent than the Session actually runs, so the unknown case stays
     * unknown and the callers below skip Agent-keyed work instead.
     */
    const resolveDaemonAgentId = (daemonSessionId: string): string | null => {
        if (agentSource === 'agent') {
            return String(agentId ?? '').trim() || DEFAULT_AGENT_ID;
        }
        const session = resolveDaemonSessionFromState(daemonSessionId);
        return resolveAgentIdFromSessionMetadata(
            session ? readSessionOwnerMetadataView(session) : null,
        );
    };
    let chatModelId = '';
    let commitModelId = '';
    let resolvedAgentId: string | null = null;
    let resolvedBackendTarget: BackendTargetRefV1 | null = null;
    let runMetadataSessionId: string | null = null;
    let persistedRuntimePublication: ReturnType<typeof readPersistedVoiceConversationRuntimePublication> = null;
    let persistedRunMeta: ReturnType<typeof readVoiceAgentRunMetadataFromSession> = null;
    let existingRunId: VoiceAgentStartParams['existingRunId'] = null;
    let startResumeHandle: VoiceAgentStartParams['resumeHandle'] = null;
    const retentionPolicy: NonNullable<VoiceAgentStartParams['retentionPolicy']> =
        backend === 'daemon' && configuredTranscriptPersistenceMode === 'persistent' ? 'resumable' : 'ephemeral';
    const runtimePublicationSupportsTranscriptSource = () =>
        persistedRuntimePublication?.facets?.transcriptSource?.supported === true;
    const shouldUseProviderResume = () =>
        backend === 'daemon'
        && configuredTranscriptPersistenceMode === 'persistent'
        && resumabilityMode === 'provider_resume'
        && runtimePublicationSupportsTranscriptSource();

    const refreshPersistedRunState = (metadataSessionId: string | null) => {
        persistedRuntimePublication = readPersistedVoiceConversationRuntimePublication({
            managedSessionId: sessionId,
            conversationSessionId: metadataSessionId ?? daemonConversationSessionId,
        });
        persistedRunMeta = metadataSessionId ? readVoiceAgentRunMetadataFromSession({ sessionId: metadataSessionId }) : null;
        const allowPersistedRunIdReuse =
            configuredTranscriptPersistenceMode !== 'persistent' || shouldUseProviderResume();
        const matchesResolvedBackend =
            resolvedBackendTarget != null
                ? doesVoiceAgentRunMetadataMatchBackendTarget(persistedRunMeta, resolvedBackendTarget)
                : false;
        existingRunId =
            allowPersistedRunIdReuse && persistedRunMeta && matchesResolvedBackend
                ? persistedRunMeta.runId
                : null;
        const resumeHandle = persistedRunMeta && matchesResolvedBackend ? persistedRunMeta.resumeHandle : null;
        startResumeHandle = shouldUseProviderResume() ? resumeHandle : null;
    };

    const requiresPersistentHiddenVoiceTranscript = () =>
        backend === 'daemon'
        && sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
        && configuredTranscriptPersistenceMode === 'persistent';
    const hasPersistentTranscript = (run: any) => run?.transcript?.persistenceMode === 'persistent';
    const doesRunMatchResolvedBackendTarget = (run: any): boolean => {
        if (!resolvedBackendTarget) return false;
        const runTarget = run?.backendTarget;
        if (runTarget?.kind === 'builtInAgent' && typeof runTarget.agentId === 'string' && runTarget.agentId.trim()) {
            return backendTargetsMatch(runTarget, resolvedBackendTarget);
        }
        return typeof run?.backendId === 'string' && run.backendId.trim() === resolvedAgentId;
    };

    const refreshStartState = (nextBackend: 'daemon', nextRpcSessionId: string) => {
        rpcSessionId = nextRpcSessionId;
        ({ chatModelId, commitModelId } = resolveModelIds(nextBackend, nextRpcSessionId));
        if (nextBackend !== 'daemon') {
            resolvedAgentId = String(agentId ?? '').trim() || null;
            runMetadataSessionId = null;
            persistedRuntimePublication = null;
            persistedRunMeta = null;
            existingRunId = null;
            startResumeHandle = null;
            return;
        }

        resolvedAgentId = resolveDaemonAgentId(nextRpcSessionId);
        resolvedBackendTarget = resolvedAgentId ? { kind: 'builtInAgent', agentId: resolvedAgentId } : null;
        runMetadataSessionId =
            resolveVoiceRunMetadataSessionId(sessionId, nextBackend, daemonConversationSessionId);
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
    const bootstrap = resolveVoiceAgentBootstrapConfig({
        settings,
        agentCfg,
        backend,
        initialContext: effectiveInitialContext,
    });

    const client: VoiceAgentClient = getDaemonVoiceAgentClient();

    const startArgsBase = buildVoiceAgentStartArgsBase({
        agentSource,
        profileId: normalizeNonEmptyString(
            (() => {
                const session = resolveDaemonSessionFromState(rpcSessionId);
                return session ? readSessionOwnerMetadataView(session)?.profileId : null;
            })(),
        ),
        verbosity,
        permissionIntent,
        idleTtlSeconds,
        bootstrap,
    });
    const buildStartTranscript = (nextBackend: 'daemon') => resolveTranscriptConfig(nextBackend);

    const started = await (async () => {
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
            if (
                configuredTranscriptPersistenceMode === 'persistent'
                && resumabilityMode === 'provider_resume'
                && !runtimePublicationSupportsTranscriptSource()
            ) {
                for (const matchingRun of matchingRuns) {
                    await sessionExecutionRunStop(rpcSessionId, { runId: matchingRun.runId }).catch(() => {});
                }
                await clearVoiceAgentRunMetadata(runMetadataSessionId).catch(() => {});
                persistedRunMeta = null;
                existingRunId = null;
                startResumeHandle = null;
                return;
            }
            existingRunId = adoptedRun.runId;
            const adoptedResumeHandle = adoptedRunGet?.run?.resumeHandle ?? adoptedRun.resumeHandle ?? null;
            startResumeHandle = shouldUseProviderResume() ? adoptedResumeHandle : null;
            if (resolvedBackendTarget) {
                await persistVoiceAgentRunMetadata(runMetadataSessionId, {
                    runId: adoptedRun.runId,
                    backendTarget: resolvedBackendTarget,
                    resumeHandle: adoptedResumeHandle,
                });
            }

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
                ...(providerChat
                    ? {
                        chatModelSelection: providerChat.chat,
                        commitModelSelection: providerChat.commit,
                    }
                    : {}),
                ...(providerChat && providerChat.configuration.temperature !== null
                    ? {
                        sessionConfigOptionOverrides: {
                            v: 1 as const,
                            updatedAt: 0,
                            overrides: {
                                temperature: {
                                    updatedAt: 0,
                                    value: providerChat.configuration.temperature,
                                },
                            },
                        },
                    }
                    : {}),
                ...(buildStartTranscript(backend) ? { transcript: buildStartTranscript(backend) } : {}),
                ...(backend === 'daemon'
                    ? {
                        commitIsolation: agentCfg?.commitIsolation === true,
                        existingRunId,
                        resumeWhenInactive: shouldUseProviderResume(),
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
                    if (shouldUseProviderResume()) {
                        if (!startResumeHandle && !fallbackToReplay) throw error;
                        return await startOnce({ existingRunId: null, resumeWhenInactive: true, resumeHandle: startResumeHandle });
                    }
                    return await startOnce({ existingRunId: null, resumeWhenInactive: false, resumeHandle: null });
                }
                if (canRetryFreshStart && isNotAllowed && shouldUseProviderResume() && startResumeHandle) {
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
            await ensureExistingGlobalDaemonRunHasPersistentTranscript();
            await reconcileExistingDaemonRuns();
            return await startDaemonForCurrentSession();
        } catch (error) {
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
                    await ensureExistingGlobalDaemonRunHasPersistentTranscript();
                    await reconcileExistingDaemonRuns();
                    return await startDaemonForCurrentSession();
                }
            }
            throw error;
        }
    })();

    if (runMetadataSessionId && resolvedBackendTarget) {
        try {
            const getRes: any = await sessionExecutionRunGet(rpcSessionId, { runId: started.voiceAgentId, includeStructured: false });
            const resumeHandle = getRes?.run?.resumeHandle ?? null;
            await persistVoiceAgentRunMetadata(runMetadataSessionId, {
                runId: started.voiceAgentId,
                backendTarget: resolvedBackendTarget,
                resumeHandle,
            });
        } catch {
            // best-effort; persistence should not block voice usage
        }
    }

    if (deferredTargetSessionContext.trim().length > 0) {
        setDeferredTargetSessionContext(sessionId, deferredTargetSessionContext);
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
