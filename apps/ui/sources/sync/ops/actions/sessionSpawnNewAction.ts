import {
    RPC_ERROR_CODES,
    SessionCreationKeyV1Schema,
    SessionSpawnNewResultV1Schema,
    type ActionExecuteResult,
    type ActionExecutorContext,
    type SessionSpawnNewInputV2,
    type SessionSpawnNewResultV1,
} from '@happier-dev/protocol';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createSpawnAttemptKeyForSessionSpawnNewInput } from '@/sync/domains/session/spawn/spawnAttemptKey';
import {
    acquireSpawnAttemptCustody,
    clearSpawnAttemptCustody,
    markSpawnAttemptCreated,
    markSpawnAttemptSubmitted,
    type PersistedSpawnAttempt,
} from '@/sync/domains/session/spawn/spawnAttemptNonceStore';

import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';

export type StrictSessionSpawnNewInput = SessionSpawnNewInputV2 & Readonly<{
    creationKey: NonNullable<SessionSpawnNewInputV2['creationKey']>;
}>;

export type SessionSpawnNewActionResult =
    | Readonly<{ ok: true; result: SessionSpawnNewResultV1 }>
    | Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

export type ManualSessionSpawnNewActionCustody = PersistedSpawnAttempt;

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
    return result.code === 'machine_offline'
        ? 'newSession.daemonRpcUnavailableBody'
        : 'newSession.failedToStart';
}

/**
 * UI's sole public ordinary Session-creation client. The Action executor owns
 * transport, trusted caller stamping, approvals, cancellation, and typed
 * method-unavailable results; callers supply only strict V2 authored input.
 */
export async function executeSessionSpawnNewAction(
    input: StrictSessionSpawnNewInput,
    context: ActionExecutorContext,
): Promise<SessionSpawnNewActionResult> {
    const result = await createFrontDoorActionExecute()('session.spawn_new', input, context);
    if (!result.ok) return result;
    return {
        ok: true,
        result: SessionSpawnNewResultV1Schema.parse(result.result),
    };
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
    context: ActionExecutorContext,
    params: Readonly<{
        scope: ServerAccountScope;
        machineHomeDir: string;
        userAttemptId: string;
        seedNonce?: string | null;
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

    const action = await executeSessionSpawnNewAction(input, context);
    let custody = submitted;
    if (action.ok && action.result.type === 'success') {
        custody = await markSpawnAttemptCreated({
            scope: params.scope,
            machineId: input.executionTarget.machineId,
            targetFingerprint,
            userAttemptId,
            nonce: submitted.nonce,
            createdSessionId: action.result.sessionId,
        }) ?? submitted;
    }
    const terminalWithoutCommittedSession = (
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
