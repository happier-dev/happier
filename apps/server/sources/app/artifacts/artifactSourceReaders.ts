import type { ResourceAccessLevelV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import { projectResourceGrantRows } from '@/app/teams/resourceGrantAccess';
import { DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol';
import type { AccountStatus } from '@/storage/enums.generated';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { isProjectSourceContentStoredKind, projectSourceContentTeamCustodyLevels,
    readProjectSourceContentReferencesInTx, projectSourceSetupContentReference,
    mayPublishProjectSourceSetupArtifact } from '@/app/projects/sources/projectSourceContentReferences';
import { PROJECT_SETUP_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/projects/projectSetupV1';
import { resolveResourceGrantAccessFromFacts } from '@/app/teams/resourceGrantAccess';
import { artifactGrantFacts, type StoredArtifactAccessFacts } from './artifactGrantStorageAdapter';
import type { ProjectSourceOwnerV1, ProjectSourcePublicationPatchV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ProjectSourceContentReference } from '@/app/projects/sources/projectSourceContentReferences';

type ArtifactIdentity = StoredArtifactAccessFacts;

export interface ArtifactSourceReader {
    readonly accountId: string;
    readonly account: Readonly<{ status: AccountStatus }>;
}

/** Actual Source content references confer read access only while their owning custody holds. */
export function projectArtifactSourceReadersFromFacts<T extends Readonly<{ accountId: string }>>(input: Readonly<{
    artifact: Pick<StoredArtifactAccessFacts, 'id' | 'kind' | 'accountId'> & Readonly<{
        grants: readonly Readonly<{ principalKind: string; accountId: string | null; teamId: string | null;
            teamGroupId: string | null; accessLevel: ResourceAccessLevelV1;
            team?: Readonly<{ archivedAt: unknown }> | null }>[];
    }>;
    reference: Pick<ProjectSourceContentReference, 'projectSourceId' | 'contentArtifactId' | 'expectedStoredKind'>;
    admittedSource: Readonly<{ source: Readonly<{ id: string }>; owner: ProjectSourceOwnerV1 }>;
    readers: readonly T[];
}>): readonly T[] {
    const { artifact, reference, admittedSource: { source, owner } } = input;
    if (source.id !== reference.projectSourceId || artifact.id !== reference.contentArtifactId
        || artifact.kind !== reference.expectedStoredKind || !isProjectSourceContentStoredKind(artifact.kind)) return [];
    const grants = projectResourceGrantRows(artifact.grants);
    // Setup's protected parent relation is admitted once by the attachment writer.
    const controls = artifact.kind === PROJECT_SETUP_ARTIFACT_STORED_KIND_V1 || (owner.kind === 'team' ? grants.teamGrants.some(grant => grant.teamId === owner.teamId
        && projectSourceContentTeamCustodyLevels(reference.expectedStoredKind).includes(grant.accessLevel)
        && grant.team.archivedAt === null)
        : owner.accountId === artifact.accountId || reference.expectedStoredKind === DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1
            && grants.accountGrants.some(grant => grant.accountId === owner.accountId && grant.accessLevel === 'admin'));
    return controls ? input.readers : [];
}

/** Source supplies read access only to its actual, privately held deployment content. */
export async function withArtifactSourceReadersInTx<T extends ArtifactIdentity>(tx: Tx, rows: readonly T[], actorAccountId?: string,
    projectSourceId?: string,
) {
    // Source audience adds only view access. A caller who already holds direct
    // access gains nothing, so their reads skip the reverse-reference lookup.
    const content = rows.filter(row => row.kind !== PROJECT_SETUP_ARTIFACT_STORED_KIND_V1 && isProjectSourceContentStoredKind(row.kind) && (actorAccountId === undefined
        || !resolveResourceGrantAccessFromFacts(artifactGrantFacts({ ...row, sourceReaderAccounts: [] }), actorAccountId)));
    const readersByArtifact = new Map<string, ArtifactSourceReader[]>();
    let selectedReference: ProjectSourceContentReference | null = null;
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
        for (const ids of portableQueryChunks({ values: controlledIds, bindingsPerValue: 1, fixedBindings: 3 })) {
            const accountGrants = await tx.artifactGrant.findMany({ where: { principalKind: 'account', artifactId: { in: [...ids] }, accessLevel: 'admin' },
                select: { artifactId: true, accountId: true } });
            for (const grant of accountGrants) {
                const accounts = accountControlled.get(grant.artifactId) ?? new Set<string>();
                accounts.add(grant.accountId!);
                accountControlled.set(grant.artifactId, accounts);
            }
        }
        const accountIdsByArtifact = new Map<string, Set<string>>();
        for (const reference of references) {
            const source = sources.get(reference.projectSourceId);
            if (!source) continue;
            const artifact = byId.get(reference.contentArtifactId)!;
            const readers = projectArtifactSourceReadersFromFacts({
                artifact: { ...artifact, grants: [...artifact.grants,
                    ...[...(accountControlled.get(artifact.id) ?? [])].map(accountId => ({ principalKind: 'account', accountId, teamId: null, teamGroupId: null,
                        accessLevel: 'admin' as const }))] },
                reference, admittedSource: source,
                readers: (audienceBySource.get(source.source.id) ?? []).map(accountId => ({ accountId })),
            });
            const accounts = accountIdsByArtifact.get(artifact.id) ?? new Set<string>();
            for (const { accountId } of readers) accounts.add(accountId);
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
    if (projectSourceId && actorAccountId && rows.some(row => row.kind === PROJECT_SETUP_ARTIFACT_STORED_KIND_V1)) {
        const { resolveProjectSourceAccessInTx } = await import('@/app/projects/sources/projectSourceService');
        const admitted = await resolveProjectSourceAccessInTx(tx, actorAccountId, projectSourceId);
        if (admitted.ok) {
            const reference = projectSourceSetupContentReference(admitted.source);
            selectedReference = reference;
            for (const artifact of rows) if (reference && artifact.kind === PROJECT_SETUP_ARTIFACT_STORED_KIND_V1) {
                readersByArtifact.set(artifact.id, projectArtifactSourceReadersFromFacts({ artifact, reference,
                    admittedSource: admitted, readers: [{ accountId: actorAccountId, account: { status: 'active' as const } }] }).slice());
            }
        }
    }
    return rows.map(row => ({ ...row, sourceReaderAccounts: readersByArtifact.get(row.id) ?? [],
        ...(selectedReference?.contentArtifactId === row.id ? { projectSourceContentReference: selectedReference } : {}) }));
}

/** The sharing owner prepares an owned draft, or content already held by the selected Source. */
export async function readArtifactSourcePublicationReadersInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; artifact: ArtifactIdentity; projectSourceId: string; projectSourcePatch?: ProjectSourcePublicationPatchV1;
}>): Promise<readonly ArtifactSourceReader[] | null> {
    if (input.artifact.kind !== PROJECT_SETUP_ARTIFACT_STORED_KIND_V1) return null;
    const { resolveProjectSourceAccessInTx, resolveProjectSourceAudiencesInTx, prepareProjectSourcePublicationInTx } = await import('@/app/projects/sources/projectSourceService');
    const admitted = await resolveProjectSourceAccessInTx(tx, input.actorAccountId, input.projectSourceId);
    if (!admitted.ok) return null;
    const attached = projectSourceSetupContentReference(admitted.source);
    if (attached?.contentArtifactId !== input.artifact.id
        && (!admitted.canManage || !mayPublishProjectSourceSetupArtifact(input.actorAccountId, input.artifact.accountId))) return null;
    const publication = input.projectSourcePatch
        ? await prepareProjectSourcePublicationInTx(tx, input.actorAccountId, admitted, input.projectSourcePatch) : admitted;
    if (!publication.ok) return null;
    const [audience = []] = await resolveProjectSourceAudiencesInTx(tx, [publication.source]);
    const accounts = await tx.account.findMany({ where: { id: { in: audience } }, select: { id: true, status: true } });
    return projectArtifactSourceReadersFromFacts({ artifact: input.artifact,
        reference: { projectSourceId: admitted.source.id, contentArtifactId: input.artifact.id, expectedStoredKind: PROJECT_SETUP_ARTIFACT_STORED_KIND_V1 },
        admittedSource: publication, readers: accounts.map(account => ({ accountId: account.id, account: { status: account.status } })) });
}
