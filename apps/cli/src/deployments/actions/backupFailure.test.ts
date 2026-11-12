import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { withTempDir } from '@/testkit/fs/tempDir';
import * as identityStore from '@/daemon/identity/store';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createDeploymentRestoreActionForHost } from './restore';
import { createDeploymentBackupActionForHost } from './backups';

afterEach(() => vi.restoreAllMocks());

it('preserves the receipt owner’s typed unavailability through restore and backup history', async () => {
    await withTempDir('backup-history-refusal-', async root => {
        const identity = identityStore.readOrCreateInstallationIdentitySync(join(root, 'identity.json'));
        // Installation identity is the filesystem boundary; receipt scope and reads remain real.
        vi.spyOn(identityStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(identity);
        const runtime = createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine',
            resolveAccountId: async () => 'account', projectOpenReceiptPersistence: null });
        const host = { serverId: 'home', machineId: 'machine', assertCurrent: async () => {},
            readBackupOperations: (target: Parameters<typeof runtime.readDeploymentBackupOperations>[0]['target']) =>
                runtime.readDeploymentBackupOperations({ target }) };
        const input = { serverId: 'home', environmentId: 'environment', machineId: 'machine',
            installationId: identity.installationId, targetLinkId: 'target', deploymentId: 'deployment', expectedRevision: 1 };
        const restore = createDeploymentRestoreActionForHost({ ...host,
            restore: async () => { throw new Error('Native restore must not run without receipt history'); } });
        const restored = await restore({ ...input, mode: 'prepare',
            source: { kind: 'repository', snapshotId: 'snapshot', backupOperationId: 'backup-operation' } },
        { operationAcceptance: { actionId: 'deployments.backups.restore', operationId: 'restore-operation', accept() {} } });
        const backup = createDeploymentBackupActionForHost({ ...host,
            backup: async () => { throw new Error('Native backup must not run for a history read'); } });
        const history = await backup('deployments.backups.history', { ...input, configRevision: 1 }, {});
        for (const result of [restored, history]) {
            expect(result).toMatchObject({ ok: false, errorCode: 'action_operation_unavailable',
                failureCause: { errorCode: 'action_operation_unavailable' } });
            expect(JSON.stringify(result)).not.toContain('Action operation receipt storage');
        }
    });
});
