import { describe, expect, it } from 'vitest';

import { maybeUpdateKimiSessionIdMetadata } from './kimiSessionIdMetadata';

describe('maybeUpdateKimiSessionIdMetadata', () => {
  it('publishes kimiSessionId once per new session id and preserves other metadata', () => {
    const last = { value: null as string | null };
    let metadata: any = { existing: true };

    maybeUpdateKimiSessionIdMetadata({
      getKimiSessionId: () => 'kimi-1',
      updateHappySessionMetadata: (updater) => { metadata = updater(metadata); },
      lastPublished: last,
    });

    expect(metadata.kimiSessionId).toBe('kimi-1');
    expect(metadata.existing).toBe(true);

    const before = metadata;
    maybeUpdateKimiSessionIdMetadata({
      getKimiSessionId: () => 'kimi-1',
      updateHappySessionMetadata: (updater) => { metadata = updater(metadata); },
      lastPublished: last,
    });
    expect(metadata).toBe(before);

    maybeUpdateKimiSessionIdMetadata({
      getKimiSessionId: () => 'kimi-2',
      updateHappySessionMetadata: (updater) => { metadata = updater(metadata); },
      lastPublished: last,
    });
    expect(metadata.kimiSessionId).toBe('kimi-2');
  });
});

