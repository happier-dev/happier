import {
    TeamInvitationAcceptResultV1Schema,
    TeamInvitationCreateResultV1Schema,
    TeamInvitationReissueResultV1Schema,
    TeamInvitationRevokeResultV1Schema,
    TeamInvitationsPageV1Schema,
    type SessionHistoryAccessV1,
    type TeamInvitationAcceptResultV1,
    type TeamInvitationAdmissibleRoleV1,
    type TeamInvitationCreateResultV1,
    type TeamInvitationReissueResultV1,
    type TeamInvitationRowV1,
    type TeamInvitationStateV1,
    type TeamInvitationsPageV1,
} from '@happier-dev/protocol/teams';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopedTeamResourceKey, type TeamAddress } from '@/sync/domains/teams/teamAddress';

import { runTeamAction, type HomeDomainFailure } from './teamActionClient';

/**
 * Team invitation reads and mutations, addressed to one explicit Home.
 *
 * The raw bearer exists in exactly two answers — creation and reissue — and is
 * never stored, re-read, logged, or carried anywhere else: the listed row has no
 * bearer field at all, so a manager reviewing outstanding invitations cannot
 * recover a secret and a lost link can only be replaced by reissuing.
 *
 * That is why those two alone take a mount-scoped `signal` instead of the
 * deferred result handlers every other Team mutation here uses. They are
 * declared live-only custody: an explicit UI approval keeps the invocation
 * pending through the shared blocking waiter and returns the raw answer to that
 * live call, while the durable approval Artifact retains only the safe
 * observation projection. A deferred continuation would require the bearer to
 * be re-readable afterwards, which is exactly the property this domain refuses.
 *
 * Preview and accept are the pre-authentication transport of the same owner and
 * carry the bearer in a strict versioned body, never in a query string.
 */

export type TeamInvitationOutcome<TValue> =
    | Readonly<{ kind: 'succeeded'; value: TValue }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure }>;

function succeeded<TValue>(value: TValue): TeamInvitationOutcome<TValue> {
    return Object.freeze({ kind: 'succeeded' as const, value });
}

function failed<TValue>(failure: HomeDomainFailure): TeamInvitationOutcome<TValue> {
    return Object.freeze({ kind: 'failed' as const, failure });
}

export const TEAM_INVITATIONS_PAGE_LIMIT = 50;

export function teamInvitationsPageKey(scope: ServerAccountScope, address: TeamAddress,
    state: TeamInvitationStateV1 | null, limit = TEAM_INVITATIONS_PAGE_LIMIT): string {
    return serverAccountScopedTeamResourceKey(scope, address, 'invitations', JSON.stringify([state, limit]));
}

export async function listTeamInvitations(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    /** `null` means every retained state, including terminal provenance. */
    state: TeamInvitationStateV1 | null;
    cursor?: string | null;
    /**
     * Narrows the page for a caller that needs the Home's answer rather than the
     * roster — the invite sheet reads `emailDelivery` and renders no rows, so
     * asking for fifty of them would be paid-for and discarded.
     */
    limit?: number;
    signal?: AbortSignal;
}>): Promise<TeamInvitationOutcome<TeamInvitationsPageV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.invitations.list',
        signal: params.signal,
        input: {
            v: 1,
            teamId: params.address.teamId,
            state: params.state,
            cursor: params.cursor ?? null,
            limit: params.limit ?? TEAM_INVITATIONS_PAGE_LIMIT,
        },
        parse: (value) => TeamInvitationsPageV1Schema.parse(value),
    });
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

/**
 * Creates one invitation. `joinUrl` is the single confined delivery of the raw
 * bearer to the authorized manager, and is `null` for an email-bound invitation
 * whose bearer reaches only the mail boundary — that absence is meaningful and
 * must be shown as "no link to share", never as a failure.
 */
export async function createTeamInvitation(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    role: TeamInvitationAdmissibleRoleV1;
    historyAccess: SessionHistoryAccessV1;
    recipientEmail: string | null;
    requestKey: string;
    /**
     * The invoking surface's mount lifetime.
     *
     * Creation is one of the two answers that carry a raw bearer, so it is
     * declared live-only custody: an explicit UI approval keeps *this* call
     * pending through the shared blocking approval waiter and returns the raw
     * result to this live invocation alone. Nothing durable can hand the bearer
     * back afterwards — the Artifact retains only the safe observation
     * projection — so losing this invocation loses the link, and the caller
     * must offer reissue rather than promise recovery. Deliberately no deferred
     * result continuation: registering one would require a re-readable secret.
     */
    signal?: AbortSignal;
}>): Promise<TeamInvitationOutcome<TeamInvitationCreateResultV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.invitations.create',
        input: {
            v: 1,
            teamId: params.address.teamId,
            role: params.role,
            historyAccess: params.historyAccess,
            recipientEmail: params.recipientEmail,
            requestKey: params.requestKey,
        },
        parse: (value) => TeamInvitationCreateResultV1Schema.parse(value),
        ...(params.signal ? { signal: params.signal } : {}),
    });
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

/**
 * Revokes one invitation. The Home answers with the row it now holds, so a
 * repeated revocation reads as the current terminal state rather than an error
 * that would look like "the revocation did not happen".
 */
export async function revokeTeamInvitation(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    invitationId: string;
    /** Receives the terminal row once a deferred approval executes. */
    onApprovalSucceeded?: (value: TeamInvitationRowV1) => void | Promise<void>;
    /** Receives the approval's or the Home's own typed refusal code. */
    onApprovalFailed?: (code: string) => void;
}>): Promise<TeamInvitationOutcome<TeamInvitationRowV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.invitations.revoke',
        input: { v: 1, teamId: params.address.teamId, invitationId: params.invitationId },
        parse: (value) => TeamInvitationRevokeResultV1Schema.parse(value),
        ...(params.onApprovalSucceeded ? { onApprovalSucceeded: params.onApprovalSucceeded } : {}),
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

/**
 * Reissue is one operation for both Retry and Change email: it revokes the
 * current invitation and creates a replacement with copied intent in the same
 * transaction, so the previous link stops working.
 */
export async function reissueTeamInvitation(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    invitationId: string;
    /**
     * `null` is Retry: the Home preserves the invitation's existing recipient
     * constraint, so retrying an email-bound invitation cannot widen it into a
     * transferable link. A value is Change email and replaces that constraint.
     */
    recipientEmail: string | null;
    requestKey: string;
    /**
     * The invoking surface's mount lifetime.
     *
     * Reissue is the other live-only answer: it retires the previous bearer as
     * it runs, so its replacement link exists for this invocation and nowhere
     * else. An explicit UI approval keeps this call pending through the shared
     * blocking waiter; losing the invocation loses the link, and the only
     * honest recovery offered afterwards is another reissue.
     */
    signal?: AbortSignal;
}>): Promise<TeamInvitationOutcome<TeamInvitationReissueResultV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.invitations.reissue',
        input: {
            v: 1,
            teamId: params.address.teamId,
            invitationId: params.invitationId,
            recipientEmail: params.recipientEmail,
            requestKey: params.requestKey,
        },
        parse: (value) => TeamInvitationReissueResultV1Schema.parse(value),
        ...(params.signal ? { signal: params.signal } : {}),
    });
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

export async function acceptTeamInvitation(params: Readonly<{
    scope: ServerAccountScope;
    admission:
        | Readonly<{ token: string }>
        | Readonly<{ continuation: import('@happier-dev/protocol/teams').TeamInvitationPostAuthContinuationV1 }>;
    /**
     * Receives the Home's real admission answer once a deferred approval
     * executes.
     *
     * Admission is a dangerous, deferred, result-required intent: an explicit
     * UI-approval requirement turns it into a durable approval request rather
     * than an immediate join. Supplying this is what binds that request back to
     * the surface that asked for it, so the person learns whether they joined
     * instead of being left on an offer that silently never completed.
     * Settlement never redispatches: the Home already admitted them when the
     * approval was granted.
     */
    onApprovalSucceeded?: (value: TeamInvitationAcceptResultV1) => void | Promise<void>;
    /** Receives the approval's or the Home's own typed refusal code. */
    onApprovalFailed?: (code: string) => void;
}>): Promise<TeamInvitationOutcome<TeamInvitationAcceptResultV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.invitations.accept',
        input: { v: 1, ...params.admission },
        parse: (value) => TeamInvitationAcceptResultV1Schema.parse(value),
        ...(params.onApprovalSucceeded ? { onApprovalSucceeded: params.onApprovalSucceeded } : {}),
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}
