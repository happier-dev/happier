import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { maybeUpdateKiloSessionIdMetadata } from './kiloSessionIdMetadata';

describe('maybeUpdateKiloSessionIdMetadata', () => {
  it('no-ops when session id is missing', () => {
    const lastPublished = { value: null as string | null };
    let calls = 0;

    maybeUpdateKiloSessionIdMetadata({
      getKiloSessionId: () => null,
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

    maybeUpdateKiloSessionIdMetadata({
      getKiloSessionId: () => '   ',
      updateHappySessionMetadata: () => {
        calls++;
      },
      lastPublished,
    });

    expect(calls).toBe(0);
    expect(lastPublished.value).toBeNull();
  });

  it('publishes kiloSessionId once per new session id and preserves other metadata', () => {
    const updates: Metadata[] = [];
    const lastPublished = { value: null as string | null };

    maybeUpdateKiloSessionIdMetadata({
      getKiloSessionId: () => 'kilo-1',
      updateHappySessionMetadata: (updater) => updates.push(updater(createTestMetadata({ name: 'keep-name' }))),
      lastPublished,
    });

    maybeUpdateKiloSessionIdMetadata({
      getKiloSessionId: () => 'kilo-1',
      updateHappySessionMetadata: (updater) => updates.push(updater(createTestMetadata({ name: 'keep-name' }))),
      lastPublished,
    });

    maybeUpdateKiloSessionIdMetadata({
      getKiloSessionId: () => 'kilo-2',
      updateHappySessionMetadata: (updater) => updates.push(updater(createTestMetadata({ name: 'keep-name' }))),
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ name: 'keep-name', kiloSessionId: 'kilo-1' }),
      createTestMetadata({ name: 'keep-name', kiloSessionId: 'kilo-2' }),
    ]);
  });

  it('overwrites existing kiloSessionId while preserving unrelated metadata', () => {
    const lastPublished = { value: null as string | null };
    const updates: Metadata[] = [];

    maybeUpdateKiloSessionIdMetadata({
      getKiloSessionId: () => 'kilo-next',
      updateHappySessionMetadata: (updater) => {
        updates.push(updater(createTestMetadata({ kiloSessionId: 'kilo-old', name: 'keep-name' })));
      },
      lastPublished,
    });

    expect(updates).toEqual([
      createTestMetadata({ kiloSessionId: 'kilo-next', name: 'keep-name' }),
    ]);
  });
});
