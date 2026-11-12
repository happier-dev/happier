import { DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1,
    type ArtifactJsonUpdateHttpInputV1, type DeploymentEnvironmentCreateInputV1, type DeploymentPendingDeployV1 } from '@happier-dev/protocol';
import * as privacyKit from 'privacy-kit';
import { readArtifactForCallerInTx, readArtifactHeadersForCallerInTx, resolveArtifactAudienceInTx,
    resolveArtifactPublicationAdmissionIntent, type ArtifactForCaller } from '@/app/artifacts/artifactAccessService';
import { acquireAccountChangePublicationLocksInTx } from '@/app/changes/markAccountChanged';
import { resolveProjectSourceAudienceInTx } from '@/app/projects/sources/projectSourceService';
import { updateArtifactTx } from '@/app/artifacts/artifactWriteService';
import { decodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ArtifactHeaderMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1,
    readDeploymentEnvironmentArtifactV1, readDeploymentTargetLinkArtifactV1,
    type DeploymentArtifactReadResultV1, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol';
import { eventRouter, buildUpdateArtifactUpdate } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { afterTx, type Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { deploymentFailure, type DeploymentFailure, type DeploymentSourceAdmission } from './deploymentAdmission';
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
    return projectDeploymentStoredContentAuthority(artifact, owner, expectedStoredKind, access, ownsContent);
}

/** Captured readers use the same custody, visibility, access and kind decision as ordinary reads. */
export function projectDeploymentStoredContentAuthority(artifact: AdmittedArtifact, owner: ProjectSourceOwnerV1,
    expectedStoredKind: string, access: 'read' | 'write', ownerControlsContent: boolean,
): DeploymentFailure | null {
    const ownsContent = owner.kind === 'account' ? artifact.ownerAccountId === owner.accountId
        || expectedStoredKind === DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 && ownerControlsContent : ownerControlsContent;
    if (!ownsContent || artifact.publicAudience !== 'none'
        || (access === 'write' && artifact.access === 'view')) return deploymentFailure('deployment_content_unavailable');
    const expected = decodeArtifactKindV1(expectedStoredKind);
    return artifact.kind !== expected.kind || artifact.kindHint !== expected.kindHint
        ? deploymentFailure('deployment_content_unavailable') : null;
}

/** Before receipt admission, review reads one exact candidate's current header without opening its body. */
export async function admitDeploymentCandidateContentInTx(tx: Tx, actorAccountId: string, owner: ProjectSourceOwnerV1,
    artifactId: string, expectedStoredKind: string,
): Promise<DeploymentFailure | null> {
    const read = await readArtifactForCallerInTx(tx, { actorAccountId, artifactId, projection: 'headers' });
    return read.ok ? contentAuthorityFailure(tx, read.artifact, owner, expectedStoredKind, 'read')
        : deploymentFailure('deployment_content_unavailable');
}

/** Bind the existing Artifact head atomically without opening a private body or writing another content store. */
export async function admitDeploymentStoredContentInTx(tx: Tx, actorAccountId: string, owner: ProjectSourceOwnerV1,
    reference: DeploymentContentReference, expectedStoredKind: string, access: 'read' | 'write' = 'write',
    pendingDeploy?: DeploymentPendingDeployV1,
): Promise<DeploymentFailure | null> {
    return (await admitDeploymentStoredContentsInTx(tx, actorAccountId, owner,
        [{ reference, expectedStoredKind, access, pendingDeploy }]))[0]!;
}

/** One finite parent read admits its exact Artifact heads together, retaining each reference's failure. */
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
        failures.push(projectDeploymentStoredContentRevision(read.artifact, reference));
    }
    return failures;
}

export function deploymentContentReference(input: DeploymentContentReference): DeploymentContentReference {
    return { contentArtifactId: input.contentArtifactId, contentHeaderVersion: input.contentHeaderVersion, contentBodyVersion: input.contentBodyVersion };
}

/** Current-head references share one exact revision decision across admission and projection. */
export function projectDeploymentStoredContentRevision(artifact: Readonly<{ headerVersion: number; bodyVersion: number }>,
    reference: DeploymentContentReference,
): DeploymentFailure | null {
    return artifact.headerVersion !== reference.contentHeaderVersion || artifact.bodyVersion !== reference.contentBodyVersion
        ? deploymentFailure('deployment_conflict') : null;
}

/** Plain content is inspectable through the incumbent Artifact envelopes; E2EE stays opaque. */
async function readPlainDeploymentContentInTx<T>(tx: Tx, actorAccountId: string, owner: ProjectSourceOwnerV1,
    reference: DeploymentContentReference, expectedStoredKind: string,
    open: (reference: DeploymentContentReference, artifact: DeploymentArtifactDocumentV1) => DeploymentArtifactReadResultV1<T>,
): Promise<Readonly<{ ok: true; content: T | null }> | DeploymentFailure> {
    const read = await readArtifactForCallerInTx(tx, { actorAccountId, artifactId: reference.contentArtifactId });
    if (!read.ok) return deploymentFailure('deployment_content_unavailable');
    const authorityFailure = await contentAuthorityFailure(tx, read.artifact, owner, expectedStoredKind, 'write');
    if (authorityFailure) return authorityFailure;
    return projectPlainDeploymentStoredContent(read.artifact, reference, open);
}

/** Exact current-head projection shared by transaction reads and composed SQL captures after custody admission. */
export function projectPlainDeploymentStoredContent<T>(artifact: ArtifactForCaller & Readonly<{ publicAudience: 'retained' | 'none' }>, reference: DeploymentContentReference,
    open: (reference: DeploymentContentReference, artifact: DeploymentArtifactDocumentV1) => DeploymentArtifactReadResultV1<T>,
): Readonly<{ ok: true; content: T | null }> | DeploymentFailure {
    const revisionFailure = projectDeploymentStoredContentRevision(artifact, reference);
    if (revisionFailure) return revisionFailure;
    if (artifact.encryptionMode === 'e2ee') return { ok: true, content: null };
    const header = ArtifactHeaderMetadataV1Schema.safeParse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(artifact.header)));
    const body = ArtifactBodyEnvelopeV1StoredSchema.safeParse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(artifact.body)));
    if (!header.success || !body.success) return deploymentFailure('deployment_content_unavailable');
    const opened = open(reference, { artifactId: artifact.id,
        revision: { headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion },
        header: header.data, body: body.data.body });
    return opened.ok ? { ok: true, content: opened.content } : deploymentFailure(opened.error);
}

export function readPlainDeploymentEnvironmentContentInTx(tx: Tx, actorAccountId: string, owner: ProjectSourceOwnerV1, reference: DeploymentContentReference) {
    return readPlainDeploymentContentInTx(tx, actorAccountId, owner, reference,
        DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, readDeploymentEnvironmentArtifactV1);
}
export function readPlainDeploymentTargetLinkContentInTx(tx: Tx, actorAccountId: string, owner: ProjectSourceOwnerV1, reference: DeploymentContentReference) {
    return readPlainDeploymentContentInTx(tx, actorAccountId, owner, reference,
        DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1, readDeploymentTargetLinkArtifactV1);
}

/** The Artifact owner writes prepared bytes in the same transaction as the owning record CAS. */
export async function updateDeploymentStoredContentInTx(tx: Tx, actorAccountId: string,
    custody: Pick<DeploymentSourceAdmission, 'owner' | 'source'>,
    reference: DeploymentContentReference, input: ArtifactJsonUpdateHttpInputV1, expectedStoredKind: string,
) {
    const failure = await admitDeploymentStoredContentInTx(tx, actorAccountId, custody.owner, reference, expectedStoredKind);
    if (failure) return failure;
    if ((input.kind !== undefined && input.kind !== expectedStoredKind)
        || (input.header === undefined && input.body === undefined)
        || (input.header !== undefined && input.expectedHeaderVersion !== reference.contentHeaderVersion)
        || (input.body !== undefined && input.expectedBodyVersion !== reference.contentBodyVersion)
        || (input.expectedHeaderVersion !== undefined && input.expectedHeaderVersion !== reference.contentHeaderVersion)
        || (input.expectedBodyVersion !== undefined && input.expectedBodyVersion !== reference.contentBodyVersion)) {
        return deploymentFailure('deployment_conflict');
    }
    // A private content Artifact can have fewer readers than its Source. Admit
    // their complete publication cohort before the Artifact writer takes locks.
    await acquireAccountChangePublicationLocksInTx(tx, [
        ...await resolveArtifactAudienceInTx(tx, reference.contentArtifactId),
        ...await resolveProjectSourceAudienceInTx(tx, [custody.source]),
    ], { includeSingleAccount: true, intent: resolveArtifactPublicationAdmissionIntent() });
    const result = await updateArtifactTx(tx, {
        actorUserId: actorAccountId, artifactId: reference.contentArtifactId,
        expectedRevision: { headerVersion: reference.contentHeaderVersion, bodyVersion: reference.contentBodyVersion },
        expectedHeaderVersion: input.expectedHeaderVersion, kind: input.kind,
        approvalState: input.approvalState, approvalSessionId: input.approvalSessionId,
        ...(input.header === undefined ? {} : { header: { bytes: privacyKit.decodeBase64(input.header), expectedVersion: reference.contentHeaderVersion } }),
        ...(input.body === undefined ? {} : { body: { bytes: privacyKit.decodeBase64(input.body), expectedVersion: reference.contentBodyVersion } }),
        provenance: input.provenance == null ? undefined : privacyKit.decodeBase64(input.provenance),
        provenanceDataEncryptionKey: input.provenanceDataEncryptionKey == null ? undefined : privacyKit.decodeBase64(input.provenanceDataEncryptionKey),
    });
    if (!result.ok) {
        if (result.error === 'quota_exceeded') return result;
        return deploymentFailure(result.error === 'version-mismatch' ? 'deployment_conflict' : 'deployment_content_unavailable');
    }
    afterTx(tx, () => {
        for (const recipient of result.recipientUpdates) {
            eventRouter.emitUpdate({ userId: recipient.accountId,
                payload: buildUpdateArtifactUpdate(reference.contentArtifactId, recipient.cursor.resolveCursor(), randomKeyNaked(12),
                    result.header && input.header !== undefined ? { value: input.header, version: result.header.version } : undefined,
                    result.body && input.body !== undefined ? { value: input.body, version: result.body.version } : undefined, recipient),
                recipientFilter: { type: 'user-scoped-only' } });
        }
    });
    return { ok: true as const, reference: { contentArtifactId: reference.contentArtifactId,
        contentHeaderVersion: result.header?.version ?? reference.contentHeaderVersion,
        contentBodyVersion: result.body?.version ?? reference.contentBodyVersion } };
}
