import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';

import { publishSessionRuntimeDescriptor } from './runtimeDescriptor';

describe('publishSessionRuntimeDescriptor', () => {
  it('skips publication when the next fingerprint normalizes to the last published fingerprint', async () => {
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
      fingerprint: ' fingerprint-1 ',
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
      runtimeDescriptor: null,
      buildMetadata: (metadata) => metadata,
    });

    expect(updateHappySessionMetadata).not.toHaveBeenCalled();
    expect(lastPublished).toEqual({
      sessionId: 'session-1',
      fingerprint: 'fingerprint-1',
    });
  });

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
      runtimeDescriptor: null,
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
      runtimeDescriptor: null,
      buildMetadata: (metadata) => metadata,
    });

    expect(updateHappySessionMetadata).toHaveBeenCalledTimes(1);
    expect(lastPublished).toEqual({
      sessionId: 'session-1',
      fingerprint: 'fingerprint-1',
    });
  });

  it('preserves the last fingerprint when only the session id publication fails', async () => {
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
      runtimeDescriptor: null,
      buildMetadata: (metadata) => metadata,
    });

    expect(updateHappySessionMetadata).toHaveBeenCalledTimes(1);
    expect(lastPublished).toEqual({
      sessionId: 'session-1',
      fingerprint: 'fingerprint-1',
    });
  });

  it('writes runtimeDescriptorV1 without adding the legacy agentRuntimeDescriptorV1 alias', async () => {
    const metadataUpdates: Metadata[] = [];
    const baseMetadata: Metadata = {
      path: '/workspace',
      host: 'test-host',
      homeDir: '/home/test',
      happyHomeDir: '/home/test/.happier',
      happyLibDir: '/home/test/.happier/lib',
      happyToolsDir: '/home/test/.happier/tools',
    };
    const lastPublished: {
      sessionId: string | null;
      fingerprint: string | null;
    } = {
      sessionId: null,
      fingerprint: null,
    };
    const runtimeDescriptor = {
      v: 1,
      providerId: 'opencode',
      provider: {
        backendMode: 'server',
        providerSessionId: 'opencode-session-1',
      },
    } as const;

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
      updateHappySessionMetadata: async (updater) => {
        metadataUpdates.push(updater(baseMetadata));
      },
      runtimeDescriptor,
      buildMetadata: (metadata) => metadata,
    });

    expect(metadataUpdates).toHaveLength(1);
    expect(metadataUpdates[0]?.runtimeDescriptorV1).toEqual(runtimeDescriptor);
    expect(metadataUpdates[0]).not.toHaveProperty('agentRuntimeDescriptorV1');
  });
});
