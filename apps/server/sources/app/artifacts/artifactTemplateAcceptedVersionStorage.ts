import type { ArtifactAccessGrantRowV1, ArtifactTemplateAcceptedVersionInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import type { Tx } from '@/storage/inTx';
import { markAccountChanged } from '@/app/changes/markAccountChanged';

/** The access owner has admitted this authenticated recipient before this write. */
export async function writeAdmittedTemplateAcceptedVersionInTx(tx: Tx,
    input: ArtifactTemplateAcceptedVersionInputV1 & { actorAccountId: string; ownerAccountId: string },
): Promise<{ changed: boolean }> {
    const identity = { artifactId: input.artifactId, recipientAccountId: input.actorAccountId, copyId: input.copyId };
    const where = { artifactId_recipientAccountId_copyId: identity };
    const previous = await tx.artifactTemplateAcceptedVersion.findUnique({ where, select: { acceptedVersion: true } });
    if (previous?.acceptedVersion === input.acceptedVersion) return { changed: false };
    const data = { acceptedVersion: input.acceptedVersion, reportedAt: new Date() };
    await tx.artifactTemplateAcceptedVersion.upsert({ where, create: { ...identity, ...data }, update: data });
    await markAccountChanged(tx, { accountId: input.ownerAccountId, kind: 'artifact', entityId: input.artifactId });
    return { changed: true };
}

/** One source-scoped grouped query; private copy routing and Session content never enter the projection. */
export async function projectAdmittedTemplateAcceptedVersionsInTx(tx: Tx, artifactId: string,
    grants: readonly ArtifactAccessGrantRowV1[],
): Promise<ArtifactAccessGrantRowV1[]> {
    const reports = await tx.artifactTemplateAcceptedVersion.groupBy({
        by: ['recipientAccountId', 'acceptedVersion'], where: { artifactId },
        _count: { _all: true }, _max: { reportedAt: true }, orderBy: { acceptedVersion: 'asc' },
    });
    const byAccount = new Map<string, NonNullable<ArtifactAccessGrantRowV1['acceptedVersions']>>();
    for (const report of reports) {
        const summaries = byAccount.get(report.recipientAccountId) ?? [];
        summaries.push({ version: report.acceptedVersion, copies: report._count._all,
            reportedAt: report._max.reportedAt!.getTime() });
        byAccount.set(report.recipientAccountId, summaries);
    }
    return grants.map(grant => grant.principal.kind === 'account'
        ? { ...grant, acceptedVersions: byAccount.get(grant.principal.accountId) ?? [] } : grant);
}
