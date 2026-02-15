import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: () => ({
      sessions: { s1: { id: 's1', permissionMode: 'default', metadata: { flavor: 'claude' }, modelMode: 'default' } },
      settings: {},
    }),
  },
}));

describe('sendSessionMessageWithServerScope', () => {
  it('uses scoped socket path when context is scoped', async () => {
    const { createServerScopedSessionSendMessage } = await import('./serverScopedSessionSendMessage');

    const emitWithAck = vi.fn(async () => ({ ok: true, id: 'm1', seq: 1, localId: null }));
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
    expect(sendMessageActive).not.toHaveBeenCalled();
    expect(createSocket).toHaveBeenCalled();
    expect(getScopedSessionEncryption).toHaveBeenCalled();
    expect(emitWithAck).toHaveBeenCalledWith('message', expect.objectContaining({ sid: 's1', message: 'encrypted_record' }));
  });
});
