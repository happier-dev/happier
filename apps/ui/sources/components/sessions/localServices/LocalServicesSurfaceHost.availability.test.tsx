import * as React from 'react';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import type { LocalServiceLauncherSnapshotClient } from '@/sync/domains/local/services/launch';
import type { LocalServiceInventorySnapshotClient } from '@/sync/domains/local/services/inventory/useLocalServiceInventoryState';

// The Home's HTTP and credential boundaries are genuine; the feature decision, the feeds and the pane run for real.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { resetLocalServiceInventoryStoreForTests } =
  await import('@/sync/domains/local/services/inventory/sharedStore');
const { resetLocalServiceLauncherStoreForTests } =
  await import('@/sync/domains/local/services/launch/sharedStore');
const { storage } = await import('@/sync/domains/state/storage');
const { buildLocalServiceInventoryState, createMachineFixture, createSessionFixture } = await import('@/dev/testkit');
function seedReachableSession(serverId: string) {
  const machine = createMachineFixture({ id: 'machine-a', activeAt: Date.now() });
  storage.setState({ machines: { 'machine-a': machine }, machineListByServerId: { [serverId]: [machine] },
    sessions: { 'session-a': createSessionFixture({ id: 'session-a', serverId,
      metadata: { machineId: 'machine-a', path: '/repo', host: 'devbox', homeDir: '/home/person' } }) } });
}
const { LocalServicesSurfaceHost } = await import('./LocalServicesSurfaceHost');
const { DetectedLocalServicesPane } = await import('./DetectedLocalServicesPane');
const { Text } = await import('@/components/ui/text/Text');

const operationMachineRpc = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
function createDaemonReads() {
  const reads = { inventory: 0, launcher: 0, watch: 0 };
  // Park the real daemon watch at its transport boundary until its owner cancels it.
  vi.spyOn(operationMachineRpc, 'machineRpcWithServerScope').mockImplementation(async <Response,>(request: Parameters<typeof operationMachineRpc.machineRpcWithServerScope>[0]) => {
    if (request.method !== RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) throw new Error(`Unexpected RPC ${request.method}`);
    reads.watch += 1;
    return new Promise<Response>((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  });
  const inventorySnapshotClient: LocalServiceInventorySnapshotClient =
    async () => {
      reads.inventory += 1;
      return {
        ok: true,
        snapshot: {
          v: 1,
          machineId: 'machine-a',
          sessionId: 'session-a',
          generatedAt: 1000,
          refreshState: 'idle',
          entries: [],
          diagnostics: [],
        },
      };
    };
  const launcherSnapshotClient: LocalServiceLauncherSnapshotClient =
    async () => {
      reads.launcher += 1;
      return {
        ok: true,
        snapshot: {
          v: 1,
          machineId: 'machine-a',
          sessionId: 'session-a',
          updatedAt: 3000,
          targets: [],
        },
      };
    };
  return { reads, inventorySnapshotClient, launcherSnapshotClient };
}

describe('LocalServicesSurfaceHost Home availability', () => {
  beforeEach(async () => {
    await home.reset();
    resetLocalServiceInventoryStoreForTests();
    resetLocalServiceLauncherStoreForTests();
  });
  afterEach(async () => {
    resetLocalServiceInventoryStoreForTests();
    resetLocalServiceLauncherStoreForTests();
    await home.reset();
    vi.restoreAllMocks();
  });

  it('says Local services are off on the Home, offers nothing that cannot work, and reads nothing from the daemon', async () => {
    const serverId = await home.addHome({
      name: 'Services off',
      serverUrl: 'https://services-off.test',
      accountId: 'account',
      currentAccount: true,
      localServicesEnabled: false,
    });
    seedReachableSession(serverId);
    const daemon = createDaemonReads();
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId={serverId}
        sessionId="session-a"
        inventorySnapshotClient={daemon.inventorySnapshotClient}
        launcherSnapshotClient={daemon.launcherSnapshotClient}
        testID="services"
      />,
    );
    try {
      await waitForHomeGovernance(() =>
        expect(screen.findByTestId('services-off')).not.toBeNull(),
      );
      expect(screen.findByTestId('services-empty')).toBeNull();
      expect(screen.findByTestId('services-refresh')).toBeNull();
      expect(screen.findByTestId('services-scope-toggle')).toBeNull();
      expect(
        screen
          .findAllByProps({ accessibilityRole: 'button' })
          .filter((node) => node.props.testID?.startsWith('services-off')),
      ).toEqual([]);
      expect(daemon.reads).toEqual({ inventory: 0, launcher: 0, watch: 0 });
    } finally {
      await screen.unmount();
    }
  });

  // Databases reach remote databases and other targets that do not depend on Local services (owner 2026-11-20),
  // so the Services panel surfaces stay under the off card; only a Machine out of reach leaves them out.
  it('keeps the Services panel surfaces under a Home that turned Local services off, and out of a pane whose Machine is out of reach', async () => {
    const serverId = await home.addHome({
      name: 'Services off',
      serverUrl: 'https://services-off.test',
      accountId: 'account',
      currentAccount: true,
      localServicesEnabled: false,
    });
    const footer = <Text testID="services-footer-probe">Databases</Text>;
    const off = await renderScreen(
      <DetectedLocalServicesPane inventoryState={buildLocalServiceInventoryState({ rows: [] })} availability="server_disabled" serverId={serverId} footer={footer} testID="services" />,
    );
    try {
      expect(off.findByTestId('services-off')).not.toBeNull();
      expect(off.findByTestId('services-footer-probe')).not.toBeNull();
    } finally {
      await off.unmount();
    }
    const on = await renderScreen(
      <DetectedLocalServicesPane inventoryState={buildLocalServiceInventoryState({ rows: [] })} availability="available" serverId={serverId} footer={footer} testID="services" />,
    );
    try {
      expect(on.findByTestId('services-footer-probe')).not.toBeNull();
    } finally {
      await on.unmount();
    }
    // A Machine out of reach says so once: nothing below the card can run or load until Try again succeeds.
    const unreachable = await renderScreen(
      <DetectedLocalServicesPane inventoryState={buildLocalServiceInventoryState({ rows: [] })} availability="available"
        machine={{ name: 'MacBook Pro', homeDir: null, reachability: 'unreachable' }} footer={footer} testID="services" />,
    );
    try {
      expect(unreachable.findAllByProps({}).some((node) => /^services-(offline|waiting)$/.test(String(node.props.testID ?? '')))).toBe(true);
      expect(unreachable.findByTestId('services-footer-probe')).toBeNull();
    } finally {
      await unreachable.unmount();
    }
  });

  it('keeps the scanned pane unchanged when the Home has Local services on', async () => {
    const serverId = await home.addHome({
      name: 'Services on',
      serverUrl: 'https://services-on.test',
      accountId: 'account',
      currentAccount: true,
      localServicesEnabled: true,
    });
    seedReachableSession(serverId);
    const daemon = createDaemonReads();
    const screen = await renderScreen(
      <LocalServicesSurfaceHost
        machineId="machine-a"
        serverId={serverId}
        sessionId="session-a"
        inventorySnapshotClient={daemon.inventorySnapshotClient}
        launcherSnapshotClient={daemon.launcherSnapshotClient}
        testID="services"
      />,
    );
    try {
      await waitForHomeGovernance(() =>
        expect(screen.findByTestId('services-empty'), screen.getTextContent()).not.toBeNull(),
      );
      expect(screen.findByTestId('services-off')).toBeNull();
      expect(daemon.reads.inventory).toBeGreaterThan(0);
      expect(daemon.reads.launcher).toBeGreaterThan(0);
    } finally {
      await screen.unmount();
    }
  });
});
