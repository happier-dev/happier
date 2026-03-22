import { MachineTransferSendEnvelopeSchema } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { Server, Socket } from 'socket.io';

const MACHINE_TRANSFER_MAX_BYTES_ERROR = 'Server-routed machine transfer exceeds the configured max-bytes limit';

function getServerRoutedChunkPayloadSizeBytes(raw: unknown): number | null {
  try {
    const payloadBase64 = typeof raw === 'object' && raw !== null && 'payloadBase64' in raw
      ? (raw as { payloadBase64?: unknown }).payloadBase64
      : null;
    if (typeof payloadBase64 !== 'string') {
      return null;
    }
    return Buffer.byteLength(payloadBase64, 'base64');
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
  ctx: Readonly<{ io: Server; serverRoutedTransferEnabled?: boolean; serverRoutedTransferMaxBytes?: number | null }>,
) {
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
    if (
      typeof ctx.serverRoutedTransferMaxBytes === 'number'
      && payloadSizeBytes !== null
      && payloadSizeBytes > ctx.serverRoutedTransferMaxBytes
    ) {
      emitMachineTransferAbort({
        io: ctx.io,
        userId,
        deliverToMachineId: parsed.data.targetMachineId,
        sourceMachineId,
        targetMachineId: parsed.data.targetMachineId,
        transferId: parsed.data.envelope.transferId,
        reason: MACHINE_TRANSFER_MAX_BYTES_ERROR,
      });
      socket.emit(SOCKET_RPC_EVENTS.ERROR, {
        type: 'machine-transfer',
        error: MACHINE_TRANSFER_MAX_BYTES_ERROR,
      });
      return;
    }

    ctx.io
      .to(`machine:${parsed.data.targetMachineId}:${userId}`)
      .emit(SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE, {
        sourceMachineId,
        targetMachineId: parsed.data.targetMachineId,
        envelope: parsed.data.envelope,
      });
  });
}
