import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { SocketCollector } from '../../src/testkit/socketClient';

class FakeSocket extends EventEmitter {
  connected = true;

  connect(): void {}
  disconnect(): void {}
  close(): void {}
  timeout(): { emitWithAck: () => Promise<unknown> } {
    return { emitWithAck: async () => ({ ok: true }) };
  }
}

describe('testkit: SocketCollector.rpcRegister', () => {
  it('ignores rpc errors for other methods while waiting for target registration', async () => {
    const socket = new FakeSocket();
    const collector = new SocketCollector(socket as any);

    const registerPromise = collector.rpcRegister('session-a:permission');

    socket.emit(SOCKET_RPC_EVENTS.ERROR as any, { method: 'session-b:permission', error: 'other-method-error' });
    socket.emit(SOCKET_RPC_EVENTS.REGISTERED as any, { method: 'session-a:permission' });

    await expect(registerPromise).resolves.toBeUndefined();
  });
});
