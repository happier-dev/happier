import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { attachSocketEventCollector } from './socketEventCollector';

class FakeSocket extends EventEmitter {}

describe('socketEventCollector', () => {
  it('captures connect, update, ephemeral, and disconnect events', () => {
    const socket = new FakeSocket();
    const collector = attachSocketEventCollector(socket);

    socket.emit('connect');
    socket.emit('update', { body: { t: 'new-message' }, seq: 1 });
    socket.emit('ephemeral', { type: 'usage' });
    socket.emit('disconnect', 'transport close');

    expect(collector.getEvents().map((event) => event.kind)).toEqual([
      'connect',
      'update',
      'ephemeral',
      'disconnect',
    ]);
  });

  it('normalizes connect errors into captured messages', () => {
    const socket = new FakeSocket();
    const collector = attachSocketEventCollector(socket);

    socket.emit('connect_error', new Error('boom'));

    expect(collector.getEvents()).toEqual([
      expect.objectContaining({
        kind: 'connect_error',
        message: 'boom',
      }),
    ]);
  });
});
