import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import type { MachineGuardActivityRowV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';

import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { WidgetFrameBodyMetaContext } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineActivityForTest, publishMachineInventoryForTest as publishTruthMachineInventory } from '@/dev/testkit/harness/machinePresence';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { Machine } from '@/sync/domains/state/storageTypes';

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// Only the Machine network is replaced; credential binding, the Actions front door, the guard store and the rows run for real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({ machineRpcWithServerScope: transport.rpc }),
);
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { machineGuardStore } =
  await import('@/sync/domains/machines/guard/machineGuardStore');
const { storage } = await import('@/sync/domains/state/storageStore');
const { MachineActivityWidget } = await import('./MachineActivityWidget');
const { Modal } = await import('@/modal');
const { t } = await import('@/text');

function machine(id: string, host: string): Machine {
  return createMachineFixture({
    id,
    active: true,
    activeAt: Date.now(),
    storageMode: 'plain',
    isShared: false,
    metadata: {
      host,
      platform: 'linux',
      happyCliVersion: '0.3.0',
      happyHomeDir: '/home/leeroy/.happier',
      homeDir: '/home/leeroy',
    },
    access: {
      role: 'manage',
      custodian: { accountId: 'owner', displayName: 'Owner' },
      resourceMode: 'plain',
      accessState: 'ready',
    },
  });
}

function entry(
  overrides: Partial<MachineGuardActivityRowV1>,
): MachineGuardActivityRowV1 {
  return {
    v: 1,
    id: 'e1',
    at: Date.now() - 60_000,
    kind: 'stopped_session',
    rule: 'idle_sessions',
    subject: { kind: 'session', sessionId: 's-1', title: 'Docs link sweep' },
    freedBytes: 700 * 1024 ** 2,
    outcome: 'done',
    wayBack: [
      {
        label: 'resume',
        actionId: 'session.open',
        input: { sessionId: 's-1' },
      },
    ],
    attribution: { kind: 'unknown' },
    ...overrides,
  } as MachineGuardActivityRowV1;
}
const list = (entries: MachineGuardActivityRowV1[]) => ({
  entries,
  counts: { stopped: entries.length, cleanedUp: 0, needsLook: 0, others: 0 },
  asOf: Date.now(),
});

function MetaHost(props: Readonly<{ children: React.ReactNode }>) {
  const [meta, setMeta] = React.useState<React.ReactNode>(null);
  return <WidgetFrameBodyMetaContext.Provider value={setMeta}>{meta}{props.children}</WidgetFrameBodyMetaContext.Provider>;
}

async function mount(
  options: Readonly<{
    size?: WidgetSizeV1;
    bound: boolean;
    machines: Machine[];
    rpc: (method: string, payload: Record<string, unknown>) => unknown;
    undoOff?: boolean;
  }>,
) {
  const serverId = await home.addHome({
    name: 'Activity Home',
    serverUrl: `https://activity-widget-${Math.random().toString(36).slice(2)}.test`,
    serverIdentityId: 'srv_activity_widget',
    accountId: 'owner',
  });
  home.answer(serverId, '/v2/account/settings', {
    body: { content: { t: 'plain', v: {} }, version: 1 },
  });
  if (options.undoOff) await home.setActionPolicy(serverId, 'machines.guard.activity.undo', 'ui', 'off');
  storage.setState({
    machines: {},
    machineListByServerId: {},
    machineListStatusByServerId: {},
  });
  await publishTruthMachineInventory({ serverId, accountId: 'owner' }, options.machines);
  transport.rpc.mockImplementation(
    async ({
      method,
      payload,
    }: {
      method: string;
      payload: Record<string, unknown>;
    }) => {
      const answer = options.rpc(method, payload);
      if (answer !== undefined) return answer;
      throw new Error(`unexpected ${method}`);
    },
  );
  const input: Readonly<Record<string, JsonValue>> = options.bound
    ? { machine: { serverId, machineId: options.machines[0]!.id } }
    : {};
  const screen = await renderScreen(
    <MetaHost>
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
      <MachineActivityWidget
        input={input}
        serverId={serverId}
        testID="activity-widget"
      />
    </WidgetPresentationProvider>
    </MetaHost>,
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
  machineGuardStore.reset();
  storage.setState(before);
  await home.reset();
});

describe('MachineActivityWidget', () => {
  it.each([true, false])('dates retained receipts after a failed refresh (bound: %s)', async (bound) => {
    const watch = createDeferred<never>();
    const current = machine('m1', 'leeroy-mbp');
    const { screen, serverId } = await mount({
      bound, machines: [current],
      rpc: method => {
        if (method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST) {
          return list([entry({})]);
        }
        return watch.promise;
      },
    });
    await act(async () => {
      publishMachineActivityForTest([current]);
      await publishTruthMachineInventory({ serverId, accountId: 'owner' }, [current]);
    });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-activity-e1')).not.toBeNull()); });
    expect(screen.findByTestId('activity-widget.asOf')).toBeNull();
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(transport.rpc.mock.calls.some(([call]) => call.method === RPC_METHODS.DAEMON_GUARD_ACTIVITY_WATCH)).toBe(true);
    });
    await act(async () => {
      watch.reject(new Error('watch failed'));
    });
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(screen.findByTestId('machine-activity-e1')).not.toBeNull();
      expect(screen.findByTestId('activity-widget.asOf')).not.toBeNull();
    });
  });

  it.each(['manage', 'use'] as const)('offers all-off Set up only for shared Manage (%s)', async (role) => {
    const shared = machine('m1', 'leeroy-mbp');
    const { screen } = await mount({
      bound: true,
      machines: [{ ...shared, isShared: true, access: { ...shared.access!, role },
        metadata: { ...shared.metadata!, resourcesPolicyV1: MachineResourcesPolicyV1Schema.parse({ v: 1 }) } }],
      rpc: (method) => method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST ? list([]) : undefined,
    });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('activity-widget.notSetUp.empty')).not.toBeNull()); });
    expect(screen.findByTestId('activity-widget.notSetUp.empty.action') !== null).toBe(role === 'manage');
  });

  it('keeps shared Use activity visible without Undo controls', async () => {
    const shared = machine('m1', 'leeroy-mbp');
    const { screen } = await mount({
      bound: true,
      machines: [{ ...shared, isShared: true, access: { ...shared.access!, role: 'use' } }],
      rpc: (method) => method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST ? list([entry({})]) : undefined,
    });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-activity-e1')).not.toBeNull()); });
    expect(screen.findByTestId('machine-activity-e1-resume')).toBeNull();
  });

  it('explains a refused Resume and keeps the original Activity receipt', async () => {
    const { screen } = await mount({
      bound: true,
      machines: [machine('m1', 'leeroy-mbp')],
      undoOff: true,
      rpc: method => method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST ? list([entry({})]) : undefined,
    });
    vi.mocked(Modal.alert).mockClear();
    try {
      await vi.waitFor(() => expect(screen.findByTestId('machine-activity-e1-resume')).not.toBeNull());
      await screen.pressByTestIdAsync('machine-activity-e1-resume');
      await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledWith(
        t('machineGuard.activity.title'), t('actionConfirmations.turnedOffUnnamedMessage'),
      ));
      expect(transport.rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_UNDO)).toBe(false);
      expect(screen.findByTestId('machine-activity-e1-resume')).not.toBeNull();
    } finally { await screen.unmount(); }
  });

  it.each([false, true])('resumes a stopped session for a manager (shared: %s) and then shows what happened', async (isShared) => {
    const undone: unknown[] = [];
    let entries = [entry({})];
    const { screen } = await mount({
      bound: true,
      machines: [{ ...machine('m1', 'leeroy-mbp'), isShared }],
      rpc: (method, payload) => {
        if (method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST)
          return list(entries);
        if (method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_UNDO) {
          undone.push(payload.entryId);
          entries = [
            entry({
              id: 'e2',
              at: Date.now(),
              kind: 'undone',
              ref: 'e1',
              wayBack: undefined,
              freedBytes: undefined,
            }),
            entry({ undoneAt: Date.now() }),
          ];
          return { ok: true };
        }
        return undefined;
      },
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('machine-activity-e1-resume'),
        ).not.toBeNull(),
      );
    });
    expect(screen.getTextContent()).toContain('Stopped “Docs link sweep”');
    expect(screen.getTextContent()).toContain(
      '1 automatic action this week · 1 can be undone',
    );
    await act(async () => {
      screen.pressByTestId('machine-activity-e1-resume');
    });
    await act(async () => {
      await vi.waitFor(() => expect(undone).toEqual(['e1']));
    });
    // The next answer says what happened; the undone receipt has no way back left.
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.getTextContent()).toContain('Undid an earlier stop'),
      );
    });
    expect(screen.findByTestId('machine-activity-e1-resume')).toBeNull();
  });

  it('lists answered receipts newest first and qualifies missing fleet answers', async () => {
    const current = [machine('m1', 'leeroy-mbp'), machine('m2', 'edge-1'), { ...machine('m3', 'studio'), active: false, activeAt: Date.now() - 86_400_000 }];
    const { screen, serverId } = await mount({
      bound: false,
      machines: current,
      rpc: (method, payload) => {
        if (method !== RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST)
          return undefined;
        return payload.machineId === 'm1'
          ? list([entry({ id: 'a', at: Date.now() - 120_000 })])
          : list([
              entry({
                id: 'b',
                at: Date.now() - 30_000,
                kind: 'stopped_service',
                rule: 'memory_guard',
                subject: { kind: 'service', label: 'website · dev server' },
                wayBack: undefined,
              }),
            ]);
      },
    });
    await act(async () => {
      publishMachineActivityForTest(current);
      await publishTruthMachineInventory({ serverId, accountId: 'owner' }, current);
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.findByTestId('machine-activity-a')).not.toBeNull(),
      );
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.findByTestId('machine-activity-b')).not.toBeNull(),
      );
    });
    const text = screen.getTextContent();
    expect(text).toContain('leeroy-mbp');
    expect(text).toContain('edge-1');
    expect(text.indexOf('website · dev server')).toBeLessThan(
      text.indexOf('Docs link sweep'),
    );
    // Each machine is its own daemon read; an offline machine is not asked.
    const asked = transport.rpc.mock.calls.map(([call]) => (call as { method: string; payload?: { machineId?: string } }))
      .filter((call) => call.method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST).map((call) => call.payload?.machineId);
    expect(new Set(asked)).toEqual(new Set(['m1', 'm2']));
    expect(screen.findByTestId('activity-widget.coverage')).not.toBeNull();
    // It says how many machines its week comes from, never a second count of the fleet: the Machines header owns that (TH MB-2).
    const coverage = String(screen.findByTestId('activity-widget.coverage')!.props.children);
    expect(coverage).toMatch(/2/);
    expect(coverage).not.toMatch(/3/);
    await act(async () => {
      const answered = [machine('m1', 'leeroy-mbp'), machine('m2', 'edge-1'), machine('m3', 'studio')];
      publishMachineActivityForTest(answered);
      await publishTruthMachineInventory({ serverId, accountId: 'owner' }, answered);
    });
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(screen.findByTestId('activity-widget.coverage')).toBeNull();
    });
  });

  it('says nothing happened this week as one quiet line, never an empty list', async () => {
    const { screen } = await mount({
      bound: true,
      machines: [machine('m1', 'leeroy-mbp')],
      rpc: (method) =>
        method === RPC_METHODS.MACHINES_GUARD_ACTIVITY_LIST
          ? list([])
          : undefined,
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('activity-widget.notSetUp.empty') ??
            screen.findByTestId('activity-widget.nothing.empty'),
        ).not.toBeNull(),
      );
    });
    // Every rule of this machine is off by default (R29), so it says how to get automatic actions.
    expect(screen.getTextContent()).toContain('No automatic actions yet');
  });
});
