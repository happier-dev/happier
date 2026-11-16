import { z } from 'zod/mini';
import { DeploymentDomainCapturedPlacementsV1Schema } from '@happier-dev/protocol';
import type { DeploymentDomainAddPreparedInputV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { DeploymentOwnServerTargetMachinesV1Schema } from '@happier-dev/protocol/deployments/deploymentEnvironmentCreateV1';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { isDeploymentMembershipActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { Tx } from '@/storage/inTx';
import { readAcceptedDeploymentReceiptInTx } from './deploymentAcceptedExecution';

/** Native selection is admitted once and retained in the existing receipt until signed settlement. */
export const deploymentTeardownMembershipAdmissionSchema = z.object({ admittedMachines: DeploymentOwnServerTargetMachinesV1Schema });
type Member = Readonly<{ machineId: string; installationId: string }>;
/** Reconcile only an existing Domain, using the exact accepted receipt and its native selection. */
export async function readDeploymentMembershipAdmissionInTx(tx: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, input: DeploymentDomainAddPreparedInputV1,
) {
    if (!isDeploymentMembershipActionIdV1(binding.actionId, binding.deploymentPreparationAdmission)
        || !input.membershipDeploymentId || !input.membershipMachines) return null;
    const receipt = await readAcceptedDeploymentReceiptInTx(tx, binding, undefined, {
        id: input.membershipDeploymentId, environmentId: input.environmentId, targetLinkId: input.targetLinkId,
        state: { in: ['queued', 'running'] }, cancelRequestedAt: null,
    });
    if (!receipt) return null;
    const link = await tx.deploymentTargetLink.findFirst({ where: { id: receipt.targetLinkId,
        environmentId: receipt.environmentId, role: 'runtime', sourceKind: 'host', targetKind: 'ownServer',
        revision: input.expectedTargetLinkRevision, deletedAt: null, detachedAt: null,
        environment: { runtimeTargetLinkId: receipt.targetLinkId } }, include: { machines: true } });
    const domain = await tx.deploymentDomain.findFirst({ where: { id: input.domainId, environmentId: receipt.environmentId,
        deletedAt: null, contentArtifactId: input.contentArtifactId,
        contentHeaderVersion: input.contentHeaderVersion, contentBodyVersion: input.contentBodyVersion } });
    if (!link || !domain || input.expectedDomainRevision === undefined || domain.state === 'removing') return null;
    const selection = receipt.operation === 'teardown' ? deploymentTeardownMembershipAdmissionSchema.safeParse(receipt.teardownProof) : null;
    if (selection && !selection.success) return null;
    const members = link.machines.filter(member => !selection?.success || !selection.data.admittedMachines.some(removed =>
        removed.machineId === member.machineId && removed.installationId === member.installationId));
    if (members.length === 0 || input.membershipMachines.length !== members.length
        || members.some(member => !input.membershipMachines!.some(selected => selected.machineId === member.machineId
            && selected.installationId === member.installationId))) return null;
    return { receipt, link, domain, members };
}

/** Signed Domain settlement owns route readiness; the receipt owner consumes the persisted result once. */
export async function haveDeploymentMembershipRoutesInTx(tx: Tx, input: Readonly<{
    environmentId: string; targetLinkId: string; members: readonly Member[]; mode: 'join' | 'drain';
}>) {
    const domains = await tx.deploymentDomain.findMany({ where: { environmentId: input.environmentId, deletedAt: null },
        select: { state: true, capturedPlacements: true } });
    return domains.every(domain => {
        const parsed = DeploymentDomainCapturedPlacementsV1Schema.safeParse(domain.capturedPlacements);
        if (!parsed.success || parsed.data.length === 0) return false;
        if (input.mode === 'drain') return parsed.data.every(capture => !input.members.some(member =>
            member.machineId === capture.placement.machineId && member.installationId === capture.placement.installationId));
        return domain.state === 'active' && parsed.data.every(capture => capture.desired)
            && input.members.every(member => parsed.data.some(capture => capture.placement.targetLinkId === input.targetLinkId
                && capture.placement.machineId === member.machineId && capture.placement.installationId === member.installationId));
    });
}
