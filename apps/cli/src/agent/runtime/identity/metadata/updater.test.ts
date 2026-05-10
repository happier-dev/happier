import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import { createSessionRuntimeIdentityMetadataUpdater } from './updater';

describe('createSessionRuntimeIdentityMetadataUpdater', () => {
  const maybeUpdate = createSessionRuntimeIdentityMetadataUpdater('kimiSessionId');

  it('no-ops when session id is missing', () => {
    const lastPublished = { value: null as string | null };
    let calls = 0;

    maybeUpdate({
      getSessionId: () => null,
      updateHappySessionMetadata: () => {
        calls++;
      },
      lastPublished,
    });

    expect(calls).toBe(0);
    expect(lastPublished.value).toBeNull();
  });

  it('no-ops when session id is whitespace-only', () => {
    const lastPublished = { value: null as string | null };
    let calls = 0;

    maybeUpdate({
      getSessionId: () => '   ',
      updateHappySessionMetadata: () => {
        calls++;
      },
      lastPublished,
    });

    expect(calls).toBe(0);
    expect(lastPublished.value).toBeNull();
  });

  it('publishes session id once per new value and preserves metadata', () => {
    const updates: Metadata[] = [];
    const lastPublished = { value: null as string | null };

    maybeUpdate({
      getSessionId: () => ' kimi-1 ',
      updateHappySessionMetadata: (updater) => {
        updates.push(updater(createTestMetadata({ name: 'keep-name' })));
      },
      lastPublished,
    });

    maybeUpdate({
      getSessionId: () => 'kimi-1',
      updateHappySessionMetadata: (updater) => {
        updates.push(updater(createTestMetadata({ name: 'keep-name' })));
      },
      lastPublished,
    });

    maybeUpdate({
      getSessionId: () => 'kimi-2',
      updateHappySessionMetadata: (updater) => {
        updates.push(updater(createTestMetadata({ name: 'keep-name' })));
      },
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ name: 'keep-name', kimiSessionId: 'kimi-1' }),
      createTestMetadata({ name: 'keep-name', kimiSessionId: 'kimi-2' }),
    ]);
  });

  it('overwrites existing value while preserving unrelated metadata', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    maybeUpdate({
      getSessionId: () => 'kimi-next',
      updateHappySessionMetadata: (updater) => {
        updates.push(updater(createTestMetadata({ kimiSessionId: 'kimi-old', name: 'keep-name' })));
      },
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ kimiSessionId: 'kimi-next', name: 'keep-name' }),
    ]);
  });

  it('does not mark the session id as published when the metadata update fails', async () => {
    const lastPublished = { value: null as string | null };
    let calls = 0;

    maybeUpdate({
      getSessionId: () => 'kimi-1',
      updateHappySessionMetadata: async () => {
        calls += 1;
        throw new Error('update failed');
      },
      lastPublished,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toBe(1);
    expect(lastPublished.value).toBeNull();
  });

  it('works with different metadata keys', () => {
    const updater = createSessionRuntimeIdentityMetadataUpdater('qwenSessionId');
    const updates: Metadata[] = [];
    const lastPublished = { value: null as string | null };

    updater({
      getSessionId: () => 'qwen-1',
      updateHappySessionMetadata: (fn) => {
        updates.push(fn(createTestMetadata({ name: 'test' })));
      },
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ name: 'test', qwenSessionId: 'qwen-1' }),
    ]);
  });

  it('uses the session-state vendor binding for provider-specific metadata keys', () => {
    const updater = createSessionRuntimeIdentityMetadataUpdater('claudeSessionId');
    const updates: Metadata[] = [];
    const lastPublished = { value: null as string | null };

    updater({
      getSessionId: () => ' claude-1 ',
      updateHappySessionMetadata: (fn) => {
        updates.push(fn(createTestMetadata({ name: 'test' })));
      },
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ name: 'test', claudeSessionId: 'claude-1' }),
    ]);
  });

  it('passes the real happy session id into the session-state metadata port', () => {
    const updater = createSessionRuntimeIdentityMetadataUpdater('claudeSessionId');
    const updateSessionIds: string[] = [];
    const lastPublished = { value: null as string | null };

    updater({
      sessionId: ' sess-happy-1 ',
      getSessionId: () => 'claude-1',
      updateHappySessionMetadata: (_fn, sessionId) => {
        updateSessionIds.push(sessionId);
      },
      lastPublished,
    });

    expect(updateSessionIds).toEqual(['sess-happy-1']);
  });
});
