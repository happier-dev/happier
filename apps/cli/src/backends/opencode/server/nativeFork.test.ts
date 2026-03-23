import { describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

import { forkOpenCodeSessionNative } from './nativeFork';

function createCredentials(): Credentials {
  return {
    token: 'token-1',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
  } as any;
}

describe('forkOpenCodeSessionNative', () => {
  it('forks at latest without providing a messageID', async () => {
    const client = {
      sessionFork: vi.fn(async () => ({ id: 'ses_child' })),
      dispose: vi.fn(async () => {}),
    };

    const out = await forkOpenCodeSessionNative({
      credentials: createCredentials(),
      parentHappySessionId: 'sess_parent',
      parentRawSession: { encryptionMode: 'plain' } as any,
      directory: '/repo',
      parentOpenCodeSessionId: 'ses_parent_vendor',
      forkPoint: { type: 'latest' },
    }, {
      createClient: async () => client as any,
      fetchSingleHappyRow: async () => null,
    });

    expect(out).toEqual({ vendorSessionId: 'ses_child' });
    expect(client.sessionFork).toHaveBeenCalledWith({ sessionId: 'ses_parent_vendor' });
  });

  it('forks before a user message using deterministic msg_<localId> (exclusive cursor semantics)', async () => {
    const client = {
      sessionFork: vi.fn(async () => ({ id: 'ses_child' })),
      dispose: vi.fn(async () => {}),
    };

    const out = await forkOpenCodeSessionNative({
      credentials: createCredentials(),
      parentHappySessionId: 'sess_parent',
      parentRawSession: { encryptionMode: 'plain' } as any,
      directory: '/repo',
      parentOpenCodeSessionId: 'ses_parent_vendor',
      forkPoint: { type: 'seq', upToSeqInclusive: 10 },
    }, {
      createClient: async () => client as any,
      fetchSingleHappyRow: async () => ({
        seq: 10,
        createdAt: 1,
        localId: 'local-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
      }),
    });

    expect(out).toEqual({ vendorSessionId: 'ses_child', vendorMessageId: 'msg_local-1' });
    expect(client.sessionFork).toHaveBeenCalledWith({ sessionId: 'ses_parent_vendor', messageId: 'msg_local-1' });
  });

  it('forks after the first user message (inclusive) when upToSeqInclusive is 1', async () => {
    const client = {
      sessionFork: vi.fn(async () => ({ id: 'ses_child' })),
      sessionMessagesList: vi.fn(async () => ([
        { info: { id: 'msg_local-1' } },
        { info: { id: 'msg_next' } },
      ])),
      dispose: vi.fn(async () => {}),
    };

    const out = await forkOpenCodeSessionNative({
      credentials: createCredentials(),
      parentHappySessionId: 'sess_parent',
      parentRawSession: { encryptionMode: 'plain' } as any,
      directory: '/repo',
      parentOpenCodeSessionId: 'ses_parent_vendor',
      forkPoint: { type: 'seq', upToSeqInclusive: 1 },
    }, {
      createClient: async () => client as any,
      fetchSingleHappyRow: async () => ({
        seq: 1,
        createdAt: 1,
        localId: 'local-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
      }),
    });

    expect(out).toEqual({ vendorSessionId: 'ses_child', vendorMessageId: 'msg_next' });
    expect(client.sessionFork).toHaveBeenCalledWith({ sessionId: 'ses_parent_vendor', messageId: 'msg_next' });
  });

  it('derives msg_<localId> from decrypted meta when row.localId is missing (exclusive)', async () => {
    const client = {
      sessionFork: vi.fn(async () => ({ id: 'ses_child' })),
      dispose: vi.fn(async () => {}),
    };

    const out = await forkOpenCodeSessionNative({
      credentials: createCredentials(),
      parentHappySessionId: 'sess_parent',
      parentRawSession: { encryptionMode: 'plain' } as any,
      directory: '/repo',
      parentOpenCodeSessionId: 'ses_parent_vendor',
      forkPoint: { type: 'seq', upToSeqInclusive: 12 },
    }, {
      createClient: async () => client as any,
      fetchSingleHappyRow: async () => ({
        seq: 12,
        createdAt: 1,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' }, meta: { localId: 'local-2' } } },
      }),
    });

    expect(out).toEqual({ vendorSessionId: 'ses_child', vendorMessageId: 'msg_local-2' });
    expect(client.sessionFork).toHaveBeenCalledWith({ sessionId: 'ses_parent_vendor', messageId: 'msg_local-2' });
  });

  it('forks at an agent message using stored meta.opencodeMessageId', async () => {
    const client = {
      sessionFork: vi.fn(async () => ({ id: 'ses_child' })),
      sessionMessagesList: vi.fn(async () => ([
        { info: { id: 'msg_before_agent' } },
        { info: { id: 'msg_from_agent' } },
        { info: { id: 'msg_next' } },
      ])),
      dispose: vi.fn(async () => {}),
    };

    const out = await forkOpenCodeSessionNative({
      credentials: createCredentials(),
      parentHappySessionId: 'sess_parent',
      parentRawSession: { encryptionMode: 'plain' } as any,
      directory: '/repo',
      parentOpenCodeSessionId: 'ses_parent_vendor',
      forkPoint: { type: 'seq', upToSeqInclusive: 11 },
    }, {
      createClient: async () => client as any,
      fetchSingleHappyRow: async () => ({
        seq: 11,
        createdAt: 1,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'ok' }, meta: { opencodeMessageId: 'msg_from_agent' } } },
      }),
    });

    expect(out).toEqual({ vendorSessionId: 'ses_child', vendorMessageId: 'msg_next' });
    expect(client.sessionFork).toHaveBeenCalledWith({ sessionId: 'ses_parent_vendor', messageId: 'msg_next' });
  });

  it('omits messageID when the fork point is already at the latest vendor message', async () => {
    const client = {
      sessionFork: vi.fn(async () => ({ id: 'ses_child' })),
      sessionMessagesList: vi.fn(async () => ([
        { info: { id: 'msg_before' } },
        { info: { id: 'msg_latest' } },
      ])),
      dispose: vi.fn(async () => {}),
    };

    const out = await forkOpenCodeSessionNative({
      credentials: createCredentials(),
      parentHappySessionId: 'sess_parent',
      parentRawSession: { encryptionMode: 'plain' } as any,
      directory: '/repo',
      parentOpenCodeSessionId: 'ses_parent_vendor',
      forkPoint: { type: 'seq', upToSeqInclusive: 99 },
    }, {
      createClient: async () => client as any,
      fetchSingleHappyRow: async () => ({
        seq: 99,
        createdAt: 1,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'ok' }, meta: { opencodeMessageId: 'msg_latest' } } },
      }),
    });

    expect(out).toEqual({ vendorSessionId: 'ses_child' });
    expect(client.sessionFork).toHaveBeenCalledWith({ sessionId: 'ses_parent_vendor' });
  });

  it('resolves user message IDs from parent session metadata when available', async () => {
    const client = {
      sessionFork: vi.fn(async () => ({ id: 'ses_child' })),
      dispose: vi.fn(async () => {}),
    };

    const out = await forkOpenCodeSessionNative({
      credentials: createCredentials(),
      parentHappySessionId: 'sess_parent',
      parentRawSession: {
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          opencodeUserMessageIdMapV1: {
            v: 1,
            byLocalId: { 'local-1': 'msg_000000000000aaaaaaaaaaaaaa' },
          },
        }),
      } as any,
      directory: '/repo',
      parentOpenCodeSessionId: 'ses_parent_vendor',
      forkPoint: { type: 'seq', upToSeqInclusive: 10 },
    }, {
      createClient: async () => client as any,
      fetchSingleHappyRow: async () => ({
        seq: 10,
        createdAt: 1,
        localId: 'local-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
      }),
    });

    expect(out).toEqual({ vendorSessionId: 'ses_child', vendorMessageId: 'msg_000000000000aaaaaaaaaaaaaa' });
    expect(client.sessionFork).toHaveBeenCalledWith({ sessionId: 'ses_parent_vendor', messageId: 'msg_000000000000aaaaaaaaaaaaaa' });
  });

  it('falls back to OpenCode message history lookup when msg_<localId> does not exist (legacy sessions)', async () => {
    const client = {
      sessionFork: vi.fn()
        .mockRejectedValueOnce(new Error('unknown message id'))
        .mockResolvedValueOnce({ id: 'ses_child' }),
      sessionMessagesList: vi.fn(async () => ([
        { info: { id: 'msg_a', role: 'user', time: { created: 1000 } }, parts: [{ type: 'text', text: 'older' }] },
        { info: { id: 'msg_real', role: 'user', time: { created: 2000 } }, parts: [{ type: 'text', text: 'hi' }] },
        { info: { id: 'msg_b', role: 'assistant', time: { created: 3000 } }, parts: [{ type: 'text', text: 'ok' }] },
      ])),
      dispose: vi.fn(async () => {}),
    };

    const out = await forkOpenCodeSessionNative({
      credentials: createCredentials(),
      parentHappySessionId: 'sess_parent',
      parentRawSession: { encryptionMode: 'plain' } as any,
      directory: '/repo',
      parentOpenCodeSessionId: 'ses_parent_vendor',
      forkPoint: { type: 'seq', upToSeqInclusive: 10 },
    }, {
      createClient: async () => client as any,
      fetchSingleHappyRow: async () => ({
        seq: 10,
        createdAt: 2000,
        localId: 'local-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
      }),
    });

    expect(out).toEqual({ vendorSessionId: 'ses_child', vendorMessageId: 'msg_real' });
    expect(client.sessionFork).toHaveBeenNthCalledWith(1, { sessionId: 'ses_parent_vendor', messageId: 'msg_local-1' });
    expect(client.sessionFork).toHaveBeenNthCalledWith(2, { sessionId: 'ses_parent_vendor', messageId: 'msg_real' });
  });

  it('preserves first-user inclusive fork semantics when fallback rematches the vendor user message', async () => {
    const client = {
      sessionFork: vi.fn()
        .mockRejectedValueOnce(new Error('stale cursor'))
        .mockResolvedValueOnce({ id: 'ses_child' }),
      sessionMessagesList: vi.fn(async () => ([
        { info: { id: 'msg_local-1', role: 'user', time: { created: 1000 } }, parts: [{ type: 'text', text: 'old hi' }] },
        { info: { id: 'msg_real', role: 'user', time: { created: 2000 } }, parts: [{ type: 'text', text: 'hi' }] },
        { info: { id: 'msg_after_real', role: 'assistant', time: { created: 3000 } }, parts: [{ type: 'text', text: 'ok' }] },
      ])),
      dispose: vi.fn(async () => {}),
    };

    const out = await forkOpenCodeSessionNative({
      credentials: createCredentials(),
      parentHappySessionId: 'sess_parent',
      parentRawSession: { encryptionMode: 'plain' } as any,
      directory: '/repo',
      parentOpenCodeSessionId: 'ses_parent_vendor',
      forkPoint: { type: 'seq', upToSeqInclusive: 1 },
    }, {
      createClient: async () => client as any,
      fetchSingleHappyRow: async () => ({
        seq: 1,
        createdAt: 2000,
        localId: 'local-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
      }),
    });

    expect(out).toEqual({ vendorSessionId: 'ses_child', vendorMessageId: 'msg_after_real' });
    expect(client.sessionFork).toHaveBeenNthCalledWith(1, { sessionId: 'ses_parent_vendor', messageId: 'msg_real' });
    expect(client.sessionFork).toHaveBeenNthCalledWith(2, { sessionId: 'ses_parent_vendor', messageId: 'msg_after_real' });
  });
});
