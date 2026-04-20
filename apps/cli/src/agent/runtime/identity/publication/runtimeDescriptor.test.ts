import { describe, expect, it, vi } from 'vitest';

import { publishSessionRuntimeDescriptor } from './runtimeDescriptor';

describe('publishSessionRuntimeDescriptor', () => {
  it('skips duplicate publishes when the session id and fingerprint are unchanged', async () => {
    const updateHappySessionMetadata = vi.fn(async () => undefined);
    const lastPublished: {
      sessionId: string | null;
      fingerprint: string | null;
    } = {
      sessionId: 'session-1',
      fingerprint: 'fingerprint-1',
    };

    await publishSessionRuntimeDescriptor({
      sessionId: 'session-1',
      fingerprint: 'fingerprint-1',
      publicationState: {
        getSessionId: () => lastPublished.sessionId,
        getFingerprint: () => lastPublished.fingerprint,
        setSessionId: (sessionId) => {
          lastPublished.sessionId = sessionId;
        },
        setFingerprint: (fingerprint) => {
          lastPublished.fingerprint = fingerprint;
        },
      },
      updateHappySessionMetadata,
      buildMetadata: (metadata) => metadata,
    });

    expect(updateHappySessionMetadata).not.toHaveBeenCalled();
    expect(lastPublished).toEqual({
      sessionId: 'session-1',
      fingerprint: 'fingerprint-1',
    });
  });

  it('reverts the last published signature when metadata publication fails', async () => {
    const updateHappySessionMetadata = vi.fn(async () => {
      throw new Error('boom');
    });
    const lastPublished: {
      sessionId: string | null;
      fingerprint: string | null;
    } = {
      sessionId: 'session-1',
      fingerprint: 'fingerprint-1',
    };

    await publishSessionRuntimeDescriptor({
      sessionId: 'session-2',
      fingerprint: 'fingerprint-2',
      publicationState: {
        getSessionId: () => lastPublished.sessionId,
        getFingerprint: () => lastPublished.fingerprint,
        setSessionId: (sessionId) => {
          lastPublished.sessionId = sessionId;
        },
        setFingerprint: (fingerprint) => {
          lastPublished.fingerprint = fingerprint;
        },
      },
      updateHappySessionMetadata,
      buildMetadata: (metadata) => metadata,
    });

    expect(updateHappySessionMetadata).toHaveBeenCalledTimes(1);
    expect(lastPublished).toEqual({
      sessionId: 'session-1',
      fingerprint: 'fingerprint-1',
    });
  });
});
