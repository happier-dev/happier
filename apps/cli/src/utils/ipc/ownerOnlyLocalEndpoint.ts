import { chmod, rm } from 'node:fs/promises';
import { connect as netConnect, type Server, type Socket } from 'node:net';

import {
  startProcessCustodySecurePipeRelay,
  type ProcessCustodySecurePipeRelay,
  type ProcessCustodySecurePipeRelayStart,
} from '@/subprocess/supervision/processCustodySecurePipeRelay';

/**
 * Same-OS-user local endpoint owner: a unix socket secured to 0600 (callers keep it inside a 0700
 * directory), or on Windows a named pipe whose owner-SID-only DACL is applied by the native secure
 * relay (`processcustody secure-pipe-relay`). Never a network listener for callers.
 */
export type OwnerOnlyLocalPipePrefix = 'happier-workspace-sync-' | 'happier-session-rpc-';

export interface OwnerOnlyLocalEndpoint {
  readonly endpointPath: string;
  readonly kind: 'unix' | 'named_pipe';
  connect(path?: string): Socket;
  listen(server: Server, path?: string): Promise<void>;
  secure(path?: string): Promise<void>;
  remove(path?: string): Promise<void>;
  peerPid(socket: Socket): number | undefined;
}

export function createOwnerOnlyLocalEndpoint(input: Readonly<{
  endpointPath: string;
  /** Named-pipe prefix the native secure relay admits; a non-pipe path is mapped under it on Windows. */
  windowsPipePrefix: OwnerOnlyLocalPipePrefix;
  platform?: NodeJS.Platform;
  startWindowsRelay?: ProcessCustodySecurePipeRelayStart;
}>): OwnerOnlyLocalEndpoint {
  const isWindows = (input.platform ?? process.platform) === 'win32';
  const startWindowsRelay = input.startWindowsRelay ?? startProcessCustodySecurePipeRelay;
  const endpointPath = isWindows && !input.endpointPath.startsWith('\\\\.\\pipe\\')
    ? `\\\\.\\pipe\\${input.windowsPipePrefix}${Buffer.from(input.endpointPath).toString('hex').slice(-48)}`
    : input.endpointPath;
  const peerPids = new WeakMap<Socket, number>();
  let windowsRelay: ProcessCustodySecurePipeRelay | undefined;
  return {
    endpointPath,
    kind: isWindows ? 'named_pipe' : 'unix',
    connect: (path = endpointPath) => netConnect(path),
    listen: async (server, path = endpointPath) => {
      if (isWindows) {
        if (windowsRelay) throw new Error('owner-only named-pipe relay is already listening');
        windowsRelay = await startWindowsRelay({
          pipeName: path,
          onConnection: (socket, peerPid) => {
            peerPids.set(socket, peerPid);
            server.emit('connection', socket);
          },
        });
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(path);
      });
    },
    secure: async (path = endpointPath) => {
      if (!isWindows) await chmod(path, 0o600);
    },
    remove: async (path = endpointPath) => {
      if (isWindows) {
        const relay = windowsRelay;
        windowsRelay = undefined;
        await relay?.close();
      } else {
        await rm(path, { force: true });
      }
    },
    peerPid: (socket) => peerPids.get(socket),
  };
}

