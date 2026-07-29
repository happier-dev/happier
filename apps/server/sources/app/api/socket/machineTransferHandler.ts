import { MachineTransferSendEnvelopeSchema } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { readMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { Server, Socket } from 'socket.io';

import {
  transferRelayLifecycle,
  type TransferRelayLogicalIdentity,
} from './transferRelayLifecycle';

const MACHINE_TRANSFER_MAX_BYTES_ERROR = 'Server-routed machine transfer exceeds the configured max-bytes limit';
const MACHINE_TRANSFER_MAX_ACTIVE_TRANSFERS_ERROR =
  'Server-routed machine transfer exceeds the configured active-transfer limit';

type MachineTransferScopeKey = string;

function buildMachineTransferScopeKey(params: Readonly<{
  userId: string;
  sourceMachineId: string;
}>): MachineTransferScopeKey {
  return `${params.userId}:${params.sourceMachineId}`;
}

function buildMachineTransferLogicalIdentity(params: Readonly<{
  userId: string;
  sourceMachineId: string;
  targetMachineId: string;
  transferId: string;
}>): TransferRelayLogicalIdentity {
  return {
    namespace: 'machine-transfer-v1',
    userId: params.userId,
    transferId: params.transferId,
    participants: [
      `machine:${params.sourceMachineId}`,
      `machine:${params.targetMachineId}`,
    ],
  };
}

function getServerRoutedChunkPayloadSizeBytes(raw: unknown): number | null {
  try {
    const payloadBase64 = typeof raw === 'object' && raw !== null && 'payloadBase64' in raw
      ? (raw as { payloadBase64?: unknown }).payloadBase64
      : null;
    if (typeof payloadBase64 !== 'string') {
      return null;
    }

    const encryptedDataKeyEnvelopeBase64 = typeof raw === 'object' && raw !== null && 'encryptedDataKeyEnvelopeBase64' in raw
      ? (raw as { encryptedDataKeyEnvelopeBase64?: unknown }).encryptedDataKeyEnvelopeBase64
      : null;

    const payloadBytes = Buffer.byteLength(payloadBase64, 'base64');
    const dataKeyBytes = typeof encryptedDataKeyEnvelopeBase64 === 'string'
      ? Buffer.byteLength(encryptedDataKeyEnvelopeBase64, 'base64')
      : 0;

    return payloadBytes + dataKeyBytes;
  } catch {
    return null;
  }
}

function emitMachineTransferAbort(params: Readonly<{
  io: Server;
  userId: string;
  deliverToMachineId: string;
  sourceMachineId: string;
  targetMachineId: string;
  transferId: string;
  reason: string;
}>): void {
  params.io
    .to(`machine:${params.deliverToMachineId}:${params.userId}`)
    .emit(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
      sourceMachineId: params.sourceMachineId,
      targetMachineId: params.targetMachineId,
      envelope: {
        transferId: params.transferId,
        kind: 'abort',
        reason: params.reason,
      },
    });
}

export function machineTransferHandler(
  userId: string,
  socket: Socket,
  ctx: Readonly<{
    io: Server;
    serverRoutedTransferEnabled?: boolean;
    serverRoutedTransferMaxBytes?: number | null;
    serverRoutedTransferMaxActiveTransfersPerSocket?: number | null;
  }>,
) {
  // Cross-socket accounting. Prevents bypassing max-bytes/active-transfer budgets by opening
  // multiple machine-scoped sockets and splitting the same logical transfer across them.
  const maxActiveTransfersPerSocket = (
    typeof ctx.serverRoutedTransferMaxActiveTransfersPerSocket === 'number'
      && Number.isFinite(ctx.serverRoutedTransferMaxActiveTransfersPerSocket)
      && ctx.serverRoutedTransferMaxActiveTransfersPerSocket > 0
  )
    ? Math.floor(ctx.serverRoutedTransferMaxActiveTransfersPerSocket)
    : 128;

  socket.on(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, async (raw: unknown) => {
    const sourceMachineId = typeof (socket.data as any)?.machineId === 'string' ? (socket.data as any).machineId : '';
    const clientType = (socket.data as any)?.clientType;
    if (clientType !== 'machine-scoped' || !sourceMachineId) {
      socket.emit(SOCKET_RPC_EVENTS.ERROR, {
        type: 'machine-transfer',
        error: 'Machine transfer requires a machine-scoped socket',
      });
      return;
    }

    const parsed = MachineTransferSendEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      socket.emit(SOCKET_RPC_EVENTS.ERROR, {
        type: 'machine-transfer',
        error: 'Invalid machine transfer payload',
      });
      return;
    }

    const sourceState = await readMachineAvailabilityState({ accountId: userId, machineId: sourceMachineId });
    if (sourceState === 'revoked' || sourceState === 'replaced' || sourceState === 'missing') {
      socket.emit(SOCKET_RPC_EVENTS.ERROR, {
        type: 'machine-transfer',
        error: sourceState === 'replaced' ? 'Machine replaced' : 'Machine unavailable',
      });
      return;
    }

    const targetState = await readMachineAvailabilityState({ accountId: userId, machineId: parsed.data.targetMachineId });
    if (targetState === 'revoked' || targetState === 'replaced' || targetState === 'missing') {
      socket.emit(SOCKET_RPC_EVENTS.ERROR, {
        type: 'machine-transfer',
        error: targetState === 'replaced' ? 'Machine replaced' : 'Machine unavailable',
      });
      return;
    }

    if (ctx.serverRoutedTransferEnabled === false) {
      emitMachineTransferAbort({
        io: ctx.io,
        userId,
        deliverToMachineId: sourceMachineId,
        sourceMachineId: parsed.data.targetMachineId,
        targetMachineId: sourceMachineId,
        transferId: parsed.data.envelope.transferId,
        reason: 'Server-routed machine transfer is disabled on this server',
      });
      socket.emit(SOCKET_RPC_EVENTS.ERROR, {
        type: 'machine-transfer',
        error: 'Server-routed machine transfer is disabled on this server',
      });
      return;
    }

    const payloadSizeBytes = parsed.data.envelope.kind === 'chunk'
      ? getServerRoutedChunkPayloadSizeBytes(parsed.data.envelope)
      : null;
    const transferId = parsed.data.envelope.transferId;
    const targetMachineId = parsed.data.targetMachineId;
    const scopeKey = buildMachineTransferScopeKey({ userId, sourceMachineId });
    const logicalIdentity = buildMachineTransferLogicalIdentity({
      userId,
      sourceMachineId,
      targetMachineId,
      transferId,
    });
    const sourceParticipantKey = `machine:${sourceMachineId}`;
    const onParticipantDisconnect = () => {
      emitMachineTransferAbort({
        io: ctx.io,
        userId,
        deliverToMachineId: targetMachineId,
        sourceMachineId,
        targetMachineId,
        transferId,
        reason: 'machine_transfer_socket_disconnected',
      });
    };

    if (parsed.data.envelope.kind === 'finish' || parsed.data.envelope.kind === 'abort') {
      transferRelayLifecycle.terminateTransfer(logicalIdentity);
    } else if (parsed.data.envelope.kind === 'open' || parsed.data.envelope.kind === 'chunk') {
      if (parsed.data.envelope.kind === 'chunk' && payloadSizeBytes === null) {
        socket.emit(SOCKET_RPC_EVENTS.ERROR, {
          type: 'machine-transfer',
          error: 'Invalid machine transfer payload',
        });
        return;
      }

      const lifecycleResult = transferRelayLifecycle.trackTransferFrame({
        identity: logicalIdentity,
        scopeKey,
        participant: sourceParticipantKey,
        socketId: socket.id,
        payloadSizeBytes: payloadSizeBytes ?? 0,
        maxActiveTransfers: maxActiveTransfersPerSocket,
        maxBytes: parsed.data.envelope.kind === 'chunk' && typeof ctx.serverRoutedTransferMaxBytes === 'number'
          ? ctx.serverRoutedTransferMaxBytes
          : null,
        releaseActiveOnMaxBytes: false,
        onParticipantDisconnect,
      });

      if (lifecycleResult.kind === 'blocked') {
        socket.emit(SOCKET_RPC_EVENTS.ERROR, {
          type: 'machine-transfer',
          error: MACHINE_TRANSFER_MAX_BYTES_ERROR,
        });
        return;
      }

      if (lifecycleResult.kind === 'active-limit-exceeded') {
        emitMachineTransferAbort({
          io: ctx.io,
          userId,
          deliverToMachineId: targetMachineId,
          sourceMachineId,
          targetMachineId,
          transferId,
          reason: MACHINE_TRANSFER_MAX_ACTIVE_TRANSFERS_ERROR,
        });
        socket.emit(SOCKET_RPC_EVENTS.ERROR, {
          type: 'machine-transfer',
          error: MACHINE_TRANSFER_MAX_ACTIVE_TRANSFERS_ERROR,
        });
        return;
      }

      if (lifecycleResult.kind === 'max-bytes-exceeded') {
        emitMachineTransferAbort({
          io: ctx.io,
          userId,
          deliverToMachineId: targetMachineId,
          sourceMachineId,
          targetMachineId,
          transferId,
          reason: MACHINE_TRANSFER_MAX_BYTES_ERROR,
        });
        socket.emit(SOCKET_RPC_EVENTS.ERROR, {
          type: 'machine-transfer',
          error: MACHINE_TRANSFER_MAX_BYTES_ERROR,
        });
        return;
      }
    } else {
      transferRelayLifecycle.observeTransferFrame({
        identity: logicalIdentity,
        participant: sourceParticipantKey,
        socketId: socket.id,
        onParticipantDisconnect,
      });
    }

    ctx.io
      .to(`machine:${parsed.data.targetMachineId}:${userId}`)
      .emit(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
        sourceMachineId,
        targetMachineId: parsed.data.targetMachineId,
        envelope: parsed.data.envelope,
      });
  });

  socket.on('disconnect', () => {
    transferRelayLifecycle.disconnectSocket(socket.id);
  });
}
