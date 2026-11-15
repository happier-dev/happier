import { WorkflowTriggerListResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentBackupHistoryResultV1Schema, type DeploymentBackupHistoryResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupHistoryV1';
import { DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1, DEPLOYMENT_BACKUP_HISTORY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import type { BackupNoticeHost } from '../deploymentSettlementNotices';
import { publishBackupFreshnessNotices } from './freshness';

/** Called by existing Automation assignment/change/reconnect wakes, never by a timer. */
export function createBackupFreshnessObserver(host: BackupNoticeHost,
    executor: Pick<ReturnType<typeof createCliActionExecutorFromCredentials>, 'execute'>) {
    return async (automationId: string): Promise<void> => {
        const context = { surface: 'cli' as const, authority: 'account_automation' as const,
            serverId: host.serverId, signal: host.signal };
        const listed = await executor.execute('workflow.trigger.list', { backupFreshness: { automationId } }, context);
        if (!listed.ok) throw Object.assign(new Error(listed.errorCode), { code: listed.errorCode });
        const observation = WorkflowTriggerListResultV1Schema.parse(listed.result);
        await publishBackupFreshnessNotices({ ...host, async readEnvironment({ environmentId }) {
            const result = await executor.execute(DEPLOYMENT_ENVIRONMENT_GET_ACTION_ID_V1,
                { serverId: host.serverId, environmentId }, context);
            if (!result.ok) throw Object.assign(new Error(result.errorCode), { code: result.errorCode });
            const current = DeploymentEnvironmentGetResultV1Schema.parse(result.result);
            if (!current.ok) throw Object.assign(new Error(current.error), { code: current.error });
            let backupHistory: DeploymentBackupHistoryResultV1 | undefined;
            if (current.backupTarget) {
                const history = await executor.execute(DEPLOYMENT_BACKUP_HISTORY_ACTION_ID_V1, current.backupTarget, context);
                if (!history.ok) throw Object.assign(new Error(history.errorCode), { code: history.errorCode });
                backupHistory = DeploymentBackupHistoryResultV1Schema.parse(history.result);
            }
            return { environment: current.environment, backupTarget: current.backupTarget, backupHistory };
        } }, observation);
    };
}
