import { MachineTransferSendEnvelopeSchema } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { Server, Socket } from 'socket.io';

const MACHINE_TRANSFER_MAX_BYTES_ERROR = 'Server-routed machine transfer exceeds the configured max-bytes limit';

function getEncodedMachineTransferEnvelopeSize(raw: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(raw), 'utf8');
  } catch {
    return null;
  }
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
      socket.emit(SOCKET_RPC_EVENTS.ERROR, {
        type: 'machine-transfer',
        error: 'Server-routed machine transfer is disabled on this server',
      });
      return;
    }

    const encodedSize = getEncodedMachineTransferEnvelopeSize(parsed.data);
    if (
      typeof ctx.serverRoutedTransferMaxBytes === 'number'
      && Number.isFinite(ctx.serverRoutedTransferMaxBytes)
      && encodedSize !== null
      && encodedSize > ctx.serverRoutedTransferMaxBytes
    ) {
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
