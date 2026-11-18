import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { MachineProcessesAnswerV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { DaemonLocalServiceActionExecuteResponseV1Schema, LocalServiceActionRequestV1Schema } from '@happier-dev/protocol/local/services/actions/v1';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineActivityForTest, publishMachineInventoryForTest as publishTruthMachineInventory } from '@/dev/testkit/harness/machinePresence';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';

import { buildLocalServiceInventoryRow } from '@/dev/testkit/fixtures/localServices';

const { Pressable } = await import('react-native');

function SharedPortConsumer(props: Readonly<{ port: number }>) {
  const [open, setOpen] = React.useState(false);
  const [result, setResult] = React.useState<boolean | null>(null);
  const entry = useMachinePortEntry({ port: props.port }, open);
  return (
    <>
      <Pressable testID="shared-port-demand" onPress={() => { entry.actions?.demand(); setOpen(true); }} />
      <Pressable testID="shared-port-result" accessibilityValue={{ text: String(result) }} />
      {entry.open ? <Pressable testID="shared-port-open" onPress={async () => { setResult(await entry.open!()); }} accessibilityHint={entry.offered?.openUnavailableReason ?? undefined} /> : null}
    </>
  );
}

import {
  createProcessesAnswer,
  processRow,
  PROCESSES_FIXTURE_BYTES,
} from './testkit/processesAnswerFixture';

// Instrument the React boundary while running the real hooks and subscription owners.
vi.mock('react', { spy: true });

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
// Only the machine network is replaced; credential binding, the process store, Actions, approval policy and the tab run for real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () => {
    const { createServerScopedMachineRpcBoundaryMock } =
      await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(transport.rpc);
  },
);
// The device class is a platform boundary; a test that asks for the phone composition sets it.
const device = vi.hoisted(() => ({ type: null as 'phone' | null }));
vi.mock('@/utils/platform/responsive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
  return { ...actual, useDeviceType: () => device.type ?? actual.useDeviceType() };
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ renderCustomModals: true }).module;
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { ModalProvider } = await import('@/modal');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storageStore');
const { machineProcessesStore } =
  await import('@/sync/domains/machines/processes/machineProcessesStore');
const { MachinePageStateContext } =
  await import('@/components/machines/page/machinePageContext');
const { MachinePortActionsProvider, useMachinePortEntry } = await import('@/components/machines/localServices/MachinePortActions');
const { MachineProcessesTab } = await import('./MachineProcessesTab');
const { machineResourceStore } = await import('@/sync/domains/machines/resources/machineResourceStore');
const { measureMountedCollections } = await import('@/dev/testkit/render/renderInCollectionLayout');
const { PROCESS_ROW_EXIT_MS } = await import('./processesMotion');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');

const { GB, MB } = PROCESSES_FIXTURE_BYTES;

function machine(overrides: Partial<Machine> = {}): Machine {
  return createMachineFixture({
    id: 'machine',
    activeAt: Date.now(),
    storageMode: 'plain',
    isShared: false,
    metadata: {
      host: 'leeroy-mbp',
      platform: 'darwin',
      happyCliVersion: '0.3.0',
      happyHomeDir: '/Users/leeroy/.happier',
      homeDir: '/Users/leeroy',
    },
    access: {
      role: 'manage',
      custodian: { accountId: 'owner', displayName: 'Owner' },
      resourceMode: 'plain',
      accessState: 'ready',
    },
    daemonState: {
      resources: {
        v: 1,
        vitals: { state: 'reporting' },
        host: { logicalCores: 18, memoryTotalBytes: 128 * GB, bootedAt: 1 },
        attention: { level: 'calm', reasons: [] },
      },
    },
    ...overrides,
  });
}

type Rpc = Readonly<{ method: string; payload?: Record<string, unknown> }>;

async function mount(
  options: Readonly<{
    answer?: MachineProcessesAnswerV1;
    reply?: (rpc: Rpc) => unknown;
    machine?: Partial<Machine>;
    params?: Extract<MachinePageTabParams, { id: 'processes' }>;
    online?: boolean | null;
    waitForRows?: boolean;
    askBeforeKill?: boolean;
    askBeforeStop?: boolean;
    askBeforePortStop?: boolean;
    sharedPort?: number;
  }> = {},
) {
  const serverId = await home.addHome({
    name: 'Processes Home',
    serverUrl: `https://processes-tab-${Math.random().toString(36).slice(2)}.test`,
    accountId: 'owner',
  });
  // The person waived confirmation for these Actions on this device (their own approval setting, R41).
  home.answer(serverId, '/v2/account/settings', {
    body: {
      content: {
        t: 'plain',
        v: {
          actionsSettingsV1: {
            v: 1,
            actions: {},
            approvalWaivedSurfaces: {
              ...(options.askBeforeStop ? {} : { 'machines.processes.stop': ['ui'] }),
              ...(options.askBeforeKill ? {} : { 'machines.processes.kill': ['ui'] }),
              'machines.processes.leftBehind.cleanUp': ['ui'],
              ...(options.askBeforePortStop ? {} : { 'localServices.actions.terminateDetected': ['ui'] }),
              'localServices.actions.copyUrl': ['ui'],
            },
          },
        },
      },
      version: 1,
    },
  });
  const current = machine(options.machine);
  storage.setState({
    machines: {},
    machineListByServerId: { [serverId]: [current] },
    machineListStatusByServerId: { [serverId]: 'idle' },
  });
  const answer = options.answer ?? createProcessesAnswer();
  transport.rpc.mockImplementation(async (rpc: Rpc) => {
    const reply = options.reply?.(rpc);
    if (reply !== undefined) return reply;
    if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_LIST) return answer;
    return new Promise(() => {});
  });
  const pageState = {
    target: {
      machineId: 'machine',
      requestedServerId: serverId,
      serverId,
      activeServerId: serverId,
      machine: current,
      machineName: 'leeroy-mbp',
      online: options.online === undefined ? true : options.online,
      isServerSwitching: false,
      isHydratingMachine: false,
      switchReady: true,
    },
    managedEnrolled: null,
    refreshKey: 0,
    reload: async () => {},
  } as unknown as React.ContextType<typeof MachinePageStateContext>;
  const setParams = vi.fn();
  const screen = await renderScreen(
    <AuthProvider initialCredentials={{ token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature` }}>
<ModalProvider>
      <MachinePageStateContext.Provider value={pageState}>
        {options.sharedPort === undefined ? (
        <MachineProcessesTab
          serverId={serverId}
          machineId="machine"
          machineName="leeroy-mbp"
          online={options.online === undefined ? true : options.online}
          params={options.params ?? { id: 'processes' }}
          setParams={setParams}
        />
        ) : (
          <MachinePortActionsProvider serverId={serverId} machineId="machine">
            <SharedPortConsumer port={options.sharedPort} />
          </MachinePortActionsProvider>
        )}
      </MachinePageStateContext.Provider>
    </ModalProvider>
    </AuthProvider>,
  );
  if (options.waitForRows !== false && options.sharedPort === undefined) await act(async () => {
    await vi.waitFor(() =>
      expect(
        screen.root.findAll((node) => String(node.props.testID ?? '').startsWith('machine-processes-row-')).length,
      ).toBeGreaterThan(0),
    );
  });
  // A test renderer never lays out: measure the table the way the platform does on its first layout.
  await measureMountedCollections(screen, { width: 1200 });
  // FX77 makes the default direct; this scenario needs the person's explicit Account-owned Ask setting.
  if (options.askBeforeStop) await act(async () => { await home.requireUiApproval(serverId, 'machines.processes.stop'); });
  return { screen, serverId, setParams };
}

const textOf = (node: { children: unknown[] } | null): string =>
  !node
    ? ''
    : node.children
        .map((child) =>
          typeof child === 'string'
            ? child
            : textOf(child as { children: unknown[] }),
        )
        .join('');
const count = (text: string, needle: string) => text.split(needle).length - 1;
it('displays native ceiling utilization and the unverifiable count without inventing actionable rows', async () => {
  const answer = createProcessesAnswer();
  answer.unverifiableCount = 2;
  answer.owners[0].ceiling = { limitBytes: 4 * GB, usedBytes: 3 * GB, observedAtMs: answer.capturedAtMs, throttleCount5m: 7 };
  const { screen } = await mount({ answer });
  expect(screen.getTextContent()).toContain('3 GB of 4 GB');
  expect(screen.findByTestId('machine-processes-unverifiable')).not.toBeNull();
  expect(screen.root.findAll(node => String(node.props.testID ?? '').startsWith('machine-processes-row-unknown'))).toHaveLength(0);
  const phone = await mount({ answer, params: { id: 'processes', page: 'owner', owner: answer.owners[0].rowId }, waitForRows: false });
  expect(phone.screen.findByTestId('machine-processes-ceiling-throttles')).not.toBeNull();
});
it('keeps the vitals above "Nothing running" while the machine is short on memory, and leaves a calm one quiet', async () => {
  const quiet = createProcessesAnswer();
  const nothing = { ...quiet, leftBehind: [], owners: quiet.owners.filter(owner => owner.owner.kind === 'happier') };
  const calm = await mount({ answer: nothing });
  expect(calm.screen.findByTestId('machine-processes-nothing')).not.toBeNull();
  // The state agrees with the table beneath it, which still lists Happier itself.
  expect(textOf(calm.screen.findByTestId('machine-processes-nothing'))).toContain('Only Happier is running on leeroy-mbp');
  expect(calm.screen.findByTestId('machine-processes-tile-memory')).toBeNull();
  const short = await mount({ answer: nothing, machine: { daemonState: { resources: { v: 1, vitals: { state: 'reporting' },
    host: { logicalCores: 18, memoryTotalBytes: 128 * GB, bootedAt: 1 },
    attention: { level: 'needs_you', reasons: [{ key: 'memory', kind: 'memory_pressure', level: 'needs_you', since: 1, metric: 'memory',
      nextStep: 'review_processes', pressure: 'critical', swapping: true }] } } } } });
  expect(short.screen.findByTestId('machine-processes-nothing')).not.toBeNull();
  expect(short.screen.findByTestId('machine-processes-tile-memory')).not.toBeNull();
});
it('lists the one process of a single-process owner on its phone page, so it can be opened', async () => {
  const answer = createProcessesAnswer();
  const { screen } = await mount({ answer, params: { id: 'processes', page: 'owner', owner: 'service:website' }, waitForRows: false,
    machine: { daemonState: { resources: { v: 1, vitals: { state: 'reporting' },
      host: { logicalCores: 18, effectiveCores: 1.26, memoryTotalBytes: 128 * GB, bootedAt: 1 },
      attention: { level: 'calm', reasons: [] } } } } });
  const row = await vi.waitFor(() => {
    const found = screen.findByTestId('machine-processes-owner-row-p:website');
    expect(found).not.toBeNull();
    return found;
  });
  expect(textOf(row)).toContain('1.2 GB');
  expect(screen.getTextContent()).toContain(t('machineProcesses.phone.cpuOfCores', { cores: 1.26 }));
});
type Screen = Awaited<ReturnType<typeof mount>>['screen'];
/** The row's menu owner (DropdownMenu): choose an item the way a press on it does. */
function chooseMenuItem(screen: Screen, key: string, itemId: string) {
    const menu = screen.root.findAll(node => node.props.testID === `machine-processes-menu-${key}` && typeof node.props.onSelect === 'function')[0];
    if (!menu) throw new Error(`No menu for ${key}`);
    menu.props.onSelect(itemId);
    return menu;
}
const labelledRows = (screen: Screen) => [...new Set(screen.root.findAll(node => typeof node.props.testID === 'string'
    && typeof node.type === 'string' && /^machine-processes-label-[^:]+:[^:]+$/u.test(node.props.testID)).map(node => node.props.testID as string))];

beforeEach(async () => {
  await home.reset();
  machineProcessesStore.reset();
  transport.rpc.mockReset();
});
afterEach(async () => {
  standardCleanup();
  machineProcessesStore.reset();
  await home.reset();
});

describe('MachineProcessesTab', () => {
  it('conceals hidden left-behind Session bylines and restores them after sharing', async () => {
    const { screen, serverId } = await mount({ params: { id: 'processes', filter: 'leftBehind' } });
    const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
    const previous = storage.getState();
    const row = createSessionListRenderableSessionFixture({ id: 'ended', metadata: {
      name: 'Private ended project', path: '/private-ended', host: 'host', machineId: 'machine',
    } });
    try {
      await act(async () => {
        storage.setState({ sessionListRowsByServerId: { ...previous.sessionListRowsByServerId, [serverId]: { [row.id]: row } } });
        storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [serverId]: ['private'] } });
        storage.getState().setSessionTagAssignmentsOptimistic(serverId, row.id, ['private']);
      });
      expect(screen.getTextContent()).toContain('Private ended project');
      await act(async () => { setScreenSharingPrivacyActive(true); });
      expect(screen.getTextContent()).not.toContain('Private ended project');
      expect(screen.findByTestId('machine-processes-row-l:left-next')).not.toBeNull();
      await act(async () => { setScreenSharingPrivacyActive(false); });
      expect(screen.getTextContent()).toContain('Private ended project');
    } finally { setScreenSharingPrivacyActive(false); await screen.unmount(); storage.setState(previous, true); }
  });

  it('keeps native container inspection but offers no raw process Stop or Kill', async () => {
    const answer = createProcessesAnswer();
    const owner = answer.owners[0];
    owner.owner = { kind: 'container', serverId: 'home', machineId: 'machine', serviceId: 'production/web',
      containerId: 'a'.repeat(64), composeProject: 'production', composeService: 'web', environmentId: 'environment' };
    const { screen } = await mount({ answer });
    expect(screen.root.findAll(node => node.props.testID === `machine-processes-menu-o:${owner.rowId}`)).toHaveLength(0);
    await act(async () => { screen.pressByTestId(`machine-processes-row-o:${owner.rowId}`); });
    const menu = await vi.waitFor(() => {
      const found = screen.root.findAll(node => node.props.testID === 'machine-processes-menu-p:agent' && Array.isArray(node.props.items))[0];
      expect(found).toBeDefined(); return found!;
    });
    expect(menu.props.items.map((item: { id: string }) => item.id)).toContain('copy');
    expect(menu.props.items.map((item: { id: string }) => item.id)).not.toContain('kill');
    expect(transport.rpc.mock.calls.some(call => [RPC_METHODS.MACHINES_PROCESSES_KILL, RPC_METHODS.MACHINES_PROCESSES_STOP].includes(call[0]?.method))).toBe(false);
  });
  it('keeps mounted Processes snapshots stable and updates CPU and memory from its Account-qualified demand', async () => {
    const snapshots = new Set<() => unknown>();
    const useSyncExternalStore = React.useSyncExternalStore;
    const observe = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((subscribe, getSnapshot, getServerSnapshot) => {
      snapshots.add(getSnapshot);
      return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    });
    const errors = vi.spyOn(console, 'error');
    let sampledAt = Date.now();
    let cpu: number | null = 39;
    let availableBytes = 71 * GB;
    const expectStableSnapshots = () => {
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now');
      try {
        for (const getSnapshot of snapshots) {
          clock.mockReturnValue(now);
          const before = getSnapshot();
          // Wall time alone cannot change a snapshot between React consistency reads;
          // the shared presence deadline must publish its clock transition first.
          clock.mockReturnValue(now + 3_600_000);
          expect(getSnapshot()).toBe(before);
        }
      } finally {
        clock.mockRestore();
      }
    };
    try {
      const { screen, serverId } = await mount({ reply: ({ method }) => method === RPC_METHODS.MACHINES_VITALS_GET ? {
        state: 'reporting', sample: { v: 1, sampledAt, intervalMs: 15_000,
          cpu: { reported: true, busyPct: cpu },
          memory: { reported: true, totalBytes: 128 * GB, availableBytes, usedBytes: 128 * GB - availableBytes, pressure: { level: 'calm', source: 'psi' } },
          disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 0, txBps: 0 } },
        series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] }, attention: { level: 'calm', reasons: [] },
      } : undefined });
      const key = { serverId, expectedAccountId: 'owner', machineId: 'machine', view: 'summary' as const };
      await vi.waitFor(() => expect(machineResourceStore.getState(key).status).toBe('ready'));
      await vi.waitFor(() => expect(textOf(screen.findByTestId('machine-processes-tile-cpu'))).toContain('39'));
      expect(textOf(screen.findByTestId('machine-processes-tile-memory'))).toContain('71');
      expect(snapshots.size).toBeGreaterThan(0);
      expect([...snapshots].some(getSnapshot => getSnapshot() === machineResourceStore.getState(key))).toBe(true);
      expectStableSnapshots();

      sampledAt += 15_000;
      cpu = 51;
      availableBytes = 69 * GB;
      await act(async () => {
        await machineResourceStore.retry(key);
      });
      expect(textOf(screen.findByTestId('machine-processes-tile-cpu'))).toContain('51');
      expect(textOf(screen.findByTestId('machine-processes-tile-memory'))).toContain('69');
      // A sample without a CPU figure (a gap between measurements) keeps the retained one, never "— %".
      sampledAt += 15_000;
      cpu = null;
      await act(async () => {
        await machineResourceStore.retry(key);
      });
      expect(textOf(screen.findByTestId('machine-processes-tile-cpu'))).toContain('51');
      expect(textOf(screen.findByTestId('machine-processes-tile-cpu'))).not.toContain('—');
      expectStableSnapshots();
      expect(errors.mock.calls.filter(args => args.some(value => String(value).includes('getSnapshot should be cached')))).toEqual([]);
    } finally {
      observe.mockRestore();
      errors.mockRestore();
    }
  });
  it('renders the browser engine and redacted driver in its existing row', async () => {
    const answer = createProcessesAnswer();
    const owner = answer.owners[0];
    owner.members.push(processRow('browser-main', 'runner', { role: 'browser', browserEngine: 'chromium', browserHelper: false,
      command: 'chromium --headless', driverLabel: 'node playwright test', memoryBytes: 10,
      browserGroup: { memberRefs: ['browser-main'], totals: { memoryBytes: 10, processCount: 1 } } }));
    const { screen } = await mount({ answer });
    await act(async () => { screen.pressByTestId(`machine-processes-row-o:${owner.rowId}`); });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-processes-row-p:browser-main')).not.toBeNull()); });
    // Collection paints controls and text beside its press target; the cell owns the visible row.
    const row = textOf(screen.findHostByTestId('machine-processes-row-p:browser-main:cell'));
    expect(row).toContain('Chromium');
    expect(row).toContain('node playwright test');
  });
  it('names an owned row by the display name the daemon gave it, beside its role and native name', async () => {
    const answer = createProcessesAnswer();
    const owner = answer.owners[0];
    owner.members.find((row) => row.ref === 'vite')!.displayName = 'Vite';
    const { screen } = await mount({ answer });
    await act(async () => { screen.pressByTestId(`machine-processes-row-o:${owner.rowId}`); });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-processes-row-p:vite')).not.toBeNull()); });
    const row = textOf(screen.findHostByTestId('machine-processes-row-p:vite:cell'));
    expect(row).toContain('Vite');
    expect(row).toContain('Dev server · node');
    // A row with no display name keeps its role in words, and external wire rows still carry no command.
    expect(textOf(screen.findHostByTestId('machine-processes-row-p:tsgo:cell'))).toContain('Type checker');
  });
  it('opens a phone app group on its own page and offers each process there its Kill action', async () => {
    const answer = createProcessesAnswer({
      notHappier: [{ appGroup: 'Docker Desktop', members: [
        { name: 'com.docker.backend', appGroup: 'Docker Desktop', pid: 900, ref: 'docker-backend', memoryBytes: 640, cpuPercent: 0.1 },
        { name: 'com.docker.virtualization', appGroup: 'Docker Desktop', pid: 901, ref: 'docker-vm', memoryBytes: 5_000, cpuPercent: 0.4 },
      ] }],
    });
    const machine = { metadata: { host: 'leeroy-mbp', platform: 'darwin', happyCliVersion: '0.3.0', happyHomeDir: '/Users/leeroy/.happier',
      homeDir: '/Users/leeroy', resourcesPolicyV1: { v: 1, processes: { allProcessesVisible: true } } } as Machine['metadata'] };
    device.type = 'phone';
    try {
      const list = await mount({ answer, machine });
      await act(async () => { list.screen.pressByTestId('machine-processes-scope:all'); });
      await act(async () => { await vi.waitFor(() => expect(list.screen.findByTestId('machine-processes-row-a:Docker Desktop')).not.toBeNull()); });
      await act(async () => { list.screen.pressByTestId('machine-processes-row-a:Docker Desktop'); });
      expect(list.setParams).toHaveBeenLastCalledWith({ id: 'processes', page: 'app', app: 'Docker Desktop' });
      const page = await mount({ answer, machine, params: { id: 'processes', page: 'app', app: 'Docker Desktop' }, waitForRows: false });
      await act(async () => { await vi.waitFor(() => expect(page.screen.findByTestId('machine-processes-app-page')).not.toBeNull()); });
      await act(async () => { await vi.waitFor(() => expect(page.screen.findByTestId('machine-processes-app-row-m:docker-backend')).not.toBeNull()); });
      expect(page.screen.findByTestId('machine-processes-app-row-m:docker-vm')).not.toBeNull();
      expect(page.screen.root.findAll(node => node.props.testID === 'machine-processes-menu-m:docker-backend' && Array.isArray(node.props.items))[0]!.props.items
        .map((item: { title: string }) => item.title)).toEqual(['Copy name', 'Kill process…']);
    } finally {
      device.type = null;
    }
  });
  it('shows a matching external app’s processes and figures when searching All processes, never a zero match', async () => {
    const answer = createProcessesAnswer({
      notHappier: [{ appGroup: 'Docker Desktop', members: [
        { name: 'com.docker.backend', appGroup: 'Docker Desktop', pid: 900, ref: 'docker-backend', memoryBytes: 640, cpuPercent: 0.1 },
      ] }],
    });
    const { screen } = await mount({ answer, machine: { metadata: { host: 'leeroy-mbp', platform: 'darwin', happyCliVersion: '0.3.0',
      happyHomeDir: '/Users/leeroy/.happier', homeDir: '/Users/leeroy', resourcesPolicyV1: { v: 1, processes: { allProcessesVisible: true } } } as Machine['metadata'] } });
    await act(async () => { screen.pressByTestId('machine-processes-scope:all'); });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-processes-row-a:Docker Desktop')).not.toBeNull()); });
    await act(async () => { screen.changeTextByTestId('machine-processes-search', 'backend'); });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-processes-row-m:docker-backend')).not.toBeNull()); });
    expect(textOf(screen.findByTestId('machine-processes-total-match'))).toContain('1');
    expect(textOf(screen.findByTestId('machine-processes-total-match'))).not.toContain('0 of');
  });
  it('does not open an empty detail under an external app’s member (it has nothing to peek)', async () => {
    const answer = createProcessesAnswer({
      notHappier: [{ appGroup: 'Docker Desktop', members: [
        { name: 'com.docker.backend', appGroup: 'Docker Desktop', pid: 900, ref: 'docker-backend', memoryBytes: 640, cpuPercent: 0.1 },
      ] }],
    });
    const { screen } = await mount({ answer, machine: { metadata: { host: 'leeroy-mbp', platform: 'darwin', happyCliVersion: '0.3.0',
      happyHomeDir: '/Users/leeroy/.happier', homeDir: '/Users/leeroy', resourcesPolicyV1: { v: 1, processes: { allProcessesVisible: true } } } as Machine['metadata'] } });
    await act(async () => { screen.pressByTestId('machine-processes-scope:all'); });
    await act(async () => { screen.changeTextByTestId('machine-processes-search', 'backend'); });
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(screen.findByTestId('machine-processes-row-m:docker-backend')).not.toBeNull();
    });
    await act(async () => { screen.pressByTestId('machine-processes-row-m:docker-backend'); });
    expect(screen.findByTestId('machine-processes-row-m:docker-backend:peek-cell')).toBeNull();
  });
  it.each([
    { id: 'processes' as const },
    { id: 'processes' as const, page: 'owner' as const, owner: 'session:refactor' },
  ])('shows offline without a loading surface when no process answer exists ($page)', async (params) => {
    const { screen } = await mount({ online: false, waitForRows: false, params });
    expect(screen.findByTestId('machine-processes-offline-empty')).not.toBeNull();
    expect(screen.findByTestId('machine-processes-table')).toBeNull();
    expect(transport.rpc.mock.calls.some(([rpc]: readonly unknown[]) => typeof rpc === 'object' && rpc !== null && 'method' in rpc
      && (rpc.method === RPC_METHODS.MACHINES_PROCESSES_LIST || rpc.method === RPC_METHODS.DAEMON_PROCESSES_WATCH))).toBe(false);
  });

  it('keeps unknown presence distinct from offline while no process answer can be read', async () => {
    const { screen } = await mount({ online: null, waitForRows: false });
    expect(screen.findByTestId('machine-processes-unknown') !== null).toBe(true);
    expect(screen.findByTestId('machine-processes-offline-empty')).toBeNull();
    expect(transport.rpc.mock.calls.some(([rpc]: readonly unknown[]) => typeof rpc === 'object' && rpc !== null && 'method' in rpc
      && (rpc.method === RPC_METHODS.MACHINES_PROCESSES_LIST || rpc.method === RPC_METHODS.DAEMON_PROCESSES_WATCH))).toBe(false);
  });

  it('explains a connected predecessor missing the process operation instead of a failed request', async () => {
    const { screen } = await mount({ waitForRows: false, reply: (rpc) => {
      if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_LIST) throw new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND);
    } });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-processes-older')).not.toBeNull()); });
    expect(screen.findByTestId('machine-processes-error')).toBeNull();
  });

  it('shows checking until the first process answer arrives, then becomes live', async () => {
    await import('@/sync/ops/actions/defaultActionExecutor');
    let answer!: (value: MachineProcessesAnswerV1) => void;
    const pending = new Promise<MachineProcessesAnswerV1>((resolve) => { answer = resolve; });
    const { screen, serverId } = await mount({ waitForRows: false, reply: (rpc) =>
      rpc.method === RPC_METHODS.MACHINES_PROCESSES_LIST ? pending : undefined });
    const current = machine();
    publishMachineActivityForTest([current]);
    await act(async () => { await publishTruthMachineInventory({ serverId, accountId: 'owner' }, [current]); });
    expect(screen.findByTestId('machine-processes-checking')).not.toBeNull();
    expect(screen.findByTestId('machine-processes-live')).toBeNull();
    await act(async () => { answer(createProcessesAnswer()); });
    await vi.waitFor(() => expect(screen.findByTestId('machine-processes-live')).not.toBeNull());
    expect(screen.findByTestId('machine-processes-checking')).toBeNull();
  });

  it.each([null, 0])('keeps unknown owner meters distinct from measured zero (%s)', async (value) => {
    await import('@/sync/ops/actions/defaultActionExecutor');
    const answer = createProcessesAnswer();
    const owner = answer.owners[0]!;
    if (value === null) delete owner.totals.cpuPercent;
    else owner.totals.cpuPercent = value;
    owner.totals.memoryBytes = value;
    const { screen, serverId } = await mount({ answer, params: { id: 'processes', page: 'owner', owner: owner.rowId }, waitForRows: false });
    const current = machine();
    publishMachineActivityForTest([current]);
    await act(async () => { await publishTruthMachineInventory({ serverId, accountId: 'owner' }, [current]); });
    const descriptions = () => screen.root.findAll(node => typeof node.props.accessibilityLabel === 'string')
      .map(node => node.props.accessibilityLabel as string);
    await act(async () => { await vi.waitFor(() => expect(descriptions().some(label => label.startsWith(`${t('machineProcesses.tiles.cpu')} `) && label.includes(' / '))).toBe(true)); });
    const cpu = descriptions().find(label => label.startsWith(`${t('machineProcesses.tiles.cpu')} `) && label.includes(' / '));
    const memory = descriptions().find(label => label.startsWith(`${t('machineProcesses.tiles.memory')} `) && label.includes(' / '));
    expect(cpu).toContain(value === null ? 'Unknown / ' : ', 0 / ');
    expect(memory).toContain(value === null ? 'Unknown / ' : ', 0 / ');
  });

  it.each([
    ['error', new Error('request failed')],
    ['older', new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND)],
  ])('does not claim live or checking after the first read settles as %s', async (state, error) => {
    await import('@/sync/ops/actions/defaultActionExecutor');
    const { screen, serverId } = await mount({ waitForRows: false, reply: (rpc) => {
      if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_LIST) throw error;
    } });
    const current = machine();
    publishMachineActivityForTest([current]);
    await act(async () => { await publishTruthMachineInventory({ serverId, accountId: 'owner' }, [current]); });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId(`machine-processes-${state}`)).not.toBeNull()); });
    expect(screen.findByTestId('machine-processes-live')).toBeNull();
    expect(screen.findByTestId('machine-processes-checking')).toBeNull();
  });

  it('lists each owner with its own totals, opens one in place, and closes on Happier in total', async () => {
    const { screen } = await mount();
    // Owners carry their totals; what they started stays folded until the owner is opened.
    expect(
      screen.findByTestId('machine-processes-row-o:service:website'),
    ).not.toBeNull();
    expect(
      textOf(
        screen.findByTestId('machine-processes-memory-o:session:refactor'),
      ),
    ).toBe('3.75 GB');
    expect(screen.findByTestId('machine-processes-row-p:tsgo')).toBeNull();
    await act(async () => {
      screen.pressByTestId('machine-processes-row-o:session:refactor');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('machine-processes-row-p:tsgo'),
        ).not.toBeNull(),
      );
    });
    // The runner is the owner row itself, never a child of it.
    expect(screen.findByTestId('machine-processes-row-p:runner')).toBeNull();
    expect(screen.getTextContent()).toContain('Happier in total');
    expect(
      textOf(screen.findByTestId('machine-processes-total-happier-memory')),
    ).toBe('5.13 GB');
  });

  it('keeps the totals figures on a phone, where the rows say memory beside their name', async () => {
    device.type = 'phone';
    try {
      const { screen } = await mount();
      expect(textOf(screen.findByTestId('machine-processes-memory-o:session:refactor'))).toBe('3.75 GB');
      expect(textOf(screen.findByTestId('machine-processes-total-happier-memory'))).toBe('5.13 GB');
    } finally {
      device.type = null;
    }
  });

  it('says once, in its freshness chip, that the machine stopped answering, and keeps the rows', async () => {
    let lists = 0;
    const { screen } = await mount({
      reply: (rpc) => {
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_LIST) lists += 1;
        // The machine answers the first read, then stops answering.
        if (rpc.method === RPC_METHODS.DAEMON_PROCESSES_WATCH) return Promise.reject(new Error('timeout'));
        return undefined;
      },
    });
    await act(async () => {
      await vi.waitFor(() => expect(screen.findByTestId('machine-processes-stale')).not.toBeNull());
    });
    // One cause, one place: the chip says when and offers Retry; no second strip, no "Live", rows at full strength.
    expect(textOf(screen.findByTestId('machine-processes-stale'))).toContain('Retry');
    expect(screen.findByTestId('machine-processes-live')).toBeNull();
    expect(screen.getTextContent()).not.toContain('Live');
    expect(screen.findByTestId('machine-processes-row-o:session:refactor')).not.toBeNull();
    const before = lists;
    await act(async () => {
      screen.pressByTestId('machine-vitals-retry');
    });
    await act(async () => {
      await vi.waitFor(() => expect(lists).toBeGreaterThan(before));
    });
  });

  it('labels only what it cannot prove', async () => {
    const { screen } = await mount();
    await act(async () => {
      screen.pressByTestId('machine-processes-row-o:session:refactor');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('machine-processes-row-p:vite'),
        ).not.toBeNull(),
      );
    });
    expect(labelledRows(screen)).toEqual(['machine-processes-label-p:vite']);
    const text = screen.getTextContent();
    expect(text).toContain('Likely');
    expect(text).not.toContain('Proven');
  });

  it('recounts Left behind to the rows a search leaves, and its cleanup echoes exactly those', async () => {
    const cleanups: unknown[] = [];
    const { screen } = await mount({
      reply: (rpc) => {
        if (rpc.method !== RPC_METHODS.MACHINES_PROCESSES_LEFT_BEHIND_CLEAN_UP)
          return undefined;
        cleanups.push(rpc.payload);
        return {
          ended: [{ ref: 'left-postgres', freedBytes: 150 * 1024 * 1024 }],
          skipped: [],
        };
      },
    });
    expect(screen.getTextContent()).toContain('Clean up 3 · 1.37 GB');
    await act(async () => {
      screen.changeTextByTestId('machine-processes-search', 'postgres');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.getTextContent()).toContain('Clean up 1 · 150 MB'),
      );
    });
    expect(screen.findByTestId('machine-processes-row-l:left-next')).toBeNull();
    expect(
      screen.findByTestId('machine-processes-row-l:left-postgres'),
    ).not.toBeNull();
    await act(async () => {
      screen.pressByTestId('machine-processes-tile-left-behind');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.findByTestId('machine-processes-review')).not.toBeNull(),
      );
    });
    expect(
      textOf(screen.findByTestId('machine-processes-review-summary')),
    ).toContain('1 of 1 selected');
    await act(async () => {
      screen.pressByTestId('machine-processes-review-confirm');
    });
    await act(async () => {
      await vi.waitFor(() => expect(cleanups).toHaveLength(1));
    });
    expect(cleanups[0]).toMatchObject({
      machineId: 'machine',
      refs: ['left-postgres'],
    });
  });

  it('checks a process it cannot prove again before it can be killed, and says what it found', async () => {
    const kills: unknown[] = [];
    const { screen } = await mount({
      askBeforeKill: true,
      reply: (rpc) => {
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_GET) {
                return { row: { ...createProcessesAnswer().owners[0]!.members.find(row => row.ref === 'vite')!, evidence: [
                    { kind: 'fence', state: 'not_available', reason: 'macos_no_fence' },
                    { kind: 'group_and_port', state: 'met', reason: 'same_group_port_opened_while_running' }] }, owner: { kind: 'session', sessionId: 'refactor' } };
            }
            if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_CHECK)
          return {
            checks: [
              {
                ref: 'vite',
                present: true,
                identityEqual: true,
                level: 'likely',
              },
            ],
          };
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_KILL) {
          kills.push(rpc.payload);
          return {
            status: 'ended',
            outcomes: [{ ref: 'vite', outcome: 'ended', freedBytes: 1 }],
          };
        }
        return undefined;
      },
    });
    await act(async () => {
      screen.pressByTestId('machine-processes-row-o:session:refactor');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('machine-processes-menu-p:vite'),
        ).not.toBeNull(),
      );
    });
    await act(async () => {
      chooseMenuItem(screen, 'p:vite', 'kill');
    });
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(
        textOf(screen.findByTestId('machine-processes-kill-ask-first-note')),
      ).toContain('Checked again just now: same process, started');
    });
    expect(screen.getTextContent()).toContain(
      'Same group as the session, and its port opened while it ran',
    );
    await act(async () => {
      screen.pressByTestId('machine-processes-kill-ask-first-confirm');
    });
    await act(async () => {
      await vi.waitFor(() => expect(kills).toHaveLength(1));
    });
    expect(kills[0]).toMatchObject({
      tree: false,
      targets: [
        {
          ref: 'vite',
          expect: {
            level: 'likely',
            owner: { kind: 'session', sessionId: 'refactor' },
          },
        },
      ],
    });
  });

  it.each([true, false])('rechecks unproven identity even when Kill approval is waived (same=%s)', async (same) => {
    retirePresentationNotice();
    const kills: unknown[] = [];
    const { screen } = await mount({
      reply: (rpc) => {
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_GET)
          return { row: createProcessesAnswer().owners[0]!.members.find(row => row.ref === 'vite')!, owner: { kind: 'session', sessionId: 'refactor' } };
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_CHECK)
          return { checks: [{ ref: 'vite', present: true, identityEqual: same, level: 'likely' }] };
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_KILL) {
          kills.push(rpc.payload);
          return { status: 'ended', outcomes: [{ ref: 'vite', outcome: 'ended' }] };
        }
        return undefined;
      },
    });
    await act(async () => { screen.pressByTestId('machine-processes-row-o:session:refactor'); });
    await act(async () => { chooseMenuItem(screen, 'p:vite', 'kill'); });
    await act(async () => {
      await vi.waitFor(() => expect(transport.rpc.mock.calls.some(([rpc]) => rpc.method === RPC_METHODS.MACHINES_PROCESSES_CHECK)).toBe(true));
      if (same) await vi.waitFor(() => expect(kills).toHaveLength(1));
      else await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ key: 'machine-processes:kill:p:vite', severity: 'warning' }));
    });
    expect(kills).toHaveLength(same ? 1 : 0);
    expect(screen.findByTestId('machine-processes-kill-ask-first-confirm')).toBeNull();
  });

  it('shows a refused identity check as a permission failure and leaves the process alone', async () => {
    retirePresentationNotice();
    const { screen } = await mount({
      reply: rpc => {
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_GET) return { row: null };
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_CHECK) throw new RpcError('Private diagnostic', RPC_ERROR_CODES.FORBIDDEN);
        return undefined;
      },
    });
    try {
      await act(async () => { screen.pressByTestId('machine-processes-row-o:session:refactor'); });
      await act(async () => { chooseMenuItem(screen, 'p:vite', 'kill'); });
      await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({
        key: 'machine-processes:kill:p:vite', severity: 'warning', message: t('errors.permissionDenied'),
      }));
      expect(transport.rpc.mock.calls.some(([rpc]) => rpc.method === RPC_METHODS.MACHINES_PROCESSES_KILL)).toBe(false);
    } finally { await screen.unmount(); }
  });

  it('opens filtered to Left behind from a link (filter=leftBehind), and Show all returns the whole list', async () => {
    const { parseMachineProcessesParams } = await import('./MachineProcessesTab');
    expect(parseMachineProcessesParams({ filter: 'leftBehind', sort: 'cpu' })).toEqual({ id: 'processes', sort: 'cpu', filter: 'leftBehind' });
    expect(parseMachineProcessesParams({ filter: 'other' })).toEqual({ id: 'processes' });
    const { screen, setParams } = await mount({ params: { id: 'processes', filter: 'leftBehind' } });
    const leftRows = screen.root.findAll((node) => typeof node.type === 'string' && String(node.props.testID ?? '').startsWith('machine-processes-row-l:'));
    expect(leftRows.length).toBeGreaterThan(0);
    expect(screen.findByTestId('machine-processes-row-o:service:website')).toBeNull();
    await act(async () => {
      screen.pressByTestId('machine-processes-show-everything');
    });
    expect(setParams).toHaveBeenCalledWith({ id: 'processes' });
  });

  it('honors the shared Stop waiver for guest and own work without a caller confirmation', async () => {
    const base = createProcessesAnswer();
    const answer = { ...base, owners: base.owners.map((owner) => owner.rowId === 'session:refactor'
      ? { ...owner, requester: { accountId: 'guest', displayName: 'Ben' } } : owner) };
    const stops: unknown[] = [];
    const { screen } = await mount({
      answer,
      reply: (rpc) => {
        if (rpc.method !== RPC_METHODS.MACHINES_PROCESSES_STOP) return undefined;
        stops.push(rpc.payload);
        return { status: 'ended', outcomes: [{ ref: 'runner', outcome: 'ended', freedBytes: 1 }] };
      },
    });
    await act(async () => {
      chooseMenuItem(screen, 'o:session:refactor', 'stop');
    });
    await act(async () => { await vi.waitFor(() => expect(stops).toHaveLength(1)); });
    expect(screen.findByTestId('machine-processes-stop-guest-confirm')).toBeNull();

    await act(async () => {
      chooseMenuItem(screen, 'o:service:website', 'stop');
    });
    await act(async () => { await vi.waitFor(() => expect(stops).toHaveLength(2)); });
    expect(screen.findByTestId('machine-processes-stop-guest-confirm')).toBeNull();
  });

  it('keeps guest work available when the person cancels an explicit Ask-first Stop', async () => {
    const base = createProcessesAnswer();
    const answer = { ...base, owners: base.owners.map(owner => owner.rowId === 'session:refactor'
      ? { ...owner, requester: { accountId: 'guest', displayName: 'Ben' } } : owner) };
    const stops: unknown[] = [];
    const { screen, serverId } = await mount({ answer, askBeforeStop: true, reply: rpc => {
      if (rpc.method !== RPC_METHODS.MACHINES_PROCESSES_STOP) return undefined;
      stops.push(rpc.payload);
      return { status: 'ended', outcomes: [{ ref: 'runner', outcome: 'ended' }] };
    } });
    const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
    const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
    const approvals = home.artifacts(serverId);
    await act(async () => { chooseMenuItem(screen, 'o:session:refactor', 'stop'); });
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(1));
    const first = approvals.list()[0]!;
    const request = () => ApprovalRequestV2Schema.parse(JSON.parse(approvals.readPlainBody(first.id)!));
    expect(request()).toMatchObject({ status: 'open', actionId: 'machines.processes.stop',
      actionArgs: { targets: [{ ref: 'runner', expect: { owner: { kind: 'session', sessionId: 'refactor' } } }] } });
    expect(stops).toHaveLength(0);
    // Explicit Ask retains durable approval custody, rather than a default-only inline confirmation.
    expect(screen.findByTestId('machine-processes-stop-guest-confirm')).toBeNull();
    expect((await decideApprovalAsInbox(serverId, first.id, 'cancel')).ok).toBe(true);
    expect(request().status).toBe('canceled');
    expect(screen.findByTestId('machine-processes-row-o:session:refactor')).not.toBeNull();
    expect(stops).toHaveLength(0);
    await act(async () => { chooseMenuItem(screen, 'o:session:refactor', 'stop'); });
    await vi.waitFor(() => expect(approvals.list()).toHaveLength(2));
    expect(stops).toHaveLength(0);
  });

  it('keeps Stop session as the alternative inside shared Kill-tree policy without issuing Kill', async () => {
    const effects: string[] = [];
    const { screen } = await mount({ askBeforeKill: true, reply: rpc => {
      if (rpc.method !== RPC_METHODS.MACHINES_PROCESSES_STOP && rpc.method !== RPC_METHODS.MACHINES_PROCESSES_KILL) return undefined;
      effects.push(rpc.method);
      return { status: 'ended', outcomes: [{ ref: 'runner', outcome: 'ended' }] };
    } });
    await act(async () => { chooseMenuItem(screen, 'o:session:refactor', 'kill-tree'); });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-processes-kill-tree-alternative')).not.toBeNull()); });
    expect(effects).toEqual([]);
    await act(async () => { screen.pressByTestId('machine-processes-kill-tree-alternative'); });
    await act(async () => { await vi.waitFor(() => expect(effects).toEqual([RPC_METHODS.MACHINES_PROCESSES_STOP])); });
  });

  it.each([
    [true, null],
    [false, null],
    [undefined, null],
    // A phone has no room reserved for the stop preview, but the way back stays under the meter.
    [true, 'phone'],
    [false, 'phone'],
  ] as const)('stopping a service offers Start again only when its owner reports availability (%s, %s)', async (canStartAgain, deviceType) => {
    device.type = deviceType;
    onTestFinished(() => { device.type = null; });
    const stops: unknown[] = [];
    const starts: unknown[] = [];
    const answer = createProcessesAnswer();
    answer.owners = answer.owners.map(owner => owner.owner.kind === 'service' ? { ...owner, canStartAgain } : owner);
    const { screen } = await mount({
      answer,
      reply: (rpc) => {
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_START_AGAIN) {
          starts.push(rpc.payload);
          return { status: 'started' };
        }
        if (rpc.method !== RPC_METHODS.MACHINES_PROCESSES_STOP)
          return undefined;
        stops.push(rpc.payload);
        return {
          status: 'ended',
          outcomes: [
            { ref: 'website', outcome: 'ended', freedBytes: 1.2 * GB },
          ],
        };
      },
    });
    await act(async () => {
      chooseMenuItem(screen, 'o:service:website', 'stop');
    });
    await act(async () => { await vi.waitFor(() => expect(stops).toHaveLength(1)); });
    // The row fades (160 ms) and its height closes (240 ms); then it is gone.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, PROCESS_ROW_EXIT_MS + 100)); });
    expect(screen.findByTestId('machine-processes-row-o:service:website')).toBeNull();
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          textOf(screen.findByTestId('machine-processes-freed')),
        ).toContain('1.2 GB freed'),
      );
    });
    expect(screen.findByTestId('machine-processes-start-again') !== null).toBe(canStartAgain === true);
    if (canStartAgain) {
      await act(async () => { screen.pressByTestId('machine-processes-start-again'); });
      await act(async () => { await vi.waitFor(() => expect(starts).toMatchObject([{ machineId: 'machine', ref: 'website' }])); });
    }
    expect(stops[0]).toMatchObject({
      targets: [
        {
          ref: 'website',
          expect: {
            level: 'proven',
            owner: { kind: 'service', serviceId: 'website' },
          },
        },
      ],
    });
  });

  it('never shows another app’s command line, only its name, in All processes', async () => {
    const answer = createProcessesAnswer({
      notHappier: [
        {
          appGroup: 'Docker Desktop',
          members: [
            {
              name: 'com.docker.backend',
              appGroup: 'Docker Desktop',
              pid: 900,
              ref: 'docker-backend',
              memoryBytes: 640,
              cpuPercent: 0.1,
            },
          ],
        },
      ],
    });
    const { screen } = await mount({
      answer,
      machine: {
        metadata: {
          host: 'leeroy-mbp',
          platform: 'darwin',
          happyCliVersion: '0.3.0',
          happyHomeDir: '/Users/leeroy/.happier',
          homeDir: '/Users/leeroy',
          resourcesPolicyV1: { v: 1, processes: { allProcessesVisible: true } },
        } as Machine['metadata'],
      },
    });
    await act(async () => {
      screen.pressByTestId('machine-processes-scope:all');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('machine-processes-row-a:Docker Desktop'),
        ).not.toBeNull(),
      );
    });
    await act(async () => {
      screen.pressByTestId('machine-processes-row-a:Docker Desktop');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('machine-processes-row-m:docker-backend'),
        ).not.toBeNull(),
      );
    });
    const row = textOf(
      screen.findHostByTestId('machine-processes-row-m:docker-backend:cell'),
    );
    expect(row).toContain('com.docker.backend');
    // Its menu offers the name only: the command never left the machine.
    expect(screen.root.findAll(node => node.props.testID === 'machine-processes-menu-m:docker-backend' && Array.isArray(node.props.items))[0]!.props.items.map((item: { title: string }) => item.title)).toEqual(['Copy name', 'Kill process…']);
  });
});

/**
 * A terminal whose own shell listens on :8080 and which started a dev server on :4000, as the
 * daemon reports it, plus the Local services feeds that list both listeners as detected services.
 */
function terminalPortsAnswer(): MachineProcessesAnswerV1 {
  const base = createProcessesAnswer();
  const shell = processRow('term-shell', 'terminal:dev', {
    name: 'zsh',
    role: 'tool_shell',
    command: 'zsh -l',
    memoryBytes: 40 * MB,
    startedAtMs: 100,
    ports: [{ port: 8080, inventoryEntryId: 'entry-8080' }],
  });
  const server = processRow('term-server', 'term-shell', {
    name: 'node',
    role: 'dev_server',
    command: 'node server.js',
    memoryBytes: 200 * MB,
    ports: [{ port: 4000, inventoryEntryId: 'entry-4000' }],
  });
  return {
    ...base,
    owners: [
      ...base.owners,
      {
        rowId: 'terminal:dev',
        owner: { kind: 'terminal', terminalId: 'dev' },
        state: 'running',
        totals: { memoryBytes: 240 * MB, cpuPercent: 0, processCount: 2 },
        members: [shell, server],
      },
    ],
  };
}

/** The preview the private-preview access owner registered for a listener (session-bound, as the daemon issues it). */
const previewResource = (port: number) => ({
  previewId: `preview-${port}`,
  sessionId: 'session-1',
  machineId: 'machine',
  owner: { kind: 'session' as const, id: 'session-1' },
  target: { scheme: 'http' as const, host: '127.0.0.1', port },
  initialPath: { pathname: '/', search: '' },
  display: { title: `localhost:${port}`, addressLabel: `localhost:${port}` },
  originMode: 'host' as const,
});
// :8080 already has a preview that this device has no private route to; :4000 has none yet.
const unreachablePreview = {
  previewId: 'preview-8080',
  resource: previewResource(8080),
  accessUrl: null,
  expiresAt: null,
  accessUnavailableReasonCode: 'preview_private_route_unavailable' as const,
  diagnostics: [],
};
const ACCESS_URL_4000 = 'https://preview-4000.preview.test/?previewToken=fresh';

const detected = (port: number) => ({
  id: `detected:${port}`,
  source: 'inventory_entry' as const,
  sourceClass: { kind: 'inventory_entry' as const, inventoryEntryId: `entry-${port}` },
  machineId: 'machine',
  title: `localhost:${port}`,
  subtitle: `localhost:${port}`,
  confidence: 'high' as const,
  state: 'available' as const,
  ...(port === 8080
    ? {
        actions: ['open_preview' as const, 'register_preview' as const, 'terminate_detected' as const],
        browserTarget: { kind: 'localServicePreview' as const, targetId: 'preview-8080', machineId: 'machine', sessionId: 'session-1' },
      }
    : { actions: ['register_preview' as const, 'terminate_detected' as const] }),
});

/** Local services' daemon boundary: the inventory and launcher reads, and the Actions it executes. */
function localServicesReply(executed: Record<string, unknown>[]) {
  return (rpc: Rpc): unknown => {
    if (
      rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT ||
      rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH
    )
      return {
        protocolVersion: 1,
        snapshot: {
          v: 1,
          machineId: 'machine',
          generatedAt: 2_000,
          refreshState: 'idle',
          entries: [8080, 4000].map((port) =>
            buildLocalServiceInventoryRow({ id: `entry-${port}`, machineId: 'machine', port }),
          ),
          diagnostics: [],
        },
      };
    if (rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT)
      return {
        protocolVersion: 1,
        snapshot: { v: 1, machineId: 'machine', updatedAt: 2_000, targets: [detected(8080), detected(4000)] },
      };
    if (rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT)
      return {
        protocolVersion: 1,
        snapshot: {
          v: 1,
          machineId: 'machine',
          generatedAt: 2_000,
          refreshState: 'idle',
          resources: [previewResource(8080)],
          previews: [unreachablePreview],
          diagnostics: [],
        },
      };
    if (rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE) {
      if (rpc.payload?.inventoryEntryId === 'entry-8080') return {
        protocolVersion: 1, status: 'existing', preview: unreachablePreview,
        snapshot: { v: 1, machineId: 'machine', generatedAt: 3_000, refreshState: 'idle',
          resources: [previewResource(8080)], previews: [unreachablePreview], diagnostics: [] },
      };
      const preview = { previewId: 'preview-4000', resource: previewResource(4000), accessUrl: ACCESS_URL_4000, expiresAt: 61_000, diagnostics: [] };
      return {
        protocolVersion: 1,
        status: 'created',
        preview,
        snapshot: {
          v: 1,
          machineId: 'machine',
          generatedAt: 3_000,
          refreshState: 'idle',
          resources: [previewResource(8080), previewResource(4000)],
          previews: [unreachablePreview, preview],
          diagnostics: [],
        },
      };
    }
    if (rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE) {
      const request = LocalServiceActionRequestV1Schema.parse(rpc.payload);
      executed.push(request);
      return DaemonLocalServiceActionExecuteResponseV1Schema.parse({
        protocolVersion: 1,
        result: { v: 1, requestId: request.requestId, action: request.action, status: 'succeeded', auditEvents: [{
          v: 1, eventId: `event:${request.requestId}`, requestId: request.requestId,
          machineId: request.target.machineId, action: request.action, result: 'succeeded', recordedAt: 3_000,
        }] },
      });
    }
    return undefined;
  };
}

type PortMenuItem = Readonly<{ id: string; title: string; subtitle?: string; disabled?: boolean }>;
const portMenu = (screen: Screen, key: string, port: number) =>
  screen.root.findAll(
    (node) =>
      node.props.testID === `machine-processes-port-menu-${key}-${port}` &&
      typeof node.props.onSelect === 'function',
  )[0];

/** Press the chip, then wait until its menu offers what Local services offers for that listener. */
async function openPortMenu(screen: Screen, key: string, port: number, expected = 'stop') {
  await act(async () => {
    screen.pressByTestId(`machine-processes-port-${key}-${port}`);
  });
  // The menu opens on the frame after the press.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  await act(async () => {
    await vi.waitFor(() =>
      expect(
        (portMenu(screen, key, port)?.props.items as PortMenuItem[] | undefined)?.map((item) => item.id),
      ).toContain(expected),
    );
  });
  return portMenu(screen, key, port)!;
}

async function openTerminal(screen: Screen) {
  await act(async () => {
    screen.pressByTestId('machine-processes-row-o:terminal:dev');
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(screen.findByTestId('machine-processes-row-p:term-server')).not.toBeNull(),
    );
  });
}

describe('MachineProcessesTab port chips', () => {
  it('refuses the final external tab when the link Action is disabled, then opens the admitted preview when allowed', async () => {
    const { screen, serverId } = await mount({ answer: terminalPortsAnswer(), reply: localServicesReply([]) });
    const { Linking } = await import('react-native');
    const openURL = vi.spyOn(Linking, 'openURL');
    const { Modal } = await import('@/modal');
    const alert = vi.mocked(Modal.alert);
    alert.mockClear();
    const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
    const setLinkPolicy = async (disabled: boolean) => {
      const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
        ...(disabled ? { actions: { 'links.openExternal': { enabled: false } } } : {}),
      });
      home.answer(serverId, '/v2/account/settings', { body: {
        content: { t: 'plain', v: { actionsSettingsV1 } }, version: disabled ? 2 : 3,
      } });
      await act(async () => { storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1 } })); });
    };
    await openTerminal(screen);
    await setLinkPolicy(true);
    const denied = await openPortMenu(screen, 'p:term-server', 4000, 'open-browser');
    await act(async () => { denied.props.onSelect('open-browser'); });
    await vi.waitFor(() => expect(alert).toHaveBeenCalled());
    expect(openURL).not.toHaveBeenCalled();
    expect(alert.mock.calls[0]?.[1]).toBe(t('actionConfirmations.turnedOffUnnamedMessage'));
    const details = alert.mock.calls[0]?.[2]?.find(button => button.text === t('common.details'));
    expect(details).toBeDefined();
    await act(async () => { details?.onPress?.(); });
    expect(alert.mock.calls.at(-1)?.[1]).toContain('action_disabled');
    await setLinkPolicy(false);
    const allowed = await openPortMenu(screen, 'p:term-server', 4000, 'open-browser');
    await act(async () => { allowed.props.onSelect('open-browser'); });
    await vi.waitFor(() => expect(openURL).toHaveBeenCalled());
    expect(openURL).toHaveBeenCalledExactlyOnceWith(ACCESS_URL_4000);
    openURL.mockRestore();
  });

  it('lets a Services-style port consumer open through the same lazy owner without a Processes controller', async () => {
    const { screen } = await mount({ sharedPort: 4000, reply: localServicesReply([]) });
    const serviceReads = () => transport.rpc.mock.calls.filter(([rpc]) => rpc.method.startsWith('daemon.localServices.'));
    expect(serviceReads()).toHaveLength(0);
    const { Linking } = await import('react-native');
    const openURL = vi.spyOn(Linking, 'openURL');
    await act(async () => { screen.pressByTestId('shared-port-demand'); });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('shared-port-open')).not.toBeNull()); });
    await act(async () => { screen.pressByTestId('shared-port-open'); });
    await act(async () => { await vi.waitFor(() => expect(openURL).toHaveBeenCalledWith(ACCESS_URL_4000)); });
    expect(transport.rpc.mock.calls.filter(([rpc]) => rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE))
      .toHaveLength(1);
    openURL.mockRestore();
  });

  it('keeps the shared port consumer on the preview owner refusal when this device has no private route', async () => {
    const { screen } = await mount({ sharedPort: 8080, reply: localServicesReply([]) });
    const { Linking } = await import('react-native');
    const openURL = vi.spyOn(Linking, 'openURL');
    await act(async () => { screen.pressByTestId('shared-port-demand'); });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('shared-port-open')?.props.accessibilityHint)
      .toBe(t('browserShell.unavailable.previewElsewhere'))); });
    // The external adapter also refuses the admitted preview when it has no access URL.
    await act(async () => { screen.pressByTestId('shared-port-open'); });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('shared-port-result')?.props.accessibilityValue)
      .toEqual({ text: 'false' })); });
    expect(openURL).not.toHaveBeenCalled();
    openURL.mockRestore();
  });

  it('keeps a row to its first listener and a count; the rest are in its detail', async () => {
    const answer = terminalPortsAnswer();
    const terminal = answer.owners.find((owner) => owner.rowId === 'terminal:dev')!;
    const server = terminal.members.find((member) => member.ref === 'term-server')!;
    (server as { ports: unknown }).ports = [
      { port: 4000, inventoryEntryId: 'entry-4000' },
      { port: 4001, inventoryEntryId: 'entry-4001' },
    ];
    const { screen } = await mount({ answer, reply: localServicesReply([]) });
    const chips = (key: string) => screen.root.findAll((node) => typeof node.props.testID === 'string'
      && node.props.testID.startsWith(`machine-processes-port-${key}-`) && typeof node.props.onPress === 'function')
      .map((node) => node.props.testID as string);
    await act(async () => {
      await vi.waitFor(() => expect(screen.findByTestId('machine-processes-row-o:terminal:dev')).not.toBeNull());
    });
    await openTerminal(screen);
    expect([...new Set(chips('p:term-server'))]).toEqual(['machine-processes-port-p:term-server-4000']);
    expect(screen.findByTestId('machine-processes-ports-more-p:term-server')).not.toBeNull();
    expect(textOf(screen.findByTestId('machine-processes-ports-more-p:term-server'))).toBe('+1');
    // The count is its own button: it shows the rest in place, each listener its own chip and menu.
    const more = screen.root.findAll((node) => node.props.testID === 'machine-processes-ports-more-p:term-server'
      && typeof node.props.onPress === 'function')[0]!;
    expect(more.props.accessibilityRole).toBe('button');
    await act(async () => { more.props.onPress(); });
    expect([...new Set(chips('p:term-server'))]).toHaveLength(2);
    expect(screen.findByTestId('machine-processes-ports-more-p:term-server')).toBeNull();
  });

  it('opens what Local services offers for the listener and copies its address through that Action', async () => {
    const executed: Record<string, unknown>[] = [];
    const { screen } = await mount({ answer: terminalPortsAnswer(), reply: localServicesReply(executed) });
    await openTerminal(screen);
    expect(transport.rpc.mock.calls.some(([rpc]: readonly unknown[]) => typeof rpc === 'object' && rpc !== null
      && 'method' in rpc && typeof rpc.method === 'string' && rpc.method.includes('daemon.localServices.'))).toBe(false);
    // Copy address appears once the inventory names where the listener answers.
    const menu = await openPortMenu(screen, 'p:term-server', 4000, 'copy');
    const items = menu.props.items as PortMenuItem[];
    expect(items.map((item) => item.title)).toEqual(['Open in browser', 'Copy address', 'Stop server on :4000']);
    expect(items[0]!.disabled).toBe(false);
    expect(items[1]!.subtitle).toBe('127.0.0.1:4000');
    expect(items[2]!.subtitle).toBe('Frees about 200 MB');
    await act(async () => {
      menu.props.onSelect('copy');
    });
    await act(async () => {
      await vi.waitFor(() => expect(executed).toHaveLength(1));
    });
    expect(executed[0]).toMatchObject({
      action: 'copy_url',
      target: { kind: 'inventory_entry', inventoryEntryId: 'entry-4000', machineId: 'machine' },
    });
    // Open in browser registers through the Services opener and opens the URL its access owner admits.
    const { Linking } = await import('react-native');
    const openURL = vi.spyOn(Linking, 'openURL');
    const reopened = await openPortMenu(screen, 'p:term-server', 4000, 'open-browser');
    await act(async () => {
      reopened.props.onSelect('open-browser');
    });
    await act(async () => {
      await vi.waitFor(() => expect(openURL).toHaveBeenCalledWith(ACCESS_URL_4000));
    });
    openURL.mockRestore();
  });

  it('keeps Open in browser for a listener this device has no route to, and says why', async () => {
    const { screen } = await mount({ answer: terminalPortsAnswer(), reply: localServicesReply([]) });
    const menu = await openPortMenu(screen, 'o:terminal:dev', 8080);
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          (portMenu(screen, 'o:terminal:dev', 8080)!.props.items as PortMenuItem[]).find((item) => item.id === 'open-browser'),
        ).toMatchObject({
          title: 'Open in browser',
          disabled: true,
          subtitle: t('browserShell.unavailable.previewElsewhere'),
        }),
      );
    });
    expect(menu).toBeDefined();
  });

  it('lets Allowed stop the shell’s listener through mounted Services admission without a second confirmation', async () => {
    const executed: Record<string, unknown>[] = [];
    const { screen } = await mount({ answer: terminalPortsAnswer(), reply: localServicesReply(executed) });
    await openTerminal(screen);
    const menu = await openPortMenu(screen, 'o:terminal:dev', 8080);
    await act(async () => { menu.props.onSelect('stop'); });
    await act(async () => { await vi.waitFor(() => expect(executed).toHaveLength(1)); });
    expect(screen.findByTestId('machine-processes-port-close-terminal')).toBeNull();
    expect(executed[0]).toMatchObject({ action: 'terminate_detected',
      target: { kind: 'inventory_entry', inventoryEntryId: 'entry-8080' } });
    const childMenu = await openPortMenu(screen, 'p:term-server', 4000);
    await act(async () => { childMenu.props.onSelect('stop'); });
    await act(async () => { await vi.waitFor(() => expect(executed).toHaveLength(2)); });
    expect(screen.findByTestId('machine-processes-port-close-terminal')).toBeNull();
    expect(executed[1]).toMatchObject({ action: 'terminate_detected',
      target: { kind: 'inventory_entry', inventoryEntryId: 'entry-4000' } });
  });

  it('uses the terminal-loss disclosure when shared Stop policy asks and keeps a decline quiet', async () => {
    const executed: Record<string, unknown>[] = [];
    const { screen } = await mount({ answer: terminalPortsAnswer(), reply: localServicesReply(executed), askBeforePortStop: true });
    const { Modal } = await import('@/modal');
    vi.mocked(Modal.alert).mockClear();
    await openTerminal(screen);
    // The terminal's own shell is its owner row; its port is the shell's listener.
    const shellMenu = await openPortMenu(screen, 'o:terminal:dev', 8080);
    await act(async () => {
      shellMenu.props.onSelect('stop');
    });
    expect(portMenu(screen, 'o:terminal:dev', 8080)!.props.open).toBe(false);
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.findByTestId('machine-processes-port-close-terminal')).not.toBeNull(),
      );
    });
    expect(textOf(screen.findByTestId('machine-processes-port-close-terminal'))).toContain(
      'This closes the terminal Terminal · zsh.',
    );
    expect(executed).toHaveLength(0);
    await act(async () => {
      screen.pressByTestId('machine-processes-port-close-terminal-confirm');
    });
    await act(async () => {
      await vi.waitFor(() => expect(executed).toHaveLength(1));
    });
    expect(executed[0]).toMatchObject({
      action: 'terminate_detected',
      target: { kind: 'inventory_entry', inventoryEntryId: 'entry-8080' },
    });

    // A second press is a fresh invocation, so declining it leaves the prior result intact.
    const again = await openPortMenu(screen, 'o:terminal:dev', 8080);
    await act(async () => { again.props.onSelect('stop'); });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-processes-port-close-terminal-cancel')).not.toBeNull()); });
    await act(async () => { screen.pressByTestId('machine-processes-port-close-terminal-cancel'); });
    expect(executed).toHaveLength(1);
    expect(screen.findByTestId('machine-processes-port-close-terminal')).toBeNull();
    expect(Modal.alert).not.toHaveBeenCalled();
  });
});
