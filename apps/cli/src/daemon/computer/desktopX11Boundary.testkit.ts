import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

// The X server socket is an OS transport boundary. Answer authenticated setup
// and the GetInputFocus reply that acknowledges the real desktop ChangeHosts.
vi.mock('node:net', async importOriginal => ({
  ...(await importOriginal<typeof import('node:net')>()),
  createConnection: () => {
    const socket = Object.assign(new EventEmitter(), {
      write: () => {
        setImmediate(() => socket.emit('data', Buffer.concat([
          Buffer.from([1, 0, 11, 0, 0, 0, 0, 0]), Buffer.from([1, ...new Array(31).fill(0)]),
        ])));
        return true;
      },
      destroy: () => undefined,
    });
    return socket;
  },
}));
