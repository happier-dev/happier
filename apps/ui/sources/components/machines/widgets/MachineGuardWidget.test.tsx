import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import { MachineGuardPolicyV1Schema } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import type { MachineGuardViewV1 } from '@happier-dev/protocol/machines/guard/guardRpcV1';
import { MachineGuardActivityRowV1Schema, type MachineGuardActivityRowV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { createDeferred, flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { WidgetFrameBodyMetaContext } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineGuardViewFixture } from '@/sync/domains/machines/guard/guardViewFixtures';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// Only the Machine network is replaced; credential binding, the Actions front door, the guard store and the body run for real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({ machineRpcWithServerScope: transport.rpc }),
);
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { machineGuardStore } =
  await import('@/sync/domains/machines/guard/machineGuardStore');
const { storage } = await import('@/sync/domains/state/storageStore');
const { Modal } = await import('@/modal');
const { MachineGuardWidget, guardHeaderStateText } = await import('./MachineGuardWidget');
const { withdrawMachinePresenceForScope, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { useGuardFreshness, useGuardActivityFreshness } = await import('../guard/useGuardFreshness');
const { useMachineGuardActivity } = await import('@/sync/domains/machines/guard/useMachineGuardView');

const GiB = 1024 ** 3;

function HeaderMetaProbe(props: React.PropsWithChildren) {
  const [meta, setMeta] = React.useState<React.ReactNode>(null);
  return (
    <WidgetFrameBodyMetaContext.Provider value={setMeta}>
      {meta}
      {props.children}
    </WidgetFrameBodyMetaContext.Provider>
  );
}

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

async function mount(
  options: Readonly<{
    size?: WidgetSizeV1;
    view?: MachineGuardViewV1;
    activity?: MachineGuardActivityRowV1[];
    overrides?: Partial<Machine>;
    rpc?: (method: string, payload: Record<string, unknown>) => unknown;
    active?: boolean;
    keepRunningOff?: boolean;
  }> = {},
) {
  const serverId = await home.addHome({
    name: 'Guard Home',
    serverUrl: `https://guard-widget-${Math.random().toString(36).slice(2)}.test`,
    serverIdentityId: 'srv_guard_widget',
    accountId: 'owner',
    active: options.active,
  });
  home.answer(serverId, '/v2/account/settings', {
    body: { content: { t: 'plain', v: {} }, version: 1 },
  });
  if (options.keepRunningOff) await home.setActionPolicy(serverId, 'machines.guard.idleStop.keepRunning', 'ui', 'off');
  storage.setState({
    machines: {},
    machineListByServerId: {},
    machineListStatusByServerId: {},
  });
  await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [machine(options.overrides)]);
  transport.rpc.mockImplementation(
    async ({
      method,
      payload,
    }: {
      method: string;
      payload: Record<string, unknown>;
    }) => {
      const answer = options.rpc?.(method, payload);
      if (answer !== undefined) return answer;
      if (method === RPC_METHODS.DAEMON_GUARD_WATCH || method === RPC_METHODS.DAEMON_GUARD_ACTIVITY_WATCH)
        return new Promise(() => {});
      if (method === RPC_METHODS.MACHINES_GUARD_GET)
        return options.view ?? createMachineGuardViewFixture();
      if (method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST)
        return { entries: options.activity ?? [], counts: { stopped: options.activity?.length ?? 0, cleanedUp: 0, needsLook: 0, others: 0 }, asOf: Date.now() };
      throw new Error(`unexpected ${method}`);
    },
  );
  const screen = await renderScreen(
    <WidgetPresentationProvider
      value={{
        size: options.size ?? 'medium',
        footprint: {
          columns: 2,
          columnSpan: 1,
          rowSpan: 2,
          width: 'half',
          height: 'regular',
        },
      }}
    >
      <HeaderMetaProbe>
        <MachineGuardWidget
          input={{ machine: { serverId, machineId: 'machine' } }}
          serverId={serverId}
          testID="guard-widget"
        />
      </HeaderMetaProbe>
    </WidgetPresentationProvider>,
  );
  return { screen, serverId };
}

const before = storage.getState();
beforeEach(async () => {
  await home.reset();
  machineGuardStore.reset();
  transport.rpc.mockReset();
});
afterEach(async () => {
  standardCleanup();
  clearMachineRequestReachabilityForTest();
  machineGuardStore.reset();
  storage.setState(before);
  await home.reset();
});

describe('MachineGuardWidget', () => {
  it.each([false, true])('localizes an untitled Session in compact candidates and warnings (warning=%s)', async warning => {
    const view = createMachineGuardViewFixture({
      policy: MachineGuardPolicyV1Schema.parse({ memoryGuard: { enabled: true }, idleSessions: { enabled: true } }),
      idle: warning ? [{ sessionRef: 'untitled', title: null, agentId: 'codex', status: 'stops_at', stopAt: Date.now() + 60_000, idleMs: 60_000 }] : [],
    });
    view.ladder.steps[2] = { rung: 'idleSessions', enabled: true, status: 'next', freesAboutBytes: GiB,
      candidates: [{ ref: 'untitled', kind: 'session', label: null, qualifier: 'idle', footprintBytes: GiB }] };
    const { screen } = await mount({ size: 'small', view });
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(screen.getTextContent()).toContain(t('session.untitled'));
    });
  });
  it('does not call a withdrawn unknown Machine offline or claim its held Guard state is current', async () => {
    const { screen, serverId } = await mount();
    await vi.waitFor(() => expect(screen.findByTestId('guard-widget.state')).not.toBeNull());
    const freshness = await renderHook(() => {
      const scope = { serverId, machineId: 'machine' };
      const activity = useMachineGuardActivity({ ...scope, range: '7d', filter: 'all' });
      return { guard: useGuardFreshness(scope), activity: useGuardActivityFreshness(activity, scope) };
    });
    await vi.waitFor(() => expect(freshness.getCurrent()).toMatchObject({ guard: { kind: 'live' }, activity: { kind: 'live' } }));
    await act(async () => { withdrawMachinePresenceForScope({ serverId, accountId: 'owner' }); });
    expect(freshness.getCurrent()).toEqual({ guard: { kind: 'none' }, activity: { kind: 'none' } });
    expect(screen.findByTestId('guard-widget.offline')).toBeNull();
    expect(screen.findByTestId('guard-widget.state')).toBeNull();
    expect(screen.findByTestId('guard-widget.unavailable')).not.toBeNull();
  });
  it.each(['medium', 'wide', 'full', 'tall', 'large'] as const)('reads yesterday-only Last action and Recent from the default Activity history at %s size', async size => {
    const yesterday = MachineGuardActivityRowV1Schema.parse({ v: 1, id: 'yesterday', at: Date.now() - 86_400_000,
      kind: 'stopped_session', rule: 'idle_sessions', subject: { kind: 'session', sessionId: 'old-session', title: 'Yesterday build' },
      outcome: 'done', attribution: { kind: 'unknown' }, freedBytes: GiB });
    const { screen } = await mount({ size, activity: [yesterday], view: createMachineGuardViewFixture({
      policy: MachineGuardPolicyV1Schema.parse({ memoryGuard: { enabled: true } }), recentActivity: [],
    }) });
    await vi.waitFor(async () => {
      // Finish each commit so GuardOn can mount and demand its Activity history.
      await flushHookEffects();
      expect(screen.getTextContent()).toContain(size === 'wide' ? 'It last acted' : 'Yesterday build');
    });
    expect(transport.rpc.mock.calls.some(([call]) => call.method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST
      && call.payload.range === '7d' && call.payload.filter === 'all')).toBe(true);
  });

  it('keeps Last action absent when Activity has no receipt, even if the operational view has one', async () => {
    const view = createMachineGuardViewFixture({ policy: MachineGuardPolicyV1Schema.parse({ memoryGuard: { enabled: true } }),
      recentActivity: [MachineGuardActivityRowV1Schema.parse({ v: 1, id: 'operational-only', at: Date.now(), kind: 'closed_browser',
        rule: 'memory_guard', outcome: 'done', attribution: { kind: 'unknown' } })],
    });
    const { screen } = await mount({ view });
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(transport.rpc.mock.calls.some(([call]) => call.method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST)).toBe(true);
    });
    expect(screen.getTextContent()).not.toContain('Last action');
  });

  it('does not project synced default Off before the Guard read proves a state', async () => {
    const answer = createDeferred<unknown>();
    const { screen } = await mount({
      rpc: method => method === RPC_METHODS.MACHINES_GUARD_GET ? answer.promise : undefined,
    });
    await act(async () => {
      await vi.waitFor(() => expect(transport.rpc.mock.calls.some(([call]) =>
        (call as { method: string }).method === RPC_METHODS.MACHINES_GUARD_GET,
      )).toBe(true));
    });
    expect(screen.findByTestId('guard-widget.state')).toBeNull();

    await act(async () => { answer.resolve({}); });
    await act(async () => {
      await vi.waitFor(() => expect(screen.findByTestId('guard-widget.error')).not.toBeNull());
    });
    expect(screen.findByTestId('guard-widget.state')).toBeNull();
  });

  it('retains actually read Off when the parked Guard read later fails', async () => {
    const { screen, serverId } = await mount({
      rpc: method => {
        if (method === RPC_METHODS.DAEMON_GUARD_WATCH) throw new Error('machine_unreachable');
        return undefined;
      },
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(machineGuardStore.getView({
          serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId,
          expectedAccountId: 'owner',
          machineId: 'machine',
        })).toMatchObject({ status: 'error', pending: false, view: { policyRevision: 1 } });
        expect(screen.findByTestId('guard-widget.off.empty')).not.toBeNull();
      });
    });
    expect(screen.findByTestId('guard-widget.state')).not.toBeNull();
    expect(screen.findByTestId('guard-widget.state')?.props.children).toBe('Off');
  });

  it.each(['allowed', 'off'] as const)('warns before an idle stop and honors Keep running policy %s', async policy => {
    const kept: unknown[] = [];
    const view = createMachineGuardViewFixture({
      policy: MachineGuardPolicyV1Schema.parse({
        idleSessions: { enabled: true },
      }),
      idle: [
        {
          sessionRef: 's-1',
          title: 'Docs link sweep',
          agentId: 'claude',
          status: 'stops_at',
          stopAt: Date.now() + 272_000,
          idleMs: 2 * 3_600_000,
        },
      ],
    });
    const { screen } = await mount({
      view,
      keepRunningOff: policy === 'off',
      rpc: (method, payload) => {
        if (method !== RPC_METHODS.MACHINES_GUARD_IDLE_STOP_KEEP_RUNNING)
          return undefined;
        kept.push(payload);
        return { status: 'kept' };
      },
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.findByTestId('guard-widget.warning')).not.toBeNull(),
      );
    });
    expect(screen.getTextContent()).toContain('Stopping Docs link sweep');
    expect(screen.getTextContent()).toMatch(/in 4:3\d/);
    expect(screen.getTextContent()).toContain('It wakes on your next message.');
    vi.mocked(Modal.alert).mockClear();
    await act(async () => {
      screen.pressByTestId('guard-widget.keepRunning');
    });
    if (policy === 'off') {
      await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith(
        t('machines.widgets.body.guard.keepRunning'), t('actionConfirmations.turnedOffUnnamedMessage'),
      ));
      expect(kept).toHaveLength(0);
      expect(screen.findByTestId('guard-widget.warning')).not.toBeNull();
      return;
    }
    await act(async () => {
      await vi.waitFor(() => expect(kept).toHaveLength(1));
    });
    expect(kept[0]).toMatchObject({ machineId: 'machine', sessionId: 's-1' });
  });

  it('lists what Guard would stop first, numbered, with the real candidates', async () => {
    const view = createMachineGuardViewFixture({
      policy: MachineGuardPolicyV1Schema.parse({
        memoryGuard: { enabled: true },
      }),
      ladder: {
        steps: [
          {
            rung: 'browsers',
            enabled: true,
            status: 'next',
            freesAboutBytes: 2.3 * GiB,
            candidates: [
              {
                ref: 'browser-1',
                kind: 'browser',
                label: 'Browser sidecar',
                qualifier: 'Idle 41 min',
                footprintBytes: 2.3 * GiB,
              },
            ],
          },
          {
            rung: 'devServers',
            enabled: true,
            status: 'skip',
            freesAboutBytes: 1.2 * GiB,
            candidates: [
              {
                ref: 'svc-1',
                kind: 'service',
                label: 'website · dev server',
                qualifier: 'Idle 12 min',
                footprintBytes: 1.2 * GiB,
              },
            ],
          },
          {
            rung: 'idleSessions',
            enabled: false,
            status: 'off',
            freesAboutBytes: 0,
            candidates: [
              {
                ref: 's-9',
                kind: 'session',
                label: 'Working session', qualifier: 'Working',
                footprintBytes: 4 * GiB,
              },
            ],
          },
        ],
        excluded: [],
        summary: {
          candidatesBytes: 3.5 * GiB,
          inUseBytes: 57 * GiB,
          workingBytes: 9 * GiB,
          workingSessions: 1,
          notHappiersBytes: 47 * GiB,
          leftAloneSessions: 0,
        },
      },
    });
    const { screen } = await mount({ size: 'small', view });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('guard-widget.candidate.browser-1'),
        ).not.toBeNull(),
      );
    });
    const text = screen.getTextContent();
    expect(text).toContain('Would stop first');
    expect(text).toContain('Browser sidecar');
    expect(text).toContain('website · dev server');
    // A switched-off rung's candidates are never shown as something Guard would stop.
    expect(screen.findByTestId('guard-widget.candidate.s-9')).toBeNull();
  });

  it('invites turning Guard on when every rule is off, and says an offline machine plainly', async () => {
    const { screen } = await mount();
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.findByTestId('guard-widget.off.empty')).not.toBeNull(),
      );
    });
    // The frame already names the machine; the body does not repeat it in a half-width column.
    expect(screen.getTextContent()).toContain('Guard is off');
    expect(screen.getTextContent()).not.toContain('Guard is off on');
    expect(screen.getTextContent()).toContain('Turn on Guard');

    standardCleanup();
    machineGuardStore.reset();
    transport.rpc.mockClear();
    const offline = await mount({
      overrides: { active: false, activeAt: Date.now() - 2 * 86_400_000 },
      active: false,
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          offline.screen.findByTestId('guard-widget.offline'),
        ).not.toBeNull(),
      );
    });
    expect(offline.screen.getTextContent()).toContain('Last seen');
    expect(offline.screen.getTextContent()).toContain(
      'Guard keeps running on the machine',
    );
    expect(
      transport.rpc.mock.calls.some(
        ([call]) =>
          (call as { method: string }).method ===
          RPC_METHODS.MACHINES_GUARD_GET,
      ),
    ).toBe(false);
  });

  it('names no Guard state in the header when the read failed: Off from the settings read would contradict the body', () => {
    expect(guardHeaderStateText({ offline: false, on: null })).toBeNull();
    expect(guardHeaderStateText({ offline: false, on: false })).toBe('Off');
    expect(guardHeaderStateText({ offline: true, on: null })).toBe('Offline');
  });
});
