import { isDeepStrictEqual } from 'node:util';
import * as privacyKit from 'privacy-kit';
import type { ResourceAccessLevelV1, ResourceCallerAccessV1, ResourceRecipientKeyEnvelopeInputV1,
    ResourceRecipientKeyEnvelopeCommitResponseV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { isTeamPrincipalRoleV1, TEAM_PRINCIPAL_ROLES_V1, type TeamRoleV1 } from '@happier-dev/protocol/teams';
import { deriveAccountRecipientEnvelopeReadinessFromRow, type AccountRecipientEnvelopeReadiness,
    type AccountRecipientEnvelopeReadinessRow } from '@/app/encryption/accountRecipientEnvelopeReadiness';
import { projectRecipientContentKey, RECIPIENT_READINESS_SELECT, type RecipientReadinessRow } from '@/app/session/encryption/sessionDataKeyRecipientProjection';
import type { Tx } from '@/storage/inTx';
import type { AccountStatus, TeamMembershipStatus } from '@/storage/enums.generated';
import { EFFECTIVE_TEAM_MEMBERSHIP_WHERE, isEffectiveTeamMembership, type TeamMembershipLifetimeContext } from './memberships/effectiveMembership';
import { EFFECTIVE_TEAM_GROUP_MEMBERSHIP_WHERE, isEffectiveTeamGroupMembership, type TeamGroupMembershipLifetimeContext } from './groups/effectiveGroupMembership';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { resolveShareAccountSubjectsInTx, resolveShareSubjectInTx, resolveShareSubjectsInTx, type ShareSubjectError } from './shareEligibility';

type Member = Readonly<{ accountId: string; status: TeamMembershipStatus; account: Readonly<{ status: AccountStatus }> }>;

/** Resource adapters supply current storage facts; links and keys never supply grants. */
export interface ResourceGrantAccessFacts {
    ownerAccountId: string;
    encryptionMode: 'plain' | 'e2ee' | null;
    accountGrants: readonly Readonly<{ accountId: string; accessLevel: ResourceAccessLevelV1; account: Readonly<{ status: AccountStatus }> }>[];
    teamGrants: readonly Readonly<{ teamId?: string; accessLevel: ResourceAccessLevelV1; team: Readonly<{ archivedAt: Date | null; memberships: readonly (Member & { role: TeamRoleV1 })[] }> }>[];
    groupGrants: readonly Readonly<{ teamGroupId?: string; accessLevel: ResourceAccessLevelV1; teamGroup: Readonly<{
        archivedAt: Date | null; team: Readonly<{ archivedAt: Date | null }>;
        memberships: readonly Readonly<{ teamMembership: Member }>[];
    }> }>[];
}

export type ResourceGrantContribution =
    | Readonly<{ kind: 'account'; accountId: string; accessLevel: ResourceAccessLevelV1 }>
    | Readonly<{ kind: 'team'; teamId?: string; accessLevel: ResourceAccessLevelV1 }>
    | Readonly<{ kind: 'group'; teamGroupId?: string; accessLevel: ResourceAccessLevelV1 }>;

export interface ResourceGrantAccess {
    ownerAccountId: string;
    level: ResourceCallerAccessV1;
    encryptionMode: 'plain' | 'e2ee' | null;
}

/** Independent qualifying grants; capability owners must not combine their delegation flags. */
export interface ResourceGrantAccessDecision extends ResourceGrantAccess {
    readonly matchedGrants: readonly ResourceGrantContribution[];
}

export interface ResourceGrantStorageAdapter {
    readAccessFactsBatchInTx(tx: Tx, resourceIds: readonly string[], actorAccountId?: string): Promise<ReadonlyMap<string, ResourceGrantAccessFacts>>;
    readAccessFactsInTx(tx: Tx, resourceId: string, actorAccountId?: string): Promise<ResourceGrantAccessFacts | null>;
}

/** Common relation projection; resource identity and persisted mode remain adapter-owned. */
export function resourceGrantRelationsSelect(actorAccountId?: string) {
    const accountFilter = actorAccountId === undefined ? {} : { accountId: actorAccountId };
    return { grants: {
        ...(actorAccountId === undefined ? {} : { where: { OR: [
            { accountId: actorAccountId }, { teamId: { not: null } }, { teamGroupId: { not: null } },
        ] } }),
        select: { id: true, principalKind: true, accountId: true, teamId: true, teamGroupId: true, accessLevel: true,
            account: { select: { status: true } },
            team: { select: { archivedAt: true, memberships: { where: accountFilter, select: {
                accountId: true, status: true, role: true, account: { select: { status: true } },
            } } } },
            teamGroup: { select: { archivedAt: true, team: { select: { archivedAt: true } },
                memberships: { where: { teamMembership: accountFilter }, select: { teamMembership: {
                    select: { accountId: true, status: true, account: { select: { status: true } } },
                } } },
            } },
        },
    } } as const;
}

/** The persisted principal constraint owns non-nullability; this projects its typed arms once. */
export function projectResourceGrantRows<T extends Readonly<{
    principalKind: string; accountId: string | null; teamId: string | null; teamGroupId: string | null;
    account?: unknown; team?: unknown; teamGroup?: unknown;
}>>(grants: readonly T[]) {
    return {
        accountGrants: grants.flatMap(grant => grant.principalKind === 'account'
            ? [{ ...grant, accountId: grant.accountId!, account: grant.account! as NonNullable<T['account']> }] : []),
        teamGrants: grants.flatMap(grant => grant.principalKind === 'team'
            ? [{ ...grant, teamId: grant.teamId!, team: grant.team! as NonNullable<T['team']> }] : []),
        groupGrants: grants.flatMap(grant => grant.principalKind === 'group'
            ? [{ ...grant, teamGroupId: grant.teamGroupId!, teamGroup: grant.teamGroup! as NonNullable<T['teamGroup']> }] : []),
    };
}

/** Lifecycle facts are supplied by the existing membership owners; grant matching lives here. */
export type ResourceGrantPrincipalFacts =
    | Readonly<{ kind: 'account'; accountId: string; active: boolean }>
    | Readonly<{ kind: 'team'; memberships: readonly Pick<TeamMembershipLifetimeContext, 'accountId' | 'role' | 'effective'>[] }>
    | Readonly<{ kind: 'group'; memberships: readonly Pick<TeamGroupMembershipLifetimeContext, 'accountId' | 'effective'>[] }>
    | Readonly<{ kind: 'team_member'; teamMembershipId: string;
        membership: Pick<TeamMembershipLifetimeContext, 'accountId' | 'teamMembershipId' | 'effective'> | null }>;

/** One principal policy for per-actor admission and linear recipient census. */
export function* iterateResourceGrantPrincipalAccountIdsFromFacts(principal: ResourceGrantPrincipalFacts): IterableIterator<string> {
    switch (principal.kind) {
        case 'account':
            if (principal.active) yield principal.accountId;
            break;
        case 'team_member':
            if (principal.membership?.effective && principal.membership.teamMembershipId === principal.teamMembershipId) {
                yield principal.membership.accountId;
            }
            break;
        case 'team':
            for (const member of principal.memberships) {
                if (member.effective && isTeamPrincipalRoleV1(member.role)) yield member.accountId;
            }
            break;
        case 'group':
            for (const member of principal.memberships) {
                if (member.effective) yield member.accountId;
            }
            break;
    }
}

/** Return each qualifying contribution independently; domains retain their capability semantics. */
export function resolveResourceGrantMatchedContributionsFromFacts<T>(
    grants: readonly Readonly<{ principal: ResourceGrantPrincipalFacts; contribution: T }>[], actorAccountId: string,
): T[] {
    return grants.flatMap(({ principal, contribution }) => {
        for (const accountId of iterateResourceGrantPrincipalAccountIdsFromFacts(principal)) {
            if (accountId === actorAccountId) return [contribution];
        }
        return [];
    });
}

export type ResourceGrantTeamPrincipal =
    | Readonly<{ kind: 'team' }>
    | Readonly<{ kind: 'team_group'; teamGroupId: string }>
    | Readonly<{ kind: 'team_member'; teamMembershipId: string }>;

/** Scoped Team resources retain exact membership lifetimes, unlike ordinary Account grants. */
export function resolveTeamResourceGrantMatchedContributionsFromFacts<T>(input: Readonly<{
    teamId: string;
    membership: TeamMembershipLifetimeContext | null;
    groupMemberships: readonly TeamGroupMembershipLifetimeContext[];
    grants: readonly Readonly<{ principal: ResourceGrantTeamPrincipal; contribution: T }>[];
}>): T[] {
    const membership = input.membership;
    if (!membership || membership.teamId !== input.teamId) return [];
    const grants = input.grants.map(({ principal, contribution }): Readonly<{ principal: ResourceGrantPrincipalFacts; contribution: T }> => {
        if (principal.kind === 'team') return { principal: { kind: 'team', memberships: [membership] }, contribution };
        if (principal.kind === 'team_member') return { principal: { ...principal, membership }, contribution };
        return { principal: { kind: 'group', memberships: input.groupMemberships.map(group => ({
            accountId: group.accountId,
            effective: membership.effective && group.effective && group.teamId === input.teamId
                && group.teamGroupId === principal.teamGroupId && group.teamMembershipId === membership.teamMembershipId,
        })) }, contribution };
    });
    return resolveResourceGrantMatchedContributionsFromFacts(grants, membership.accountId);
}

const accessRank = { view: 1, edit: 2, admin: 3, owner: 4 } as const;

function hasEffectiveTeamGrant(grant: ResourceGrantAccessFacts['teamGrants'][number], actorAccountId: string): boolean {
    return resolveResourceGrantMatchedContributionsFromFacts([{
        principal: { kind: 'team', memberships: grant.team.memberships.map(member => ({
            ...member, effective: isEffectiveTeamMembership({ accountStatus: member.account.status,
                membershipStatus: member.status, teamArchivedAt: grant.team.archivedAt }),
        })) }, contribution: true,
    }], actorAccountId).length > 0;
}

/** The caller's direct Team audience, using the same membership policy as access admission. */
export function resolveResourceGrantTeamIdsFromFacts(row: ResourceGrantAccessFacts, actorAccountId: string): string[] {
    return row.teamGrants.flatMap(grant => grant.teamId !== undefined && hasEffectiveTeamGrant(grant, actorAccountId) ? [grant.teamId] : []);
}

/** Database projection of the same grant policy below, for candidate lists and aggregate counts.
 * The actor and lifecycle predicates must match the SAME membership row.
 * Resource adapters still own visibility and final private-content admission.
 */
export function resourceGrantArmWheres(actorAccountId: string, sharedWithTeamId?: string) {
    const member = { ...EFFECTIVE_TEAM_MEMBERSHIP_WHERE, accountId: actorAccountId };
    return {
        account: { accountId: actorAccountId, account: { status: 'active' as const } },
        team: { ...(sharedWithTeamId === undefined ? {} : { teamId: sharedWithTeamId }),
            team: { memberships: { some: { ...member, role: { in: [...TEAM_PRINCIPAL_ROLES_V1] } } } } },
        group: { teamGroup: { ...(sharedWithTeamId === undefined ? {} : { teamId: sharedWithTeamId }),
            memberships: { some: { ...EFFECTIVE_TEAM_GROUP_MEMBERSHIP_WHERE, teamMembership: member } } } },
    };
}

export type ResourceGrantPrincipalArm = 'account' | 'team' | 'group';

/**
 * The same grant policy for ordered candidate pages and their counts, as separately
 * index-servable arms. A grant sublink inside the access OR cannot use any resource
 * index (PostgreSQL scanned every Account's resources), and materializing every
 * granted id into `id IN (…)` made each page read and re-bind the caller's whole
 * received inventory (and exceeded SQLite's bind limit at 1,000 shares). Instead the
 * owner index is one arm and each grant principal is one semi-join arm, read through
 * its principal index. Received arms exclude the caller's own resources, so they are
 * disjoint from `owned`; they may overlap each other. Callers apply their selection,
 * keyset and LIMIT to every arm and merge (`mergeResourceGrantArmPages`). Resource
 * adapters still own visibility and final private-content admission.
 */
export function resourceGrantPageAccessArms<Where extends object>(actorAccountId: string,
    grantedThrough: (arm: ResourceGrantPrincipalArm, grantWhere: ReturnType<typeof resourceGrantArmWheres>[ResourceGrantPrincipalArm]) => Where,
    sharedWithTeamId?: string): Readonly<{ owned: Readonly<{ accountId: string }>; received: readonly (Where & Readonly<{ accountId: { not: string } }>)[] }> {
    const grants = resourceGrantArmWheres(actorAccountId, sharedWithTeamId);
    return { owned: { accountId: actorAccountId }, received: (['account', 'team', 'group'] as const).map(arm =>
        ({ accountId: { not: actorAccountId }, ...grantedThrough(arm, grants[arm]) })) };
}

/** The first `limit` rows of the union lie within the union of each arm's first `limit` rows. */
export function mergeResourceGrantArmPages<Row extends Readonly<{ id: string }>>(pages: readonly (readonly Row[])[],
    compare: (left: Row, right: Row) => number, limit?: number): Row[] {
    const merged = [...new Map(pages.flat().map(row => [row.id, row])).values()].sort(compare);
    return limit === undefined ? merged : merged.slice(0, limit);
}

/** SQL projection of the effective-membership owner, shared by resource adapters. */
export function resourceGrantMembershipSqlPredicate(input: Readonly<{
    actorAccountId: string | ReturnType<typeof prismaRuntime.sql>;
    membershipAlias: string; accountAlias: string; teamAlias: string;
    principal: 'team' | 'member';
}>): ReturnType<typeof prismaRuntime.sql> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const sql = prismaRuntime.sql;
    const identifier = (name: string) => prismaRuntime.raw(provider === 'mysql'
        ? `\`${name.replaceAll('`', '``')}\`` : `"${name.replaceAll('"', '""')}"`);
    const column = (alias: string, name: string) => sql`${identifier(alias)}.${identifier(name)}`;
    const status = (value: AccountStatus | TeamMembershipStatus, enumName: 'AccountStatus' | 'TeamMembershipStatus') =>
        provider === 'postgres' || provider === 'pglite' ? sql`CAST(${value} AS ${identifier(enumName)})` : sql`${value}`;
    const member = EFFECTIVE_TEAM_MEMBERSHIP_WHERE;
    const membership = sql`${column(input.membershipAlias, 'accountId')} = ${input.actorAccountId}
        AND ${column(input.membershipAlias, 'status')} = ${status(member.status, 'TeamMembershipStatus')}
        AND ${column(input.accountAlias, 'status')} = ${status(member.account.status, 'AccountStatus')}
        AND ${column(input.teamAlias, 'archivedAt')} IS NULL`;
    if (input.principal === 'member') return membership;
    const roles = prismaRuntime.join(TEAM_PRINCIPAL_ROLES_V1.map(role =>
        provider === 'postgres' || provider === 'pglite' ? sql`CAST(${role} AS ${identifier('TeamRole')})` : sql`${role}`));
    return sql`${membership} AND ${column(input.membershipAlias, 'role')} IN (${roles})`;
}

/** SQL projection for bounded candidate queries that Prisma cannot express.
 * The resource adapter supplies its table names; `a` is the resource alias.
 * Readers still re-admit the captured content through the ordinary access owner.
 */
export function resourceGrantAccessSqlPredicate(input: Readonly<{
    actorAccountId: string; resourceTablePrefix: string; resourceIdColumn: string;
}>): ReturnType<typeof prismaRuntime.sql> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const mysql = provider === 'mysql';
    const sql = prismaRuntime.sql;
    const identifier = (name: string) => prismaRuntime.raw(mysql
        ? `\`${name.replaceAll('`', '``')}\`` : `"${name.replaceAll('"', '""')}"`);
    const column = (alias: string, name: string) => sql`${identifier(alias)}.${identifier(name)}`;
    const account = identifier('Account');
    const team = identifier('Team');
    const membership = identifier('TeamMembership');
    const member = EFFECTIVE_TEAM_MEMBERSHIP_WHERE;
    // PostgreSQL enum columns do not compare to Prisma's text parameters.
    const status = (value: AccountStatus | TeamMembershipStatus, enumName: 'AccountStatus' | 'TeamMembershipStatus') =>
        provider === 'postgres' || provider === 'pglite' ? sql`CAST(${value} AS ${identifier(enumName)})` : sql`${value}`;
    const activeAccount = status(member.account.status, 'AccountStatus');
    const actor = input.actorAccountId;
    const resourceId = column('a', 'id');
    const memberMatches = resourceGrantMembershipSqlPredicate({ actorAccountId: actor,
        membershipAlias: 'm', accountAlias: 'c', teamAlias: 't', principal: 'member' });
    const teamMemberMatches = resourceGrantMembershipSqlPredicate({ actorAccountId: actor,
        membershipAlias: 'm', accountAlias: 'c', teamAlias: 't', principal: 'team' });
    return sql`(${column('a', 'accountId')} = ${actor}
        OR EXISTS (SELECT 1 FROM ${identifier(`${input.resourceTablePrefix}Grant`)} g
            JOIN ${account} c ON ${column('c', 'id')} = ${column('g', 'accountId')}
            WHERE ${column('g', input.resourceIdColumn)} = ${resourceId}
            AND ${column('g', 'accountId')} = ${actor} AND ${column('c', 'status')} = ${activeAccount})
        OR EXISTS (SELECT 1 FROM ${identifier(`${input.resourceTablePrefix}Grant`)} g
            JOIN ${membership} m ON ${column('m', 'teamId')} = ${column('g', 'teamId')}
            JOIN ${account} c ON ${column('c', 'id')} = ${column('m', 'accountId')}
            JOIN ${team} t ON ${column('t', 'id')} = ${column('m', 'teamId')}
            WHERE ${column('g', input.resourceIdColumn)} = ${resourceId} AND ${teamMemberMatches})
        OR EXISTS (SELECT 1 FROM ${identifier(`${input.resourceTablePrefix}Grant`)} g
            JOIN ${identifier('TeamGroup')} r ON ${column('r', 'id')} = ${column('g', 'teamGroupId')}
            JOIN ${identifier('TeamGroupMembership')} gm ON ${column('gm', 'teamGroupId')} = ${column('r', 'id')}
                AND ${column('gm', 'teamId')} = ${column('r', 'teamId')}
            JOIN ${membership} m ON ${column('m', 'id')} = ${column('gm', 'teamMembershipId')}
                AND ${column('m', 'teamId')} = ${column('gm', 'teamId')}
            JOIN ${account} c ON ${column('c', 'id')} = ${column('m', 'accountId')}
            JOIN ${team} t ON ${column('t', 'id')} = ${column('m', 'teamId')}
            WHERE ${column('g', input.resourceIdColumn)} = ${resourceId}
            AND ${column('r', 'archivedAt')} IS NULL AND ${memberMatches}))`;
}

function resourceGrantPrincipalContributionsFromFacts(row: ResourceGrantAccessFacts): Readonly<{
    principal: ResourceGrantPrincipalFacts; contribution: ResourceGrantContribution;
}>[] {
    return [
        ...row.accountGrants.map(grant => ({ principal: { kind: 'account' as const, accountId: grant.accountId,
            active: grant.account.status === 'active' }, contribution: { kind: 'account' as const, accountId: grant.accountId, accessLevel: grant.accessLevel } })),
        ...row.teamGrants.map(grant => ({ principal: { kind: 'team' as const, memberships: grant.team.memberships.map(member => ({
            ...member, effective: isEffectiveTeamMembership({ accountStatus: member.account.status,
                membershipStatus: member.status, teamArchivedAt: grant.team.archivedAt }),
        })) }, contribution: { kind: 'team' as const, ...(grant.teamId !== undefined ? { teamId: grant.teamId } : {}), accessLevel: grant.accessLevel } })),
        ...row.groupGrants.map(grant => ({ principal: { kind: 'group' as const, memberships: grant.teamGroup.memberships.map(({ teamMembership: member }) => ({
            accountId: member.accountId, effective: isEffectiveTeamGroupMembership({ accountStatus: member.account.status,
                membershipStatus: member.status, teamArchivedAt: grant.teamGroup.team.archivedAt,
                groupArchivedAt: grant.teamGroup.archivedAt }),
        })) }, contribution: { kind: 'group' as const, ...(grant.teamGroupId !== undefined ? { teamGroupId: grant.teamGroupId } : {}), accessLevel: grant.accessLevel } })),
    ];
}

/** Ownership or the highest live direct/Team/Group grant, independent of key readiness. */
export function resolveResourceGrantAccessFromFacts(row: ResourceGrantAccessFacts, actorAccountId: string): ResourceGrantAccessDecision | null {
    const access = { ownerAccountId: row.ownerAccountId, encryptionMode: row.encryptionMode };
    if (row.ownerAccountId === actorAccountId) return { ...access, level: 'owner', matchedGrants: [] };
    let level: ResourceCallerAccessV1 | null = null;
    const include = (candidate: ResourceAccessLevelV1) => {
        if (level === null || accessRank[candidate] > accessRank[level]) level = candidate;
    };
    const matchedGrants = resolveResourceGrantMatchedContributionsFromFacts(resourceGrantPrincipalContributionsFromFacts(row), actorAccountId);
    for (const candidate of matchedGrants) include(candidate.accessLevel);
    return level === null ? null : { ...access, level, matchedGrants };
}

export function resolveResourceGrantAudienceFromFacts(row: ResourceGrantAccessFacts): string[] {
    const audience = new Set([row.ownerAccountId]);
    for (const grant of resourceGrantPrincipalContributionsFromFacts(row)) {
        for (const accountId of iterateResourceGrantPrincipalAccountIdsFromFacts(grant.principal)) audience.add(accountId);
    }
    return [...audience].sort();
}

/** One membership census for requested Principals; resource ownership is not membership. */
export function resolveResourceGrantPrincipalAudiencesFromFacts(row: ResourceGrantAccessFacts, principals: readonly PrincipalRefV1[]): readonly string[][] {
    const audiences = new Map<string, string[]>();
    for (const grant of resourceGrantPrincipalContributionsFromFacts(row)) {
        const contribution = grant.contribution;
        const id = contribution.kind === 'account' ? contribution.accountId
            : contribution.kind === 'team' ? contribution.teamId : contribution.teamGroupId;
        audiences.set(JSON.stringify([contribution.kind, id]), [...new Set(iterateResourceGrantPrincipalAccountIdsFromFacts(grant.principal))].sort());
    }
    return principals.map(principal => audiences.get(JSON.stringify([principal.kind,
        principal.kind === 'account' ? principal.accountId : principal.kind === 'team' ? principal.teamId : principal.groupId])) ?? []);
}

/** One storage snapshot and one decision per distinct resource in this admission. */
export async function resolveResourceGrantAccessBatchInTx(tx: Tx, adapter: ResourceGrantStorageAdapter,
    input: Readonly<{ resourceIds: readonly string[]; actorAccountId: string }>): Promise<readonly (ResourceGrantAccessDecision | null)[]> {
    const ids = [...new Set(input.resourceIds)];
    if (ids.length === 0) return [];
    const facts = await adapter.readAccessFactsBatchInTx(tx, ids, input.actorAccountId);
    const decisions = new Map(ids.map(id => {
        const row = facts.get(id);
        return [id, row ? resolveResourceGrantAccessFromFacts(row, input.actorAccountId) : null] as const;
    }));
    return input.resourceIds.map(id => decisions.get(id) ?? null);
}

export async function resolveResourceGrantAccessInTx(tx: Tx, adapter: ResourceGrantStorageAdapter,
    input: Readonly<{ resourceId: string; actorAccountId: string }>): Promise<ResourceGrantAccessDecision | null> {
    return (await resolveResourceGrantAccessBatchInTx(tx, adapter, {
        resourceIds: [input.resourceId], actorAccountId: input.actorAccountId,
    }))[0] ?? null;
}

export async function resolveResourceGrantAudienceInTx(tx: Tx, adapter: ResourceGrantStorageAdapter, resourceId: string): Promise<string[]> {
    const row = await adapter.readAccessFactsInTx(tx, resourceId);
    return row ? resolveResourceGrantAudienceFromFacts(row) : [];
}

/** Facts for grants that are not stored in a grant table (a prospective grant, or an
 * in-memory audience such as a Service preview share), read through the same relations. */
export async function readResourceGrantPrincipalFactsInTx(tx: Tx, input: Readonly<{
    ownerAccountId: string; principals: readonly PrincipalRefV1[]; actorAccountId?: string;
}>): Promise<ResourceGrantAccessFacts> {
    const relations = resourceGrantRelationsSelect(input.actorAccountId);
    const accountGrants: ResourceGrantAccessFacts['accountGrants'][number][] = [];
    const teamGrants: ResourceGrantAccessFacts['teamGrants'][number][] = [];
    const groupGrants: ResourceGrantAccessFacts['groupGrants'][number][] = [];
    const accountIds = [...new Set(input.principals.flatMap(principal => principal.kind === 'account'
        && (input.actorAccountId === undefined || principal.accountId === input.actorAccountId) ? [principal.accountId] : []))];
    const teamIds = [...new Set(input.principals.flatMap(principal => principal.kind === 'team' ? [principal.teamId] : []))];
    const groupIds = [...new Set(input.principals.flatMap(principal => principal.kind === 'group' ? [principal.groupId] : []))];
    const [accounts, teams, groups] = await Promise.all([
        Promise.all(portableQueryChunks({ values: accountIds, bindingsPerValue: 1 }).map(ids =>
            tx.account.findMany({ where: { id: { in: [...ids] } }, select: { id: true, status: true } }))).then(rows => rows.flat()),
        Promise.all(portableQueryChunks({ values: teamIds, bindingsPerValue: 1, fixedBindings: input.actorAccountId === undefined ? 0 : 1 }).map(ids =>
            tx.team.findMany({ where: { id: { in: [...ids] } }, select: { id: true, ...relations.grants.select.team.select } }))).then(rows => rows.flat()),
        Promise.all(portableQueryChunks({ values: groupIds, bindingsPerValue: 1, fixedBindings: input.actorAccountId === undefined ? 0 : 1 }).map(ids =>
            tx.teamGroup.findMany({ where: { id: { in: [...ids] } },
                select: { id: true, ...relations.grants.select.teamGroup.select, teamId: true } }))).then(rows => rows.flat()),
    ]);
    const accountsById = new Map(accounts.map(account => [account.id, account]));
    const teamsById = new Map(teams.map(team => [team.id, team]));
    const groupsById = new Map(groups.map(group => [group.id, group]));
    for (const principal of input.principals) {
        if (principal.kind === 'account') {
            const account = accountsById.get(principal.accountId);
            if (account) accountGrants.push({ accountId: principal.accountId, accessLevel: 'view', account });
        } else if (principal.kind === 'team') {
            const team = teamsById.get(principal.teamId);
            if (team) teamGrants.push({ teamId: principal.teamId, accessLevel: 'view', team });
        } else {
            const group = groupsById.get(principal.groupId);
            if (group?.teamId === principal.teamId) groupGrants.push({ teamGroupId: principal.groupId, accessLevel: 'view', teamGroup: group });
        }
    }
    return { ownerAccountId: input.ownerAccountId, encryptionMode: null, accountGrants, teamGrants, groupGrants };
}

/** For an admitted review, compare audiences through the same effective-membership owner as access. */
export async function resolveResourceGrantMissingAudienceInTx(tx: Tx,
    input: Readonly<{ facts: ResourceGrantAccessFacts; requestedAudience: readonly PrincipalRefV1[] }>,
): Promise<PrincipalRefV1[]> {
    const covered = new Set(resolveResourceGrantAudienceFromFacts(input.facts));
    const requested = await readResourceGrantPrincipalFactsInTx(tx, {
        ownerAccountId: input.facts.ownerAccountId, principals: input.requestedAudience,
    });
    const accounts = new Map(requested.accountGrants.map(row => [row.accountId, row]));
    const teams = new Map(requested.teamGrants.map(row => [row.teamId, row]));
    const groups = new Map(requested.groupGrants.map(row => [row.teamGroupId, row]));
    return input.requestedAudience.filter(principal => {
        const account = principal.kind === 'account' ? accounts.get(principal.accountId) : undefined;
        const team = principal.kind === 'team' ? teams.get(principal.teamId) : undefined;
        const group = principal.kind === 'group' ? groups.get(principal.groupId) : undefined;
        const facts = { ...requested,
            accountGrants: account ? [account] : [],
            teamGrants: team ? [team] : [],
            groupGrants: group ? [group] : [],
        };
        return resolveResourceGrantAudienceFromFacts(facts).some(accountId => !covered.has(accountId));
    });
}

/** Read a prospective grant through the same live membership policy as a stored resource. */
export async function readResourceGrantPrincipalAudienceInTx(tx: Tx, input: Readonly<{
    ownerAccountId: string; principal: PrincipalRefV1;
}>): Promise<string[]> {
    return resolveResourceGrantAudienceFromFacts(await readResourceGrantPrincipalFactsInTx(tx, {
        ownerAccountId: input.ownerAccountId, principals: [input.principal],
    }));
}

/** Admins manage ordinary grants; assigning admin remains an owner operation. */
export function mayManageResourceGrants(access: ResourceGrantAccess, nextLevel?: ResourceAccessLevelV1): boolean {
    return access.level === 'owner' || (access.level === 'admin' && nextLevel !== 'admin');
}

export type ResourceGrantPrincipalError = 'owner_grant_invalid' | 'subject_not_found' | 'subject_ineligible';

/** Resource wire codes have no self-share code; a self-share is simply not an eligible subject. */
function resourceGrantPrincipalError(error: ShareSubjectError): ResourceGrantPrincipalError {
    return error === 'self_grant_invalid' ? 'subject_ineligible' : error;
}

/** Prospective principals are admitted in a batch before private membership facts are inspected. */
export async function validateResourceGrantPrincipalsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; ownerAccountId: string; principals: readonly PrincipalRefV1[]; hasExistingGrant: boolean;
}>): Promise<ResourceGrantPrincipalError | null> {
    const resolutions = await resolveShareSubjectsInTx(tx, { actorAccountId: input.actorAccountId,
        resourceOwnerAccountId: input.ownerAccountId, subjects: input.principals, hasExistingGrant: input.hasExistingGrant });
    for (const { eligibility } of resolutions) {
        if (!eligibility.ok) return resourceGrantPrincipalError(eligibility.error);
    }
    return null;
}

/** Batched Account form of the one share-eligibility rule, for grant previews. */
export async function validateResourceGrantAccountPrincipalsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; ownerAccountId: string; accountIds: readonly string[];
}>): Promise<ReadonlyMap<string, ResourceGrantPrincipalError | null>> {
    const resolutions = await resolveShareAccountSubjectsInTx(tx, { actorAccountId: input.actorAccountId,
        resourceOwnerAccountId: input.ownerAccountId, subjectAccountIds: input.accountIds, hasExistingGrant: false });
    return new Map(input.accountIds.map((accountId, index) => {
        const resolution = resolutions[index]!;
        return [accountId, resolution.ok ? null : resourceGrantPrincipalError(resolution.error)];
    }));
}

/** A resource grant writer's subject admission: the one share-eligibility rule; an existing grant stays editable. */
export async function validateResourceGrantPrincipalInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; ownerAccountId: string; principal: PrincipalRefV1; hasExistingGrant: boolean;
}>): Promise<ResourceGrantPrincipalError | null> {
    const resolution = await resolveShareSubjectInTx(tx, { actorAccountId: input.actorAccountId,
        resourceOwnerAccountId: input.ownerAccountId, subject: input.principal, hasExistingGrant: input.hasExistingGrant });
    return resolution.ok ? null : resourceGrantPrincipalError(resolution.error);
}

export interface ResourceStoredRecipientEnvelope {
    encryptedDataKey: Uint8Array;
    recipientContentPublicKeyFingerprint: string;
}

/** A stored tuple is usable only with the recipient's current verified binding. */
export function projectResourceRecipientEnvelope(account: AccountRecipientEnvelopeReadinessRow, envelope: ResourceStoredRecipientEnvelope,
    readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account)): Uint8Array<ArrayBuffer> | null {
    return readiness.status === 'available'
        && readiness.binding.contentPublicKeyFingerprint === envelope.recipientContentPublicKeyFingerprint
        && parseEncryptedDataKeyEnvelopeV1(envelope.encryptedDataKey) !== null
        ? new Uint8Array(envelope.encryptedDataKey) : null;
}

/** Shared content census; optional resource-specific key channels compose this projection. */
export function projectResourceRecipientCensusRow(input: Readonly<{
    access: ResourceGrantAccess;
    ownerDataEncryptionKey: Uint8Array;
    account: RecipientReadinessRow;
    readiness: AccountRecipientEnvelopeReadiness;
    envelope?: ResourceStoredRecipientEnvelope;
}>) {
    const { access, account, readiness, envelope } = input;
    const plain = access.encryptionMode === 'plain';
    const fingerprint = readiness.status === 'available' ? readiness.binding.contentPublicKeyFingerprint : null;
    const ownerEnvelope = !plain && account.id === access.ownerAccountId && fingerprint !== null
        && parseEncryptedDataKeyEnvelopeV1(input.ownerDataEncryptionKey) !== null;
    const current = !plain && envelope && fingerprint === envelope.recipientContentPublicKeyFingerprint
        && parseEncryptedDataKeyEnvelopeV1(envelope.encryptedDataKey) !== null;
    return {
        recipientAccountId: account.id, contentKey: projectRecipientContentKey(account, readiness),
        contentPublicKeyFingerprint: fingerprint,
        encryptedDataKey: ownerEnvelope ? privacyKit.encodeBase64(new Uint8Array(input.ownerDataEncryptionKey))
            : current ? privacyKit.encodeBase64(new Uint8Array(envelope.encryptedDataKey)) : null,
        recipientContentPublicKeyFingerprint: ownerEnvelope ? fingerprint : envelope?.recipientContentPublicKeyFingerprint ?? null,
    };
}

/** Address-free census policy shared by resource-specific response adapters. */
export function projectResourceRecipientCensus(input: Readonly<{
    access: ResourceGrantAccess;
    ownerDataEncryptionKey: Uint8Array;
    callerDataEncryptionKey: Uint8Array | null;
    accounts: readonly Readonly<{ account: RecipientReadinessRow; readiness: AccountRecipientEnvelopeReadiness }>[];
    envelopes: readonly (ResourceStoredRecipientEnvelope & Readonly<{ recipientAccountId: string }>)[];
}>) {
    const { access } = input;
    if (!access.encryptionMode) return { ok: false, error: 'content_unavailable' } as const;
    const plain = access.encryptionMode === 'plain';
    const callerKey = plain ? null : access.level === 'owner' ? new Uint8Array(input.ownerDataEncryptionKey) : input.callerDataEncryptionKey;
    if (!plain && !callerKey) return { ok: false, error: 'content_unavailable' } as const;
    const byAccount = new Map(input.envelopes.map(envelope => [envelope.recipientAccountId, envelope]));
    return { ok: true, value: {
        ownerAccountId: access.ownerAccountId, access: access.level, encryptionMode: access.encryptionMode,
        dataEncryptionKey: plain ? null : privacyKit.encodeBase64(new Uint8Array(input.ownerDataEncryptionKey)),
        callerDataEncryptionKey: callerKey ? privacyKit.encodeBase64(new Uint8Array(callerKey)) : null,
        recipients: input.accounts.map(({ account, readiness }) => projectResourceRecipientCensusRow({
            access, ownerDataEncryptionKey: input.ownerDataEncryptionKey, account, readiness, envelope: byAccount.get(account.id),
        })),
    } } as const;
}

/** Shared structural framing owner for both first-share and subsequent key commits. */
export function validateResourceRecipientKeyEnvelopes(envelopes: readonly ResourceRecipientKeyEnvelopeInputV1[]): boolean {
    return envelopes.every(envelope => parseEncryptedDataKeyEnvelopeV1(privacyKit.decodeBase64(envelope.encryptedDataKey)) !== null);
}

/** Owner-key fence and structural envelope validation precede every resource commit. */
export function validateResourceRecipientEnvelopeCommit(input: Readonly<{
    ownerDataEncryptionKey: Uint8Array;
    expectedDataEncryptionKey: string;
    recipientKeyEnvelopes: readonly ResourceRecipientKeyEnvelopeInputV1[];
}>): 'data_key_changed' | 'invalid_recipient_envelope' | null {
    if (!isDeepStrictEqual(new Uint8Array(input.ownerDataEncryptionKey), privacyKit.decodeBase64(input.expectedDataEncryptionKey))) return 'data_key_changed';
    return validateResourceRecipientKeyEnvelopes(input.recipientKeyEnvelopes) ? null : 'invalid_recipient_envelope';
}

/** Account conversion prepares one complete target key set; the target owner's first-key proof supplies its binding. */
export function validateResourceAccountEncryptionMigrationKeys(input: Readonly<{
    ownerAccountId: string;
    toMode: 'plain' | 'e2ee';
    ownerContentPublicKeyFingerprint?: string | null;
    recipients: readonly ReturnType<typeof projectResourceRecipientCensusRow>[];
    recipientKeyEnvelopes?: readonly ResourceRecipientKeyEnvelopeInputV1[];
}>): boolean {
    const envelopes = input.recipientKeyEnvelopes;
    if (!envelopes) return false;
    if (input.toMode === 'plain') return envelopes.length === 0;
    const owner = envelopes.find(envelope => envelope.recipientAccountId === input.ownerAccountId);
    if (!input.ownerContentPublicKeyFingerprint || !owner
        || owner.recipientContentPublicKeyFingerprint !== input.ownerContentPublicKeyFingerprint) return false;
    const ready = input.recipients.filter(recipient => recipient.recipientAccountId !== input.ownerAccountId && recipient.contentKey.status === 'available');
    if (envelopes.length !== ready.length + 1) return false;
    const expected = new Map(ready.map(recipient => [recipient.recipientAccountId, recipient.contentPublicKeyFingerprint]));
    const seen = new Set<string>();
    for (const envelope of envelopes) {
        if (seen.has(envelope.recipientAccountId) || !parseEncryptedDataKeyEnvelopeV1(privacyKit.decodeBase64(envelope.encryptedDataKey))) return false;
        seen.add(envelope.recipientAccountId);
        if (envelope.recipientAccountId !== input.ownerAccountId
            && expected.get(envelope.recipientAccountId) !== envelope.recipientContentPublicKeyFingerprint) return false;
    }
    return true;
}

export interface ResourceRecipientEnvelopeStorageAdapter<Envelope extends ResourceRecipientKeyEnvelopeInputV1> extends ResourceGrantStorageAdapter {
    writeRecipientEnvelopeInTx(tx: Tx, resourceId: string, envelope: Envelope): Promise<void>;
    publishRecipientsChangedInTx(tx: Tx, resourceId: string, accountIds: readonly string[]): Promise<void>;
}

/** Fenced commits and Account transitions share the same live recipient admission. */
export async function applyResourceRecipientKeyEnvelopesInTx<Envelope extends ResourceRecipientKeyEnvelopeInputV1>(
    tx: Tx, adapter: ResourceRecipientEnvelopeStorageAdapter<Envelope>,
    input: Readonly<{ resourceId: string; recipientKeyEnvelopes: readonly Envelope[] }>,
): Promise<ResourceRecipientKeyEnvelopeCommitResponseV1> {
    const appliedRecipientAccountIds: string[] = [];
    const skippedRecipientAccountIds: string[] = [];
    const recipientIds = [...new Set(input.recipientKeyEnvelopes.map(envelope => envelope.recipientAccountId))];
    const accounts = recipientIds.length === 0 ? [] : await tx.account.findMany({
        where: { id: { in: recipientIds } }, select: RECIPIENT_READINESS_SELECT,
    });
    // Decisions share one in-transaction fact snapshot; subsequent grant removal is enforced by live resource reads.
    const facts = recipientIds.length === 0 ? null : await adapter.readAccessFactsInTx(tx, input.resourceId);
    const accountsById = new Map(accounts.map(account => [account.id, account]));
    for (const envelope of input.recipientKeyEnvelopes) {
        const account = accountsById.get(envelope.recipientAccountId);
        const access = facts ? resolveResourceGrantAccessFromFacts(facts, envelope.recipientAccountId) : null;
        const readiness = account ? deriveAccountRecipientEnvelopeReadinessFromRow(account) : null;
        if (!access || access.level === 'owner' || readiness?.status !== 'available'
            || readiness.binding.contentPublicKeyFingerprint !== envelope.recipientContentPublicKeyFingerprint) {
            skippedRecipientAccountIds.push(envelope.recipientAccountId);
            continue;
        }
        await adapter.writeRecipientEnvelopeInTx(tx, input.resourceId, envelope);
        appliedRecipientAccountIds.push(envelope.recipientAccountId);
    }
    await adapter.publishRecipientsChangedInTx(tx, input.resourceId, appliedRecipientAccountIds);
    return { appliedRecipientAccountIds, skippedRecipientAccountIds };
}
