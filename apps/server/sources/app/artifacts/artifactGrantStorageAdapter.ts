import { projectResourceGrantRows } from '@/app/teams/resourceGrantAccess';
import type { Tx } from '@/storage/inTx';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { resourceGrantAccessSqlPredicate, resourceGrantRelationsSelect, resolveResourceGrantAccessFromFacts, type ResourceGrantAccessFacts, type ResourceGrantStorageAdapter } from '@/app/teams/resourceGrantAccess';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { artifactOrdinarySqlPredicate, artifactVisibleWhere } from './artifactClassification';
import { withArtifactSourceReadersInTx, type ArtifactSourceReader } from './artifactSourceReaders';

export function artifactAccessFactsSelect(actorAccountId?: string) {
    const grants = resourceGrantRelationsSelect(actorAccountId);
    return {
        id: true, kind: true, accountId: true, account: { select: { encryptionMode: true } },
        ...grants,
    } as const;
}

async function readArtifactAccessFactsBatchInTx(tx: Tx, artifactIds: readonly string[], actorAccountId?: string) {
    return tx.artifact.findMany({ where: { id: { in: [...artifactIds] }, ...artifactVisibleWhere }, select: artifactAccessFactsSelect(actorAccountId) });
}

export type StoredArtifactAccessFacts = Awaited<ReturnType<typeof readArtifactAccessFactsBatchInTx>>[number];
export type ArtifactAccessFacts = StoredArtifactAccessFacts & Readonly<{ sourceReaderAccounts: readonly ArtifactSourceReader[] }>;

export function artifactGrantFacts(row: ArtifactAccessFacts): ResourceGrantAccessFacts {
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
    const grants = projectResourceGrantRows(row.grants);
    return { ownerAccountId: row.accountId, encryptionMode: mode.status === 'ready' ? mode.mode : null,
        accountGrants: [...grants.accountGrants, ...row.sourceReaderAccounts.map(reader => ({ ...reader, accessLevel: 'view' as const }))],
        teamGrants: grants.teamGrants, groupGrants: grants.groupGrants };
}

/** Admit an exact identity set through the same live grant and Artifact lifecycle predicates. */
export async function readAccessibleArtifactIdsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifactIds: readonly string[];
}>): Promise<ReadonlySet<string>> {
    const mysql = getDbProviderFromEnv(process.env, 'postgres') === 'mysql';
    const identifier = (name: string) => prismaRuntime.raw(mysql ? `\`${name}\`` : `"${name}"`);
    const access = resourceGrantAccessSqlPredicate({ actorAccountId: input.actorAccountId,
        resourceTablePrefix: 'Artifact', resourceIdColumn: 'artifactId' });
    const admitted = new Set<string>();
    for (const ids of portableQueryChunks({ values: [...new Set(input.artifactIds)], bindingsPerValue: 1,
        fixedBindings: access.values.length })) {
        const rows = await tx.$queryRaw<Array<{ id: string }>>(prismaRuntime.sql`
            SELECT a.${identifier('id')} FROM ${identifier('Artifact')} a
            WHERE a.${identifier('id')} IN (${prismaRuntime.join([...ids])})
                AND a.${identifier('deletedAt')} IS NULL
                AND ${prismaRuntime.raw(artifactOrdinarySqlPredicate(mysql))} AND ${access}`);
        for (const row of rows) admitted.add(row.id);
    }
    const missing = [...new Set(input.artifactIds)].filter(id => !admitted.has(id));
    const rows: StoredArtifactAccessFacts[] = [];
    for (const ids of portableQueryChunks({ values: missing, bindingsPerValue: 1, fixedBindings: 1 })) {
        rows.push(...await tx.artifact.findMany({ where: { id: { in: [...ids] }, ...artifactVisibleWhere },
            select: artifactAccessFactsSelect(input.actorAccountId) }));
    }
    for (const row of await withArtifactSourceReadersInTx(tx, rows, input.actorAccountId)) {
        if (resolveResourceGrantAccessFromFacts(artifactGrantFacts(row), input.actorAccountId)) admitted.add(row.id);
    }
    return admitted;
}

/** Artifact storage only; access policy never loads an Artifact body or content key. */
export const artifactGrantStorageAdapter: ResourceGrantStorageAdapter = {
    async readAccessFactsBatchInTx(tx, artifactIds, actorAccountId) {
        const rows: StoredArtifactAccessFacts[] = [];
        for (const ids of portableQueryChunks({ values: [...new Set(artifactIds)], bindingsPerValue: 1,
            fixedBindings: actorAccountId === undefined ? 0 : 3 })) {
            rows.push(...await readArtifactAccessFactsBatchInTx(tx, ids, actorAccountId));
        }
        return new Map((await withArtifactSourceReadersInTx(tx, rows, actorAccountId)).map(row => [row.id, artifactGrantFacts(row)]));
    },
    async readAccessFactsInTx(tx, artifactId, actorAccountId) {
        return (await artifactGrantStorageAdapter.readAccessFactsBatchInTx(tx, [artifactId], actorAccountId)).get(artifactId) ?? null;
    },
};
