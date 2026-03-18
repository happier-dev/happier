import { describe, expect, it, vi } from 'vitest';

import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { createFakeSocket, getSocketHandler } from '../testkit/socketHarness';

describe('machineTransferHandler', () => {
  it('forwards a machine transfer envelope to the target machine room for the same account', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const io = { to } as any;
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineTransferHandler('user-1', socket, { io });

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    await handler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
      },
    });

    expect(to).toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
      },
    });
  }, 15000);

  it('rejects invalid machine transfer payloads', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineTransferHandler('user-1', socket, { io: {} as any });

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    await handler({
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
      },
    });

    expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-transfer',
      error: 'Invalid machine transfer payload',
    });
  });

  it('rejects server-routed transfer when the server feature is disabled', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineTransferHandler('user-1', socket, {
      io: { to } as any,
      serverRoutedTransferEnabled: false,
    });

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    await handler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_2',
        kind: 'open',
        manifestHash: 'transfer_2',
      },
    });

    expect(to).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-transfer',
      error: 'Server-routed machine transfer is disabled on this server',
    });
  });

  it('rejects server-routed transfer envelopes that exceed the advertised max-bytes limit', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineTransferHandler('user-1', socket, {
      io: { to } as any,
      serverRoutedTransferMaxBytes: 32,
    } as any);

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    await handler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_oversized',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('this chunk is too large', 'utf8').toString('base64'),
      },
    });

    expect(to).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-transfer',
      error: 'Server-routed machine transfer exceeds the configured max-bytes limit',
    });
  });
});
