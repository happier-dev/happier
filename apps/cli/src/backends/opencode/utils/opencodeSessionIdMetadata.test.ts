import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { maybeUpdateOpenCodeSessionIdMetadata } from './opencodeSessionIdMetadata';

describe('maybeUpdateOpenCodeSessionIdMetadata', () => {
  it('no-ops when session id is missing', async () => {
    const lastPublished = { sessionId: null as string | null, backendMode: null as 'server' | 'acp' | null };
    let called = 0;

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => null,
      backendMode: 'server',
      updateHappySessionMetadata: () => {
        called++;
      },
      lastPublished,
    });

    expect(called).toBe(0);
    expect(lastPublished.sessionId).toBeNull();
    expect(lastPublished.backendMode).toBeNull();
  });

  it('publishes opencodeSessionId once per new session id and preserves other metadata', async () => {
    const lastPublished = { sessionId: null as string | null, backendMode: null as 'server' | 'acp' | null };
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      const base = { path: '/tmp', flavor: 'opencode' } as unknown as Metadata;
      updates.push(updater(base));
    };

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => ' session-1 ',
      backendMode: 'server',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => 'session-1',
      backendMode: 'server',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    await maybeUpdateOpenCodeSessionIdMetadata({
      getOpenCodeSessionId: () => 'session-2',
      backendMode: 'server',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    expect(updates).toEqual([
      { path: '/tmp', flavor: 'opencode', opencodeSessionId: 'session-1', opencodeBackendMode: 'server' } as unknown as Metadata,
      { path: '/tmp', flavor: 'opencode', opencodeSessionId: 'session-2', opencodeBackendMode: 'server' } as unknown as Metadata,
    ]);
  });

  it('does not mark the session id as published when the metadata update fails', async () => {
    const lastPublished = { sessionId: null as string | null, backendMode: null as 'server' | 'acp' | null };
    let called = 0;

    await expect(
      maybeUpdateOpenCodeSessionIdMetadata({
        getOpenCodeSessionId: () => 'session-1',
        backendMode: 'server',
        updateHappySessionMetadata: async () => {
          called++;
          throw new Error('update failed');
        },
        lastPublished,
      }),
    ).rejects.toThrow('update failed');

    expect(called).toBe(1);
    expect(lastPublished.sessionId).toBeNull();
    expect(lastPublished.backendMode).toBeNull();
  });
});
