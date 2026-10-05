import {
    resolveAgentIdFromSessionMetadata,
    type PermissionIntent,
} from '@happier-dev/agents';
import {
    storage,
} from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import type { BackendTargetRefV1, ExecutionRunPublicState } from '@happier-dev/protocol';
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
import { backendTargetKeysMatch } from '@/agents/backendCatalog/backendTargetKeyV2';
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
    resolveBoundTargetSessionAddress,
    resolvePersistedDaemonConversationSessionId,
    resolveVoiceRunMetadataSessionId,
    resolveVoiceAgentSessionFromState,
    type VoiceAgentSessionState,
} from '@/voice/agent/voiceAgentRunState';
import { readLocalConversationSettingsFromAccountSettings } from '@/voice/local/localVoiceSettings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type InitializeVoiceAgentHandleParams = Readonly<{
    sessionId: string;
    getDaemonVoiceAgentClient: (scope: ServerAccountScope) => VoiceAgentClient;
    setDeferredTargetSessionContext: (sessionId: string, update: string) => void;
}>;

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
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime) throw new Error('voice_agent_account_scope_unavailable');
    const assertAccountCurrent = () => {
        if (!accountLifetime.isCurrent()) throw new Error('voice_agent_account_scope_retired');
    };
    const runOptions = { scope: accountLifetime.scope };
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
    const admittedVoice = voiceSettingsParse(settings.voice);
    const voicePolicy = {
        assistantLanguage: normalizeNonEmptyString(admittedVoice.assistantLanguage),
        welcome: { enabled: admittedVoice.welcome.enabled, mode: admittedVoice.welcome.mode },
    } satisfies NonNullable<VoiceAgentStartParams['voicePolicy']>;
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
            || !backendTargetKeysMatch(providerChat.chat.agentTargetKey, expectedTargetKey)
            || !backendTargetKeysMatch(providerChat.commit.agentTargetKey, expectedTargetKey)
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

    const resolveDaemonSessionFromState = (target: SessionAddress | string): VoiceAgentSessionState | null => (
        resolveVoiceAgentSessionFromState(target)
    );

    const hydratedSessions = new Set<string>();
    const ensureSessionTranscriptReady = async (
        target: SessionAddress | string | null,
        options?: Readonly<{ forceRefresh?: boolean }>,
    ): Promise<void> => {
        const normalizedSessionId = normalizeNonEmptyString(
            typeof target === 'string' ? target : target?.sessionId,
        );
        if (!normalizedSessionId) {
            return;
        }
        const serverId = typeof target === 'object' && target
            ? normalizeNonEmptyString(target.serverId)
            : null;
        const hydrationKey = serverId
            ? sessionAddressKey({ serverId, sessionId: normalizedSessionId })
            : JSON.stringify(['legacy_unscoped_session', normalizedSessionId]);
        if (hydratedSessions.has(hydrationKey)) return;
        hydratedSessions.add(hydrationKey);
        await Promise.resolve(
            sync.ensureSessionVisibleForMessageRoute(normalizedSessionId, {
                ...options,
                ...(serverId ? { serverId } : {}),
            }),
        ).catch(() => {});
        if (!serverId || areServerProfileIdentifiersEquivalent(serverId, getActiveServerSnapshot().serverId)) {
            await Promise.resolve(sync.refreshSessionMessages(normalizedSessionId)).catch(() => {});
        }
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

    const throwVoiceAgentSelectionUnavailable = (): never => {
        throw Object.assign(new Error('voice_agent_selection_unavailable'), {
            code: 'VOICE_AGENT_SELECTION_UNAVAILABLE',
        });
    };

    const resolveModelIds = (
        backend: 'daemon',
        daemonSessionId: string,
        targetAddress?: SessionAddress | null,
    ) => {
        if (providerChat) {
            return {
                chatModelId: providerChat.chat.modelId,
                commitModelId: providerChat.commit.modelId,
            };
        }

        const session = resolveDaemonSessionFromState(targetAddress ?? daemonSessionId);
        if (!session) return resolveConfiguredModelIds();

        return resolveDaemonVoiceAgentModelIds({
            modelMode: typeof session.modelMode === 'string' ? session.modelMode : null,
            metadata: readVoiceSessionOwnerMetadataFromState(storage.getState(), targetAddress ?? daemonSessionId),
            agent: agentCfg ?? {},
        }) ?? resolveConfiguredModelIds();
    };

    const boundTargetSessionAddress = resolveBoundTargetSessionAddress(sessionId);
    const boundTargetSessionId = boundTargetSessionAddress?.sessionId ?? null;
    const boundConversationSessionId = resolveBoundConversationSessionId(sessionId);
    const daemonTargetSessionId = normalizeNonEmptyString(
        boundTargetSessionId ?? (sessionId === VOICE_AGENT_GLOBAL_SESSION_ID ? null : sessionId),
    );
    if (daemonTargetSessionId) {
        await ensureSessionTranscriptReady(
            boundTargetSessionAddress?.sessionId === daemonTargetSessionId
                ? boundTargetSessionAddress
                : daemonTargetSessionId,
            { forceRefresh: true },
        );
        if (agentSource === 'session') {
            const targetAgentId = resolveAgentIdFromSessionMetadata(
                readVoiceSessionOwnerMetadataFromState(storage.getState(), boundTargetSessionAddress ?? daemonTargetSessionId),
            );
            if (!targetAgentId) throwVoiceAgentSelectionUnavailable();
        }
        // Keep the bound target's Home: capability is answered by that Home's daemon projection.
        await assertActiveDaemonTargetSession(
            boundTargetSessionAddress?.sessionId === daemonTargetSessionId
                ? boundTargetSessionAddress
                : daemonTargetSessionId,
        );
    } else if (boundTargetSessionId) {
        await ensureSessionTranscriptReady(boundTargetSessionId);
    }
    await ensureSessionTranscriptReady(boundConversationSessionId, { forceRefresh: true });

    const {
        bootstrapInitialContext,
        deferredTargetSessionContext,
    } = resolveVoiceAgentInitialContexts(sessionId, {
        targetSessionAddress: boundTargetSessionAddress,
    });

    const shouldFallbackFromDaemon = (error: unknown) => shouldRecoverUnavailableGlobalVoiceAutoMachine(error);

    if (daemonTargetSessionId == null) {
        await assertActiveDaemonTargetSession(sessionId);
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
    const resolveDaemonAgentId = (
        daemonSessionId: string,
        targetAddress?: SessionAddress | null,
    ): string | null => {
        if (agentSource === 'agent') {
            return String(agentId ?? '').trim() || DEFAULT_AGENT_ID;
        }
        return resolveAgentIdFromSessionMetadata(
            readVoiceSessionOwnerMetadataFromState(storage.getState(), targetAddress ?? daemonSessionId),
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
    let retainedRunState: ExecutionRunPublicState | null = null;
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
    const hasPersistentTranscript = (run: ExecutionRunPublicState | null | undefined) =>
        run?.transcript?.persistenceMode === 'persistent';
    const doesRunMatchResolvedBackendTarget = (run: ExecutionRunPublicState): boolean => {
        if (!resolvedBackendTarget) return false;
        return backendTargetKeysMatch(run.backendTarget, resolvedBackendTarget);
    };

    const refreshStartState = (nextBackend: 'daemon', nextRpcSessionId: string) => {
        assertAccountCurrent();
        retainedRunState = null;
        rpcSessionId = nextRpcSessionId;
        const targetAddress = boundTargetSessionAddress?.sessionId === nextRpcSessionId
            ? boundTargetSessionAddress
            : null;
        ({ chatModelId, commitModelId } = resolveModelIds(nextBackend, nextRpcSessionId, targetAddress));
        if (nextBackend !== 'daemon') {
            resolvedAgentId = String(agentId ?? '').trim() || null;
            runMetadataSessionId = null;
            persistedRuntimePublication = null;
            persistedRunMeta = null;
            existingRunId = null;
            startResumeHandle = null;
            return;
        }

        resolvedAgentId = resolveDaemonAgentId(nextRpcSessionId, targetAddress);
        resolvedBackendTarget = resolvedAgentId ? { kind: 'builtInAgent', agentId: resolvedAgentId } : null;
        runMetadataSessionId =
            resolveVoiceRunMetadataSessionId(sessionId, nextBackend, daemonConversationSessionId);
        refreshPersistedRunState(runMetadataSessionId);
    };
    refreshStartState(backend, rpcSessionId);
    if (backend === 'daemon' && agentSource === 'session' && !resolvedAgentId) {
        throwVoiceAgentSelectionUnavailable();
    }
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

    assertAccountCurrent();
    const client: VoiceAgentClient = getDaemonVoiceAgentClient(accountLifetime.scope);

    const startArgsBase = buildVoiceAgentStartArgsBase({
        agentSource,
        profileId: normalizeNonEmptyString(
            (() => {
                const targetAddress = boundTargetSessionAddress?.sessionId === rpcSessionId
                    ? boundTargetSessionAddress
                    : null;
                return readVoiceSessionOwnerMetadataFromState(storage.getState(), targetAddress ?? rpcSessionId)?.profileId;
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
            const existingRunGet = await sessionExecutionRunGet(rpcSessionId, {
                runId: existingRunId,
                includeStructured: false,
            }, runOptions).catch(() => null);
            if (existingRunGet && 'run' in existingRunGet && hasPersistentTranscript(existingRunGet.run)) {
                retainedRunState = existingRunGet.run;
                return;
            }
            await sessionExecutionRunStop(rpcSessionId, { runId: existingRunId }, runOptions).catch(() => {});
            await clearVoiceAgentRunMetadata(runMetadataSessionId, accountLifetime).catch(() => {});
            persistedRunMeta = null;
            existingRunId = null;
            startResumeHandle = null;
        };

        const reconcileExistingDaemonRuns = async () => {
            if (backend !== 'daemon' || !runMetadataSessionId || !resolvedAgentId) return;
            const listed = await sessionExecutionRunList(rpcSessionId, {}, runOptions);
            if (!('runs' in listed)) return;

            const matchingRuns = listed.runs
                .filter((run) =>
                    run.intent === 'voice_agent'
                    && run.status === 'running'
                    && doesRunMatchResolvedBackendTarget(run),
                )
                .sort((left, right) => {
                    if (right.startedAtMs !== left.startedAtMs) return right.startedAtMs - left.startedAtMs;
                    return left.runId.localeCompare(right.runId);
                });
            if (matchingRuns.length === 0) return;

            const adoptedRun = matchingRuns[0]!;
            const adoptedRunGet = await sessionExecutionRunGet(rpcSessionId, {
                runId: adoptedRun.runId,
                includeStructured: false,
            }, runOptions);
            const adoptedRunState = 'run' in adoptedRunGet ? adoptedRunGet.run : null;
            if (requiresPersistentHiddenVoiceTranscript() && !hasPersistentTranscript(adoptedRunState)) {
                for (const matchingRun of matchingRuns) {
                    await sessionExecutionRunStop(rpcSessionId, { runId: matchingRun.runId }, runOptions).catch(() => {});
                }
                await clearVoiceAgentRunMetadata(runMetadataSessionId, accountLifetime).catch(() => {});
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
                    await sessionExecutionRunStop(rpcSessionId, { runId: matchingRun.runId }, runOptions).catch(() => {});
                }
                await clearVoiceAgentRunMetadata(runMetadataSessionId, accountLifetime).catch(() => {});
                persistedRunMeta = null;
                existingRunId = null;
                startResumeHandle = null;
                return;
            }
            existingRunId = adoptedRun.runId;
            retainedRunState = adoptedRunState ?? adoptedRun;
            const adoptedResumeHandle = adoptedRunState?.resumeHandle ?? adoptedRun.resumeHandle ?? null;
            startResumeHandle = shouldUseProviderResume() ? adoptedResumeHandle : null;
            if (resolvedBackendTarget) {
                await persistVoiceAgentRunMetadata(runMetadataSessionId, {
                    accountLifetime,
                    runId: adoptedRun.runId,
                    backendTarget: resolvedBackendTarget,
                    resumeHandle: adoptedResumeHandle,
                });
            }

            const duplicateRuns = matchingRuns.slice(1);
            for (const duplicateRun of duplicateRuns) {
                await sessionExecutionRunStop(rpcSessionId, { runId: duplicateRun.runId }, runOptions).catch(() => {});
            }
        };

        const buildStartParams = (overrides?: Partial<Pick<VoiceAgentStartParams, 'existingRunId' | 'resumeWhenInactive' | 'resumeHandle'>>) =>
            ({
                sessionId: rpcSessionId,
                ...startArgsBase,
                voicePolicy,
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

        const startOnce = (overrides?: Partial<Pick<VoiceAgentStartParams, 'existingRunId' | 'resumeWhenInactive' | 'resumeHandle'>>) => {
            assertAccountCurrent();
            return client.start(buildStartParams(overrides));
        };

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
                    if (agentSource === 'session' && !resolvedAgentId) {
                        throwVoiceAgentSelectionUnavailable();
                    }
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
        // A policy snapshot is needed even if persisting the optional resume
        // pointer fails. A prior adoption read can still prove the same Run.
        const getRes = await sessionExecutionRunGet(rpcSessionId, { runId: started.voiceAgentId, includeStructured: false }, runOptions).catch(() => null);
        if (getRes && 'run' in getRes) retainedRunState = getRes.run;
        try {
            const resumeHandle = getRes && 'run' in getRes ? getRes.run.resumeHandle ?? null : null;
            await persistVoiceAgentRunMetadata(runMetadataSessionId, {
                accountLifetime,
                runId: started.voiceAgentId,
                backendTarget: resolvedBackendTarget,
                resumeHandle,
            });
        } catch {
            // best-effort; persistence should not block voice usage
        }
    }

    if (!accountLifetime.isCurrent()) {
        await client.stop({ sessionId: rpcSessionId, voiceAgentId: started.voiceAgentId }).catch(() => {});
        assertAccountCurrent();
    }

    if (started.voiceAgentId === existingRunId && retainedRunState?.runId !== started.voiceAgentId) {
        // Do not present fresh preferences as the retained daemon's policy.
        // Leave that Run intact so a later initialization can retry the read.
        throw Object.assign(new Error('The retained Voice policy is unavailable; retry the connection'), {
            code: 'VOICE_AGENT_POLICY_UNAVAILABLE' as const,
        });
    }

    if (deferredTargetSessionContext.trim().length > 0) {
        setDeferredTargetSessionContext(sessionId, deferredTargetSessionContext);
    }

    clearVoiceAgentRecoveryReplaySource(sessionId);

    return {
        accountLifetime,
        // A fresh fallback start uses its new admission. Only this exact
        // retained Run can override the current Account preference snapshot.
        voicePolicy: retainedRunState?.runId === started.voiceAgentId
            ? retainedRunState.voicePolicy ?? voicePolicy
            : voicePolicy,
        metadataSessionId: runMetadataSessionId,
        client,
        voiceAgentId: started.voiceAgentId,
        backend,
        rpcSessionId,
        agentBackendId: backend === 'daemon' ? resolvedAgentId : null,
    };
}
