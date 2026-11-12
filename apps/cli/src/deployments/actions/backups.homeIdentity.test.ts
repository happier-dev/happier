import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createDeploymentBackupActionForHost } from './backups';

// Installation identity is the OS persistence boundary; admission and host stay real.
vi.mock('@/daemon/identity/store', () => ({ readInstallationIdentityIfExistsSync: () => ({ installationId: 'installed' }) }));

it('admits alias and canonical backup history through the real host and refuses foreign targets before effects', async () => {
  const reads: unknown[] = [];
  const executor = createActionExecutor({
    // Home metadata is the HTTP boundary; scope derivation remains real.
    resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => { throw new Error('Unexpected full Environment read'); },
      async ({ environmentId }) => ({ ok: true, environment: { id: environmentId, projectSourceId: 'source', purpose: 'standard' } })),
    deploymentBackupAction: createDeploymentBackupActionForHost({
    serverId: 'canonical-home', machineId: 'machine', async assertCurrent() {},
    async readBackupOperations(input) { reads.push(input); return []; },
    async backup() { throw new Error('History cannot execute a native effect'); },
  }) });
  const context = { surface: 'cli' as const, authority: 'present_user' as const,
    serverId: 'alias', serverIdentityId: 'canonical-home', runtimeAccountId: 'account' };
  const input = { serverId: 'alias', machineId: 'machine', installationId: 'installed', environmentId: 'environment',
    targetLinkId: 'link', deploymentId: 'deployment', expectedRevision: 1, configRevision: 1 };
  for (const serverId of ['alias', 'canonical-home']) {
    const result = await executor.execute('deployments.backups.history', { ...input, serverId }, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'history', environmentId: 'environment' } });
  }
  expect(reads).toEqual([ { ...input, serverId: 'canonical-home' }, { ...input, serverId: 'canonical-home' } ]);
  expect(await executor.execute('deployments.backups.history', { ...input, serverId: 'foreign' }, context))
    .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
  expect(await executor.execute('deployments.backups.history', { ...input, machineId: 'other' }, context))
    .toMatchObject({ ok: false, errorCode: 'target_mismatch' });
  expect(await executor.execute('deployments.backups.history', { ...input, installationId: 'other' }, context))
    .toMatchObject({ ok: false, errorCode: 'target_mismatch' });
  expect(reads).toHaveLength(2);
});

it('normalizes restore before preparing its destructive review and rejects foreign input before review', async () => {
  const reviewed: unknown[] = [];
  const executor = createActionExecutor({ prepareDeploymentRestore: async request => {
    reviewed.push(request.input);
    return { ok: false, errorCode: 'review_probe', error: 'review_probe' };
  } });
  const context = { surface: 'cli' as const, authority: 'present_user' as const,
    serverId: 'alias', serverIdentityId: 'canonical-home', runtimeAccountId: 'account' };
  const input = { serverId: 'alias', machineId: 'machine', installationId: 'installed', environmentId: 'environment',
    targetLinkId: 'link', deploymentId: 'deployment', expectedRevision: 1, mode: 'confirm',
    prepareOperationId: 'prepared', source: { kind: 'repository', snapshotId: 'snapshot' } };
  expect(await executor.execute('deployments.backups.restore', input, context))
    .toMatchObject({ ok: false, errorCode: 'review_probe' });
  expect(reviewed).toEqual([{ ...input, serverId: 'canonical-home' }]);
  expect(await executor.execute('deployments.backups.restore', { ...input, serverId: 'foreign' }, context))
    .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
  expect(reviewed).toHaveLength(1);
});

it('refuses an unresolved or ambiguous Home mapping before entering the host', async () => {
  let effects = 0;
  const executor = createActionExecutor({ resolveServerProfileScopeId: () => null,
    deploymentBackupAction: async () => { effects++; throw new Error('Unresolved Home cannot reach host'); } });
  expect(await executor.execute('deployments.backups.history', { serverId: 'alias', machineId: 'machine',
    installationId: 'installed', environmentId: 'environment', targetLinkId: 'link', deploymentId: 'deployment', expectedRevision: 1, configRevision: 1 },
    { surface: 'cli', authority: 'present_user', serverId: 'alias', runtimeAccountId: 'account' }))
    .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
  expect(effects).toBe(0);
});
