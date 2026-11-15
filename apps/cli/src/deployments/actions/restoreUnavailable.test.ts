import { expect, it, vi } from 'vitest';
import { createDeploymentRestoreActionForHost } from '@/deployments/actions/restore';
import { readOrCreateInstallationIdentitySync } from '@/daemon/identity/store';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { logger } from '@/ui/logger';
import { createNativeCredentialComposerFixture } from '@/machines/managed/nativeCredentialComposer.testkit';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

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
    expect(result).toMatchObject({ ok: false, errorCode: 'action_failed',
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

it('holds restore for review while preserving the snapshot owner’s typed public failure', async () => {
  const native = await createNativeCredentialComposerFixture({ nativeOptions: { snapshot: true } });
  try {
    const identity = readOrCreateInstallationIdentitySync();
    const machine = native.input.machine;
    if (!machine.controller || !machine.resource) throw new Error('Expected managed native fixture');
    const offer = { managedId: machine.id, intentRevision: machine.intentRevision, controller: machine.controller,
      resource: machine.resource, contribution: machine.launch.provider, coverage: { rootDisk: true, attachedVolumes: false },
      consistency: 'running' as const, cost: { kind: 'billed' as const, source: 'Native snapshot pricing' } };
    const original = { mode: 'prepare' as const, serverId: 'home', environmentId: 'environment', machineId: 'machine',
      installationId: identity.installationId, targetLinkId: 'runtime', deploymentId: 'deployment', expectedRevision: 1,
      source: { kind: 'upload' as const, transferId: 'upload' } };
    const prepared = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'prepared', revision: 1,
      actionId: 'deployments.backups.restore', state: 'succeeded', scope: { accountId: 'account', machineId: 'machine' },
      title: 'Prepare restore', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported', result: {
        kind: 'prepared', operationId: 'prepared', evidence: { input: original, snapshot: offer, native: { prepared: {
          kind: 'prepared', operationId: 'prepared', source: { kind: 'upload', transferId: 'upload', sizeBytes: 1, sha256: 'a'.repeat(64) },
          sourceFormat: 'volumeTar', destination: { adapter: 'volume-v1', service: 'app', volume: 'data',
            environmentId: 'environment', revision: 1, currentVolume: 'current', stagingVolume: 'staging',
            hasMeaningfulData: true, writerServices: ['app'], runningServices: ['app'] },
        } } },
      } });
    const nativeCause = { localCause: 'native_route_unavailable' as const };
    const failureCause = projectActionFailureCauseV1({ code: 'native_route_unavailable' }, 'machines.snapshot');
    const observation: unknown[] = [];
    let snapshotRequests = 0;
    let restoreEffects = 0;
    let releases = 0;
    const restore = createDeploymentRestoreActionForHost({ serverId: 'home', machineId: 'machine',
      assertCurrent: async () => {}, readPreparation: async () => prepared,
      acquireUpload: async () => ({ source: { kind: 'upload', transferId: 'upload', filePath: '/unused', sizeBytes: 1,
        sha256: 'a'.repeat(64), readChunk: async () => { throw new Error('Snapshot refusal must not read upload'); } },
        release() { releases++; } }),
      nativeSnapshot: { read: async () => offer, execute: async () => {
        snapshotRequests++;
        return { ok: false, errorCode: 'native_failed', error: 'native_failed', failureCause,
          details: { kind: 'managedNative', nativeCause } };
      } }, restore: async () => { restoreEffects++; throw new Error('Restore must wait for review'); },
    });
    const executor = createActionExecutor({ deploymentRestore: restore,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => { throw new Error('Unexpected full Environment read'); },
        async ({ environmentId }) => ({ ok: true, environment: { id: environmentId, projectSourceId: 'source', purpose: 'standard' } })),
    });
    const result = await executor.execute('deployments.backups.restore',
      { ...original, mode: 'confirm', prepareOperationId: 'prepared', snapshotReview: offer }, {
      surface: 'cli', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account', bypassApprovals: true,
      actionRequestId: 'snapshot-restore-request',
      operationAcceptance: { actionId: 'deployments.backups.restore', operationId: 'restore', accept() {} },
      operationOwnerUpdate: { update(value) { observation.push(value); } },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'native_failed', failureCause,
      details: { kind: 'managedNative', nativeCause, steps: [], snapshot: { kind: 'unknown', code: 'native_failed', nativeCause } } });
    expect(observation).toMatchObject([{ observation: { kind: 'review_required', code: 'restore_snapshot_not_confirmed',
      snapshot: { kind: 'unknown', code: 'native_failed', nativeCause } } }]);
    expect({ snapshotRequests, restoreEffects, releases }).toEqual({ snapshotRequests: 1, restoreEffects: 0, releases: 1 });
  } finally { await native.cleanup(); }
});
