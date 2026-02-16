import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { maybeUpdateCodexSessionIdMetadata, publishCodexSessionIdMetadata } from './codexSessionIdMetadata';

describe('maybeUpdateCodexSessionIdMetadata', () => {
  it('no-ops when thread id is missing', () => {
    const lastPublished = { value: null as string | null };
    let called = 0;

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => null,
      updateHappySessionMetadata: () => {
        called++;
      },
      lastPublished,
    });

    expect(called).toBe(0);
    expect(lastPublished.value).toBeNull();
  });

  it('no-ops when thread id is whitespace-only', () => {
    const lastPublished = { value: null as string | null };
    let called = 0;

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => '   ',
      updateHappySessionMetadata: () => {
        called++;
      },
      lastPublished,
    });

    expect(called).toBe(0);
    expect(lastPublished.value).toBeNull();
  });

  it('publishes codexSessionId once per new thread id and preserves other metadata', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    const apply = (updater: (m: Metadata) => Metadata) => {
      const base = createTestMetadata({ path: '/tmp' });
      updates.push(updater(base));
    };

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => ' thread-1 ',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-2',
      updateHappySessionMetadata: apply,
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ path: '/tmp', codexSessionId: 'thread-1' }),
      createTestMetadata({ path: '/tmp', codexSessionId: 'thread-2' }),
    ]);
  });

  it('overwrites prior codexSessionId while preserving unrelated metadata', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-next',
      updateHappySessionMetadata: (updater) => {
        updates.push(updater(createTestMetadata({ codexSessionId: 'thread-old', name: 'keep-name' })));
      },
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ codexSessionId: 'thread-next', name: 'keep-name' }),
    ]);
  });

  it('does not mark thread id as published when the metadata update fails', async () => {
    const lastPublished = { value: null as string | null };
    let called = 0;

    maybeUpdateCodexSessionIdMetadata({
      getCodexThreadId: () => 'thread-1',
      updateHappySessionMetadata: async () => {
        called++;
        throw new Error('update failed');
      },
      lastPublished,
    });

    // Flush microtasks so the rejection handler can revert the optimistic publish.
    await Promise.resolve();
    await Promise.resolve();

    expect(called).toBe(1);
    expect(lastPublished.value).toBeNull();
  });

  it('retries publishing when a session.updateMetadata call fails', async () => {
    const lastPublished = { value: null as string | null };
    let calls = 0;

    const session = {
      updateMetadata: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('update failed');
        }
      },
    };

    publishCodexSessionIdMetadata({ session: session as any, getCodexThreadId: () => 'thread-1', lastPublished });
    await Promise.resolve();
    await Promise.resolve();
    expect(lastPublished.value).toBeNull();

    publishCodexSessionIdMetadata({ session: session as any, getCodexThreadId: () => 'thread-1', lastPublished });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(lastPublished.value).toBe('thread-1');
  });
});
