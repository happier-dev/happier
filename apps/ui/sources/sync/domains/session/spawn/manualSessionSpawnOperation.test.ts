import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { readManualSessionSpawnOperationDetails } from './manualSessionSpawnOperation';

// Replace the machine network transport; retain the real get adapter, schema and store.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: vi.fn(),
}));

afterEach(() => { vi.mocked(machineRpcWithServerScope).mockReset(); actionOperationStore.reset(); });

describe('manual Session operation details', () => {
    it('hydrates a failed list row before presenting its typed spawn refusal', async () => {
        const scope = { serverId: 'home', accountId: 'account' };
        const summary: ActionOperationSnapshotV1 = {
            version: 1, operationId: 'operation', revision: 3, actionId: 'session.spawn_new',
            state: 'failed', scope: { accountId: scope.accountId, machineId: 'machine' },
            requestId: 'manual:attempt', title: 'Create session', createdAt: 1, startedAt: 2, settledAt: 3,
            cancellation: 'supported', error: { errorCode: 'spawn_failed', error: 'spawn_failed' },
        };
        const result = { type: 'error', code: 'spawn_failed', retryable: false,
            launchError: { kind: 'launch_error', code: 'agent_isolation_unavailable', message: 'agent_isolation_unavailable' } };
        vi.mocked(machineRpcWithServerScope).mockResolvedValue({ kind: 'found', operation: { ...summary, result } });
        await expect(readManualSessionSpawnOperationDetails(scope, summary)).resolves.toMatchObject({ result });
    });
});
