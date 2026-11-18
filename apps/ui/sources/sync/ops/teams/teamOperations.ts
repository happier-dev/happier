import {
    TeamSummaryV1Schema,
    type TeamActionIdV1,
    type TeamAdmissionModeV1,
    type TeamAuthenticationPolicyComparisonBasisV1,
    type TeamExternalSharingPolicyV1,
    type TeamLogoSourceV1,
    type TeamSessionCreationPolicyV1,
    type SessionHistoryAccessV1,
    type TeamSummaryV1,
    type TeamPolicySetInputV1,
} from '@happier-dev/protocol/teams';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type {
    TeamAuthenticationPolicyV1,
} from '@happier-dev/protocol/auth/entry';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { applyTeamProjection } from '@/sync/store/teams/teamsSnapshots';

import {
    runTeamAction,
    type HomeDomainFailure,
    type TeamActionOutcome,
} from './teamActionClient';

/**
 * Team lifecycle, metadata, policy and branding intents for one exact Home.
 *
 * Each wrapper names its Action and its strict input and nothing else: the row
 * declares the path and codecs, and the shared front door owns admission,
 * settings and dangerous-action approval. UI + present-user dispatch is enough
 * for the shared default policy to avoid a duplicate approval, while explicit
 * user-required UI approvals remain authoritative. No path or method appears
 * here.
 *
 * Every Team mutation answers with the Team as the viewer now sees it, so the
 * accepted result is published straight into the Team snapshot rather than
 * triggering a re-read. That is not a second writer: it is the same projection
 * the Team's own read returns, arriving on the response that produced it, which
 * is what keeps a rename or an archive from flickering through a stale render.
 */

export type TeamMutationOutcome =
    | Readonly<{ kind: 'succeeded'; team: TeamSummaryV1 }>
    | Readonly<{ kind: 'failed'; failure: HomeDomainFailure }>;

async function mutateTeam(params: Readonly<{
    scope: ServerAccountScope;
    /** Absent for `teams.create`, whose Team id does not exist yet. */
    address: TeamAddress | null;
    actionId: TeamActionIdV1;
    input: unknown;
    /**
     * Receives this intent's real answer once a deferred approval executes.
     * Supplying it is what turns the thrown pending error into a result-bearing
     * continuation; settlement never redispatches, because the Home performed
     * the mutation when the approval was granted.
     */
    onApprovalSucceeded?: (team: TeamSummaryV1) => void | Promise<void>;
    /** Receives the refusal code and any typed Action failure from approval settlement. */
    onApprovalFailed?: (code: string, failure?: ActionExecuteFailure) => void;
}>): Promise<TeamMutationOutcome> {
    /**
     * One settlement for the immediate answer and the approved one.
     *
     * The answer is addressed by the Team the Home actually returned, so a
     * create publishes under its new id rather than needing a second read — and
     * an approved create publishes the same way instead of leaving the caller
     * holding an id no projection knows about.
     */
    const publish = (team: TeamSummaryV1): TeamSummaryV1 => {
        applyTeamProjection({
            scope: params.scope,
            address: params.address ?? { serverId: params.scope.serverId, teamId: team.id },
            team,
            observedAt: Date.now(),
        });
        return team;
    };
    const onApprovalSucceeded = params.onApprovalSucceeded;
    const outcome: TeamActionOutcome<TeamSummaryV1> = await runTeamAction({
        scope: params.scope,
        actionId: params.actionId,
        input: params.input,
        parse: (value) => TeamSummaryV1Schema.parse(value),
        ...(onApprovalSucceeded
            ? { onApprovalSucceeded: async (team: TeamSummaryV1) => await onApprovalSucceeded(publish(team)) }
            : {}),
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
    if (outcome.kind === 'failed') {
        return Object.freeze({ kind: 'failed' as const, failure: outcome.failure });
    }

    return Object.freeze({ kind: 'succeeded' as const, team: publish(outcome.value) });
}

/**
 * Creates a Team on one exact Home.
 *
 * `requestKey` is the caller's own retry identity: a lost response must not
 * create a second Team, so the same key is reused across a transport retry of
 * the same submission and only regenerated for a genuinely new one.
 */
export function createTeam(params: Readonly<{
    scope: ServerAccountScope;
    name: string;
    description: string | null;
    initialOwnerAccountId?: string;
    requestKey: string;
    /**
     * Receives the created Team once a deferred approval executes. The new
     * Team's id exists only in this answer, so without it an approved creation
     * would strand the person on a submitted form with no way to reach the Team
     * they just made.
     */
    onApprovalSucceeded?: (team: TeamSummaryV1) => void | Promise<void>;
    onApprovalFailed?: (code: string, failure?: ActionExecuteFailure) => void;
}>): Promise<TeamMutationOutcome> {
    return mutateTeam({
        scope: params.scope,
        address: null,
        actionId: 'teams.create',
        input: {
            v: 1,
            name: params.name,
            description: params.description,
            ...(params.initialOwnerAccountId ? { initialOwnerAccountId: params.initialOwnerAccountId } : {}),
            requestKey: params.requestKey,
        },
        ...(params.onApprovalSucceeded ? { onApprovalSucceeded: params.onApprovalSucceeded } : {}),
        ...(params.onApprovalFailed ? { onApprovalFailed: params.onApprovalFailed } : {}),
    });
}

/** Metadata only. An omitted field is unchanged; a null description clears it. */
export function updateTeam(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    name?: string;
    description?: string | null;
}>): Promise<TeamMutationOutcome> {
    return mutateTeam({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.update',
        input: {
            v: 1,
            teamId: params.address.teamId,
            ...(params.name !== undefined ? { name: params.name } : {}),
            ...(params.description !== undefined ? { description: params.description } : {}),
        },
    });
}

/**
 * Patches Team policy. The patch commits wholly or not at all, so a permitted
 * Session-default edit can never clear a field the actor was not authorized to
 * change; omitted fields are simply not sent.
 */
export function setTeamPolicy(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    sessionCreationPolicy?: TeamSessionCreationPolicyV1;
    externalSharingPolicy?: TeamExternalSharingPolicyV1;
    defaultSessionHistoryAccess?: SessionHistoryAccessV1;
    admissionMode?: TeamAdmissionModeV1;
    /** The strict prior value required when replacing accepted authentication. */
    previousAuthenticationPolicy?: TeamAuthenticationPolicyComparisonBasisV1;
    /** `null` restores Home inheritance; omitted leaves the current value unchanged. */
    authenticationPolicy?: TeamAuthenticationPolicyV1 | null;
} & Pick<TeamPolicySetInputV1, 'managedDefaults' | 'managedGroupDefaults'>>): Promise<TeamMutationOutcome> {
    return mutateTeam({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.policy.set',
        input: {
            v: 1,
            teamId: params.address.teamId,
            ...(params.sessionCreationPolicy !== undefined
                ? { sessionCreationPolicy: params.sessionCreationPolicy } : {}),
            ...(params.externalSharingPolicy !== undefined
                ? { externalSharingPolicy: params.externalSharingPolicy } : {}),
            ...(params.defaultSessionHistoryAccess !== undefined
                ? { defaultSessionHistoryAccess: params.defaultSessionHistoryAccess } : {}),
            ...(params.admissionMode !== undefined ? { admissionMode: params.admissionMode } : {}),
            ...(params.authenticationPolicy !== undefined
                ? { previousAuthenticationPolicy: params.previousAuthenticationPolicy }
                : {}),
            ...(params.authenticationPolicy !== undefined
                ? { authenticationPolicy: params.authenticationPolicy }
                : {}),
            ...(params.managedDefaults !== undefined ? { managedDefaults: params.managedDefaults } : {}),
            ...(params.managedGroupDefaults !== undefined ? { managedGroupDefaults: params.managedGroupDefaults } : {}),
        },
    });
}

export function archiveTeam(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
}>): Promise<TeamMutationOutcome> {
    return mutateTeam({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.archive',
        input: { v: 1, teamId: params.address.teamId },
    });
}

export function restoreTeam(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
}>): Promise<TeamMutationOutcome> {
    return mutateTeam({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.restore',
        input: { v: 1, teamId: params.address.teamId },
    });
}

/**
 * Publishes a Team logo through the shared managed-image owner. The client sends
 * source bytes only; the published `ImageRef`, its square fit and its thumbhash
 * are the media owner's outputs and are never caller-supplied.
 */
export function setTeamLogo(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    image: TeamLogoSourceV1;
    onApprovalSucceeded?: (team: TeamSummaryV1) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>): Promise<TeamMutationOutcome> {
    return mutateTeam({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.logo.set',
        input: { v: 1, teamId: params.address.teamId, image: params.image },
        onApprovalSucceeded: params.onApprovalSucceeded,
        onApprovalFailed: params.onApprovalFailed,
    });
}

/** Drops the logo. The Team falls back to its deterministic monogram. */
export function removeTeamLogo(params: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
}>): Promise<TeamMutationOutcome> {
    return mutateTeam({
        scope: params.scope,
        address: params.address,
        actionId: 'teams.logo.remove',
        input: { v: 1, teamId: params.address.teamId },
    });
}
