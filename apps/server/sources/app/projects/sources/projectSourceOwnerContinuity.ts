import type { ProjectSourceV1, ProjectSourceOwnerV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readArtifactRecipientCensusInTx } from '@/app/artifacts/artifactAccessService';
import { readProjectDeploymentDefaultsContentInTx } from '@/app/projects/projectDeploymentDefaultsService';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { readSavedSecretResourcesForPrincipalInTx, validateSavedSecretResourceReferenceCapturesV1 } from '@/app/account/savedSecrets/savedSecretResourceService';
import { admitDeploymentMachinesInTx } from '@/app/deployments/deploymentAdmission';
import { deploymentInProgressStates, readDeploymentAcceptedExecution } from '@/app/deployments/deploymentAcceptedExecution';
import { hasCompleteTeardownInTx } from '@/app/deployments/deploymentDispositionService';
import { readDeploymentEnvironmentRequiredSecretUsesInTx } from '@/app/deployments/deploymentEnvironmentService';
import { readEnvironmentMachineSecretGrantsInTx } from '@/app/deployments/environmentSecretGrantRepository';
import { admitDeploymentStoredContentsInTx } from '@/app/deployments/deploymentStoredContent';
import type { Tx } from '@/storage/inTx';
import { resolveProjectSourceAudienceInTx } from './projectSourceService';

async function recipientsReadyInTx(tx: Tx, actorAccountId: string, artifactId: string, audience: readonly string[]) {
    const census = await readArtifactRecipientCensusInTx(tx, { actorAccountId,
        artifactId });
    if (!census.ok) return false;
    const recipients = new Map(census.value.recipients.map(recipient => [recipient.recipientAccountId, recipient]));
    return audience.every(accountId => {
        const recipient = recipients.get(accountId);
        return recipient !== undefined && (census.value.encryptionMode === 'plain'
            || recipient.encryptedDataKey !== null && (census.value.provenanceDataEncryptionKey === null
                || recipient.encryptedProvenanceDataKey !== null));
    });
}

/** Existing Source CAS consumes prepared custody; it never copies grants, content or CI authority. */

export async function hasProjectSourceOwnerContinuityInTx(tx: Tx, actorAccountId: string,
    input: Readonly<{ source: ProjectSourceV1; owner: ProjectSourceOwnerV1 }>,
): Promise<boolean> {
    const content = { contentArtifactId: true, contentHeaderVersion: true, contentBodyVersion: true } as const;
    const [defaults, environments] = await Promise.all([
        readProjectDeploymentDefaultsContentInTx(tx, actorAccountId, input.source.id, input.owner),
        tx.deploymentEnvironment.findMany({ where: { projectSourceId: input.source.id }, select: {
            id: true, deletedAt: true, controllerMachineId: true, buildMachineId: true, edgeMachineId: true,
            runtimeTargetLinkId: true, referencedSavedSecretRevisions: true, ...content,
            targetLinks: { include: { machines: true } },
            deployments: { select: { state: true, acceptedControllerMachineId: true, acceptedControllerInstallationId: true,
                acceptedBuildMachineId: true, acceptedBuildInstallationId: true, ...content } },
        } }),
    ]);
    if (!defaults.ok) return false;
    if (!defaults.content && !environments.length) return true;
    const audience = await resolveProjectSourceAudienceInTx(tx, [input.source]);
    if (defaults.content && !await recipientsReadyInTx(tx, actorAccountId, defaults.content.contentArtifactId, audience)) return false;
    const inputs: Parameters<typeof admitDeploymentStoredContentsInTx>[3][number][] = [];
    const machines: Parameters<typeof admitDeploymentMachinesInTx>[2][number][] = [];
    const active = new Set<string>(deploymentInProgressStates());
    for (const environment of environments) {
        inputs.push({ reference: environment, expectedStoredKind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, access: 'read' });
        for (const link of environment.targetLinks) {
            inputs.push({ reference: link, expectedStoredKind: DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1, access: 'read' });
            const retained = link.deletedAt !== null || link.detachedAt !== null || environment.deletedAt !== null;
            if (retained && await hasCompleteTeardownInTx(tx, link, undefined, environment.runtimeTargetLinkId)) continue;
            machines.push(...link.machines.map(member => ({ machineId: member.machineId,
                installationId: member.installationId, role: 'target' as const })));
            if (link.machineId) machines.push({ machineId: link.machineId, role: 'target',
                ...(link.installationId ? { installationId: link.installationId } : {}) });
        }
        for (const receipt of environment.deployments) {
            inputs.push({ reference: receipt, expectedStoredKind: DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1, access: 'read' });
            if (active.has(receipt.state)) {
                const accepted = readDeploymentAcceptedExecution(receipt);
                if (!accepted) return false;
                machines.push({ ...accepted.controller, role: 'controller' },
                    ...(accepted.builder ? [{ ...accepted.builder, role: 'build' as const }] : []));
            }
        }
        if (environment.deletedAt !== null) continue;
        machines.push({ machineId: environment.controllerMachineId, role: 'controller' });
        if (environment.buildMachineId) machines.push({ machineId: environment.buildMachineId, role: 'build' });
        if (environment.edgeMachineId) machines.push({ machineId: environment.edgeMachineId, role: 'target' });
        const required = await readDeploymentEnvironmentRequiredSecretUsesInTx(tx, environment);
        if (required.status !== 'complete') return false;
        if (!required.requiredSecretUses.length) continue;
        let grants: Awaited<ReturnType<typeof readEnvironmentMachineSecretGrantsInTx>>;
        try { grants = await readEnvironmentMachineSecretGrantsInTx(tx, { environmentId: environment.id }); }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'secret_missing') return false;
            throw error;
        }
        if (required.requiredSecretUses.some(use => !grants.some(grant => grant.kind === 'secret'
            && grant.resourceId === use.resourceId && grant.resourceRevision === use.resourceRevision
            && grant.machineId === use.machineId && grant.installationId === use.installationId))) return false;
        const revisions = new Map(required.requiredSecretUses.map(use => [use.resourceId, use.resourceRevision]));
        const resources = await readSavedSecretResourcesForPrincipalInTx(tx, input.owner, [...revisions.keys()]);
        if (!validateSavedSecretResourceReferenceCapturesV1(resources, {
            references: [...revisions.keys()].map(formatSharedSavedSecretRefV1),
            savedSecretRevisions: [...revisions].map(([resourceId, expectedRevision]) => ({ resourceId, expectedRevision })),
        })) return false;
    }
    if (await admitDeploymentMachinesInTx(tx, input.owner, machines)) return false;
    if ((await admitDeploymentStoredContentsInTx(tx, actorAccountId, input.owner, inputs)).some(Boolean)) return false;
    for (const artifactId of new Set(inputs.map(input => input.reference.contentArtifactId))) {
        if (!await recipientsReadyInTx(tx, actorAccountId, artifactId, audience)) return false;
    }
    return true;
}
