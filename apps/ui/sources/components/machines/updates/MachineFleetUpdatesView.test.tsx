import * as React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';

import {
  createMachineFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';

const { MachineFleetUpdatesView } = await import('./MachineFleetUpdatesView');
const baseline = storage.getState();
afterEach(() => {
  standardCleanup();
  storage.setState(baseline, true);
});

const machine = (id: string, online: boolean, updates: object) =>
  createMachineFixture({
    id,
    active: online,
    activeAt: online ? Date.now() : 1,
    daemonState: {
      status: 'running',
      setup: {
        version: 1,
        desiredRevision: 0,
        status: 'drifted',
        recipes: [],
        updates,
      },
    },
  });

function textOf(node: ReactTestInstance | null | undefined): string {
  if (!node) return '';
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join(' ');
}

it('heads the table with the fleet in one count line and offers the rollout only where updates of that kind wait', async () => {
  const serverId = getActiveServerSnapshot().serverId;
  storage.getState().applyMachines(
    [
      machine('hetzner', true, {
        status: 'drifted',
        backend: 'apt',
        pendingSecurity: 3,
        pendingAll: 7,
        rebootNeeded: false,
      }),
      machine('vps', true, {
        status: 'drifted',
        backend: 'apt',
        pendingSecurity: 0,
        pendingAll: 2,
        rebootNeeded: true,
      }),
      machine('build', false, {
        status: 'drifted',
        backend: 'apt',
        pendingSecurity: 4,
        pendingAll: 9,
      }),
    ],
    true,
    { sourceServerId: serverId },
  );
  const screen = await renderScreen(<MachineFleetUpdatesView />);
  const byTestID = (testID: string) =>
    screen.root.findAll(
      (node) =>
        node.props.testID === testID && typeof node.props.title === 'string',
    )[0];
  const pressable = (testID: string) =>
    screen.root.findAll(
      (node) =>
        node.props.testID === testID &&
        typeof node.props.onPress === 'function',
    )[0]!;

  // The page's count line says the fleet once, under its purpose.
  expect(
    textOf(screen.findByTestId('machines.updates.header:count')),
  ).toContain(t('machineFleetUpdates.statusPartial', { count: 2, checked: 2, total: 3 }));

  await act(async () => {
    pressable('machines.updates.review').props.onPress();
  });
  // Security only reaches hetzner; build is offline and is named as skipped, not counted.
  expect(byTestID('machines.updates.prepare')?.props.title).toBe(
    t('machineFleetUpdates.prepare', { count: 1 }),
  );
  expect(byTestID('machines.updates.scope')?.props.subtitle).toContain(
    t('machineFleetUpdates.skippedOffline', { names: 'build' }).split(': ')[0]!,
  );
  await act(async () => {
    byTestID('machines.updates.scope')!.props.onChange('all');
  });
  expect(byTestID('machines.updates.prepare')?.props.title).toBe(
    t('machineFleetUpdates.prepare', { count: 2 }),
  );
});
