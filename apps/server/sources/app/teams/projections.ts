import { z } from "zod/mini";
import type { Prisma } from "@prisma/client";

import { resolveTeamAdmissionProjectionV1, type TeamSummaryCountsV1, type TeamSummaryV1 } from '@happier-dev/protocol/teams/projections';
import { isTeamPrincipalRoleV1, readManagedDefaultsV1, type TeamCapabilitiesV1, type TeamPolicyV1 } from '@happier-dev/protocol/teams';
import { normalizeTeamAuthenticationPolicyV1, TeamAuthenticationPolicyV1Schema } from '@happier-dev/protocol/auth/entry';

import type { HomeGovernanceAuthority } from "@/app/home/governance/homeCapabilities";
import { projectTeamDirectoryMembershipFact, type DirectoryMembershipProjectionRow } from "./directory/directorySourceProjection";
import { getPublicUrl } from "@/storage/blob/files";
import type {
    SessionHistoryAccess,
    TeamAdmissionMode,
    TeamExternalSharingPolicy,
    TeamRole,
    TeamSessionCreationPolicy,
} from "@/storage/enums.generated";

/**
 * The Team columns every projection needs, selected once so a route cannot
 * accidentally read a narrower row and then project a field it never loaded.
 */
export const TEAM_PROJECTION_SELECT = {
    id: true,
    name: true,
    description: true,
    logo: true,
    sessionCreationPolicy: true,
    reviewCreationPolicy: true,
    externalSharingPolicy: true,
    defaultSessionHistoryAccess: true,
    admissionMode: true,
    authenticationPolicy: true,
    managedDefaults: true,
    archivedAt: true,
    directorySources: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
            kind: true,
            state: true,
            displayName: true,
            activeReconcileRunId: true,
            lastAttemptAt: true,
            lastSuccessAt: true,
            lastErrorCode: true,
        },
    },
} satisfies Prisma.TeamSelect;

export type TeamRecord = Readonly<{
    id: string;
    name: string;
    description: string | null;
    logo: unknown;
    sessionCreationPolicy: TeamSessionCreationPolicy;
    reviewCreationPolicy: TeamSessionCreationPolicy;
    externalSharingPolicy: TeamExternalSharingPolicy;
    defaultSessionHistoryAccess: SessionHistoryAccess;
    admissionMode: TeamAdmissionMode;
    authenticationPolicy: unknown;
    managedDefaults?: unknown;
    archivedAt: Date | null;
    directorySources?: readonly DirectoryMembershipProjectionRow[];
}>;

/**
 * The stored logo metadata.
 *
 * The public URL is deliberately absent: it is derived from the deployment's
 * current blob backend at projection time, exactly as Account avatars are, so
 * moving or re-hosting public storage does not require rewriting Team rows.
 *
 * It is strict because this column is written only by the Team logo owner. A
 * value that does not match was not produced by that writer, and the safe
 * reading of an unrecognized branding reference is "no logo" rather than a
 * projected path of unknown provenance.
 */
export const StoredTeamLogoSchema = z.strictObject({
    path: z.string().check(z.minLength(1)),
    width: z.number().check(z.int(), z.positive()),
    height: z.number().check(z.int(), z.positive()),
    thumbhash: z.string().check(z.minLength(1)),
});
export type StoredTeamLogo = z.infer<typeof StoredTeamLogoSchema>;

export function readStoredTeamLogo(value: unknown, teamId?: string): StoredTeamLogo | null {
    const parsed = StoredTeamLogoSchema.safeParse(value);
    if (!parsed.success) return null;
    // A valid-looking path is still untrusted persisted data until it is bound
    // to the Team whose projection is being read. The optional argument keeps
    // this parser useful for migration/test inspection while every production
    // projection supplies the owning Team id.
    if (teamId !== undefined && !parsed.data.path.startsWith(`public/teams/${teamId}/logo/`)) return null;
    return parsed.data;
}

/**
 * The one Team-logo projection: the stored metadata bound to its own Team,
 * with the public URL derived from the current blob backend. Every surface
 * that shows a Team's logo — summary, invitation preview, auth entry — reads
 * it through here, so no second parser can disagree about what a logo is.
 */
export function projectTeamLogoRefV1(team: Pick<TeamRecord, "id" | "logo">): TeamSummaryV1["logo"] {
    const logo = readStoredTeamLogo(team.logo, team.id);
    return logo === null ? null : { ...logo, url: getPublicUrl(logo.path) };
}

/** The closed policy projection; the stored columns are already the contract. */
export function projectTeamPolicyV1(team: TeamRecord, homeDefaults?: TeamPolicyV1['homeDefaults']): TeamPolicyV1 {
    const managedDefaults = readManagedDefaultsV1(team.managedDefaults ?? null);
    const parsedAuthenticationPolicy = team.authenticationPolicy === null
        ? null
        : TeamAuthenticationPolicyV1Schema.safeParse(team.authenticationPolicy);
    const authenticationPolicy = parsedAuthenticationPolicy === null
        ? null
        : parsedAuthenticationPolicy.success
            ? normalizeTeamAuthenticationPolicyV1(parsedAuthenticationPolicy.data)
            : null;
    return {
        v: 1,
        sessionCreationPolicy: team.sessionCreationPolicy,
        reviewCreationPolicy: team.reviewCreationPolicy,
        externalSharingPolicy: team.externalSharingPolicy,
        defaultSessionHistoryAccess: team.defaultSessionHistoryAccess,
        admissionMode: team.admissionMode,
        authenticationPolicy,
        authenticationPolicyStatus: parsedAuthenticationPolicy !== null && !parsedAuthenticationPolicy.success
            ? "repair_required"
            : "available",
        managedDefaults: managedDefaults.defaults,
        managedDefaultsStatus: managedDefaults.status,
        ...(homeDefaults !== undefined ? { homeDefaults } : {}),
    };
}

/**
 * Coarse membership totals accompany a readable Team, including Home-only
 * administration; they confer no roster access. Group counts still follow
 * `viewRoster`, and waiting invitations follow qualified membership
 * `manageInvitations`.
 */
function projectTeamSummaryCountsV1(input: Readonly<{
    counts: TeamSummaryCountFacts;
    capabilities: TeamCapabilitiesV1;
    teamCapabilities: TeamCapabilitiesV1;
}>): TeamSummaryV1["counts"] {
    if (!input.capabilities.viewTeam) return null;
    return {
        members: input.counts.members,
        suspendedMembers: input.counts.suspendedMembers,
        groups: input.capabilities.viewRoster ? input.counts.groups : null,
        archivedGroups: input.capabilities.viewRoster ? input.counts.archivedGroups : null,
        waitingInvitations: input.teamCapabilities.manageInvitations ? input.counts.waitingInvitations : null,
    };
}

/** The unqualified counts of one Team, as read by `readTeamSummaryCountsInTx`. */
export type TeamSummaryCountFacts = Readonly<Omit<TeamSummaryCountsV1, "groups" | "archivedGroups" | "waitingInvitations"> & {
    groups: number;
    archivedGroups: number;
    waitingInvitations: number;
}>;

/**
 * The one Team summary builder used by `teams.get`, `teams.list`, and every
 * mutation result, so a client never has to reconcile two shapes of the same
 * Team. Capabilities arrive already decided; Team-default eligibility uses the protocol role owner.
 * Counts arrive unqualified from `readTeamSummaryCountsInTx` and are narrowed
 * here to what those capabilities may read.
 */
export function projectTeamSummaryV1(input: Readonly<{
    team: TeamRecord;
    viewerRole: TeamRole | null;
    viewerJoinedAt?: number | null;
    hasSetup?: boolean | null;
    capabilities: TeamCapabilitiesV1;
    ownerRequired: boolean;
    homeAuthority: Pick<HomeGovernanceAuthority, "manageAllTeams">;
    /**
     * Membership-derived authority after Team authentication qualification
     * (none when unqualified); it decides whether invitation counts are visible.
     */
    teamCapabilities: TeamCapabilitiesV1;
    counts: TeamSummaryCountFacts;
    managedDefaultsGroupIds?: readonly string[];
    homeDefaults?: TeamPolicyV1['homeDefaults'];
}>): TeamSummaryV1 {
    const policy = projectTeamPolicyV1(input.team, input.homeDefaults);
    if (!input.capabilities.viewTeam) {
        policy.managedDefaults = null;
        policy.homeDefaults = null;
    } else if (input.viewerRole !== null && !isTeamPrincipalRoleV1(input.viewerRole)) {
        policy.managedDefaults = null;
    } else if (policy.managedDefaults && !input.capabilities.manageSettings && !input.teamCapabilities.manageGroups) {
        const applicable = new Set(input.managedDefaultsGroupIds ?? []);
        policy.managedDefaults = {
            team: policy.managedDefaults.team,
            groups: Object.fromEntries(Object.entries(policy.managedDefaults.groups).filter(([id]) => applicable.has(id))),
        };
    }
    return {
        id: input.team.id,
        name: input.team.name,
        description: input.team.description,
        logo: projectTeamLogoRefV1(input.team),
        archivedAt: input.team.archivedAt === null ? null : input.team.archivedAt.getTime(),
        recovery: input.ownerRequired
            ? {
                kind: "owner_required",
                canAppointOwner: input.homeAuthority.manageAllTeams,
            }
            : null,
        policy,
        managedDefaultsGroupIds: input.capabilities.viewTeam ? [...(input.managedDefaultsGroupIds ?? [])] : [],
        ...(input.capabilities.viewTeam && input.team.directorySources !== undefined ? {
            directoryMembership: projectTeamDirectoryMembershipFact(input.team.directorySources),
        } : {}),
        viewerRole: input.viewerRole,
        viewerJoinedAt: input.capabilities.viewTeam ? input.viewerJoinedAt ?? null : null,
        hasSetup: input.capabilities.viewTeam ? input.hasSetup ?? null : null,
        capabilities: input.capabilities,
        admission: resolveTeamAdmissionProjectionV1(),
        counts: projectTeamSummaryCountsV1({
            counts: input.counts,
            capabilities: input.capabilities,
            teamCapabilities: input.teamCapabilities,
        }),
    };
}
