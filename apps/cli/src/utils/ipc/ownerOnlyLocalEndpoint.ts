import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { chmod, rm } from 'node:fs/promises';
import { connect as netConnect, type Server, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { configuration } from '@/configuration';

import {
  startProcessCustodySecurePipeRelay,
  type OwnerOnlyLocalPipePrefix,
  type ProcessCustodySecurePipeRelay,
  type ProcessCustodySecurePipeRelayStart,
} from '@/subprocess/supervision/processCustodySecurePipeRelay';

/**
 * Same-OS-user local endpoint owner: a unix socket secured to 0600 (callers keep it inside a 0700
 * directory), or on Windows a named pipe whose owner-SID-only DACL is applied by the native secure
 * relay (`processcustody secure-pipe-relay`). Never a network listener for callers.
 */
export type { OwnerOnlyLocalPipePrefix } from '@/subprocess/supervision/processCustodySecurePipeRelay';

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

/** unix-domain socket paths are limited to 104 bytes on macOS (108 on Linux), including the NUL. */
const MAX_SOCKET_PATH_BYTES = 103;

/** Ours, not a symlink, and no group/other bits: nobody else can read, replace or swap what it holds. */
export function isOwnerOnlyPath(path: string): boolean {
  const entry = lstatSync(path);
  return !entry.isSymbolicLink() && entry.uid === process.getuid?.() && (entry.mode & 0o077) === 0;
}

/**
 * The owner-only POSIX directory this OS user's local sockets live under: the first root where
 * `leaf` fits the unix socket path limit. $XDG_RUNTIME_DIR (already ours and 0700), else the Happier
 * home's private `run/`, else a private `~/.happier-run`, else a per-user `happier-<uid>` under the
 * system temp dir. Never the shared temp dir itself, where a same-uid process allowed to write there
 * (a provider sandbox) could replace a listener. The temp directory is created 0700; one that already
 * exists must be ours, not a symlink and exactly 0700, or it is refused, never repaired.
 */
export function resolveOwnerOnlySocketRoot(leaf: string): string {
  const fits = (root: string) => Buffer.byteLength(join(root, leaf)) <= MAX_SOCKET_PATH_BYTES;
  const runtime = process.env.XDG_RUNTIME_DIR;
  try {
    if (runtime && fits(runtime) && isOwnerOnlyPath(runtime)) return runtime;
  } catch { /* unavailable: fall through */ }
  for (const root of [join(configuration.happyHomeDir, 'run'), join(homedir(), '.happier-run')]) {
    if (!fits(root)) continue;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    if (isOwnerOnlyPath(root)) return root;
  }
  const temp = join(tmpdir(), `happier-${process.getuid?.() ?? 'user'}`);
  if (!fits(temp)) throw new Error('No owner-private directory can hold a local socket path');
  try {
    mkdirSync(temp, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const entry = lstatSync(temp);
  if (entry.isSymbolicLink() || !entry.isDirectory() || entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o700) {
    throw Object.assign(new Error('The per-user socket directory under the system temp dir is not private to this user'),
      { code: 'owner_only_socket_root_unsafe' });
  }
  return temp;
}
