/**
 * Session operations for remote procedure calls
 */

import { apiSocket } from '../api/session/apiSocket';
import { createRpcCallError, isRpcMethodNotAvailableError, readRpcErrorCode as readSessionRpcErrorCode } from '../runtime/rpcErrors';
import { assertRpcResponseWithSuccess } from '../runtime/assertRpcResponseWithSuccess';
import { buildResumeHappySessionRpcParams, type ResumeHappySessionRpcParams } from '../domains/session/resume/resumeSessionPayload';
import { resolveTerminalSpawnOptions } from '../domains/settings/terminalSettings';
import { readForkSessionRpcTimeoutMsFromEnv, readSpawnSessionRpcTimeoutMsFromEnv } from '../domains/session/spawn/spawnSessionRpcTimeout';
import { randomUUID } from '@/platform/randomUUID';
import { storage } from '../domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent, getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { resolveSessionArchiveServerId } from '@/sync/domains/session/listing/sessionArchiveState';
import { readMachineDaemonCliVersionForServerScope } from '../domains/machines/readMachineDaemonCliVersionForServerScope';
import { nowServerMs } from '../runtime/time';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { emitSessionMetadataUpdateWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/emitSessionMetadataUpdateWithServerScope';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { resolveServerScopedSessionContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedSessionContext';
import { sessionRpcWithPreferredSessionScope } from '@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope';
import { sessionRespondToStructuredQuestion } from './sessionStructuredQuestion';
import { sessionRpcWithServerScope, sessionRpcWithServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import type {
    LlmTaskRunnerConfigV1,
    SessionAttachMetadataIdentityPolicy,
    SessionAuthoringValueV1,
    SessionForkPoint,
    SessionForkRpcResult,
    SessionForkStrategy,
    SessionRollbackRpcResult,
    SessionRollbackTarget,
    SessionInitialGoalRequestV1,
    SpawnSessionResult,
    SendableAskUserQuestionAnswerPayload,
} from '@happier-dev/protocol';
import { ConnectedServiceAuthSelectionUnsupportedError, machineRpcWithConnectedServiceAuthAdmission } from './connectedServiceAuthSupport';
import {
    SessionForkRpcResultSchema,
    SessionRollbackRpcResultSchema,
    SessionAuthoringValueV1Schema,
    SPAWN_SESSION_ERROR_CODES,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { prepareAccountSettingsForDaemonSpawnIfNeeded } from './accountSettingsDaemonSpawnPreparation';
import { normalizeSpawnSessionResult } from './_shared';
import { isAccountSettingsScopeChangedDuringSpawnPreparationError } from '@/sync/engine/settings/accountSettingsSpawnPreparationError';
import { isSocketIoAckTimeoutError } from '@happier-dev/protocol/rpcErrors';
import { readMachineControlTargetForSession } from './sessionMachineTarget';
import { stopSessionUsingCanonicalStrategy } from './sessionStopStrategy';
import type { Metadata } from '../domains/state/storageTypes';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { supportsSessionForkRequestId } from '@/utils/system/versionUtils';
import { throwIfSessionArchiveAborted, withSessionArchiveDeadline, type SessionArchiveRequestOptions } from './sessionArchiveLifecycle';
import { AsyncTimeoutError } from '@/utils/timing/time';
export { sessionRipgrep } from './sessionRipgrep';
export type { SessionRipgrepResponse } from './sessionRipgrep';

export {
    sessionScmBranchCheckout,
    sessionScmBranchCreate,
    sessionScmBranchMerge,
    sessionScmBranchList,
    sessionScmBranchOperationAbort,
    sessionScmBranchOperationContinue,
    sessionScmBranchRebase,
    sessionScmChangeDiscard,
    sessionScmChangeExclude,
    sessionScmChangeInclude,
    sessionScmCommitBackout,
    sessionScmCommitCreate,
    sessionScmDiffCommit,
    sessionScmDiffFile,
    sessionScmHostingRepositoryDescribePublishTargets,
    sessionScmHostingRepositoryPublish,
    sessionScmLogList,
    sessionScmRemoteAdd,
    sessionScmRemoteFetch,
    sessionScmRemotePull,
    sessionScmRemotePublish,
    sessionScmRemotePush,
    sessionScmRemoteRemove,
    sessionScmRemoteSetUrl,
    sessionScmRepositoryInit,
    sessionScmStatusSnapshot,
    sessionScmStashApply,
    sessionScmStashDrop,
    sessionScmStashList,
    sessionScmStashPop,
    sessionScmStashShow,
} from './sessionScm';

// Permission operation types live with the shared permission-decision owner so
// foreground ops and the headless notification executor send one wire shape.
import { applySessionThinkingDecisionRecovery, dispatchSessionPermissionDecision, isSessionPermissionDecisionAccepted, type SessionPermissionRequest } from './sessionPermissionDecision';

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

const INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR = 'Session RPC unavailable for inactive session';

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
    backendTarget: import('@happier-dev/protocol').BackendTargetRefV1;
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
    agentModeId?: string;
    agentModeUpdatedAt?: number;
    /**
     * Optional: publish an explicit UI-selected model override at resume time.
     * Use only when the UI selection is newer than metadata.modelOverrideV1.updatedAt.
     *
     * NOTE: this should never be the sentinel "default" (that value is represented by omitting the override).
     */
    modelId?: string;
    modelUpdatedAt?: number;
    /**
     * Internal daemon freshness barrier. Resume callers should normally omit this and let
     * `resumeSession` capture a freshly flushed account-settings version at the RPC boundary.
     */
    accountSettingsVersionHint?: number;
    /**
     * Legacy transport fallback for older daemon boundaries.
     * Prefer codexBackendMode for new resume callers.
     */
    experimentalCodexAcp?: boolean;
    codexBackendMode?: import('@happier-dev/agents').CodexBackendMode;
    agentRuntimeDescriptorV1?: import('@happier-dev/protocol').AgentRuntimeDescriptorV1;
    /**
     * Transcript cursor to use when the resume request is caused by a just-committed
     * wake message. The daemon should catch up after this seq so that prompt is
     * consumed without replaying older turns.
     */
    initialTranscriptAfterSeq?: number;
    executionAuthorization?: import('@happier-dev/protocol').SpawnSessionExecutionAuthorization;
    /**
     * Optional native goal to apply immediately after attaching/resuming the provider session,
     * before any pending user-message queue is drained.
     */
    initialGoal?: SessionInitialGoalRequestV1;
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

async function runResumeSession(
    options: ResumeSessionOptions,
    presentation: 'explicit_resume' | 'ensure_pending_consumer',
): Promise<ResumeSessionResult> {
    // A pending-input wake does not authorize restoring an archived session.
    // Keep restoration with the explicit Resume action, before any lifecycle or RPC effects.
    if (presentation === 'ensure_pending_consumer' && storage.getState().sessions[options.sessionId]?.archivedAt != null) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: 'session_archived',
        };
    }
    // Pending delivery also uses the daemon's spawn/adopt RPC so the daemon can prove whether the
    // recorded active runner is still serviceable. That serviceability check is not itself a user
    // resume. Only publish the resuming lifecycle when the caller explicitly resumed the session,
    // or when the current session snapshot already proves that a Pending consumer is inactive.
    const shouldPresentAsResuming = presentation === 'explicit_resume'
        || storage.getState().sessions[options.sessionId]?.active !== true;
    if (shouldPresentAsResuming) {
        storage.getState().markSessionResuming(options.sessionId);
    }
    try {
        const serverId = typeof options.serverId === 'string' ? options.serverId.trim() : null;
        const session = storage.getState().sessions[options.sessionId];
        if (session?.archivedAt != null) {
            const unarchiveResult = await sessionUnarchiveWithServerScope(options.sessionId, { serverId });
            if (!unarchiveResult.success) {
                if (shouldPresentAsResuming) {
                    storage.getState().clearSessionResuming(options.sessionId);
                }
                return {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: unarchiveResult.message ?? 'Failed to unarchive session',
                };
            }
        }

        const accountSettingsPreparation = typeof options.accountSettingsVersionHint === 'number'
            ? {}
            : await prepareAccountSettingsForDaemonSpawnIfNeeded(options.accountSettingsVersionHint);
        const preparedOptions = {
            ...options,
            ...accountSettingsPreparation,
        };
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
            agentModeId,
            agentModeUpdatedAt,
            modelId,
            modelUpdatedAt,
            experimentalCodexAcp,
            codexBackendMode,
            agentRuntimeDescriptorV1,
            accountSettingsVersionHint,
            initialTranscriptAfterSeq,
            executionAuthorization,
            initialGoal,
            preferRequestedMachineTarget,
            preferScopedMachineRpc,
        } = preparedOptions;

        const machineTarget = readMachineControlTargetForSession(sessionId);
        const machineId = preferRequestedMachineTarget ? rawMachineId.trim() : machineTarget?.machineId ?? rawMachineId.trim();
        const directory = preferRequestedMachineTarget ? rawDirectory.trim() : machineTarget?.basePath ?? rawDirectory.trim();
        if (!machineId || !directory) {
            if (shouldPresentAsResuming) {
                storage.getState().clearSessionResuming(sessionId);
            }
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'No reachable machine target found to resume session',
            };
        }

        const parsedConnectedServicesRaw: SessionAuthoringValueV1['connectedServices'] | undefined =
            connectedServices === undefined
                ? undefined
                : (SessionAuthoringValueV1Schema.shape.connectedServices.parse(connectedServices) as SessionAuthoringValueV1['connectedServices']);
        const parsedConnectedServices = parsedConnectedServicesRaw == null ? undefined : parsedConnectedServicesRaw;
        const terminal = resolveTerminalSpawnOptions({ settings: storage.getState().settings, machineId });
        const params: ResumeHappySessionRpcParams = buildResumeHappySessionRpcParams({
            sessionId,
            directory,
            backendTarget,
            ...(terminal ? { terminal } : {}),
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
            ...(agentModeId ? { agentModeId } : {}),
            ...(typeof agentModeUpdatedAt === 'number' ? { agentModeUpdatedAt } : {}),
            ...(modelId ? { modelId } : {}),
            ...(typeof modelUpdatedAt === 'number' ? { modelUpdatedAt } : {}),
            ...(typeof accountSettingsVersionHint === 'number' ? { accountSettingsVersionHint } : {}),
            ...(typeof initialTranscriptAfterSeq === 'number' ? { initialTranscriptAfterSeq } : {}),
            ...(executionAuthorization ? { executionAuthorization } : {}),
            ...(initialGoal ? { initialGoal } : {}),
            experimentalCodexAcp,
            codexBackendMode,
            ...(agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1 } : {}),
        });

        const result = await machineRpcWithConnectedServiceAuthAdmission<ResumeHappySessionRpcParams>({
            machineId,
            method: RPC_METHODS.SPAWN_HAPPY_SESSION,
            payload: params,
            serverId,
            timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv(),
            ...(preferScopedMachineRpc ? { preferScoped: true } : {}),
        }, {
            backendTarget,
            connectedServices: parsedConnectedServices,
        });
        const normalizedResult = normalizeSpawnSessionResult(result);
        if (shouldPresentAsResuming) {
            if (normalizedResult.type === 'error') {
                storage.getState().clearSessionResuming(sessionId);
            } else {
                storage.getState().armSessionResumingFallback(sessionId);
            }
        }
        return normalizedResult;
    } catch (error) {
        if (shouldPresentAsResuming) {
            storage.getState().clearSessionResuming(options.sessionId);
        }
        if (error instanceof ConnectedServiceAuthSelectionUnsupportedError) {
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST, errorMessage: error.message };
        }
        if (isAccountSettingsScopeChangedDuringSpawnPreparationError(error)) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.ACCOUNT_SCOPE_CHANGED,
                errorMessage: 'Account changed while syncing settings. Please retry from the current account.',
            };
        }
        if (isRpcMethodNotAvailableError(error as any) || readSessionRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
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

/**
 * Resume an inactive session by spawning a new CLI process that reconnects
 * to the existing Happy session and resumes the agent.
 */
export async function resumeSession(options: ResumeSessionOptions): Promise<ResumeSessionResult> {
    return await runResumeSession(options, 'explicit_resume');
}

/**
 * Ask the daemon to prove that the durable Pending queue has a serviceable consumer.
 * The daemon may adopt an existing runner or spawn a replacement when the UI's active
 * snapshot is stale; an already-active snapshot must not be presented as a user resume.
 */
export async function ensureSessionRuntimeForPendingInput(
    options: ResumeSessionOptions,
): Promise<ResumeSessionResult> {
    return await runResumeSession(options, 'ensure_pending_consumer');
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
     * Idempotency key for one user-visible fork attempt. Callers that can retry
     * the same attempt (the strategy modal) own it, so a retry coalesces onto
     * the in-flight fork instead of committing a second provider-side one. Left
     * unset, one is minted per call — correct only for a caller that cannot
     * retry.
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
    const state = storage.getState();
    const daemonCliVersion = readMachineDaemonCliVersionForServerScope({
        state,
        machineId,
        serverId,
        activeServerId: state.profileScope?.serverId,
    });
    try {
        // Stable per-user-action idempotency key: transport-level retries inside
        // machineRpcWithServerScope reuse it, so the daemon coalesces them onto
        // the in-flight fork instead of committing a second provider-side fork.
        // A caller that can reissue the same user attempt supplies its own key;
        // minting one here per call would give that retry a fresh key and defeat
        // the coalescing entirely.
        const requestId = supportsSessionForkRequestId(daemonCliVersion)
            ? options.requestId ?? randomUUID()
            : null;
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId,
            method: RPC_METHODS.SESSION_FORK,
            payload: {
                v: 1,
                parentSessionId: options.parentSessionId,
                forkPoint: options.forkPoint,
                strategy: options.strategy,
                replaySummaryRunner: options.replaySummaryRunner,
                replayMaxSeedChars: options.replayMaxSeedChars,
                ...(requestId ? { requestId } : {}),
            },
            serverId,
            // Fork can block on the provider-side fork plus an accept-then-async
            // spawn resolution; keep the outer acknowledgement budget above the
            // canonical spawn budget so a slow-but-healthy fork does not trigger
            // timeout-driven retries.
            timeoutMs: readForkSessionRpcTimeoutMsFromEnv(),
        });

        const parsed = SessionForkRpcResultSchema.safeParse(raw);
        if (!parsed.success) {
            return { ok: false, errorCode: 'UNEXPECTED', errorMessage: 'Unsupported fork response from daemon' };
        }
        return parsed.data;
    } catch (error) {
        if (isRpcMethodNotAvailableError(error as any) || readSessionRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
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
    try {
        const raw = await sessionRpcWithServerScope<unknown, unknown>({
            sessionId: options.sessionId,
            serverId: options.serverId,
            method: SESSION_RPC_METHODS.SESSION_ROLLBACK,
            payload: {
                v: 1,
                target: options.target ?? { type: 'latest_turn' },
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

export async function sessionAbort(sessionId: string, options?: Readonly<{ scope: ServerAccountScope }>): Promise<void> {
    const recoveryScope = options?.scope ?? getActiveServerAccountScope();
    const serverId = options?.scope.serverId ?? resolvePreferredServerIdForSessionId(sessionId);
    try {
        const request = {
            sessionId,
            method: 'abort',
            payload: {
            reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
            },
        };
        if (options?.scope) {
            await sessionRpcWithServerAccountScope({ ...request, scope: options.scope });
        } else {
            await sessionRpcWithPreferredSessionScope(request);
        }
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

    // Best-effort local UX recovery: aborts should immediately return the session
    // to non-thinking state even if lifecycle events arrive out of order.
    const activeScope = getActiveServerAccountScope();
    if ((recoveryScope ? areServerAccountScopesEqual(recoveryScope, activeScope) : activeScope === null)
        && (!serverId || areServerProfileIdentifiersEquivalent(serverId, getActiveServerId()))) {
        applySessionThinkingDecisionRecovery(sessionId);
    }
}

/** Foreground/action permission responses must be accepted before their callers settle. */
export async function sessionRespondToPermission(params: Readonly<{
    sessionId: string;
    request: SessionPermissionRequest;
    serverId?: string | null;
    permissionModeAfterStop?: PermissionMode;
}>): Promise<unknown> {
    const stopsRun = params.request.approved === false && params.request.decision === 'abort';
    let stopScope: ServerAccountScope | null = null;
    if (stopsRun) {
        const serverId = params.serverId ?? resolvePreferredServerIdForSessionId(params.sessionId);
        const activeScope = getActiveServerAccountScope();
        if (activeScope && (!serverId || areServerProfileIdentifiersEquivalent(serverId, activeScope.serverId))) {
            stopScope = activeScope;
        } else {
            const context = await resolveServerScopedSessionContext({ serverId, preferScoped: true });
            if (context.scope !== 'scoped') throw new Error('Permission Stop requires an authenticated session account');
            stopScope = createServerAccountScope(context.targetServerId, context.targetAccountId);
        }
        if (!stopScope) throw new Error('Permission Stop requires an authenticated session account');
    }
    const result = await dispatchSessionPermissionDecision({
        sessionId: params.sessionId,
        request: params.request,
        ...(stopScope ? { target: { scope: stopScope } } : params.serverId !== undefined ? { target: { serverId: params.serverId } } : {}),
    });
    if (!isSessionPermissionDecisionAccepted(result)) {
        const rejection = typeof result === 'object' && result !== null ? result as Record<string, unknown> : null;
        throw createRpcCallError({
            error: rejection?.ok === false
                ? typeof rejection.errorMessage === 'string' ? rejection.errorMessage : 'Permission response was rejected'
                : 'Permission RPC returned an invalid response',
            errorCode: typeof rejection?.errorCode === 'string' ? rejection.errorCode : undefined,
        });
    }
    if (stopScope) {
        // Each phase validates the saved target credentials, so changing focus remains supported
        // while replacing the target account cannot redirect the continuation to another account.
        await sessionAbort(params.sessionId, { scope: stopScope });
        if (params.permissionModeAfterStop && areServerAccountScopesEqual(stopScope, getActiveServerAccountScope())) {
            storage.getState().updateSessionPermissionMode(params.sessionId, params.permissionModeAfterStop);
        }
    }
    return result;
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
    await sessionRespondToPermission({ sessionId, request });
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
    await sessionRespondToPermission({ sessionId, request });
}

/**
 * Allow a permission request and attach structured answers (AskUserQuestion).
 *
 * Modern arrays use the receiver-enforced v1 method. The legacy method is used only for a payload
 * already proven to round-trip through the deployed comma parser; this function never downgrades.
 */
export async function sessionAllowWithAnswers(
    sessionId: string,
    id: string,
    payload: SendableAskUserQuestionAnswerPayload,
): Promise<void> {
    if (payload.protocol === 'structured-question-v1') {
        await sessionRespondToStructuredQuestion({
            sessionId,
            request: { id, structuredAnswersV1: payload.structuredAnswersV1 },
        });
        return;
    }
    const request: SessionPermissionRequest = { id, approved: true, answers: { ...payload.answers } };
    await sessionRespondToPermission({ sessionId, request });
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
    await sessionRespondToPermission({ sessionId, request });
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

type ArchiveRequestParams = Readonly<{
    sessionId: string;
    serverId?: string | null;
    action: 'archive' | 'unarchive';
    signal?: AbortSignal;
}>;

function archiveRequestWithContext(params: ArchiveRequestParams): Promise<Response>;
function archiveRequestWithContext<T>(params: ArchiveRequestParams, consumeResponse: (response: Response) => Promise<T>): Promise<T>;
async function archiveRequestWithContext<T>(params: ArchiveRequestParams, consumeResponse?: (response: Response) => Promise<T>): Promise<Response | T> {
    const context = await resolveServerScopedSessionContext({
        serverId: params.serverId ?? resolvePreferredServerIdForSessionId(params.sessionId) ?? null,
    });
    const path = `/v2/sessions/${params.sessionId}/${params.action}`;
    const init: RequestInit = { method: 'POST', ...(params.signal ? { signal: params.signal } : {}) };

    if (context.scope === 'active') {
        return consumeResponse
            ? await apiSocket.request(path, init, consumeResponse)
            : await apiSocket.request(path, init);
    }

    const response = await runtimeFetchWithServerReachability({
        serverUrl: context.targetServerUrl,
        token: context.token,
        url: `${context.targetServerUrl}${path}`,
        init: {
            ...init,
            headers: {
                Authorization: `Bearer ${context.token}`,
            },
        },
        timeoutMs: context.timeoutMs,
        signal: params.signal,
    });
    return consumeResponse ? await consumeResponse(response) : response;
}

async function applyArchivedAtToLocalSession(sessionId: string, archivedAt: number | null, capturedServerId: string): Promise<void> {
    const serverId = resolveSessionArchiveServerId(capturedServerId);
    const updatedAt = nowServerMs();
    const session = storage.getState().sessions[sessionId];
    if (session && areServerProfileIdentifiersEquivalent(serverId, getActiveServerSnapshot().serverId)) {
        storage.getState().applySessions([
            {
                ...session,
                archivedAt,
                updatedAt,
            },
        ]);
        return;
    }

    storage.getState().applySessionListRenderablePatches([
        {
            sessionId,
            patch: {
                archivedAt,
                updatedAt,
            },
        },
    ], serverId);
}

export async function sessionArchiveWithServerScope(
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null }> & SessionArchiveRequestOptions,
): Promise<SessionArchiveResponse> {
    try {
        const serverId = resolveSessionArchiveServerId(opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId));
        const archive = async (signal: AbortSignal): Promise<SessionArchiveResponse> => {
            try {
                throwIfSessionArchiveAborted(signal);
                const result = await archiveRequestWithContext({ sessionId, serverId, action: 'archive', signal }, async (response): Promise<SessionArchiveResponse> => {
                    if (!response.ok) {
                        const message = await response.text().catch(() => '');
                        throwIfSessionArchiveAborted(signal);
                        if (response.status === 409) {
                            return { success: false, message: SESSION_ACTIVE_ARCHIVE_MESSAGE, code: 'session_active' };
                        }
                        return { success: false, message: message || 'Failed to archive session' };
                    }
                    const json: unknown = await response.json().catch(() => null);
                    throwIfSessionArchiveAborted(signal);
                    const archivedAt = json !== null && typeof json === 'object' && 'archivedAt' in json && typeof json.archivedAt === 'number'
                        ? json.archivedAt
                        : null;
                    return { success: true, archivedAt };
                });
                throwIfSessionArchiveAborted(signal);
                if (result.success) {
                    await applyArchivedAtToLocalSession(sessionId, result.archivedAt ?? null, serverId);
                }
                return result;
            } catch (error) {
                // Fetch may replace the controller's timeout reason with a generic AbortError.
                throwIfSessionArchiveAborted(signal);
                throw error;
            }
        };
        // Stop-and-archive supplies one enclosing deadline across all 409 attempts. Direct archive
        // owns the same finite lifecycle here; a caller-provided signal never starts another timer.
        return opts?.signal
            ? await archive(opts.signal)
            : await withSessionArchiveDeadline(async ({ signal }) => await archive(signal));
    } catch (error) {
        if (error instanceof AsyncTimeoutError) return { success: false, code: 'session_archive_timeout' };
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function sessionUnarchiveWithServerScope(
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionArchiveResponse> {
    try {
        const serverId = resolveSessionArchiveServerId(opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId));
        const response = await archiveRequestWithContext({ sessionId, serverId, action: 'unarchive' });
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            return { success: false, message: message || 'Failed to unarchive session' };
        }
        await response.json().catch(() => null);
        await applyArchivedAtToLocalSession(sessionId, null, serverId);
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

export async function sessionDeleteWithServerScope(
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<{ success: boolean; message?: string }> {
    const serverId = resolveSessionArchiveServerId(opts?.serverId);
    const context = await resolveServerScopedSessionContext({ serverId });
    try {
        if (context.scope === 'active') {
            const response = await apiSocket.request(`/v1/sessions/${sessionId}`, { method: 'DELETE' });
            if (response.ok) {
                await response.json().catch(() => null);
                storage.getState().deleteSession(sessionId, serverId);
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
            storage.getState().deleteSession(sessionId, serverId);
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
        const updatedAt = Date.now();

        await sync.patchSessionMetadataWithRetry(
            sid,
            (metadata: Metadata) => ({
                ...(metadata ?? {}),
                summary: { text: normalizedTitle, updatedAt },
            }),
            { serverId: options?.serverId ?? null },
        );

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
    SessionRenameResponse
};
