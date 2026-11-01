import { SessionArchiveTimeoutError, withSessionArchiveDeadline } from './sessionArchiveLifecycle';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveSessionArchiveAddress } from '@/sync/domains/session/listing/sessionArchiveState';
/**
 * Session operations for remote procedure calls
 */

import { apiSocket } from '../api/session/apiSocket';
import { resolveSessionExplicitControlIntent, writeSessionExplicitStopV1ToMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { Platform } from 'react-native';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { publishDisplayTitleToMetadata } from '@/sync/state/displayTitlePublish';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { createRpcCallError, isRpcMethodNotAvailableError, readRpcErrorCode as readSessionRpcErrorCode } from '../runtime/rpcErrors';
import { assertRpcResponseWithSuccess } from '../runtime/assertRpcResponseWithSuccess';
import { buildResumeHappySessionRpcParams, ResumeSessionInputValidationError, type ResumeHappySessionRpcParams } from '../domains/session/resume/resumeSessionPayload';
import { resolveTerminalSpawnOptions } from '../domains/settings/terminalSettings';
import { readAccountSettingsForScope } from '../domains/state/accountSettingsPersistence';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '../domains/session/spawn/spawnSessionRpcTimeout';
import { storage } from '../domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readMachineDaemonCliVersionForServerScope } from '../domains/machines/readMachineDaemonCliVersionForServerScope';
import { nowServerMs } from '../runtime/time';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { emitSessionMetadataUpdateWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/emitSessionMetadataUpdateWithServerScope';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { resolveServerAccountRequestContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext';
import type {
    ServerAccountRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { createServerRequestForResolvedServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { sessionRpcWithPreferredSessionScope } from '@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope';
import {
    sessionRpcWithServerAccountScope,
    sessionRpcWithServerScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { prepareAccountSettingsForDaemonSpawnIfNeeded } from './accountSettingsDaemonSpawnPreparation';
import type {
    ActionExecutorContext,
    BackendTargetRefV1,
    CheckpointCodeRollbackRequest,
    CheckpointCodeRollbackResult,
    LlmTaskRunnerConfigV1,
    SessionAttachMetadataIdentityPolicy,
    SessionAuthoringValueV1,
    SessionInitialGoalRequestV1,
    SessionModelSelectionV1,
    SessionPermissionRespondRpcParamsV1,
    SessionUserActionAnswerRpcParamsV1,
    SessionForkPoint,
    SessionForkRpcResult,
    SessionForkStrategy,
    SessionRollbackRpcResult,
    SessionRollbackTarget,
    SpawnSessionExecutionAuthorization,
    SpawnSessionResult,
} from '@happier-dev/protocol';
import { CheckpointCodeRollbackResultSchema } from '@happier-dev/protocol/sessions/control/rollback/checkpointCodeRollback';
import { SessionForkRpcResultSchema } from '@happier-dev/protocol/sessions/fork';
import type { SessionStopResult } from '@happier-dev/protocol/sessions/control/contract';
import { SessionRollbackRpcResultSchema } from '@happier-dev/protocol/sessions/rollback';
import { SessionAuthoringValueV1Schema } from '@happier-dev/protocol/sessions/authoring/index';
import { readHomeDomainActionErrorV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import type { StructuredQuestionAnswersV1 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { normalizeSpawnSessionResult } from './_shared';
import { isAccountSettingsScopeChangedDuringSpawnPreparationError } from '@/sync/engine/settings/accountSettingsSpawnPreparationError';
import { isSocketIoAckTimeoutError, readRpcRequestDisposition } from '@happier-dev/sync-client';
import { readRpcFailureCode } from './actions/rpcFailureCode';
import { isMachineRpcTimeoutError, MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcTimeoutError';
import { readMachineControlTargetForSession } from './sessionMachineTarget';
import { stopSessionUsingCanonicalStrategy } from './sessionStopStrategy';
import {
    isProviderSafeDaemonSessionMethodAbsent,
    requiresProviderSafeSessionRpc,
} from './providerDaemonSessionCompatibility';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { buildResumeCapabilityOptionsFromUiState } from '@/agents/registry/registryUiBehavior';
import type { CurrentProjectedAgentCapabilities } from '@/agents/backendCatalog/currentAgentCapabilities';
import { readAgentScopedPluginSettingsSnapshot } from '@/agents/registry/agentScopedPluginSettings';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getPendingQueueWakeResumeOptions } from '@/sync/domains/pending/pendingQueueWake';
import { supportsSessionForkRequestId } from '@/utils/system/versionUtils';
import { machineResolveSpawnSessionByNonceUntilSettled } from './machines';
import { captureLazyActionAccountContext, withActionAccountRequestSignal } from './actions/actionAccountContext';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { randomUUID } from '@/platform/randomUUID';
import { createManagedMachineActionClient } from '@/sync/api/machines/managedMachineActions';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
export {
    sessionScmBranchCheckout,
    sessionScmBranchCreate,
    sessionScmBranchMerge,
    sessionScmBranchOperationAbort,
    sessionScmBranchOperationContinue,
    sessionScmBranchOperationSkip,
    sessionScmConflictAcceptSide,
    sessionScmConflictMarkResolved,
    sessionScmBranchRebase,
    sessionScmBranchList,
    sessionScmChangeDiscard,
    sessionScmChangeExclude,
    sessionScmChangeInclude,
    sessionScmCommitBackout,
    sessionScmCommitCreate,
    sessionScmCommitUndoLast,
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
    sessionScmStashCreate,
    sessionScmStashPop,
    sessionScmStashShow,
} from './sessionScm';

function resolveSessionPermissionTurnId(
    sessionId: string,
    requestId: string,
    explicitTurnId?: string,
    serverId?: string,
): string | undefined {
    const session = storage.getState().sessions[sessionId];
    const owningServerId = typeof session?.serverId === 'string' && session.serverId.trim().length > 0
        ? session.serverId
        : getActiveServerSnapshot().serverId;
    const loadedRequest = (serverId === undefined || areServerProfileIdentifiersEquivalent(serverId, owningServerId)
        ? session
        : undefined)?.agentState?.requests?.[requestId];
    // The live pending-request projection owns turn custody. Transcript rows can
    // survive rebinding and therefore supply an older turn for the same request.
    // A loaded turnless request is also authoritative: adding a transcript turn
    // would make the runner reject an otherwise valid legacy response.
    const candidate = loadedRequest ? loadedRequest.turnId : explicitTurnId;
    return typeof candidate === 'string' && candidate.trim().length > 0
        ? candidate.trim()
        : undefined;
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
// Resume's in-process callers retain a typed launch or transport refusal without
// changing the established spawn wire envelope or exposing private error prose.
export type ResumeSessionResult = Exclude<SpawnSessionResult, { type: 'error' }>
    | (Omit<Extract<SpawnSessionResult, { type: 'error' }>, 'errorCode'> & Readonly<{
        errorCode: Extract<SpawnSessionResult, { type: 'error' }>['errorCode'] | 'plugin_disabled';
        rpcErrorCode?: string;
    }>);
/** Local pending-input projection, not a daemon spawn acknowledgement. */
export type PendingInputRuntimeEnsureResult = ResumeSessionResult | Readonly<{ type: 'pending' }>;

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
    /** Canonical manifest-qualified Agent to resume. */
    agentTarget?: import('@happier-dev/protocol').AgentExecutionTargetV1;
    /** Released configured-ACP/daemon compatibility target. */
    backendTarget?: import('@happier-dev/protocol').BackendTargetRefV2Input;
    /** Optional vendor resume id (e.g. Claude/Codex session id). */
    resume?: string;
    environmentVariables?: Record<string, string>;
    connectedServices?: unknown;
    connectedServicesUpdatedAt?: number;
    transcriptStorage?: 'direct' | 'persisted';
    attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy;
    /** Optional explicit server scope for resume spawn routing. */
    serverId?: string;
    /** Exact route credential lifetime; fences daemon admission and forbids ambient Account fallback. */
    accountLifetime?: ServerAccountScopeLifetime;
    /** The originating surface may stop waiting without undoing an admitted resume. */
    signal?: AbortSignal;
    /** Host-private accepted-input authority; never serialized into the spawn RPC. */
    pendingActivationAuthorization?: import('@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1').PendingActivationAuthorizationV1;
    /**
     * Optional: publish an explicit UI-selected permission mode at resume time.
     * Use only when the UI selection is newer than metadata.permissionModeUpdatedAt.
     */
    permissionMode?: PermissionMode;
    permissionModeUpdatedAt?: number;
    /** Optional explicit target-bound model selection. Omission means keep the persisted session intent. */
    modelSelection?: SessionModelSelectionV1;
    runtimeDescriptorV1?: import('@happier-dev/protocol').RuntimeDescriptorV1;
    /**
     * Transcript cursor to use when the resume request is caused by a just-committed
     * wake message. The daemon should catch up after this seq so that prompt is
     * consumed without replaying older turns.
     */
    initialTranscriptAfterSeq?: number;
    executionAuthorization?: SpawnSessionExecutionAuthorization;
    /** Action callers retain their admitted authority when requesting explicit Resume. */
    executionAuthority?: ActionExecutorContext['authority'];
    /** Explicit consent from private-folder recovery; never inferred by automatic wake. */
    approvedNewDirectoryCreation?: boolean;
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
    /** Stable operation identity used by the existing daemon spawn-readiness owner. */
    spawnNonce?: string;
    /** Do not expose spawn acknowledgement as an active Session runtime. */
    waitForReady?: boolean;
}

async function runResumeSession(
    options: ResumeSessionOptions,
    presentation: 'explicit_resume' | 'ensure_pending_consumer',
): Promise<ResumeSessionResult> {
    options.signal?.throwIfAborted();
    const exactAccountLifetime = options.accountLifetime;
    const exactAccountScopeRetiredError = () => Object.assign(
        new Error('Session Account authority retired before runtime admission'),
        { code: 'session_account_scope_retired' },
    );
    const assertExactAccountCurrent = (): void => {
        if (!exactAccountLifetime) return;
        if (
            !exactAccountLifetime.isCurrent()
            || (options.serverId !== undefined
                && !areServerProfileIdentifiersEquivalent(options.serverId, exactAccountLifetime.scope.serverId))
        ) {
            throw exactAccountScopeRetiredError();
        }
    };
    assertExactAccountCurrent();
    // Pending input does not authorize restoring an archived Session. Exact Account
    // requests already avoid ambient Session state and its unarchive path below.
    if (!exactAccountLifetime && presentation === 'ensure_pending_consumer'
        && storage.getState().sessions[options.sessionId]?.archivedAt != null) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: 'session_archived',
        };
    }
    let providerSafeRpcRequired = false;
    const canProjectResumePresentation = (): boolean => {
        if (!exactAccountLifetime) return true;
        const focusedSession = storage.getState().sessions[options.sessionId];
        return exactAccountLifetime.isCurrent()
            && areServerAccountScopesEqual(getActiveServerAccountScope(), exactAccountLifetime.scope)
            && typeof focusedSession?.serverId === 'string'
            && areServerProfileIdentifiersEquivalent(focusedSession.serverId, exactAccountLifetime.scope.serverId);
    };
    // A scoped RPC may remain valid for a background Account. Its local status
    // belongs only to the still-focused Account and matching Session Home.
    const shouldPresentAsResuming = canProjectResumePresentation() && (
        presentation === 'explicit_resume'
        || storage.getState().sessions[options.sessionId]?.active !== true
    );
    if (shouldPresentAsResuming && canProjectResumePresentation()) {
        storage.getState().markSessionResuming(options.sessionId);
    }
    try {
        assertExactAccountCurrent();
        const serverId = exactAccountLifetime?.scope.serverId
            ?? (typeof options.serverId === 'string' ? options.serverId.trim() : null);
        const session = exactAccountLifetime ? null : storage.getState().sessions[options.sessionId];
        if (session?.archivedAt != null) {
            const unarchiveResult = await sessionUnarchiveWithServerScope(options.sessionId, { serverId });
            if (!unarchiveResult.success) {
                if (shouldPresentAsResuming && canProjectResumePresentation()) {
                    storage.getState().clearSessionResuming(options.sessionId);
                }
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
            agentTarget,
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
            runtimeDescriptorV1,
            accountSettingsVersionHint,
            initialTranscriptAfterSeq,
            executionAuthorization,
            approvedNewDirectoryCreation,
            initialGoal,
            preferRequestedMachineTarget,
            preferScopedMachineRpc,
            spawnNonce,
            waitForReady,
        } = options;

        const machineTarget = exactAccountLifetime ? null : readMachineControlTargetForSession(sessionId);
        const useRequestedMachineTarget = Boolean(exactAccountLifetime) || preferRequestedMachineTarget;
        const machineId = useRequestedMachineTarget ? rawMachineId.trim() : machineTarget?.machineId ?? rawMachineId.trim();
        const directory = useRequestedMachineTarget ? rawDirectory.trim() : machineTarget?.basePath ?? rawDirectory.trim();
        if (!machineId || !directory) {
            if (shouldPresentAsResuming && canProjectResumePresentation()) {
                storage.getState().clearSessionResuming(sessionId);
            }
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'No reachable machine target found to resume session',
            };
        }

        const storedSession = exactAccountLifetime ? null : storage.getState().sessions[sessionId];
        const storedSessionOwnerMetadata = storedSession
            ? readSessionOwnerMetadataView(storedSession)
            : null;
        providerSafeRpcRequired = requiresProviderSafeSessionRpc({
            modelSelection,
            existingSessionMetadata: storedSessionOwnerMetadata
                ? { state: 'known', metadata: storedSessionOwnerMetadata }
                : { state: 'unknown' },
        });

        const preparation = exactAccountLifetime
            ? {}
            : await prepareAccountSettingsForDaemonSpawnIfNeeded(options.accountSettingsVersionHint);
        assertExactAccountCurrent();

        const parsedConnectedServicesRaw: SessionAuthoringValueV1['connectedServices'] | undefined =
            connectedServices === undefined
                ? undefined
                : (SessionAuthoringValueV1Schema.shape.connectedServices.parse(connectedServices) as SessionAuthoringValueV1['connectedServices']);
        const parsedConnectedServices = parsedConnectedServicesRaw == null ? undefined : parsedConnectedServicesRaw;
        const state = storage.getState();
        const terminalSettings = exactAccountLifetime
            ? readAccountSettingsForScope({ scope: exactAccountLifetime.scope, focusedScope: state.settingsScope, focusedSettings: state.settings })
            : state.settings;
        const terminal = resolveTerminalSpawnOptions({ settings: terminalSettings, machineId });
        const params: ResumeHappySessionRpcParams = buildResumeHappySessionRpcParams({
            sessionId,
            machineId,
            directory,
            ...(terminal ? { terminal } : {}),
            ...(agentTarget ? { agentTarget } : {}),
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
            ...(approvedNewDirectoryCreation !== undefined ? { approvedNewDirectoryCreation } : {}),
            ...(initialGoal ? { initialGoal } : {}),
            ...(spawnNonce ? { spawnNonce } : {}),
            ...preparation,
            ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
        });

        const retirementAbort = exactAccountLifetime ? new AbortController() : null;
        const retirementSubscription = exactAccountLifetime?.onRetire(() => retirementAbort?.abort());
        const cancellation = mergeAbortSignals([retirementAbort?.signal, options.signal]);
        let result: unknown;
        try {
            const execution = await (async () => {
                const account = await captureLazyActionAccountContext(serverId ?? getActiveServerSnapshot().serverId, cancellation.signal);
                try {
                    if (exactAccountLifetime && account.accountId !== exactAccountLifetime.scope.accountId) {
                        throw new Error(`Session resume requires Account ${exactAccountLifetime.scope.accountId}`);
                    }
                    return await executeOriginalAccountMachineAction({ account, actionId: 'session.open',
                    requestId: params.executionAuthorization?.requestId ?? params.spawnNonce ?? randomUUID(),
                    machineId, foreignTargetOnly: true,
                    input: { serverId: account.serverId, sessionId, intent: 'resume', resumeRequest: params },
                    ...(cancellation.signal ? { signal: cancellation.signal } : {}),
                    });
                } finally { account.dispose(); }
            })();
            result = execution ? execution.ok ? execution.result : {
                type: 'error', errorCode: execution.errorCode, errorMessage: execution.error,
            } : await machineRpcWithServerScope<unknown, ResumeHappySessionRpcParams>({
                machineId,
                method: providerSafeRpcRequired
                    ? RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
                    : RPC_METHODS.SPAWN_HAPPY_SESSION,
                payload: params,
                serverId,
                timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv(),
                ...(exactAccountLifetime ? {
                    accountId: exactAccountLifetime.scope.accountId,
                    preferScoped: true,
                    onIssued: assertExactAccountCurrent,
                } : preferScopedMachineRpc ? { preferScoped: true } : {}),
                ...(cancellation.signal ? { signal: cancellation.signal } : {}),
            });
        } finally {
            cancellation.dispose();
            retirementSubscription?.dispose();
        }
        assertExactAccountCurrent();
        let normalizedResult = normalizeSpawnSessionResult(result);
        if (
            waitForReady
            && normalizedResult.type === 'success'
            && (normalizedResult.sessionIdStatus === 'pending' || normalizedResult.sessionId !== sessionId)
        ) {
            const readinessNonce = normalizedResult.spawnNonce ?? spawnNonce;
            if (!readinessNonce) {
                normalizedResult = {
                    type: 'error',
                    errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
                    errorMessage: 'Session resume was accepted without a readiness identity',
                };
            } else {
                const readiness = await machineResolveSpawnSessionByNonceUntilSettled({
                    machineId,
                    spawnNonce: readinessNonce,
                    serverId,
                    signal: options.signal,
                });
                normalizedResult = readiness.status === 'success' && readiness.sessionId === sessionId
                    ? { type: 'success', sessionId }
                    : readiness.status === 'error'
                        ? {
                            type: 'error',
                            errorCode: readiness.errorCode,
                            errorMessage: readiness.errorMessage,
                            ...(readiness.errorDetail ? { errorDetail: readiness.errorDetail } : {}),
                        }
                        : {
                            type: 'error',
                            errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
                            errorMessage: 'Session resume was accepted but runtime readiness is still unknown',
                        };
            }
        }
        if (shouldPresentAsResuming && canProjectResumePresentation()) {
            if (normalizedResult.type === 'error') {
                storage.getState().clearSessionResuming(sessionId);
            } else {
                storage.getState().armSessionResumingFallback(sessionId);
            }
        }
        return normalizedResult.type === 'error'
            && normalizedResult.errorDetail?.kind === 'launch_error'
            && normalizedResult.errorDetail.code === 'plugin_disabled'
            ? { ...normalizedResult, errorCode: 'plugin_disabled' }
            : normalizedResult;
    } catch (error) {
        if (shouldPresentAsResuming && canProjectResumePresentation()) {
            storage.getState().clearSessionResuming(options.sessionId);
        }
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
        if (error instanceof ResumeSessionInputValidationError) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: error.message,
            };
        }
        const rpcErrorCode = readRpcFailureCode(error);
        if (rpcErrorCode !== RPC_ERROR_CODES.OUTCOME_UNKNOWN && (isSocketIoAckTimeoutError(error) || isMachineRpcTimeoutError(error))) {
            return {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
                errorMessage: 'Session startup timed out',
            };
        }
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: error instanceof Error ? error.message : 'Failed to resume session',
            ...(rpcErrorCode ? { rpcErrorCode } : {}),
        };
    }
}

/**
 * Resume an inactive session by spawning a new CLI process that reconnects
 * to the existing Happy session and resumes the agent.
 */
export async function resumeSession(options: ResumeSessionOptions): Promise<ResumeSessionResult> {
    return await runResumeSession({
        ...options,
        executionAuthorization: options.executionAuthority === 'present_user'
            ? options.executionAuthorization ?? {
                provenance: 'user_request',
                requestId: options.spawnNonce ?? randomUUID(),
            }
            : undefined,
    }, 'explicit_resume');
}

/**
 * Ask the daemon to prove that the durable Pending queue has a serviceable consumer.
 * The daemon may adopt an existing runner or spawn a replacement when the UI's active
 * snapshot is stale; an already-active snapshot must not be presented as a user resume.
 */
export async function ensureSessionRuntimeForPendingInput(
    options: ResumeSessionOptions,
): Promise<PendingInputRuntimeEnsureResult> {
    const activation = options.pendingActivationAuthorization;
    const target = activation?.managedWakeTargetV1;
    if (target) {
        // A protected Session reference selects the native read. Ambient Machine
        // metadata and a desired Start are neither enrollment nor running facts.
        const serverId = options.accountLifetime?.scope.serverId ?? options.serverId;
        if (!serverId || options.accountLifetime?.isCurrent() === false
            || target.origin.kind !== 'session-input' || target.origin.session.sessionId !== options.sessionId
            || target.origin.session.homeId !== target.homeId || target.enrolledMachineId !== options.machineId
            || target.origin.pendingRequestId !== activation.requestId || target.origin.requestedAt !== activation.requestedAt) {
            return { type: 'pending' };
        }
        const account = await captureLazyActionAccountContext(serverId);
        try {
            if (account.serverIdentityId !== target.homeId
                || (options.accountLifetime && !areServerAccountScopesEqual(account.accountLifetime.scope, options.accountLifetime.scope))) return { type: 'pending' };
            const managed = await createManagedMachineActionClient({ request: account.request }).execute('machines.managed.get', {
                homeId: target.homeId, managedId: target.managedId,
            });
            account.assertCurrent();
            const observed = managed.observation;
            if (options.accountLifetime?.isCurrent() === false || managed.id !== target.managedId
                || managed.homeId !== target.homeId || managed.enrolledMachineId !== target.enrolledMachineId
                || managed.creationState !== 'active' || managed.allocation === 'confirmed-absent'
                || activation.status !== 'waiting' || observed?.availability !== 'present'
                || observed.power !== 'running' || observed.storage === 'lost' || observed.daemon !== 'connected') return { type: 'pending' };
        } catch {
            // Missing/unknown native observations leave accepted custody intact.
            // Server/controller wake and guest activation retain their owners.
            return { type: 'pending' };
        } finally { account.dispose(); }
    }
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
    const state = storage.getState();
    const daemonCliVersion = readMachineDaemonCliVersionForServerScope({
        state,
        machineId,
        serverId,
        activeServerId: state.profileScope?.serverId,
    });
    const requestId = supportsSessionForkRequestId(daemonCliVersion)
        && typeof options.requestId === 'string'
        && options.requestId.trim().length > 0
        ? options.requestId
        : null;
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
            authorization: { kind: 'session.write', sessionId: options.parentSessionId },
            payload: {
                v: 1,
                parentSessionId: options.parentSessionId,
                forkPoint: options.forkPoint,
                strategy: options.strategy,
                replaySummaryRunner: options.replaySummaryRunner,
                replayMaxSeedChars: options.replayMaxSeedChars,
                ...(requestId
                    ? { requestId }
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
        // Preserve setup failures only when the transport proves this attempt
        // was not sent. An issued fork still requires lineage reconciliation.
        const setupErrorCode = readRpcRequestDisposition(error) === 'notSent'
            ? readSessionRpcErrorCode(error) ?? (isMachineRpcTimeoutError(error) ? MACHINE_RPC_TIMEOUT_ERROR_CODE : undefined)
            : undefined;
        return {
            ok: false,
            errorCode: setupErrorCode ?? 'UNEXPECTED',
            errorMessage: error instanceof Error ? error.message : 'Failed to fork session',
        };
    }
}

export async function rollbackSessionConversation(options: Readonly<{
    sessionId: string;
    signal?: AbortSignal;
    serverId?: string | null;
    target?: SessionRollbackTarget;
    currentAgentCapabilities?: CurrentProjectedAgentCapabilities | null;
}>): Promise<SessionRollbackRpcResult> {
    const target = options.target ?? { type: 'latest_turn' };
    const session = storage.getState().sessions[options.sessionId];
    if (session?.active === false && target.type === 'before_user_message') {
        const state = storage.getState();
        const serverId = options.serverId ?? resolvePreferredServerIdForSessionId(options.sessionId);
        const machineId = readMachineControlTargetForSession(options.sessionId)?.machineId ?? null;
        const agentId = resolveAgentIdFromSessionMetadata(readSessionOwnerMetadataView(session));
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        const pluginSettings = await readAgentScopedPluginSettingsSnapshot({
            agentId,
            machineId,
            serverId,
            accountLifetime,
            accountSettings: state.settings,
            ...(options.signal ? { signal: options.signal } : {}),
        });
        if (accountLifetime && !accountLifetime.isCurrent()) {
            return {
                ok: false,
                errorCode: 'session_rollback_resume_unavailable',
                errorMessage: 'This inactive session cannot be resumed for rollback',
            };
        }
        const resumeOptions = getPendingQueueWakeResumeOptions({
            sessionId: options.sessionId,
            session,
            resumeCapabilityOptions: {
                ...buildResumeCapabilityOptionsFromUiState({
                    settings: state.settings,
                    pluginSettings,
                    results: undefined,
                }),
                currentAgentCapabilities: options.currentAgentCapabilities,
            },
        });
        if (!resumeOptions) {
            return {
                ok: false,
                errorCode: 'session_rollback_resume_unavailable',
                errorMessage: 'This inactive session cannot be resumed for rollback',
            };
        }

        const resumeResult = await resumeSession({
            ...resumeOptions,
            ...(serverId ? { serverId } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
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
                    ...(options.signal ? { signal: options.signal } : {}),
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
            ...(options.signal ? { signal: options.signal } : {}),
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
    signal?: AbortSignal;
    serverId?: string | null;
}>): Promise<CheckpointCodeRollbackResult> {
    try {
        const raw = await sessionRpcWithServerScope<unknown, unknown>({
            sessionId: options.request.sessionId,
            serverId: options.serverId,
            method: SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK,
            payload: options.request,
            ...(options.signal ? { signal: options.signal } : {}),
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

function applySessionThinkingDecisionRecovery(
    sessionId: string,
    scope: ServerAccountScope | null,
    serverId: string,
): void {
    const activeScope = getActiveServerAccountScope();
    if (scope === null ? activeScope !== null : !areServerAccountScopesEqual(scope, activeScope)) return;
    if (!areServerProfileIdentifiersEquivalent(serverId, getActiveServerSnapshot().serverId)) return;
    const session = storage.getState().sessions[sessionId];
    storage.getState().clearSessionOptimisticThinking(sessionId);
    storage.getState().clearSessionThinkingGrace(sessionId);
    if (!session || session.thinking !== true) return;
    storage.getState().applySessions([{ ...session, thinking: false, updatedAt: nowServerMs() }], 'projection');
}

export async function sessionAbort(sessionId: string, options?: Readonly<{ serverId?: string; signal?: AbortSignal }>): Promise<void> {
    const recoveryScope = getActiveServerAccountScope();
    const serverId = options?.serverId ?? resolvePreferredServerIdForSessionId(sessionId)
        ?? getActiveServerSnapshot().serverId;
    try {
        await sessionRpcWithPreferredSessionScope<void, { reason: string }>({
            sessionId,
            ...(options?.serverId !== undefined ? { serverId: options.serverId } : {}),
            method: 'abort',
            ...(options?.signal ? { signal: options.signal } : {}),
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

    // The caller's Account lifetime can retire after an authoritative reply.
    if (options?.signal?.aborted) return;

    // Best-effort recovery belongs only to the Account and Home captured before issuance.
    applySessionThinkingDecisionRecovery(sessionId, recoveryScope, serverId);
}

/**
 * Respond to one Session permission request, including the composed Stop action.
 */
export async function sessionRespondToPermission(
    sessionId: string,
    params: Omit<SessionPermissionRespondRpcParamsV1, 'answers'>,
    options?: Readonly<{ serverId?: string; signal?: AbortSignal; onIssued?: () => void }>,
): Promise<void> {
    if (params.decision !== 'abort') {
        await sendSessionPermissionResponse(sessionId, params, options);
        return;
    }
    // Stop is one composed Session action. Retain its target Account across
    // permission admission and abort instead of borrowing the next login.
    const serverId = options?.serverId ?? resolvePreferredServerIdForSessionId(sessionId)
        ?? getActiveServerSnapshot().serverId;
    const account = await captureLazyActionAccountContext(serverId, options?.signal);
    try {
        await withActionAccountRequestSignal(account, options?.signal, async (signal) => {
            account.assertCurrent();
            await sendSessionPermissionResponse(sessionId, params, { serverId, signal, onIssued: options?.onIssued });
            account.assertCurrent();
            await sessionAbort(sessionId, { serverId, signal });
        });
    } finally {
        account.dispose();
    }
}

type ScopedSessionPermissionResponseOptions = Readonly<{
    scope: ServerAccountScope;
    networkMode?: 'background-task';
    signal?: AbortSignal;
    onIssued?: () => void;
}>;

/** Respond to an exact notification request without rebinding its turn to mounted UI state. */
export async function sessionRespondToPermissionWithServerAccountScope(
    sessionId: string,
    params: Omit<SessionPermissionRespondRpcParamsV1, 'answers' | 'decision' | 'turnId'> & Readonly<{
        turnId: string;
        decision?: Exclude<SessionPermissionRespondRpcParamsV1['decision'], 'abort'>;
    }>,
    options: ScopedSessionPermissionResponseOptions,
): Promise<void> {
    const request = !params.approved && params.reason === undefined
        ? { ...params, reason: 'Denied from notification' }
        : params;
    await sendSessionPermissionResponse(sessionId, request, options);
}

function assertSessionInteractionResponseApplied(result: unknown): void {
    // The receiver's established success result is void. A structured success is
    // also accepted; transport delivery alone cannot admit an invalid result.
    if (result === undefined) return;
    if (result && typeof result === 'object' && 'ok' in result) {
        if (result.ok === true) return;
        if (result.ok === false && 'errorCode' in result
            && typeof result.errorCode === 'string' && result.errorCode.length > 0) {
            throw createRpcCallError({ error: result.errorCode, errorCode: result.errorCode });
        }
    }
    throw createRpcCallError({
        error: 'Invalid Session interaction response',
        errorCode: 'session_interaction_response_invalid',
    });
}

async function sendSessionPermissionResponse(
    sessionId: string,
    params: Omit<SessionPermissionRespondRpcParamsV1, 'answers'>,
    options?: Readonly<{ serverId?: string; signal?: AbortSignal; onIssued?: () => void }> | ScopedSessionPermissionResponseOptions,
): Promise<void> {
    const exactScope = options && 'scope' in options ? options : null;
    const serverId = options && 'serverId' in options ? options.serverId : undefined;
    const recoveryScope = exactScope?.scope ?? getActiveServerAccountScope();
    const recoveryServerId = exactScope?.scope.serverId ?? serverId
        ?? resolvePreferredServerIdForSessionId(sessionId) ?? getActiveServerSnapshot().serverId;
    const request: SessionPermissionRespondRpcParamsV1 = {
        ...params,
        answeringClientCategory: readAnsweringClientCategory(),
        turnId: exactScope ? params.turnId : resolveSessionPermissionTurnId(sessionId, params.id, params.turnId, serverId),
    };
    const call = {
        sessionId,
        method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
        payload: request,
        ...(options?.signal ? { signal: options.signal } : {}),
        // The permission owner settles the admitted answer. Connection setup
        // stays bounded; the generic RPC cutoff cannot declare its effect failed.
        timeoutMs: null,
        ...(options?.onIssued ? { onIssued: options.onIssued } : {}),
    };
    const result = exactScope
        ? await sessionRpcWithServerAccountScope<unknown, SessionPermissionRespondRpcParamsV1>({
            ...call, scope: exactScope.scope, networkMode: exactScope.networkMode, onIssued: exactScope.onIssued,
        })
        : await sessionRpcWithPreferredSessionScope<unknown, SessionPermissionRespondRpcParamsV1>({
            ...call, ...(serverId !== undefined ? { serverId } : {}),
        });
    assertSessionInteractionResponseApplied(result);
    if (params.approved) return;
    // Keep deny's existing best-effort thinking recovery on the applied Home.
    // Exact external decisions must also prove the mounted Account. A known
    // newer same-ID turn cannot inherit recovery from the admitted response.
    const currentRequest = storage.getState().sessions[sessionId]?.agentState?.requests?.[params.id];
    if (currentRequest && currentRequest.turnId !== request.turnId) return;
    applySessionThinkingDecisionRecovery(sessionId, recoveryScope, recoveryServerId);
}

/** The executing client's category, as stamped on an answer; the question card compares it to say where one was given. */
export function readAnsweringClientCategory(): SessionPermissionRespondRpcParamsV1['answeringClientCategory'] {
    // Platform evidence describes this executing client, never the Account or
    // the Session's machine. A desktop browser is still a web client.
    if (Platform.OS === 'web' && isDesktopHost()) return 'desktop';
    return Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web'
        ? Platform.OS : undefined;
}

export async function sessionAllow(
    sessionId: string,
    id: string,
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    allowedTools?: string[],
    decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment',
    execPolicyAmendment?: { command: string[] },
    turnId?: string,
    options?: Readonly<{ serverId?: string; signal?: AbortSignal }>,
): Promise<void> {
    const request: SessionPermissionRespondRpcParamsV1 = {
        id,
        turnId,
        approved: true,
        mode,
        allowedTools,
        decision,
        execPolicyAmendment
    };
    await sessionRespondToPermission(sessionId, request, options);
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
        turnId?: string;
        serverId?: string;
        signal?: AbortSignal;
    }>,
): Promise<void> {
    const request: SessionPermissionRespondRpcParamsV1 = {
        id,
        turnId: params.turnId,
        approved: true,
        mode: params.mode,
        allowedTools: params.allowedTools,
        decision: params.decision,
        updatedPermissions: params.updatedPermissions,
    };
    await sessionRespondToPermission(sessionId, request, { serverId: params.serverId, signal: params.signal });
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
    options?: Readonly<{ serverId?: string; signal?: AbortSignal }>,
): Promise<void> {
    const request: SessionPermissionRespondRpcParamsV1 = {
        id,
        approved: true,
        answers,
    };
    await sessionRespondToUserAction(sessionId, request, options);
}

/** Shared user-action response effect below canonical Action admission. */
export async function sessionRespondToUserAction(
    sessionId: string,
    params: SessionUserActionAnswerRpcParamsV1,
    options?: Readonly<{ serverId?: string; signal?: AbortSignal; onIssued?: () => void }>,
): Promise<unknown> {
    const result = await sessionRpcWithPreferredSessionScope<unknown, SessionUserActionAnswerRpcParamsV1>({
        sessionId,
        ...(options?.serverId !== undefined ? { serverId: options.serverId } : {}),
        method: RPC_METHODS.SESSION_USER_ACTION_ANSWER,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.onIssued ? { onIssued: options.onIssued } : {}),
        payload: 'disposition' in params ? params : { ...params, answeringClientCategory: readAnsweringClientCategory() },
    });
    assertSessionInteractionResponseApplied(result);
    return result;
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
    turnId?: string,
    options?: Readonly<{ serverId?: string; signal?: AbortSignal }>,
): Promise<void> {
    const request: SessionPermissionRespondRpcParamsV1 = {
        id,
        turnId,
        approved: false,
        mode,
        allowedTools,
        decision,
        reason,
    };
    // Legacy callers compose their own abort after deny; preserve that API
    // while sharing the single response transport and recovery owner.
    await sendSessionPermissionResponse(sessionId, request, options);
}

/**
 * Request mode change for a session
 */
export async function sessionSwitch(
    sessionId: string,
    to: 'remote' | 'local',
    options?: Readonly<{
        serverId?: string | null;
        accountLifetime?: ServerAccountScopeLifetime;
        signal?: AbortSignal;
        onIssued?: () => void;
    }>,
): Promise<boolean> {
    const request: SessionModeChangeRequest = { to };
    if (options?.accountLifetime) {
        const lifetime = options.accountLifetime;
        const assertCurrent = (): void => {
            if (
                !lifetime.isCurrent()
                || (options.serverId !== undefined
                    && options.serverId !== null
                    && !areServerProfileIdentifiersEquivalent(options.serverId, lifetime.scope.serverId))
            ) {
                throw Object.assign(
                    new Error('Session Account authority retired before control switch'),
                    { code: 'session_account_scope_retired' },
                );
            }
        };
        assertCurrent();
        const retired = new AbortController();
        const retirement = lifetime.onRetire(() => retired.abort());
        const cancellation = mergeAbortSignals([options.signal, retired.signal]);
        try {
            const response = await sessionRpcWithServerAccountScope<boolean, SessionModeChangeRequest>({
                sessionId,
                scope: lifetime.scope,
                method: 'switch',
                payload: request,
                onIssued: () => {
                    assertCurrent();
                    options.onIssued?.();
                },
                signal: cancellation.signal,
            });
            assertCurrent();
            return response;
        } finally {
            cancellation.dispose();
            retirement.dispose();
        }
    }
    const response = await sessionRpcWithPreferredSessionScope<boolean, SessionModeChangeRequest>({
        sessionId,
        ...(options?.serverId ? { serverId: options.serverId } : {}),
        method: 'switch',
        payload: request,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.onIssued ? { onIssued: options.onIssued } : {}),
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
export async function sessionBash(sessionId: string, request: SessionBashRequest, options?: Readonly<{ signal?: AbortSignal }>): Promise<SessionBashResponse> {
    try {
        const response = await sessionRpcWithPreferredSessionScope<SessionBashResponse, SessionBashRequest>({
            sessionId,
            method: 'bash',
            payload: request,
            ...(options?.signal ? { signal: options.signal } : {}),
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
    options?: SessionReadLogTailRequest & Readonly<{ signal?: AbortSignal }>,
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
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        return assertRpcResponseWithSuccess<SessionReadLogTailResponse>(response);
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

export type SessionStopResponse = SessionStopResult & Readonly<{
    success: boolean;
    message?: string;
    code?: import('./sessionStopContract').SessionStopResponseCode;
    recovery?: import('./sessionStopContract').SessionStopRecovery;
}>;

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
    opts?: Omit<Parameters<typeof stopSessionUsingCanonicalStrategy>[0], 'sessionId'> & Readonly<{
        actionContext?: ActionExecutorContext;
    }>,
): Promise<SessionStopResponse> {
    let accountContext: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
    let stopResult: Awaited<ReturnType<typeof stopSessionUsingCanonicalStrategy>>;
    try {
        const intent = resolveSessionExplicitControlIntent({ rawSession: { id: sessionId }, actionContext: opts?.actionContext });
        if (intent === 'unauthorized' || intent === 'self_stop_forbidden') throw new Error('Explicit Stop caller unavailable');
        let scope = opts?.scope;
        let isCurrent = opts?.isCurrent;
        if (intent !== 'automatic') {
            const serverId = opts?.serverId ?? scope?.serverId ?? resolvePreferredServerIdForSessionId(sessionId)
                ?? getActiveServerSnapshot().serverId;
            if (!scope) {
                accountContext = await captureLazyActionAccountContext(serverId, opts?.signal);
                scope = accountContext.accountLifetime.scope;
                isCurrent = accountContext.accountLifetime.isCurrent;
            }
            const accountLifetime = { scope, isCurrent: isCurrent ?? (() => true) };
            const assertCurrent = () => {
                opts?.signal?.throwIfAborted();
                if (!accountLifetime.isCurrent()) throw new Error('Session Account authority retired before Stop');
            };
            assertCurrent();
            const stop = { v: 1, cause: 'explicit_stop', requestId: randomUUID(), requestedAtMs: nowServerMs(),
                ...(intent === 'manager' && opts?.actionContext?.actionCaller?.kind === 'session'
                    ? { managerSessionId: opts.actionContext.actionCaller.sessionId } : {}),
            } as const;
            // The UI owns Account credentials; restricted runners only receive
            // the existing physical Stop after the owner tuple acknowledges it.
            await getSyncSingleton().patchSessionMetadataWithRetry(sessionId,
                metadata => writeSessionExplicitStopV1ToMetadata(metadata, stop), {
                    serverId, accountLifetime,
                    shouldContinue: () => !opts?.signal?.aborted && accountLifetime.isCurrent(),
                });
            assertCurrent();
        }
        stopResult = await stopSessionUsingCanonicalStrategy({
            ...opts, sessionId, serverId: opts?.serverId ?? scope?.serverId ?? null,
            ...(scope ? { scope } : {}), ...(isCurrent ? { isCurrent } : {}),
        });
    } catch (error) {
        return { sessionId, stopped: false, success: false, code: 'session_stop_control_unavailable',
            message: error instanceof Error ? error.message : 'Session Stop control unavailable' };
    } finally {
        accountContext?.dispose();
    }
    const confirmation: SessionStopResult = stopResult.success
        ? stopResult.stopOutcome
            ? { sessionId, stopped: false, stopOutcome: stopResult.stopOutcome }
            : { sessionId, stopped: true }
        : { sessionId, stopped: false };
    if (stopResult.success) {
        return { ...confirmation, success: true };
    }

    if (stopResult.reason === 'requested') {
        return {
            ...confirmation,
            success: false,
            message: stopResult.message,
            code: 'session_stop_requested',
            recovery: stopResult.recovery,
        };
    }

    if (stopResult.reason === 'not_found') {
        return { ...confirmation, success: false, message: stopResult.message, code: 'session_stop_not_found' };
    }

    if (stopResult.reason === 'control_unavailable') {
        return {
            ...confirmation,
            success: false,
            message: stopResult.message,
            code: 'session_stop_control_unavailable',
            recovery: stopResult.recovery,
        };
    }

    return { ...confirmation, success: false, message: stopResult.message, code: 'session_stop_failed' };
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
type ArchiveRequestResult<T> = Readonly<{ response: T; address: SessionAddress; release: () => Promise<void> }>;
function archiveRequestWithContext(params: ArchiveRequestParams): Promise<ArchiveRequestResult<Response>>;
function archiveRequestWithContext<T>(params: ArchiveRequestParams, consumeResponse: (response: Response) => Promise<T>): Promise<ArchiveRequestResult<T>>;
async function archiveRequestWithContext<T>(params: ArchiveRequestParams, consumeResponse?: (response: Response) => Promise<T>): Promise<ArchiveRequestResult<Response | T>> {
    const address = resolveSessionArchiveAddress({
        serverId: params.serverId ?? resolvePreferredServerIdForSessionId(params.sessionId) ?? getActiveServerSnapshot().serverId,
        sessionId: params.sessionId,
    });
    if (!address) throw new Error('Archive requires an exact Home-qualified Session');
    const context = await resolveServerAccountRequestContext({ serverId: address.serverId, signal: params.signal });
    const path = `/v2/sessions/${params.sessionId}/${params.action}`;

    try {
        throwIfAborted(params.signal);
        const request = createServerRequestForResolvedServerScope({
            context,
            activeRequest: apiSocket.request.bind(apiSocket),
        });
        const init = { method: 'POST', ...(params.signal ? { signal: params.signal } : {}) };
        const response = consumeResponse ? await request(path, init, undefined, consumeResponse)
            : await request(path, init);
        return {
            response,
            address,
            release: context.scope === 'scoped' ? (context.release ?? (async () => undefined)) : async () => undefined,
        };
    } catch (error) {
        if (context.scope === 'scoped') await context.release?.();
        throw error;
    }
}

async function applyArchivedAtToLocalSession(capturedAddress: SessionAddress, archivedAt: number | null): Promise<void> {
    const address = resolveSessionArchiveAddress(capturedAddress);
    if (!address) return;
    const updatedAt = nowServerMs();
    storage.getState().applyServerScopedSessionListRowPatches(address.serverId, [
        { sessionId: address.sessionId, patch: { archivedAt, updatedAt } },
    ]);
    const state = storage.getState();
    const session = state.sessions[address.sessionId];
    if (!session || !areServerProfileIdentifiersEquivalent(address.serverId, getActiveServerSnapshot().serverId)
        || (session.serverId && !areServerProfileIdentifiersEquivalent(session.serverId, address.serverId))) return;
    state.applySessions([{ ...session, archivedAt, updatedAt }], 'projection');
}

export async function sessionArchiveWithServerScope(
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null; signal?: AbortSignal }>,
): Promise<SessionArchiveResponse> {
    try {
        return await withSessionArchiveDeadline(opts?.signal, async signal => {
            const request = await archiveRequestWithContext({ sessionId, serverId: opts?.serverId ?? null, action: 'archive', signal }, async (response): Promise<SessionArchiveResponse> => {
                if (!response.ok) {
                    const message = await response.text().catch(() => '');
                    throwIfAborted(signal);
                    if (response.status === 409) return { success: false, message: SESSION_ACTIVE_ARCHIVE_MESSAGE, code: 'session_active' };
                    return { success: false, message: message || 'Failed to archive session' };
                }
                const json: unknown = await response.json().catch(() => null);
                throwIfAborted(signal);
                const archivedAt = json && typeof json === 'object' && 'archivedAt' in json && typeof json.archivedAt === 'number'
                    ? json.archivedAt : null;
                return { success: true, archivedAt };
            });
            try {
                throwIfAborted(signal);
                if (request.response.success) await applyArchivedAtToLocalSession(request.address, request.response.archivedAt ?? null);
                return request.response;
            } finally { await request.release(); }
        });
    } catch (error) {
        if (error instanceof SessionArchiveTimeoutError) return { success: false, code: 'session_archive_timeout' };
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

export async function sessionUnarchiveWithServerScope(
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionArchiveResponse> {
    try {
        const request = await archiveRequestWithContext({ sessionId, serverId: opts?.serverId ?? null, action: 'unarchive' });
        try {
        const { response } = request;
        if (!response.ok) {
            const message = await response.text().catch(() => '');
            return { success: false, message: message || 'Failed to unarchive session' };
        }
        await response.json().catch(() => null);
        await applyArchivedAtToLocalSession(request.address, null);
        return { success: true, archivedAt: null };
        } finally {
            await request.release();
        }
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Why a session delete failed, when the server said something the caller can act on.
 *
 * - `session_absent`: the server answered 404 — the session is gone, or was never
 *   owned by this Account. Nothing further will ever delete it, so a caller holding
 *   local state for that exact id may safely retire it.
 * - `session_active`: the Session must be stopped before deletion. The Session and
 *   its local state remain live.
 * - `session_delete_conflict`: the server answered 409 — it found the session but
 *   lost the delete condition to a concurrent write. The session still exists and
 *   the same delete can be retried; local state must be kept.
 *
 * Absent is deliberately not folded into the generic failure: collapsing the two
 * either strands decrypted local rows for a session the server no longer has, or
 * discards live rows on a transient conflict.
 */
export type SessionDeleteFailureCode = 'session_absent' | 'session_active' | 'session_delete_conflict';

export type SessionDeleteResult = Readonly<{
    success: boolean;
    message?: string;
    code?: SessionDeleteFailureCode;
}>;

function isSessionDeleteFailureCode(value: string): value is SessionDeleteFailureCode {
    return value === 'session_absent' || value === 'session_active' || value === 'session_delete_conflict';
}

/**
 * Internal Voice-history cleanup uses its already-bound Account authority.
 * User-command deletion is admitted by the canonical session.delete Action.
 */
async function readSessionDeleteFailure(response: Response): Promise<SessionDeleteResult> {
    const error = await response.text().catch(() => '');
    let payload: unknown = null;
    try {
        payload = JSON.parse(error);
    } catch {
        // The message remains useful, but an unstructured body cannot prove a typed refusal.
    }
    const refusal = readHomeDomainActionErrorV1(payload);
    const code = refusal && isSessionDeleteFailureCode(refusal.code) ? refusal.code : undefined;
    return {
        success: false,
        message: error || 'Failed to delete session',
        ...(code ? { code } : null),
    };
}

export async function sessionDeleteWithServerAccountAuthority(
    sessionId: string,
    authority: Pick<ServerAccountRequestAuthority, 'request'>,
): Promise<SessionDeleteResult> {
    try {
        const response = await authority.request(
            `/v1/sessions/${encodeURIComponent(sessionId)}`,
            { method: 'DELETE' },
        );
        if (response.ok) {
            await response.json().catch(() => null);
            return { success: true };
        }
        return await readSessionDeleteFailure(response);
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
                    {
                        serverId: options?.serverId ?? null,
                        mutationIntent: 'rename_session',
                    },
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
