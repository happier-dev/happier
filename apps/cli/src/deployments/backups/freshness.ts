import type { z } from 'zod/mini';
import type { WorkflowTriggerListResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import type { DeploymentBackupRunInputV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import type { DeploymentBackupHistoryResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupHistoryV1';
import { createBackupSettlementNotices, readEnvironmentAlertDeliveryForHost,
    type BackupNoticeEnvironment, type BackupNoticeHost } from '../deploymentSettlementNotices';

export type BackupFreshnessHost = BackupNoticeHost & Readonly<{
    readEnvironment(input: Readonly<{ environmentId: string; context: { signal: AbortSignal } }>): Promise<
        BackupNoticeEnvironment & Readonly<{
            backupTarget?: DeploymentBackupRunInputV1;
            backupHistory?: DeploymentBackupHistoryResultV1;
        }>>;
}>;

/** Automation owns due/start/held classification; history owns successful captures.
 * Consume those facts only on its existing wakes. C1 owns publication/deduplication. */
export async function publishBackupFreshnessNotices(host: BackupFreshnessHost,
    observation: z.infer<typeof WorkflowTriggerListResultV1Schema>,
    delivery?: Awaited<ReturnType<typeof readEnvironmentAlertDeliveryForHost>>): Promise<void> {
    const signal = host.signal ?? new AbortController().signal;
    const missed = observation.sets.filter(set => set.enabled && set.health === 'available')
        .flatMap(set => (set.missedSchedules ?? []).map(occurrence => ({ automationId: set.automationId, ...occurrence })))
        .sort((left, right) => right.dueAt - left.dueAt);
    if (!missed.length || signal.aborted) return;
    const publish = createBackupSettlementNotices(host);
    for (const target of observation.backupEnvironments ?? []) {
        if (target.serverId !== host.serverId || signal.aborted) continue;
        const environment = await host.readEnvironment({ environmentId: target.environmentId, context: { signal } });
        if (environment.environment.controllerMachineId !== host.machineId) continue;
        const occurrence = missed[0]!;
        const successfulBackup = environment.backupHistory?.lastSuccessfulBackup;
        const recovered = successfulBackup !== undefined && successfulBackup.completedAt >= occurrence.dueAt;
        const retryTarget = environment.backupTarget;
        await publish({ environment, targetLinkId: retryTarget?.targetLinkId ?? environment.environment.runtimeTargetLinkId,
            check: 'run', operationId: recovered ? successfulBackup.operationId
                : `${occurrence.automationId}:${occurrence.triggerId}:${occurrence.dueAt}`,
            configRevision: recovered ? successfulBackup.configRevision : retryTarget?.configRevision,
            retryTarget, ...(recovered ? {} : { missedSchedule: occurrence }), outcome: recovered ? 'succeeded' : 'failed',
            delivery: delivery ?? await readEnvironmentAlertDeliveryForHost(host, target.environmentId, signal) });
    }
}
