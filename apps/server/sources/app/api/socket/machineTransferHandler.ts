import { MachineTransferSendEnvelopeSchema } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { Server, Socket } from 'socket.io';

const MACHINE_TRANSFER_MAX_BYTES_ERROR = 'Server-routed machine transfer exceeds the configured max-bytes limit';
const MACHINE_TRANSFER_MAX_ACTIVE_TRANSFERS_ERROR =
  'Server-routed machine transfer exceeds the configured active-transfer limit';

type MachineTransferScopeKey = string;
type MachineTransferKey = string;

const globalActiveTransfersByScope = new Map<MachineTransferScopeKey, Set<MachineTransferKey>>();
const globalTransferBytesByKey = new Map<MachineTransferKey, number>();
const globalBlockedTransfers = new Set<MachineTransferKey>();
const globalTransferScopeByKey = new Map<MachineTransferKey, MachineTransferScopeKey>();
const globalTransferSocketsByKey = new Map<MachineTransferKey, Set<string>>();

function buildMachineTransferScopeKey(params: Readonly<{
  userId: string;
  sourceMachineId: string;
}>): MachineTransferScopeKey {
  return `${params.userId}:${params.sourceMachineId}`;
}

function buildMachineTransferKey(params: Readonly<{
  userId: string;
  sourceMachineId: string;
  targetMachineId: string;
  transferId: string;
}>): MachineTransferKey {
  return `${params.userId}:${params.sourceMachineId}:${params.targetMachineId}:${params.transferId}`;
}

function clearMachineTransferKey(key: MachineTransferKey): void {
  globalBlockedTransfers.delete(key);
  globalTransferBytesByKey.delete(key);
  globalTransferSocketsByKey.delete(key);
  const scopeKey = globalTransferScopeByKey.get(key);
  if (scopeKey) {
    globalTransferScopeByKey.delete(key);
    const active = globalActiveTransfersByScope.get(scopeKey);
    active?.delete(key);
    if (active && active.size === 0) {
      globalActiveTransfersByScope.delete(scopeKey);
    }
  }
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
  const socketTransferKeys = new Set<MachineTransferKey>();
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
    const transferKey = buildMachineTransferKey({ userId, sourceMachineId, targetMachineId, transferId });

    if (parsed.data.envelope.kind === 'finish' || parsed.data.envelope.kind === 'abort') {
      clearMachineTransferKey(transferKey);
      socketTransferKeys.delete(transferKey);
    } else if (parsed.data.envelope.kind === 'chunk') {
      if (payloadSizeBytes === null) {
        socket.emit(SOCKET_RPC_EVENTS.ERROR, {
          type: 'machine-transfer',
          error: 'Invalid machine transfer payload',
        });
        return;
      }

      if (globalBlockedTransfers.has(transferKey)) {
        socket.emit(SOCKET_RPC_EVENTS.ERROR, {
          type: 'machine-transfer',
          error: MACHINE_TRANSFER_MAX_BYTES_ERROR,
        });
        return;
      }

      if (!globalTransferBytesByKey.has(transferKey)) {
        const active = globalActiveTransfersByScope.get(scopeKey) ?? new Set<MachineTransferKey>();
        if (!globalActiveTransfersByScope.has(scopeKey)) {
          globalActiveTransfersByScope.set(scopeKey, active);
        }
        if (active.size >= maxActiveTransfersPerSocket) {
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
        active.add(transferKey);
        globalTransferScopeByKey.set(transferKey, scopeKey);
      }

      const sockets = globalTransferSocketsByKey.get(transferKey) ?? new Set<string>();
      sockets.add(socket.id);
      globalTransferSocketsByKey.set(transferKey, sockets);
      socketTransferKeys.add(transferKey);

      const priorBytes = globalTransferBytesByKey.get(transferKey) ?? 0;
      const nextBytes = priorBytes + payloadSizeBytes;
      if (typeof ctx.serverRoutedTransferMaxBytes === 'number') {
        if (nextBytes > ctx.serverRoutedTransferMaxBytes) {
          globalBlockedTransfers.add(transferKey);
          globalTransferBytesByKey.set(transferKey, nextBytes);
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
      }
      globalTransferBytesByKey.set(transferKey, nextBytes);
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
    for (const transferKey of socketTransferKeys) {
      const sockets = globalTransferSocketsByKey.get(transferKey);
      if (!sockets) continue;
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        clearMachineTransferKey(transferKey);
      } else {
        globalTransferSocketsByKey.set(transferKey, sockets);
      }
    }
    socketTransferKeys.clear();
  });
}
