import type { DeploymentEnvironmentControllerSetInputV1 } from '@happier-dev/protocol';
import type { Tx } from '@/storage/inTx';
import { admitDeploymentMachineInTx, admitDeploymentDefinitionMachinesInTx, readDeploymentDefinitionMachinesInTx, deploymentFailure, type DeploymentAuthentication } from './deploymentAdmission';
import { loadDeploymentEnvironmentInTx, lockDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { publishDeploymentChangesInTx } from './deploymentPublication';
import { reassignDeploymentEnvironmentAutomationsInTx } from '@/app/automations/automationDeploymentController';

/** Change future controller placement under current Source authority without dispatching or moving existing work. */
export async function setDeploymentEnvironmentControllerInTx(tx: Tx, actorAccountId: string,
    input: DeploymentEnvironmentControllerSetInputV1, authentication: DeploymentAuthentication = {},
) {
    await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    const loaded = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!loaded.ok) return loaded;
    if (loaded.row.deletedAt || !loaded.admission.canManage) return deploymentFailure('deployment_access_denied');
    if (loaded.row.revision !== input.expectedRevision) return deploymentFailure('deployment_conflict');
    if (loaded.row.controllerMachineId === input.controllerMachineId) {
        const machineFailure = await admitDeploymentMachineInTx(tx, loaded.admission.owner, input.controllerMachineId, 'controller');
        if (machineFailure) return machineFailure;
        await reassignDeploymentEnvironmentAutomationsInTx(tx, actorAccountId, loaded.row.id, input.controllerMachineId, authentication);
        return { ok: true as const, environmentId: loaded.row.id, revision: loaded.row.revision };
    }
    const machineFailure = await admitDeploymentDefinitionMachinesInTx(tx, actorAccountId, loaded.admission.owner,
        await readDeploymentDefinitionMachinesInTx(tx, { ...loaded.row, controllerMachineId: input.controllerMachineId }));
    if (machineFailure) return machineFailure;
    const changed = await tx.deploymentEnvironment.updateMany({ where: { id: loaded.row.id, revision: input.expectedRevision },
        data: { controllerMachineId: input.controllerMachineId, revision: { increment: 1 } } });
    if (changed.count !== 1) throw new Error('Locked deployment Environment changed during controller CAS');
    await reassignDeploymentEnvironmentAutomationsInTx(tx, actorAccountId, loaded.row.id, input.controllerMachineId, authentication);
    await publishDeploymentChangesInTx(tx, loaded.admission, loaded.row.id, loaded.row.revision + 1);
    return { ok: true as const, environmentId: loaded.row.id, revision: loaded.row.revision + 1 };
}
