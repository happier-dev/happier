import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentBackupInventoryResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createDeploymentActions } = await import('./deploymentActions');
const { useDeploymentBackupFacts } = await import('./useDeploymentBackupFacts');

beforeEach(() => homes.reset());
afterEach(() => standardCleanup());

it('counts only currently kept database snapshots, including captures whose receipt expired, and preserves unknown reads', async () => {
  const serverId = await homes.addHome({ name: 'Kept backups', serverUrl: 'https://kept-backups.test',
    serverIdentityId: 'srv_kept_backups', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const environment = createDeploymentEnvironmentHeaderV1({ serverId: 'srv_kept_backups' });
  homes.answer(serverId, `/v1/deployments/environments/${environment.id}`, { body: { ok: true, environment, targetLinks: [] } });
  homes.answer(serverId, 'POST /v3/automations/query', { body: { automations: [], nextCursor: null } });
  const input = { environmentId: environment.id, expectedRevision: 1, machineId: environment.controllerMachineId,
    installationId: 'installation-a', targetLinkId: 'target-link', deploymentId: 'deployment-a', configRevision: 1 };
  const snapshot = (id: string, sourceId: string): DeploymentBackupInventoryResultV1['snapshots'][number] => ({
    snapshot: { snapshotId: id.repeat(64), treeId: 'f'.repeat(64), hostname: 'backup-host',
      time: '2026-11-14T10:00:00Z', paths: ['/backup'], tags: [] },
    source: { sourceId, kind: 'dump' }, verification: { kind: 'unknown', reason: 'captureReceiptUnavailable' },
  });
  let snapshots = [snapshot('a', 'database'), snapshot('b', 'database'), snapshot('c', 'other-database')];
  let unavailable = false;
  let reads = 0;
  const held = createDeferred<void>();
  await answerExternalActionAccountForHome(homes, serverId, { machineId: input.machineId,
    installationId: input.installationId, actionId: 'deployments.backups.inventory', tokenEpoch: 0,
    execute: async () => {
      reads++;
      await held.promise;
      if (unavailable) return { ok: false, errorCode: 'service_operation_unavailable', error: 'service_operation_unavailable' };
      return { kind: 'inventory', environmentId: input.environmentId, configRevision: 1, repositoryId: 'e'.repeat(64), snapshots };
    } });
  await answerExternalActionAccountForHome(homes, serverId, { machineId: input.machineId,
    installationId: input.installationId, actionId: 'deployments.backups.history', tokenEpoch: 0,
    execute: () => ({ kind: 'history', environmentId: input.environmentId, configRevision: 1,
      history: { entries: [{ operationId: 'expired-capture', action: 'backup', state: 'succeeded', configRevision: 1,
        startedAt: 1, completedAt: 2, snapshotIds: ['d'.repeat(64)] }] } }) });
  const actions = createDeploymentActions(account.accountLifetime, environment.projectSourceId);
  const hook = await renderHook(presented => useDeploymentBackupFacts(actions, input, presented, ['database']), { initialProps: false });
  try {
    expect(reads).toBe(0);
    await hook.rerender(true);
    expect(hook.getCurrent().facts).toMatchObject({ status: 'loading' });
    await act(async () => held.resolve());
    await vi.waitFor(() => expect(hook.getCurrent().facts).toMatchObject({ status: 'ready', restorePoints: { status: 'ready', count: 2 } }));
    expect(reads).toBe(1);
    await hook.rerender(true);
    expect(reads).toBe(1);
    // Native prune/deletion changes inventory; retained receipt history remains unchanged.
    snapshots = [snapshot('b', 'database'), snapshot('c', 'other-database')];
    await act(async () => hook.getCurrent().reload());
    await vi.waitFor(() => expect(hook.getCurrent().facts).toMatchObject({ restorePoints: { status: 'ready', count: 1 } }));
    unavailable = true;
    await act(async () => hook.getCurrent().reload());
    await vi.waitFor(() => expect(hook.getCurrent().facts).toMatchObject({ restorePoints: { status: 'unavailable' } }));
    unavailable = false;
    snapshots = [];
    await act(async () => hook.getCurrent().reload());
    await vi.waitFor(() => expect(hook.getCurrent().facts).toMatchObject({ restorePoints: { status: 'ready', count: 0 } }));
    expect(reads).toBe(4);
  } finally { await hook.unmount(); account.dispose(); }
});

it('hides the prior Account count when a new lifetime reads the same target operands', async () => {
  const input = { environmentId: 'environment-a', expectedRevision: 1, machineId: 'machine-a',
    installationId: 'installation-a', targetLinkId: 'target-link', deploymentId: 'deployment-a', configRevision: 1 };
  const held = createDeferred<void>();
  async function openAccount(name: string, count: number, wait = false) {
    const serverId = await homes.addHome({ name, serverUrl: `https://backups-${name}.test`,
      serverIdentityId: `srv_backups_${name}`, accountId: name, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const environment = createDeploymentEnvironmentHeaderV1({ id: input.environmentId, serverId: `srv_backups_${name}`,
      controllerMachineId: input.machineId });
    homes.answer(serverId, `/v1/deployments/environments/${environment.id}`, { body: { ok: true, environment, targetLinks: [] } });
    homes.answer(serverId, 'POST /v3/automations/query', { body: { automations: [], nextCursor: null } });
    await answerExternalActionAccountForHome(homes, serverId, { machineId: input.machineId,
      installationId: input.installationId, actionId: 'deployments.backups.history', tokenEpoch: 0,
      execute: () => ({ kind: 'history', environmentId: input.environmentId, configRevision: 1, history: { entries: [] } }) });
    await answerExternalActionAccountForHome(homes, serverId, { machineId: input.machineId,
      installationId: input.installationId, actionId: 'deployments.backups.inventory', tokenEpoch: 0,
      execute: async () => {
        if (wait) await held.promise;
        return { kind: 'inventory', environmentId: input.environmentId, configRevision: 1, repositoryId: 'f'.repeat(64),
          snapshots: Array.from({ length: count }, () => ({ snapshot: { snapshotId: 'a'.repeat(64), treeId: 'b'.repeat(64),
            hostname: 'backup-host', time: '2026-11-14T10:00:00Z', paths: ['/backup'], tags: [] },
          source: { sourceId: 'database', kind: 'dump' }, verification: { kind: 'unknown', reason: 'captureReceiptUnavailable' } })) };
      } });
    return { account, actions: createDeploymentActions(account.accountLifetime, environment.projectSourceId) };
  }
  const previous = await openAccount('previous', 1);
  const hook = await renderHook(actions => useDeploymentBackupFacts(actions, input, true, ['database']), { initialProps: previous.actions });
  let next: Awaited<ReturnType<typeof openAccount>> | null = null;
  try {
    await vi.waitFor(() => expect(hook.getCurrent().facts).toMatchObject({ restorePoints: { status: 'ready', count: 1 } }));
    next = await openAccount('next', 0, true);
    await hook.rerender(next.actions);
    expect(hook.getCurrent().facts).toEqual({ status: 'loading' });
    await act(async () => held.resolve());
    await vi.waitFor(() => expect(hook.getCurrent().facts).toMatchObject({ restorePoints: { status: 'ready', count: 0 } }));
  } finally { await hook.unmount(); previous.account.dispose(); next?.account.dispose(); }
});
