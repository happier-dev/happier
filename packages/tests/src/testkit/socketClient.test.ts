import { beforeEach, describe, expect, it, vi } from 'vitest';

const ioMock = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({
  io: (...args: unknown[]) => ioMock(...args),
}));

import {
  createMachineScopedSocketCollector,
  createSessionScopedSocketCollector,
  createUserScopedSocketCollector,
} from './socketClient';

describe('socketClient collector construction', () => {
  beforeEach(() => {
    ioMock.mockReset();
    ioMock.mockReturnValue({
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      timeout: vi.fn(() => ({ emitWithAck: vi.fn() })),
    });
  });

  it('passes an explicit connect timeout through to user-scoped collectors', () => {
    createUserScopedSocketCollector('http://127.0.0.1:3000', 'token-1', {
      transports: ['websocket'],
      connectTimeoutMs: 65_000,
    });

    expect(ioMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000',
      expect.objectContaining({
        timeout: 65_000,
      }),
    );
  });

  it('passes an explicit connect timeout through to session-scoped collectors', () => {
    createSessionScopedSocketCollector('http://127.0.0.1:3000', 'token-1', 'session-1', 'machine-1', {
      transports: ['websocket'],
      connectTimeoutMs: 65_000,
    });

    expect(ioMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000',
      expect.objectContaining({
        timeout: 65_000,
      }),
    );
  });

  it('constructs machine-scoped collectors with exact machine identity', () => {
    createMachineScopedSocketCollector('http://127.0.0.1:3000', 'token-1', 'machine-1', {
      transports: ['websocket'],
      connectTimeoutMs: 65_000,
    });

    expect(ioMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000',
      expect.objectContaining({
        auth: {
          token: 'token-1',
          clientType: 'machine-scoped',
          machineId: 'machine-1',
        },
        timeout: 65_000,
      }),
    );
  });
});
