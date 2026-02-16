import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { maybeUpdateGeminiSessionIdMetadata } from './geminiSessionIdMetadata';

describe('maybeUpdateGeminiSessionIdMetadata', () => {
  it('no-ops when session id is missing', () => {
    const lastPublished = { value: null as string | null };
    let calls = 0;

    maybeUpdateGeminiSessionIdMetadata({
      getGeminiSessionId: () => null,
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

    maybeUpdateGeminiSessionIdMetadata({
      getGeminiSessionId: () => '   ',
      updateHappySessionMetadata: () => {
        calls++;
      },
      lastPublished,
    });

    expect(calls).toBe(0);
    expect(lastPublished.value).toBeNull();
  });

  it('publishes geminiSessionId once per new session id and preserves other metadata', () => {
    const updates: Metadata[] = [];
    const lastPublished = { value: null as string | null };

    maybeUpdateGeminiSessionIdMetadata({
      getGeminiSessionId: () => 'g1',
      updateHappySessionMetadata: (updater) => {
        updates.push(updater(createTestMetadata({ name: 'keep-name' })));
      },
      lastPublished,
    });

    maybeUpdateGeminiSessionIdMetadata({
      getGeminiSessionId: () => 'g1',
      updateHappySessionMetadata: (updater) => {
        updates.push(updater(createTestMetadata({ name: 'keep-name' })));
      },
      lastPublished,
    });

    maybeUpdateGeminiSessionIdMetadata({
      getGeminiSessionId: () => 'g2',
      updateHappySessionMetadata: (updater) => {
        updates.push(updater(createTestMetadata({ name: 'keep-name' })));
      },
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ name: 'keep-name', geminiSessionId: 'g1' }),
      createTestMetadata({ name: 'keep-name', geminiSessionId: 'g2' }),
    ]);
  });

  it('overwrites existing geminiSessionId while preserving unrelated metadata', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    maybeUpdateGeminiSessionIdMetadata({
      getGeminiSessionId: () => 'g-next',
      updateHappySessionMetadata: (updater) => {
        updates.push(updater(createTestMetadata({ geminiSessionId: 'g-old', name: 'keep-name' })));
      },
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ geminiSessionId: 'g-next', name: 'keep-name' }),
    ]);
  });

  it('does not mark the session id as published when the metadata update fails', async () => {
    const lastPublished = { value: null as string | null };
    let calls = 0;

    maybeUpdateGeminiSessionIdMetadata({
      getGeminiSessionId: () => 'g1',
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
});
