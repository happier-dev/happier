import { afterEach, describe, expect, it, vi } from 'vitest';

import { TRANSFER_RELAY_V2_SOCKET_EVENT } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { createFakeSocket, getSocketHandler } from '../testkit/socketHarness';
import { getSocketRooms } from '../socketRooms';

describe('transferRelayV2Handler', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('routes relay v2 transfer frames only to the exact target machine room', async () => {
    const { transferRelayV2Handler } = await import('./transferRelayV2Handler');
    const targetMachineEmit = vi.fn();
    const otherMachineEmit = vi.fn();
    const machineSubscriptions = [
      {
        emit: targetMachineEmit,
        rooms: new Set(getSocketRooms({
          userId: 'user-1',
          clientType: 'machine-scoped',
          machineId: 'machine-target',
        })),
      },
      {
        emit: otherMachineEmit,
        rooms: new Set(getSocketRooms({
          userId: 'user-1',
          clientType: 'machine-scoped',
          machineId: 'machine-other',
        })),
      },
    ];
    const routedRooms: string[] = [];
    const to = vi.fn((room: string) => ({
      emit(event: string, payload: unknown) {
        routedRooms.push(room);
        for (const subscription of machineSubscriptions) {
          if (subscription.rooms.has(room)) {
            subscription.emit(event, payload);
          }
        }
      },
    }));
    const io = { to } as any;
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'user-scoped',
    };

    transferRelayV2Handler('user-1', socket, { io });

    const handler = getSocketHandler(socket, TRANSFER_RELAY_V2_SOCKET_EVENT);
    const relayEnvelopeBase = {
      scopeUserId: 'user-1',
      sender: {
        kind: 'user' as const,
        socketId: 'socket-source',
      },
      recipient: {
        kind: 'machine' as const,
        machineId: 'machine-target',
      },
    };
    const envelopes = [
      {
        transferId: 'transfer_1',
        kind: 'open',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
        openPayloadBase64: Buffer.from('open-payload', 'utf8').toString('base64'),
      },
      {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 0,
        payloadBase64: Buffer.from('chunk-payload', 'utf8').toString('base64'),
      },
      {
        transferId: 'transfer_1',
        kind: 'finish',
        manifestHash: 'manifest_1',
      },
      {
        transferId: 'transfer_1',
        kind: 'abort',
        reason: 'cancelled',
      },
    ] as const;

    for (const envelope of envelopes) {
      await handler({
        ...relayEnvelopeBase,
        envelope,
      });
    }

    expect(routedRooms).toEqual(Array(envelopes.length).fill('machine:machine-target:user-1'));
    expect(targetMachineEmit).toHaveBeenCalledTimes(envelopes.length);
    expect(targetMachineEmit.mock.calls.map(([event, payload]) => ({
      event,
      kind: payload.envelope.kind,
    }))).toEqual(envelopes.map((envelope) => ({
      event: TRANSFER_RELAY_V2_SOCKET_EVENT,
      kind: envelope.kind,
    })));
    expect(otherMachineEmit).not.toHaveBeenCalled();
  });

  it('rejects a relay v2 payload when the scope user does not match the authenticated socket user', async () => {
    const { transferRelayV2Handler } = await import('./transferRelayV2Handler');
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'user-scoped',
    };

    transferRelayV2Handler('user-1', socket, { io: {} as any });

    const handler = getSocketHandler(socket, TRANSFER_RELAY_V2_SOCKET_EVENT);
    await handler({
      scopeUserId: 'user-2',
      sender: {
        kind: 'user',
      },
      recipient: {
        kind: 'machine',
        machineId: 'machine-target',
      },
      envelope: {
        transferId: 'transfer_2',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
      },
    });

    expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'transfer-relay',
      error: 'Relay v2 scope user does not match the authenticated socket user',
    });
  });

  it('releases active relay accounting after a reverse-direction finish, including a duplicate terminal', async () => {
    const { transferRelayV2Handler } = await import('./transferRelayV2Handler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const userSocketEmit = vi.fn();
    const userSocket = createFakeSocket({ emit: userSocketEmit, id: 'user-socket' }) as any;
    userSocket.data = {
      clientType: 'user-scoped',
    };
    const machineSocket = createFakeSocket({ emit: vi.fn(), id: 'machine-socket' }) as any;
    machineSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-target',
    };

    const relayContext = {
      io: { to } as any,
      serverRelayTransferMaxActiveTransfersPerSocket: 1,
    };
    transferRelayV2Handler('user-1', userSocket, relayContext);
    transferRelayV2Handler('user-1', machineSocket, relayContext);

    const userHandler = getSocketHandler(userSocket, TRANSFER_RELAY_V2_SOCKET_EVENT);
    const machineHandler = getSocketHandler(machineSocket, TRANSFER_RELAY_V2_SOCKET_EVENT);

    await userHandler({
      scopeUserId: 'user-1',
      sender: {
        kind: 'user',
      },
      recipient: {
        kind: 'machine',
        machineId: 'machine-target',
      },
      envelope: {
        transferId: 'transfer_1',
        kind: 'open',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });
    await machineHandler({
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-target',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 0,
        payloadBase64: Buffer.from('chunk', 'utf8').toString('base64'),
      },
    });
    await userHandler({
      scopeUserId: 'user-1',
      sender: {
        kind: 'user',
      },
      recipient: {
        kind: 'machine',
        machineId: 'machine-target',
      },
      envelope: {
        transferId: 'transfer_1',
        kind: 'ack',
        nextSequence: 1,
      },
    });

    const finishEnvelope = {
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-target',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_1',
        kind: 'finish',
        manifestHash: 'manifest_1',
      },
    } as const;
    await machineHandler(finishEnvelope);
    await machineHandler(finishEnvelope);

    await userHandler({
      scopeUserId: 'user-1',
      sender: {
        kind: 'user',
      },
      recipient: {
        kind: 'machine',
        machineId: 'machine-target',
      },
      envelope: {
        transferId: 'transfer_2',
        kind: 'open',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });

    expect(userSocketEmit.mock.calls.some(([, payload]) => (
      payload?.error === 'Server-relayed transfer exceeds the configured active-transfer limit'
    ))).toBe(false);
    expect(emit).toHaveBeenCalledWith(TRANSFER_RELAY_V2_SOCKET_EVENT, expect.objectContaining({
      scopeUserId: 'user-1',
      sender: {
        kind: 'user',
      },
      recipient: {
        kind: 'machine',
        machineId: 'machine-target',
      },
      envelope: {
        transferId: 'transfer_2',
        kind: 'open',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    }));
  });

  it.each([
    ['initiating user', 'user'],
    ['responding machine', 'machine'],
  ] as const)('releases active relay accounting when the %s aborts, including a duplicate terminal', async (_label, abortingParticipant) => {
    const { transferRelayV2Handler } = await import('./transferRelayV2Handler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const userSocketEmit = vi.fn();
    const userSocket = createFakeSocket({ emit: userSocketEmit, id: 'user-socket' }) as any;
    userSocket.data = { clientType: 'user-scoped' };
    const machineSocket = createFakeSocket({ emit: vi.fn(), id: 'machine-socket' }) as any;
    machineSocket.data = { clientType: 'machine-scoped', machineId: 'machine-target' };
    const relayContext = {
      io: { to } as any,
      serverRelayTransferMaxActiveTransfersPerSocket: 1,
    };
    transferRelayV2Handler('user-1', userSocket, relayContext);
    transferRelayV2Handler('user-1', machineSocket, relayContext);
    const userHandler = getSocketHandler(userSocket, TRANSFER_RELAY_V2_SOCKET_EVENT);
    const machineHandler = getSocketHandler(machineSocket, TRANSFER_RELAY_V2_SOCKET_EVENT);

    await userHandler({
      scopeUserId: 'user-1',
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: 'machine-target' },
      envelope: {
        transferId: 'transfer_1',
        kind: 'open',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });

    const abortEnvelope = abortingParticipant === 'user'
      ? {
        scopeUserId: 'user-1',
        sender: { kind: 'user' as const },
        recipient: { kind: 'machine' as const, machineId: 'machine-target' },
        envelope: { transferId: 'transfer_1', kind: 'abort' as const, reason: 'cancelled' },
      }
      : {
        scopeUserId: 'user-1',
        sender: { kind: 'machine' as const, machineId: 'machine-target' },
        recipient: { kind: 'user' as const },
        envelope: { transferId: 'transfer_1', kind: 'abort' as const, reason: 'cancelled' },
      };
    const abortHandler = abortingParticipant === 'user' ? userHandler : machineHandler;
    await abortHandler(abortEnvelope);
    await abortHandler(abortEnvelope);

    await userHandler({
      scopeUserId: 'user-1',
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: 'machine-target' },
      envelope: {
        transferId: 'transfer_2',
        kind: 'open',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });

    expect(userSocketEmit.mock.calls.some(([, payload]) => (
      payload?.error === 'Server-relayed transfer exceeds the configured active-transfer limit'
    ))).toBe(false);
  });

  it.each([
    ['initiating user', 'user'],
    ['responding machine', 'machine'],
  ] as const)('releases active relay accounting when the %s disconnects', async (_label, disconnectingParticipant) => {
    const { transferRelayV2Handler } = await import('./transferRelayV2Handler');
    const emit = vi.fn();
    const routedEnvelopes: Array<Readonly<{ room: string; event: string; payload: any }>> = [];
    const to = vi.fn((room: string) => ({
      emit(event: string, payload: any) {
        emit(event, payload);
        routedEnvelopes.push({ room, event, payload });
      },
    }));
    const userSocket = createFakeSocket({ emit: vi.fn(), id: 'user-socket' }) as any;
    userSocket.data = { clientType: 'user-scoped' };
    const machineSocket = createFakeSocket({ emit: vi.fn(), id: 'machine-socket' }) as any;
    machineSocket.data = { clientType: 'machine-scoped', machineId: 'machine-target' };
    const relayContext = {
      io: { to } as any,
      serverRelayTransferMaxActiveTransfersPerSocket: 1,
    };
    transferRelayV2Handler('user-1', userSocket, relayContext);
    transferRelayV2Handler('user-1', machineSocket, relayContext);
    const userHandler = getSocketHandler(userSocket, TRANSFER_RELAY_V2_SOCKET_EVENT);
    const machineHandler = getSocketHandler(machineSocket, TRANSFER_RELAY_V2_SOCKET_EVENT);

    await userHandler({
      scopeUserId: 'user-1',
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: 'machine-target' },
      envelope: {
        transferId: 'transfer_1',
        kind: 'open',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });
    await machineHandler({
      scopeUserId: 'user-1',
      sender: { kind: 'machine', machineId: 'machine-target' },
      recipient: { kind: 'user' },
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 0,
        payloadBase64: Buffer.from('chunk', 'utf8').toString('base64'),
      },
    });

    routedEnvelopes.length = 0;
    await getSocketHandler(
      disconnectingParticipant === 'user' ? userSocket : machineSocket,
      'disconnect',
    )();

    const survivingRoom = disconnectingParticipant === 'user'
      ? 'machine:machine-target:user-1'
      : 'user:user-1';
    expect(routedEnvelopes.filter(({ room, event, payload }) => (
      room === survivingRoom
      && event === TRANSFER_RELAY_V2_SOCKET_EVENT
      && payload.envelope?.kind === 'abort'
    ))).toEqual([
      expect.objectContaining({
        room: survivingRoom,
        payload: {
          scopeUserId: 'user-1',
          sender: disconnectingParticipant === 'user'
            ? { kind: 'user' }
            : { kind: 'machine', machineId: 'machine-target' },
          recipient: disconnectingParticipant === 'user'
            ? { kind: 'machine', machineId: 'machine-target' }
            : { kind: 'user' },
          envelope: {
            transferId: 'transfer_1',
            kind: 'abort',
            reason: 'relay_socket_disconnected',
          },
        },
      }),
    ]);

    const replacementUserSocketEmit = vi.fn();
    const replacementUserSocket = createFakeSocket({
      emit: replacementUserSocketEmit,
      id: 'replacement-user-socket',
    }) as any;
    replacementUserSocket.data = { clientType: 'user-scoped' };
    transferRelayV2Handler('user-1', replacementUserSocket, relayContext);
    await getSocketHandler(replacementUserSocket, TRANSFER_RELAY_V2_SOCKET_EVENT)({
      scopeUserId: 'user-1',
      sender: { kind: 'user' },
      recipient: { kind: 'machine', machineId: 'machine-target' },
      envelope: {
        transferId: 'transfer_2',
        kind: 'open',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });

    expect(replacementUserSocketEmit.mock.calls.some(([, payload]) => (
      payload?.error === 'Server-relayed transfer exceeds the configured active-transfer limit'
    ))).toBe(false);
  });

  it('releases active relay accounting on max-bytes abort so a new transfer can start under the same socket budget', async () => {
    const { transferRelayV2Handler } = await import('./transferRelayV2Handler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    transferRelayV2Handler('user-1', socket, {
      io: { to } as any,
      serverRelayTransferMaxActiveTransfersPerSocket: 1,
      serverRelayTransferMaxBytes: 1,
    });

    const handler = getSocketHandler(socket, TRANSFER_RELAY_V2_SOCKET_EVENT);

    // First transfer exceeds the byte budget and should be force-aborted.
    await handler({
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-source',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('ab', 'utf8').toString('base64'),
      },
    });

    emit.mockClear();

    // Any subsequent envelopes for a max-bytes-blocked transfer must fail closed by emitting an abort
    // to the recipient instead of silently dropping the frame.
    await handler({
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-source',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_1',
        kind: 'chunk',
        sequence: 2,
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
      },
    });

    expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'transfer-relay',
      error: 'Server-relayed transfer exceeds the configured max-bytes limit',
    });
    expect(emit).toHaveBeenCalledWith(TRANSFER_RELAY_V2_SOCKET_EVENT, expect.objectContaining({
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-source',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_1',
        kind: 'abort',
        reason: 'Server-relayed transfer exceeds the configured max-bytes limit',
      },
    }));

    emit.mockClear();

    // Second transfer must not be blocked by stale accounting from the aborted transfer.
    await handler({
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-source',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_2',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
      },
    });

    expect(to).toHaveBeenCalledWith('user:user-1');
    expect(emit).toHaveBeenCalledWith(TRANSFER_RELAY_V2_SOCKET_EVENT, expect.objectContaining({
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-source',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_2',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
      },
    }));
  });

  it('clears a max-bytes-blocked transfer key when the last socket disconnects so a reconnected socket can reuse that transfer id', async () => {
    const { transferRelayV2Handler } = await import('./transferRelayV2Handler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const io = { to } as any;
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket-1' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    transferRelayV2Handler('user-1', socket, {
      io,
      serverRelayTransferMaxBytes: 1,
    });

    const relayHandler = getSocketHandler(socket, TRANSFER_RELAY_V2_SOCKET_EVENT);
    const disconnectHandler = getSocketHandler(socket, 'disconnect');

    await relayHandler({
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-source',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_blocked_reconnect',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('ab', 'utf8').toString('base64'),
      },
    });

    emit.mockClear();

    await disconnectHandler();

    const reconnectedSocket = createFakeSocket({ emit: vi.fn(), id: 'source-socket-2' }) as any;
    reconnectedSocket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    transferRelayV2Handler('user-1', reconnectedSocket, {
      io,
      serverRelayTransferMaxBytes: 1,
    });

    const reconnectedRelayHandler = getSocketHandler(reconnectedSocket, TRANSFER_RELAY_V2_SOCKET_EVENT);

    await reconnectedRelayHandler({
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-source',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_blocked_reconnect',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
      },
    });

    expect(reconnectedSocket.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.ERROR, {
      type: 'transfer-relay',
      error: 'Server-relayed transfer exceeds the configured max-bytes limit',
    });
    expect(to).toHaveBeenCalledWith('user:user-1');
    expect(emit).toHaveBeenCalledWith(TRANSFER_RELAY_V2_SOCKET_EVENT, expect.objectContaining({
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-source',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_blocked_reconnect',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
      },
    }));
  });

  it('emits an abort to the recipient room when the last relay socket disconnects mid-transfer', async () => {
    const { transferRelayV2Handler } = await import('./transferRelayV2Handler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    transferRelayV2Handler('user-1', socket, {
      io: { to } as any,
      serverRelayTransferMaxActiveTransfersPerSocket: 1,
    });

    const relayHandler = getSocketHandler(socket, TRANSFER_RELAY_V2_SOCKET_EVENT);
    const disconnectHandler = getSocketHandler(socket, 'disconnect');

    await relayHandler({
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-source',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_disconnect',
        kind: 'chunk',
        sequence: 1,
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
      },
    });

    emit.mockClear();

    await disconnectHandler();

    expect(to).toHaveBeenCalledWith('user:user-1');
    expect(emit).toHaveBeenCalledWith(TRANSFER_RELAY_V2_SOCKET_EVENT, {
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-source',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_disconnect',
        kind: 'abort',
        reason: 'relay_socket_disconnected',
      },
    });
  });

  it('emits an abort to the recipient room when the last relay socket disconnects after an open envelope', async () => {
    const { transferRelayV2Handler } = await import('./transferRelayV2Handler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'machine-scoped',
      machineId: 'machine-source',
    };

    transferRelayV2Handler('user-1', socket, {
      io: { to } as any,
    });

    const relayHandler = getSocketHandler(socket, TRANSFER_RELAY_V2_SOCKET_EVENT);
    const disconnectHandler = getSocketHandler(socket, 'disconnect');

    await relayHandler({
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-source',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_open_disconnect',
        kind: 'open',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });

    emit.mockClear();

    await disconnectHandler();

    expect(to).toHaveBeenCalledWith('user:user-1');
    expect(emit).toHaveBeenCalledWith(TRANSFER_RELAY_V2_SOCKET_EVENT, {
      scopeUserId: 'user-1',
      sender: {
        kind: 'machine',
        machineId: 'machine-source',
      },
      recipient: {
        kind: 'user',
      },
      envelope: {
        transferId: 'transfer_open_disconnect',
        kind: 'abort',
        reason: 'relay_socket_disconnected',
      },
    });
  });
});
