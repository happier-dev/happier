import * as React from 'react';

import type {
    SessionAccessAccountSummaryV1} from '@happier-dev/protocol/sessions/access/sessionAccessPrincipalV1';
import type {
    SessionResponsibilityCandidateV1,
    SetSessionResponsibilityResponse,
} from '@happier-dev/protocol/sessions/access/sessionResponsibilityV1';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import {
    SessionResponsibilityError,
    listSessionResponsibilityCandidates,
    provesSessionResponsibilityAuthorityLoss,
    readResponsibilityFailureCode,
    readSessionResponsibleAccount,
    setSessionResponsibleAccount,
    type SessionResponsibilityMutationFailure,
} from '@/sync/api/session/apiSessionResponsibility';
import { storage, useSessionListRowSelector } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useSessionCollaborationAvailabilityState } from '@/hooks/session/useSessionCollaborationAvailability';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

export type SessionResponsibilityAvailability =
    /** No cached scoped Session exists yet; preserve the section's row geometry. */
    | 'loading'
    /** This server did not project responsibility; never render "No one". */
    | 'unsupported'
    /** Projected and readable, but this Account may not change it. */
    | 'read_only'
    | 'editable';

export type SessionResponsibilityCandidatesState = Readonly<{
    loading: boolean;
    failed: boolean;
    candidates: readonly SessionResponsibilityCandidateV1[];
    nextCursor: string | null;
}>;

export type SessionResponsibilityController = Readonly<{
    availability: SessionResponsibilityAvailability;
    /** `undefined` only while unsupported; `null` is an authoritative "nobody". */
    responsibleAccountId: string | null | undefined;
    /** Safe current summary from the Session projection/Action response, retained while stale. */
    responsibleAccount: SessionAccessAccountSummaryV1 | null;
    pending: boolean;
    failure: SessionResponsibilityMutationFailure | null;
    /**
     * Set while an assignment waits on the approval Artifact the canonical Action
     * policy created for it (confirmation is required by default). The shared
     * approval continuation owner follows that Artifact and delivers its executed
     * result once; nothing has committed until then, `pending` stays true so the
     * same intent cannot be submitted twice, and the mutation is never replayed
     * from here.
     */
    pendingApproval: Readonly<{ artifactId: string; actionId: string; serverId: string }> | null;
    /** One in-context explanation for this Account's committed assignment-triggered Follow. */
    assignmentAutoFollowed: boolean;
    candidates: SessionResponsibilityCandidatesState;
    loadCandidates: (input?: Readonly<{ query?: string; cursor?: string }>) => Promise<void>;
    setResponsibleAccount: (accountId: string | null) => Promise<boolean>;
    /** Fixed canonical-self option; derived from the authenticated Account, never page one. */
    canAssignToSelf: boolean;
}>;

const NO_APPROVAL_REFRESH = () => {};

/**
 * A declined or canceled approval is the person's own answer: nothing changed,
 * so it is not reported as a failure. Every other terminal outcome is the
 * approved execution's recorded failure, projected through the same typed
 * outcomes a direct execution uses.
 */
function readApprovalSettlementFailure(code: string): SessionResponsibilityMutationFailure | null {
    if (isActionApprovalDeclinedErrorCode(code)) return null;
    if (code === 'approval_execution_outcome_unknown' || code === 'outcome_unknown') return 'unknown';
    return readResponsibilityFailureCode(code);
}

const EMPTY_CANDIDATES: SessionResponsibilityCandidatesState = {
    loading: false,
    failed: false,
    candidates: [],
    nextCursor: null,
};

/**
 * The one scoped owner of the responsibility fact for a mounted Session surface.
 *
 * Candidate search and `session.responsibility.set` share its exact
 * Home/credential/currentness state: one `scope`, one target key, one
 * revision guard. There is one controller per mounted qualified Session;
 * the section creates it and hands it to the picker, so there is no duplicate
 * request/mutation controller and no direct HTTP UI caller. The shared UI
 * Action executor is the only mutation entry, so the real UI honors Action
 * availability and the user's shared confirmation setting.
 *
 * The current assignee's display identity comes from the canonical Session
 * projection (`responsibleAccount`) and the authoritative Action response,
 * retained as last-good during refresh/offline. It is never a side effect of
 * loading the editable candidate list: candidate failure, an unrequested later
 * page or search filtering cannot erase the displayed current assignee, and no
 * responsibility-specific profile request is issued. Never renders the raw id.
 */
export function useSessionResponsibilityController(
    sessionId: string,
    scope: ServerAccountScope,
): SessionResponsibilityController {
    // The row facts this controller reads, each subscribed alone: a transcript
    // arrival advances other row fields and publishes nothing here.
    const sessionKnown = useSessionListRowSelector(scope.serverId, sessionId, (row) => row != null);
    const responsibleAccountId = useSessionListRowSelector(scope.serverId, sessionId, (row) => row?.responsibleAccountId);
    const projectedSummary = useSessionListRowSelector(scope.serverId, sessionId,
        (row) => (row as { responsibleAccount?: SessionAccessAccountSummaryV1 | null } | null)?.responsibleAccount ?? null);
    const projectedAssignResponsibility = useSessionListRowSelector(scope.serverId, sessionId,
        (row) => row?.access?.capabilities.assignResponsibility === true);
    const collaborationAvailabilityState = useSessionCollaborationAvailabilityState(scope.serverId);
    // Responsibility reads and mutations remain action admissions: unresolved fails closed at their API boundary.
    const collaborationAvailability = collaborationAvailabilityState === 'available' ? 'available' : 'unavailable';
    const targetKey = JSON.stringify([scope.serverId, scope.accountId, sessionId]);
    const currentTarget = React.useRef(targetKey);
    currentTarget.current = targetKey;
    // The exact target is only live while this controller is mounted. Without
    // this, a surface that navigated away or unmounted left `currentTarget`
    // equal to its last address, so a retained picker could still commit a
    // mutation against the Session the user had already left.
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const [pending, setPending] = React.useState(false);
    const [failure, setFailure] = React.useState<SessionResponsibilityMutationFailure | null>(null);
    const [pendingApproval, setPendingApproval] = React.useState<Readonly<{ artifactId: string; actionId: string; serverId: string }> | null>(null);
    // A refusal proved by the Home outranks the cached capability projection
    // this controller reads, until the projection itself catches up.
    const [authorityLost, setAuthorityLost] = React.useState(false);
    const [assignmentAutoFollowed, setAssignmentAutoFollowed] = React.useState(false);
    const [candidates, setCandidates] = React.useState<SessionResponsibilityCandidatesState>(EMPTY_CANDIDATES);
    // Last-good safe projection survives refresh/offline/candidate failure.
    const [lastGoodSummary, setLastGoodSummary] = React.useState<SessionAccessAccountSummaryV1 | null>(null);
    const requestRevision = React.useRef(0);
    const mutationInFlight = React.useRef(false);
    const mutationRevision = React.useRef(0);
    // The one shared approval owner, keyed by this exact target: a target change
    // releases custody, exactly like this controller's own reset below.
    const approval = useActionApprovalContinuation({
        scopeKey: targetKey,
        serverId: scope.serverId,
        onExecuted: NO_APPROVAL_REFRESH,
    });
    const approvalPending = pendingApproval !== null || approval.approvalPending;

    React.useEffect(() => {
        requestRevision.current += 1;
        setCandidates(EMPTY_CANDIDATES);
        setFailure(null);
        setPendingApproval(null);
        setAuthorityLost(false);
        setAssignmentAutoFollowed(false);
        setPending(false);
        mutationRevision.current += 1;
        mutationInFlight.current = false;
        setLastGoodSummary(null);
    }, [targetKey]);

    // Prefer the canonical projection; retain last-good while stale/unavailable.
    React.useEffect(() => {
        if (responsibleAccountId === undefined) return;
        if (responsibleAccountId === null) {
            setLastGoodSummary(null);
            return;
        }
        if (projectedSummary && projectedSummary.accountId === responsibleAccountId) {
            setLastGoodSummary(projectedSummary);
        }
    }, [responsibleAccountId, projectedSummary]);

    React.useEffect(() => {
        if (responsibleAccountId !== scope.accountId) {
            setAssignmentAutoFollowed(false);
        }
    }, [responsibleAccountId, scope.accountId]);

    // The proven refusal only stands in for a projection that has not caught up
    // yet. Once the canonical projection itself withdraws the capability it owns
    // the answer again, so a later regrant restores the control normally.
    React.useEffect(() => {
        if (!projectedAssignResponsibility) setAuthorityLost(false);
    }, [projectedAssignResponsibility]);

    const availability: SessionResponsibilityAvailability = !sessionKnown || collaborationAvailabilityState === 'loading'
        ? 'loading'
        : responsibleAccountId === undefined || collaborationAvailability !== 'available'
            ? 'unsupported'
        : projectedAssignResponsibility && !authorityLost
            ? 'editable'
            : 'read_only';

    // Capability/access loss clears private candidate data; the surface closes
    // or becomes read-only with a localized "Access changed" result.
    React.useEffect(() => {
        if (availability === 'editable') return;
        requestRevision.current += 1;
        setCandidates(EMPTY_CANDIDATES);
    }, [availability]);

    const isCurrent = React.useCallback(
        () => mounted.current && currentTarget.current === targetKey,
        [targetKey],
    );

    const loadCandidates = React.useCallback(async (input?: Readonly<{ query?: string; cursor?: string }>) => {
        if (availability !== 'editable') return;
        const revision = ++requestRevision.current;
        setCandidates((current) => ({
            ...current,
            // Previous results stay visible while a search refreshes rather than
            // flashing an empty list or a skeleton wall.
            loading: true,
            failed: false,
        }));
        try {
            const page = await listSessionResponsibilityCandidates(scope, {
                sessionId,
                ...(input?.query ? { query: input.query } : {}),
                ...(input?.cursor ? { cursor: input.cursor } : {}),
            }, {
                availability: collaborationAvailability,
                isCurrent,
            });
            if (requestRevision.current !== revision || !isCurrent()) return;
            setCandidates((current) => ({
                loading: false,
                failed: false,
                candidates: input?.cursor ? [...current.candidates, ...page.candidates] : page.candidates,
                nextCursor: page.nextCursor,
            }));
            setFailure((current) => current === 'session_access_authentication_required'
                || current === 'session_access_authentication_unavailable'
                ? null
                : current);
        } catch (error) {
            if (requestRevision.current !== revision || !isCurrent()) return;
            const authenticationFailed = error instanceof SessionResponsibilityError
                && (error.failure === 'session_access_authentication_required'
                    || error.failure === 'session_access_authentication_unavailable');
            // A refused page is a fresh authoritative answer about this Account's
            // standing: the identities already on screen were disclosed under a
            // basis the Home has just withdrawn, so they go with the control.
            if (error instanceof SessionResponsibilityError
                && provesSessionResponsibilityAuthorityLoss(error.failure)) {
                requestRevision.current += 1;
                setAuthorityLost(true);
                setCandidates(EMPTY_CANDIDATES);
                setFailure(error.failure);
                return;
            }
            setCandidates((current) => authenticationFailed
                ? { ...EMPTY_CANDIDATES, failed: true }
                : {
                    ...current,
                    loading: false,
                    failed: true,
                    // A failed initial/search request must retry from the start
                    // even while last-good rows remain visible. Only a failed
                    // continuation retains its opaque cursor for exact retry.
                    nextCursor: input?.cursor ?? null,
                });
            if (authenticationFailed) {
                setFailure(error.failure);
            }
        }
    }, [scope.serverId, scope.accountId, sessionId, availability, collaborationAvailability, isCurrent, targetKey]);

    // Consume the authoritative id/summary plus this exact transition's transient
    // auto-Follow result, whether it came back directly or through an executed
    // approval. `changed=false` is an acknowledged no-op with no
    // write/wake/baseline/handoff; `changed=true` hands the committed
    // previous/new transition once to Lane 09 server-side. The auto-Follow result
    // drives one in-context explanation only and is never persisted as
    // assignment origin or inferred client-side.
    const applyCommittedAssignment = React.useCallback((result: SetSessionResponsibilityResponse) => {
        if (result.responsibleAccount !== undefined) {
            setLastGoodSummary(result.responsibleAccount);
        } else if (result.responsibleAccountId === null) {
            setLastGoodSummary(null);
        }
        storage.getState().applySessionResponsibleAccount(
            sessionId,
            result.responsibleAccountId,
            scope,
            result.responsibleAccount ?? null,
        );
        setAssignmentAutoFollowed(
            result.autoFollowed === true && result.responsibleAccountId === scope.accountId,
        );
    }, [sessionId, scope.serverId, scope.accountId]);

    // One typed-failure reaction for a direct refusal and an approved execution's
    // recorded failure.
    const handleMutationFailure = React.useCallback(async function handleMutationFailure(
        failureKind: SessionResponsibilityMutationFailure,
        isOutcomeCurrent: () => boolean,
    ): Promise<void> {
        if (provesSessionResponsibilityAuthorityLoss(failureKind)) {
            // The Home refused in the deciding transaction, so the cached
            // capability is stale and the disclosed candidate identities lose
            // their basis. Reloading the page under the same refused basis
            // would only be refused again, so the control closes instead.
            requestRevision.current += 1;
            setAuthorityLost(true);
            setCandidates(EMPTY_CANDIDATES);
            return;
        }
        if (failureKind === 'session_access_authentication_required'
            || failureKind === 'session_access_authentication_unavailable') {
            // Team authentication loss revokes the basis on which private
            // candidate identities were disclosed. Invalidate any in-flight
            // page and clear the last accepted page immediately.
            requestRevision.current += 1;
            setCandidates(EMPTY_CANDIDATES);
        }
        if (failureKind === 'assignee-unavailable') {
            // The chosen person's access changed between the picker and the
            // commit. This Account's own authority is intact, so the page is
            // reloaded rather than guessing which row went stale.
            void loadCandidates();
        }
        if (failureKind === 'unknown') {
            try {
                const reconciled = await readSessionResponsibleAccount(scope, sessionId, { isCurrent: isOutcomeCurrent });
                if (isOutcomeCurrent()) {
                    setLastGoodSummary(reconciled.responsibleAccount);
                    storage.getState().applySessionResponsibleAccount(
                        sessionId,
                        reconciled.responsibleAccountId,
                        scope,
                        reconciled.responsibleAccount,
                    );
                }
            } catch (error) {
                // A reconciliation read has its own typed terminal outcomes.
                // Feed those through the same classifier as the direct
                // mutation so a definitive denial purges disclosed candidates
                // and withdraws editing, while authentication-required remains
                // recoverable. Transport/read failures stay outcome-unknown.
                if (isOutcomeCurrent() && error instanceof SessionResponsibilityError) {
                    const reconciliationFailure = error.failure;
                    setFailure(reconciliationFailure);
                    if (reconciliationFailure !== 'unknown') {
                        await handleMutationFailure(reconciliationFailure, isOutcomeCurrent);
                    }
                }
            }
        }
    }, [loadCandidates, sessionId, scope.serverId, scope.accountId]);

    const requestApproval = approval.requestApproval;
    const setResponsibleAccount = React.useCallback(async (accountId: string | null): Promise<boolean> => {
        if (availability !== 'editable' || mutationInFlight.current || approvalPending || !isCurrent()) return false;
        mutationInFlight.current = true;
        const mutation = ++mutationRevision.current;
        const isMutationCurrent = () => mutationRevision.current === mutation && isCurrent();
        setPending(true);
        setFailure(null);
        setPendingApproval(null);
        setAssignmentAutoFollowed(false);
        try {
            const result = await setSessionResponsibleAccount(scope, {
                sessionId,
                responsibleAccountId: accountId,
            }, {
                availability: collaborationAvailability,
                isCurrent: isMutationCurrent,
            });
            if (!isMutationCurrent()) return false;
            applyCommittedAssignment(result);
            return true;
        } catch (error) {
            if (!isMutationCurrent()) return false;
            const failureKind = error instanceof SessionResponsibilityError ? error.failure : 'unknown';
            const pendingIdentity = error instanceof SessionResponsibilityError ? error.approval : null;
            if (failureKind === 'approval-pending' && pendingIdentity) {
                // The canonical Action policy routed this intent to an approval
                // Artifact: nothing committed and the previous assignee is still
                // the truth. The shared continuation owner follows the Artifact and
                // settles this exact intent once; never a reconciliation read or a
                // retry from here.
                setFailure('approval-pending');
                setPendingApproval({ ...pendingIdentity, serverId: scope.serverId });
                const isSettlementCurrent = () => isMutationCurrent() && mounted.current;
                requestApproval(createActionApprovalContinuation<SetSessionResponsibilityResponse, 'session.responsibility.set'>({
                    artifactId: pendingIdentity.artifactId,
                    actionId: 'session.responsibility.set',
                    scope,
                    expectedInput: { sessionId, responsibleAccountId: accountId },
                    onSucceeded: (result) => {
                        if (!isSettlementCurrent()) return;
                        setPendingApproval(null);
                        setFailure(null);
                        applyCommittedAssignment(result);
                    },
                    onFailed: (code) => {
                        if (!isSettlementCurrent()) return;
                        setPendingApproval(null);
                        const settled = readApprovalSettlementFailure(code);
                        setFailure(settled);
                        if (settled) void handleMutationFailure(settled, isSettlementCurrent);
                    },
                }));
                return false;
            }
            setFailure(failureKind);
            await handleMutationFailure(failureKind, isMutationCurrent);
            return false;
        } finally {
            if (mutationRevision.current === mutation) {
                mutationInFlight.current = false;
                if (isCurrent()) setPending(false);
            }
        }
    }, [applyCommittedAssignment, approvalPending, handleMutationFailure, requestApproval, sessionId, scope.serverId, scope.accountId, availability, collaborationAvailability, isCurrent, targetKey]);

    // "Assign to me" is a fixed canonical-self option derived from the
    // authenticated Home Account plus current Session-read eligibility. It never
    // waits for, searches, or assumes membership in candidate page one. The
    // server repeats the target check in the mutation transaction.
    // The actor views this Session, so they read it; active status is the
    // authenticated Account itself. Hide only when already assigned to self or
    // not editable.
    const canAssignToSelf = availability === 'editable' && responsibleAccountId !== undefined;

    const responsibleAccount = responsibleAccountId === undefined || responsibleAccountId === null
        ? null
        : lastGoodSummary && lastGoodSummary.accountId === responsibleAccountId
            ? lastGoodSummary
            : projectedSummary && projectedSummary.accountId === responsibleAccountId
                ? projectedSummary
                : null;

    return {
        availability,
        responsibleAccountId,
        responsibleAccount: responsibleAccount ?? null,
        pending: pending || approvalPending,
        failure,
        pendingApproval,
        assignmentAutoFollowed,
        candidates,
        loadCandidates,
        setResponsibleAccount,
        canAssignToSelf,
    };
}
