import { afterEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storageStore';

import { useUserMessageHistory } from './useUserMessageHistory';
import { renderHook } from '@/dev/testkit';

const serverFeaturesSnapshotState = vi.hoisted(() => ({
  current: {
    status: 'loading' as const,
    features: null,
  } as
    | Readonly<{ status: 'loading'; features: null }>
    | Readonly<{
      status: 'ready';
      features: {
        capabilities: {
          session: {
            messages: {
              role: boolean;
            };
          };
        };
      };
    }>,
}));
const fetchUserMessageHistoryPageMock = vi.hoisted(() =>
  vi.fn(async (_sessionId: string, _opts?: { beforeSeq?: number | null; limit?: number }) => ({
    status: 'unsupported' as const,
  })),
);

vi.mock('@/sync/sync', () => ({
  sync: {
    fetchUserMessageHistoryPage: (
      sessionId: string,
      opts?: { beforeSeq?: number | null; limit?: number },
    ) => fetchUserMessageHistoryPageMock(sessionId, opts),
  },
}));

vi.mock('@/agents/catalog/catalog', () => ({
  isAgentId: (value: unknown) => value === 'codex',
}));

vi.mock('@/agents/registry/registryUiBehavior', () => ({
  resolveAgentUiBehavior: () => ({}),
  resolveAgentUiBehaviorFromFlavor: () => ({}),
  supportsDetectedMcpConfigScan: () => false,
  supportsEditableSessionGoals: () => false,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
  usePreferredServerIdForSession: () => 'server-1',
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
  useServerFeaturesSnapshotForServerId: () => serverFeaturesSnapshotState.current,
}));

describe('useUserMessageHistory', () => {
  afterEach(() => {
    fetchUserMessageHistoryPageMock.mockClear();
    serverFeaturesSnapshotState.current = {
      status: 'loading',
      features: null,
    };
  });

  it('returns a referentially stable navigator when store state is unchanged', async () => {
    const previousState = storage.getState();
    try {
      const messagesById = {
        u1: { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' } as any,
        a1: { kind: 'agent-text', id: 'a1', localId: null, createdAt: 2, text: 'ok', isThinking: false } as any,
        u2: { kind: 'user-text', id: 'u2', localId: null, createdAt: 3, text: 'bye' } as any,
      };

      storage.setState((state) => ({
        ...state,
        sessionMessages: {
          ...state.sessionMessages,
          s1: {
            messageIdsOldestFirst: ['u1', 'a1', 'u2'],
            messagesById,
            messagesMap: messagesById,
            reducerState: {} as any,
            latestThinkingMessageId: null,
            latestThinkingMessageActivityAtMs: null,
            messagesVersion: 1,
            isLoaded: true,
          },
        },
      }));

      const hook = await renderHook(() =>
        useUserMessageHistory({ scope: 'global', sessionId: null, maxEntries: 20 }),
      );

      const first = hook.getCurrent();

      await hook.rerender();

      expect(hook.getCurrent()).toBe(first);

      await hook.unmount();
    } finally {
      storage.setState(previousState);
    }
  });

  it('normalizes session ids before reading per-session history', async () => {
    const previousState = storage.getState();
    try {
      const messagesById = {
        u1: { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first' } as any,
        u2: { kind: 'user-text', id: 'u2', localId: null, createdAt: 2, text: 'second' } as any,
      };

      storage.setState((state) => ({
        ...state,
        sessionMessages: {
          ...state.sessionMessages,
          s1: {
            messageIdsOldestFirst: ['u1', 'u2'],
            messagesById,
            messagesMap: messagesById,
            reducerState: {} as any,
            latestThinkingMessageId: null,
            latestThinkingMessageActivityAtMs: null,
            messagesVersion: 1,
            isLoaded: true,
          },
        },
      }));

      const hook = await renderHook(() =>
        useUserMessageHistory({ scope: 'perSession', sessionId: '  s1  ', maxEntries: 20 }),
      );

      expect(hook.getCurrent().moveUp('draft')).toBe('second');

      await hook.unmount();
    } finally {
      storage.setState(previousState);
    }
  });

  it('preserves active per-session browsing when role-query support becomes ready', async () => {
    const previousState = storage.getState();
    try {
      const messagesById = {
        u1: { kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'first' } as any,
        u2: { kind: 'user-text', id: 'u2', localId: null, createdAt: 2, text: 'second' } as any,
      };

      storage.setState((state) => ({
        ...state,
        sessionMessages: {
          ...state.sessionMessages,
          s1: {
            messageIdsOldestFirst: ['u1', 'u2'],
            messagesById,
            messagesMap: messagesById,
            reducerState: {} as any,
            latestThinkingMessageId: null,
            latestThinkingMessageActivityAtMs: null,
            messagesVersion: 1,
            isLoaded: true,
          },
        },
      }));

      const hook = await renderHook(() =>
        useUserMessageHistory({ scope: 'perSession', sessionId: 's1', maxEntries: 20 }),
      );

      const browsingNavigator = hook.getCurrent();
      expect(browsingNavigator.moveUp('draft')).toBe('second');
      expect(browsingNavigator.isBrowsing()).toBe(true);

      serverFeaturesSnapshotState.current = {
        status: 'ready',
        features: {
          capabilities: {
            session: {
              messages: {
                role: true,
              },
            },
          },
        },
      };
      await hook.rerender();

      expect(hook.getCurrent()).toBe(browsingNavigator);
      expect(hook.getCurrent().moveUp('second')).toBe('first');

      await hook.unmount();
    } finally {
      storage.setState(previousState);
    }
  });
});
