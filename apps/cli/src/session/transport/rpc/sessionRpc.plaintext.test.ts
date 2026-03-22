import { describe, expect, it, vi } from 'vitest';

class FakeSocket {
  private handlers = new Map<string, Array<(...args: any[]) => void>>();
  public emitted: Array<{ event: string; data: any }> = [];

  on(event: string, handler: (...args: any[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  connect() {
    for (const handler of this.handlers.get('connect') ?? []) {
      handler();
    }
    return this;
  }

  emit(event: string, data: any, callback: (payload: any) => void) {
    this.emitted.push({ event, data });
    callback({ ok: true, result: { echoed: data.params } });
    return this;
  }

  disconnect() {}
  close() {}
}

vi.mock('@/api/session/sockets', () => ({
  createSessionScopedSocket: vi.fn(() => new FakeSocket()),
}));

describe('callSessionRpc (plaintext sessions)', () => {
  it('sends plaintext params and returns plaintext results when mode=plain', async () => {
    const { callSessionRpc } = await import('./sessionRpc');
    const req = { a: 1 };
    const res = await callSessionRpc({
      token: 't',
      sessionId: 'sess_1',
      mode: 'plain',
      method: 'sess_1:demo.method',
      request: req,
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
    });

    expect(res).toEqual({ echoed: req });
  });
});

