import { resolveTeamMembershipContextInTx, resolveTeamMembershipContextsInTx, type TeamMembershipLifetimeContext } from "../memberships/effectiveMembership";
import { resolveTeamGroupMembershipsForAccountInTx, resolveTeamGroupMembershipsForAccountsInTx, type TeamGroupMembershipLifetimeContext } from "../groups/effectiveGroupMembership";
import type { Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { TEAM_CREDENTIAL_ROUTES_V1, type TeamCredentialRouteV1, type TeamCredentialDeliveryPolicyV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { readTeamCredentialAllowedRoutes, readTeamCredentialDeliveryConfiguration } from './resourceDeliveryRead';
import { isTeamPrincipalRoleV1 } from '@happier-dev/protocol/teams';

export type TeamCredentialMatchedGrant =
    | Readonly<{ kind: "team" }>
    | Readonly<{ kind: "team_group"; teamGroupId: string }>
    | Readonly<{ kind: "team_member"; teamMembershipId: string }>;

export type TeamCredentialEntitlementInput = Readonly<{
    resource: Readonly<{
        id: string;
        teamId: string;
        custodianAccountId: string;
        revision: number;
        enabled: boolean;
        disclosureCeiling: string;
        allMembersDeliveryMode: string | null;
        groupGrants: readonly Readonly<{ teamGroupId: string; deliveryMode: string }>[];
        memberGrants: readonly Readonly<{ teamMembershipId: string; deliveryMode: string }>[];
    }>;
    membership: TeamMembershipLifetimeContext | null;
    custodianMembership: TeamMembershipLifetimeContext | null;
    groupMemberships: readonly TeamGroupMembershipLifetimeContext[];
}>;

export type TeamCredentialEntitlementDecision =
    | Readonly<{
        ok: true;
        resourceId: string;
        resourceRevision: number;
        matchedGrants: readonly TeamCredentialMatchedGrant[];
        deliveryPolicy: TeamCredentialDeliveryPolicyV1;
        allowedRoutes: readonly TeamCredentialRouteV1[];
        mayBroker: boolean;
        mayReceiveDirect: boolean;
    }>
    | Readonly<{ ok: false; reason: "access_removed" | "disabled" | "resource_corrupt" | "source_owner_required" }>;

/** Resolve current database authority in the transaction that admits resource use. */
export async function resolveTeamCredentialEntitlementInTx(
    tx: Tx,
    input: Readonly<{ resourceId: string; accountId: string }>,
): Promise<TeamCredentialEntitlementDecision> {
    const entitlements = await resolveTeamCredentialEntitlementsInTx(tx, {
        resourceId: input.resourceId, accountIds: [input.accountId],
    });
    return entitlements.get(input.accountId)!;
}

/** One current resource and membership fact set, with the existing decision per recipient. */
export async function resolveTeamCredentialEntitlementsInTx(
    tx: Tx,
    input: Readonly<{ resourceId: string; accountIds: readonly string[] }>,
): Promise<Map<string, TeamCredentialEntitlementDecision>> {
    const accountIds = [...new Set(input.accountIds)];
    if (accountIds.length === 0) return new Map();
    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: input.resourceId },
        select: {
            id: true, teamId: true, custodianAccountId: true, revision: true, enabled: true,
            disclosureCeiling: true, allMembersDeliveryMode: true,
            groupGrants: { select: { teamGroupId: true, deliveryMode: true } },
            memberGrants: { select: { teamMembershipId: true, deliveryMode: true } },
        },
    });
    if (!resource) return new Map(accountIds.map(accountId => [accountId, { ok: false, reason: "access_removed" }]));
    const membershipsByAccount = new Map<string, TeamMembershipLifetimeContext>();
    for (const chunk of portableQueryChunks({
        values: [...new Set([...accountIds, resource.custodianAccountId])], bindingsPerValue: 1, fixedBindings: 2,
    })) {
        const memberships = await resolveTeamMembershipContextsInTx(tx, {
            where: { teamId: resource.teamId, accountId: { in: [...chunk] } },
        });
        for (const membership of memberships) membershipsByAccount.set(membership.accountId, membership);
    }
    const effectiveAccountIds = accountIds.filter(accountId => membershipsByAccount.get(accountId)?.effective);
    const groups = resource.groupGrants.length === 0 ? [] : await resolveTeamGroupMembershipsForAccountsInTx(tx, {
        teamId: resource.teamId, credentialResourceId: resource.id, accountIds: effectiveAccountIds,
    });
    const groupsByAccount = new Map<string, TeamGroupMembershipLifetimeContext[]>();
    for (const group of groups) {
        const memberships = groupsByAccount.get(group.accountId) ?? [];
        memberships.push(group);
        groupsByAccount.set(group.accountId, memberships);
    }
    return new Map(accountIds.map(accountId => [accountId, projectTeamCredentialEntitlement({
        resource,
        membership: membershipsByAccount.get(accountId) ?? null,
        custodianMembership: membershipsByAccount.get(resource.custodianAccountId) ?? null,
        groupMemberships: groupsByAccount.get(accountId) ?? [],
    })]));
}

/**
 * Determines only whether a current Team principal is named by an audience.
 * This deliberately does not reinterpret a corrupt grant as usable; it lets
 * the catalog keep an already-authorized row visible as `resource_corrupt`
 * while the entitlement decision itself continues to fail closed.
 */
export async function hasCurrentTeamCredentialAudienceMatchInTx(
    tx: Tx,
    input: Readonly<{ resourceId: string; accountId: string }>,
): Promise<boolean> {
    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: input.resourceId },
        select: {
            teamId: true,
            allMembersDeliveryMode: true,
            groupGrants: { select: { teamGroupId: true } },
            memberGrants: { select: { teamMembershipId: true } },
        },
    });
    if (!resource) return false;
    const membershipRow = await tx.teamMembership.findUnique({
        where: { teamId_accountId: { teamId: resource.teamId, accountId: input.accountId } },
        select: { id: true },
    });
    if (!membershipRow) return false;
    const membershipResult = await resolveTeamMembershipContextInTx(tx, {
        teamId: resource.teamId,
        teamMembershipId: membershipRow.id,
        expectedAccountId: input.accountId,
    });
    if (!membershipResult.ok || !membershipResult.membership.effective) return false;
    if (resource.allMembersDeliveryMode !== null && isTeamPrincipalRoleV1(membershipResult.membership.role)) return true;
    if (resource.memberGrants.some(grant => grant.teamMembershipId === membershipRow.id)) return true;
    const groupMemberships = resource.groupGrants.length === 0 ? [] : await resolveTeamGroupMembershipsForAccountInTx(tx, {
        teamId: resource.teamId, credentialResourceId: input.resourceId, accountId: input.accountId,
    });
    return groupMemberships.some(group => group.effective);
}

/** Current audience entitlement only; source readiness and Session policy remain required. */
export function projectTeamCredentialEntitlement(
    input: TeamCredentialEntitlementInput,
): TeamCredentialEntitlementDecision {
    const { resource, membership, custodianMembership } = input;
    if (!membership?.effective || membership.teamId !== resource.teamId) {
        return { ok: false, reason: "access_removed" };
    }

    const candidates = [
        ...(resource.allMembersDeliveryMode === null ? [] : [{
            source: { kind: "team" } as const,
            mode: resource.allMembersDeliveryMode,
            matches: isTeamPrincipalRoleV1(membership.role),
        }]),
        ...resource.groupGrants.map(grant => ({
            source: { kind: "team_group", teamGroupId: grant.teamGroupId } as const,
            mode: grant.deliveryMode,
            matches: input.groupMemberships.some(group => group.effective
                && group.teamId === resource.teamId
                && group.accountId === membership.accountId
                && group.teamMembershipId === membership.teamMembershipId
                && group.teamGroupId === grant.teamGroupId),
        })),
        ...resource.memberGrants.map(grant => ({
            source: { kind: "team_member", teamMembershipId: grant.teamMembershipId } as const,
            mode: grant.deliveryMode,
            matches: grant.teamMembershipId === membership.teamMembershipId,
        })),
    ];
    // Custodian standing, enablement and the source owner's ceiling are the
    // audience's business. A same-Team caller who matches no grant learns only
    // that they have no access, exactly as the catalog read already decides.
    if (!candidates.some((candidate) => candidate.matches)) {
        return { ok: false, reason: "access_removed" };
    }
    if (!custodianMembership?.effective || custodianMembership.teamId !== resource.teamId
        || custodianMembership.accountId !== resource.custodianAccountId) {
        return { ok: false, reason: "source_owner_required" };
    }
    if (!resource.enabled) return { ok: false, reason: "disabled" };

    const configuration = readTeamCredentialDeliveryConfiguration(resource.disclosureCeiling);
    if (!configuration.success) return { ok: false, reason: "resource_corrupt" };
    const allowed = configuration.data.policy.preferredAllowedModes;

    const matchedGrants: TeamCredentialMatchedGrant[] = [];
    const entitledRoutes = new Set<TeamCredentialRouteV1>();
    for (const candidate of candidates) {
        const routes = readTeamCredentialAllowedRoutes(candidate.mode);
        if (!routes.success || routes.data.some(route => !allowed.includes(route))) {
            return { ok: false, reason: "resource_corrupt" };
        }
        if (!candidate.matches) continue;
        matchedGrants.push(candidate.source);
        for (const route of routes.data) entitledRoutes.add(route);
    }
    return {
        ok: true,
        resourceId: resource.id,
        resourceRevision: resource.revision,
        matchedGrants,
        deliveryPolicy: configuration.data.policy,
        allowedRoutes: TEAM_CREDENTIAL_ROUTES_V1.filter(route => entitledRoutes.has(route)),
        mayBroker: entitledRoutes.has('brokered'),
        mayReceiveDirect: entitledRoutes.has('direct'),
    };
}
