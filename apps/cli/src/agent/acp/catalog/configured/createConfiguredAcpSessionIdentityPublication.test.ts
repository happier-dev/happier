import { describe, expect, it } from 'vitest';

import { createConfiguredAcpSessionIdentityPublication } from './createConfiguredAcpSessionIdentityPublication';

function createFakeSession(initial: Record<string, unknown> = {}) {
  let metadata: Record<string, unknown> = { ...initial };
  const updateCalls: Array<Record<string, unknown>> = [];
  return {
    session: {
      sessionId: 'happier-session-1',
      getMetadataSnapshot: () => metadata as never,
      updateMetadata: (updater: (value: Record<string, unknown>) => Record<string, unknown>) => {
        metadata = updater(metadata);
        updateCalls.push(metadata);
      },
    },
    getMetadata: () => metadata,
    updateCalls,
  };
}

describe('createConfiguredAcpSessionIdentityPublication', () => {
  it('publishes the bound ACP session id to customAcpSessionId metadata when the adapter supports session load', async () => {
    const fake = createFakeSession();
    const publication = createConfiguredAcpSessionIdentityPublication({
      session: fake.session as never,
      isSessionLoadSupported: () => true,
    });

    expect(publication.kind).toBe('persist-bound');
    if (publication.kind !== 'persist-bound') throw new Error('expected persist-bound');
    await publication.persistBound({ generation: 0, operation: 'create', vendorSessionId: 'acp-session-1' });

    expect(fake.getMetadata().customAcpSessionId).toBe('acp-session-1');
  });

  it('publishes nothing when the adapter does not support session load', async () => {
    const fake = createFakeSession();
    const publication = createConfiguredAcpSessionIdentityPublication({
      session: fake.session as never,
      isSessionLoadSupported: () => false,
    });

    if (publication.kind !== 'persist-bound') throw new Error('expected persist-bound');
    await publication.persistBound({ generation: 0, operation: 'create', vendorSessionId: 'acp-session-1' });

    expect(fake.updateCalls).toHaveLength(0);
    expect(fake.getMetadata().customAcpSessionId).toBeUndefined();
  });

  it('re-evaluates adapter support on every publication so capability is read after initialize', async () => {
    const fake = createFakeSession();
    let supported = false;
    const publication = createConfiguredAcpSessionIdentityPublication({
      session: fake.session as never,
      isSessionLoadSupported: () => supported,
    });

    if (publication.kind !== 'persist-bound') throw new Error('expected persist-bound');
    await publication.persistBound({ generation: 0, operation: 'create', vendorSessionId: 'acp-session-1' });
    expect(fake.getMetadata().customAcpSessionId).toBeUndefined();

    supported = true;
    await publication.persistBound({ generation: 1, operation: 'create', vendorSessionId: 'acp-session-2' });
    expect(fake.getMetadata().customAcpSessionId).toBe('acp-session-2');
  });
});
