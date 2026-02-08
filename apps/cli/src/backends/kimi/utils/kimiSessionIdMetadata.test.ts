import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/backends/testHelpers/sessionMetadata.testHelpers';
import { maybeUpdateKimiSessionIdMetadata } from './kimiSessionIdMetadata';

describe('maybeUpdateKimiSessionIdMetadata', () => {
  it('no-ops when session id is missing', () => {
    const lastPublished = { value: null as string | null };
    let calls = 0;

    maybeUpdateKimiSessionIdMetadata({
      getKimiSessionId: () => null,
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

    maybeUpdateKimiSessionIdMetadata({
      getKimiSessionId: () => '   ',
      updateHappySessionMetadata: () => {
        calls++;
      },
      lastPublished,
    });

    expect(calls).toBe(0);
    expect(lastPublished.value).toBeNull();
  });

  it('publishes kimiSessionId once per new session id and preserves metadata', () => {
    const updates: Metadata[] = [];
    const lastPublished = { value: null as string | null };

    maybeUpdateKimiSessionIdMetadata({
      getKimiSessionId: () => ' kimi-1 ',
      updateHappySessionMetadata: (updater) => updates.push(updater(createTestMetadata({ name: 'keep-name' }))),
      lastPublished,
    });

    maybeUpdateKimiSessionIdMetadata({
      getKimiSessionId: () => 'kimi-1',
      updateHappySessionMetadata: (updater) => updates.push(updater(createTestMetadata({ name: 'keep-name' }))),
      lastPublished,
    });

    maybeUpdateKimiSessionIdMetadata({
      getKimiSessionId: () => 'kimi-2',
      updateHappySessionMetadata: (updater) => updates.push(updater(createTestMetadata({ name: 'keep-name' }))),
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ name: 'keep-name', kimiSessionId: 'kimi-1' }),
      createTestMetadata({ name: 'keep-name', kimiSessionId: 'kimi-2' }),
    ]);
  });

  it('overwrites existing kimiSessionId while preserving unrelated metadata', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    maybeUpdateKimiSessionIdMetadata({
      getKimiSessionId: () => 'kimi-next',
      updateHappySessionMetadata: (updater) => {
        updates.push(updater(createTestMetadata({ kimiSessionId: 'kimi-old', name: 'keep-name' })));
      },
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ kimiSessionId: 'kimi-next', name: 'keep-name' }),
    ]);
  });
});
