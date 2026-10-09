import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionSpawnNewResultV1Schema, type SessionSpawnNewResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectSessionFollowSourceKeyPreparationAfterSetV1, type SessionFollowSourceKeyPreparationResultV1, SessionFollowSourceKeyPreparationResultV1Schema, SESSION_FOLLOW_SOURCE_KEY_PREPARATION_WAITING_ACTION_ERROR_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceKeyPreparationV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { UiActionExecutorContext } from './defaultActionExecutor';
import type { SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { SessionRequesterBootstrapV1, SessionRequesterBootstrapRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createSpawnAttemptKeyForSessionSpawnNewInput } from '@/sync/domains/session/spawn/spawnAttemptKey';
import {
    acquireSpawnAttemptCustody,
    clearSpawnAttemptCustody,
    markSpawnAttemptCreated,
    markSpawnAttemptSubmitted,
    type PersistedSpawnAttempt,
} from '@/sync/domains/session/spawn/spawnAttemptNonceStore';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '@/sync/domains/session/spawn/spawnSessionRpcTimeout';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { isMachineRpcTimeoutError } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcTimeoutError';
import { isSocketIoAckTimeoutError } from '@happier-dev/sync-client';
import { parseToken } from '@/utils/auth/parseToken';

import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';
import { prepareSessionFollowSourceKey } from '@/components/sessions/follow/prepareSessionFollowSourceKey';
import { t } from '@/text';

export type StrictSessionSpawnNewInput = SessionSpawnNewInputV2 & Readonly<{
    creationKey: NonNullable<SessionSpawnNewInputV2['creationKey']>;
}>;

export type SessionSpawnNewActionResult =
    | Readonly<{ ok: true; result: SessionSpawnNewResultV1 }>
    | Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

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

/**
 * The one step that asks for a Session to be created. The UI's own Action executor is the
 * default; a presentation host that owns creation itself (the embed's new chat, plan 05 §4.3.5)
 * supplies its own. Custody, creation identity and retry stay with the manual launch owner.
 */
export type SessionSpawnNewActionExecutor = (
    input: StrictSessionSpawnNewInput,
    context: UiActionExecutorContext,
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

export type SessionSpawnNewActionFailurePresentation =
    | 'update_required'
    | 'generic_failure';

export type SessionSpawnNewActionFailureMessageKey =
    | 'newSession.actionMethodUnavailable'
    | 'newSession.failedToStart';

export type SessionSpawnNewResultFailureMessageKey =
    | 'newSession.launchStillPendingBody'
    | 'newSession.daemonRpcUnavailableBody'
    | 'session.access.repairBody'
    | 'session.access.preparationKeyUnavailable'
    | 'teams.policy.externalSharingDisabled'
    | 'teams.policy.externalSharingAdmins'
    | 'session.collaboration.accessUnavailableReason'
    | 'newSession.failedToStart';

/**
 * Keeps the strict creation callers on one typed compatibility presentation.
 * An older CLI can reject the Action method before it sees a spawn request;
 * that is distinct from an ordinary creation failure and never authorizes a
 * private-RPC retry.
 */
export function resolveSessionSpawnNewActionFailurePresentation(
    result: Extract<SessionSpawnNewActionResult, Readonly<{ ok: false }>>,
): SessionSpawnNewActionFailurePresentation {
    return result.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
        ? 'update_required'
        : 'generic_failure';
}

export function resolveSessionSpawnNewActionFailureMessageKey(
    result: Extract<SessionSpawnNewActionResult, Readonly<{ ok: false }>>,
): SessionSpawnNewActionFailureMessageKey {
    return resolveSessionSpawnNewActionFailurePresentation(result) === 'update_required'
        ? 'newSession.actionMethodUnavailable'
        : 'newSession.failedToStart';
}

/**
 * Projects the strict action result without discarding its originating typed
 * outcome. `machine_offline` is the strict result's target-transport or
 * daemon-preparation failure class; all other typed rejections stay neutral
 * rather than claiming the daemon is absent.
 */
export function resolveSessionSpawnNewResultFailureMessageKey(
    result: Exclude<SessionSpawnNewResultV1, Readonly<{ type: 'success' }>>,
): SessionSpawnNewResultFailureMessageKey {
    if (result.type === 'pending') {
        return 'newSession.launchStillPendingBody';
    }
    if (
        result.code === 'recipient_key_unavailable'
        || result.code === 'session_access_invalid_recipient_envelope'
    ) {
        return 'session.access.repairBody';
    }
    if (result.code === 'session_data_key_unavailable') {
        return 'session.access.preparationKeyUnavailable';
    }
    if (result.code === 'session_access_external_sharing_disabled') {
        return 'teams.policy.externalSharingDisabled';
    }
    if (result.code === 'session_access_external_sharing_requires_team_admin') {
        return 'teams.policy.externalSharingAdmins';
    }
    if (result.code === 'session_access_sharing_unavailable') {
        return 'session.collaboration.accessUnavailableReason';
    }
    return result.code === 'machine_offline'
        ? 'newSession.daemonRpcUnavailableBody'
        : 'newSession.failedToStart';
}

/** Keep localized recovery guidance while exposing the typed cause of otherwise generic failures. */
export function resolveSessionSpawnNewActionFailureMessage(
    result: Extract<SessionSpawnNewActionResult, Readonly<{ ok: false }>>,
): string {
    const key = resolveSessionSpawnNewActionFailureMessageKey(result);
    const message = t(key);
    return key === 'newSession.failedToStart'
        ? t('errors.errorWithCode', { message, code: result.errorCode })
        : message;
}

export function resolveSessionSpawnNewResultFailureMessage(
    result: Exclude<SessionSpawnNewResultV1, Readonly<{ type: 'success' }>>,
): string {
    const key = resolveSessionSpawnNewResultFailureMessageKey(result);
    const message = t(key);
    return result.type !== 'pending' && key === 'newSession.failedToStart'
        ? t('errors.errorWithCode', { message, code: result.code })
        : message;
}

/**
 * UI's sole public ordinary Session-creation client. The Action executor owns
 * transport, trusted caller stamping, approvals, cancellation, and typed
 * method-unavailable results; callers supply only strict V2 authored input.
 */
export async function executeSessionSpawnNewAction(
    input: StrictSessionSpawnNewInput,
    context: UiActionExecutorContext,
    executor?: Parameters<typeof createFrontDoorActionExecute>[0],
): Promise<SessionSpawnNewActionResult> {
    const result = await createFrontDoorActionExecute(executor)('session.spawn_new', input, context);
    if (!result.ok) return result;
    return {
        ok: true,
        result: SessionSpawnNewResultV1Schema.parse(result.result),
    };
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
    let issued = false;
    try {
        const payload: SessionSpawnNewInputV2 | SessionRequesterBootstrapRpcRequestV1 = params.requesterBootstrap
            ? { kind: 'requester_session_bootstrap_v1', input: params.payload, requesterBootstrap: params.requesterBootstrap }
            : params.payload;
        return await machineRpcWithServerScope<SessionSpawnNewResultV1, typeof payload>({
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
            onIssued: () => { issued = true; },
        });
    } catch (error) {
        if (isSocketIoAckTimeoutError(error) || isMachineRpcTimeoutError(error)) {
            return issued
                ? { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' }
                : { type: 'error', code: 'machine_offline', retryable: true };
        }
        throw error;
    }
}

/** The durable creation result remains explicit when the attached lead's private material cannot be prepared. */
export async function dispatchSessionSpawnNewWithReportsToPreparation(params: Readonly<{
    payload: SessionSpawnNewInputV2;
    requesterBootstrap?: SessionRequesterBootstrapV1;
    signal?: AbortSignal;
}>): Promise<SessionSpawnNewResultV1 | Extract<ActionExecuteResult, Readonly<{ ok: false }>>> {
    const committed = await dispatchSessionSpawnNewToMachine(params);
    const reportsTo = params.payload.reportsTo;
    if (committed.type !== 'success' || !reportsTo) return committed;
    let preparation: SessionFollowSourceKeyPreparationResultV1;
    try {
        preparation = await prepareSessionFollowSourceKey({
            serverId: params.payload.executionTarget.serverId,
            sourceSessionId: committed.sessionId,
            destinationSessionId: reportsTo.sessionId,
        });
    } catch {
        preparation = { kind: 'waiting', reason: 'runner_unreachable' };
    }
    const projected = projectSessionFollowSourceKeyPreparationAfterSetV1({ source: committed }, preparation);
    return 'ok' in projected ? projected : committed;
}

/**
 * Namespaces one present-user click without conflating it with the transport
 * nonce retained by the existing manual-launch custody store.
 */
export function buildManualSessionCreationKey(userAttemptId: string) {
    const normalized = userAttemptId.trim();
    if (!normalized) throw new Error('Manual Session user-attempt identity is unavailable');
    return SessionCreationKeyV1Schema.parse(`manual:${normalized}`);
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
        executeAction?: SessionSpawnNewActionExecutor;
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
    });
    if (acquired.status !== 'acquired') {
        return { status: 'custody_unavailable', reason: acquired.status };
    }
    const submitted = await markSpawnAttemptSubmitted({
        scope: params.scope,
        machineId: input.executionTarget.machineId,
        targetFingerprint,
        userAttemptId,
        nonce: acquired.record.nonce,
    });
    if (!submitted) {
        return { status: 'custody_unavailable', reason: 'lock_unavailable' };
    }

    // Custody acquisition may outlive the originating draft's Account authority.
    // Fence admission here; once issued, the Action owns truthful effect receipts.
    const sourceAdmissionRetired = params.sourceAccountLifetime !== undefined && !params.sourceAccountLifetime.isCurrent();
    const action: SessionSpawnNewActionResult = sourceAdmissionRetired
        ? { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' }
        : await (params.executeAction ?? executeSessionSpawnNewAction)(input, {
            ...context,
            expectedAccountId: params.scope.accountId,
        });
    let custody = submitted;
    const committed = readCommittedSessionSpawnNewActionResult(action);
    if (committed
        && committed.executionTarget.serverId === input.executionTarget.serverId
        && committed.executionTarget.machineId === input.executionTarget.machineId) {
        custody = await markSpawnAttemptCreated({
            scope: params.scope,
            machineId: input.executionTarget.machineId,
            targetFingerprint,
            userAttemptId,
            nonce: submitted.nonce,
            createdSessionId: committed.sessionId,
        }) ?? submitted;
    }
    const terminalWithoutCommittedSession = sourceAdmissionRetired || (
        !action.ok && action.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
    ) || (
        action.ok && action.result.type === 'error' && action.result.retryable === false
    );
    if (terminalWithoutCommittedSession) {
        await clearSpawnAttemptCustody({
            scope: submitted.scope,
            machineId: submitted.machineId,
            targetFingerprint: submitted.targetFingerprint,
            userAttemptId: submitted.userAttemptId,
            nonce: submitted.nonce,
        });
    }
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
