import { afterEach, describe, expect, it, vi } from 'vitest';

import { TRANSFER_RELAY_V2_SOCKET_EVENT } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { createFakeSocket, getSocketHandler } from '../testkit/socketHarness';

describe('transferRelayV2Handler', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('forwards a relay v2 open envelope from a user-scoped source to the target machine room', async () => {
    const { transferRelayV2Handler } = await import('./transferRelayV2Handler');
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const io = { to } as any;
    const socket = createFakeSocket({ emit: vi.fn(), id: 'source-socket' }) as any;
    socket.data = {
      clientType: 'user-scoped',
    };

    transferRelayV2Handler('user-1', socket, { io });

    const handler = getSocketHandler(socket, TRANSFER_RELAY_V2_SOCKET_EVENT);
    await handler({
      scopeUserId: 'user-1',
      sender: {
        kind: 'user',
        socketId: 'socket-source',
      },
      recipient: {
        kind: 'machine',
        machineId: 'machine-target',
      },
      envelope: {
        transferId: 'transfer_1',
        kind: 'open',
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
        openPayloadBase64: Buffer.from('open-payload', 'utf8').toString('base64'),
      },
    });

    expect(to).toHaveBeenCalledWith('machine:machine-target:user-1');
    expect(emit).toHaveBeenCalledWith(TRANSFER_RELAY_V2_SOCKET_EVENT, {
      scopeUserId: 'user-1',
      sender: {
        kind: 'user',
        socketId: 'socket-source',
      },
      recipient: {
        kind: 'machine',
        machineId: 'machine-target',
      },
      envelope: {
        transferId: 'transfer_1',
        kind: 'open',
        openPayloadBase64: Buffer.from('open-payload', 'utf8').toString('base64'),
        recipientPublicKeyBase64: Buffer.from('recipient-key-material', 'utf8').toString('base64'),
      },
    });
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

  it('releases active relay accounting on finish so a new transfer can start under the same socket budget', async () => {
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

    const handler = getSocketHandler(socket, TRANSFER_RELAY_V2_SOCKET_EVENT);

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
        payloadBase64: Buffer.from('a', 'utf8').toString('base64'),
      },
    });

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
        kind: 'finish',
        manifestHash: 'manifest_1',
      },
    });

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
