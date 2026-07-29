import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { createFakeSocket, getSocketHandler } from '../testkit/socketHarness';

const machineFindFirst = vi.fn(async (): Promise<{ revokedAt: Date | null; replacedByMachineId: string | null }> => ({
  revokedAt: null,
  replacedByMachineId: null,
}));
vi.mock("@/storage/db", () => ({
  db: {
    machine: {
      findFirst: machineFindFirst,
    },
  },
}));

describe('machineTransferHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    machineFindFirst.mockResolvedValue({ revokedAt: null, replacedByMachineId: null });
  });

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

  it('rejects server-routed transfer envelopes from replaced source machines', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    machineFindFirst.mockResolvedValueOnce({ revokedAt: null, replacedByMachineId: 'machine-current' });
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineTransferHandler('user-1', socket, { io: { to } as any });

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    await handler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_replaced',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
      },
    });

    expect(machineFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { accountId: 'user-1', id: 'machine-source' },
      select: { revokedAt: true, replacedByMachineId: true },
    }));
    expect(to).not.toHaveBeenCalled();
    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-transfer',
      error: 'Machine replaced',
    });
  });

  it('rejects server-routed transfer envelopes to replaced target machines', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    machineFindFirst
      .mockResolvedValueOnce({ revokedAt: null, replacedByMachineId: null })
      .mockResolvedValueOnce({ revokedAt: null, replacedByMachineId: 'machine-current' });
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socketEmit = vi.fn();
    const socket = createFakeSocket({ emit: socketEmit, id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    machineTransferHandler('user-1', socket, { io: { to } as any });

    const handler = getSocketHandler(socket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    await handler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_replaced_target',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: 'YQ==',
      },
    });

    expect(machineFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { accountId: 'user-1', id: 'machine-source' },
      select: { revokedAt: true, replacedByMachineId: true },
    }));
    expect(machineFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { accountId: 'user-1', id: 'machine-target' },
      select: { revokedAt: true, replacedByMachineId: true },
    }));
    expect(to).not.toHaveBeenCalled();
    expect(socketEmit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'machine-transfer',
      error: 'Machine replaced',
    });
  });

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
  }, 15000);

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

  it('does not emit a second disconnect abort after a transfer has already been terminally blocked by max-bytes', async () => {
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
    const disconnectHandler = getSocketHandler(socket, 'disconnect');

    await handler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_blocked_disconnect',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('this chunk is too large', 'utf8').toString('base64'),
      },
    });

    emit.mockClear();

    await disconnectHandler();

    expect(emit).not.toHaveBeenCalled();
  }, 15000);

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

  it('releases retained-v1 accounting after a reverse-direction finish, including a duplicate terminal', async () => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const requesterEmit = vi.fn();
    const requesterSocket = createFakeSocket({ emit: requesterEmit, id: 'requester-socket' }) as any;
    requesterSocket.data = { clientType: 'machine-scoped', machineId: 'machine-requester' };
    const responderSocket = createFakeSocket({ emit: vi.fn(), id: 'responder-socket' }) as any;
    responderSocket.data = { clientType: 'machine-scoped', machineId: 'machine-responder' };
    const relayContext = {
      io: { to } as any,
      serverRoutedTransferMaxActiveTransfersPerSocket: 1,
    };
    machineTransferHandler('user-1', requesterSocket, relayContext);
    machineTransferHandler('user-1', responderSocket, relayContext);
    const requesterHandler = getSocketHandler(requesterSocket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    const responderHandler = getSocketHandler(responderSocket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);

    await requesterHandler({
      targetMachineId: 'machine-responder',
      envelope: {
        transferId: 'transfer_1',
        kind: 'open',
        manifestHash: 'manifest_1',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });
    await responderHandler({
      targetMachineId: 'machine-requester',
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 0,
        payloadBase64: Buffer.from('chunk', 'utf8').toString('base64'),
      },
    });
    await requesterHandler({
      targetMachineId: 'machine-responder',
      envelope: {
        transferId: 'transfer_1',
        kind: 'ack',
        nextSequence: 1,
      },
    });
    const finishEnvelope = {
      targetMachineId: 'machine-requester',
      envelope: {
        transferId: 'transfer_1',
        kind: 'finish',
        manifestHash: 'manifest_1',
      },
    } as const;
    await responderHandler(finishEnvelope);
    await responderHandler(finishEnvelope);

    await requesterHandler({
      targetMachineId: 'machine-responder',
      envelope: {
        transferId: 'transfer_2',
        kind: 'open',
        manifestHash: 'manifest_2',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });

    expect(requesterEmit.mock.calls.some(([, payload]) => (
      payload?.error === 'Server-routed machine transfer exceeds the configured active-transfer limit'
    ))).toBe(false);
  });

  it.each([
    ['requester', 'requester'],
    ['responder', 'responder'],
  ] as const)('releases retained-v1 accounting when the %s aborts, including a duplicate terminal', async (_label, abortingParticipant) => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const requesterEmit = vi.fn();
    const requesterSocket = createFakeSocket({ emit: requesterEmit, id: 'requester-socket' }) as any;
    requesterSocket.data = { clientType: 'machine-scoped', machineId: 'machine-requester' };
    const responderSocket = createFakeSocket({ emit: vi.fn(), id: 'responder-socket' }) as any;
    responderSocket.data = { clientType: 'machine-scoped', machineId: 'machine-responder' };
    const relayContext = {
      io: { to } as any,
      serverRoutedTransferMaxActiveTransfersPerSocket: 1,
    };
    machineTransferHandler('user-1', requesterSocket, relayContext);
    machineTransferHandler('user-1', responderSocket, relayContext);
    const requesterHandler = getSocketHandler(requesterSocket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    const responderHandler = getSocketHandler(responderSocket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);

    await requesterHandler({
      targetMachineId: 'machine-responder',
      envelope: {
        transferId: 'transfer_1',
        kind: 'open',
        manifestHash: 'manifest_1',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });
    const abortEnvelope = abortingParticipant === 'requester'
      ? {
        targetMachineId: 'machine-responder',
        envelope: { transferId: 'transfer_1', kind: 'abort' as const, reason: 'cancelled' },
      }
      : {
        targetMachineId: 'machine-requester',
        envelope: { transferId: 'transfer_1', kind: 'abort' as const, reason: 'cancelled' },
      };
    const abortHandler = abortingParticipant === 'requester' ? requesterHandler : responderHandler;
    await abortHandler(abortEnvelope);
    await abortHandler(abortEnvelope);

    await requesterHandler({
      targetMachineId: 'machine-responder',
      envelope: {
        transferId: 'transfer_2',
        kind: 'open',
        manifestHash: 'manifest_2',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });

    expect(requesterEmit.mock.calls.some(([, payload]) => (
      payload?.error === 'Server-routed machine transfer exceeds the configured active-transfer limit'
    ))).toBe(false);
  });

  it.each([
    ['requester', 'requester'],
    ['responder', 'responder'],
  ] as const)('releases retained-v1 accounting when the %s disconnects', async (_label, disconnectingParticipant) => {
    const { machineTransferHandler } = await import('./machineTransferHandler');
    const emit = vi.fn();
    const routedEnvelopes: Array<Readonly<{ room: string; event: string; payload: any }>> = [];
    const to = vi.fn((room: string) => ({
      emit(event: string, payload: any) {
        emit(event, payload);
        routedEnvelopes.push({ room, event, payload });
      },
    }));
    const requesterSocket = createFakeSocket({ emit: vi.fn(), id: 'requester-socket' }) as any;
    requesterSocket.data = { clientType: 'machine-scoped', machineId: 'machine-requester' };
    const responderSocket = createFakeSocket({ emit: vi.fn(), id: 'responder-socket' }) as any;
    responderSocket.data = { clientType: 'machine-scoped', machineId: 'machine-responder' };
    const relayContext = {
      io: { to } as any,
      serverRoutedTransferMaxActiveTransfersPerSocket: 1,
    };
    machineTransferHandler('user-1', requesterSocket, relayContext);
    machineTransferHandler('user-1', responderSocket, relayContext);
    const requesterHandler = getSocketHandler(requesterSocket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    const responderHandler = getSocketHandler(responderSocket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);

    await requesterHandler({
      targetMachineId: 'machine-responder',
      envelope: {
        transferId: 'transfer_1',
        kind: 'open',
        manifestHash: 'manifest_1',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });
    await responderHandler({
      targetMachineId: 'machine-requester',
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 0,
        payloadBase64: Buffer.from('chunk', 'utf8').toString('base64'),
      },
    });

    routedEnvelopes.length = 0;
    await getSocketHandler(
      disconnectingParticipant === 'requester' ? requesterSocket : responderSocket,
      'disconnect',
    )();

    const survivingMachineId = disconnectingParticipant === 'requester'
      ? 'machine-responder'
      : 'machine-requester';
    const disconnectedMachineId = disconnectingParticipant === 'requester'
      ? 'machine-requester'
      : 'machine-responder';
    const survivingRoom = `machine:${survivingMachineId}:user-1`;
    expect(routedEnvelopes.filter(({ room, event, payload }) => (
      room === survivingRoom
      && event === SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE
      && payload.envelope?.kind === 'abort'
    ))).toEqual([
      expect.objectContaining({
        room: survivingRoom,
        payload: {
          sourceMachineId: disconnectedMachineId,
          targetMachineId: survivingMachineId,
          envelope: {
            transferId: 'transfer_1',
            kind: 'abort',
            reason: 'machine_transfer_socket_disconnected',
          },
        },
      }),
    ]);

    const replacementRequesterEmit = vi.fn();
    const replacementRequesterSocket = createFakeSocket({
      emit: replacementRequesterEmit,
      id: 'replacement-requester-socket',
    }) as any;
    replacementRequesterSocket.data = { clientType: 'machine-scoped', machineId: 'machine-requester' };
    machineTransferHandler('user-1', replacementRequesterSocket, relayContext);
    await getSocketHandler(replacementRequesterSocket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE)({
      targetMachineId: 'machine-responder',
      envelope: {
        transferId: 'transfer_2',
        kind: 'open',
        manifestHash: 'manifest_2',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });

    expect(replacementRequesterEmit.mock.calls.some(([, payload]) => (
      payload?.error === 'Server-routed machine transfer exceeds the configured active-transfer limit'
    ))).toBe(false);
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

  it('emits an abort to the target machine room when the last sender socket disconnects mid-transfer', async () => {
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
      serverRoutedTransferMaxActiveTransfersPerSocket: 1,
    } as any);

    const relayHandler = getSocketHandler(socket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    const disconnectHandler = getSocketHandler(socket, 'disconnect');

    await relayHandler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_disconnect',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
      },
    });

    emit.mockClear();

    await disconnectHandler();

    expect(to).toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_disconnect',
        kind: 'abort',
        reason: 'machine_transfer_socket_disconnected',
      },
    });
  });

  it('emits an abort to the target machine room when the last sender socket disconnects after an open envelope', async () => {
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
      serverRoutedTransferMaxActiveTransfersPerSocket: 1,
    } as any);

    const relayHandler = getSocketHandler(socket, SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE);
    const disconnectHandler = getSocketHandler(socket, 'disconnect');

    await relayHandler({
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_open_disconnect',
        kind: 'open',
        manifestHash: 'transfer_open_disconnect',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });

    emit.mockClear();

    await disconnectHandler();

    expect(to).toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      envelope: {
        transferId: 'transfer_open_disconnect',
        kind: 'abort',
        reason: 'machine_transfer_socket_disconnected',
      },
    });
  }, 15000);
});
