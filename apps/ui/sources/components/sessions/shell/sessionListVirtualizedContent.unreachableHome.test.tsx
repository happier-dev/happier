import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
  publishAppliedActiveServerRuntimeAvailability,
  publishAppliedActiveServerSnapshot,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import type { ScheduledWorkflowRowsRead } from '@/components/workflows/triggers/ScheduledWorkflowSection';

import {
  SESSION_LIST_SUPPORTING_SECTIONS_NODE,
  type SessionListVirtualizedNode,
} from './sessionListVirtualizedNodes';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const probe = vi.hoisted(() => ({ legendMounts: 0 }));

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
// Genuine third-party render boundary; no row here renders Markdown.
vi.mock(
  'react-native-enriched-markdown/lib/module/web/streamingReveal.js',
  () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
  }),
);
// Genuine virtualizer boundary: it only records that the list was presented.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
  const ReactModule = await import('react');
  const Mount = () => {
    ReactModule.useEffect(() => {
      probe.legendMounts += 1;
    }, []);
    return null;
  };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    LegendList: ReactModule.forwardRef<unknown, unknown>(() =>
      ReactModule.createElement(Mount),
    ),
  };
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const initialStorageState = storage.getState();
const { SessionListVirtualizedContent } =
  await import('./sessionListVirtualizedContent');

const NODES: readonly SessionListVirtualizedNode[] = [
  { id: 'header:project', kind: 'header', headerKind: 'project' },
  { id: 'session:a', kind: 'session', isGroupTail: true },
  SESSION_LIST_SUPPORTING_SECTIONS_NODE,
];

function build(serverId: string) {
  const scheduledRead: ScheduledWorkflowRowsRead = {
    available: true,
    rows: [],
    status: 'loading',
    retry: () => {},
    serverId,
  };
  return React.createElement(SessionListVirtualizedContent as never, {
    nodes: NODES,
    rowHeight: 44,
    safeAreaBottom: 0,
    showDrafts: false,
    showReminders: false,
    renderItem: () => null,
    rowExtraData: null,
    onStopScrollEventPropagationOnWeb: () => {},
    scheduledRead,
  });
}

describe('SessionListVirtualizedContent while its Home is unreachable', () => {
  let homeId = '';
  beforeEach(async () => {
    await homes.reset();
    homeId = await homes.addHome({
      name: 'Studio',
      serverUrl: 'https://studio.example.test',
      accountId: 'list-account',
    });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    publishAppliedActiveServerRuntimeAvailability(true);
    storage.setState({
      machineListStatusByServerId: { [homeId]: 'idle' },
      endpointStatus: 'offline',
      socketStatus: 'disconnected',
      endpointReason: null,
      syncError: null,
    });
  });
  afterEach(async () => {
    standardCleanup();
    probe.legendMounts = 0;
    await homes.reset();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.setState(initialStorageState, true);
  });

  // WAVE-ACCEPT-1117C: the column said "Can't reach This Home" over skeleton rows that never resolved, because the
  // list waited for upcoming work that an unreachable Home cannot answer. Its kept rows stand under the one line.
  it('presents its kept rows instead of waiting for upcoming work the Home cannot answer', async () => {
    const screen = await renderScreen(build(homeId));

    expect(screen.findByTestId('session-list-skeleton')).toBeNull();
    expect(probe.legendMounts).toBe(1);
    await screen.unmount();
  });
});
