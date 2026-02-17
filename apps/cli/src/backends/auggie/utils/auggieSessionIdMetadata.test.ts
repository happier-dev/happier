import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { maybeUpdateAuggieSessionIdMetadata } from './auggieSessionIdMetadata';

const BASE_METADATA: Metadata = {
  path: '/tmp',
  host: 'localhost',
  homeDir: '/tmp/home',
  happyHomeDir: '/tmp/.happy',
  happyLibDir: '/tmp/.happy/lib',
  happyToolsDir: '/tmp/.happy/tools',
};

describe('maybeUpdateAuggieSessionIdMetadata', () => {
  it('publishes auggieSessionId once per new session id and preserves other metadata', () => {
    const published: Metadata[] = [];
    const last = { value: null as string | null };
    const applyUpdate = (updater: (metadata: Metadata) => Metadata) => {
      published.push(updater({ ...BASE_METADATA, name: 'keep-me' }));
    };

    maybeUpdateAuggieSessionIdMetadata({
      getAuggieSessionId: () => 'a1',
      updateHappySessionMetadata: applyUpdate,
      lastPublished: last,
    });

    maybeUpdateAuggieSessionIdMetadata({
      getAuggieSessionId: () => 'a1',
      updateHappySessionMetadata: applyUpdate,
      lastPublished: last,
    });

    maybeUpdateAuggieSessionIdMetadata({
      getAuggieSessionId: () => 'a2',
      updateHappySessionMetadata: applyUpdate,
      lastPublished: last,
    });

    expect(published).toEqual([
      { ...BASE_METADATA, name: 'keep-me', auggieSessionId: 'a1' },
      { ...BASE_METADATA, name: 'keep-me', auggieSessionId: 'a2' },
    ]);
  });

  it('does not mark the session id as published when the metadata update fails', async () => {
    const lastPublished = { value: null as string | null };
    let called = 0;

    maybeUpdateAuggieSessionIdMetadata({
      getAuggieSessionId: () => 'a1',
      updateHappySessionMetadata: async () => {
        called++;
        throw new Error('update failed');
      },
      lastPublished,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(called).toBe(1);
    expect(lastPublished.value).toBeNull();
  });
});
