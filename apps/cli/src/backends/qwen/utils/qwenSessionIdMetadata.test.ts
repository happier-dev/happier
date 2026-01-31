import { describe, expect, it } from 'vitest';

import { maybeUpdateQwenSessionIdMetadata } from './qwenSessionIdMetadata';

describe('maybeUpdateQwenSessionIdMetadata', () => {
  it('publishes qwenSessionId once per new session id and preserves other metadata', () => {
    const last = { value: null as string | null };
    let metadata: any = { existing: true };

    maybeUpdateQwenSessionIdMetadata({
      getQwenSessionId: () => 'qwen-1',
      updateHappySessionMetadata: (updater) => { metadata = updater(metadata); },
      lastPublished: last,
    });

    expect(metadata.qwenSessionId).toBe('qwen-1');
    expect(metadata.existing).toBe(true);

    // Same id again should not re-run updater
    const before = metadata;
    maybeUpdateQwenSessionIdMetadata({
      getQwenSessionId: () => 'qwen-1',
      updateHappySessionMetadata: (updater) => { metadata = updater(metadata); },
      lastPublished: last,
    });
    expect(metadata).toBe(before);

    maybeUpdateQwenSessionIdMetadata({
      getQwenSessionId: () => 'qwen-2',
      updateHappySessionMetadata: (updater) => { metadata = updater(metadata); },
      lastPublished: last,
    });
    expect(metadata.qwenSessionId).toBe('qwen-2');
  });
});

