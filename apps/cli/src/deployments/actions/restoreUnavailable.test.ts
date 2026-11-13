import { expect, it, vi } from 'vitest';
import { createDeploymentRestoreActionForHost } from '@/deployments/actions/restore';
import { readOrCreateInstallationIdentitySync } from '@/daemon/identity/store';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { logger } from '@/ui/logger';

it('carries a restore adapter refusal and its private diagnostic through the real Action output', async () => {
  const identity = readOrCreateInstallationIdentitySync();
  const records: unknown[] = [];
  const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation((_message, diagnostic) => { records.push(diagnostic); });
  try {
    const restore = createDeploymentRestoreActionForHost({ serverId: 'home', machineId: 'machine',
      assertCurrent: async context => { context.signal?.throwIfAborted(); },
      // The host port is the native restore/OS boundary; its rejected exception is the incident shape.
      restore: async () => { throw new TypeError('restore destination rejected token=PRIVATE_RESTORE_TOKEN'); },
    });
    const terminal: unknown[] = [];
    const executor = createActionExecutor({ deploymentRestore: restore,
      // Home metadata is the HTTP boundary; the real scope and Action owners remain loaded.
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => { throw new Error('Unexpected full Environment read'); },
        async ({ environmentId }) => ({ ok: true, environment: { id: environmentId, projectSourceId: 'source', purpose: 'standard' } })),
      recordActionOutputDiagnostic: diagnostic => { terminal.push(diagnostic); },
    });
    const result = await executor.execute('deployments.backups.restore', { mode: 'prepare', serverId: 'home', environmentId: 'environment', machineId: 'machine',
      installationId: identity.installationId, targetLinkId: 'runtime', deploymentId: 'deployment', expectedRevision: 1,
      source: { kind: 'repository', snapshotId: 'snapshot' } },
      { surface: 'cli', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account', bypassApprovals: true,
        actionRequestId: 'restore-request',
        operationAcceptance: { actionId: 'deployments.backups.restore', operationId: 'prepare-operation', accept() {} } });
    expect(result).toMatchObject({ ok: false, errorCode: 'deployment_unavailable',
      failureCause: { phase: 'deployment.restore.prepare', errorClass: 'TypeError' } });
    const diagnostic = { phase: 'deployment.restore.prepare', causeKind: 'native_failure',
      exception: { errorClass: 'TypeError', message: expect.stringContaining('restore destination rejected') } };
    expect(records).toContainEqual(expect.objectContaining(diagnostic));
    expect(terminal).toContainEqual(expect.objectContaining({ ...diagnostic, requestId: 'restore-request' }));
    expect(JSON.stringify([records, terminal])).not.toContain('PRIVATE_RESTORE_TOKEN');
    expect(JSON.stringify(result)).not.toContain('restore destination rejected');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_RESTORE_TOKEN');
    expect(JSON.stringify(result)).not.toContain('exception');
  } finally { log.mockRestore(); }
});
