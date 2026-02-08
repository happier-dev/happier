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
});
