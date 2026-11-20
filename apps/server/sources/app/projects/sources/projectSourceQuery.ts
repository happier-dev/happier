import type { Prisma } from '@prisma/client';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { ProjectSourcesFailureV1, ProjectSourcesListInputV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { TeamActorContext, TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { EFFECTIVE_TEAM_MEMBERSHIP_WHERE } from '@/app/teams/memberships/effectiveMembership';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { resolveProjectSourceAdmissionInTx } from './projectSourceService';

const dialect = () => resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
const column = (name: string) => prismaRuntime.raw(dialect() === 'mysql'
    ? `s.\`${name}\`` : `s."${name}"`);
const either = (arms: readonly Prisma.Sql[]) => arms.length ? prismaRuntime.sql`(${prismaRuntime.join([...arms], ' OR ')})` : prismaRuntime.sql`1 = 0`;
const sourceTable = () => prismaRuntime.raw(dialect() === 'mysql' ? '`ProjectSource`' : '"ProjectSource"');

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

async function resolveSourceVisibilityInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    authentication?: Partial<TeamOperationAuthenticationContext>;
    admittedTeamActors?: readonly TeamActorContext[];
}>) {
    const memberships = await tx.teamMembership.findMany({ where: { ...EFFECTIVE_TEAM_MEMBERSHIP_WHERE,
        accountId: input.actorAccountId }, select: { teamId: true } });
    const grants = memberships.map(({ teamId }) => ({ principal: { kind: 'team' as const, teamId }, level: 'view' as const }));
    const owner = { kind: 'account' as const, accountId: input.actorAccountId };
    const admission = await resolveProjectSourceAdmissionInTx(tx, input.actorAccountId, grants, input.authentication ?? {}, [owner], input.admittedTeamActors);
    if (!admission.active) return null;
    const principals = admission.effectivePrincipals(owner, grants);
    const readable = either([
        prismaRuntime.sql`(${column('owner')} IS NULL AND ${column('createdByAccountId')} = ${input.actorAccountId})`,
        ...principals.flatMap(principal => principal.kind === 'group'
            ? [contains('audience', principal)] : [contains('owner', principal), contains('audience', principal)]),
    ]);
    const membershipTeamIds = new Set(memberships.map(({ teamId }) => teamId));
    const groupsByTeam = new Map<string, Extract<PrincipalRefV1, { kind: 'group' }>[]>();
    for (const principal of principals) {
        if (principal.kind !== 'group') continue;
        const groups = groupsByTeam.get(principal.teamId) ?? [];
        groups.push(principal);
        groupsByTeam.set(principal.teamId, groups);
    }
    return {
        readable,
        selectTeam(teamId: string) {
            if (!admission.admittedTeam(teamId)) {
                return membershipTeamIds.has(teamId) ? { kind: 'unavailable' } as const : { kind: 'empty' } as const;
            }
            const groups = groupsByTeam.get(teamId) ?? [];
            const team = { kind: 'team', teamId } as const;
            return {
                kind: 'selected' as const,
                where: either([contains('owner', team), contains('audience', team), ...groups.map(group => contains('audience', group))]),
                groupIds: groups.map(group => group.groupId),
            };
        },
    };
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
    const visibility = await resolveSourceVisibilityInTx(tx, {
        ...input, admittedTeamActors: input.admittedTeamActor ? [input.admittedTeamActor] : undefined,
    });
    const selection = input.sharedWithTeamId ? visibility?.selectTeam(input.sharedWithTeamId) : undefined;
    if (!visibility || selection?.kind === 'unavailable') return { ok: false, error: 'source_unavailable' };
    const selected = selection?.kind === 'selected' ? selection.where : selection?.kind === 'empty'
        ? prismaRuntime.sql`1 = 0` : prismaRuntime.sql`1 = 1`;
    return { ok: true, where: prismaRuntime.sql`${input.includeDeleted ? prismaRuntime.empty : prismaRuntime.sql`${column('deletedAt')} IS NULL AND `}${visibility.readable} AND ${selected}`,
        sharedWithTeamGroupIds: new Set(selection?.kind === 'selected' ? selection.groupIds : []) };
}

/** The directory asks for presence, with one admission and portable native reads per page. */
export async function readScopedTeamProjectSourcePresenceInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    authentication?: Partial<TeamOperationAuthenticationContext>;
    admittedTeamActors: readonly TeamActorContext[];
}>): Promise<ReadonlyMap<string, boolean | null>> {
    const presence = new Map<string, boolean | null>();
    if (input.admittedTeamActors.length === 0) return presence;
    const visibility = await resolveSourceVisibilityInTx(tx, input);
    if (!visibility) return presence;
    const table = sourceTable();
    const selections: { teamId: string; arm: Prisma.Sql }[] = [];
    for (const { team: { id } } of input.admittedTeamActors) {
        const selection = visibility.selectTeam(id);
        presence.set(id, selection.kind === 'unavailable' ? null : false);
        if (selection.kind !== 'selected') continue;
        // Each requested Team can use the native containment indexes before the
        // shared reader predicate is applied. The same Source can match multiple Teams.
        // The generated ordinal identifies the arm without spending a bind
        // on a result label, so a Team filter that fits alone still fits here.
        const ordinal = prismaRuntime.raw(String(selections.length));
        selections.push({
            teamId: id,
            arm: prismaRuntime.sql`SELECT ${ordinal} AS team_ordinal, ${column('id')} AS source_id
                FROM ${table} s WHERE ${column('deletedAt')} IS NULL AND ${selection.where}`,
        });
    }
    for (const chunk of portableQueryChunks({
        values: selections,
        bindingsPerValue: ({ arm }) => arm.values.length,
        fixedBindings: visibility.readable.values.length,
        compoundSelectsPerValue: 1,
    })) {
        const rows = await tx.$queryRaw<Readonly<{ team_ordinal: number | bigint }>[]>(prismaRuntime.sql`
            SELECT DISTINCT matching.team_ordinal
            FROM (${prismaRuntime.join(chunk.map(({ arm }) => arm), ' UNION ALL ')}) matching
            JOIN ${table} s ON ${column('id')} = matching.source_id
            WHERE ${visibility.readable}
        `);
        for (const { team_ordinal } of rows) presence.set(selections[Number(team_ordinal)]!.teamId, true);
    }
    return presence;
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
    const rows = await tx.$queryRaw<Readonly<{ count: bigint | number }>[]>(prismaRuntime.sql`SELECT COUNT(*) AS count FROM ${sourceTable()} s WHERE ${scope.where}`);
    return { ok: true, count: Number(rows[0]?.count ?? 0) };
}
