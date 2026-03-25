/**
 * Session operations for remote procedure calls
 */

import { apiSocket } from '../api/session/apiSocket';
import { createRpcCallError, isRpcMethodNotAvailableError, readRpcErrorCode } from '../runtime/rpcErrors';
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
import { sessionRpcWithPreferredSessionScope } from '@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';
import type {
    LlmTaskRunnerConfigV1,
    SessionAttachMetadataIdentityPolicy,
    SessionContinueWithReplayRpcResult,
    SessionForkPoint,
    SessionForkRpcResult,
    SessionForkStrategy,
    SessionRollbackRpcResult,
    SessionRollbackTarget,
    SpawnSessionResult,
} from '@happier-dev/protocol';
import type { AgentId } from '@/agents/catalog/catalog';
import {
    SessionContinueWithReplayRpcResultSchema,
    SessionForkRpcResultSchema,
    SessionRollbackRpcResultSchema,
    SPAWN_SESSION_ERROR_CODES,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { normalizeSpawnSessionResult } from './_shared';
import { isSocketIoAckTimeoutError } from '@/sync/runtime/socketIoAckTimeout';
import { canUseSessionRpc, readMachineTargetForSession, resolveMachinePathFromSessionBase, shouldFallbackToSessionRpc } from './sessionMachineTarget';
export {
    sessionScmBranchCheckout,
    sessionScmBranchCreate,
    sessionScmBranchList,
    sessionScmChangeDiscard,
    sessionScmChangeExclude,
    sessionScmChangeInclude,
    sessionScmCommitBackout,
    sessionScmCommitCreate,
    sessionScmDiffCommit,
    sessionScmDiffFile,
    sessionScmLogList,
    sessionScmRemoteFetch,
    sessionScmRemotePull,
    sessionScmRemotePublish,
    sessionScmRemotePush,
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
    answers?: Record<string, string>;
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

// Kill session operation types
interface SessionKillRequest {
    // No parameters needed
}

interface SessionKillResponse {
    success: boolean;
    message: string;
    errorCode?: string;
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
    /**
     * Optional: publish an explicit UI-selected model override at resume time.
     * Use only when the UI selection is newer than metadata.modelOverrideV1.updatedAt.
     *
     * NOTE: this should never be the sentinel "default" (that value is represented by omitting the override).
     */
    modelId?: string;
    modelUpdatedAt?: number;
    /**
     * Legacy transport fallback for older daemon boundaries.
     * Prefer codexBackendMode for new resume callers.
     */
    experimentalCodexAcp?: boolean;
    codexBackendMode?: import('@happier-dev/agents').CodexBackendMode;
    agentRuntimeDescriptorV1?: import('@happier-dev/protocol').AgentRuntimeDescriptorV1;
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
    const {
        sessionId,
        machineId: rawMachineId,
        directory: rawDirectory,
        backendTarget,
        resume,
        environmentVariables,
        transcriptStorage,
        attachMetadataIdentityPolicy,
        permissionMode,
        permissionModeUpdatedAt,
        modelId,
        modelUpdatedAt,
        experimentalCodexAcp,
        codexBackendMode,
        agentRuntimeDescriptorV1,
        preferRequestedMachineTarget,
        preferScopedMachineRpc,
    } = options;
    const serverId = typeof options.serverId === 'string' ? options.serverId.trim() : null;

    const machineTarget = readMachineTargetForSession(sessionId);
    const machineId = preferRequestedMachineTarget ? rawMachineId.trim() : machineTarget?.machineId ?? rawMachineId.trim();
    const directory = preferRequestedMachineTarget ? rawDirectory.trim() : machineTarget?.basePath ?? rawDirectory.trim();
    if (!machineId || !directory) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: 'No reachable machine target found to resume session',
        };
    }

    try {
        const params: ResumeHappySessionRpcParams = buildResumeHappySessionRpcParams({
            sessionId,
            directory,
            backendTarget,
            ...(resume ? { resume } : {}),
            ...(environmentVariables ? { environmentVariables } : {}),
            ...(transcriptStorage ? { transcriptStorage } : {}),
            ...(attachMetadataIdentityPolicy ? { attachMetadataIdentityPolicy } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(typeof permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt } : {}),
            ...(modelId ? { modelId } : {}),
            ...(typeof modelUpdatedAt === 'number' ? { modelUpdatedAt } : {}),
            experimentalCodexAcp,
            codexBackendMode,
            ...(agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1 } : {}),
        });

        const result = await machineRpcWithServerScope<unknown, ResumeHappySessionRpcParams>({
            machineId,
            method: RPC_METHODS.SPAWN_HAPPY_SESSION,
            payload: params,
            serverId,
            timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv(),
            ...(preferScopedMachineRpc ? { preferScoped: true } : {}),
        });
        return normalizeSpawnSessionResult(result);
    } catch (error) {
        if (isRpcMethodNotAvailableError(error as any) || readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
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
    approvedNewDirectoryCreation?: boolean;
    permissionMode?: PermissionMode;
    permissionModeUpdatedAt?: number;
    modelId?: string;
    modelUpdatedAt?: number;
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
    try {
        const raw = await machineRpcWithServerScope<unknown, unknown>({
            machineId: options.machineId,
            method: RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
            payload: {
                directory: options.directory,
                agent: options.agent,
                approvedNewDirectoryCreation: options.approvedNewDirectoryCreation,
                permissionMode: options.permissionMode,
                permissionModeUpdatedAt: options.permissionModeUpdatedAt,
                modelId: options.modelId,
                modelUpdatedAt: options.modelUpdatedAt,
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
        if (isRpcMethodNotAvailableError(error as any) || readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
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
}>;

export async function forkSession(options: ForkSessionOptions): Promise<SessionForkRpcResult> {
    const serverId = typeof options.serverId === 'string' ? options.serverId.trim() : null;
    const parentTarget = readMachineTargetForSession(options.parentSessionId);
    const explicitMachineId = typeof options.machineId === 'string' ? options.machineId.trim() : '';
    const machineId = parentTarget?.machineId ?? explicitMachineId;
    if (!machineId) {
        return {
            ok: false,
            errorCode: 'machine_not_found',
            errorMessage: 'No reachable machine target found for session fork',
        };
    }
    try {
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
            },
            serverId,
        });

        const parsed = SessionForkRpcResultSchema.safeParse(raw);
        if (!parsed.success) {
            return { ok: false, errorCode: 'UNEXPECTED', errorMessage: 'Unsupported fork response from daemon' };
        }
        return parsed.data;
    } catch (error) {
        if (isRpcMethodNotAvailableError(error as any) || readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
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
        if (isRpcMethodNotAvailableError(error as any) || readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) {
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
        if (e instanceof Error && isRpcMethodNotAvailableError(e)) {
            // Session RPCs are unavailable when no agent process is attached (inactive/resumable).
            // Treat abort as a no-op in that case.
            return;
        }
        throw e;
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
        method: 'permission',
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
        method: 'permission',
        payload: request,
    });
}

/**
 * Allow a permission request and attach structured answers (AskUserQuestion).
 *
 * This uses the existing `permission` RPC (no separate RPC required).
 */
export async function sessionAllowWithAnswers(
    sessionId: string,
    id: string,
    answers: Record<string, string>,
): Promise<void> {
    const request: SessionPermissionRequest = {
        id,
        approved: true,
        answers,
    };
    await sessionRpcWithPreferredSessionScope<void, SessionPermissionRequest>({
        sessionId,
        method: 'permission',
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
        method: 'permission',
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

/**
 * Run ripgrep in the session
 */
export async function sessionRipgrep(
    sessionId: string,
    args: string[],
    cwd?: string
): Promise<SessionRipgrepResponse> {
    try {
        const machineTarget = readMachineTargetForSession(sessionId);
        if (machineTarget) {
            try {
                const request: SessionRipgrepRequest = {
                    args,
                    cwd: resolveMachinePathFromSessionBase({ basePath: machineTarget.basePath, requestPath: cwd }),
                };
                const response = await apiSocket.machineRPC<SessionRipgrepResponse, SessionRipgrepRequest>(
                    machineTarget.machineId,
                    'ripgrep',
                    request,
                );
                return assertRpcResponseWithSuccess<SessionRipgrepResponse>(response);
            } catch (error) {
                if (!shouldFallbackToSessionRpc(sessionId, error)) {
                    throw error;
                }
            }
        }

        if (!canUseSessionRpc(sessionId)) {
            return {
                success: false,
                error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
            };
        }

        const request: SessionRipgrepRequest = { args, cwd };
        const response = await sessionRpcWithPreferredSessionScope<SessionRipgrepResponse, SessionRipgrepRequest>({
            sessionId,
            method: 'ripgrep',
            payload: request,
        });
        return assertRpcResponseWithSuccess<SessionRipgrepResponse>(response);
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Kill the session process immediately
 */
export async function sessionKill(sessionId: string): Promise<SessionKillResponse> {
    try {
        const response = await sessionRpcWithPreferredSessionScope<SessionKillResponse, {}>({
            sessionId,
            method: 'killSession',
            payload: {},
        });
        return assertRpcResponseWithSuccess<SessionKillResponse>(response);
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export interface SessionStopResponse {
    success: boolean;
    message?: string;
}

/**
 * Stop a session.
 *
 * Primary behavior: kill the session process (same as previous "archive" behavior).
 * Fallback: if the session RPC method is unavailable (e.g. session crashed / disconnected),
 * mark the session inactive server-side so it no longer appears "online".
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
    const killResult = await (async (): Promise<SessionKillResponse> => {
        try {
            const response = await sessionRpcWithServerScope<SessionKillResponse, SessionKillRequest>({
                sessionId,
                serverId: opts?.serverId ?? null,
                method: 'killSession',
                payload: {},
            });
            return assertRpcResponseWithSuccess<SessionKillResponse>(response);
        } catch (error) {
            return {
                success: false,
                message: error instanceof Error ? error.message : 'Unknown error',
                errorCode: readRpcErrorCode(error),
            };
        }
    })();

    if (killResult.success) {
        return { success: true };
    }

    const message = killResult.message || 'Failed to archive session';
    const isRpcMethodUnavailable = isRpcMethodNotAvailableError({
        rpcErrorCode: killResult.errorCode,
        message,
    });

    if (isRpcMethodUnavailable) {
        const context = await resolveServerScopedSessionContext({ serverId: opts?.serverId ?? null });
        try {
            if (context.scope === 'active') {
                apiSocket.send('session-end', { sid: sessionId, time: Date.now() });
            } else {
                const socket = await createEphemeralServerSocketClient({
                    serverUrl: context.targetServerUrl,
                    token: context.token,
                    timeoutMs: context.timeoutMs,
                });
                try {
                    socket.emit('session-end', { sid: sessionId, time: Date.now() });
                } finally {
                    socket.disconnect();
                }
            }
        } catch {
            // Best-effort: server will also eventually time out stale sessions.
        }
        return { success: true };
    }

    return { success: false, message };
}

export interface SessionArchiveResponse {
    success: boolean;
    archivedAt?: number | null;
    message?: string;
}

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
export async function sessionRename(sessionId: string, title: string): Promise<SessionRenameResponse> {
    try {
        const { sync } = await import('../sync');
        const sessionEncryption = sync.encryption.getSessionEncryption(sessionId);
        if (!sessionEncryption) {
            return {
                success: false,
                message: 'Session encryption not found'
            };
        }

        // Get the current session from storage
        const { storage } = await import('../domains/state/storage');
        const currentSession = storage.getState().sessions[sessionId];
        if (!currentSession) {
            return {
                success: false,
                message: 'Session not found in storage'
            };
        }

        // Ensure we have valid metadata to update
        if (!currentSession.metadata) {
            return {
                success: false,
                message: 'Session metadata not available'
            };
        }

        // Update metadata with new summary
        const updatedMetadata = {
            ...currentSession.metadata,
            summary: {
                text: title,
                updatedAt: Date.now()
            }
        };

        // Encrypt the updated metadata
        const encryptedMetadata = await sessionEncryption.encryptMetadata(updatedMetadata);

        // Send update to server
        const result = await emitSessionMetadataUpdateWithServerScope({
            sessionId,
            expectedVersion: currentSession.metadataVersion,
            metadata: encryptedMetadata,
        });

        if (result.result === 'success') {
            return { success: true };
        } else if (result.result === 'version-mismatch') {
            // Retry with updated version
            return {
                success: false,
                message: 'Version conflict, please try again'
            };
        } else {
            return {
                success: false,
                message: result.message || 'Failed to rename session'
            };
        }
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
    SessionKillResponse,
    SessionRenameResponse
};
