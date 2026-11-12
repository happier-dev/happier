import type { Prisma } from '@prisma/client';
import type { Tx } from '@/storage/inTx';
import { prismaRuntime } from '@/storage/prisma';
import { capturedPostgresRowJson, teamAuthenticationReadCaptureSql, materializeTeamAuthenticationReadCapture,
    type JsonSnapshot, type TeamAuthenticationSqlCapture } from '@/app/auth/entry/teamAuthenticationReadCapture';
import { resolveHomeGovernanceAuthority } from '@/app/home/governance/homeCapabilities';
import { composeTeamActorContext, qualifyTeamOperationAuthenticationsInTx,
    type TeamActorContext, type TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import type { TeamRecord } from '@/app/teams/projections';
import { isEffectiveTeamGroupMembership } from '@/app/teams/groups/effectiveGroupMembership';
import { admitProjectSourceRows, composeProjectSourceAdmission,
    type ProjectSourceRow, type ProjectSourceAccessResult } from './projectSourceService';


/** Internal statement result; provider ciphertext never enters a Source or deployment DTO. */
export interface ProjectSourceAccessCapture extends TeamAuthenticationSqlCapture {
    readonly sources: readonly JsonSnapshot<ProjectSourceRow>[];
    readonly teams: readonly JsonSnapshot<TeamRecord>[];
    readonly memberships: readonly Readonly<{ teamId: string; membership: TeamActorContext['membership'] }>[];
    readonly ownerCounts: readonly Readonly<{ teamId: string; count: number }>[];
    readonly groups: readonly Readonly<{ teamId: string; teamGroupId: string; groupArchivedAt: number | null }>[];

}

/** A scalar JSON expression composable with the enclosing page's one PostgreSQL SELECT.
 * Selectors only capture facts; the existing Source, Team and authentication owners decide access. */
export function projectSourceAccessCaptureSql(input: Readonly<{
    actorAccountId: Prisma.Sql;
    sourceIds: Prisma.Sql;
    env?: NodeJS.ProcessEnv;
}>): Prisma.Sql {
    const sources = capturedPostgresRowJson('s', ['deletedAt', 'createdAt', 'updatedAt']);
    const teams = capturedPostgresRowJson('t', ['archivedAt']);
    const authentication = teamAuthenticationReadCaptureSql({ actorAccountId: input.actorAccountId,
        teams: prismaRuntime.sql`SELECT "id", "authenticationPolicy" FROM capture_teams`, env: input.env });
    return prismaRuntime.sql`(
        WITH capture_sources AS MATERIALIZED (
            SELECT s.* FROM "ProjectSource" s WHERE s."id" IN (${input.sourceIds})
        ), capture_team_ids AS MATERIALIZED (
            SELECT DISTINCT value #>> '{}' AS id FROM capture_sources s,
                LATERAL jsonb_path_query(s."owner", '$.teamId') value
            UNION
            SELECT DISTINCT value #>> '{}' AS id FROM capture_sources s,
                LATERAL jsonb_path_query(s."audience", '$[*].principal.teamId') value
        ), capture_teams AS MATERIALIZED (
            SELECT t.* FROM "Team" t WHERE t."id" IN (SELECT id FROM capture_team_ids)
        ), capture_memberships AS MATERIALIZED (
            SELECT m.*, (EXISTS (SELECT 1 FROM "TeamProvisionedIdentity" p WHERE p."teamMembershipId" = m."id")
                OR EXISTS (SELECT 1 FROM "TeamMembershipIdentityConnectionManagement" j WHERE j."teamMembershipId" = m."id")) AS "managedExternally"
            FROM "TeamMembership" m WHERE m."accountId" = ${input.actorAccountId}
                AND m."teamId" IN (SELECT id FROM capture_team_ids)
        )
        SELECT jsonb_build_object(
            'sources', COALESCE((SELECT jsonb_agg(${sources}) FROM capture_sources s), '[]'::jsonb),
            'teams', COALESCE((SELECT jsonb_agg(${teams}) FROM capture_teams t), '[]'::jsonb),
            'memberships', COALESCE((SELECT jsonb_agg(jsonb_build_object('teamId', m."teamId", 'membership',
                jsonb_build_object('id', m."id", 'role', m."role", 'status', m."status", 'managedExternally', m."managedExternally")))
                FROM capture_memberships m), '[]'::jsonb),
            'ownerCounts', COALESCE((SELECT jsonb_agg(to_jsonb(counts)) FROM (
                SELECT m."teamId", count(*)::int AS count FROM "TeamMembership" m
                JOIN "Account" a ON a."id" = m."accountId" WHERE m."teamId" IN (SELECT id FROM capture_team_ids)
                    AND m."role" = 'owner' AND m."status" = 'active' AND a."status" = 'active' GROUP BY m."teamId"
            ) counts), '[]'::jsonb),
            'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object('teamId', g."teamId", 'teamGroupId', g."teamGroupId", 'groupArchivedAt', EXTRACT(EPOCH FROM t."archivedAt") * 1000))
                FROM "TeamGroupMembership" g JOIN capture_memberships m ON m."id" = g."teamMembershipId" AND m."teamId" = g."teamId"
                JOIN "TeamGroup" t ON t."id" = g."teamGroupId" AND t."teamId" = g."teamId"), '[]'::jsonb)
        ) || ${authentication}
    )`;
}

const date = (value: number | null) => value === null ? null : new Date(value);

/** Materializes database encodings only, then invokes the same canonical access evaluator as scalar reads. */
export async function resolveProjectSourceAccessFromCapture(tx: Tx, input: Readonly<{
    actorAccountId: string;
    authentication?: Partial<TeamOperationAuthenticationContext>;
    capture: ProjectSourceAccessCapture;
}>): Promise<ReadonlyMap<string, ProjectSourceAccessResult>> {
    const { capture, actorAccountId } = input;
    const account = capture.actor;
    const homeAuthority = resolveHomeGovernanceAuthority(account ? { ...account, accountId: account.id } : null);
    const memberships = new Map(capture.memberships.map(entry => [entry.teamId, entry.membership]));
    const counts = new Map(capture.ownerCounts.map(entry => [entry.teamId, entry.count]));
    const contexts = new Map(capture.teams.map(row => {
        const { directorySources: _directorySources, ...teamRow } = row;
        const team: TeamRecord = { ...teamRow, archivedAt: date(row.archivedAt) };
        return [team.id, composeTeamActorContext({ team, actorAccountId, accountStatus: account?.status ?? 'disabled',
            membership: memberships.get(team.id) ?? null, homeAuthority, ownerRequired: (counts.get(team.id) ?? 0) === 0,
            activeOwnerCount: counts.get(team.id) ?? 0 })] as const;
    }));
    const groups = new Map<string, Set<string>>();
    for (const group of capture.groups) {
        const context = contexts.get(group.teamId);
        if (!context?.membership || !isEffectiveTeamGroupMembership({ accountStatus: context.accountStatus,
            membershipStatus: context.membership.status, teamArchivedAt: context.team.archivedAt,
            groupArchivedAt: date(group.groupArchivedAt) })) continue;
        const ids = groups.get(group.teamId) ?? new Set<string>();
        ids.add(group.teamGroupId);
        groups.set(group.teamId, ids);
    }
    const readCapture = materializeTeamAuthenticationReadCapture(capture);
    const qualified = await qualifyTeamOperationAuthenticationsInTx(tx, { contexts: [...contexts.values()], ...input.authentication }, readCapture);
    const admission = composeProjectSourceAdmission({ actorAccountId, active: account?.status === 'active', contexts, qualified, groups });
    return admitProjectSourceRows(capture.sources.map(row => ({ ...row, deletedAt: date(row.deletedAt),
        createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) })), admission);
}
