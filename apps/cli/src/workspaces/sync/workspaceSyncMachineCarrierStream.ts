import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import type { WorkspaceSyncSeedCarrierV1 } from '@happier-dev/protocol/socketRpc';

type WorkspaceSyncMachineTunnelTarget = Readonly<{
  sourceMachineId: string;
  targetMachineId: string;
  signal?: AbortSignal;
}>;

export type WorkspaceSyncMachineTunnelOpenInput =
  | (WorkspaceSyncMachineTunnelTarget & Readonly<{
      flow: 'file_transfer';
      admittedSeed?: Readonly<{
        prepare: (publicKey: string) => Promise<WorkspaceSyncSeedCarrierV1 | undefined>;
      }>;
    }>)
  | (WorkspaceSyncMachineTunnelTarget & Readonly<{
      flow: 'workspace_sync';
      operationId: string;
    }>);

type MachineTunnelLifecycle = Readonly<{
  localPort: number;
  observedPath: 'direct' | 'relay' | 'unknown';
  close(): Promise<void>;
}>;

export type FiniteTransferMachineTunnel = MachineTunnelLifecycle & Readonly<{
  localCapability?: never;
}>;

export type WorkspaceSyncMachineTunnel = MachineTunnelLifecycle & Readonly<{
  localCapability: string;
}>;

/**
 * Lane 06 owns the authenticated Iroh lifecycle and exposes only its exact
 * per-stream loopback port. Lane 08 connects raw Mutagen bytes to that port;
 * it never handles QUIC, grants, handshakes, routing, or fallback selection.
 */
export type WorkspaceSyncMachineTunnelOpen = {
  (input: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'file_transfer' }>): Promise<FiniteTransferMachineTunnel>;
  (input: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'workspace_sync' }>): Promise<WorkspaceSyncMachineTunnel>;
};

export type WorkspaceSyncMachineTunnelConnection = Readonly<{
  stream: Socket;
  stop(): Promise<void>;
}>;

function invalidTunnelPort(): Error {
  return Object.assign(new Error('Workspace sync machine tunnel did not expose a valid loopback port'), {
    code: 'machine_carrier_unavailable',
  });
}

async function throwAfterTunnelCleanup(
  tunnel: WorkspaceSyncMachineTunnel,
  error: unknown,
): Promise<never> {
  try {
    await tunnel.close();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      'Workspace sync machine tunnel setup and cleanup both failed',
    );
  }
  throw error;
}

export async function connectWorkspaceSyncMachineTunnel(
  tunnel: WorkspaceSyncMachineTunnel,
  signal?: AbortSignal,
): Promise<WorkspaceSyncMachineTunnelConnection> {
  if (!Number.isInteger(tunnel.localPort) || tunnel.localPort < 1 || tunnel.localPort > 65_535) {
    return await throwAfterTunnelCleanup(tunnel, invalidTunnelPort());
  }
  if (!/^[0-9a-f]{64}$/.test(tunnel.localCapability)) {
    return await throwAfterTunnelCleanup(tunnel, invalidTunnelPort());
  }
  try {
    signal?.throwIfAborted();
  } catch (error) {
    return await throwAfterTunnelCleanup(tunnel, error);
  }
  const socket = connect({
    host: '127.0.0.1',
    port: tunnel.localPort,
    allowHalfOpen: true,
  });
  socket.setNoDelay(true);
  let stopped = false;
  let stopAttempt: Promise<void> | null = null;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    if (stopAttempt) return await stopAttempt;
    signal?.removeEventListener('abort', abort);
    const attempt = tunnel.close().then(() => { stopped = true; });
    stopAttempt = attempt;
    try {
      await attempt;
    } catch (error) {
      if (stopAttempt === attempt) stopAttempt = null;
      throw error;
    }
  };
  const abort = (): void => {
    socket.destroy(signal?.reason instanceof Error ? signal.reason : undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await once(socket, 'connect');
    socket.write(tunnel.localCapability, 'ascii');
    if (signal?.aborted) {
      abort();
      signal.throwIfAborted();
    }
    return { stream: socket, stop };
  } catch (error) {
    socket.destroy();
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Workspace sync machine tunnel connection and cleanup both failed',
      );
    }
    throw error;
  }
}
