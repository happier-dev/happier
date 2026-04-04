import {
  TRANSFER_RELAY_V2_SOCKET_EVENT,
  TransferRelayV2SendEnvelopeSchema,
  type TransferRelayV2Recipient,
  type TransferRelayV2SendEnvelope,
  type TransferRelayV2Sender,
} from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { Server, Socket } from 'socket.io';

import { getSocketRooms } from '../socketRooms';

type TransferRelayV2ScopeKey = string;
type TransferRelayV2Key = string;

const globalActiveTransfersByScope = new Map<TransferRelayV2ScopeKey, Set<TransferRelayV2Key>>();
const globalTransferBytesByKey = new Map<TransferRelayV2Key, number>();
const globalBlockedTransfers = new Set<TransferRelayV2Key>();
const globalTransferScopeByKey = new Map<TransferRelayV2Key, TransferRelayV2ScopeKey>();
const globalTransferSocketsByKey = new Map<TransferRelayV2Key, Set<string>>();

const TRANSFER_RELAY_V2_MAX_BYTES_ERROR = 'Server-relayed transfer exceeds the configured max-bytes limit';
const TRANSFER_RELAY_V2_MAX_ACTIVE_TRANSFERS_ERROR = 'Server-relayed transfer exceeds the configured active-transfer limit';

function buildRelayV2ScopeKey(params: Readonly<{
  userId: string;
  sender: TransferRelayV2Sender | TransferRelayV2Recipient;
}>): TransferRelayV2ScopeKey {
  if (params.sender.kind === 'machine') {
    return `${params.userId}:machine:${params.sender.machineId}`;
  }
  return `${params.userId}:user`;
}

function buildRelayV2TransferKey(params: Readonly<{
  scopeKey: TransferRelayV2ScopeKey;
  recipient: TransferRelayV2Sender | TransferRelayV2Recipient;
  transferId: string;
}>): TransferRelayV2Key {
  if (params.recipient.kind === 'machine') {
    return `${params.scopeKey}:machine:${params.recipient.machineId}:${params.transferId}`;
  }
  return `${params.scopeKey}:user:${params.transferId}`;
}

function clearRelayV2TransferKey(key: TransferRelayV2Key): void {
  globalBlockedTransfers.delete(key);
  globalTransferBytesByKey.delete(key);
  globalTransferSocketsByKey.delete(key);

  const scopeKey = globalTransferScopeByKey.get(key);
  if (!scopeKey) {
    return;
  }

  globalTransferScopeByKey.delete(key);
  const active = globalActiveTransfersByScope.get(scopeKey);
  active?.delete(key);
  if (active && active.size === 0) {
    globalActiveTransfersByScope.delete(scopeKey);
  }
}

function getRelayV2ChunkPayloadSizeBytes(raw: TransferRelayV2SendEnvelope['envelope']): number | null {
  if (raw.kind !== 'chunk') {
    return null;
  }

  try {
    const payloadBytes = Buffer.byteLength(raw.payloadBase64, 'base64');
    const dataKeyBytes = typeof raw.encryptedDataKeyEnvelopeBase64 === 'string'
      ? Buffer.byteLength(raw.encryptedDataKeyEnvelopeBase64, 'base64')
      : 0;
    return payloadBytes + dataKeyBytes;
  } catch {
    return null;
  }
}

function emitRelayV2Abort(params: Readonly<{
  io: Server;
  userId: string;
  recipientRoom: string;
  senderRoom: string;
  sender: TransferRelayV2Sender;
  recipient: TransferRelayV2Recipient;
  transferId: string;
  reason: string;
}>): void {
  const payload = {
    scopeUserId: params.userId,
    sender: params.sender,
    recipient: params.recipient,
    envelope: {
      transferId: params.transferId,
      kind: 'abort' as const,
      reason: params.reason,
    },
  };

  params.io.to(params.recipientRoom).emit(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
  if (params.senderRoom !== params.recipientRoom) {
    params.io.to(params.senderRoom).emit(TRANSFER_RELAY_V2_SOCKET_EVENT, payload);
  }
}

function resolveRecipientRoom(params: Readonly<{
  userId: string;
  recipient: TransferRelayV2Recipient;
}>): string {
  if (params.recipient.kind === 'machine') {
    return getSocketRooms({
      userId: params.userId,
      clientType: 'machine-scoped',
      machineId: params.recipient.machineId,
    })[0] ?? `machine:${params.recipient.machineId}:${params.userId}`;
  }
  return getSocketRooms({
    userId: params.userId,
    clientType: 'user-scoped',
  })[0] ?? `user:${params.userId}`;
}

function resolveSenderRoom(params: Readonly<{
  userId: string;
  sender: TransferRelayV2Sender;
}>): string {
  if (params.sender.kind === 'machine') {
    return `machine:${params.sender.machineId}:${params.userId}`;
  }
  return `user:${params.userId}`;
}

export function transferRelayV2Handler(
  userId: string,
  socket: Socket,
  ctx: Readonly<{
    io: Server;
    serverRelayTransferEnabled?: boolean;
    serverRelayTransferMaxBytes?: number | null;
    serverRelayTransferMaxActiveTransfersPerSocket?: number | null;
  }>,
) {
  const socketTransferKeys = new Set<TransferRelayV2Key>();
  const maxActiveTransfersPerSocket = (
    typeof ctx.serverRelayTransferMaxActiveTransfersPerSocket === 'number'
    && Number.isFinite(ctx.serverRelayTransferMaxActiveTransfersPerSocket)
    && ctx.serverRelayTransferMaxActiveTransfersPerSocket > 0
  )
    ? Math.floor(ctx.serverRelayTransferMaxActiveTransfersPerSocket)
    : 128;

  socket.on(TRANSFER_RELAY_V2_SOCKET_EVENT, async (raw: unknown) => {
    const parsed = TransferRelayV2SendEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      socket.emit(SOCKET_RPC_EVENTS.ERROR, {
        type: 'transfer-relay',
        error: 'Invalid transfer relay v2 payload',
      });
      return;
    }

    const relayEnvelope: TransferRelayV2SendEnvelope = parsed.data;

    if (relayEnvelope.scopeUserId !== userId) {
      socket.emit(SOCKET_RPC_EVENTS.ERROR, {
        type: 'transfer-relay',
        error: 'Relay v2 scope user does not match the authenticated socket user',
      });
      return;
    }

    const clientType = (socket.data as { clientType?: unknown } | undefined)?.clientType;
    const sourceMachineId = typeof (socket.data as { machineId?: unknown } | undefined)?.machineId === 'string'
      ? (socket.data as { machineId: string }).machineId
      : '';

    if (relayEnvelope.sender.kind === 'machine') {
      if (clientType !== 'machine-scoped' || !sourceMachineId || sourceMachineId !== relayEnvelope.sender.machineId) {
        socket.emit(SOCKET_RPC_EVENTS.ERROR, {
          type: 'transfer-relay',
          error: 'Relay v2 machine sender requires a matching machine-scoped socket',
        });
        return;
      }
    } else if (clientType !== 'user-scoped' && clientType !== 'session-scoped') {
      socket.emit(SOCKET_RPC_EVENTS.ERROR, {
        type: 'transfer-relay',
        error: 'Relay v2 user sender requires a user-scoped socket',
      });
      return;
    }

    if (ctx.serverRelayTransferEnabled === false) {
      const senderRoom = resolveSenderRoom({ userId, sender: relayEnvelope.sender });
      const recipientRoom = resolveRecipientRoom({ userId, recipient: relayEnvelope.recipient });
      emitRelayV2Abort({
        io: ctx.io,
        userId,
        recipientRoom,
        senderRoom,
        sender: relayEnvelope.sender,
        recipient: relayEnvelope.recipient,
        transferId: relayEnvelope.envelope.transferId,
        reason: 'Server-relayed transfer is disabled on this server',
      });
      socket.emit(SOCKET_RPC_EVENTS.ERROR, {
        type: 'transfer-relay',
        error: 'Server-relayed transfer is disabled on this server',
      });
      return;
    }

    const scopeKey = buildRelayV2ScopeKey({ userId, sender: relayEnvelope.sender });
    const transferKey = buildRelayV2TransferKey({ scopeKey, recipient: relayEnvelope.recipient, transferId: relayEnvelope.envelope.transferId });
    const recipientRoom = resolveRecipientRoom({ userId, recipient: relayEnvelope.recipient });
    const senderRoom = resolveSenderRoom({ userId, sender: relayEnvelope.sender });

    if (relayEnvelope.envelope.kind === 'finish' || relayEnvelope.envelope.kind === 'abort') {
      clearRelayV2TransferKey(transferKey);
      socketTransferKeys.delete(transferKey);
    } else if (relayEnvelope.envelope.kind === 'chunk') {
      const payloadSizeBytes = getRelayV2ChunkPayloadSizeBytes(relayEnvelope.envelope);
      if (payloadSizeBytes === null) {
        socket.emit(SOCKET_RPC_EVENTS.ERROR, {
          type: 'transfer-relay',
          error: 'Invalid transfer relay v2 payload',
        });
        return;
      }

      if (globalBlockedTransfers.has(transferKey)) {
        socket.emit(SOCKET_RPC_EVENTS.ERROR, {
          type: 'transfer-relay',
          error: TRANSFER_RELAY_V2_MAX_BYTES_ERROR,
        });
        return;
      }

      if (!globalTransferBytesByKey.has(transferKey)) {
        const active = globalActiveTransfersByScope.get(scopeKey) ?? new Set<TransferRelayV2Key>();
        if (!globalActiveTransfersByScope.has(scopeKey)) {
          globalActiveTransfersByScope.set(scopeKey, active);
        }
        if (active.size >= maxActiveTransfersPerSocket) {
          emitRelayV2Abort({
            io: ctx.io,
            userId,
            recipientRoom,
            senderRoom,
            sender: relayEnvelope.sender,
            recipient: relayEnvelope.recipient,
            transferId: relayEnvelope.envelope.transferId,
            reason: TRANSFER_RELAY_V2_MAX_ACTIVE_TRANSFERS_ERROR,
          });
          socket.emit(SOCKET_RPC_EVENTS.ERROR, {
            type: 'transfer-relay',
            error: TRANSFER_RELAY_V2_MAX_ACTIVE_TRANSFERS_ERROR,
          });
          return;
        }
        active.add(transferKey);
        globalTransferScopeByKey.set(transferKey, scopeKey);
      }

      const sockets = globalTransferSocketsByKey.get(transferKey) ?? new Set<string>();
      sockets.add(socket.id);
      globalTransferSocketsByKey.set(transferKey, sockets);
      socketTransferKeys.add(transferKey);

      const priorBytes = globalTransferBytesByKey.get(transferKey) ?? 0;
      const nextBytes = priorBytes + payloadSizeBytes;
      if (typeof ctx.serverRelayTransferMaxBytes === 'number' && nextBytes > ctx.serverRelayTransferMaxBytes) {
        globalBlockedTransfers.add(transferKey);
        globalTransferBytesByKey.set(transferKey, nextBytes);
        emitRelayV2Abort({
          io: ctx.io,
          userId,
          recipientRoom,
          senderRoom,
          sender: relayEnvelope.sender,
          recipient: relayEnvelope.recipient,
          transferId: relayEnvelope.envelope.transferId,
          reason: TRANSFER_RELAY_V2_MAX_BYTES_ERROR,
        });
        socket.emit(SOCKET_RPC_EVENTS.ERROR, {
          type: 'transfer-relay',
          error: TRANSFER_RELAY_V2_MAX_BYTES_ERROR,
        });
        return;
      }

      globalTransferBytesByKey.set(transferKey, nextBytes);
    }

    ctx.io.to(recipientRoom).emit(TRANSFER_RELAY_V2_SOCKET_EVENT, relayEnvelope);
  });

  socket.on('disconnect', () => {
    for (const transferKey of socketTransferKeys) {
      const sockets = globalTransferSocketsByKey.get(transferKey);
      if (!sockets) {
        continue;
      }
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        clearRelayV2TransferKey(transferKey);
      } else {
        globalTransferSocketsByKey.set(transferKey, sockets);
      }
    }
    socketTransferKeys.clear();
  });
}
