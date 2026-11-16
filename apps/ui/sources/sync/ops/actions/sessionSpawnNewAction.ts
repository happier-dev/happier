import { RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionLookupByTagsResponseV2Schema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { normalizeSessionCreationOrganizationPlacementV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionSpawnNewResultV1Schema, SessionSpawnNewActionResultV1Schema, readSessionSpawnNewActionResultV1,
    type SessionSpawnNewInitialInputDispositionV1, type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectSessionSpawnNewActionInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { supportsMachineSessionSpawnProtocolVersionV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { projectSessionFollowSourceKeyPreparationAfterSetV1, type SessionFollowSourceKeyPreparationResultV1, SessionFollowSourceKeyPreparationResultV1Schema, SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { readSessionCreationTargetPreparationResultV1, needsSessionCreationDirectoryApprovalPreflightV1,
    projectSessionCreationTargetPreparationRpcFailureV1,
    projectSessionCreationDirectoryApprovalV1,
    type SessionCreationTargetPreparationRequestV1,
} from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import type { UiActionExecutorContext } from './defaultActionExecutor';
import type { SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { SessionRequesterBootstrapV1, SessionRequesterBootstrapRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createSpawnAttemptKeyForSessionSpawnNewInput } from '@/sync/domains/session/spawn/spawnAttemptKey';
import {
    acquireSpawnAttemptCustody,
    clearSpawnAttemptCustody,
    markSpawnAttemptCreated,
    type PersistedSpawnAttempt,
} from '@/sync/domains/session/spawn/spawnAttemptNonceStore';
import { settleManualSessionSpawnNewActionCustody } from './sessionSpawnNewCustody';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '@/sync/domains/session/spawn/spawnSessionRpcTimeout';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcTimeoutError';
import { ScopedRpcSocketConnectionTimeoutError } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { isSocketIoAckTimeoutError, readRpcRequestDisposition } from '@happier-dev/sync-client';
import { parseToken } from '@/utils/auth/parseToken';

import { createFrontDoorActionExecute, requireActionSuccess } from './frontDoorRuntimeActionExecutor';
import { captureLazyActionAccountContext, withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { prepareSessionFollowSourceKey } from '@/components/sessions/follow/prepareSessionFollowSourceKey';
import { t } from '@/text';
import { buildManualSessionCreationKey, readManualSessionSpawnOperation, readManualSessionSpawnOperationDetails } from '@/sync/domains/session/spawn/manualSessionSpawnOperation';
import { recordBugReportUserAction } from '@/utils/system/bugReportActionTrail';
export { buildManualSessionCreationKey } from '@/sync/domains/session/spawn/manualSessionSpawnOperation';

export type StrictSessionSpawnNewInput = SessionSpawnNewInputV2 & Readonly<{
    creationKey: NonNullable<SessionSpawnNewInputV2['creationKey']>;
}>;

export type SessionSpawnNewActionResult =
    | Readonly<{ ok: true; result: SessionSpawnNewResultV1 }>
    | Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

/** Session existence is presentation proof, never native readiness or input acceptance. */
export type SessionSpawnNewCommittedReceipt = Readonly<{
    sessionId: string;
    executionTarget: SessionSpawnNewInputV2['executionTarget'];
    /** Manual launch custody's creation-derived first-input identity, still owned by the launch. */
    firstTurnLocalId?: string;
}>;

export type SessionSpawnNewActionObservation = Readonly<{
    operationProtocolCapabilities?: unknown;
    /** The target accepted this creation, or returned its validated terminal success. */
    onAccepted?: (receipt: Readonly<{
        operation?: NonNullable<Extract<SessionSpawnNewResultV1, { type: 'pending' }>['operation']>;
    }>) => void | Promise<void>;
    onCommitted?: (receipt: SessionSpawnNewCommittedReceipt) => void | Promise<void>;
}>;

/** Preserve recognized transport causes without copying private exception messages into the result. */
function projectSessionSpawnSetupTransportFailure(error: unknown) {
    const rpcErrorCode = readRpcErrorCode(error);
    const code = rpcErrorCode
        ?? (error && typeof error === 'object' && 'code' in error ? error.code : undefined);
    const timedOut = code === MACHINE_RPC_TIMEOUT_ERROR_CODE || (code === undefined && isSocketIoAckTimeoutError(error));
    const unavailable = code === RPC_ERROR_CODES.OUTCOME_UNKNOWN || code === RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE;
    if (!timedOut && !unavailable) return null;
    return {
        type: 'error', code: 'spawn_failed', retryable: true,
        launchError: { kind: 'launch_error',
            // An unconfirmed setup read cannot make Session creation uncertain.
            // Retain its original RPC cause separately from this pre-effect verdict.
            code: unavailable ? RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE : MACHINE_RPC_TIMEOUT_ERROR_CODE,
            ...(rpcErrorCode === MACHINE_RPC_TIMEOUT_ERROR_CODE || rpcErrorCode === RPC_ERROR_CODES.OUTCOME_UNKNOWN
                || rpcErrorCode === RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE ? { rpcErrorCode } : {}),
            ...(error instanceof ScopedRpcSocketConnectionTimeoutError ? { connectionPhase: error.connectionPhase } : {}),
            message: code === RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE ? code : code === RPC_ERROR_CODES.OUTCOME_UNKNOWN
                ? 'Session creation transport lost its acknowledgement before a spawn request was issued.'
                : 'Session creation transport timed out before a spawn request was issued.',
        },
    } satisfies Extract<SessionSpawnNewResultV1, { type: 'error' }>;
}

/** Explicit launch prepares the requester before reviewing directory creation. */
export function createUiSessionSpawnNewDirectoryApprovalPreflight(
    account: LazyActionAccountContext | null,
): NonNullable<ActionExecutorDeps['sessionSpawnNewDirectoryApprovalPreflight']> {
    return async ({ input, signal }) => {
        if (!needsSessionCreationDirectoryApprovalPreflightV1(input)) return { type: 'not_required' };
        if (!account) return { type: 'error', result: { type: 'error', code: 'permission_denied', retryable: false } };
        account.assertCurrent();
        let raw: unknown;
        try {
            raw = await withActionAccountRequestSignal(account, signal, ownedSignal => machineRpcWithServerScope<unknown, SessionCreationTargetPreparationRequestV1>({
                serverId: input.executionTarget.serverId, accountId: account.accountId,
                machineId: input.executionTarget.machineId, method: RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
                payload: { directory: input.directory, prepareAgentIsolationMember: true }, signal: ownedSignal,
            }));
        } catch (error) {
            if (signal?.aborted) throw error;
            const refusal = projectSessionCreationTargetPreparationRpcFailureV1(error);
            if (refusal) return { type: 'error', result: refusal };
            const failure = projectSessionSpawnSetupTransportFailure(error);
            if (failure) {
                recordBugReportUserAction('session.spawn_new.directory_preflight_failure', {
                    metadata: { phase: 'setup', spawnIssued: false,
                        errorCode: failure.launchError?.code ?? 'unknown',
                        rpcErrorCode: failure.launchError?.rpcErrorCode ?? 'unknown',
                        requestDisposition: readRpcRequestDisposition(error) ?? 'unknown',
                    },
                });
                return { type: 'error', result: failure };
            }
            throw error;
        }
        account.assertCurrent();
        const prepared = readSessionCreationTargetPreparationResultV1(raw);
        if (!prepared.ok) return { type: 'error', result: prepared.result };
        const approval = projectSessionCreationDirectoryApprovalV1(input.executionTarget, prepared.preparedTarget);
        return approval ? { type: 'approval_required', approval } : { type: 'not_required' };
    };
}

export type ManualSessionSpawnNewActionCustody = PersistedSpawnAttempt;

/** A waiting private-key transfer is not a failed creation; consume only its validated committed DTO. */
export function readCommittedSessionSpawnNewActionResult(action: SessionSpawnNewActionResult):
    Extract<SessionSpawnNewResultV1, Readonly<{ type: 'success' }>> | null {
    if (action.ok) return action.result.type === 'success' ? action.result : null;
    if (action.errorCode !== SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1) return null;
    const details = action.details;
    if (!details || typeof details !== 'object') return null;
    const record = details as Readonly<Record<string, unknown>>;
    if (record.status !== 'waiting' || record.edgeCommitted !== true) return null;
    const preparation = SessionFollowSourceKeyPreparationResultV1Schema.safeParse({ kind: 'waiting', reason: record.reason });
    const committed = SessionSpawnNewResultV1Schema.safeParse(record.source);
    return preparation.success && committed.success && committed.data.type === 'success' ? committed.data : null;
}

/** The authenticated request qualifies a daemon result; daemon-local Home names are not client routes. */
function qualifySessionSpawnNewActionResult(
    action: SessionSpawnNewActionResult,
    executionTarget: SessionSpawnNewInputV2['executionTarget'],
): SessionSpawnNewActionResult {
    const committed = readCommittedSessionSpawnNewActionResult(action);
    if (!committed) return action;
    if (committed.executionTarget.machineId !== executionTarget.machineId) return { ok: false,
        errorCode: 'action_operation_result_unavailable', error: 'action_operation_result_unavailable' };
    const result = { ...committed, executionTarget: { ...committed.executionTarget, serverId: executionTarget.serverId } };
    if (action.ok) return { ok: true, result };
    return { ...action, details: { ...(typeof action.details === 'object' ? action.details : {}), source: result } };
}

/**
 * The one step that asks for a Session to be created. The UI's own Action executor is the
 * default; a presentation host that owns creation itself (the embed's new chat, plan 05 §4.3.5)
 * supplies its own. Custody, creation identity and retry stay with the manual launch owner.
 */
export type SessionSpawnNewActionExecutor = (
    input: StrictSessionSpawnNewInput,
    context: UiActionExecutorContext,
    observation?: SessionSpawnNewActionObservation,
) => Promise<SessionSpawnNewActionResult>;

export type ManualSessionSpawnNewActionExecutionResult =
    | Readonly<{
        status: 'executed';
        action: SessionSpawnNewActionResult;
        custody: ManualSessionSpawnNewActionCustody;
    }>
    | Readonly<{
        status: 'custody_unavailable';
        reason: 'corrupt' | 'lock_unavailable';
    }>;

export { resolveSessionSpawnNewActionFailurePresentation, resolveSessionSpawnNewActionFailureMessageKey,
    resolveSessionSpawnNewResultFailureMessageKey, resolveSessionSpawnNewActionFailureMessage,
    resolveSessionSpawnNewResultFailureMessage, resolveSessionSpawnNewOperationFailureMessage,
    resolveSessionSpawnNewInitialInputFailureMessage, type SessionSpawnNewActionFailurePresentation,
    type SessionSpawnNewActionFailureMessageKey, type SessionSpawnNewResultFailureMessageKey } from './sessionSpawnFailurePresentation';

/**
 * UI's sole public ordinary Session-creation client. The Action executor owns
 * transport, trusted caller stamping, approvals, cancellation, and typed
 * method-unavailable results; callers supply only strict V2 authored input.
 */
export async function executeSessionSpawnNewAction(
    input: StrictSessionSpawnNewInput,
    context: UiActionExecutorContext,
    executor?: Parameters<typeof createFrontDoorActionExecute>[0],
    observation?: SessionSpawnNewActionObservation,
): Promise<SessionSpawnNewActionResult> {
    const execute = createFrontDoorActionExecute(executor);
    // Observation belongs to this caller, never a retained recipe or another
    // observer. Strict older daemons must never receive an unnegotiated field.
    const { observeSessionCommit: _previousObservation, ...terminalInput } = input;
    const onCommitted = observation?.onCommitted;
    const observeCommit = onCommitted !== undefined
        && supportsMachineSessionSpawnProtocolVersionV1(observation?.operationProtocolCapabilities, 3);
    const dispatch = input.isolationOverride === 'directly' ? execute.confirmed : execute;
    const result = await dispatch('session.spawn_new', projectSessionSpawnNewActionInputV2({
        ...terminalInput, ...(observeCommit ? { observeSessionCommit: true } : {}),
    }), context);
    if (!result.ok) return qualifySessionSpawnNewActionResult(result, input.executionTarget);
    requireActionSuccess(result);
    const spawn = readSessionSpawnNewActionResultV1(SessionSpawnNewActionResultV1Schema.parse(result.result));
    const unavailable = (): SessionSpawnNewActionResult => ({ ok: false,
        errorCode: 'action_operation_result_unavailable', error: 'action_operation_result_unavailable' });
    if (spawn.type === 'pending' && spawn.operation
        && spawn.operation.machineId !== input.executionTarget.machineId) return unavailable();
    const announceAccepted = async () => {
        try {
            await observation?.onAccepted?.({ ...(spawn.type === 'pending' && spawn.operation
                ? { operation: { ...spawn.operation, serverId: input.executionTarget.serverId } } : {}) });
        } catch {
            // Presentation cannot change the target's accepted creation verdict.
            recordBugReportUserAction('session.spawn_new.presentation_failure', { metadata: { phase: 'acceptance' } });
        }
    };
    if (observation?.onAccepted && spawn.type === 'pending' && spawn.outcome === 'accepted' && spawn.operation) await announceAccepted();
    const presentedSessionId = observeCommit && spawn.type === 'pending' && spawn.outcome === 'accepted'
        ? spawn.sessionId : undefined;
    if (observeCommit && spawn.type === 'pending' && spawn.outcome === 'accepted' && spawn.sessionId) {
        if (!spawn.operation) return unavailable();
        try {
            await onCommitted?.({ sessionId: spawn.sessionId, executionTarget: input.executionTarget });
        } catch {
            // Presentation failure does not retire the original creation or
            // erase a later typed launch refusal. Its owner can retry the route.
            recordBugReportUserAction('session.spawn_new.presentation_failure', { metadata: { phase: 'presentation' } });
        }
        context.signal?.throwIfAborted();
    }
    if (spawn.type !== 'pending' || !spawn.operation) {
        const qualified = qualifySessionSpawnNewActionResult({ ok: true, result: spawn }, input.executionTarget);
        if (observation?.onAccepted && readCommittedSessionSpawnNewActionResult(qualified)) await announceAccepted();
        return qualified;
    }
    // A pending receipt names the existing creation owner. Join it through the
    // same admitted Action transport (including embed credentials), never spawn
    // again or depend on a best-effort socket notification to finish the caller.
    const address = spawn.operation;
    // The daemon may name its Home with a stack-local identifier. As with push
    // and manual operation reads, the requester owns routing and store scope.
    const serverId = input.executionTarget.serverId;
    context.signal?.throwIfAborted();
    const observed = await execute('action.operations.get', { ...address, serverId, waitForTerminal: true }, context);
    if (!observed.ok) return observed;
    requireActionSuccess(observed);
    const parsed = ActionOperationGetV1ResponseSchema.safeParse(observed.result);
    if (!parsed.success || parsed.data.kind !== 'found') return unavailable();
    const operation = parsed.data.operation;
    if (operation.operationId !== address.operationId || operation.actionId !== 'session.spawn_new'
        || operation.scope.machineId !== address.machineId
        || context.expectedAccountId && operation.scope.accountId !== context.expectedAccountId
        || !['succeeded', 'failed', 'cancelled'].includes(operation.state)) return unavailable();
    const settled = projectManualSessionSpawnOperationResult(operation, input.executionTarget);
    const committed = readCommittedSessionSpawnNewActionResult(settled);
    if (presentedSessionId && committed && committed.sessionId !== presentedSessionId) return unavailable();
    if (operation.state === 'succeeded' && !settled.ok) return settled;
    // Requester reads and pushes advance the same revision-checked store. A
    // missed notification must not leave every other consumer on `running`.
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    actionOperationStore.mergeSnapshots({ serverId, snapshots: [operation] });
    context.signal?.throwIfAborted();
    if (observation?.onAccepted && spawn.outcome !== 'accepted' && readCommittedSessionSpawnNewActionResult(settled)) await announceAccepted();
    return settled;
}

/**
 * The Action executor's daemon transport for one strict spawn request.
 *
 * Creating a Session is a spawn lifecycle, so it waits for the daemon for the
 * spawn budget every other spawn path uses (the Home relay honours the same
 * value), not the generic 30 s machine RPC default: a daemon stalled past that
 * default still creates the Session and admits the first message.
 *
 * When the deadline passes after the request was emitted, the daemon may
 * already hold the Session. That is an unknown outcome, not a failure — the
 * same settlement the daemon reports for its own lost acknowledgements — and
 * only a retry with the same creation key can resolve it. Before issuance, a
 * timeout is a retryable failure because no creation request reached the daemon.
 */
export async function dispatchSessionSpawnNewToMachine(params: Readonly<{
    payload: SessionSpawnNewInputV2;
    requesterBootstrap?: SessionRequesterBootstrapV1;
    signal?: AbortSignal;
}>): Promise<SessionSpawnNewResultV1> {
    const startedAtMs = Date.now();
    let issued = false;
    let issuedAtMs: number | undefined;
    const readPhaseTiming = () => {
        const nowMs = Date.now();
        return {
            phase: issued ? 'response' : 'setup',
            issued,
            elapsedMs: Math.max(0, nowMs - startedAtMs),
            phaseElapsedMs: Math.max(0, nowMs - (issuedAtMs ?? startedAtMs)),
        };
    };
    try {
        const payload: SessionSpawnNewInputV2 | SessionRequesterBootstrapRpcRequestV1 = params.requesterBootstrap
            ? { kind: 'requester_session_bootstrap_v1', input: params.payload, requesterBootstrap: params.requesterBootstrap }
            : params.payload;
        const result = await machineRpcWithServerScope<SessionSpawnNewResultV1, typeof payload>({
            serverId: params.payload.executionTarget.serverId,
            machineId: params.payload.executionTarget.machineId,
            method: RPC_METHODS.SESSION_SPAWN_NEW,
            payload,
            ...(params.requesterBootstrap ? {
                accountId: parseToken(params.requesterBootstrap.credentials.token),
                // A Plain Account still has private authentication; the installed
                // requester wrapper protects it without requiring an Account DEK.
                requireEncryptedPayload: true,
            } : {}),
            timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv(),
            signal: params.signal,
            onIssued: () => { issued = true; issuedAtMs = Date.now(); },
        });
        if (result?.type === 'error') {
            const refusal = SessionSpawnNewResultV1Schema.safeParse(result);
            if (refusal.success && refusal.data.type === 'error') {
                recordBugReportUserAction('session.spawn_new.daemon_refusal', {
                    metadata: { ...readPhaseTiming(), resultCode: refusal.data.code },
                });
            }
        }
        return result;
    } catch (error) {
        const record = error && typeof error === 'object' ? error as Readonly<Record<string, unknown>> : null;
        const code = readRpcErrorCode(error) ?? record?.code;
        // Only known diagnostic constants may enter the existing local trail.
        // Messages, stacks, payloads and arbitrary token-shaped names/codes stay private.
        const errorCode = Object.values(RPC_ERROR_CODES).some(value => value === code)
            || code === MACHINE_RPC_TIMEOUT_ERROR_CODE || code === 'MACHINE_RPC_ABORTED' || code === 'SOCKET_RPC_ABORTED'
            ? String(code) : 'unknown';
        const errorName = typeof record?.name === 'string'
            && ['Error', 'RpcError', 'AbortError', 'TimeoutError', 'TypeError', 'RangeError', 'AxiosError'].includes(record.name)
            ? record.name : 'unknown';
        recordBugReportUserAction('session.spawn_new.transport_failure', {
            metadata: {
                ...readPhaseTiming(), errorName, errorCode,
                requestDisposition: readRpcRequestDisposition(error) ?? 'unknown',
                transportScope: record?.scope === 'active' || record?.scope === 'scoped' ? record.scope : 'unknown',
            },
        });
        // A scoped-rpc socket recycled after the emit clears the acknowledgement with
        // RPC_OUTCOME_UNKNOWN: like a timeout, the daemon may already be creating the Session.
        const failure = projectSessionSpawnSetupTransportFailure(error);
        if (failure) {
            return issued && readRpcRequestDisposition(error) !== 'notSent'
                ? { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' }
                : failure;
        }
        throw error;
    }
}

/** The durable creation result remains explicit when the attached lead's private material cannot be prepared. */
export async function dispatchSessionSpawnNewWithManagerPreparation(params: Readonly<{
    payload: SessionSpawnNewInputV2;
    requesterBootstrap?: SessionRequesterBootstrapV1;
    signal?: AbortSignal;
}>): Promise<SessionSpawnNewResultV1 | Extract<ActionExecuteResult, Readonly<{ ok: false }>>> {
    const committed = await dispatchSessionSpawnNewToMachine(params);
    const manager = params.payload.manager;
    if (committed.type !== 'success' || !manager) return committed;
    let preparation: SessionFollowSourceKeyPreparationResultV1;
    try {
        preparation = await prepareSessionFollowSourceKey({
            serverId: params.payload.executionTarget.serverId,
            sourceSessionId: committed.sessionId,
            destinationSessionId: manager.sessionId,
            signal: params.signal,
        });
    } catch {
        preparation = { kind: 'waiting', reason: 'runner_unreachable' };
    }
    const projected = projectSessionFollowSourceKeyPreparationAfterSetV1({ source: committed }, preparation);
    return 'ok' in projected ? projected : committed;
}

/** The operation, rather than Session existence, owns accepted startup and first-input settlement. */
export function projectManualSessionSpawnOperationResult(
    operation: ActionOperationSnapshotV1,
    executionTarget: SessionSpawnNewInputV2['executionTarget'],
): SessionSpawnNewActionResult {
    if (operation.state === 'succeeded' || operation.state === 'failed' && operation.result !== undefined) {
        return qualifySessionSpawnNewActionResult({ ok: true,
            result: readSessionSpawnNewActionResultV1(SessionSpawnNewActionResultV1Schema.parse(operation.result)) }, executionTarget);
    }
    if (operation.state === 'failed' || operation.state === 'cancelled') {
        return { ok: false, errorCode: operation.error?.errorCode ?? 'action_cancelled', error: operation.error?.error ?? 'action_cancelled',
            ...(operation.error?.details ? { details: operation.error.details } : {}) };
    }
    return { ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' } };
}

/**
 * Reconcile an acknowledgement, never create or re-admit input. The authenticated
 * owner-only tag read proves this attempt's committed Session; its first-input
 * local id separately proves admission. A missing input receipt stays unknown.
 */
async function reconcileManualSessionCreation(
    input: StrictSessionSpawnNewInput,
    custody: PersistedSpawnAttempt,
    sourceAccountLifetime?: Pick<ServerAccountScopeLifetime, 'isCurrent'>,
): Promise<SessionSpawnNewActionResult | null> {
    let account: LazyActionAccountContext | undefined;
    const isSourceCurrent = () => sourceAccountLifetime?.isCurrent() !== false;
    try {
        if (!isSourceCurrent()) return null;
        account = await captureLazyActionAccountContext(custody.scope.serverId);
        if (account.accountId !== custody.scope.accountId || !isSourceCurrent()) return null;
        const response = await account.request('/v2/sessions/lookup-by-tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags: [deriveSessionCreationTagV1({
                callerCreationNamespace: 'user', creationKey: input.creationKey,
            })] }),
        }, { retry: 'none' });
        if (!response.ok) return null;
        const lookup = SessionLookupByTagsResponseV2Schema.safeParse(await response.json());
        account.assertCurrent();
        if (!isSourceCurrent() || !lookup.success || lookup.data.sessions.length !== 1) return null;
        const session = lookup.data.sessions[0]!;
        if (session.archivedAt != null) return null;
        let initialInput: SessionSpawnNewInitialInputDispositionV1 = { status: 'notRequested' };
        if (input.initialInput) {
            initialInput = { status: 'outcomeUnknown', localId: custody.firstTurnLocalId, code: 'session_input_admission_outcome_unknown' };
            try {
                const receipt = await account.request(`/v2/sessions/${encodeURIComponent(session.id)}/messages/by-local-id/${encodeURIComponent(custody.firstTurnLocalId)}`,
                    undefined, { retry: 'none' });
                if (receipt.ok) {
                    const body: unknown = await receipt.json();
                    const message = SessionMessageV1Schema.safeParse(body && typeof body === 'object' && 'message' in body ? body.message : null);
                    if (message.success && message.data.localId === custody.firstTurnLocalId && message.data.messageRole === 'user') {
                        initialInput = { status: 'alreadyAccepted', localId: custody.firstTurnLocalId };
                    }
                }
            } catch {
                // A first-input read cannot undo the independently proven create.
            }
        }
        account.assertCurrent();
        if (!isSourceCurrent()) return null;
        return { ok: true, result: SessionSpawnNewResultV1Schema.parse({
            type: 'success', disposition: 'rejoined', sessionId: session.id,
            executionTarget: input.executionTarget,
            organizationPlacement: normalizeSessionCreationOrganizationPlacementV1(input.organizationPlacement),
            initialInput,
        }) };
    } catch {
        // Unavailable evidence preserves the original Action outcome and custody.
        return null;
    } finally {
        account?.dispose();
    }
}

/**
 * Runs the canonical manual Action through the existing crash-stable custody
 * owner. The store is local recovery state only: Action request identity and
 * `creationKey` remain the sole executable/durable Session identities.
 */
export async function executeManualSessionSpawnNewAction(
    input: StrictSessionSpawnNewInput,
    context: UiActionExecutorContext,
    params: Readonly<{
        scope: ServerAccountScope;
        machineHomeDir: string;
        userAttemptId: string;
        seedNonce?: string | null;
        sourceAccountLifetime?: Pick<ServerAccountScopeLifetime, 'isCurrent'>;
        authoringOriginPersistence?: PersistedSpawnAttempt['authoringOriginPersistence'];
        executeAction?: SessionSpawnNewActionExecutor;
        observation?: SessionSpawnNewActionObservation;
    }>,
): Promise<ManualSessionSpawnNewActionExecutionResult> {
    const userAttemptId = params.userAttemptId.trim();
    const expectedCreationKey = buildManualSessionCreationKey(userAttemptId);
    if (input.creationKey !== expectedCreationKey) {
        throw new Error('Manual Session creation identity does not match launch custody');
    }
    if (context.actionRequestId !== userAttemptId) {
        throw new Error('Manual Session Action request identity does not match launch custody');
    }
    if (
        input.executionTarget.machineId !== input.executionTarget.machineId.trim()
        || input.executionTarget.serverId !== params.scope.serverId
    ) {
        throw new Error('Manual Session execution target does not match launch custody');
    }
    const targetFingerprint = createSpawnAttemptKeyForSessionSpawnNewInput(
        input,
        params.machineHomeDir,
    );
    const acquired = await acquireSpawnAttemptCustody({
        scope: params.scope,
        machineId: input.executionTarget.machineId,
        targetFingerprint,
        userAttemptId,
        seedNonce: params.seedNonce,
        submissionState: 'submitted',
        ...(params.authoringOriginPersistence || input.authoringOrigin ? {
            authoringOriginPersistence: params.authoringOriginPersistence ?? 'daemon-birth',
        } : {}),
    });
    if (acquired.status !== 'acquired') {
        return { status: 'custody_unavailable', reason: acquired.status };
    }
    let submitted = acquired.record;

    // The first dispatch owns provenance. An upgrade cannot turn a retained
    // browser checkpoint into a daemon write, nor can withdrawal add a second writer.
    const { authoringOrigin, ...withoutAuthoringOrigin } = input;
    if (submitted.authoringOriginPersistence === 'daemon-birth' && !authoringOrigin) {
        throw Object.assign(new Error('Authoring origin birth handoff is unavailable'), {
            code: 'authoring_origin_birth_unconfirmed', phase: 'authoring_origin',
        });
    }
    const dispatchInput = submitted.authoringOriginPersistence === 'daemon-birth' ? input : withoutAuthoringOrigin;

    const observedOperation = acquired.reused ? readManualSessionSpawnOperation(params.scope, userAttemptId) : null;
    const operation = observedOperation
        ? await readManualSessionSpawnOperationDetails(params.scope, observedOperation,
            () => params.sourceAccountLifetime?.isCurrent() !== false)
        : null;
    const observed: SessionSpawnNewActionResult | null = submitted.terminalResult
        ? { ok: true, result: submitted.terminalResult }
        : operation ? projectManualSessionSpawnOperationResult(operation, input.executionTarget) : null;
    // A known committed receipt still belongs to its original startup/input
    // operation. Inventory existence cannot replace that operation's verdict.
    const reconciled = !observed && submitted.createdSessionId === null && acquired.reused && acquired.previousSubmissionState === 'submitted'
        ? await reconcileManualSessionCreation(input, submitted, params.sourceAccountLifetime)
        : null;
    // Custody acquisition and reconciliation may outlive the originating draft's
    // Account authority. Fence actual issuance after those reads have settled.
    const sourceAdmissionRetired = params.sourceAccountLifetime !== undefined && !params.sourceAccountLifetime.isCurrent();
    const executeAction: SessionSpawnNewActionExecutor = params.executeAction ?? ((input, context, observation) =>
        executeSessionSpawnNewAction(input, context, undefined, observation));
    const observation = params.observation ? { ...params.observation,
        ...(params.observation.onAccepted ? { onAccepted: async (receipt: Parameters<NonNullable<SessionSpawnNewActionObservation['onAccepted']>>[0]) => {
            if (params.sourceAccountLifetime?.isCurrent() !== false) await params.observation?.onAccepted?.(receipt);
        } } : {}),
        ...(params.observation.onCommitted ? { onCommitted: async (receipt: SessionSpawnNewCommittedReceipt) => {
            if (receipt.executionTarget.serverId !== input.executionTarget.serverId
                || receipt.executionTarget.machineId !== input.executionTarget.machineId) throw new Error('spawn_committed_target_mismatch');
            const marked = await markSpawnAttemptCreated({ scope: submitted.scope, machineId: submitted.machineId,
                targetFingerprint: submitted.targetFingerprint, userAttemptId: submitted.userAttemptId,
                nonce: submitted.nonce, createdSessionId: receipt.sessionId });
            // Even if persistence is unavailable, known creation cannot become
            // no-effect cleanup when the original terminal result later refuses.
            submitted = marked ?? { ...submitted, createdSessionId: receipt.sessionId };
            if (!marked) throw new Error('spawn_committed_custody_unavailable');
            if (params.sourceAccountLifetime?.isCurrent() !== false) {
                await params.observation?.onCommitted?.({ ...receipt, firstTurnLocalId: submitted.firstTurnLocalId });
            }
        } } : {}),
    } : undefined;
    let action: SessionSpawnNewActionResult = qualifySessionSpawnNewActionResult(sourceAdmissionRetired
        ? { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' }
        : observed ?? reconciled ?? await executeAction(dispatchInput, {
            ...context,
            expectedAccountId: params.scope.accountId,
        }, observation), input.executionTarget);
    if (!observed && submitted.createdSessionId === null
        && ((!action.ok && action.errorCode === 'action_failed') || (action.ok && action.result.type === 'pending' && action.result.outcome === 'unknown'))) {
        action = await reconcileManualSessionCreation(input, submitted, params.sourceAccountLifetime) ?? action;
    }
    const custody = await settleManualSessionSpawnNewActionCustody({ acquired: { ...acquired, record: submitted }, action,
        committed: readCommittedSessionSpawnNewActionResult(action), executionTarget: input.executionTarget,
        sourceAdmissionRetired });
    return { status: 'executed', action, custody };
}

/** Clears custody only after the caller has durably consumed the Action result. */
export async function completeManualSessionSpawnNewActionCustody(
    custody: ManualSessionSpawnNewActionCustody,
): Promise<boolean> {
    return await clearSpawnAttemptCustody({
        scope: custody.scope,
        machineId: custody.machineId,
        targetFingerprint: custody.targetFingerprint,
        userAttemptId: custody.userAttemptId,
        nonce: custody.nonce,
    });
}
