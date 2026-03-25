import { afterEach, describe, expect, it, vi } from 'vitest';

import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { createFakeSocket, getSocketHandler } from '../testkit/socketHarness';

describe('machineTransferHandler', () => {
  afterEach(() => {
    vi.resetModules();
  });

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
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' }) as any;
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
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });

    expect(to).toHaveBeenCalledWith('machine:machine-source:user-1');
    expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: 'machine-target',
      targetMachineId: 'machine-source',
      envelope: {
        transferId: 'transfer_2',
        kind: 'abort',
        reason: 'Server-routed machine transfer is disabled on this server',
      },
    });
    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-transfer',
      error: 'Server-routed machine transfer is disabled on this server',
    });
  });

  it('does not reject open control envelopes when the advertised max-bytes policy is lower than the encoded envelope overhead', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineTransferHandler('user-1', socket, {
      io: { to } as any,
      serverRoutedTransferMaxBytes: 8,
    } as any);

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    await handler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_control',
        kind: 'open',
        manifestHash: 'transfer_control',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });

    expect(to).toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_control',
        kind: 'open',
        manifestHash: 'transfer_control',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });
    expect(socketEmit).not.toHaveBeenCalled();
  });

  it('rejects oversized server-routed chunk envelopes with a synthetic abort for the waiting target machine', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineTransferHandler('user-1', socket, {
      io: { to } as any,
      serverRoutedTransferMaxBytes: 8,
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

    expect(to).toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_oversized',
        kind: 'abort',
        reason: 'Server-routed machine transfer exceeds the configured max-bytes limit',
      },
    });
    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-transfer',
      error: 'Server-routed machine transfer exceeds the configured max-bytes limit',
    });
  });

  it('rejects server-routed transfers whose cumulative chunk payload bytes exceed the configured max-bytes limit', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineTransferHandler('user-1', socket, {
      io: { to } as any,
      serverRoutedTransferMaxBytes: 8,
    } as any);

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);

    await handler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_total',
        kind: 'open',
        manifestHash: 'transfer_total',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });

    await handler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_total',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('hello', 'utf8').toString('base64'), // 5 bytes
      },
    });

    await handler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_total',
        kind: 'chunk',
        sequence: 2,
        payloadBase64: Buffer.from('hello', 'utf8').toString('base64'), // 5 bytes (total 10 > 8)
      },
    });

    expect(to).toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_total',
        kind: 'abort',
        reason: 'Server-routed machine transfer exceeds the configured max-bytes limit',
      },
    });
    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-transfer',
      error: 'Server-routed machine transfer exceeds the configured max-bytes limit',
    });
  });

  it('rejects oversized server-routed chunk envelopes when encryptedDataKeyEnvelopeBase64 exceeds the configured max-bytes limit', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineTransferHandler('user-1', socket, {
      io: { to } as any,
      serverRoutedTransferMaxBytes: 8,
    } as any);

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    await handler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_oversized_key_envelope',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
        encryptedDataKeyEnvelopeBase64: Buffer.from('0123456789', 'utf8').toString('base64'),
      },
    });

    expect(to).toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_oversized_key_envelope',
        kind: 'abort',
        reason: 'Server-routed machine transfer exceeds the configured max-bytes limit',
      },
    });
    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-transfer',
      error: 'Server-routed machine transfer exceeds the configured max-bytes limit',
    });
  });

  it('rejects new server-routed chunk envelopes when the active transfer-id budget per socket is exceeded', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineTransferHandler('user-1', socket, {
      io: { to } as any,
      serverRoutedTransferMaxActiveTransfersPerSocket: 1,
    } as any);

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);

    await handler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
      },
    });

    await handler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_2',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
      },
    });

    expect(to).toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_2',
        kind: 'abort',
        reason: expect.stringContaining('active-transfer'),
      },
    });
    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-transfer',
      error: expect.stringContaining('active-transfer'),
    });
  });

  it('rejects cumulative max-bytes across multiple sockets (cannot bypass server max-bytes by splitting chunks)', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));

    const socketEmitA = vi.fn();
    const socketA = createFakeSocket({ emit: socketEmitA, id: 'source-socket-a' }) as any;
    socketA.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    const socketEmitB = vi.fn();
    const socketB = createFakeSocket({ emit: socketEmitB, id: 'source-socket-b' }) as any;
    socketB.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineTransferHandler('user-1', socketA, {
      io: { to } as any,
      serverRoutedTransferMaxBytes: 8,
    } as any);
    machineTransferHandler('user-1', socketB, {
      io: { to } as any,
      serverRoutedTransferMaxBytes: 8,
    } as any);

    const handlerA = getSocketHandler(socketA, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    const handlerB = getSocketHandler(socketB, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);

    await handlerA({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_split',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('hello', 'utf8').toString('base64'), // 5 bytes
      },
    });

    await handlerB({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_split',
        kind: 'chunk',
        sequence: 2,
        payloadBase64: Buffer.from('hello', 'utf8').toString('base64'), // 5 bytes (total 10 > 8)
      },
    });

    expect(to).toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_split',
        kind: 'abort',
        reason: 'Server-routed machine transfer exceeds the configured max-bytes limit',
      },
    });
    expect(socketEmitB).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-transfer',
      error: 'Server-routed machine transfer exceeds the configured max-bytes limit',
    });
  });

  it('rejects active transfer-id budget across multiple sockets (cannot bypass by opening extra sockets)', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));

    const socketEmitA = vi.fn();
    const socketA = createFakeSocket({ emit: socketEmitA, id: 'source-socket-a' }) as any;
    socketA.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    const socketEmitB = vi.fn();
    const socketB = createFakeSocket({ emit: socketEmitB, id: 'source-socket-b' }) as any;
    socketB.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineTransferHandler('user-1', socketA, {
      io: { to } as any,
      serverRoutedTransferMaxActiveTransfersPerSocket: 1,
    } as any);
    machineTransferHandler('user-1', socketB, {
      io: { to } as any,
      serverRoutedTransferMaxActiveTransfersPerSocket: 1,
    } as any);

    const handlerA = getSocketHandler(socketA, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    const handlerB = getSocketHandler(socketB, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);

    await handlerA({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
      },
    });

    await handlerB({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_2',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
      },
    });

    expect(to).toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_2',
        kind: 'abort',
        reason: expect.stringContaining('active-transfer'),
      },
    });
    expect(socketEmitB).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-transfer',
      error: expect.stringContaining('active-transfer'),
    });
  });
});
