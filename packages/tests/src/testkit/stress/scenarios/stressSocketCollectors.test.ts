import { describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    timeout: vi.fn(() => ({ emitWithAck: vi.fn() })),
    connect: vi.fn(),
    disconnect: vi.fn(),
    close: vi.fn(),
    connected: false,
  })),
}));

describe('stressSocketCollectors', () => {
  it('keeps transportOptions defined for polling collectors without sticky headers', async () => {
    const { io } = await import('socket.io-client');
    const { createStressUserScopedSocketCollector } = await import('./stressSocketCollectors');

    createStressUserScopedSocketCollector('http://127.0.0.1:43080', 'token', {
      transports: ['polling'],
    });

    expect(io).toHaveBeenCalledWith(
      'http://127.0.0.1:43080',
      expect.objectContaining({
        transports: ['polling'],
        transportOptions: {},
      }),
    );
  });
});
