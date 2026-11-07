import type {
    SessionBoardApprovalRequestCreatedResultV1,
    SessionBoardErrorV1,
    SessionBoardItemPlacementV1,
    SessionBoardItemRemoveInputV1,
    SessionBoardActionInputV1ById,
    SessionBoardLayoutUpdateInputV1,
    SessionBoardMutationActionResultV1,
    SessionBoardActionRecoveryEvidenceV1,
    SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';
import {
    parseSessionBoardActionExecuteOutcomeV1,
} from '@happier-dev/protocol/sessions/board';
import type { ActionExecuteResult} from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext} from '@happier-dev/protocol/actions/executor/types';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';

import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

/**
 * The Board mutation seam this human vertical CONSUMES.
 *
 * Every durable human Board intent — Save note, Rename, Remove, reorder, resize,
 * Pin to Board — goes through the same shared Actions an Agent uses
 * (Lane 08.04). The inputs and results below are that owner's canonical Protocol
 * contracts, imported rather than restated, so the human path cannot drift from
 * the Agent path.
 *
 * This port is the consumer half only. The ONE implementation is Lane 08.04's UI
 * adapter over `sync/ops/actions/defaultActionExecutor`, which stamps the exact
 * Home/Session, applies Action settings, approval and admission, seals content
 * once and calls the atomic Board route. Nothing in Lane 08.03 writes a System
 * Record, calls the Board route, or seals Board content directly, and while that
 * adapter is absent {@link unavailableSessionBoardActions} refuses rather than
 * letting a Board surface acquire a private write path.
 *
 * Reads are NOT part of this port: the UI composes `session.board.get` through the
 * Lane 08.02 repository, so a Board read never becomes a second fetch owner.
 */

export type SessionBoardActionUnavailableReason =
    /** Lane 08.04's Action family is not wired into this build yet. */
    | 'board_actions_unavailable'
    /** The exact Home does not have `sessions.board` enabled. */
    | 'board_feature_unavailable'
    /** No reachable Home for the captured Session address. */
    | 'offline'
    /** The negotiated peer cannot perform this operation (Lane 04.02 update-required owner). */
    | 'update_required';

export type SessionBoardActionOutcome<TValue> =
    | Readonly<{ status: 'ok'; value: TValue }>
    | Readonly<{ status: 'pending_approval'; approval: SessionBoardApprovalRequestCreatedResultV1 }>
    | Readonly<{ status: 'refused'; error: SessionBoardErrorV1 }>
    | Readonly<{ status: 'unavailable'; reason: SessionBoardActionUnavailableReason }>
    | Readonly<{ status: 'cancelled' }>
    | Readonly<{ status: 'failed'; code: string }>
    /**
     * The acknowledgement was lost. The server may or may not have committed; the
     * caller keeps its frozen request and reconciles by refreshing the affected
     * Lane 08.02 records before offering resubmission.
     */
    | Readonly<{ status: 'outcome_unknown'; recovery: SessionBoardActionRecoveryEvidenceV1 }>;

export type SessionBoardItemPlacementInput = SessionBoardItemPlacementV1;
/** Mounted editors carry parsed items, not CLI workspace-publication or cross-Session acquisition intents. */
export type SessionBoardItemUpsertInput = Readonly<
    Omit<Extract<SessionBoardActionInputV1ById['session.board.item.upsert'], { item: unknown }>, 'item'>
    & { item: SessionSurfaceItemV1 }
>;
/** Cross-Session copy (V-OP-02): no authored item; the executor materializes the exact source revision. */
export type SessionBoardItemCopyInput = Readonly<
    Omit<Extract<SessionBoardActionInputV1ById['session.board.item.upsert'], { copySource: unknown }>, 'item' | 'expectedItemRevision'>
    & { expectedItemRevision: null; copySource: NonNullable<Extract<SessionBoardActionInputV1ById['session.board.item.upsert'], { copySource: unknown }>['copySource']> }
>;
export type SessionBoardItemRemoveInput = SessionBoardItemRemoveInputV1;
export type SessionBoardLayoutUpdateInput = SessionBoardLayoutUpdateInputV1;
export type SessionBoardMutationResult = SessionBoardMutationActionResultV1;

export type SessionBoardActionsPort = Readonly<{
    upsertItem: (input: SessionBoardItemUpsertInput) => Promise<SessionBoardActionOutcome<SessionBoardMutationResult>>;
    removeItem: (
        input: SessionBoardItemRemoveInput,
    ) => Promise<SessionBoardActionOutcome<SessionBoardMutationResult>>;
    updateLayout: (input: SessionBoardLayoutUpdateInput) => Promise<SessionBoardActionOutcome<SessionBoardMutationResult>>;
}>;

const UNAVAILABLE: SessionBoardActionOutcome<never> = Object.freeze({
    status: 'unavailable' as const,
    reason: 'board_actions_unavailable' as const,
});

/**
 * The honest default while Lane 08.04's UI Action adapter is absent from this build.
 *
 * It refuses instead of writing, so no Board surface can quietly acquire a second
 * mutation path, and every hosting surface renders the same typed unavailable
 * explanation it would render for a disabled feature.
 */
export const unavailableSessionBoardActions: SessionBoardActionsPort = Object.freeze({
    upsertItem: async () => UNAVAILABLE,
    removeItem: async () => UNAVAILABLE,
    updateLayout: async () => UNAVAILABLE,
});

type SessionBoardActionExecute = (
    actionId: ActionId,
    input: unknown,
    context?: Pick<
        ActionExecutorContext,
        | 'serverId'
        | 'defaultSessionId'
        | 'surface'
        | 'signal'
        | 'authority'
        | 'presentUserConfirmation'
        | 'bypassApprovals'
    >,
) => Promise<ActionExecuteResult>;

/** The one human Board dispatch: the captured Home and Session, the shared executor, typed outcomes. */
function createSessionBoardActionRun(input: Readonly<{ serverId: string; sessionId: string; execute?: SessionBoardActionExecute }>) {
    const serverId = input.serverId.trim();
    const sessionId = input.sessionId.trim();
    const execute = input.execute ?? createFrontDoorActionExecute();

    const run = async (
        actionId: 'session.board.item.upsert' | 'session.board.item.remove' | 'session.board.layout.update',
        actionInput: SessionBoardItemUpsertInput | SessionBoardItemCopyInput | SessionBoardItemRemoveInput | SessionBoardLayoutUpdateInput,
    ): Promise<SessionBoardActionOutcome<SessionBoardMutationResult>> => {
        if (!serverId || !sessionId || actionInput.sessionId !== sessionId) {
            return { status: 'refused', error: { error: 'session_board_forbidden' } };
        }
        let result: ActionExecuteResult;
        try {
            result = await execute(actionId, actionInput, {
                serverId,
                defaultSessionId: sessionId,
                surface: 'ui',
            });
        } catch {
            return { status: 'unavailable', reason: 'offline' };
        }
        const parsed = parseSessionBoardActionExecuteOutcomeV1(actionId, actionInput, result, {
            expectedServerId: serverId,
            expectedSessionId: sessionId,
            resolveServerScopeId: resolveServerProfileScopeIdForIdentifier,
        });
        if (!parsed.success) {
            return { status: 'unavailable', reason: 'board_actions_unavailable' };
        }
        if (parsed.kind === 'applied') {
            return 'result' in parsed.data
                ? { status: 'ok', value: parsed.data }
                : { status: 'unavailable', reason: 'board_actions_unavailable' };
        }
        if (parsed.kind === 'approval_request_created') {
            return { status: 'pending_approval', approval: parsed.data };
        }

        const failure = parsed.data;
        switch (failure.errorCode) {
            case 'session_board_invalid':
            case 'session_board_item_not_found':
            case 'session_board_forbidden':
            case 'session_board_storage_mode_mismatch':
            case 'session_board_source_conflict':
                return { status: 'refused', error: { error: failure.errorCode } };
            case 'session_board_revision_conflict':
                return {
                    status: 'refused',
                    error: {
                        error: failure.errorCode,
                        ...('details' in failure && failure.details
                            ? failure.details
                            : {}),
                    },
                };
            case 'feature_disabled':
            case 'feature_unavailable':
                return { status: 'unavailable', reason: 'board_feature_unavailable' };
            case 'update_required':
                return { status: 'unavailable', reason: 'update_required' };
            case 'offline':
                return { status: 'unavailable', reason: 'offline' };
            case 'outcome_unknown':
                return { status: 'outcome_unknown', recovery: failure.details.recovery };
            case 'cancelled':
                return { status: 'cancelled' };
            case 'protocol_unavailable':
            case 'unsupported_action':
            case 'unsupported_version':
                return { status: 'unavailable', reason: 'board_actions_unavailable' };
            default:
                return { status: 'failed', code: failure.errorCode };
        }
    };

    return run;
}

/**
 * Bind the human Board to the same Action executor used by Agents and declared
 * surface Actions. The exact Home and Session are captured once when the pane
 * mounts, so a later Home-focus change cannot retarget an edit in progress.
 */
export function createSessionBoardActionsPort(input: Readonly<{
    serverId: string;
    sessionId: string;
    execute?: SessionBoardActionExecute;
}>): SessionBoardActionsPort {
    const run = createSessionBoardActionRun(input);
    return Object.freeze({
        upsertItem: async (actionInput) => await run('session.board.item.upsert', actionInput),
        removeItem: async (actionInput) => await run('session.board.item.remove', actionInput),
        updateLayout: async (actionInput) => await run('session.board.layout.update', actionInput),
    });
}

/** The stored item revision an upsert committed, when the result is an item upsert. */
export function readSessionBoardUpsertItemRevision(result: SessionBoardMutationResult): string | null {
    return result.result.operation === 'upsert_item' ? result.result.itemRevision : null;
}

/**
 * Copy an exact Session visual revision into the captured (destination) Session (V-OP-02): the same
 * `session.board.item.upsert` with `copySource` an agent sends. The shared executor reads the source
 * at that revision and materializes an independent item; this adds no copy logic of its own.
 */
export async function copySessionBoardItemIntoSession(
    destination: Readonly<{ serverId: string; sessionId: string; execute?: SessionBoardActionExecute }>,
    actionInput: SessionBoardItemCopyInput,
): Promise<SessionBoardActionOutcome<SessionBoardMutationResult>> {
    return await createSessionBoardActionRun(destination)('session.board.item.upsert', actionInput);
}
