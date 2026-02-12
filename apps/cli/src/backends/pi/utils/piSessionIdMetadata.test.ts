import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import { maybeUpdatePiSessionIdMetadata } from './piSessionIdMetadata';

describe('maybeUpdatePiSessionIdMetadata', () => {
  it.each([null, '', '   '])('does not publish metadata when session id is %p', (sessionId) => {
    const lastPublished = { value: null as string | null };
    let metadata = createTestMetadata();
    let calls = 0;

    maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => sessionId,
      updateHappySessionMetadata: (updater) => {
        calls += 1;
        metadata = updater(metadata);
      },
      lastPublished,
    });

    expect(calls).toBe(0);
    expect(lastPublished.value).toBeNull();
    expect((metadata as Metadata & { piSessionId?: string }).piSessionId).toBeUndefined();
  });

  it('publishes trimmed session id once and preserves unrelated metadata', () => {
    const lastPublished = { value: null as string | null };
    let metadata = createTestMetadata({ flavor: 'pi' });

    maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => '  pi-session-1 ',
      updateHappySessionMetadata: (updater) => {
        metadata = updater(metadata);
      },
      lastPublished,
    });

    expect(lastPublished.value).toBe('pi-session-1');
    expect((metadata as Metadata & { piSessionId?: string }).piSessionId).toBe('pi-session-1');
    expect(metadata.flavor).toBe('pi');
  });

  it('does not update metadata when value is unchanged', () => {
    const lastPublished = { value: null as string | null };
    let metadata = createTestMetadata();
    let calls = 0;

    maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => 'pi-session-1',
      updateHappySessionMetadata: (updater) => {
        calls += 1;
        metadata = updater(metadata);
      },
      lastPublished,
    });
    const snapshot = metadata;

    maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => ' pi-session-1 ',
      updateHappySessionMetadata: (updater) => {
        calls += 1;
        metadata = updater(metadata);
      },
      lastPublished,
    });

    expect(calls).toBe(1);
    expect(metadata).toBe(snapshot);
  });
});
