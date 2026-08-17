import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCapturingLegendListMock,
  createDeferred,
  createExpoVectorIconsMock,
  createLiveStorageStoreMock,
  createModalModuleMock,
  createSessionFixture,
  createSessionMessagesFixture,
  createStorageModuleStub,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { registerStorageStateReader } from '@/sync/domains/state/storageStateReaderBridge';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionMessages } from '@/sync/store/domains/messages';

const legendListMock = createCapturingLegendListMock({ renderItems: true });
const modalMock = createModalModuleMock({ confirmResult: true });

const state = vi.hoisted(() => ({
  profileScope: null as ServerAccountScope | null,
  profileScopeListeners: new Set<() => void>(),
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

vi.mock('@/sync/domains/state/storage', () => {
  const storage = createLiveStorageStoreMock(() => ({
    profileScope: state.profileScope,
    sessions: state.sessions,
    sessionMessages: state.sessionMessages,
  }));
  return createStorageModuleStub({
    storage,
    useActiveServerAccountScope: () => React.useSyncExternalStore(
      (listener) => {
        state.profileScopeListeners.add(listener);
        return () => state.profileScopeListeners.delete(listener);
      },
      () => state.profileScope,
      () => state.profileScope,
    ),
  });
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
  subscribeActiveServer: () => () => {},
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope', () => ({
  captureSessionRequestAuthorityForServerAccountScope: async ({ scope }: { scope: ServerAccountScope }) => ({
    scope,
    context: {},
    request: async () => new Response(JSON.stringify({
      sessions: [lookupSessionRecord(
        scope.accountId === 'account-a' ? 'voice-history-a' : 'voice-history-b',
      )],
    }), { status: 200 }),
  }),
}));

vi.mock('@/sync/api/capabilities/accountStoredContentCompatibility', () => ({
  isAccountStoredContentClientUpgradeRequiredError: () => false,
  requireCurrentAccountStoredContentServerCompatibility: async () => undefined,
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
  for (const listener of [...state.profileScopeListeners]) listener();
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Voice History route account scope', () => {
  beforeEach(() => {
    legendListMock.state.reset();
    modalMock.spies.confirm.mockReset();
    modalMock.spies.confirm.mockResolvedValue(true);
    state.profileScope = { serverId: 'server-1', accountId: 'account-a' };
    state.profileScopeListeners.clear();
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
  });

  afterEach(() => {
    standardCleanup();
    state.profileScopeListeners.clear();
    registerStorageStateReader(() => null as never);
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
    registerStorageStateReader(() => ({
      profileScope: state.profileScope,
      sessions: state.sessions,
      sessionMessages: state.sessionMessages,
    }) as never);
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
      publishScope({ serverId: 'server-1', accountId: 'account-b' });
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
