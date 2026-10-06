import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCapturingLegendListMock,
  createDeferred,
  createExpoVectorIconsMock,
  createModalModuleMock,
  createSessionFixture,
  createSessionMessagesFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { Message } from "@happier-dev/session-core/messages";
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionMessages } from '@/sync/store/domains/messages';

const legendListMock = createCapturingLegendListMock({ renderItems: true });
const modalMock = createModalModuleMock({ confirmResult: true });
installDisconnectedServerSocketBoundary();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let storage: typeof import('@/sync/domains/state/storage')['storage'];

const state = vi.hoisted(() => ({
  profileScope: null as ServerAccountScope | null,
  refreshCalls: [] as string[],
  loadOlderCalls: [] as string[],
  refreshBySessionId: new Map<string, () => Promise<void>>(),
  loadOlderBySessionId: new Map<string, () => Promise<{
    loaded: number;
    hasMore: boolean;
    status: 'no_more';
  }>>(),
  sessions: {} as Record<string, Session>,
  sessionMessages: {} as Record<string, SessionMessages>,
}));

vi.mock('@/components/ui/lists/virtualized', () => ({
  VirtualizedList: legendListMock.module.LegendList,
}));
vi.mock('@expo/vector-icons', () => createExpoVectorIconsMock());
vi.mock('@/modal', () => modalMock.module);
// The History page is a settings page: its header reads the current route.
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await vi.importActual<typeof import('@/dev/testkit/mocks/router')>(
    '@/dev/testkit/mocks/router',
  );
  return createExpoRouterMock({ pathname: '/settings/voice-history' }).module;
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
  captureServerRequestAuthorityForServerAccountScope: async ({ scope }: { scope: ServerAccountScope }) => ({
    scope,
    context: {},
    release: async () => {},
    request: async () => new Response(JSON.stringify({
      sessions: [lookupSessionRecord(
        scope.accountId === 'account-a' ? 'voice-history-a' : 'voice-history-b',
      )],
    }), { status: 200 }),
  }),
}));

vi.mock('@/sync/runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => ({
    ensureSessionVisibleForMessageRoute: async (sessionId: string) => ({
      kind: 'available',
      sessionId,
    }),
    refreshSessionMessages: async (sessionId: string) => {
      state.refreshCalls.push(sessionId);
      await state.refreshBySessionId.get(sessionId)?.();
    },
    loadOlderMessages: async (sessionId: string) => {
      state.loadOlderCalls.push(sessionId);
      return await state.loadOlderBySessionId.get(sessionId)?.()
        ?? { loaded: 0, hasMore: false, status: 'no_more' as const };
    },
    retireLocalSession: () => undefined,
  }),
}));

function lookupSessionRecord(id: string) {
  return {
    id,
    seq: 0,
    createdAt: 1,
    updatedAt: 1,
    active: false,
    activeAt: 1,
    metadata: '{}',
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    dataEncryptionKey: null,
  };
}

function historySession(id: string): Session {
  return createSessionFixture({
    id,
    serverId: connection.home.id,
    active: false,
    metadata: {
      path: '/Users/tester/voice-history',
      host: 'tester.local',
      systemSessionV1: {
        v: 1,
        key: 'voice_transcript_history',
        hidden: true,
      },
    },
  });
}

function voiceMessage(id: string, text: string): Message {
  return {
    id,
    localId: null,
    createdAt: 1,
    text,
    kind: 'agent-text',
    meta: {
      happier: {
        kind: 'conversation_turn.v1',
        payload: { v: 1 },
        conversationTurnOriginV1: {
          v: 1,
          channel: 'realtime_conversation',
          modality: 'voice',
          source: {
            pluginId: 'happier.voice.openai',
            contributionId: 'realtime-openai',
          },
        },
      },
    },
  };
}

function publishScope(scope: ServerAccountScope): void {
  state.profileScope = scope;
  storage.setState({ profileScope: scope });
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

await loadSyncSingletonForTests();

describe('Voice History route account scope', () => {
  beforeEach(async () => {
    storage = (await import('@/sync/domains/state/storage')).storage;
    connection = await restoreServerAccountForTest({
      serverUrl: 'https://voice-history.test',
      accountId: 'account-a',
    });
    legendListMock.state.reset();
    modalMock.spies.confirm.mockReset();
    modalMock.spies.confirm.mockResolvedValue(true);
    state.profileScope = { serverId: connection.home.id, accountId: 'account-a' };
    state.refreshCalls.length = 0;
    state.loadOlderCalls.length = 0;
    state.refreshBySessionId.clear();
    state.loadOlderBySessionId.clear();
    state.sessions = {
      'voice-history-a': historySession('voice-history-a'),
      'voice-history-b': historySession('voice-history-b'),
    };
    state.sessionMessages = {
      'voice-history-a': createSessionMessagesFixture({
        messageIdsOldestFirst: ['account-a-row'],
        messagesById: { 'account-a-row': voiceMessage('account-a-row', 'Account A transcript') },
        isLoaded: true,
      }),
      'voice-history-b': createSessionMessagesFixture({
        messageIdsOldestFirst: ['account-b-row'],
        messagesById: { 'account-b-row': voiceMessage('account-b-row', 'Account B transcript') },
        isLoaded: true,
      }),
    };
    storage.setState({
      profileScope: state.profileScope,
      sessions: state.sessions,
      sessionMessages: state.sessionMessages,
    });
  });

  afterEach(async () => {
    standardCleanup();
    registerStorageStateReader(() => null as never);
    await connection?.dispose();
  });

  it('remounts one History consumer per same-server Account scope and never restores Account A rows', async () => {
    const refreshA = createDeferred<void>();
    const refreshB = createDeferred<void>();
    const loadOlderA = createDeferred<{
      loaded: number;
      hasMore: boolean;
      status: 'no_more';
    }>();
    state.refreshBySessionId.set('voice-history-a', () => refreshA.promise);
    state.refreshBySessionId.set('voice-history-b', () => refreshB.promise);
    state.loadOlderBySessionId.set('voice-history-a', () => loadOlderA.promise);

    const { SessionLookupByTagsResponseV2Schema } = await import('@happier-dev/protocol');
    expect(SessionLookupByTagsResponseV2Schema.safeParse({
      sessions: [lookupSessionRecord('voice-history-a')],
    }).success).toBe(true);
    const route = await import('../../../../app/(app)/settings/voice-history');
    registerStorageStateReader(() => storage.getState());
    const screen = await renderScreen(React.createElement(route.default));
    await flushAsyncWork();
    await vi.waitFor(() => expect(state.refreshCalls).toEqual(['voice-history-a']));

    await act(async () => {
      refreshA.resolve();
      await refreshA.promise;
    });
    await flushAsyncWork();
    expect(screen.findByTestId('voice-history-row-account-a-row')).not.toBeNull();

    await act(async () => {
      screen.pressByTestId('voice-history-load-older');
      await Promise.resolve();
    });
    expect(state.loadOlderCalls).toEqual(['voice-history-a']);

    await act(async () => {
      publishScope({ serverId: connection.home.id, accountId: 'account-b' });
    });
    expect(screen.findByTestId('voice-history-row-account-a-row')).toBeNull();
    expect(screen.findByTestId('voice-history-loading')).not.toBeNull();

    await act(async () => {
      loadOlderA.resolve({ loaded: 0, hasMore: false, status: 'no_more' });
      await loadOlderA.promise;
    });
    await flushAsyncWork();
    expect(screen.findByTestId('voice-history-row-account-a-row')).toBeNull();
    expect(screen.findByTestId('voice-history-loading')).not.toBeNull();

    await act(async () => {
      refreshB.resolve();
      await refreshB.promise;
    });
    await flushAsyncWork();
    expect(screen.findByTestId('voice-history-row-account-a-row')).toBeNull();
    expect(screen.findByTestId('voice-history-row-account-b-row')).not.toBeNull();
  });
});
