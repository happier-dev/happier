import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createProviderSessionIdMetadataUpdater } from './createProviderSessionIdMetadataUpdater';

describe('createProviderSessionIdMetadataUpdater', () => {
  const maybeUpdate = createProviderSessionIdMetadataUpdater('kimiSessionId');

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
    const updater = createProviderSessionIdMetadataUpdater('qwenSessionId');
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
});
