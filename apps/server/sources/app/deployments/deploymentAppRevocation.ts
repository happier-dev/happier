import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { revokeMachineInTx } from '@/app/machines/machineMutations';
import { readAutomationMachineAssignmentRemovalPublicationAudienceInTx } from '@/app/automations/automationMachineAssignmentRemoval';
import { readDeploymentEnvironmentAutomationDisableAudienceInTx } from '@/app/automations/automationDeploymentEnvironment';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { resolveArtifactAudienceInTx, resolveArtifactPublicationAdmissionIntent } from '@/app/artifacts/artifactAccessService';
import { readMachineAudienceAccountIdsForMachinesInTx } from '@/app/machines/machineRecipientWork';
import { listAuthorizedAccountIdsForResourcesInTx } from '@/app/account/savedSecrets/savedSecretResourceService';

/** Disposition selects App children; the existing Machine owner withdraws their credentials and sockets. */
export async function prepareDeploymentAppMachineRevocationInTx(tx: Tx, input: Readonly<{
    environmentId: string; targetLinkId?: string;
    removedMachines?: readonly Readonly<{ machineId: string; installationId: string }>[];
    publicationAccountIds: readonly string[];
    contentArtifactId?: string;
    disableEnvironmentAutomations?: Readonly<{ observationOnly?: boolean }>;
    environmentRemoval?: Readonly<{ telemetryMachineId: string | null; savedSecretResourceIds: readonly string[] }>;
}>): Promise<() => Promise<void>> {
    const receipts = await tx.deployment.findMany({ where: { environmentId: input.environmentId,
        ...(input.targetLinkId ? { targetLinkId: input.targetLinkId } : {}) },
        select: { id: true, acceptedControllerMachineId: true, acceptedControllerInstallationId: true } });
    const ids = receipts.filter(receipt => !input.removedMachines || input.removedMachines.some(member =>
        member.machineId === receipt.acceptedControllerMachineId
        && member.installationId === receipt.acceptedControllerInstallationId)).map(receipt => receipt.id);
    const machines: { id: string; accountId: string }[] = [];
    for (const chunk of portableQueryChunks({ values: ids, bindingsPerValue: 1 })) machines.push(...await tx.machine.findMany({
        where: { deploymentAppDeploymentId: { in: [...chunk] }, revokedAt: null }, select: { id: true, accountId: true } }));
    if (!machines.length) return async () => {};
    const audiences = await Promise.all(machines.map(machine => readAutomationMachineAssignmentRemovalPublicationAudienceInTx(tx, {
        accountId: machine.accountId, machineId: machine.id,
    })));
    if (input.disableEnvironmentAutomations) {
        audiences.push(await readDeploymentEnvironmentAutomationDisableAudienceInTx(tx, input.environmentId, input.disableEnvironmentAutomations));
    }
    const telemetryAudience = input.environmentRemoval?.telemetryMachineId
        ? await readMachineAudienceAccountIdsForMachinesInTx(tx, [input.environmentRemoval.telemetryMachineId]) : new Map<string, string[]>();
    // Nested Machine/Artifact owners must consume this complete publication cohort,
    // rather than establish the first child's narrower Account admission themselves.
    await acquireSessionAccountCursorLocksInTx(tx, audiences.flatMap(audience => audience.sessionIds), [
        ...input.publicationAccountIds, ...audiences.flatMap(audience => audience.accountIds), ...[...telemetryAudience.values()].flat(),
        ...input.contentArtifactId ? await resolveArtifactAudienceInTx(tx, input.contentArtifactId) : [],
        ...input.environmentRemoval ? await listAuthorizedAccountIdsForResourcesInTx(tx, input.environmentRemoval.savedSecretResourceIds) : [],
    ], { intent: input.contentArtifactId ? resolveArtifactPublicationAdmissionIntent() : 'content' });
    return async () => {
        for (const machine of machines) await revokeMachineInTx(tx, { accountId: machine.accountId, machineId: machine.id });
    };
}
