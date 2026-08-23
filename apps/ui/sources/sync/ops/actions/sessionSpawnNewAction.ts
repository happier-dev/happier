import {
    RPC_ERROR_CODES,
    SessionSpawnNewResultV1Schema,
    type ActionExecuteResult,
    type ActionExecutorContext,
    type SessionSpawnNewInputV2,
    type SessionSpawnNewResultV1,
} from '@happier-dev/protocol';

import { createFrontDoorActionExecute } from './frontDoorRuntimeActionExecutor';

export type StrictSessionSpawnNewInput = SessionSpawnNewInputV2 & Readonly<{
    creationKey: NonNullable<SessionSpawnNewInputV2['creationKey']>;
}>;

export type SessionSpawnNewActionResult =
    | Readonly<{ ok: true; result: SessionSpawnNewResultV1 }>
    | Extract<ActionExecuteResult, Readonly<{ ok: false }>>;

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
