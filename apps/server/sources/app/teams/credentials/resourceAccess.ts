import { resolveTeamMembershipContextsInTx, type TeamMembershipLifetimeContext } from "../memberships/effectiveMembership";
import { resolveTeamGroupMembershipsForAccountsInTx, type TeamGroupMembershipLifetimeContext } from "../groups/effectiveGroupMembership";
import type { Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';
import { TEAM_CREDENTIAL_ROUTES_V1, type TeamCredentialRouteV1, type TeamCredentialDeliveryPolicyV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { readTeamCredentialAllowedRoutes, readTeamCredentialDeliveryConfiguration } from './resourceDeliveryRead';
import { resourceGrantMembershipSqlPredicate, resolveTeamResourceGrantMatchedContributionsFromFacts, type ResourceGrantTeamPrincipal } from '../resourceGrantAccess';

export type TeamCredentialMatchedGrant = ResourceGrantTeamPrincipal;

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

/** Matched audiences retain unavailable source/configuration rows in their catalog. */
export function isTeamCredentialEntitlementCatalogVisible(entitlement: TeamCredentialEntitlementDecision): boolean {
    return entitlement.ok || entitlement.reason === 'resource_corrupt' || entitlement.reason === 'source_owner_required';
}

/** One eligibility projection for recipient pages and scalar metadata counts.
 * Principal arms start at their existing indexes. Custodian withdrawal is tested
 * against the resource's own Team, retaining the same unavailable-source row as
 * projectTeamCredentialEntitlement without expanding one predicate per Team.
 * The caller supplies the resource table as alias `a`.
 */
export function teamCredentialRecipientCatalogSql(input: Readonly<{
    accountId: string; teamIds: readonly string[]; resourceId?: string;
}>): ReturnType<typeof prismaRuntime.sql> {
    const sql = prismaRuntime.sql;
    if (input.teamIds.length === 0) return sql`1 = 0`;
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const identifier = (name: string) => prismaRuntime.raw(provider === 'mysql'
        ? `\`${name.replaceAll('`', '``')}\`` : `"${name.replaceAll('"', '""')}"`);
    const column = (alias: string, name: string) => sql`${identifier(alias)}.${identifier(name)}`;
    const members = identifier('TeamMembership');
    const accounts = identifier('Account');
    const teams = identifier('Team');
    const resources = identifier('TeamCredentialResource');
    const member = resourceGrantMembershipSqlPredicate({ actorAccountId: input.accountId,
        membershipAlias: 'm', accountAlias: 'c', teamAlias: 't', principal: 'member' });
    const teamMember = resourceGrantMembershipSqlPredicate({ actorAccountId: input.accountId,
        membershipAlias: 'm', accountAlias: 'c', teamAlias: 't', principal: 'team' });
    const custodian = resourceGrantMembershipSqlPredicate({ actorAccountId: column('a', 'custodianAccountId'),
        membershipAlias: 'cm', accountAlias: 'cc', teamAlias: 'ct', principal: 'member' });
    return sql`${column('a', 'teamId')} IN (${prismaRuntime.join([...input.teamIds])})
        AND ${column('a', 'custodianAccountId')} <> ${input.accountId}
        ${input.resourceId === undefined ? sql`` : sql`AND ${column('a', 'id')} = ${input.resourceId}`}
        AND (${column('a', 'enabled')} = ${true} OR NOT EXISTS (
            SELECT 1 FROM ${members} cm
            JOIN ${accounts} cc ON ${column('cc', 'id')} = ${column('cm', 'accountId')}
            JOIN ${teams} ct ON ${column('ct', 'id')} = ${column('cm', 'teamId')}
            WHERE ${column('cm', 'teamId')} = ${column('a', 'teamId')} AND ${custodian}
        ))
        AND ${column('a', 'id')} IN (
            SELECT ${column('r', 'id')} FROM ${members} m
            JOIN ${accounts} c ON ${column('c', 'id')} = ${column('m', 'accountId')}
            JOIN ${teams} t ON ${column('t', 'id')} = ${column('m', 'teamId')}
            JOIN ${resources} r ON ${column('r', 'teamId')} = ${column('m', 'teamId')}
            WHERE ${teamMember} AND ${column('r', 'allMembersDeliveryMode')} IS NOT NULL
            UNION ALL
            SELECT ${column('g', 'resourceId')} FROM ${members} m
            JOIN ${accounts} c ON ${column('c', 'id')} = ${column('m', 'accountId')}
            JOIN ${teams} t ON ${column('t', 'id')} = ${column('m', 'teamId')}
            JOIN ${identifier('TeamGroupMembership')} gm ON ${column('gm', 'teamMembershipId')} = ${column('m', 'id')}
                AND ${column('gm', 'teamId')} = ${column('m', 'teamId')}
            JOIN ${identifier('TeamGroup')} gr ON ${column('gr', 'id')} = ${column('gm', 'teamGroupId')}
                AND ${column('gr', 'teamId')} = ${column('m', 'teamId')}
            JOIN ${identifier('TeamCredentialGroupGrant')} g ON ${column('g', 'teamGroupId')} = ${column('gr', 'id')}
            JOIN ${resources} r ON ${column('r', 'id')} = ${column('g', 'resourceId')}
                AND ${column('r', 'teamId')} = ${column('m', 'teamId')}
            WHERE ${member} AND ${column('gr', 'archivedAt')} IS NULL
            UNION ALL
            SELECT ${column('g', 'resourceId')} FROM ${members} m
            JOIN ${accounts} c ON ${column('c', 'id')} = ${column('m', 'accountId')}
            JOIN ${teams} t ON ${column('t', 'id')} = ${column('m', 'teamId')}
            JOIN ${identifier('TeamCredentialMemberGrant')} g ON ${column('g', 'teamMembershipId')} = ${column('m', 'id')}
            JOIN ${resources} r ON ${column('r', 'id')} = ${column('g', 'resourceId')}
                AND ${column('r', 'teamId')} = ${column('m', 'teamId')}
            WHERE ${member}
        )`;
}

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

/** Current audience entitlement only; source readiness and Session policy remain required. */
export function projectTeamCredentialEntitlement(
    input: TeamCredentialEntitlementInput,
): TeamCredentialEntitlementDecision {
    const { resource, custodianMembership } = input;

    const candidates = [
        ...(resource.allMembersDeliveryMode === null ? [] : [{
            source: { kind: "team" } as const,
            mode: resource.allMembersDeliveryMode,
        }]),
        ...resource.groupGrants.map(grant => ({
            source: { kind: "team_group", teamGroupId: grant.teamGroupId } as const,
            mode: grant.deliveryMode,
        })),
        ...resource.memberGrants.map(grant => ({
            source: { kind: "team_member", teamMembershipId: grant.teamMembershipId } as const,
            mode: grant.deliveryMode,
        })),
    ];
    const matched = new Set(resolveTeamResourceGrantMatchedContributionsFromFacts({
        teamId: resource.teamId, membership: input.membership, groupMemberships: input.groupMemberships,
        grants: candidates.map(candidate => ({ principal: candidate.source, contribution: candidate })),
    }));
    // Custodian standing, enablement and the source owner's ceiling are the
    // audience's business. A same-Team caller who matches no grant learns only
    // that they have no access, exactly as the catalog read already decides.
    if (matched.size === 0) {
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
        if (!matched.has(candidate)) continue;
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
