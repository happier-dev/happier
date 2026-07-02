import { describe, expect, it } from 'vitest';

import {
  maybeUpdatePiSessionIdMetadata,
  type PiSessionMetadataRecord,
  type PublishedPiSessionMetadata,
} from './sessionMetadata.js';

function createMetadata(overrides: PiSessionMetadataRecord = {}): PiSessionMetadataRecord {
  return {
    path: '/tmp/workspace',
    host: 'localhost',
    ...overrides,
  };
}

describe('maybeUpdatePiSessionIdMetadata', () => {
  it.each([null, '', '   '])('does not publish metadata when session id is %p', (sessionId) => {
    const lastPublished = { value: null as PublishedPiSessionMetadata | null };
    let metadata = createMetadata();
    let calls = 0;

    maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => sessionId,
      getPiSessionFile: () => null,
      updateHappySessionMetadata: (updater) => {
        calls += 1;
        metadata = updater(metadata);
      },
      lastPublished,
    });

    expect(calls).toBe(0);
    expect(lastPublished.value).toBeNull();
    expect(metadata.piSessionId).toBeUndefined();
  });

  it('publishes trimmed session id once and preserves unrelated metadata', () => {
    const lastPublished = { value: null as PublishedPiSessionMetadata | null };
    let metadata = createMetadata({ flavor: 'pi' });

    maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => '  pi-session-1 ',
      getPiSessionFile: () => '  /tmp/pi/sessions/pi-session-1.jsonl ',
      updateHappySessionMetadata: (updater) => {
        metadata = updater(metadata);
      },
      lastPublished,
    });

    expect(lastPublished.value).toEqual({
      sessionId: 'pi-session-1',
      sessionFile: '/tmp/pi/sessions/pi-session-1.jsonl',
    });
    expect(metadata.piSessionId).toBe('pi-session-1');
    expect(metadata.piSessionFile).toBe('/tmp/pi/sessions/pi-session-1.jsonl');
    expect(metadata.agentRuntimeDescriptorV1).toEqual({
      v: 1,
      providerId: 'pi',
      provider: {
        resumeStrategy: 'sessionFileAbsolutePreferred',
        providerSessionId: 'pi-session-1',
        sessionFile: '/tmp/pi/sessions/pi-session-1.jsonl',
      },
    });
    expect(metadata.flavor).toBe('pi');
  });

  it('does not update metadata when the published session id and file are unchanged', () => {
    const lastPublished = { value: null as PublishedPiSessionMetadata | null };
    let metadata = createMetadata();
    let calls = 0;

    maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => 'pi-session-1',
      getPiSessionFile: () => '/tmp/pi/sessions/pi-session-1.jsonl',
      updateHappySessionMetadata: (updater) => {
        calls += 1;
        metadata = updater(metadata);
      },
      lastPublished,
    });
    const snapshot = metadata;

    maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => ' pi-session-1 ',
      getPiSessionFile: () => '/tmp/pi/sessions/pi-session-1.jsonl',
      updateHappySessionMetadata: (updater) => {
        calls += 1;
        metadata = updater(metadata);
      },
      lastPublished,
    });

    expect(calls).toBe(1);
    expect(metadata).toBe(snapshot);
  });

  it('publishes a newly discovered absolute session file for the same session id', () => {
    const lastPublished = { value: null as PublishedPiSessionMetadata | null };
    let metadata = createMetadata({ flavor: 'pi' });
    let sessionFile: string | null = null;
    let calls = 0;

    maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => 'pi-session-1',
      getPiSessionFile: () => sessionFile,
      updateHappySessionMetadata: (updater) => {
        calls += 1;
        metadata = updater(metadata);
      },
      lastPublished,
    });

    sessionFile = '/tmp/pi/sessions/pi-session-1.jsonl';
    maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => 'pi-session-1',
      getPiSessionFile: () => sessionFile,
      updateHappySessionMetadata: (updater) => {
        calls += 1;
        metadata = updater(metadata);
      },
      lastPublished,
    });

    expect(calls).toBe(2);
    expect(lastPublished.value).toEqual({
      sessionId: 'pi-session-1',
      sessionFile: '/tmp/pi/sessions/pi-session-1.jsonl',
    });
    expect(metadata.piSessionFile).toBe('/tmp/pi/sessions/pi-session-1.jsonl');
    expect(metadata.agentRuntimeDescriptorV1).toEqual({
      v: 1,
      providerId: 'pi',
      provider: {
        resumeStrategy: 'sessionFileAbsolutePreferred',
        providerSessionId: 'pi-session-1',
        sessionFile: '/tmp/pi/sessions/pi-session-1.jsonl',
      },
    });
  });

  it('clears a stale session file when a new session id has no absolute session file', () => {
    const lastPublished = { value: null as PublishedPiSessionMetadata | null };
    let metadata = createMetadata({ flavor: 'pi' });

    maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => 'pi-session-1',
      getPiSessionFile: () => '/tmp/pi/sessions/pi-session-1.jsonl',
      updateHappySessionMetadata: (updater) => {
        metadata = updater(metadata);
      },
      lastPublished,
    });

    maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => 'pi-session-2',
      getPiSessionFile: () => null,
      updateHappySessionMetadata: (updater) => {
        metadata = updater(metadata);
      },
      lastPublished,
    });

    expect(lastPublished.value).toEqual({
      sessionId: 'pi-session-2',
      sessionFile: null,
    });
    expect(metadata.piSessionId).toBe('pi-session-2');
    expect(metadata).not.toHaveProperty('piSessionFile');
    expect(metadata.agentRuntimeDescriptorV1).toEqual({
      v: 1,
      providerId: 'pi',
      provider: {
        resumeStrategy: 'sessionFileAbsolutePreferred',
        providerSessionId: 'pi-session-2',
      },
    });
    expect(metadata.flavor).toBe('pi');
  });

  it('reverts lastPublished when the metadata update fails', async () => {
    const lastPublished = { value: null as PublishedPiSessionMetadata | null };
    let calls = 0;

    maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => 'pi-session-1',
      getPiSessionFile: () => null,
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
