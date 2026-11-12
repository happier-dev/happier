import { DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol';
import type { ResourceAccessLevelV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import type { AccountStatus } from '@/storage/enums.generated';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { isProjectSourceContentStoredKind, projectSourceContentTeamCustodyLevels,
    readProjectSourceContentReferencesInTx } from '@/app/projects/sources/projectSourceContentReferences';
import { resolveResourceGrantAccessFromFacts } from '@/app/teams/resourceGrantAccess';
import { artifactGrantFacts, type StoredArtifactAccessFacts } from './artifactGrantStorageAdapter';

type ArtifactIdentity = StoredArtifactAccessFacts & Readonly<{
    teamGrants: readonly Readonly<{ teamId: string; accessLevel: ResourceAccessLevelV1;
        team: Readonly<{ archivedAt: Date | null }> }>[];
}>;

export interface ArtifactSourceReader {
    readonly accountId: string;
    readonly account: Readonly<{ status: AccountStatus }>;
}

/** Source supplies read access only to its actual, privately held deployment content. */
export async function withArtifactSourceReadersInTx<T extends ArtifactIdentity>(tx: Tx, rows: readonly T[], actorAccountId?: string) {
    // Source audience adds only view access. A caller who already holds direct
    // access gains nothing, so their reads skip the reverse-reference lookup.
    const content = rows.filter(row => isProjectSourceContentStoredKind(row.kind) && (actorAccountId === undefined
        || !resolveResourceGrantAccessFromFacts(artifactGrantFacts({ ...row, sourceReaderAccounts: [] }), actorAccountId)));
    const readersByArtifact = new Map<string, ArtifactSourceReader[]>();
    if (content.length) {
        const { readProjectSourcesCustodyInTx, resolveProjectSourcesAccessInTx, resolveProjectSourceAudiencesInTx }
            = await import('@/app/projects/sources/projectSourceService');
        const byId = new Map(content.map(row => [row.id, row]));
        const references = (await readProjectSourceContentReferencesInTx(tx, { artifactIds: content.map(row => row.id) }))
            .filter(reference => byId.get(reference.contentArtifactId)?.kind === reference.expectedStoredKind);
        const sourceIds = [...new Set(references.map(reference => reference.projectSourceId))];
        const sources = actorAccountId === undefined ? await readProjectSourcesCustodyInTx(tx, sourceIds)
            : new Map([...(await resolveProjectSourcesAccessInTx(tx, actorAccountId, sourceIds))]
                .flatMap(([id, admission]) => admission.ok ? [[id, { source: admission.source, owner: admission.owner }] as const] : []));
        const sourceValues = [...sources.values()];
        const audiences = actorAccountId === undefined
            ? await resolveProjectSourceAudiencesInTx(tx, sourceValues.map(value => value.source))
            : sourceValues.map(() => [actorAccountId]);
        const audienceBySource = new Map(sourceValues.map((value, index) => [value.source.id, audiences[index]!]));
        const accountControlled = new Map<string, Set<string>>();
        const controlledIds = [...new Set(references.filter(reference => {
            const source = sources.get(reference.projectSourceId);
            return source?.owner.kind === 'account' && reference.expectedStoredKind === DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1
                && source.owner.accountId !== byId.get(reference.contentArtifactId)!.accountId;
        }).map(reference => reference.contentArtifactId))];
        for (const ids of portableQueryChunks({ values: controlledIds, bindingsPerValue: 1, fixedBindings: 2 })) {
            const accountGrants = await tx.artifactAccountGrant.findMany({ where: { artifactId: { in: [...ids] }, accessLevel: 'admin' },
                select: { artifactId: true, accountId: true } });
            for (const grant of accountGrants) {
                const accounts = accountControlled.get(grant.artifactId) ?? new Set<string>();
                accounts.add(grant.accountId);
                accountControlled.set(grant.artifactId, accounts);
            }
        }
        const accountIdsByArtifact = new Map<string, Set<string>>();
        for (const reference of references) {
            const source = sources.get(reference.projectSourceId);
            if (!source) continue;
            const artifact = byId.get(reference.contentArtifactId)!;
            const owner = source.owner;
            const controls = owner.kind === 'team' ? artifact.teamGrants.some(grant => grant.teamId === owner.teamId
                && projectSourceContentTeamCustodyLevels(reference.expectedStoredKind).includes(grant.accessLevel)
                && grant.team.archivedAt === null)
                : owner.accountId === artifact.accountId || reference.expectedStoredKind === DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1
                    && accountControlled.get(artifact.id)?.has(owner.accountId);
            if (!controls) continue;
            const accounts = accountIdsByArtifact.get(artifact.id) ?? new Set<string>();
            for (const accountId of audienceBySource.get(source.source.id) ?? []) accounts.add(accountId);
            accountIdsByArtifact.set(artifact.id, accounts);
        }
        const accountsById = new Map<string, { id: string; status: AccountStatus }>();
        for (const ids of portableQueryChunks({ values: [...new Set([...accountIdsByArtifact.values()].flatMap(ids => [...ids]))],
            bindingsPerValue: 1, fixedBindings: 1 })) {
            for (const account of await tx.account.findMany({ where: { id: { in: [...ids] } }, select: { id: true, status: true } })) {
                accountsById.set(account.id, account);
            }
        }
        for (const [artifactId, accountIds] of accountIdsByArtifact) {
            readersByArtifact.set(artifactId, [...accountIds].flatMap(accountId => {
                const account = accountsById.get(accountId);
                return account ? [{ accountId, account: { status: account.status } }] : [];
            }));
        }
    }
    return rows.map(row => ({ ...row, sourceReaderAccounts: readersByArtifact.get(row.id) ?? [] }));
}
