/**
 * Session operations for remote procedure calls
 */

import { apiSocket } from '../api/session/apiSocket';
import { publishDisplayTitleToMetadata } from '@/sync/state/displayTitlePublish';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { createRpcCallError, isRpcMethodNotAvailableError, readRpcErrorCode as readSessionRpcErrorCode } from '../runtime/rpcErrors';
import { assertRpcResponseWithSuccess } from '../runtime/assertRpcResponseWithSuccess';
import { buildResumeHappySessionRpcParams, type ResumeHappySessionRpcParams } from '../domains/session/resume/resumeSessionPayload';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '../domains/session/spawn/spawnSessionRpcTimeout';
import { storage } from '../domains/state/storage';
import { nowServerMs } from '../runtime/time';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { emitSessionMetadataUpdateWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/emitSessionMetadataUpdateWithServerScope';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import type {
    ServerAccountSessionRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import { sessionRpcWithPreferredSessionScope } from '@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import { prepareAccountSettingsForDaemonSpawnIfNeeded } from './accountSettingsDaemonSpawnPreparation';
import type {
    BackendTargetRefV2Input,
    BackendTargetRefV1,
    CheckpointCodeRollbackRequest,
    CheckpointCodeRollbackResult,
    LlmTaskRunnerConfigV1,
    SessionAttachMetadataIdentityPolicy,
    SessionContinueWithReplayRpcResult,
    SessionAuthoringValueV1,
    SessionInitialGoalRequestV1,
    SessionModelSelectionV1,
    SessionForkPoint,
    SessionForkRpcResult,
    SessionForkStrategy,
    SessionRollbackRpcResult,
    SessionRollbackTarget,
    SpawnSessionExecutionAuthorization,
    SpawnSessionResult,
} from '@happier-dev/protocol';
import { readBackendTargetRefV2 } from '@happier-dev/protocol';
import type { AgentId } from '@/agents/catalog/catalog';
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';
import {
    SessionContinueWithReplayRpcResultSchema,
    CheckpointCodeRollbackResultSchema,
    SessionForkRpcResultSchema,
    SessionRollbackRpcResultSchema,
    SessionAuthoringValueV1Schema,
    SPAWN_SESSION_ERROR_CODES,
} from '@happier-dev/protocol';
import type { StructuredQuestionAnswersV1 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { normalizeSpawnSessionResult } from './_shared';
import { isAccountSettingsScopeChangedDuringSpawnPreparationError } from '@/sync/engine/settings/accountSettingsSpawnPreparationError';
import { isSocketIoAckTimeoutError } from '@/sync/runtime/socketIoAckTimeout';
import { readMachineControlTargetForSession } from './sessionMachineTarget';
import { stopSessionUsingCanonicalStrategy } from './sessionStopStrategy';
import {
    isProviderSafeDaemonSessionMethodAbsent,
    requiresProviderSafeSessionRpc,
} from './providerDaemonSessionCompatibility';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { buildResumeCapabilityOptionsFromUiState } from '@/agents/registry/registryUiBehavior';
import { getPendingQueueWakeResumeOptions } from '@/sync/domains/pending/pendingQueueWake';
export {
    sessionScmBranchCheckout,
    sessionScmBranchCreate,
    sessionScmBranchMerge,
    sessionScmBranchOperationAbort,
    sessionScmBranchOperationContinue,
    sessionScmBranchRebase,
    sessionScmBranchList,
    sessionScmChangeDiscard,
    sessionScmChangeExclude,
    sessionScmChangeInclude,
    sessionScmCommitBackout,
    sessionScmCommitCreate,
    sessionScmDiffCommit,
    sessionScmDiffFile,
    sessionScmLogList,
    sessionScmRemoteAdd,
    sessionScmRemoteFetch,
    sessionScmRemotePull,
    sessionScmRemotePublish,
    sessionScmRemoteRemove,
    sessionScmRemotePush,
    sessionScmRemoteSetUrl,
    sessionScmHostingRepositoryDescribePublishTargets,
    sessionScmHostingRepositoryPublish,
    sessionScmPullRequestOpenCompose,
    sessionScmPullRequestOpenOrReuse,
    sessionScmRepositoryInit,
    sessionScmRepositoryRemoveIndexLock,
    sessionScmStatusSnapshot,
    sessionScmStashApply,
    sessionScmStashDrop,
    sessionScmStashList,
    sessionScmStashPop,
    sessionScmStashShow,
} from './sessionScm';

// Permission operation types
interface SessionPermissionRequest {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
    execPolicyAmendment?: {
        command: string[];
    };
    /**
     * Optional permission updates to apply inside the agent runtime (provider-specific).
     * This is used to accept provider-suggested permission changes (e.g. Claude Agent SDK `permission_suggestions`).
     */
    updatedPermissions?: unknown;
    /**
     * AskUserQuestion: structured answers keyed by question text.
     * When present, the agent can complete the tool call without requiring a follow-up user message.
     */
    answers?: StructuredQuestionAnswersV1;
}

// Mode change operation types
interface SessionModeChangeRequest {
    to: 'remote' | 'local';
}

// Bash operation types
interface SessionBashRequest {
    command: string;
    cwd?: string;
    timeout?: number;
}

interface SessionBashResponse {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}

// Read file operation types
// Session log tail operation types
interface SessionReadLogTailRequest {
    maxBytes?: number;
}

interface SessionReadLogTailResponse {
    success: boolean;
    path?: string;
    tail?: string;
    truncated?: boolean;
    bytesRead?: number;
    totalBytes?: number;
    error?: string;
}

// Ripgrep operation types
interface SessionRipgrepRequest {
    args: string[];
    cwd?: string;
}

interface SessionRipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

// Response types for spawn session
export type ResumeSessionResult = SpawnSessionResult;

/**
 * Options for resuming an inactive session.
 */
export interface ResumeSessionOptions {
    /** The Happy session ID to resume */
    sessionId: string;
    /** The machine ID where the session was running */
    machineId: string;
    /** The directory where the session was running */
    directory: string;
    /** The backend target to resume */
    backendTarget: import('@happier-dev/protocol').BackendTargetRefV2Input;
    /** Optional vendor resume id (e.g. Claude/Codex session id). */
    resume?: string;
    environmentVariables?: Record<string, string>;
    connectedServices?: unknown;
    connectedServicesUpdatedAt?: number;
    transcriptStorage?: 'direct' | 'persisted';
    attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy;
    /** Optional explicit server scope for resume spawn routing. */
    serverId?: string;
    /**
     * Optional: publish an explicit UI-selected permission mode at resume time.
     * Use only when the UI selection is newer than metadata.permissionModeUpdatedAt.
     */
    permissionMode?: PermissionMode;
    permissionModeUpdatedAt?: number;
    /** Optional explicit target-bound model selection. Omission means keep the persisted session intent. */
    modelSelection?: SessionModelSelectionV1;
    /**
     * Legacy transport fallback for older daemon boundaries.
     * Prefer codexBackendMode for new resume callers.
     */
    experimentalCodexAcp?: boolean;
    codexBackendMode?: import('@happier-dev/protocol').CodexBackendMode;
    runtimeDescriptorV1?: import('@happier-dev/protocol').RuntimeDescriptorV1;
    /**
     * Transcript cursor to use when the resume request is caused by a just-committed
     * wake message. The daemon should catch up after this seq so that prompt is
     * consumed without replaying older turns.
     */
    initialTranscriptAfterSeq?: number;
    executionAuthorization?: SpawnSessionExecutionAuthorization;
    initialGoal?: SessionInitialGoalRequestV1;
    /**
     * Internal daemon freshness barrier. Resume callers should normally omit this and let
     * `resumeSession` capture a freshly flushed account-settings version at the RPC boundary.
     */
    accountSettingsVersionHint?: number;
    /**
     * When true, use the requested machine/directory even if the current session metadata
     * still points at a previously reachable machine. This is required for session handoff
     * cutover where the source machine target remains visible until metadata is patched.
     */
    preferRequestedMachineTarget?: boolean;
    /**
     * When true, skip the active-machine RPC path and use server-scoped machine RPC directly.
     * This is required for cross-machine handoff cutover where the target daemon may not be
     * reachable yet through the app's active machine socket route.
     */
    preferScopedMachineRpc?: boolean;
}

/**
 * Resume an inactive session by spawning a new CLI process that reconnects
 * to the existing Happy session and resumes the agent.
 */
export async function resumeSession(options: ResumeSessionOptions): Promise<ResumeSessionResult> {
    let providerSafeRpcRequired = false;
    storage.getState().markSessionResuming(options.sessionId);
    try {
        const serverId = typeof options.serverId === 'string' ? options.serverId.trim() : null;
        const session = storage.getState().sessions[options.sessionId];
        if (session?.archivedAt != null) {
            const unarchiveResult = await sessionUnarchiveWithServerScope(options.sessionId, { serverId });
            if (!unarchiveResult.success) {
                storage.getState().clearSessionResuming(options.sessionId);
                return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: unarchiveResult.message ?? 'Failed to unarchive session',
                };
            }
        }

        const {
            sessionId,
            machineId: rawMachineId,
            directory: rawDirectory,
            backendTarget,
            resume,
            environmentVariables,
            connectedServices,
            connectedServicesUpdatedAt,
            transcriptStorage,
            attachMetadataIdentityPolicy,
            permissionMode,
            permissionModeUpdatedAt,
            modelSelection,
            experimentalCodexAcp,
            codexBackendMode,
            runtimeDescriptorV1,
            accountSettingsVersionHint,
            initialTranscriptAfterSeq,
            executionAuthorization,
            initialGoal,
            preferRequestedMachineTarget,
            preferScopedMachineRpc,
        } = options;

        const machineTarget = readMachineControlTargetForSession(sessionId);
        const machineId = preferRequestedMachineTarget ? rawMachineId.trim() : machineTarget?.machineId ?? rawMachineId.trim();
        const directory = preferRequestedMachineTarget ? rawDirectory.trim() : machineTarget?.basePath ?? rawDirectory.trim();
        if (!machineId || !directory) {
            storage.getState().clearSessionResuming(sessionId);
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'No reachable machine target found to resume session',
            };
        }

        const storedSession = storage.getState().sessions[sessionId];
        const storedSessionOwnerMetadata = storedSession
            ? readSessionOwnerMetadataView(storedSession)
            : null;
        providerSafeRpcRequired = requiresProviderSafeSessionRpc({
            modelSelection,
            existingSessionMetadata: storedSessionOwnerMetadata
                ? { state: 'known', metadata: storedSessionOwnerMetadata }
                : { state: 'unknown' },
        });

        const preparation = await prepareAccountSettingsForDaemonSpawnIfNeeded(options.accountSettingsVersionHint);

        const parsedConnectedServicesRaw: SessionAuthoringValueV1['connectedServices'] | undefined =
            connectedServices === undefined
                ? undefined
                : (SessionAuthoringValueV1Schema.shape.connectedServices.parse(connectedServices) as SessionAuthoringValueV1['connectedServices']);
        const parsedConnectedServices = parsedConnectedServicesRaw == null ? undefined : parsedConnectedServicesRaw;
        const params: ResumeHappySessionRpcParams = buildResumeHappySessionRpcParams({
            sessionId,
            directory,
            backendTarget,
            ...(resume ? { resume } : {}),
            ...(environmentVariables ? { environmentVariables } : {}),
            ...(parsedConnectedServices !== undefined ? { connectedServices: parsedConnectedServices } : {}),
            ...(parsedConnectedServices !== undefined && typeof connectedServicesUpdatedAt === 'number' && Number.isFinite(connectedServicesUpdatedAt)
                ? { connectedServicesUpdatedAt }
                : {}),
            ...(transcriptStorage ? { transcriptStorage } : {}),
            ...(attachMetadataIdentityPolicy ? { attachMetadataIdentityPolicy } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(typeof permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt } : {}),
            ...(modelSelection ? { modelSelection } : {}),
            ...(typeof accountSettingsVersionHint === 'number' ? { accountSettingsVersionHint } : {}),
            ...(typeof initialTranscriptAfterSeq === 'number' ? { initialTranscriptAfterSeq } : {}),
            ...(executionAuthorization ? { executionAuthorization } : {}),
            ...(initialGoal ? { initialGoal } : {}),
            ...preparation,
            experimentalCodexAcp,
            codexBackendMode,
            ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
        });

        const result = await machineRpcWithServerScope<unknown, ResumeHappySessionRpcParams>({
            machineId,
            method: providerSafeRpcRequired
                ? RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
                : RPC_METHODS.SPAWN_HAPPY_SESSION,
            payload: params,
            serverId,
            timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv(),
            ...(preferScopedMachineRpc ? { preferScoped: true } : {}),
        });
        const normalizedResult = normalizeSpawnSessionResult(result);
        if (normalizedResult.type === 'error') {
            storage.getState().clearSessionResuming(sessionId);
        } else {
            storage.getState().armSessionResumingFallback(sessionId);
        }
        return normalizedResult;
    } catch (error) {
        storage.getState().clearSessionResuming(options.sessionId);
        if (isAccountSettingsScopeChangedDuringSpawnPreparationError(error)) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.ACCOUNT_SCOPE_CHANGED,
                errorMessage: 'Account changed while syncing settings. Please retry from the current account.',
            };
        }
        if (
            (providerSafeRpcRequired && isProviderSafeDaemonSessionMethodAbsent(error))
            || isRpcMethodNotAvailableError(error)
            || readSessionRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        ) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage:
                    `Daemon RPC is not available (RPC method not available). ` +
                    `The daemon may be stopped, still starting, or not connected to the server.`,
            };
        }
        if (isSocketIoAckTimeoutError(error)) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
                errorMessage: 'Session startup timed out',
            };
        }
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: error instanceof Error ? error.message : 'Failed to resume session'
        };
    }
}

export type ContinueSessionWithReplayOptions = Readonly<{
    machineId: string;
    serverId?: string | null;
    directory: string;
    agent: AgentId;
    backendTarget?: BackendTargetRefV2Input;
    approvedNewDirectoryCreation?: boolean;
    permissionMode?: PermissionMode;
    permissionModeUpdatedAt?: number;
    modelSelection?: SessionModelSelectionV1;
    replay: Readonly<{
        previousSessionId: string;
        strategy?: 'recent_messages' | 'summary_plus_recent';
        recentMessagesCount?: number;
        maxSeedChars?: number;
        seedMode?: 'draft' | 'daemon_initial_prompt';
        summaryRunner?: LlmTaskRunnerConfigV1;
    }>;
}>;

export async function continueSessionWithReplay(options: ContinueSessionWithReplayOptions): Promise<SessionContinueWithReplayRpcResult> {
    const serverId = typeof options.serverId === 'string' ? options.serverId.trim() : null;
    const replayTarget = readMachineControlTargetForSession(options.replay.previousSessionId);
    const machineId = replayTarget?.machineId ?? options.machineId;
    const directory = replayTarget?.basePath ?? options.directory;
    const canonicalAgent = isLegacyCompatAgentType(options.agent) ? undefined : options.agent;
    const backendTarget = options.backendTarget
        ? readBackendTargetRefV2(options.backendTarget)
        : (canonicalAgent
            ? readBackendTargetRefV2({ kind: 'builtInAgent', agentId: canonicalAgent } as const)
            : undefined);
    const legacyAgent = backendTarget?.kind === 'backend'
        ? backendTarget.sourceKind === 'configured'
            ? canonicalAgent
            : backendTarget.backendId
        : canonicalAgent;
    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId,
            method: RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
            payload: {
                directory,
                ...(legacyAgent ? { agent: legacyAgent } : {}),
                ...(backendTarget ? { backendTarget } : {}),
                approvedNewDirectoryCreation: options.approvedNewDirectoryCreation,
                permissionMode: options.permissionMode,
                permissionModeUpdatedAt: options.permissionModeUpdatedAt,
                modelSelection: options.modelSelection,
                replay: options.replay,
            },
            serverId,
        });

        const parsed = SessionContinueWithReplayRpcResultSchema.safeParse(raw);
        if (!parsed.success) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'Unsupported replay response from daemon',
            };
        }
        return parsed.data;
    } catch (error) {
        if (
            isRpcMethodNotAvailableError(error)
            || readSessionRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        ) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage:
                    `Daemon RPC is not available (RPC method not available). ` +
                    `The daemon may be stopped, still starting, or not connected to the server.`,
            };
        }
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: error instanceof Error ? error.message : 'Failed to continue session with replay',
        };
    }
}

export type ForkSessionOptions = Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    parentSessionId: string;
    forkPoint: SessionForkPoint;
    strategy?: SessionForkStrategy;
    replaySummaryRunner?: LlmTaskRunnerConfigV1;
    replayMaxSeedChars?: number;
    /**
     * Stable idempotency key for one user-visible fork attempt. Retries of the
     * SAME attempt must reuse it so the daemon coalesces them onto the in-flight
     * fork instead of committing a second provider-side fork. Callers that have
     * no attempt identity omit it and keep today's behavior.
     */
    requestId?: string;
}>;

export async function forkSession(options: ForkSessionOptions): Promise<SessionForkRpcResult> {
    const serverId = typeof options.serverId === 'string' ? options.serverId.trim() : null;
    const parentTarget = readMachineControlTargetForSession(options.parentSessionId);
    const explicitMachineId = typeof options.machineId === 'string' ? options.machineId.trim() : '';
    const machineId = parentTarget?.machineId ?? explicitMachineId;
    if (!machineId) {
        return {
            ok: false,
            errorCode: 'machine_not_found',
            errorMessage: 'No reachable machine target found for session fork',
        };
    }
    const storedParentSession = storage.getState().sessions[options.parentSessionId];
    const storedParentOwnerMetadata = storedParentSession
        ? readSessionOwnerMetadataView(storedParentSession)
        : null;
    const providerSafeRpcRequired = requiresProviderSafeSessionRpc({
        existingSessionMetadata: storedParentOwnerMetadata
            ? { state: 'known', metadata: storedParentOwnerMetadata }
            : { state: 'unknown' },
    });
    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId,
            method: providerSafeRpcRequired
                ? RPC_METHODS.SESSION_FORK_PROVIDER_SAFE
                : RPC_METHODS.SESSION_FORK,
            payload: {
                v: 1,
                parentSessionId: options.parentSessionId,
                forkPoint: options.forkPoint,
                strategy: options.strategy,
                replaySummaryRunner: options.replaySummaryRunner,
                replayMaxSeedChars: options.replayMaxSeedChars,
                ...(typeof options.requestId === 'string' && options.requestId.trim().length > 0
                    ? { requestId: options.requestId }
                    : {}),
            },
            serverId,
            timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv(),
            // Fork can create durable provider/session state. Once the request is emitted,
            // an acknowledgement timeout is outcome-unknown and must not trigger another route.
            onIssued: () => {},
        });

        const parsed = SessionForkRpcResultSchema.safeParse(raw);
        if (!parsed.success) {
            return { ok: false, errorCode: 'UNEXPECTED', errorMessage: 'Unsupported fork response from daemon' };
        }
        return parsed.data;
    } catch (error) {
        if (
            (providerSafeRpcRequired && isProviderSafeDaemonSessionMethodAbsent(error))
            || isRpcMethodNotAvailableError(error)
            || readSessionRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        ) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
                errorMessage:
                    `Daemon RPC is not available (RPC method not available). ` +
                    `The daemon may be stopped, still starting, or not connected to the server.`,
            };
        }
        return {
            ok: false,
            errorCode: 'UNEXPECTED',
            errorMessage: error instanceof Error ? error.message : 'Failed to fork session',
        };
    }
}

export async function rollbackSessionConversation(options: Readonly<{
    sessionId: string;
    serverId?: string | null;
    target?: SessionRollbackTarget;
}>): Promise<SessionRollbackRpcResult> {
    const target = options.target ?? { type: 'latest_turn' };
    const session = storage.getState().sessions[options.sessionId];
    if (session?.active === false && target.type === 'before_user_message') {
        const state = storage.getState();
        const resumeOptions = getPendingQueueWakeResumeOptions({
            sessionId: options.sessionId,
            session,
            resumeCapabilityOptions: buildResumeCapabilityOptionsFromUiState({
                settings: state.settings,
                results: undefined,
            }),
        });
        if (!resumeOptions) {
            return {
                ok: false,
                errorCode: 'session_rollback_resume_unavailable',
                errorMessage: 'This inactive session cannot be resumed for rollback',
            };
        }

        const serverId = options.serverId ?? resolvePreferredServerIdForSessionId(options.sessionId);
        const resumeResult = await resumeSession({
            ...resumeOptions,
            ...(serverId ? { serverId } : {}),
        });
        if (resumeResult.type === 'error') {
            return {
                ok: false,
                errorCode: resumeResult.errorCode,
                errorMessage: resumeResult.errorMessage,
            };
        }

        const deadlineMs = Date.now() + 30_000;
        while (true) {
            // Resume completes before the child necessarily registers its session RPCs. Retrying
            // only METHOD_NOT_AVAILABLE is safe: it proves rollback execution never started.
            try {
                const raw = await sessionRpcWithServerScope<unknown, unknown>({
                    sessionId: options.sessionId,
                    serverId,
                    method: SESSION_RPC_METHODS.SESSION_ROLLBACK,
                    payload: { v: 1, target },
                });
                const parsed = SessionRollbackRpcResultSchema.safeParse(raw);
                if (!parsed.success) {
                    return {
                        ok: false,
                        errorCode: 'UNEXPECTED',
                        errorMessage: 'Unsupported rollback response from session RPC',
                    };
                }
                if (
                    parsed.data.ok
                    || parsed.data.errorCode !== RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
                    || Date.now() >= deadlineMs
                ) {
                    return parsed.data;
                }
            } catch (error) {
                if (
                    (
                        !isRpcMethodNotAvailableError(error)
                        && readSessionRpcErrorCode(error) !== RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
                    )
                    || Date.now() >= deadlineMs
                ) {
                    if (
                        isRpcMethodNotAvailableError(error)
                        || readSessionRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
                    ) {
                        return {
                            ok: false,
                            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                            errorMessage: 'Session rollback did not become available after resuming the session',
                        };
                    }
                    return {
                        ok: false,
                        errorCode: 'UNEXPECTED',
                        errorMessage: error instanceof Error ? error.message : 'Failed to roll back session conversation',
                    };
                }
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
    }

    try {
        const raw = await sessionRpcWithServerScope<unknown, unknown>({
            sessionId: options.sessionId,
            serverId: options.serverId,
            method: SESSION_RPC_METHODS.SESSION_ROLLBACK,
            payload: {
                v: 1,
                target,
            },
        });
        const parsed = SessionRollbackRpcResultSchema.safeParse(raw);
        if (!parsed.success) {
            return { ok: false, errorCode: 'UNEXPECTED', errorMessage: 'Unsupported rollback response from session RPC' };
        }
        return parsed.data;
    } catch (error) {
        if (isRpcMethodNotAvailableError(error as any) || readSessionRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
            return {
                ok: false,
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                errorMessage: 'Session rollback is not available for this session',
            };
        }
        return {
            ok: false,
            errorCode: 'UNEXPECTED',
            errorMessage: error instanceof Error ? error.message : 'Failed to roll back session conversation',
        };
    }
}

function coerceCheckpointCodeRollbackResult(raw: unknown): CheckpointCodeRollbackResult | null {
    const schema = CheckpointCodeRollbackResultSchema as unknown as { safeParse?: (value: unknown) => { success: boolean; data?: CheckpointCodeRollbackResult } };
    const parsed = typeof schema?.safeParse === 'function' ? schema.safeParse(raw) : null;
    if (parsed?.success && parsed.data) return parsed.data;
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as Partial<CheckpointCodeRollbackResult>;
    if (
        (candidate.status === 'conversation_only'
            || candidate.status === 'applied'
            || candidate.status === 'conflict'
            || candidate.status === 'unavailable'
            || candidate.status === 'aborted')
        && Array.isArray(candidate.changedPaths)
        && Array.isArray(candidate.skippedPaths)
        && Array.isArray(candidate.receipts)
        && Array.isArray(candidate.diagnostics)
    ) {
        return {
            status: candidate.status,
            ...(typeof candidate.backupCheckpointRef === 'string' ? { backupCheckpointRef: candidate.backupCheckpointRef } : {}),
            ...(typeof candidate.gitStashRef === 'string' ? { gitStashRef: candidate.gitStashRef } : {}),
            changedPaths: candidate.changedPaths.filter((path): path is string => typeof path === 'string' && path.length > 0),
            skippedPaths: candidate.skippedPaths.filter((path): path is string => typeof path === 'string' && path.length > 0),
            receipts: candidate.receipts.filter((receipt): receipt is CheckpointCodeRollbackResult['receipts'][number] =>
                receipt === 'checkpoint.rollback_backup_captured'
                || receipt === 'checkpoint.rollback_applied'
                || receipt === 'checkpoint.rollback_conflict'
                || receipt === 'checkpoint.rollback_aborted',
            ),
            diagnostics: candidate.diagnostics.filter((diagnostic): diagnostic is string => typeof diagnostic === 'string' && diagnostic.length > 0),
        };
    }
    return null;
}

export async function rollbackSessionCheckpointCode(options: Readonly<{
    request: CheckpointCodeRollbackRequest;
    serverId?: string | null;
}>): Promise<CheckpointCodeRollbackResult> {
    try {
        const raw = await sessionRpcWithServerScope<unknown, unknown>({
            sessionId: options.request.sessionId,
            serverId: options.serverId,
            method: SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK,
            payload: options.request,
        });
        const parsed = coerceCheckpointCodeRollbackResult(raw);
        if (!parsed) {
            return {
                status: 'unavailable',
                changedPaths: [],
                skippedPaths: [],
                receipts: ['checkpoint.rollback_aborted'],
                diagnostics: ['unsupported_checkpoint_code_rollback_response'],
            };
        }
        return parsed;
    } catch (error) {
        if (isRpcMethodNotAvailableError(error as any) || readSessionRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
            return {
                status: 'unavailable',
                changedPaths: [],
                skippedPaths: [],
                receipts: ['checkpoint.rollback_aborted'],
                diagnostics: ['session_checkpoint_code_rollback_unavailable'],
            };
        }
        return {
            status: 'unavailable',
            changedPaths: [],
            skippedPaths: [],
            receipts: ['checkpoint.rollback_aborted'],
            diagnostics: [error instanceof Error ? error.message : 'failed_to_roll_back_checkpoint_code'],
        };
    }
}

export async function sessionAbort(sessionId: string): Promise<void> {
    try {
        await sessionRpcWithPreferredSessionScope<void, { reason: string }>({
            sessionId,
            method: 'abort',
            payload: {
            reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
            },
        });
    } catch (e) {
        const errorCode = readSessionRpcErrorCode(e);
        if (
            e instanceof Error
            && (
                isRpcMethodNotAvailableError(e)
            )
        ) {
            // Session RPCs are unavailable when no agent process is attached (inactive/resumable).
            // Treat abort as a no-op in that case.
            return;
        }
        if (
            e instanceof Error
            && (
                errorCode === 'scoped_session_encryption_unavailable'
                || errorCode === 'session_encryption_not_found'
            )
        ) {
            // Scoped session RPC encryption can be unavailable when the provider is already detached.
            // Abort is best-effort; do not block follow-up user actions (e.g. sending pending messages).
        } else {
            throw e;
        }
    }

    // Best-effort local UX recovery: aborts should immediately return the session to non-thinking state
    // even if lifecycle events arrive out of order or providers publish intermittent thinking=false.
    const session = storage.getState().sessions[sessionId];
    storage.getState().clearSessionOptimisticThinking(sessionId);
    storage.getState().clearSessionThinkingGrace(sessionId);
    if (!session || session.thinking !== true) {
        return;
    }

    storage.getState().applySessions([
        {
            ...session,
            thinking: false,
            updatedAt: nowServerMs(),
        },
    ]);
}

/**
 * Allow a permission request
 */
export async function sessionAllow(
    sessionId: string,
    id: string,
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    allowedTools?: string[],
    decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment',
    execPolicyAmendment?: { command: string[] }
): Promise<void> {
    const request: SessionPermissionRequest = {
        id,
        approved: true,
        mode,
        allowedTools,
        decision,
        execPolicyAmendment
    };
    await sessionRpcWithPreferredSessionScope<void, SessionPermissionRequest>({
        sessionId,
        method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
        payload: request,
    });
}

/**
 * Allow a permission request and attach provider permission updates.
 *
 * Used when the backend exposes structured permission suggestions that can be applied in-runtime
 * (e.g. Claude Agent SDK `permission_suggestions`).
 */
export async function sessionAllowWithPermissionUpdates(
    sessionId: string,
    id: string,
    params: Readonly<{
        mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
        allowedTools?: string[];
        decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment';
        updatedPermissions: unknown;
    }>,
): Promise<void> {
    const request: SessionPermissionRequest = {
        id,
        approved: true,
        mode: params.mode,
        allowedTools: params.allowedTools,
        decision: params.decision,
        updatedPermissions: params.updatedPermissions,
    };
    await sessionRpcWithPreferredSessionScope<void, SessionPermissionRequest>({
        sessionId,
        method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
        payload: request,
    });
}

/**
 * Allow a permission request and attach structured answers (AskUserQuestion).
 *
 * AskUserQuestion is a user-action request and uses the canonical user-action RPC.
 */
export async function sessionAllowWithAnswers(
    sessionId: string,
    id: string,
    answers: StructuredQuestionAnswersV1,
): Promise<void> {
    const request: SessionPermissionRequest = {
        id,
        approved: true,
        answers,
    };
    await sessionRpcWithPreferredSessionScope<void, SessionPermissionRequest>({
        sessionId,
        method: RPC_METHODS.SESSION_USER_ACTION_ANSWER,
        payload: request,
    });
}

/**
 * Deny a permission request
 */
export async function sessionDeny(
    sessionId: string,
    id: string,
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    allowedTools?: string[],
    decision?: 'denied' | 'abort',
    reason?: string,
): Promise<void> {
    const request: SessionPermissionRequest = { id, approved: false, mode, allowedTools, decision, reason };
    await sessionRpcWithPreferredSessionScope<void, SessionPermissionRequest>({
        sessionId,
        method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
        payload: request,
    });

    // Best-effort local UX recovery: deny/abort decisions should immediately return
    // the session to non-thinking state even if lifecycle events arrive out of order.
    const session = storage.getState().sessions[sessionId];
    storage.getState().clearSessionOptimisticThinking(sessionId);
    storage.getState().clearSessionThinkingGrace(sessionId);
    if (!session || session.thinking !== true) {
        return;
    }

    storage.getState().applySessions([
        {
            ...session,
            thinking: false,
            updatedAt: nowServerMs(),
        },
    ]);
}

/**
 * Request mode change for a session
 */
export async function sessionSwitch(sessionId: string, to: 'remote' | 'local'): Promise<boolean> {
    const request: SessionModeChangeRequest = { to };
    const response = await sessionRpcWithPreferredSessionScope<boolean, SessionModeChangeRequest>({
        sessionId,
        method: 'switch',
        payload: request,
    });
    return response;
}

/**
 * Push provider meta updates to the CLI session without sending a user message.
 *
 * Deprecated: provider meta updates should be driven by account settings sync instead of ad-hoc session RPCs.
 */

/**
 * Execute a bash command in the session
 */
export async function sessionBash(sessionId: string, request: SessionBashRequest): Promise<SessionBashResponse> {
    try {
        const response = await sessionRpcWithPreferredSessionScope<SessionBashResponse, SessionBashRequest>({
            sessionId,
            method: 'bash',
            payload: request,
        });
        return response;
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Read the tail of a session log file from the running CLI session process.
 */
export async function sessionReadLogTail(
    sessionId: string,
    options?: SessionReadLogTailRequest,
): Promise<SessionReadLogTailResponse> {
    try {
        const request: SessionReadLogTailRequest = {};
        if (typeof options?.maxBytes === 'number' && Number.isFinite(options.maxBytes)) {
            request.maxBytes = options.maxBytes;
        }
        const response = await sessionRpcWithPreferredSessionScope<SessionReadLogTailResponse, SessionReadLogTailRequest>({
            sessionId,
            method: RPC_METHODS.SESSION_LOG_TAIL,
            payload: request,
        });
        return assertRpcResponseWithSuccess<SessionReadLogTailResponse>(response);
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

export interface SessionStopResponse {
    success: boolean;
    message?: string;
    code?: import('./sessionStopContract').SessionStopResponseCode;
    recovery?: import('./sessionStopContract').SessionStopRecovery;
}

/**
 * Stop a session.
 *
 * Primary behavior: stop through the supervising daemon when the hosting machine is reachable.
 * Compatibility fallback: ask the runner to terminate via session RPC.
 * If neither lifecycle owner is reachable, report unavailable control without changing reachability.
 */
export async function sessionStop(sessionId: string): Promise<SessionStopResponse> {
    return await sessionStopWithServerScope(sessionId, {
        serverId: resolvePreferredServerIdForSessionId(sessionId),
    });
}

export async function sessionStopWithServerScope(
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionStopResponse> {
    const stopResult = await stopSessionUsingCanonicalStrategy({
        sessionId,
        serverId: opts?.serverId ?? null,
    });
    if (stopResult.success) {
        return { success: true };
    }

    if (stopResult.reason === 'requested') {
        return {
            success: false,
            message: stopResult.message,
            code: 'session_stop_requested',
            recovery: stopResult.recovery,
        };
    }

    if (stopResult.reason === 'not_found') {
        return { success: false, message: stopResult.message, code: 'session_stop_not_found' };
    }

    if (stopResult.reason === 'control_unavailable') {
        return {
            success: false,
            message: stopResult.message,
            code: 'session_stop_control_unavailable',
            recovery: stopResult.recovery,
        };
    }

    return { success: false, message: stopResult.message, code: 'session_stop_failed' };
}

export interface SessionArchiveResponse {
    success: boolean;
    archivedAt?: number | null;
    message?: string;
    code?: string;
}

const SESSION_ACTIVE_ARCHIVE_MESSAGE = 'Cannot archive an active session';

async function archiveRequestWithContext(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    action: 'archive' | 'unarchive';
}>): Promise<Response> {
    const context = await resolveServerScopedSessionContext({
        serverId: params.serverId ?? resolvePreferredServerIdForSessionId(params.sessionId) ?? null,
    });
    const path = `/v2/sessions/${params.sessionId}/${params.action}`;

    if (context.scope === 'active') {
        return await apiSocket.request(path, { method: 'POST' });
    }

    return await runtimeFetchWithServerReachability({
        serverUrl: context.targetServerUrl,
        token: context.token,
        url: `${context.targetServerUrl}${path}`,
        init: {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${context.token}`,
            },
        },
        timeoutMs: context.timeoutMs,
    });
}

async function applyArchivedAtToLocalSession(sessionId: string, archivedAt: number | null): Promise<void> {
    const session = storage.getState().sessions[sessionId];
    if (!session) return;
    storage.getState().applySessions([
        {
            ...session,
            archivedAt,
            updatedAt: nowServerMs(),
        },
    ]);
}

export async function sessionArchiveWithServerScope(
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionArchiveResponse> {
    try {
        const response = await archiveRequestWithContext({ sessionId, serverId: opts?.serverId ?? null, action: 'archive' });
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            if (response.status === 409) {
                return { success: false, message: SESSION_ACTIVE_ARCHIVE_MESSAGE, code: 'session_active' };
            }
            return { success: false, message: message || 'Failed to archive session' };
        }
        const json = await response.json().catch(() => ({}));
        const archivedAt = typeof (json as any)?.archivedAt === 'number' ? (json as any).archivedAt : null;
        await applyArchivedAtToLocalSession(sessionId, archivedAt);
        return { success: true, archivedAt };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function sessionUnarchiveWithServerScope(
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionArchiveResponse> {
    try {
        const response = await archiveRequestWithContext({ sessionId, serverId: opts?.serverId ?? null, action: 'unarchive' });
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            return { success: false, message: message || 'Failed to unarchive session' };
        }
        await response.json().catch(() => null);
        await applyArchivedAtToLocalSession(sessionId, null);
        return { success: true, archivedAt: null };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Permanently delete a session from the server
 * This will remove the session and all its associated data (messages, usage reports, access keys)
 * The session should be inactive before deletion
 */
export async function sessionDelete(sessionId: string): Promise<{ success: boolean; message?: string }> {
    return await sessionDeleteWithServerScope(sessionId, {
        serverId: resolvePreferredServerIdForSessionId(sessionId) ?? null,
    });
}

export async function sessionDeleteWithServerAccountAuthority(
    sessionId: string,
    authority: ServerAccountSessionRequestAuthority,
): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await authority.request(
            `/v1/sessions/${encodeURIComponent(sessionId)}`,
            { method: 'DELETE' },
        );
        if (response.ok) {
            await response.json().catch(() => null);
            return { success: true };
        }
        const error = await response.text().catch(() => '');
        return {
            success: false,
            message: error || 'Failed to delete session',
        };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

export async function sessionDeleteWithServerScope(
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<{ success: boolean; message?: string }> {
    const context = await resolveServerScopedSessionContext({ serverId: opts?.serverId ?? null });
    try {
        if (context.scope === 'active') {
            const response = await apiSocket.request(`/v1/sessions/${sessionId}`, { method: 'DELETE' });
            if (response.ok) {
                await response.json().catch(() => null);
                return { success: true };
            }
            const error = await response.text().catch(() => '');
            return { success: false, message: error || 'Failed to delete session' };
        }

        const response = await runtimeFetchWithServerReachability({
            serverUrl: context.targetServerUrl,
            token: context.token,
            url: `${context.targetServerUrl}/v1/sessions/${sessionId}`,
            init: {
                method: 'DELETE',
                headers: {
                    Authorization: `Bearer ${context.token}`,
                },
            },
        });
        if (response.ok) {
            await response.json().catch(() => null);
            return { success: true };
        }
        const error = await response.text().catch(() => '');
        return { success: false, message: error || 'Failed to delete session' };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

// Session rename types
interface SessionRenameRequest {
    title: string;
}

interface SessionRenameResponse {
    success: boolean;
    message?: string;
}

/**
 * Rename a session by updating its metadata summary
 * This updates the session title displayed in the UI
 */
export async function sessionRename(
    sessionId: string,
    title: string,
    options?: Readonly<{ serverId?: string | null }>,
): Promise<SessionRenameResponse> {
    try {
        const sid = String(sessionId ?? '').trim();
        const normalizedTitle = String(title ?? '').trim();
        if (!sid || !normalizedTitle) {
            return { success: false, message: 'invalid_parameters' };
        }

        const sync = getSyncSingleton();
        await publishDisplayTitleToMetadata({
            sessionId: sid,
            title: normalizedTitle,
            updateSessionMetadataWithRetry: async (targetSessionId, updater) => {
                await sync.patchSessionMetadataWithRetry(
                    targetSessionId,
                    updater,
                    { serverId: options?.serverId ?? null },
                );
            },
        });

        return { success: true };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

// Export types for external use
export type {
    SessionBashRequest,
    SessionBashResponse,
    SessionRipgrepResponse,
    SessionRenameResponse,
};
