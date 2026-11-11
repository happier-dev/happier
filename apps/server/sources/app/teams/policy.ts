import { normalizeTeamAuthenticationPolicyV1, type TeamAuthenticationPolicyV1, type TeamRestrictedAuthenticationPolicyV1, TeamAuthenticationPolicyV1Schema } from '@happier-dev/protocol/auth/entry';
import { type TeamAuthenticationPolicyComparisonBasisV1, type TeamAuthenticationPolicyUnavailableDetailsV1 } from '@happier-dev/protocol/teams';
import type { TeamCapabilitiesV1 } from "@happier-dev/protocol/teams";
import { readManagedDefaultsV1, type ManagedDefaultsV1, type ManagedSessionDefaultsV1, type ManagedSessionPlacementV1 } from "@happier-dev/protocol/teams";
import type { TeamSummaryV1 } from '@happier-dev/protocol/teams/projections';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { resolveTeamAuthenticationPolicyInTx } from "@/app/auth/entry/resolveTeamAuthenticationPolicy";
import type { Tx } from "@/storage/inTx";
import { acquireTeamMutationAccountAdmissionInTx } from "./memberships/sessionAccessEffects";
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import { getActivePrismaRuntime } from "@/storage/prisma";
import {
    AccountStatus,
    TeamRole,
    TeamMembershipStatus,
    type SessionHistoryAccess,
    type TeamAdmissionMode,
    type TeamExternalSharingPolicy,
    type TeamSessionCreationPolicy,
} from "@/storage/enums.generated";

import { projectForActorInTx } from "./lifecycle";
import { TEAM_PROJECTION_SELECT } from "./projections";
import { publishTeamChangedInTx } from "./teamChanges";
import {
    acquireTeamMutationLockInTx,
    qualifyTeamOperationAuthenticationInTx,
    resolveTeamActorContextInTx,
    type TeamOperationAuthenticationContext,
} from "./actorContext";
import { toTeamViewer } from "./viewer";
import { applyTeamSessionAuthenticationContextEffectsInTx } from "./memberships/sessionAccessEffects";
import { resolveTeamAdmissionModeApplicabilityInTx } from "./identity/teamAdmissionModeApplicability";
import { authorizeTeamGroupDefaultsInTx } from "./groups/groupService";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { resolveEffectiveMachineAccessForMachinesInTx } from "@/app/machines/machineAccess";

/**
 * Team policy and managed Session defaults, with named downstream consumers.
 *
 * Each field records intent that its own canonical owner enforces. Nothing here
 * evaluates Session access, rewrites existing grants, or touches membership
 * horizons — a policy edit is prospective by construction, because it only
 * changes the default a future decision reads.
 *
 * Accepted authentication consumes the Lane 03 codec and is independently
 * authorized from the other Team policy fields.
 */

export type TeamPolicyError =
    | "team_not_found"
    | "team_forbidden"
    | "team_archived"
    | "group_not_found"
    | "group_archived"
    | "invalid_team_input"
    | "invalid_team_authentication_policy"
    | "team_authentication_policy_conflict"
    | "team_authentication_policy_unavailable"
    | "team_authentication_unavailable"
    | "team_authentication_required"
    | "teams_unavailable";

export type TeamPolicyResult =
    | Readonly<{ ok: true; team: TeamSummaryV1 }>
    | Readonly<{
        ok: false;
        error: TeamPolicyError;
        details?: TeamAuthenticationPolicyUnavailableDetailsV1;
    }>;

export type SetTeamPolicyInput = Readonly<{
    actorAccountId: string;
    teamId: string;
    env?: NodeJS.ProcessEnv;
    sessionCreationPolicy?: TeamSessionCreationPolicy;
    externalSharingPolicy?: TeamExternalSharingPolicy;
    defaultSessionHistoryAccess?: SessionHistoryAccess;
    admissionMode?: TeamAdmissionMode;
    previousAuthenticationPolicy?: TeamAuthenticationPolicyComparisonBasisV1;
    authenticationPolicy?: TeamAuthenticationPolicyV1 | null;
    managedDefaults?: ManagedDefaultsV1 | null;
    managedGroupDefaults?: Readonly<{ teamGroupId: string; defaults: ManagedSessionDefaultsV1 | null }>;
    authentication?: TeamOperationAuthenticationContext;
}>;

type StoredAuthenticationPolicy =
    | Readonly<{ status: "available"; policy: TeamRestrictedAuthenticationPolicyV1 | null }>
    | Readonly<{ status: "repair_required" }>;

function readCanonicalAuthenticationPolicy(value: unknown): StoredAuthenticationPolicy {
    if (value === null) return { status: "available", policy: null };
    const parsed = TeamAuthenticationPolicyV1Schema.safeParse(value);
    return parsed.success
        ? { status: "available", policy: normalizeTeamAuthenticationPolicyV1(parsed.data) }
        : { status: "repair_required" };
}

function sameAuthenticationPolicy(
    left: StoredAuthenticationPolicy,
    right: TeamAuthenticationPolicyComparisonBasisV1,
): boolean {
    if (left.status === "repair_required") {
        return right !== null && "status" in right && right.status === "repair_required";
    }
    if (right !== null && "status" in right) return false;
    const normalizedRight = right === null ? null : normalizeTeamAuthenticationPolicyV1(right);
    return JSON.stringify(left.policy) === JSON.stringify(normalizedRight);
}

type TeamPolicyPatch = Pick<SetTeamPolicyInput,
    | "sessionCreationPolicy"
    | "externalSharingPolicy"
    | "defaultSessionHistoryAccess"
    | "admissionMode"
    | "authenticationPolicy"
    | "managedDefaults"
    | "managedGroupDefaults"
>;

/** Managed Machine defaults are prospective, but their target must be usable by
 * every member receiving the layer. This is the same Machine access owner used
 * by Session admission, so Action/MCP writes cannot bypass the picker rule. */
async function managedPlacementAudienceInTx(tx: Tx, teamId: string, placement: ManagedSessionPlacementV1 | undefined,
    groupId?: string): Promise<boolean> {
    if (!placement || placement.kind !== "machine") return true;
    const memberships = groupId
        ? await tx.teamGroupMembership.findMany({
            where: { teamGroupId: groupId, teamMembership: { status: TeamMembershipStatus.active,
                account: { status: AccountStatus.active } } },
            select: { teamMembership: { select: { accountId: true } } },
        })
        : await tx.teamMembership.findMany({
            where: { teamId, status: TeamMembershipStatus.active, account: { status: AccountStatus.active } },
            select: { accountId: true },
        });
    const accountIds = memberships.map(member => "teamMembership" in member ? member.teamMembership.accountId : member.accountId);
    if (accountIds.length === 0) return true;
    const access = await resolveEffectiveMachineAccessForMachinesInTx(tx, {
        machineIds: [placement.target.machineId], accountIds,
    });
    return accountIds.every(accountId => access.get(placement.target.machineId)?.get(accountId) !== null);
}

async function managedDefaultsAreMemberUsableInTx(tx: Tx, teamId: string, defaults: ManagedDefaultsV1): Promise<boolean> {
    if (!await managedPlacementAudienceInTx(tx, teamId, defaults.team.placement)) return false;
    for (const [groupId, groupDefaults] of Object.entries(defaults.groups)) {
        if (!await managedPlacementAudienceInTx(tx, teamId, groupDefaults.placement, groupId)) return false;
    }
    return true;
}

/** Every changed field is authorized before any field is written. */
export function authorizeTeamPolicyPatch(
    capabilities: TeamCapabilitiesV1,
    patch: TeamPolicyPatch,
): boolean {
    const changesSessionPolicy = patch.sessionCreationPolicy !== undefined
        || patch.externalSharingPolicy !== undefined
        || patch.defaultSessionHistoryAccess !== undefined;
    const changesAuthentication = patch.admissionMode !== undefined
        || patch.authenticationPolicy !== undefined;
    return (!changesSessionPolicy || capabilities.managePolicy)
        && (!changesAuthentication || capabilities.manageAuthentication)
        && (patch.managedDefaults === undefined || capabilities.manageSettings)
        && (patch.managedGroupDefaults === undefined || capabilities.manageGroups);
}

export async function setTeamPolicyInTx(tx: Tx, input: SetTeamPolicyInput): Promise<TeamPolicyResult> {
    const recheckAdmission = await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: input.teamId, accountIds: [input.actorAccountId],
        ...(input.authenticationPolicy !== undefined ? { intent: "exclusive" as const,
            membershipChange: { kind: "teamMembership" as const, teamId: input.teamId } } : {}) });
    await acquireTeamMutationLockInTx(tx, input.teamId);
    await recheckAdmission();
    if (!await isServerFeatureEnabledForHome("teams", { tx, env: input.env })) {
        return { ok: false, error: "teams_unavailable" };
    }
    const context = await resolveTeamActorContextInTx(tx, {
        teamId: input.teamId,
        actorAccountId: input.actorAccountId,
    });
    const viewer = toTeamViewer(context);
    if (viewer === null) return { ok: false, error: "team_not_found" };

    const changesAuthenticationPolicy = input.authenticationPolicy !== undefined;
    if (!authorizeTeamPolicyPatch(context!.capabilities, input)) {
        // "Archived" is only the honest reason for someone who would otherwise
        // hold the capability. Home administration never confers `managePolicy`,
        // so an administrator is refused as forbidden on an archived Team too.
        const administersTeam = viewer.viewerRole === TeamRole.owner || viewer.viewerRole === TeamRole.admin;
        const archived = viewer.team.archivedAt !== null;
        return { ok: false, error: archived && administersTeam ? "team_archived" : "team_forbidden" };
    }

    if (input.managedDefaults !== undefined && input.managedGroupDefaults !== undefined) {
        return { ok: false, error: "invalid_team_input" };
    }
    const current = readCanonicalAuthenticationPolicy(viewer.team.authenticationPolicy);
    if (changesAuthenticationPolicy) {
        if (input.previousAuthenticationPolicy === undefined
            || !sameAuthenticationPolicy(current, input.previousAuthenticationPolicy)) {
            return { ok: false, error: "team_authentication_policy_conflict" };
        }
    }

    // Every direct policy mutation qualifies against the policy already
    // protecting the Team. Malformed persisted policy has no credential a user
    // could prove, so this bounded policy-administration surface remains the one
    // explicit repair exception; it still requires the normal policy capability,
    // and authentication-policy replacement additionally requires the observed
    // repair comparison basis checked above.
    const isAuthenticationPolicyRepairOnly = current.status === "repair_required"
        && changesAuthenticationPolicy
        && input.sessionCreationPolicy === undefined
        && input.externalSharingPolicy === undefined
        && input.defaultSessionHistoryAccess === undefined
        && input.managedDefaults === undefined
        && input.managedGroupDefaults === undefined
        && input.admissionMode === undefined;
    const qualification = await qualifyTeamOperationAuthenticationInTx(tx, {
        context: context!,
        env: input.env,
        ...input.authentication,
        ...(isAuthenticationPolicyRepairOnly
            ? { allowMalformedAuthenticationPolicyRepair: true }
            : {}),
    });
    if (!qualification.ok) return qualification;

    let managedDefaults = input.managedDefaults;
    if (input.managedGroupDefaults !== undefined) {
        const error = await authorizeTeamGroupDefaultsInTx(tx, {
            context: context!, teamGroupId: input.managedGroupDefaults.teamGroupId,
        });
        if (error) return { ok: false, error };
        const stored = readManagedDefaultsV1(viewer.team.managedDefaults ?? null);
        // A scoped Group edit cannot discard malformed Team or sibling data.
        // A settings administrator repairs the complete document explicitly.
        if (stored.status === "repair_required") return { ok: false, error: "invalid_team_input" };
        const groups = { ...stored.defaults?.groups };
        if (input.managedGroupDefaults.defaults === null) delete groups[input.managedGroupDefaults.teamGroupId];
        else groups[input.managedGroupDefaults.teamGroupId] = input.managedGroupDefaults.defaults;
        managedDefaults = { team: stored.defaults?.team ?? {}, groups };
    } else if (managedDefaults !== undefined && managedDefaults !== null) {
        const groupIds = Object.keys(managedDefaults.groups);
        const groups = (await Promise.all(portableQueryChunks({ values: groupIds, bindingsPerValue: 1, fixedBindings: 2 })
            .map(ids => tx.teamGroup.findMany({
                where: { id: { in: [...ids] }, teamId: input.teamId }, select: { id: true, archivedAt: true },
            })))).flat();
        if (groups.length !== groupIds.length) return { ok: false, error: "group_not_found" };
        const stored = readManagedDefaultsV1(viewer.team.managedDefaults ?? null);
        for (const group of groups) {
            // A full Team save may carry a retained preference for restoration;
            // an archived Group still cannot receive a changed preference.
            if (group.archivedAt !== null && !sameStrictJsonValue(
                stored.defaults?.groups[group.id], managedDefaults.groups[group.id],
            )) return { ok: false, error: "group_archived" };
        }
    }
    if (managedDefaults !== undefined && managedDefaults !== null
        && !await managedDefaultsAreMemberUsableInTx(tx, input.teamId, managedDefaults)) {
        return { ok: false, error: "invalid_team_input" };
    }

    if (input.admissionMode !== undefined) {
        const applicability = await resolveTeamAdmissionModeApplicabilityInTx({
            tx,
            env: input.env ?? process.env,
            teamId: input.teamId,
        });
        if (applicability.modes[input.admissionMode].status !== "available") {
            return { ok: false, error: "team_authentication_policy_unavailable" };
        }
    }

    if (input.authenticationPolicy?.mode === "restricted") {
        const resolved = await resolveTeamAuthenticationPolicyInTx(tx, {
            env: input.env ?? process.env,
            teamId: input.teamId,
            policy: input.authenticationPolicy,
        });
        if (
            resolved.resolution.status !== "restricted"
            || resolved.resolution.choices.some((choice) => choice.availability === "unavailable")
        ) {
            return { ok: false, error: "team_authentication_policy_unavailable" };
        }
        if (resolved.activationReadiness === "provider_test_required") {
            return {
                ok: false,
                error: "team_authentication_policy_unavailable",
                details: { reason: "provider_test_required" },
            };
        }
        // Catalog applicability and test currentness are proven above. The
        // editor's current credential must also prove one accepted reference,
        // otherwise this mutation could strand every administrator.
        const prospectiveQualification = await qualifyTeamOperationAuthenticationInTx(tx, {
            context: {
                ...context!,
                team: { ...context!.team, authenticationPolicy: input.authenticationPolicy },
            },
            env: input.env,
            ...input.authentication,
        });
        if (!prospectiveQualification.ok) return prospectiveQualification;
    }

    const data = {
        ...(managedDefaults === undefined ? {} : {
            managedDefaults: managedDefaults === null ? getActivePrismaRuntime().DbNull : managedDefaults,
        }),
        ...(input.sessionCreationPolicy === undefined ? {} : { sessionCreationPolicy: input.sessionCreationPolicy }),
        ...(input.externalSharingPolicy === undefined ? {} : { externalSharingPolicy: input.externalSharingPolicy }),
        ...(input.defaultSessionHistoryAccess === undefined
            ? {}
            : { defaultSessionHistoryAccess: input.defaultSessionHistoryAccess }),
        ...(input.admissionMode === undefined ? {} : { admissionMode: input.admissionMode }),
        ...(input.authenticationPolicy === undefined
            ? {}
            : {
                authenticationPolicy: input.authenticationPolicy === null
                    ? getActivePrismaRuntime().DbNull
                    : normalizeTeamAuthenticationPolicyV1(input.authenticationPolicy)
                        ?? getActivePrismaRuntime().DbNull,
            }),
    };
    if (Object.keys(data).length === 0) return { ok: false, error: "invalid_team_input" };

    const updated = await tx.team.update({
        where: { id: input.teamId },
        data,
        select: TEAM_PROJECTION_SELECT,
    });
    await publishTeamChangedInTx(tx, { teamId: input.teamId });
    if (changesAuthenticationPolicy) {
        await applyTeamSessionAuthenticationContextEffectsInTx(tx, { teamIds: [input.teamId] });
    }

    return { ok: true, team: await projectForActorInTx(tx, updated, input.actorAccountId, input.authentication) };
}
