import {
    TeamGroupMemberMutationResultV1Schema,
    TeamGroupMembersPageV1Schema,
    TeamGroupV1Schema,
    TeamGroupsPageV1Schema,
    type SessionHistoryAccessV1,
    type TeamActionIdV1,
    type TeamGroupMemberMutationResultV1,
    type TeamGroupMembersPageV1,
    type TeamGroupV1,
    type TeamGroupsPageV1,
} from '@happier-dev/protocol/teams';
import type { PrivateLabelStoredV1 } from '@happier-dev/protocol/crypto/privateLabelV1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';

import {
    applyTeamGroupProjection,
    invalidateTeamGroupsForTeam,
} from '@/sync/store/teams/teamsSnapshots';

import { runTeamAction, type HomeDomainFailure } from './teamActionClient';

/**
 * Team Group reads and mutations, addressed to one explicit Home.
 *
 * Every mutation answers with the row the viewer now sees, so a surface renders
 * the Home's own truth rather than a locally predicted one. The Group-member
 * mutation result is deliberately carried through whole: `contribution_removed`
 * is not `removed`, and a screen that collapsed the two would tell somebody a
 * person had lost Group access when a directory still contributes them.
 */

export type TeamGroupOutcome<TValue> =
    | Readonly<{ kind: 'succeeded'; value: TValue }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure }>;

function succeeded<TValue>(value: TValue): TeamGroupOutcome<TValue> {
    return Object.freeze({ kind: 'succeeded' as const, value });
}

function failed<TValue>(failure: HomeDomainFailure): TeamGroupOutcome<TValue> {
    return Object.freeze({ kind: 'failed' as const, failure });
}

export async function listTeamGroups(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    archived: 'active' | 'archived';
    cursor?: string | null;
    signal?: AbortSignal;
}>): Promise<TeamGroupOutcome<TeamGroupsPageV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.groups.list',
        signal: params.signal,
        input: {
            v: 1,
            teamId: params.address.teamId,
            archived: params.archived,
            ...(params.cursor ? { cursor: params.cursor } : {}),
        },
        parse: (value) => TeamGroupsPageV1Schema.parse(value),
    });
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

export async function getTeamGroup(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    groupId: string;
    signal?: AbortSignal;
}>): Promise<TeamGroupOutcome<TeamGroupV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.groups.get',
        signal: params.signal,
        input: { v: 1, teamId: params.address.teamId, groupId: params.groupId },
        parse: (value) => TeamGroupV1Schema.parse(value),
    });
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

async function groupMutation(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    actionId: TeamActionIdV1;
    input: unknown;
    onApprovalSucceeded?: (group: TeamGroupV1) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>): Promise<TeamGroupOutcome<TeamGroupV1>> {
    // One settlement for the immediate answer and the approved one. The Home
    // answered with the row the viewer now sees, so publish it to the one Group
    // projection rather than letting each surface re-read it. The Groups
    // sequences are marked stale because a create, archive or restore moves
    // membership of a sequence this result does not describe.
    const publish = (group: TeamGroupV1): TeamGroupV1 => {
        applyTeamGroupProjection({
            scope: params.scope,
            address: params.address,
            group,
            observedAt: Date.now(),
        });
        invalidateTeamGroupsForTeam(params.scope, params.address);
        return group;
    };
    const onApprovalSucceeded = params.onApprovalSucceeded;
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: params.actionId,
        input: params.input,
        parse: (value) => TeamGroupV1Schema.parse(value),
        ...(onApprovalSucceeded
            ? { onApprovalSucceeded: async (group: TeamGroupV1) => await onApprovalSucceeded(publish(group)) }
            : {}),
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
    if (outcome.kind !== 'succeeded') return failed(outcome.failure);
    return succeeded(publish(outcome.value));
}

/**
 * `requestKey` is the caller's retry identity so a lost response cannot create
 * two Groups; it is regenerated only for a genuinely new submission.
 */
export function createTeamGroup(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    /** Minted before sealing so the ciphertext is bound to the immutable Group row. */
    groupId: string;
    name: PrivateLabelStoredV1;
    description: string | null;
    requestKey: string;
    /**
     * Receives the created Group once a deferred approval executes. Its id
     * exists only in this answer, so without it an approved creation would
     * leave the manager on a submitted form with no route to the new Group.
     */
    onApprovalSucceeded?: (group: TeamGroupV1) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>): Promise<TeamGroupOutcome<TeamGroupV1>> {
    return groupMutation({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.groups.create',
        input: {
            v: 1,
            teamId: params.address.teamId,
            groupId: params.groupId,
            name: params.name,
            description: params.description,
            requestKey: params.requestKey,
        },
        ...(params.onApprovalSucceeded ? { onApprovalSucceeded: params.onApprovalSucceeded } : {}),
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
}

export function updateTeamGroup(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    groupId: string;
    name?: PrivateLabelStoredV1;
    description?: string | null;
}>): Promise<TeamGroupOutcome<TeamGroupV1>> {
    return groupMutation({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.groups.update',
        input: {
            v: 1,
            teamId: params.address.teamId,
            groupId: params.groupId,
            ...(params.name !== undefined ? { name: params.name } : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
        },
    });
}

export function archiveTeamGroup(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    groupId: string;
}>): Promise<TeamGroupOutcome<TeamGroupV1>> {
    return groupMutation({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.groups.archive',
        input: { v: 1, teamId: params.address.teamId, groupId: params.groupId },
    });
}

export function restoreTeamGroup(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    groupId: string;
}>): Promise<TeamGroupOutcome<TeamGroupV1>> {
    return groupMutation({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.groups.restore',
        input: { v: 1, teamId: params.address.teamId, groupId: params.groupId },
    });
}

export async function listTeamGroupMembers(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    groupId: string;
    cursor?: string | null;
    signal?: AbortSignal;
}>): Promise<TeamGroupOutcome<TeamGroupMembersPageV1>> {
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: 'teams.groups.members.list',
        signal: params.signal,
        input: {
            v: 1,
            teamId: params.address.teamId,
            groupId: params.groupId,
            ...(params.cursor ? { cursor: params.cursor } : {}),
        },
        parse: (value) => TeamGroupMembersPageV1Schema.parse(value),
    });
    return outcome.kind === 'succeeded' ? succeeded(outcome.value) : failed(outcome.failure);
}

/**
 * A member mutation answers with the member, not the Group, so there is no new
 * Group truth to publish — but `memberCount` lives on the Group row that the
 * Groups sequence and every label reader are already holding. Marking those
 * rows stale lets the one Group projection re-read the Home's count instead of
 * leaving a surface showing a number the mutation just invalidated, and does it
 * through the same owner the Group mutations use.
 */
async function groupMemberMutation(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    actionId: TeamActionIdV1;
    input: unknown;
    onApprovalSucceeded?: (result: TeamGroupMemberMutationResultV1) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>): Promise<TeamGroupOutcome<TeamGroupMemberMutationResultV1>> {
    // A refusal or truthful idempotent no-op changed nothing on the Home, so it
    // must not cost every holder of these rows a re-read. In particular, an
    // absent/repeated native removal returns `unchanged`; invalidating here
    // would turn that explicit zero-effect result into observable cache churn.
    // The approved answer is the same answer, so it settles the same way.
    const publish = (
        result: TeamGroupMemberMutationResultV1,
    ): TeamGroupMemberMutationResultV1 => {
        if (result.status !== 'unchanged') {
            invalidateTeamGroupsForTeam(params.scope, params.address);
        }
        return result;
    };
    const onApprovalSucceeded = params.onApprovalSucceeded;
    const outcome = await runTeamAction({
        scope: params.scope,
        actionId: params.actionId,
        input: params.input,
        parse: (value) => TeamGroupMemberMutationResultV1Schema.parse(value),
        ...(onApprovalSucceeded
            ? {
                onApprovalSucceeded: async (result: TeamGroupMemberMutationResultV1) =>
                    await onApprovalSucceeded(publish(result)),
            }
            : {}),
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
    if (outcome.kind !== 'succeeded') return failed(outcome.failure);
    return succeeded(publish(outcome.value));
}

/**
 * Adds a native contribution. The Group history intent is required and separate
 * from the Team horizon: the membership owner consumes it only when this
 * membership's first contribution mints a horizon, and never widens a retained
 * one, so this layer passes the manager's choice through untouched.
 */
export function addTeamGroupMember(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    groupId: string;
    accountId: string;
    historyAccess: SessionHistoryAccessV1;
    /**
     * Receives the contribution's real answer once a deferred approval
     * executes. `added` versus `unchanged` is what decides whether the history
     * preparation journey continues, so an approved add that dropped its result
     * would silently abandon the manager's `all_existing` instruction.
     */
    onApprovalSucceeded?: (result: TeamGroupMemberMutationResultV1) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>): Promise<TeamGroupOutcome<TeamGroupMemberMutationResultV1>> {
    return groupMemberMutation({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.groups.members.add',
        input: {
            v: 1,
            teamId: params.address.teamId,
            groupId: params.groupId,
            accountId: params.accountId,
            historyAccess: params.historyAccess,
        },
        ...(params.onApprovalSucceeded ? { onApprovalSucceeded: params.onApprovalSucceeded } : {}),
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
}

/** Clears only the native contribution; an external one keeps the person in. */
export function removeTeamGroupMember(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    groupId: string;
    accountId: string;
    /**
     * Receives the removal's real answer once a deferred approval executes.
     * `contribution_removed` is not `removed`, so a dropped result would let a
     * surface claim somebody lost Group access a directory still grants.
     */
    onApprovalSucceeded?: (result: TeamGroupMemberMutationResultV1) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>): Promise<TeamGroupOutcome<TeamGroupMemberMutationResultV1>> {
    return groupMemberMutation({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.groups.members.remove',
        input: {
            v: 1,
            teamId: params.address.teamId,
            groupId: params.groupId,
            accountId: params.accountId,
        },
        ...(params.onApprovalSucceeded ? { onApprovalSucceeded: params.onApprovalSucceeded } : {}),
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
}
