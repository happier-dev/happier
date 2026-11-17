import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import {
  ActionOperationSnapshotV1Schema,
  type ActionOperationSnapshotV1,
} from '@happier-dev/protocol/actions/operations/v1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import 'fake-indexeddb/auto';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { ProjectsTreeRow } from './projectsTreeRows';

// The Socket.IO port supplies daemon answers; operation selection and the Home Account binding stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installSessionActionRpcBoundary(() => new Promise(() => {}));
const { ProjectsTreeRowAttention } = await import('./ProjectsTreeRowAttention');

let serverId = '';
beforeEach(async () => {
  await homes.reset();
  serverId = await homes.addHome({
    name: 'Team Home',
    serverUrl: 'https://team-home.test',
    serverIdentityId: 'team-home',
    accountId: 'member',
    currentAccount: true,
  });
  homes.answer(serverId, '/v1/machines/devbox', {
    body: {
      machine: createPlainMachineRowFixture({
        id: 'devbox',
        accountId: 'member',
      }),
    },
  });
});
afterEach(async () => {
  standardCleanup();
  actionOperationStore.reset();
  const { serverScopedRpcSocketPool } =
    await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
  await serverScopedRpcSocketPool.stopAll();
});

function opening(
  overrides: Partial<ActionOperationSnapshotV1> = {},
): ActionOperationSnapshotV1 {
  return ActionOperationSnapshotV1Schema.parse({
    version: 1,
    operationId: 'open',
    revision: 1,
    actionId: 'projects.open',
    state: 'running',
    scope: { accountId: 'member', machineId: 'devbox' },
    title: 'Open',
    createdAt: 1,
    startedAt: 1,
    cancellation: 'unsupported',
    domainRef: { kind: 'projectOpen', sourceId: 'acme-web' },
    ...overrides,
  });
}

function projectRow(): ProjectsTreeRow {
  return {
    key: 'acme-web',
    level: 0,
    kind: 'project',
    title: 'acme/web',
    glyph: 'project',
    expandable: false,
    expanded: false,
    attention: null,
    selected: false,
    machineId: 'devbox',
    source: {
      serverId,
      source: {
        id: 'acme-web',
        revision: 1,
        name: 'acme/web',
        audience: [],
        createdByAccountId: 'owner',
      },
    },
  };
}

describe('Projects column setup progress (lab L3)', () => {
  it("says a Source's setup run is in progress on the row whose checkout it opened", async () => {
    act(() =>
      actionOperationStore.mergeSnapshots({
        serverId,
        snapshotComplete: true,
        snapshots: [opening()],
      }),
    );
    const screen = await renderScreen(
      <ProjectsTreeRowAttention row={projectRow()} testID="row" />,
    );
    await vi.waitFor(() =>
      expect(screen.findByTestId('row-setup')).toBeTruthy(),
    );
    await screen.unmount();
  });

  it('keeps its words inside a column row that draws states as compact dots', async () => {
    const { HappierStatusCompactContext } = await import('@happier-dev/plugin-ui/presentation');
    const { t } = await import('@/text');
    act(() =>
      actionOperationStore.mergeSnapshots({
        serverId,
        snapshotComplete: true,
        snapshots: [opening()],
      }),
    );
    const screen = await renderScreen(
      <HappierStatusCompactContext.Provider value>
        <ProjectsTreeRowAttention row={projectRow()} testID="row" />
      </HappierStatusCompactContext.Provider>,
    );
    const label = t('projects.checkouts.settingUp');
    await vi.waitFor(() =>
      expect(screen.tree.findAll((node) => node.props?.children === label).length).toBeGreaterThan(0),
    );
    await screen.unmount();
  });

  it('stays quiet once the run settles', async () => {
    act(() =>
      actionOperationStore.mergeSnapshots({
        serverId,
        snapshotComplete: true,
        snapshots: [opening({ state: 'succeeded', settledAt: 2 })],
      }),
    );
    const screen = await renderScreen(
      <ProjectsTreeRowAttention row={projectRow()} testID="row" />,
    );
    expect(screen.findByTestId('row-setup')).toBeNull();
    await screen.unmount();
  });
});
