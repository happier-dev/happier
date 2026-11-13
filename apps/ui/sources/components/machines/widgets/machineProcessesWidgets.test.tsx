import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import type { MachineProcessesAnswerV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import {
  createAccountTokenForTests,
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { Machine } from '@/sync/domains/state/storageTypes';

import {
  createProcessesAnswer,
  PROCESSES_FIXTURE_BYTES,
} from '@/components/machines/processes/testkit/processesAnswerFixture';

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
// Only the machine network and navigation are replaced; credential binding, the process store, Actions,
// approval policy, the Processes tab's controller and the widget bodies run for real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () => {
    const { createServerScopedMachineRpcBoundaryMock } =
      await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(transport.rpc);
  },
);
const routerMock = vi.hoisted(() => ({
  spies: null as unknown as { push: ReturnType<typeof vi.fn> },
}));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mock = createExpoRouterMock();
  routerMock.spies = mock.spies;
  return mock.module;
});
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ renderCustomModals: true }).module;
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
const { ModalProvider } = await import('@/modal');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storageStore');
const { machineProcessesStore } =
  await import('@/sync/domains/machines/processes/machineProcessesStore');
const { readPresentationNotice, retirePresentationNotice } =
  await import('@/components/sessions/presentation/presentationNotices');
const { measureMountedCollections } =
  await import('@/dev/testkit/render/renderInCollectionLayout');
const { MachineTopConsumersWidget } =
  await import('./MachineTopConsumersWidget');
const { MachineLeftBehindWidget } = await import('./MachineLeftBehindWidget');

const { GB } = PROCESSES_FIXTURE_BYTES;
type Rpc = Readonly<{ method: string; payload?: Record<string, unknown> }>;

function machine(overrides: Partial<Machine> = {}): Machine {
  return createMachineFixture({
    id: 'machine',
    active: true,
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
    ...overrides,
  });
}

const FOOTPRINTS = {
  small: {
    columns: 2,
    columnSpan: 1,
    rowSpan: 1,
    width: 'half',
    height: 'compact',
  },
  medium: {
    columns: 2,
    columnSpan: 1,
    rowSpan: 2,
    width: 'half',
    height: 'regular',
  },
  wide: {
    columns: 2,
    columnSpan: 2,
    rowSpan: 1,
    width: 'full',
    height: 'compact',
  },
} as const;

async function mount(
  options: Readonly<{
    Body: typeof MachineTopConsumersWidget;
    size?: keyof typeof FOOTPRINTS;
    answer?: MachineProcessesAnswerV1;
    reply?: (rpc: Rpc) => unknown;
    machine?: Partial<Machine>;
    waitFor?: string;
    workingSession?: boolean;
    askBeforeStop?: boolean;
    restoreAccount?: boolean;
    active?: boolean;
  }>,
) {
  const serverUrl = `https://process-widgets-${Math.random().toString(36).slice(2)}.test`;
  let serverId = await home.addHome({
    name: 'Widgets Home',
    serverUrl,
    accountId: 'owner',
    active: options.active,
  });
  // The person's own approval setting for Stop on this device (R41); nothing in the widget decides it.
  home.answer(serverId, '/v2/account/settings', {
    body: {
      content: {
        t: 'plain',
        v: {
          actionsSettingsV1: {
            v: 1,
            actions: {},
            approvalWaivedSurfaces: options.askBeforeStop ? {} : { 'machines.processes.stop': ['ui'] },
          },
        },
      },
      version: 1,
    },
  });
  if (options.restoreAccount) {
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'owner',
      credentials: { token: createAccountTokenForTests('owner', { currentAccount: true }) }, request: home.request });
    serverId = connection.serverId;
  }
  storage.setState({
    sessions: options.workingSession ? { refactor: createSessionFixture({ id: 'refactor', serverId,
      active: true, activeAt: Date.now(), thinking: true, thinkingAt: Date.now() }) } : {},
    machines: {},
    machineListByServerId: {},
    machineListStatusByServerId: {},
  });
  await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [machine(options.machine)]);
  const answer = options.answer ?? createProcessesAnswer();
  transport.rpc.mockImplementation(async (rpc: Rpc) => {
    const reply = options.reply?.(rpc);
    if (reply !== undefined) return reply;
    if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_LIST) return rpc.payload?.view === 'owners'
      ? { ...answer, owners: answer.owners.map(owner => ({ ...owner, members: [] })) }
      : answer;
    return new Promise(() => {});
  });
  const size: WidgetSizeV1 = options.size ?? 'medium';
  const Body = options.Body;
  const screen = await renderScreen(
    <AuthProvider
      initialCredentials={{
        token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`,
      }}
    >
      <ModalProvider>
        <WidgetPresentationProvider
          value={{
            size,
            footprint: FOOTPRINTS[options.size ?? 'medium'],
            geometry: { width: 354, height: 348 },
          }}
        >
          <Body
            input={{ machine: { serverId, machineId: 'machine' } }}
            serverId={serverId}
            testID="widget"
          />
        </WidgetPresentationProvider>
      </ModalProvider>
    </AuthProvider>,
  );
  if (options.waitFor) {
    const id = options.waitFor;
    await act(async () => {
      await vi.waitFor(() => expect(screen.findByTestId(id)).not.toBeNull());
    });
    await measureMountedCollections(screen, { width: 354 });
  }
  // Seed the real Account policy, not only an HTTP answer the focused Account may already have read.
  if (options.askBeforeStop) await act(async () => { await home.requireUiApproval(serverId, 'machines.processes.stop'); });
  return { screen, serverId };
}

beforeEach(async () => {
  await home.reset();
  machineProcessesStore.reset();
  transport.rpc.mockReset();
  retirePresentationNotice();
});
afterEach(async () => {
  standardCleanup();
  machineProcessesStore.reset();
  await connection?.dispose();
  connection = null;
  await home.reset();
});

describe('Using the most widget', () => {
  it('counts admitted native container memory in Services without offering raw Stop', async () => {
    const answer = createProcessesAnswer();
    const owner = answer.owners[0];
    owner.owner = { kind: 'container', serverId: 'home', machineId: 'machine', serviceId: 'production/web',
      containerId: 'a'.repeat(64), composeProject: 'production', composeService: 'web', environmentId: 'environment' };
    delete owner.root;
    answer.owners = [owner];
    answer.totals.happier = owner.totals;
    const { screen } = await mount({ Body: MachineTopConsumersWidget, size: 'wide', answer,
      waitFor: `machine-processes-share-o:${owner.rowId}` });
    const composition = screen.root.findAll(node => node.props.testID === 'widget.composition'
      && Array.isArray(node.props.segments))[0];
    expect(composition?.props.segments).toEqual([expect.objectContaining({ id: 'services', value: owner.totals.memoryBytes })]);
    expect(screen.findByTestId(`widget.stop-o:${owner.rowId}`)).toBeNull();
    expect(transport.rpc.mock.calls.some(([rpc]) => (rpc as Rpc).method === RPC_METHODS.MACHINES_PROCESSES_STOP)).toBe(false);
  });

  it('draws each owner row\'s share of the widget\'s own total as the hairline beneath it (lab rw C)', async () => {
    const { screen } = await mount({ Body: MachineTopConsumersWidget, answer: createProcessesAnswer(),
      waitFor: 'widget.stop-o:service:website', reply: () => undefined });
    for (const key of ['o:service:website', 'o:session:refactor'])
      expect(screen.findByTestId(`machine-processes-share-${key}`)).not.toBeNull();
  });

  it('draws each owner as one line: the name, its status and the memory, with no CPU line beneath (lab rw C)', async () => {
    const { screen } = await mount({ Body: MachineTopConsumersWidget, answer: createProcessesAnswer(),
      waitFor: 'widget.stop-o:service:website', reply: () => undefined });
    const row = screen.root.findAll((node) => node.props.testID === 'machine-processes-row-o:session:refactor')[0]!;
    const texts = row.findAll((node) => typeof node.props.children === 'string').map((node) => node.props.children as string);
    expect(screen.findByTestId('machine-processes-memory-o:session:refactor')).not.toBeNull();
    expect(texts.some((text) => /CPU/.test(text))).toBe(false);
  });

  it('stops and offers the way back from an owner-only Session without requesting its process tree', async () => {
    const answer = createProcessesAnswer();
    answer.owners = answer.owners.map(owner => ({ ...owner, members: [],
      ...(owner.owner.kind === 'session' ? { root: { ref: 'runner', level: 'proven' as const }, canStartAgain: true } : {}) }));
    const calls: Rpc[] = [];
    const { screen } = await mount({ Body: MachineTopConsumersWidget, answer,
      waitFor: 'widget.stop-o:session:refactor', reply: rpc => {
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_STOP) {
          calls.push(rpc);
          return { status: 'ended', outcomes: [{ ref: 'runner', outcome: 'ended', freedBytes: 90 * 1024 * 1024 }] };
        }
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_START_AGAIN) {
          calls.push(rpc);
          return { status: 'already_wakes_on_next_message' };
        }
        return undefined;
      } });
    await act(async () => { await screen.pressByTestIdAsync('widget.stop-o:session:refactor'); });
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(screen.findByTestId('widget.stopped')).not.toBeNull();
    });
    expect(calls[0]?.payload).toMatchObject({ targets: [{ ref: 'runner', expect: {
      level: 'proven', owner: { kind: 'session', sessionId: 'refactor' },
    } }] });
    const undo = readPresentationNotice()?.undo;
    expect(undo).toBeDefined();
    await act(async () => { undo!.run(); });
    await act(async () => { await vi.waitFor(() => expect(calls).toHaveLength(2)); });
    expect(calls[1]).toMatchObject({ method: RPC_METHODS.MACHINES_PROCESSES_START_AGAIN, payload: { ref: 'runner' } });
    expect(transport.rpc.mock.calls.filter(([rpc]) =>
      (rpc as Rpc).method === RPC_METHODS.MACHINES_PROCESSES_LIST && (rpc as Rpc).payload?.view === 'tree')).toHaveLength(0);
  });

  it('keeps a working session running until its native Ask-first Stop confirmation is accepted', async () => {
    const calls: Rpc[] = [];
    const { screen } = await mount({ Body: MachineTopConsumersWidget, workingSession: true, askBeforeStop: true, restoreAccount: true,
      waitFor: 'widget.stop-o:session:refactor', reply: rpc => {
        if (rpc.method !== RPC_METHODS.MACHINES_PROCESSES_STOP) return undefined;
        calls.push(rpc);
        return { status: 'ended', outcomes: [{ ref: 'runner', outcome: 'ended' }] };
      } });
    await act(async () => { await screen.pressByTestIdAsync('widget.stop-o:session:refactor'); });
    await vi.waitFor(() => expect(screen.findByTestId('widget.confirm')).not.toBeNull());
    expect(calls).toHaveLength(0);
    await act(async () => { await screen.pressByTestIdAsync('widget.confirm-cancel'); });
    await flushHookEffects();
    expect(screen.findByTestId('widget.confirm')).toBeNull();
    expect(calls).toHaveLength(0);
    expect(screen.findByTestId('widget.stop-o:session:refactor')).not.toBeNull();
    expect(screen.findByTestId('widget.stopped')).toBeNull();
    await act(async () => { await screen.pressByTestIdAsync('widget.stop-o:session:refactor'); });
    await vi.waitFor(() => expect(screen.findByTestId('widget.confirm')).not.toBeNull());
    expect(calls).toHaveLength(0);
    await act(async () => { await screen.pressByTestIdAsync('widget.confirm-stop'); });
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(calls).toHaveLength(1);
      expect(screen.findByTestId('widget.stopped')).not.toBeNull();
    });
    expect(calls[0]).toMatchObject({ method: RPC_METHODS.MACHINES_PROCESSES_STOP,
      payload: { targets: [{ ref: 'runner', expect: {
        level: 'proven', owner: { kind: 'session', sessionId: 'refactor' },
      } }] } });
    expect(screen.findByTestId('widget.confirm')).toBeNull();
  });

  it('lets Allowed stop a working session without an inline second approval', async () => {
    const calls: Rpc[] = [];
    const { screen } = await mount({ Body: MachineTopConsumersWidget, workingSession: true,
      waitFor: 'widget.stop-o:session:refactor', reply: rpc => {
        if (rpc.method !== RPC_METHODS.MACHINES_PROCESSES_STOP) return undefined;
        calls.push(rpc);
        return { status: 'ended', outcomes: [{ ref: 'runner', outcome: 'ended' }] };
      } });
    await act(async () => { await screen.pressByTestIdAsync('widget.stop-o:session:refactor'); });
    await act(async () => { await vi.waitFor(() => expect(calls).toHaveLength(1)); });
    expect(screen.findByTestId('widget.confirm')).toBeNull();
    expect(calls[0]?.payload).toMatchObject({ targets: [{ ref: 'runner', expect: { owner: { kind: 'session', sessionId: 'refactor' } } }] });
  });

  it('stops a service through machines.processes.stop and offers its way back on the row and in the notice', async () => {
    const calls: Rpc[] = [];
    const { screen } = await mount({
      Body: MachineTopConsumersWidget,
      answer: createProcessesAnswer({ owners: createProcessesAnswer().owners.map(owner =>
        owner.owner.kind === 'service' ? { ...owner, canStartAgain: true } : owner) }),
      waitFor: 'widget.stop-o:service:website',
      reply: (rpc) => {
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_STOP) {
          calls.push(rpc);
          return {
            status: 'ended',
            outcomes: [
              { ref: 'website', outcome: 'ended', freedBytes: 1.2 * GB },
            ],
          };
        }
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_START_AGAIN) {
          calls.push(rpc);
          return { status: 'started' };
        }
        return undefined;
      },
    });
    // Happier's own daemon is never a Stop target.
    expect(screen.findByTestId('widget.stop-o:happier')).toBeNull();
    await act(async () => {
      await screen.pressByTestIdAsync('widget.stop-o:service:website');
    });
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(screen.findByTestId('widget.stopped')).not.toBeNull();
    });
    expect(calls[0]).toMatchObject({
      method: RPC_METHODS.MACHINES_PROCESSES_STOP,
      payload: {
        targets: [
          {
            ref: 'website',
            expect: {
              level: 'proven',
              owner: { kind: 'service', serviceId: 'website' },
            },
          },
        ],
      },
    });
    expect(screen.getTextContent()).toContain('1.2 GB freed');
    const notice = readPresentationNotice();
    expect(notice?.undo?.label).toBe('Undo');

    await act(async () => {
      notice!.undo!.run();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          calls.some(
            (rpc) => rpc.method === RPC_METHODS.MACHINES_PROCESSES_START_AGAIN,
          ),
        ).toBe(true),
      );
    });
    expect(
      calls.find(
        (rpc) => rpc.method === RPC_METHODS.MACHINES_PROCESSES_START_AGAIN,
      )?.payload,
    ).toMatchObject({ ref: 'website' });
  });

  it('says so quietly when nothing of Happier’s is running, and reads nothing on an offline machine', async () => {
    const { screen } = await mount({
      Body: MachineTopConsumersWidget,
      answer: createProcessesAnswer({ owners: [] }),
      waitFor: 'widget.empty',
    });
    expect(screen.getTextContent()).toContain(
      'Nothing of Happier’s is running',
    );

    transport.rpc.mockClear();
    const offline = await mount({
      Body: MachineTopConsumersWidget,
      machine: { active: false, activeAt: 1_000 },
      active: false,
      waitFor: 'widget.offline',
    });
    expect(offline.screen.getTextContent()).toContain('Last seen');
    expect(
      transport.rpc.mock.calls.some(
        ([rpc]) => (rpc as Rpc).method === RPC_METHODS.MACHINES_PROCESSES_LIST,
      ),
    ).toBe(false);
  });
});

describe('Left behind widget', () => {
  it('counts the set the cleanup would act on, and Clean up opens Processes without stopping anything', async () => {
    const { screen, serverId } = await mount({
      Body: MachineLeftBehindWidget,
      size: 'small',
      waitFor: 'widget.cleanUp',
    });
    expect(screen.getTextContent()).toContain('3');
    expect(screen.getTextContent()).toContain('Holding 1.37 GB of memory');
    await act(async () => {
      await screen.pressByTestIdAsync('widget.cleanUp');
    });
    expect(routerMock.spies.push).toHaveBeenCalledWith(
      expect.stringContaining(
        `/machine?serverId=${encodeURIComponent(serverId)}&tab=processes`,
      ),
    );
    // It opens the Processes tab on what ended sessions left running (plan 30's `filter=leftBehind`).
    expect(routerMock.spies.push).toHaveBeenCalledWith(expect.stringContaining('filter=leftBehind'));
    expect(
      transport.rpc.mock.calls.some(([rpc]) =>
        (rpc as Rpc).method === RPC_METHODS.MACHINES_PROCESSES_STOP,
      ),
    ).toBe(false);
  });

  it('is one quiet line when nothing is left behind', async () => {
    const { screen } = await mount({
      Body: MachineLeftBehindWidget,
      answer: createProcessesAnswer({ leftBehind: [] }),
      waitFor: 'widget.empty',
    });
    expect(screen.getTextContent()).toContain('Nothing left behind');
  });
});
