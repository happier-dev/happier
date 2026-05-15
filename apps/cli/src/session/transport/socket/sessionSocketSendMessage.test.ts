import { afterEach, describe, expect, it, vi } from 'vitest';

describe('sendSessionMessageViaSocketCommitted', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('includes message role in committed socket message payloads', async () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const socket = {
      connected: true,
      connect: vi.fn(),
      disconnect: vi.fn(),
      close: vi.fn(),
      emit: vi.fn((event: string, payload: unknown, callback: (answer: unknown) => void) => {
        emitted.push({ event, payload });
        callback({ ok: true, id: 'msg-1', seq: 1, localId: 'local-1' });
      }),
    };

    vi.doMock('@/api/session/sockets', () => ({
      createSessionScopedSocket: () => socket,
    }));
    vi.doMock('./waitForSocketConnect', () => ({
      waitForSocketConnect: vi.fn().mockResolvedValue(undefined),
    }));

    const { sendSessionMessageViaSocketCommitted } = await import('./sessionSocketSendMessage');

    await sendSessionMessageViaSocketCommitted({
      token: 'token-1',
      sessionId: 'session-1',
      localId: 'local-1',
      messageRole: 'user',
      content: {
        t: 'plain',
        v: { role: 'user', content: { type: 'text', text: 'hello' } },
      },
    });

    expect(emitted).toEqual([
      {
        event: 'message',
        payload: expect.objectContaining({
          sid: 'session-1',
          localId: 'local-1',
          messageRole: 'user',
        }),
      },
    ]);
  });
});
