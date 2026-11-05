import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import type {
  HappierStorageSummaryV1,
  StorageItemV1,
} from '@happier-dev/protocol/storage/storageV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  getWidgetSizeFootprintV1,
  type WidgetSizeV1,
} from '@happier-dev/protocol/widgets';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { Machine } from '@/sync/domains/state/storageTypes';

installDisconnectedServerSocketBoundary();
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', () => ({ useRouter: () => ({ push: routerPush }) }));
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock().module;
});
// Only the Machine network is replaced; credential binding, the storage store, its pile and the bodies run for real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({ machineRpcWithServerScope: transport.rpc }),
);
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { primeServerFeaturesSnapshot } = await import("@/sync/api/capabilities/serverFeaturesClient");
const { machineStorageStore } =
  await import('@/sync/domains/machines/storage/machineStorageStore');
const { storage } = await import('@/sync/domains/state/storageStore');
const { MachineStorageWidget } = await import('./MachineStorageWidget');
const { MachineWorktreesWidget } = await import('./MachineWorktreesWidget');
const { t } = await import('@/text');

const GB = 1_000_000_000;
const size = (bytes: number) => ({
  allocatedBytes: bytes,
  freesBytes: bytes,
  sharedBytes: 0,
  sharedExtentsUnmeasured: false,
  atLeast: false,
});
const suggestion = (
  itemId: string,
  title: string,
  verdict: StorageItemV1['verdict'],
): StorageItemV1 => ({
  itemId,
  kind: 'suggestion',
  categoryId: 'caches',
  title,
  evidence: ['managed_cache_root'],
  path: `/Users/leeroy/Library/Caches/${itemId}`,
  size: size(5 * GB),
  verdict,
  reason: { code: 'downloads_again' },
  collectable: verdict !== 'forbidden',
});
const SUMMARY: HappierStorageSummaryV1 = {
  revision: 1,
  sizedAt: Date.UTC(2026, 9, 10, 10, 41),
  volumes: [
    {
      volume: { volumeId: 'mac', mountPath: '/', label: 'Macintosh HD' },
      totalBytes: 994 * GB,
      freeBytes: 412 * GB,
      happierBytes: 96 * GB,
      pileBytes: 0,
      trashBytes: 0,
      canGoBytes: 21 * GB,
    },
  ],
  categories: [
    {
      categoryId: 'worktrees',
      size: size(58.4 * GB),
      canGoBytes: 23.8 * GB,
      count: 192,
      detailFacts: { canGoCount: 61, keepCount: 131, factsReported: true },
    },
    {
      categoryId: 'caches',
      size: size(17.6 * GB),
      canGoBytes: 15.7 * GB,
      count: 3,
      detailFacts: { canGoCount: 3, keepCount: 0, factsReported: true },
    },
  ],
  suggestionsTop: [
    suggestion('pw', 'Playwright browsers', 'safe'),
    suggestion('voice', 'Voice model pack', 'caution'),
  ],
  pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] },
  trash: { count: 0, allocatedBytes: 0 },
  wholeDisk: { enabled: false, scans: [] },
};
const worktree = (
  itemId: string,
  title: string,
  verdict: StorageItemV1['verdict'],
  code: StorageItemV1['reason']['code'],
): StorageItemV1 => ({
  itemId,
  kind: 'worktree',
  categoryId: 'worktrees',
  title,
  evidence: ['scm_registered_worktree'],
  path: `/Users/leeroy/dev/happier/.dev/worktree/${title}`,
  size: size(6 * GB),
  verdict,
  reason: { code },
  collectable: verdict !== 'check',
});
const WORKTREES = [
  worktree('wt-a', 'glass-v2', 'safe', 'merged_clean'),
  worktree('wt-b', 'relay-retry', 'safe', 'branch_gone'),
  worktree('wt-keep', 'materialized', 'keep', 'changed_files'),
  worktree('wt-check', 'terminal-fonts', 'check', 'facts_unavailable'),
];

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
        host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 },
        attention: { level: 'calm', reasons: [] },
      },
    },
    ...overrides,
  });
}

type Rpc = Readonly<{ method: string; payload?: Record<string, unknown> }>;
async function mount(
  body: 'storage' | 'worktrees',
  widgetSize: WidgetSizeV1,
  input: Record<string, unknown> = {},
  overrides: Partial<Machine> = {},
  summary: HappierStorageSummaryV1 = SUMMARY,
) {
  const serverId = await home.addHome({
    name: 'Widget Home',
    serverUrl: `https://storage-widget-${Math.random().toString(36).slice(2)}.test`,
    serverIdentityId: 'srv_storage_widget',
    accountId: 'owner',
  });
  primeServerFeaturesSnapshot({
    serverId,
    snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse() },
  });
  home.answer(serverId, '/v2/account/settings', {
    body: { content: { t: 'plain', v: {} }, version: 1 },
  });
  storage.setState({
    machines: {},
    machineListByServerId: { [serverId]: [machine(overrides)] },
    machineListStatusByServerId: { [serverId]: 'idle' },
  });
  let pile: Array<Record<string, unknown>> = [];
  const pileResult = () => ({
    revision: 2,
    items: pile,
    summary: { count: pile.length, freesBytes: 0, droppedSinceLastView: [] },
  });
  const calls: Rpc[] = [];
  transport.rpc.mockImplementation(async (rpc: Rpc) => {
    calls.push(rpc);
    const input = rpc.payload ?? {};
    switch (rpc.method) {
      case RPC_METHODS.DAEMON_STORAGE_WATCH:
        return new Promise(() => {});
      case RPC_METHODS.DAEMON_STORAGE_WORKTREES_LIST:
        return { revision: 1, items: WORKTREES };
      case RPC_METHODS.DAEMON_STORAGE_PILE_GET:
        return pileResult();
      case RPC_METHODS.DAEMON_STORAGE_PILE_SET: {
        const remove = (input.remove as string[] | undefined) ?? [];
        pile = [
          ...pile.filter((entry) => !remove.includes(entry.itemId as string)),
          ...((input.add as Array<Record<string, unknown>> | undefined) ?? []),
        ];
        return pileResult();
      }
      default:
        return summary;
    }
  });
  const Body =
    body === 'storage' ? MachineStorageWidget : MachineWorktreesWidget;
  const screen = await renderScreen(
    <WidgetPresentationProvider
      value={{
        size: widgetSize,
        footprint: getWidgetSizeFootprintV1('home', widgetSize)!,
      }}
    >
      <Body
        input={
          { machine: { serverId, machineId: 'machine' }, ...input } as never
        }
        serverId={serverId}
        testID="widget"
      />
    </WidgetPresentationProvider>,
  );
  return {
    screen,
    serverId,
    pileSets: () =>
      calls.filter(
        (call) => call.method === RPC_METHODS.DAEMON_STORAGE_PILE_SET,
      ),
  };
}

const before = storage.getState();
beforeEach(async () => {
  await home.reset();
  machineStorageStore.reset();
  transport.rpc.mockReset();
  routerPush.mockReset();
});
afterEach(async () => {
  standardCleanup();
  machineStorageStore.reset();
  storage.setState(before);
  await home.reset();
});

describe('Machine storage widgets', () => {
  it('Worktrees: Review collects only the ones that can go into the pile, then opens the Worktrees page', async () => {
    const { screen, pileSets } = await mount('worktrees', 'medium');
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.findByTestId('widget.review')).not.toBeNull(),
      );
    });
    const text = screen.getTextContent();
    expect(text).toContain('can be deleted');
    expect(text).toContain('glass-v2');
    expect(text).not.toContain('materialized');
    expect(text).not.toContain('scm_registered_worktree');
    expect(text).toContain(t('machineStorage.evidence.scm_registered_worktree'));
    await act(async () => {
      screen.pressByTestId('widget.review');
    });
    await act(async () => {
      await vi.waitFor(() => expect(pileSets()).toHaveLength(1));
    });
    const added = (
      pileSets()[0]!.payload!.add as Array<{ itemId: string }>
    ).map((entry) => entry.itemId);
    expect(added.sort()).toEqual(['wt-a', 'wt-b']);
    const href = String(routerPush.mock.calls.at(-1)?.[0]);
    expect(href).toContain('/machine');
    expect(href).toContain('page=worktrees');
  });

  it('Storage: Review collects the verified Safe suggestions (never a Caution one) and opens Storage on that volume', async () => {
    const { screen, pileSets } = await mount('storage', 'medium');
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.findByTestId('widget.review')).not.toBeNull(),
      );
    });
    expect(screen.getTextContent()).toContain('412');
    await act(async () => {
      screen.pressByTestId('widget.review');
    });
    await act(async () => {
      await vi.waitFor(() => expect(pileSets()).toHaveLength(1));
    });
    expect(
      (pileSets()[0]!.payload!.add as Array<{ itemId: string }>).map(
        (entry) => entry.itemId,
      ),
    ).toEqual(['pw']);
    expect(String(routerPush.mock.calls.at(-1)?.[0])).toContain('volumeId=mac');
  });

  it('Storage: each volume says its own verified "can go" — a secondary volume too; missing is unknown, zero is measured zero (40c)', async () => {
    const volume = (volumeId: string, label: string, canGoBytes?: number) => ({
      volume: { volumeId, mountPath: `/Volumes/${label}`, label },
      totalBytes: 2000 * GB, freeBytes: 1200 * GB, happierBytes: 40 * GB, pileBytes: 0, trashBytes: 0,
      ...(canGoBytes === undefined ? {} : { canGoBytes }),
    });
    const multi: HappierStorageSummaryV1 = {
      ...SUMMARY,
      volumes: [...SUMMARY.volumes, volume('work', 'Work', 7.5 * GB), volume('scratch', 'Scratch'), volume('empty', 'Empty', 0)],
    };
    const work = await mount('storage', 'medium', { volume: 'work' }, {}, multi);
    await act(async () => {
      await vi.waitFor(() => expect(work.screen.findByTestId('widget.review')).not.toBeNull());
    });
    // The secondary volume's own figure, never the machine-wide category sum (39.5 GB).
    expect(work.screen.getTextContent()).toContain('7.5 GB');
    expect(work.screen.getTextContent()).not.toContain('39.5');
    await act(async () => { work.screen.pressByTestId('widget.review'); });
    expect(String(routerPush.mock.calls.at(-1)?.[0])).toContain('volumeId=work');
    standardCleanup();

    const unknown = await mount('storage', 'medium', { volume: 'scratch' }, {}, multi);
    await act(async () => {
      await vi.waitFor(() => expect(unknown.screen.findByTestId('widget.legend.measuring')).not.toBeNull());
    });
    expect(unknown.screen.findByTestId('widget.review')).toBeNull();
    standardCleanup();

    const zero = await mount('storage', 'medium', { volume: 'empty' }, {}, multi);
    await act(async () => {
      await vi.waitFor(() => expect(zero.screen.findByTestId('widget.legend')).not.toBeNull());
    });
    expect(zero.screen.findByTestId('widget.legend.measuring')).toBeNull();
    expect(zero.screen.findByTestId('widget.review')).toBeNull();
  });

  it('Storage: a Manage grantee can review cleanup', async () => {
    const manager = await mount('storage', 'medium', {}, { isShared: true });
    await act(async () => { await vi.waitFor(() => expect(manager.screen.findByTestId('widget.review')).not.toBeNull()); });
    expect(manager.screen.findByTestId('widget.recipient')).toBeNull();
  });

  it('Storage: a Use recipient sees the disk but gets no Review, and a chosen volume that is gone is a dash, never zero', async () => {
    const recipient = await mount('storage', 'medium', {}, { isShared: true, access: {
      role: 'use', custodian: { accountId: 'owner', displayName: 'Owner' }, resourceMode: 'plain', accessState: 'ready',
    } });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          recipient.screen.findByTestId('widget.recipient'),
        ).not.toBeNull(),
      );
    });
    expect(recipient.screen.findByTestId('widget.review')).toBeNull();
    standardCleanup();
    const gone = await mount('storage', 'small', { volume: 'backup' });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          gone.screen.findByTestId('widget.volume.unavailable'),
        ).not.toBeNull(),
      );
    });
    expect(gone.screen.getTextContent()).not.toContain('0 GB');
  });
});
