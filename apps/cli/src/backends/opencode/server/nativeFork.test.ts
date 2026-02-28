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

  it('forks at a user message using deterministic msg_<localId>', async () => {
    const client = {
      sessionFork: vi.fn(async () => ({ id: 'ses_child' })),
      sessionMessagesList: vi.fn(async () => ([
        { info: { id: 'msg_local-1' } },
        { info: { id: 'msg_asst_1' } },
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
        createdAt: 1,
        localId: 'local-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
      }),
    });

    expect(out).toEqual({ vendorSessionId: 'ses_child', vendorMessageId: 'msg_asst_1' });
    expect(client.sessionFork).toHaveBeenCalledWith({ sessionId: 'ses_parent_vendor', messageId: 'msg_asst_1' });
  });

  it('derives msg_<localId> from decrypted meta when row.localId is missing', async () => {
    const client = {
      sessionFork: vi.fn(async () => ({ id: 'ses_child' })),
      sessionMessagesList: vi.fn(async () => ([
        { info: { id: 'msg_local-2' } },
        { info: { id: 'msg_asst_2' } },
      ])),
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

    expect(out).toEqual({ vendorSessionId: 'ses_child', vendorMessageId: 'msg_asst_2' });
    expect(client.sessionFork).toHaveBeenCalledWith({ sessionId: 'ses_parent_vendor', messageId: 'msg_asst_2' });
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
      sessionMessagesList: vi.fn(async () => ([
        { info: { id: 'msg_000000000000aaaaaaaaaaaaaa' } },
        { info: { id: 'msg_000000000001bbbbbbbbbbbbbb' } },
      ])),
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

    expect(out).toEqual({ vendorSessionId: 'ses_child', vendorMessageId: 'msg_000000000001bbbbbbbbbbbbbb' });
    expect(client.sessionFork).toHaveBeenCalledWith({ sessionId: 'ses_parent_vendor', messageId: 'msg_000000000001bbbbbbbbbbbbbb' });
  });
});
