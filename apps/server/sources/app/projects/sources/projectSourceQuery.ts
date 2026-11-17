import type { Prisma } from '@prisma/client';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { ProjectSourcesFailureV1, ProjectSourcesListInputV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { TeamActorContext, TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { EFFECTIVE_TEAM_MEMBERSHIP_WHERE } from '@/app/teams/memberships/effectiveMembership';
import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { resolveProjectSourceAdmissionInTx } from './projectSourceService';

const dialect = () => resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
const column = (name: string) => prismaRuntime.raw(dialect() === 'mysql'
    ? `s.\`${name}\`` : `s."${name}"`);
const either = (arms: readonly Prisma.Sql[]) => arms.length ? prismaRuntime.sql`(${prismaRuntime.join([...arms], ' OR ')})` : prismaRuntime.sql`1 = 0`;

/** JSON admission remains in the database, before ordering, cursor and limit.
 * PostgreSQL containment consumes the Source owner's partial GIN indexes. */
function contains(columnName: 'owner' | 'audience', principal: PrincipalRefV1): Prisma.Sql {
    const value = columnName === 'owner' ? principal : [{ principal }];
    const provider = dialect();
    if (provider === 'postgres') return prismaRuntime.sql`${column(columnName)} @> ${JSON.stringify(value)}::jsonb`;
    if (provider === 'mysql') return prismaRuntime.sql`JSON_CONTAINS(${column(columnName)}, ${JSON.stringify(value)})`;
    const fields = Object.entries(principal);
    const match = (root: Prisma.Sql) => prismaRuntime.join(fields.map(([key, value]) =>
        prismaRuntime.sql`json_extract(${root}, ${`$.${key}`}) = ${value}`), ' AND ');
    return columnName === 'owner' ? prismaRuntime.sql`(${match(column('owner'))})`
        : prismaRuntime.sql`EXISTS (SELECT 1 FROM json_each(${column('audience')}) grant_entry
            WHERE ${match(prismaRuntime.raw("json_extract(grant_entry.value, '$.principal')"))})`;
}

/** Shared by Source pages, Source counts and Source-context Artifact classification.
 * The returned predicate always binds ProjectSource as alias `s`. */
export async function resolveProjectSourceQueryScopeInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    sharedWithTeamId?: string;
    includeDeleted?: boolean;
    authentication?: Partial<TeamOperationAuthenticationContext>;
    /** The summary's same-transaction structural admission; Source qualification remains native. */
    admittedTeamActor?: TeamActorContext;
}>): Promise<Readonly<{ ok: true; where: Prisma.Sql; sharedWithTeamGroupIds: ReadonlySet<string> }> | Readonly<{ ok: false; error: ProjectSourcesFailureV1['error'] }>> {
    const memberships = await tx.teamMembership.findMany({ where: { ...EFFECTIVE_TEAM_MEMBERSHIP_WHERE,
        accountId: input.actorAccountId }, select: { teamId: true } });
    const grants = memberships.map(({ teamId }) => ({ principal: { kind: 'team' as const, teamId }, level: 'view' as const }));
    const owner = { kind: 'account' as const, accountId: input.actorAccountId };
    const admission = await resolveProjectSourceAdmissionInTx(tx, input.actorAccountId, grants, input.authentication ?? {}, [owner], input.admittedTeamActor);
    if (!admission.active) return { ok: false, error: 'source_unavailable' };
    if (input.sharedWithTeamId && !admission.admittedTeam(input.sharedWithTeamId)) {
        return memberships.some(({ teamId }) => teamId === input.sharedWithTeamId)
            ? { ok: false, error: 'source_unavailable' } : { ok: true, where: prismaRuntime.sql`1 = 0`, sharedWithTeamGroupIds: new Set<string>() };
    }
    const principals = admission.effectivePrincipals(owner, grants);
    const readable = either([
        prismaRuntime.sql`(${column('owner')} IS NULL AND ${column('createdByAccountId')} = ${input.actorAccountId})`,
        ...principals.flatMap(principal => principal.kind === 'group'
            ? [contains('audience', principal)] : [contains('owner', principal), contains('audience', principal)]),
    ]);
    const selectedGroups = principals.flatMap(principal => principal.kind === 'group' && principal.teamId === input.sharedWithTeamId ? [principal] : []);
    const selectedTeam = input.sharedWithTeamId ? either([
        contains('owner', { kind: 'team', teamId: input.sharedWithTeamId }),
        contains('audience', { kind: 'team', teamId: input.sharedWithTeamId }),
        ...selectedGroups.map(principal => contains('audience', principal)),
    ]) : prismaRuntime.sql`1 = 1`;
    return { ok: true, where: prismaRuntime.sql`${input.includeDeleted ? prismaRuntime.empty : prismaRuntime.sql`${column('deletedAt')} IS NULL AND `}${readable} AND ${selectedTeam}`,
        sharedWithTeamGroupIds: new Set(selectedGroups.map(principal => principal.groupId)) };
}

export function projectSourceListFiltersSql(input: ProjectSourcesListInputV1): Prisma.Sql {
    const filters: Prisma.Sql[] = [];
    if (input.cursor) filters.push(prismaRuntime.sql`${column('id')} > ${input.cursor}`);
    if (input.audience) filters.push(contains('audience', input.audience));
    const query = input.query?.trim().toLocaleLowerCase();
    if (query) {
        const provider = dialect();
        const repositoryName = provider === 'postgres' ? prismaRuntime.sql`${column('repository')} #>> '{repository,nameWithOwner}'`
            : prismaRuntime.sql`json_extract(${column('repository')}, '$.repository.nameWithOwner')`;
        const text = provider === 'mysql' ? prismaRuntime.sql`JSON_UNQUOTE(${repositoryName})` : repositoryName;
        const needle = `%${query.replace(/[!%_]/g, value => `!${value}`)}%`;
        filters.push(either([column('name'), text, column('defaultRef'), column('subdir')]
            .map(value => prismaRuntime.sql`LOWER(${value}) LIKE ${needle} ESCAPE '!'`)));
    }
    return filters.length ? prismaRuntime.sql`${prismaRuntime.join(filters, ' AND ')}` : prismaRuntime.sql`1 = 1`;
}

export async function countScopedTeamProjectSourcesInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; sharedWithTeamId: string; authentication?: Partial<TeamOperationAuthenticationContext>;
    admittedTeamActor?: TeamActorContext;
}>): Promise<Readonly<{ ok: true; count: number }> | Readonly<{ ok: false; error: ProjectSourcesFailureV1['error'] }>> {
    const scope = await resolveProjectSourceQueryScopeInTx(tx, input);
    if (!scope.ok) return scope;
    const table = prismaRuntime.raw(dialect() === 'mysql' ? '`ProjectSource`' : '"ProjectSource"');
    const rows = await tx.$queryRaw<Readonly<{ count: bigint | number }>[]>(prismaRuntime.sql`SELECT COUNT(*) AS count FROM ${table} s WHERE ${scope.where}`);
    return { ok: true, count: Number(rows[0]?.count ?? 0) };
}
