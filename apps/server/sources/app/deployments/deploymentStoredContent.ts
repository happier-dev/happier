import { DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, type DeploymentEnvironmentCreateInputV1, type DeploymentPendingDeployV1 } from '@happier-dev/protocol';
import { readArtifactForCallerInTx, readArtifactHeadersForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { decodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { type Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { deploymentFailure, type DeploymentFailure } from './deploymentAdmission';
import type { ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

export type DeploymentContentReference = Pick<DeploymentEnvironmentCreateInputV1, 'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'>;

type AdmittedArtifact = Extract<Awaited<ReturnType<typeof readArtifactForCallerInTx>>, { ok: true }>['artifact'];


async function contentAuthorityFailure(tx: Tx, artifact: AdmittedArtifact, owner: ProjectSourceOwnerV1, expectedStoredKind: string,
    access: 'read' | 'write', ownerControlsContent?: boolean,
): Promise<DeploymentFailure | null> {
    // A deployer may author a receipt for an Account-owned Environment. Its
    // owning Account retains admin, just as an owning Team does; definitions
    // still require the incumbent owning Account's Artifact.
    const ownsContent = owner.kind === 'account' ? artifact.ownerAccountId === owner.accountId
        || expectedStoredKind === DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1
            && (ownerControlsContent ?? await tx.artifactAccountGrant.findFirst({ where: { artifactId: artifact.id,
                accountId: owner.accountId, accessLevel: 'admin' }, select: { artifactId: true } }) !== null)
        : ownerControlsContent ?? await tx.artifactTeamGrant.findFirst({ where: { artifactId: artifact.id, teamId: owner.teamId,
            accessLevel: 'admin', team: { archivedAt: null } }, select: { artifactId: true } }) !== null;
    if (!ownsContent || artifact.publicAudience !== 'none'
        || (access === 'write' && artifact.access === 'view')) return deploymentFailure('deployment_content_unavailable');
    const expected = decodeArtifactKindV1(expectedStoredKind);
    return artifact.kind !== expected.kind || artifact.kindHint !== expected.kindHint
        ? deploymentFailure('deployment_content_unavailable') : null;
}

/** Before receipt admission, review reads one exact candidate's current header without opening its body. */

export async function admitDeploymentStoredContentsInTx(tx: Tx, actorAccountId: string, owner: ProjectSourceOwnerV1,
    inputs: readonly Readonly<{ reference: DeploymentContentReference; expectedStoredKind: string;
        access?: 'read' | 'write'; pendingDeploy?: DeploymentPendingDeployV1 }>[],
): Promise<(DeploymentFailure | null)[]> {
    const ids = [...new Set(inputs.map(input => input.reference.contentArtifactId))];
    const reads = new Map((await readArtifactHeadersForCallerInTx(tx, { actorAccountId, artifactIds: ids }))
        .map(item => [item.artifactId, item.read]));
    const ownerControlled = new Set<string>();
    if (owner.kind === 'team') {
        for (const artifactIds of portableQueryChunks({ values: ids, bindingsPerValue: 1, fixedBindings: 3 })) {
            const grants = await tx.artifactTeamGrant.findMany({ where: { artifactId: { in: [...artifactIds] },
                teamId: owner.teamId, accessLevel: 'admin', team: { archivedAt: null } }, select: { artifactId: true } });
            for (const grant of grants) ownerControlled.add(grant.artifactId);
        }
    } else {
        const receiptIds = [...new Set(inputs.filter(input => {
            const read = reads.get(input.reference.contentArtifactId);
            return input.expectedStoredKind === DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1
                && read?.ok && read.artifact.ownerAccountId !== owner.accountId;
        }).map(input => input.reference.contentArtifactId))];
        for (const artifactIds of portableQueryChunks({ values: receiptIds, bindingsPerValue: 1, fixedBindings: 2 })) {
            const grants = await tx.artifactAccountGrant.findMany({ where: { artifactId: { in: [...artifactIds] },
                accountId: owner.accountId, accessLevel: 'admin' }, select: { artifactId: true } });
            for (const grant of grants) ownerControlled.add(grant.artifactId);
        }
    }
    const failures: (DeploymentFailure | null)[] = [];
    for (const { reference, expectedStoredKind, access = 'write', pendingDeploy } of inputs) {
        const read = reads.get(reference.contentArtifactId);
        if (!read?.ok) { failures.push(deploymentFailure('deployment_content_unavailable')); continue; }
        const authorityFailure = await contentAuthorityFailure(tx, read.artifact, owner, expectedStoredKind, access,
            ownerControlled.has(read.artifact.id));
        if (authorityFailure) { failures.push(authorityFailure); continue; }
        if (pendingDeploy && (read.artifact.encryptionMode === 'plain') !== (pendingDeploy.t === 'plain')) {
            failures.push(deploymentFailure('deployment_content_unavailable')); continue;
        }
        failures.push(read.artifact.headerVersion !== reference.contentHeaderVersion || read.artifact.bodyVersion !== reference.contentBodyVersion
            ? deploymentFailure('deployment_conflict') : null);
    }
    return failures;
}


export function deploymentContentReference(input: DeploymentContentReference): DeploymentContentReference {
    return { contentArtifactId: input.contentArtifactId, contentHeaderVersion: input.contentHeaderVersion, contentBodyVersion: input.contentBodyVersion };
}

/** Plain content is inspectable through the incumbent Artifact envelopes; E2EE stays opaque. */
