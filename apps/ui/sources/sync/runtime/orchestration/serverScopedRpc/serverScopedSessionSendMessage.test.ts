import { describe, expect, it, vi } from 'vitest';

import { createNotAuthenticatedError } from '@/sync/runtime/connectivity/authErrors';

vi.mock('@/agents/catalog/catalog', () => ({
  getAgentCore: () => ({ model: { defaultMode: 'default', supportsSelection: false } }),
  resolveAgentIdFromFlavor: () => 'codex',
}));

const state = {
  sessions: {
    s1: { id: 's1', permissionMode: 'default', metadata: { flavor: 'claude' }, modelMode: 'default' },
  },
  settings: {},
};

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: () => state,
  },
});
});

describe('sendSessionMessageWithServerScope', () => {
  it('uses scoped socket path when context is scoped and preserves displayText plus metadata overrides', async () => {
    state.sessions.s1 = { id: 's1', permissionMode: 'default', metadata: { flavor: 'claude' }, modelMode: 'default' };

    const { createServerScopedSessionSendMessage } = await import('./serverScopedSessionSendMessage');

    const emitWithAck = vi.fn(async (_event: string, _payload: unknown) => ({ ok: true, id: 'm1', seq: 1, localId: null }));
    const socket = {
      timeout: (_ms: number) => ({ emitWithAck }),
      disconnect: vi.fn(),
    };

    const sendMessageActive = vi.fn(async () => {});
    const encryptRawRecord = vi.fn(async () => 'encrypted_record');
    const getScopedSessionEncryption = vi.fn(async () => ({
      encryptRawRecord,
    }));

    const resolveContext = vi.fn(async () => ({
      scope: 'scoped' as const,
      timeoutMs: 1000,
      targetServerId: 'server-b',
      targetServerUrl: 'https://server-b.example',
      token: 't1',
      encryption: {} as any,
    }));

    const createSocket = vi.fn(async () => socket as any);

    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      resolveContext: resolveContext as any,
      createSocket,
      getScopedSessionEncryption,
      sendMessageActive,
    });

    const sendScopedMessage = sendSessionMessageWithServerScope as (args: Readonly<{
      sessionId: string;
      message: string;
      serverId?: string | null;
      timeoutMs?: number;
      displayText?: string | null;
      metaOverrides?: Record<string, unknown> | null;
      profileId?: string | null;
    }>) => Promise<Awaited<ReturnType<typeof sendSessionMessageWithServerScope>>>;

    const res = await sendScopedMessage({
      sessionId: 's1',
      message: 'hello',
      serverId: 'server-b',
      timeoutMs: 1000,
      displayText: 'hello display',
      metaOverrides: {
        happier: {
          kind: 'attachments.v1',
        },
      },
      profileId: 'profile-work',
    });
    expect(res.ok).toBe(true);
    expect(sendMessageActive).not.toHaveBeenCalled();
    expect(createSocket).toHaveBeenCalled();
    expect(getScopedSessionEncryption).toHaveBeenCalled();
    expect(getScopedSessionEncryption).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
    expect(encryptRawRecord).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({
        displayText: 'hello display',
        profileId: 'profile-work',
        happier: {
          kind: 'attachments.v1',
        },
      }),
    }));
    expect(emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        sid: 's1',
        message: 'encrypted_record',
        messageRole: 'user',
      }),
    );
  });

  it('uses message metadata for active-scope displayText and metadata forwarding too', async () => {
    state.sessions.s1 = { id: 's1', permissionMode: 'default', metadata: { flavor: 'claude' }, modelMode: 'default' } as any;

    const { createServerScopedSessionSendMessage } = await import('./serverScopedSessionSendMessage');

    const sendMessageActive = vi.fn(async () => {});
    const resolveContext = vi.fn(async () => ({
      scope: 'active' as const,
      timeoutMs: 1000,
    }));

    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      resolveContext: resolveContext as any,
      sendMessageActive,
    });

    const res = await sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'hello',
      displayText: 'hello display',
      metaOverrides: {
        happier: {
          kind: 'attachments.v1',
        },
      },
      profileId: 'profile-work',
    });

    expect(res.ok).toBe(true);
    expect(sendMessageActive).toHaveBeenCalledWith('s1', 'hello', 'hello display', {
      happier: {
        kind: 'attachments.v1',
      },
      profileId: 'profile-work',
    }, {
      profileId: 'profile-work',
      localId: null,
      bypassPendingQueueReason: 'server_scoped_rpc',
    });
  });

  it('sends plaintext envelopes for scoped sessions when session encryptionMode is plain', async () => {
    state.sessions.s1 = {
      id: 's1',
      encryptionMode: 'plain',
      permissionMode: 'default',
      metadata: { flavor: 'claude' },
      modelMode: 'default',
    } as any;

    const { createServerScopedSessionSendMessage } = await import('./serverScopedSessionSendMessage');

    const emitWithAck = vi.fn(async (_event: string, _payload: unknown) => ({ ok: true, id: 'm1', seq: 1, localId: null }));
    const socket = {
      timeout: (_ms: number) => ({ emitWithAck }),
      disconnect: vi.fn(),
    };

    const sendMessageActive = vi.fn(async () => {});
    const getScopedSessionEncryption = vi.fn(async () => ({
      encryptRawRecord: async () => 'encrypted_record',
    }));

    const resolveContext = vi.fn(async () => ({
      scope: 'scoped' as const,
      timeoutMs: 1000,
      targetServerId: 'server-b',
      targetServerUrl: 'https://server-b.example',
      token: 't1',
      encryption: {} as any,
    }));

    const createSocket = vi.fn(async () => socket as any);

    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      resolveContext: resolveContext as any,
      createSocket,
      getScopedSessionEncryption,
      sendMessageActive,
    });

    const res = await sendSessionMessageWithServerScope({ sessionId: 's1', message: 'hello', serverId: 'server-b', timeoutMs: 1000 });
    expect(res.ok).toBe(true);
    expect(getScopedSessionEncryption).not.toHaveBeenCalled();
    expect(emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        sid: 's1',
        message: expect.objectContaining({ t: 'plain', v: expect.any(Object) }),
        messageRole: 'user',
      }),
    );
  });

  it('treats a missing ack as unknown outcome and reuses the same localId for the fire-and-forget fallback', async () => {
    state.sessions.s1 = { id: 's1', permissionMode: 'default', metadata: { flavor: 'claude' }, modelMode: 'default' } as any;

    const { createServerScopedSessionSendMessage } = await import('./serverScopedSessionSendMessage');

    const emitWithAck = vi.fn(async (_event: string, _payload: unknown) => {
      throw new Error('ack timeout');
    });
    const emit = vi.fn();
    const socket = {
      timeout: (_ms: number) => ({ emitWithAck }),
      emit,
      disconnect: vi.fn(),
    };

    const resolveContext = vi.fn(async () => ({
      scope: 'scoped' as const,
      timeoutMs: 1000,
      targetServerId: 'server-b',
      targetServerUrl: 'https://server-b.example',
      token: 't1',
      encryption: {} as any,
    }));

    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      resolveContext: resolveContext as any,
      createSocket: vi.fn(async () => socket as any),
      getScopedSessionEncryption: vi.fn(async () => ({
        encryptRawRecord: async () => 'encrypted_record',
      })),
    });

    const res = await sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'hello',
      serverId: 'server-b',
      timeoutMs: 1000,
    });

    expect(res.ok).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    const ackPayload = emitWithAck.mock.calls[0]?.[1] as { localId?: string; messageRole?: string } | undefined;
    expect(emit).toHaveBeenCalledWith('message', ackPayload);
    expect(typeof ackPayload?.localId).toBe('string');
    expect(ackPayload?.messageRole).toBe('user');
  });

  it('checks scoped auth before fallback and preserves terminal auth', async () => {
    state.sessions.s1 = { id: 's1', permissionMode: 'default', metadata: { flavor: 'claude' }, modelMode: 'default' };

    const { createServerScopedSessionSendMessage } = await import('./serverScopedSessionSendMessage');

    const emitWithAck = vi.fn(async () => {
      throw new Error('ack timeout');
    });
    const emit = vi.fn();
    const socket = {
      timeout: (_ms: number) => ({ emitWithAck }),
      emit,
      disconnect: vi.fn(),
    };
    const assertScopedEndpointAuthenticated = vi.fn(() => {
      throw createNotAuthenticatedError();
    });

    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      resolveContext: vi.fn(async () => ({
        scope: 'scoped' as const,
        timeoutMs: 1000,
        targetServerId: 'server-b',
        targetServerUrl: 'https://server-b.example',
        token: 't1',
        encryption: {
          decryptEncryptionKey: async () => null,
          initializeSessions: async () => {},
          getSessionEncryption: () => null,
        },
      })),
      createSocket: vi.fn(async () => socket),
      getScopedSessionEncryption: vi.fn(async () => ({
        encryptRawRecord: async () => 'encrypted_record',
      })),
      assertScopedEndpointAuthenticated,
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'hello',
      serverId: 'server-b',
      timeoutMs: 1000,
    })).rejects.toMatchObject({
      name: 'HappyError',
      kind: 'auth',
      code: 'not_authenticated',
    });

    expect(assertScopedEndpointAuthenticated).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('forces scoped auth convergence before treating a timeout as ack_unknown', async () => {
    state.sessions.s1 = { id: 's1', permissionMode: 'default', metadata: { flavor: 'claude' }, modelMode: 'default' } as any;

    const { createServerScopedSessionSendMessage } = await import('./serverScopedSessionSendMessage');

    const emitWithAck = vi.fn(async () => {
      throw new Error('ack timeout');
    });
    const emit = vi.fn();
    const socket = {
      timeout: (_ms: number) => ({ emitWithAck }),
      emit,
      disconnect: vi.fn(),
    };
    const assertScopedEndpointAuthenticated = vi.fn((_context, options?: { forceProbe?: boolean }) => {
      if (options?.forceProbe === true) {
        throw createNotAuthenticatedError();
      }
    });

    const { sendSessionMessageWithServerScope } = createServerScopedSessionSendMessage({
      resolveContext: vi.fn(async () => ({
        scope: 'scoped' as const,
        timeoutMs: 1000,
        targetServerId: 'server-b',
        targetServerUrl: 'https://server-b.example',
        token: 't1',
        encryption: {} as any,
      })) as any,
      createSocket: vi.fn(async () => socket as any),
      getScopedSessionEncryption: vi.fn(async () => ({
        encryptRawRecord: async () => 'encrypted_record',
      })),
      assertScopedEndpointAuthenticated: assertScopedEndpointAuthenticated as any,
    });

    await expect(sendSessionMessageWithServerScope({
      sessionId: 's1',
      message: 'hello',
      serverId: 'server-b',
      timeoutMs: 1000,
    })).rejects.toMatchObject({
      name: 'HappyError',
      kind: 'auth',
      code: 'not_authenticated',
    });

    expect(assertScopedEndpointAuthenticated).toHaveBeenCalledTimes(2);
    expect(assertScopedEndpointAuthenticated).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ targetServerId: 'server-b' }),
    );
    expect(assertScopedEndpointAuthenticated).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ targetServerId: 'server-b' }),
      { forceProbe: true },
    );
    expect(emit).not.toHaveBeenCalled();
  });
});
