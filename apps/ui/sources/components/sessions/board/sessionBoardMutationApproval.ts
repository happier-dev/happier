import * as React from 'react';

import {
    SessionBoardActionFailureV1Schema,
    SessionSurfaceItemV1Schema,
    SessionSurfaceItemV1StoredSchema,
} from '@happier-dev/protocol/sessions/board';
import type {
    SessionBoardActionFailureV1,
    SessionBoardActionInputV1ById,
    SessionBoardActionIdV1,
    SessionBoardApprovalRequestCreatedResultV1,
    SessionBoardMutationActionResultV1,
    SessionBoardItemUpsertInputV1,
    SessionSurfaceItemV1,
} from '@happier-dev/protocol/sessions/board';

import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';

export type SessionBoardMutationActionId = Exclude<SessionBoardActionIdV1, 'session.board.get'>;

export type SessionBoardMutationApprovalRequest = {
    [TActionId in SessionBoardMutationActionId]: Readonly<{
        approval: SessionBoardApprovalRequestCreatedResultV1;
        actionId: TActionId;
        expectedInput: SessionBoardActionInputV1ById[TActionId];
        onSucceeded: (value: SessionBoardMutationActionResultV1) => void | Promise<void>;
        onFailed: (code: string, failure?: SessionBoardActionFailureV1) => void;
    }>;
}[SessionBoardMutationActionId];

export type SessionBoardMutationApprovalContinuation = Readonly<{
    pending: boolean;
    request: (request: SessionBoardMutationApprovalRequest) => void;
}>;

/**
 * One semantic interpretation of an approval terminal for every mounted Board
 * mutation consumer. In particular, an executed Action whose acknowledgement
 * is unknown is not an ordinary failure and must reconcile against the Board
 * repository before any deliberate retry.
 */
export type SessionBoardMutationApprovalFailure =
    | 'cancelled'
    | 'denied'
    | 'conflict'
    | 'outcomeUnknown'
    | 'failed';

export function classifySessionBoardMutationApprovalFailure(code: string): SessionBoardMutationApprovalFailure {
    if (code === 'approval_canceled') return 'cancelled';
    if (code === 'approval_rejected' || code === 'session_board_forbidden') return 'denied';
    if (code === 'session_board_revision_conflict'
        || code === 'session_board_source_conflict') return 'conflict';
    if (code === 'approval_execution_outcome_unknown' || code === 'outcome_unknown') return 'outcomeUnknown';
    return 'failed';
}

/**
 * An equal-looking pre-request row is not proof that an acknowledgement-lost
 * upsert committed. Every Board upsert advances the item revision, so the
 * canonical refreshed row proves the exact intent only when both its strict
 * semantic content and its revision differ from the submitted CAS operand.
 */
export function isSessionBoardUpsertIntentCommitted(input: Readonly<{
    intent: SessionBoardItemUpsertInputV1;
    revision: string | null;
    item: SessionSurfaceItemV1 | null;
}>): boolean {
    if (input.revision === null || input.revision === input.intent.expectedItemRevision || input.item === null) {
        return false;
    }
    const observed = SessionSurfaceItemV1StoredSchema.safeParse(input.item);
    const submitted = SessionSurfaceItemV1Schema.safeParse(input.intent.item);
    return observed.success
        && submitted.success
        && JSON.stringify(observed.data) === JSON.stringify(submitted.data);
}

/**
 * Bind one mounted Board mutation to the incumbent Action approval lifecycle.
 *
 * The approval Artifact remains the durable lifecycle owner. This adapter keeps
 * only the existing process-local continuation, validates the exact Action input
 * through that owner, and delivers the already-executed result once. It never
 * replays a Board mutation or guesses the current record revision.
 */
export function useSessionBoardMutationApproval(input: Readonly<{
    address: SessionAddress;
    onExecuted: () => void;
}>): SessionBoardMutationApprovalContinuation {
    const scopeResolution = useServerCredentialAccountScopeResolution(input.address.serverId);
    const scope = scopeResolution.kind === 'bound' ? scopeResolution.scope : null;
    const scopeKey = scope
        ? serverAccountScopedResourceKey(scope, 'session-board', input.address.sessionId)
        : `unbound:${input.address.serverId}:${input.address.sessionId}`;
    const approval = useActionApprovalContinuation({
        scopeKey,
        serverId: input.address.serverId,
        onExecuted: input.onExecuted,
    });
    const requestInFlightRef = React.useRef(false);
    const [requestInFlight, setRequestInFlight] = React.useState(false);
    React.useEffect(() => {
        if (approval.approvalPending || !requestInFlightRef.current) return;
        requestInFlightRef.current = false;
        setRequestInFlight(false);
    }, [approval.approvalPending]);

    const request = React.useCallback((pending: SessionBoardMutationApprovalRequest) => {
        if (requestInFlightRef.current || approval.approvalPending) {
            pending.onFailed('approval_continuation_busy');
            return;
        }
        if (!scope) {
            pending.onFailed('approval_scope_unavailable');
            return;
        }
        requestInFlightRef.current = true;
        setRequestInFlight(true);
        approval.requestApproval(createActionApprovalContinuation<
            SessionBoardMutationActionResultV1,
            SessionBoardMutationActionId
        >({
            artifactId: pending.approval.artifactId,
            actionId: pending.actionId,
            scope,
            expectedInput: pending.expectedInput,
            onSucceeded: pending.onSucceeded,
            onFailed: (code, failure) => {
                if (!failure) {
                    pending.onFailed(code);
                    return;
                }
                // Exact Action input and immutable Home/Account binding were
                // already validated by the generic approval continuation.
                // This boundary only narrows that trusted envelope to Board's
                // strict failure union; it does not recreate binding logic.
                const parsed = SessionBoardActionFailureV1Schema.safeParse(failure);
                pending.onFailed(
                    code,
                    parsed.success ? parsed.data : undefined,
                );
            },
        }));
    }, [approval.approvalPending, approval.requestApproval, scope]);

    return React.useMemo(() => ({
        pending: approval.approvalPending || requestInFlight,
        request,
    }), [approval.approvalPending, request, requestInFlight]);
}
