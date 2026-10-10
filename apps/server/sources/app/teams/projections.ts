import { z } from "zod";

import {
    resolveTeamAdmissionProjectionV1,
    type TeamCapabilitiesV1,
    type TeamSummaryCountsV1,
    type TeamPolicyV1,
    type TeamSummaryV1,
} from "@happier-dev/protocol/teams";
import {
    normalizeTeamAuthenticationPolicyV1,
    TeamAuthenticationPolicyV1Schema,
} from "@happier-dev/protocol";

import type { HomeGovernanceAuthority } from "@/app/home/governance/homeCapabilities";
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
    externalSharingPolicy: true,
    defaultSessionHistoryAccess: true,
    admissionMode: true,
    authenticationPolicy: true,
    archivedAt: true,
} as const;

export type TeamRecord = Readonly<{
    id: string;
    name: string;
    description: string | null;
    logo: unknown;
    sessionCreationPolicy: TeamSessionCreationPolicy;
    externalSharingPolicy: TeamExternalSharingPolicy;
    defaultSessionHistoryAccess: SessionHistoryAccess;
    admissionMode: TeamAdmissionMode;
    authenticationPolicy: unknown;
    archivedAt: Date | null;
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
export const StoredTeamLogoSchema = z.object({
    path: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    thumbhash: z.string().min(1),
}).strict();
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
export function projectTeamPolicyV1(team: TeamRecord): TeamPolicyV1 {
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
        externalSharingPolicy: team.externalSharingPolicy,
        defaultSessionHistoryAccess: team.defaultSessionHistoryAccess,
        admissionMode: team.admissionMode,
        authenticationPolicy,
        authenticationPolicyStatus: parsedAuthenticationPolicy !== null && !parsedAuthenticationPolicy.success
            ? "repair_required"
            : "available",
    };
}

/**
 * The Overview counts this viewer may see, decided exactly as the lists they
 * summarize decide it: roster and Group counts follow the composed
 * `viewRoster` capability, and the waiting-invitation count follows qualified
 * membership `manageInvitations`.
 */
function projectTeamSummaryCountsV1(input: Readonly<{
    counts: TeamSummaryCountFacts;
    capabilities: TeamCapabilitiesV1;
    teamCapabilities: TeamCapabilitiesV1;
}>): TeamSummaryV1["counts"] {
    if (!input.capabilities.viewRoster) return null;
    return {
        members: input.counts.members,
        suspendedMembers: input.counts.suspendedMembers,
        groups: input.counts.groups,
        waitingInvitations: input.teamCapabilities.manageInvitations ? input.counts.waitingInvitations : null,
    };
}

/** The unqualified counts of one Team, as read by `readTeamSummaryCountsInTx`. */
export type TeamSummaryCountFacts = Readonly<Omit<TeamSummaryCountsV1, "waitingInvitations"> & {
    waitingInvitations: number;
}>;

/**
 * The one Team summary builder used by `teams.get`, `teams.list`, and every
 * mutation result, so a client never has to reconcile two shapes of the same
 * Team. Capabilities arrive already decided; nothing here compares a role.
 * Counts arrive unqualified from `readTeamSummaryCountsInTx` and are narrowed
 * here to what those capabilities may read.
 */
export function projectTeamSummaryV1(input: Readonly<{
    team: TeamRecord;
    viewerRole: TeamRole | null;
    capabilities: TeamCapabilitiesV1;
    ownerRequired: boolean;
    homeAuthority: Pick<HomeGovernanceAuthority, "manageAllTeams">;
    /**
     * Membership-derived authority after Team authentication qualification
     * (none when unqualified); it decides whether invitation counts are visible.
     */
    teamCapabilities: TeamCapabilitiesV1;
    counts: TeamSummaryCountFacts;
}>): TeamSummaryV1 {
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
        policy: projectTeamPolicyV1(input.team),
        viewerRole: input.viewerRole,
        capabilities: input.capabilities,
        admission: resolveTeamAdmissionProjectionV1(),
        counts: projectTeamSummaryCountsV1({
            counts: input.counts,
            capabilities: input.capabilities,
            teamCapabilities: input.teamCapabilities,
        }),
    };
}
