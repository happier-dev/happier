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
import {
  transferRelayLifecycle,
  type TransferRelayLogicalIdentity,
} from './transferRelayLifecycle';

type TransferRelayV2ScopeKey = string;

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

function buildRelayV2ParticipantKey(participant: TransferRelayV2Sender | TransferRelayV2Recipient): string {
  return participant.kind === 'machine'
    ? `machine:${participant.machineId}`
    : 'user';
}

function buildRelayV2LogicalIdentity(params: Readonly<{
  userId: string;
  sender: TransferRelayV2Sender;
  recipient: TransferRelayV2Recipient;
  transferId: string;
}>): TransferRelayLogicalIdentity {
  return {
    namespace: 'transfer-relay-v2',
    userId: params.userId,
    transferId: params.transferId,
    participants: [
      buildRelayV2ParticipantKey(params.sender),
      buildRelayV2ParticipantKey(params.recipient),
    ],
  };
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
    const machineId = params.recipient.machineId;
    const rooms = getSocketRooms({
      userId: params.userId,
      clientType: 'machine-scoped',
      machineId,
    });
    return rooms.find((room) => room.startsWith(`machine:${machineId}:`))
      ?? `machine:${machineId}:${params.userId}`;
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
    const logicalIdentity = buildRelayV2LogicalIdentity({
      userId,
      sender: relayEnvelope.sender,
      recipient: relayEnvelope.recipient,
      transferId: relayEnvelope.envelope.transferId,
    });
    const senderParticipantKey = buildRelayV2ParticipantKey(relayEnvelope.sender);
    const recipientRoom = resolveRecipientRoom({ userId, recipient: relayEnvelope.recipient });
    const senderRoom = resolveSenderRoom({ userId, sender: relayEnvelope.sender });
    const onParticipantDisconnect = () => {
      emitRelayV2Abort({
        io: ctx.io,
        userId,
        recipientRoom,
        senderRoom,
        sender: relayEnvelope.sender,
        recipient: relayEnvelope.recipient,
        transferId: relayEnvelope.envelope.transferId,
        reason: 'relay_socket_disconnected',
      });
    };

    if (relayEnvelope.envelope.kind === 'finish' || relayEnvelope.envelope.kind === 'abort') {
      transferRelayLifecycle.terminateTransfer(logicalIdentity);
    } else if (relayEnvelope.envelope.kind === 'open' || relayEnvelope.envelope.kind === 'chunk') {
      const payloadSizeBytes = relayEnvelope.envelope.kind === 'chunk'
        ? getRelayV2ChunkPayloadSizeBytes(relayEnvelope.envelope)
        : 0;
      if (relayEnvelope.envelope.kind === 'chunk' && payloadSizeBytes === null) {
        socket.emit(SOCKET_RPC_EVENTS.ERROR, {
          type: 'transfer-relay',
          error: 'Invalid transfer relay v2 payload',
        });
        return;
      }

      const lifecycleResult = transferRelayLifecycle.trackTransferFrame({
        identity: logicalIdentity,
        scopeKey,
        participant: senderParticipantKey,
        socketId: socket.id,
        payloadSizeBytes: payloadSizeBytes ?? 0,
        maxActiveTransfers: maxActiveTransfersPerSocket,
        maxBytes: relayEnvelope.envelope.kind === 'chunk' && typeof ctx.serverRelayTransferMaxBytes === 'number'
          ? ctx.serverRelayTransferMaxBytes
          : null,
        releaseActiveOnMaxBytes: true,
        onParticipantDisconnect,
      });

      if (lifecycleResult.kind === 'blocked') {
        // The transfer key has already been force-aborted (for example due to max-bytes). Fail closed by
        // re-emitting an abort envelope so relay recipients do not hang waiting for more frames.
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

      if (lifecycleResult.kind === 'active-limit-exceeded') {
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

      if (lifecycleResult.kind === 'max-bytes-exceeded') {
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
    } else {
      transferRelayLifecycle.observeTransferFrame({
        identity: logicalIdentity,
        participant: senderParticipantKey,
        socketId: socket.id,
        onParticipantDisconnect,
      });
    }

    ctx.io.to(recipientRoom).emit(TRANSFER_RELAY_V2_SOCKET_EVENT, relayEnvelope);
  });

  socket.on('disconnect', () => {
    transferRelayLifecycle.disconnectSocket(socket.id);
  });
}
