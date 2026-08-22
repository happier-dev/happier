import { readStoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

import {
    createStablePluginApprovalQueueOwner,
    type StablePluginApprovalQueueOwner,
} from './approvalQueue';

export function createProductionPluginApprovalQueueOwner(params?: Readonly<{
    recordDiagnostic?: Parameters<typeof createStablePluginApprovalQueueOwner>[0]['recordDiagnostic'];
}>): StablePluginApprovalQueueOwner {
    return createStablePluginApprovalQueueOwner({
        async resolveExecutor() {
            const credentials = await readStoredCredentials().catch(() => null);
            return credentials ? createCliActionExecutorFromCredentials({ credentials }) : null;
        },
        ...(params?.recordDiagnostic ? { recordDiagnostic: params.recordDiagnostic } : {}),
    });
}
