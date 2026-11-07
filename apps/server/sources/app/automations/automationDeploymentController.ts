import { afterTx, type Tx } from '@/storage/inTx';
import { parseAutomationObservationOnlyDefinitionV1 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { acquireWorkflowPublicationLocksInTx } from '@/app/workflows/acquireWorkflowPublicationLocksInTx';
import type { DeploymentAuthentication } from '@/app/deployments/deploymentAdmission';
import { replaceAutomationAssignmentsTx } from './automationAssignmentService';
import { emitAutomationMutationAfterTx, loadAutomationTx, markAutomationChangedTx } from './automationCrudService';
import { ensureAutomationEventCatalogStateTx } from './automationEnabledTransition';
import { emitAutomationAssignmentUpdated } from './automationChangePublisher';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveCurrentClaimablePluginMachineMaterializationsTx } from '@/app/plugins/availability/operations';

/** Environment CAS moves future definition assignments; admitted Run assignments remain immutable. */
export async function reassignDeploymentEnvironmentAutomationsInTx(tx: Tx, actorAccountId: string,
    environmentId: string, controllerMachineId: string, authentication: DeploymentAuthentication = {},
): Promise<void> {
    const rows = await tx.automation.findMany({ where: { deploymentEnvironmentId: environmentId, deletedAt: null },
        select: { id: true, accountId: true }, orderBy: { id: 'asc' } });
    if (!rows.length) return;
    await acquireWorkflowPublicationLocksInTx(tx, { accountId: actorAccountId,
        automationIds: rows.map(row => row.id),
        machineTargets: rows.map(row => ({ accountId: row.accountId, machineId: controllerMachineId })) });
    for (const row of rows) {
        const existing = await loadAutomationTx(tx, { accountId: row.accountId, automationId: row.id, lockForMutation: true });
        if (!existing || existing.deploymentEnvironmentId !== environmentId) {
            throw new Error('Locked Environment Automation changed during controller CAS');
        }
        const watcherMachines = new Set<string>();
        if (parseAutomationObservationOnlyDefinitionV1(existing.templateCiphertext)) {
            const machine = await tx.machine.findUnique({ where: { id: controllerMachineId }, select: { installationId: true } });
            const serverId = await readCurrentServerIdentityId(process.env, tx);
            let changed = false;
            for (const trigger of existing.triggers) {
                if (trigger.kind !== 'pluginEvent' || trigger.observationTransport !== 'checkpointedPull' || !trigger.eventPluginId) continue;
                const materializations = serverId && machine?.installationId
                    ? await resolveCurrentClaimablePluginMachineMaterializationsTx({ tx, accountId: row.accountId,
                        serverIdentityId: serverId, machineId: controllerMachineId,
                        machineInstallationId: machine.installationId, pluginId: trigger.eventPluginId }) : [];
                const current = materializations.length === 1 ? materializations[0] : undefined;
                const watcher = { watcherMachineId: current ? controllerMachineId : null,
                    watcherMachineInstallationId: current ? machine?.installationId ?? null : null,
                    watcherPluginId: current?.pluginId ?? null, watcherMaterializationId: current?.materializationId ?? null };
                if (trigger.watcherMachineId === watcher.watcherMachineId
                    && trigger.watcherMachineInstallationId === watcher.watcherMachineInstallationId
                    && trigger.watcherPluginId === watcher.watcherPluginId
                    && trigger.watcherMaterializationId === watcher.watcherMaterializationId) continue;
                if (trigger.watcherMachineId) watcherMachines.add(trigger.watcherMachineId);
                watcherMachines.add(controllerMachineId);
                await tx.automationTrigger.update({ where: { id: trigger.id }, data: { ...watcher, updatedAt: trigger.updatedAt } });
                changed = true;
            }
            if (!changed) continue;
            await ensureAutomationEventCatalogStateTx({ tx, accountId: row.accountId, projectionChanged: true });
        } else {
            if (existing.assignments.every(assignment => assignment.machineId === controllerMachineId)) continue;
            const assignments = existing.assignments.map(assignment => ({ ...assignment, machineId: controllerMachineId }));
            await replaceAutomationAssignmentsTx({ tx, accountId: row.accountId, actorAccountId, authentication,
                automationId: row.id, templateCiphertext: existing.templateCiphertext, assignments });
        }
        const changed = await tx.automation.updateMany({ where: { id: row.id, deploymentEnvironmentId: environmentId,
            deletedAt: null, templateVersion: existing.templateVersion }, data: { updatedAt: new Date() } });
        if (changed.count !== 1) throw new Error('Locked Environment Automation changed during assignment CAS');
        const automation = await loadAutomationTx(tx, { accountId: row.accountId, automationId: row.id });
        if (!automation) throw new Error('Environment Automation disappeared after assignment CAS');
        const cursor = await markAutomationChangedTx(tx, { accountId: row.accountId, automationId: row.id });
        emitAutomationMutationAfterTx({ tx, accountId: row.accountId, automation, cursor,
            previousAssignments: existing.assignments });
        afterTx(tx, () => {
            for (const machineId of watcherMachines) emitAutomationAssignmentUpdated({ accountId: row.accountId,
                machineId, automationId: row.id, enabled: machineId === controllerMachineId && automation.enabled,
                cursor: cursor.resolveCursor(), updatedAt: automation.updatedAt });
        });
    }
}
