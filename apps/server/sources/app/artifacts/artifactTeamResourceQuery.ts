import type { Prisma } from '@prisma/client';
import { ArtifactTeamResourceKindV1Schema, getArtifactTeamResourceStoredKindsV1,
    type ArtifactTeamResourceKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import type { ProjectSourcesFailureV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { resourceTeamShareScopeV1, type ResourceTeamShareScopeV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';
import { resourceGrantArmWheres } from '@/app/teams/resourceGrantAccess';
import { resolveProjectSourceQueryScopeInTx } from '@/app/projects/sources/projectSourceQuery';
import { artifactVisibleWhere } from './artifactClassification';

type TeamArtifactQuery = Readonly<{
    actorAccountId: string;
    sharedWithTeamId: string;
    authentication?: Parameters<typeof resolveProjectSourceQueryScopeInTx>[1]['authentication'];
    admittedTeamActor?: Parameters<typeof resolveProjectSourceQueryScopeInTx>[1]['admittedTeamActor'];
}>;
type QueryFailure = Readonly<{ ok: false; error: ProjectSourcesFailureV1['error'] }>;

/** Exact Team grant candidates use the existing principal policy, never Team administration. */
async function teamArtifactCandidatesInTx(tx: Tx, input: TeamArtifactQuery) {
    const grants = resourceGrantArmWheres(input.actorAccountId, input.sharedWithTeamId);
    const selectedTeam = { OR: [{ teamId: input.sharedWithTeamId },
        { teamGroup: { teamId: input.sharedWithTeamId } }] };
    const rows = await Promise.all([
        tx.artifactGrant.findMany({ where: { ...grants.team, principalKind: 'team' }, select: { artifactId: true, principalKind: true } }),
        tx.artifactGrant.findMany({ where: { ...grants.group, principalKind: 'group' }, select: { artifactId: true, principalKind: true } }),
        // Independent owner/direct access admits a selected Team resource even
        // when its Team presence is a Group the reader does not belong to.
        tx.artifactGrant.findMany({ where: { ...selectedTeam, artifact: { OR: [
            { accountId: input.actorAccountId }, { grants: { some: { ...grants.account, principalKind: 'account' } } },
        ] } },
            select: { artifactId: true, principalKind: true } }),
    ]);
    const flags = new Map<string, { team: boolean; group: boolean }>();
    for (const row of rows.flat()) {
        const scope = flags.get(row.artifactId) ?? { team: false, group: false };
        if (row.principalKind === 'team') scope.team = true;
        if (row.principalKind === 'group') scope.group = true;
        flags.set(row.artifactId, scope);
    }
    const sharingScopes = new Map<string, ResourceTeamShareScopeV1>();
    for (const [artifactId, flagsForArtifact] of flags) {
        const scope = resourceTeamShareScopeV1(flagsForArtifact);
        if (scope) sharingScopes.set(artifactId, scope);
    }
    return { where: { id: { in: [...flags.keys()] } } satisfies Prisma.ArtifactWhereInput, sharingScopes };
}

/** Expand only admitted Source attachment metadata; no Source or Artifact body is opened. */
async function sourceContextDocumentIdsInTx(tx: Tx, input: TeamArtifactQuery): Promise<
    Readonly<{ ok: true; ids: readonly string[] }> | QueryFailure> {
    const scope = await resolveProjectSourceQueryScopeInTx(tx, input);
    if (!scope.ok) return scope;
    const sql = prismaRuntime.sql;
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    const rows = provider === 'mysql'
        ? await tx.$queryRaw<Array<{ artifactId: string }>>(sql`
            SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(attachment.value, '$.entry.ref.artifactId')) AS artifactId
            FROM \`ProjectSource\` s CROSS JOIN JSON_TABLE(s.\`attachments\`, '$[*]' COLUMNS (value JSON PATH '$')) attachment
            WHERE ${scope.where} AND JSON_UNQUOTE(JSON_EXTRACT(attachment.value, '$.purpose')) = 'context'
                AND JSON_UNQUOTE(JSON_EXTRACT(attachment.value, '$.entry.ref.kind')) = 'doc'`)
        : provider === 'sqlite'
            ? await tx.$queryRaw<Array<{ artifactId: string }>>(sql`
                SELECT DISTINCT json_extract(attachment.value, '$.entry.ref.artifactId') AS "artifactId"
                FROM "ProjectSource" s CROSS JOIN json_each(s."attachments") attachment
                WHERE ${scope.where} AND json_extract(attachment.value, '$.purpose') = 'context'
                    AND json_extract(attachment.value, '$.entry.ref.kind') = 'doc'`)
            : await tx.$queryRaw<Array<{ artifactId: string }>>(sql`
                SELECT DISTINCT attachment.value->'entry'->'ref'->>'artifactId' AS "artifactId"
                FROM "ProjectSource" s CROSS JOIN LATERAL jsonb_array_elements(s."attachments"::jsonb) attachment(value)
                WHERE ${scope.where} AND attachment.value->>'purpose' = 'context'
                    AND attachment.value->'entry'->'ref'->>'kind' = 'doc'`);
    return { ok: true, ids: rows.map(row => row.artifactId) };
}

function artifactTeamBucketWhere(kind: ArtifactTeamResourceKindV1, documentIds: readonly string[]): Prisma.ArtifactWhereInput {
    const stored = getArtifactTeamResourceStoredKindsV1();
    switch (kind) {
        case 'projectDocuments': return { kind: { in: [...stored.projectDocument] }, id: { in: [...documentIds] } };
        case 'prompts': return { kind: { in: [...stored.prompts] }, NOT: { AND: [
            { kind: { in: [...stored.projectDocument] } }, { id: { in: [...documentIds] } },
        ] } };
        case 'workflows': return { kind: { in: [...stored.workflows] } };
        case 'reviews': return { kind: { in: [...stored.reviews] } };
        case 'otherArtifacts': return { OR: [{ kind: null }, { kind: { notIn: [...stored.prompts, ...stored.workflows, ...stored.reviews] } }] };
    }
}

/** Count and page consume one scope and the same disjoint bucket predicates. */
export async function resolveTeamArtifactQueryInTx(tx: Tx, input: TeamArtifactQuery & Readonly<{
    teamResourceKind?: ArtifactTeamResourceKindV1; allBuckets?: boolean;
}>): Promise<Readonly<{ ok: true; where: Prisma.ArtifactWhereInput;
    sharingScopes: ReadonlyMap<string, ResourceTeamShareScopeV1>;
    buckets: Readonly<Record<ArtifactTeamResourceKindV1, Prisma.ArtifactWhereInput>> }> | QueryFailure> {
    const candidates = await teamArtifactCandidatesInTx(tx, input);
    const needsDocuments = input.allBuckets || input.teamResourceKind === 'projectDocuments' || input.teamResourceKind === 'prompts';
    const documents = needsDocuments ? await sourceContextDocumentIdsInTx(tx, input) : { ok: true as const, ids: [] };
    if (!documents.ok) return documents;
    const buckets = Object.fromEntries(ArtifactTeamResourceKindV1Schema.options.map(kind =>
        [kind, artifactTeamBucketWhere(kind, documents.ids)])) as Record<ArtifactTeamResourceKindV1, Prisma.ArtifactWhereInput>;
    return { ok: true, buckets, sharingScopes: candidates.sharingScopes, where: { AND: [candidates.where,
        ...(input.teamResourceKind === undefined ? [] : [buckets[input.teamResourceKind]])] } };
}

/** Header aggregates retain admitted locked rows and never acquire content keys. */
export async function countTeamSharedArtifactsInTx(tx: Tx, input: TeamArtifactQuery): Promise<
    Readonly<{ ok: true; counts: Readonly<Record<ArtifactTeamResourceKindV1, number>> }> | QueryFailure> {
    const query = await resolveTeamArtifactQueryInTx(tx, { ...input, allBuckets: true });
    if (!query.ok) return query;
    const entries = await Promise.all(ArtifactTeamResourceKindV1Schema.options.map(async kind => [kind,
        await tx.artifact.count({ where: { ...artifactVisibleWhere, AND: [query.where, query.buckets[kind]] } }),
    ] as const));
    return { ok: true, counts: Object.fromEntries(entries) as Record<ArtifactTeamResourceKindV1, number> };
}
