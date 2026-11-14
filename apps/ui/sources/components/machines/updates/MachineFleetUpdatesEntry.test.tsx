import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';

import {
  createMachineFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';

const { MachineFleetUpdatesEntry } = await import('./MachineFleetUpdatesEntry');
const baseline = storage.getState();
afterEach(() => {
  standardCleanup();
  storage.setState(baseline, true);
});

const machine = (id: string, online: boolean, updates: object | null) =>
  createMachineFixture({
    id,
    active: online,
    activeAt: online ? Date.now() : 1,
    daemonState: {
      status: 'running',
      ...(updates
        ? {
            setup: {
              version: 1,
              desiredRevision: 0,
              status: 'drifted',
              recipes: [],
              updates,
            },
          }
        : {}),
    },
  });

it('counts the Machines with system updates waiting, from their pushed facts, and says nothing when none wait', async () => {
  const serverId = getActiveServerSnapshot().serverId;
  const apply = (machines: ReturnType<typeof machine>[]) =>
    storage
      .getState()
      .applyMachines(machines, true, { sourceServerId: serverId });
  apply([
    machine('hetzner', true, {
      status: 'drifted',
      backend: 'apt',
      pendingSecurity: 3,
      pendingAll: 7,
    }),
    machine('vps', true, {
      status: 'drifted',
      backend: 'apt',
      pendingSecurity: 0,
      pendingAll: 2,
      rebootNeeded: true,
    }),
    machine('laptop', true, {
      status: 'satisfied',
      backend: 'apt',
      pendingSecurity: 0,
      pendingAll: 0,
    }),
    // Offline: its last answer is not counted.
    machine('build', false, {
      status: 'drifted',
      backend: 'apt',
      pendingSecurity: 4,
      pendingAll: 9,
    }),
  ]);
  const screen = await renderScreen(
    <MachineFleetUpdatesEntry
      serverId={serverId}
      item={{ testID: 'entry', title: 'Updates' }}
    />,
  );
  const entry = () =>
    screen.root.findAll(
      (node) => node.props.testID === 'entry' && node.props.title === 'Updates',
    )[0]!;
  expect(entry().props.detail).toBe('2');

  await act(async () => {
    apply([
      machine('laptop', true, {
        status: 'satisfied',
        backend: 'apt',
        pendingSecurity: 0,
        pendingAll: 0,
      }),
    ]);
  });
  expect(entry().props.detail).toBeUndefined();
  await screen.unmount();
});
