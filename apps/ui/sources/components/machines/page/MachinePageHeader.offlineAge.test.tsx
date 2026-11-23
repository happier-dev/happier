import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import {
  createMachineFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { createHydratedPlainMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { t } from '@/text';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

// Modal presentation is the platform boundary.
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);
const { ModalProvider } = await import('@/modal');
const { MachinePageHeader } = await import('./MachinePageHeader');

afterEach(() => {
  vi.useRealTimers();
  standardCleanup();
});

const calm = {
  v: 1,
  vitals: { state: 'reporting' },
  host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 },
  attention: { level: 'calm', reasons: [] },
};

it("ages an offline machine's last seen on the shared minute clock, with no new machine data", async () => {
  // The shared clock keeps the wall time it last read, so the fake clock starts from the real one.
  // One second past a wall-clock minute, so the minute ticks land at known ages.
  vi.useFakeTimers({ now: (Math.floor(Date.now() / 60_000) + 1) * 60_000 + 1_000 });
  const homes = await serveAccountHomes({
    homes: [{ key: 'a', serverUrl: 'https://offline-age.test', serverIdentityId: 'srv_offline_age', accountId: 'owner', currentAccount: true }],
    route: async () => undefined,
  });
  const serverId = homes.homes.a!.id;
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  const store = getStorage();
  const previous = store.getState();
  const machine = createHydratedPlainMachineFixture({
    id: 'stopped',
    accountId: 'owner',
    machine: {
      active: false,
      // Home-owned presence (protocol 1): a stopped daemon is offline at once, never by client grace.
      presenceProtocolVersion: 1,
      activeAt: Date.now() - 5_000,
      isShared: false,
      metadata: {
        ...createMachineFixture({ id: 'stopped' }).metadata!,
        homeDir: '/home/qa',
      },
      daemonState: { resources: calm },
    },
  });
  store.getState().applyMachines([machine], true);
  // The daemon stopped: Home answers its presence once, offline, and nothing arrives after that.
  store.getState().applyMachineActivityUpdates([{ id: machine.id, active: false, activeAt: Date.now() - 5_000 }],
    { sourceServerId: serverId, sourceAccountId: 'owner' });
  // The page reads the Home's stored row, which carries the presence Home answered.
  const stored = resolveServerScopedMachine(store.getState(), serverId, machine.id)!;
  const target = {
    machineId: machine.id,
    requestedServerId: serverId,
    serverId: serverId,
    activeServerId: serverId,
    machine: stored,
    online: false,
    machineName: 'Stopped',
    machineSentenceName: 'Stopped',
    isServerSwitching: false,
    isHydratingMachine: false,
    switchReady: true,
  };
  const screen = await renderScreen(
    <ModalProvider>
      <MachinePageHeader
        target={target}
        managedIdentity={null}
        renaming={false}
        onRename={() => {}}
      />
    </ModalProvider>,
  );
  try {
    expect(screen.getTextContent()).toContain(t('time.justNow'));
    // Real time passes in steps: each minute tick renders, then asks for the next one.
    for (let minute = 0; minute < 3; minute++) {
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
    }
    expect(screen.getTextContent()).toContain(
      t('time.minutesAgo', { count: 3 }),
    );
  } finally {
    await screen.unmount();
    await homes.dispose();
    store.setState(previous);
  }
});
