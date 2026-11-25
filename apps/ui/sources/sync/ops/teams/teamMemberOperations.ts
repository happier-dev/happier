import {
    TeamMemberRemoveResultV1Schema,
    TeamGroupsPageV1Schema,
    TeamMembershipV1Schema,
    type SessionHistoryAccessV1,
    type TeamAdmissibleRoleV1,
    type TeamMemberRemoveResultV1,
    type TeamActionIdV1,
    type TeamGroupsPageV1,
    type TeamMemberManagementTargetV1,
    type TeamMembershipV1,
    type TeamRoleV1,
} from '@happier-dev/protocol/teams';

import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { invalidateTeam, refreshTeamsDirectory } from '@/sync/engine/teams/teamsDirectoryEngine';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { runTeamAction, type HomeDomainFailure } from './teamActionClient';

export { listTeamMembers } from './teamMemberReadOperations';

/**
 * Team membership reads and mutations, addressed to one explicit Home.
 *
 * Each wrapper names its Action and its strict input; the row declares the path
 * and codecs and the shared front door owns admission, settings and
 * dangerous-action approval, so no path or method appears here. They add exactly
 * two things a surface should not repeat: the Team refresh after a change the
 * Home actually accepted, because a role or removal can move the viewer's own
 * Team capabilities, and a result union that keeps an idempotent `unchanged`
 * removal distinguishable from a real one.
 *
 * They deliberately do not interpret authority. The Home's transaction decides,
 * and its typed code is carried through untouched.
 */

export type TeamMemberOutcome<TValue> =
    | Readonly<{ kind: 'succeeded'; value: TValue }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure }>;

function succeeded<TValue>(value: TValue): TeamMemberOutcome<TValue> {
    return Object.freeze({ kind: 'succeeded' as const, value });
}

function failed<TValue>(failure: HomeDomainFailure): TeamMemberOutcome<TValue> {
    return Object.freeze({ kind: 'failed' as const, failure });
}

export async function getTeamMember(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    membershipId: string;
    signal?: AbortSignal;
}>): Promise<TeamMemberOutcome<TeamMembershipV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.members.get',
        signal: params.signal,
        input: { v: 1, teamId: params.address.teamId, membershipId: params.membershipId },
        parse: (value) => TeamMembershipV1Schema.parse(value),
    });
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

/**
 * The Groups this membership lifetime is effectively in.
 *
 * It reads the same Group rows the Group list projects, so a Group opened from
 * member detail is the same destination carrying the same capabilities — member
 * detail never grows a second, thinner idea of what a Group is.
 */
export async function listTeamMemberGroups(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    membershipId: string;
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
}>): Promise<TeamMemberOutcome<TeamGroupsPageV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.members.groups.list',
        signal: params.signal,
        input: {
            v: 1,
            teamId: params.address.teamId,
            membershipId: params.membershipId,
            ...(params.cursor ? { cursor: params.cursor } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
        },
        parse: (value) => TeamGroupsPageV1Schema.parse(value),
    });
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

/**
 * Adds an existing Home Account to the Team.
 *
 * `historyAccess` is the admission decision the screen made, not a default this
 * layer invents: the Team's own `defaultSessionHistoryAccess` preselects it and
 * the membership owner mints the actual cutoff.
 */
export async function addTeamMember(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    accountId: string;
    role: TeamAdmissibleRoleV1;
    historyAccess: SessionHistoryAccessV1;
    /**
     * Receives the created membership once a deferred approval executes. The
     * membership id exists only in this answer and is what the `all_existing`
     * history journey continues at, so an approved add that dropped its result
     * would abandon the admission decision the manager actually made.
     */
    onApprovalSucceeded?: (membership: TeamMembershipV1) => void | Promise<void>;
    /** Carries the deferred refusal from the approval or Home. */
    onApprovalFailed?: (code: string, refusal?: ActionExecuteFailure) => void;
}>): Promise<TeamMemberOutcome<TeamMembershipV1>> {
    // One settlement for the immediate answer and the approved one: an
    // admission moves the roster and the viewer's own Team capabilities either
    // way. Withdraw its capabilities now, then revalidate without holding the
    // membership acknowledgement behind a separate read.
    const publish = (membership: TeamMembershipV1): TeamMembershipV1 => {
        fireAndForget(invalidateTeam(params.scope, params.address), { tag: 'teamMemberOperations.revalidate' });
        return membership;
    };
    const onApprovalSucceeded = params.onApprovalSucceeded;
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.members.add',
        input: {
            v: 1,
            teamId: params.address.teamId,
            accountId: params.accountId,
            role: params.role,
            historyAccess: params.historyAccess,
        },
        parse: (value) => TeamMembershipV1Schema.parse(value),
        ...(onApprovalSucceeded
            ? {
                onApprovalSucceeded: async (membership: TeamMembershipV1) =>
                    await onApprovalSucceeded(publish(membership)),
            }
            : {}),
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
    if (outcome.kind === 'failed') return failed(outcome.failure);
    return succeeded(publish(outcome.value));
}

export type TeamMemberChangeContinuation = Readonly<{
    onApprovalFailed?: (code: string, refusal?: ActionExecuteFailure) => void;
}>;

async function membershipTransition(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    actionId: TeamActionIdV1;
    input: unknown;
}> & TeamMemberChangeContinuation): Promise<TeamMemberOutcome<TeamMembershipV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: params.actionId,
        input: params.input,
        parse: (value) => TeamMembershipV1Schema.parse(value),
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
    if (outcome.kind === 'failed') return failed(outcome.failure);
    // A role or status change can move the viewer's own Team capabilities, so
    // the Team is re-read. A refusal moved nothing and spends no request.
    fireAndForget(invalidateTeam(params.scope, params.address), { tag: 'teamMemberOperations.revalidate' });
    return succeeded(outcome.value);
}

export function setTeamMemberRole(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    membershipId: string;
    role: TeamRoleV1;
}> & TeamMemberChangeContinuation): Promise<TeamMemberOutcome<TeamMembershipV1>> {
    return membershipTransition({
        scope: params.scope,
        address: params.address,
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
        actionId: 'teams.members.role.set',
        input: {
            v: 1,
            teamId: params.address.teamId,
            membershipId: params.membershipId,
            role: params.role,
        },
    });
}

/**
 * Moves who owns this membership's lifecycle, preserving the lifetime, role,
 * status and history horizon.
 *
 * The target names the exact source, so a conversion can never be a vague
 * "manage externally" that silently picks one. Returning to native management
 * names no source at all.
 */
export function setTeamMemberManagement(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    membershipId: string;
    management: TeamMemberManagementTargetV1;
}>): Promise<TeamMemberOutcome<TeamMembershipV1>> {
    return membershipTransition({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.members.management.set',
        input: {
            v: 1,
            teamId: params.address.teamId,
            membershipId: params.membershipId,
            management: params.management,
        },
    });
}

export function suspendTeamMember(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    membershipId: string;
}> & TeamMemberChangeContinuation): Promise<TeamMemberOutcome<TeamMembershipV1>> {
    return membershipTransition({
        scope: params.scope,
        address: params.address,
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
        actionId: 'teams.members.suspend',
        input: { v: 1, teamId: params.address.teamId, membershipId: params.membershipId },
    });
}

export function reactivateTeamMember(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    membershipId: string;
}> & TeamMemberChangeContinuation): Promise<TeamMemberOutcome<TeamMembershipV1>> {
    return membershipTransition({
        scope: params.scope,
        address: params.address,
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
        actionId: 'teams.members.reactivate',
        input: { v: 1, teamId: params.address.teamId, membershipId: params.membershipId },
    });
}

/**
 * Ends a membership lifetime. `unchanged` is the idempotent answer for a
 * lifetime that is already gone, so a retried confirmation does not read as a
 * failure; it is not reported as a fresh removal either.
 */
export async function removeTeamMember(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    membershipId: string;
}> & TeamMemberChangeContinuation): Promise<TeamMemberOutcome<TeamMemberRemoveResultV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.members.remove',
        input: { v: 1, teamId: params.address.teamId, membershipId: params.membershipId },
        parse: (value) => TeamMemberRemoveResultV1Schema.parse(value),
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
    if (outcome.kind === 'failed') return failed(outcome.failure);
    fireAndForget(invalidateTeam(params.scope, params.address), { tag: 'teamMemberOperations.revalidate' });
    return succeeded(outcome.value);
}

/** Self-removal settles the same way for immediate and deferred approved execution. */
export async function leaveTeam(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    onSucceeded?: () => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>): Promise<TeamMemberOutcome<TeamMemberRemoveResultV1>> {
    const publish = async () => {
        fireAndForget(Promise.all([
            refreshTeamsDirectory(params.scope, { v: 1, scope: 'member', archived: 'active' }),
            refreshTeamsDirectory(params.scope, { v: 1, scope: 'member', archived: 'archived' }),
        ]), { tag: 'teamMemberOperations.revalidateDirectories' });
        // Leaving withdraws the detail's read access. Continue to the directory
        // before that re-read can unmount the originating confirmation surface.
        await params.onSucceeded?.();
        fireAndForget(invalidateTeam(params.scope, params.address), { tag: 'teamMemberOperations.revalidate' });
    };
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.members.leave',
        input: { v: 1, teamId: params.address.teamId },
        parse: (value) => TeamMemberRemoveResultV1Schema.parse(value),
        onApprovalSucceeded: async () => {
            await publish();
        },
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
    if (outcome.kind === 'failed') return failed(outcome.failure);
    await publish();
    return succeeded(outcome.value);
}
