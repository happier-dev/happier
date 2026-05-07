import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

function makeRenderableSession(
  id: string,
  overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
  return {
    id,
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: false,
    activeAt: 1,
    archivedAt: null,
    metadataVersion: 1,
    agentStateVersion: 0,
    metadata: null,
    thinking: false,
    thinkingAt: 0,
    presence: 1,
    ...overrides,
  };
}

describe('useHasUnreadMessages', () => {
  afterEach(() => {
    storage.setState({
      sessions: {},
      sessionListRenderables: {},
      isDataReady: true,
    } as never);
    standardCleanup();
  });

  it('uses session-list row unread state when the full session is not hydrated', async () => {
    storage.setState({
      sessions: {},
      sessionListRenderables: {
        s1: makeRenderableSession('s1', { hasUnreadMessages: true }),
      },
      isDataReady: true,
    } as never);

    const { useHasUnreadMessages } = await import('./hooks');
    const hook = await renderHook(() => useHasUnreadMessages('s1'));

    expect(hook.getCurrent()).toBe(true);
    await hook.unmount();
  });
});
