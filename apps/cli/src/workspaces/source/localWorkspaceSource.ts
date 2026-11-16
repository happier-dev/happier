// Same specifiers as the leaves this source replaced, so OS-boundary test doubles keep applying.
import { spawn } from 'child_process';
import { accessSync, closeSync, constants as fsConstants, openSync, writeSync } from 'node:fs';
import { copyFile, symlink, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, rmdir, stat, writeFile, type FileHandle } from 'fs/promises';
import path, { delimiter as PATH_DELIMITER } from 'node:path';

import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';
import { startDirectoryTopologyWatchers } from '@/integrations/watcher/startDirectoryTopologyWatcher';
import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { requireJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/requireJavaScriptRuntimeExecutable';
import { commitGuardedFileReplace } from '@/rpc/handlers/fileSystem/commitGuardedFileReplace';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { isBun } from '@/utils/runtime';

import type { WorkspaceChildProcess, WorkspaceSource } from './workspaceSource';

function withTreeTermination(child: ReturnType<typeof spawn>): WorkspaceChildProcess {
  return Object.assign(child, { terminateTree: () => terminateProcessTree(child) }) as unknown as WorkspaceChildProcess;
}

function isSafeCommandName(command: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(command);
}

/** PATH lookup on this Machine; the local source's executable resolution. */
export function resolveLocalExecutableOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  if (!isSafeCommandName(command)) return null;
  if (process.platform === 'win32') return resolveWindowsCommandOnPath(command, env);
  const pathRaw = typeof env.PATH === 'string' ? env.PATH.trim() : '';
  if (!pathRaw) return null;
  for (const dir of pathRaw.split(PATH_DELIMITER).map((entry) => entry.trim()).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH entries.
    }
  }
  return null;
}

/**
 * Workspace bytes come only from regular files (directories keep their EISDIR
 * reads). A member can plant a FIFO or a device link in a folder this daemon
 * reads for other people; opening non-blocking and checking the opened handle
 * settles both as `workspace_file_not_regular` instead of parking a filesystem
 * thread on the FIFO or streaming an endless device into memory.
 */
async function openWorkspaceFile(target: string, options?: Readonly<{ noFollow?: boolean }>): Promise<FileHandle> {
  const handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0)
    | (options?.noFollow ? fsConstants.O_NOFOLLOW ?? 0 : 0));
  try {
    const stats = await handle.stat();
    if (stats.isFile() || stats.isDirectory()) return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  throw Object.assign(new Error('Workspace path is not a regular file'), { code: 'workspace_file_not_regular' });
}

/** This process's disk: today's native leaves, unchanged. */
export const localWorkspaceSource: WorkspaceSource = Object.freeze<WorkspaceSource>({
  kind: 'local' as const,
  id: 'local',
  stat: (target: string) => stat(target),
  lstat: (target: string) => lstat(target),
  readdir: (target: string) => readdir(target, { withFileTypes: true }),
  realpath: (target: string) => realpath(target),
  readlink: (target: string) => readlink(target),
  readFile: async (target: string) => {
    const handle = await openWorkspaceFile(target);
    try { return await readFile(handle); } finally { await handle.close(); }
  },
  open: (target: string, options?: Readonly<{ noFollow?: boolean }>) => openWorkspaceFile(target, options),
  writeFile: (target: string, bytes: Uint8Array) => writeFile(target, bytes),
  mkdir: async (target: string, options?: Readonly<{ recursive?: boolean; mode?: number }>) => { await mkdir(target, options); },
  rmdir: target => rmdir(target),
  rename: (from: string, to: string) => rename(from, to),
  rm: (target: string, options?: Readonly<{ recursive?: boolean; force?: boolean }>) => rm(target, options),
  copyFile: (from: string, to: string) => copyFile(from, to),
  symlink: (target: string, path: string) => symlink(target, path),
  openWrite: (target: string, options?: Readonly<{ mode?: number }>) => {
    const descriptor = openSync(target, 'wx', options?.mode ?? 0o644);
    return {
      write: (bytes: Uint8Array) => { let offset = 0; while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset); },
      close: () => closeSync(descriptor),
    };
  },
  replaceFile: commitGuardedFileReplace as WorkspaceSource['replaceFile'],
  resolveExecutable: (command: string, env: NodeJS.ProcessEnv) => resolveLocalExecutableOnPath(command, env),
  spawn: (request) => withTreeTermination(spawn(request.command, [...request.args], {
    ...(request.cwd !== undefined ? { cwd: request.cwd } : {}), ...(request.env ? { env: request.env } : {}), stdio: ['pipe', request.stdoutFd ?? 'pipe', 'pipe'], windowsHide: true,
  })),
  toolLaunch: async (request) => request.tool === 'difftastic'
    // Loaded on use: the difftastic integration graph must not load with every workspace consumer.
    ? { command: await (await import('@/integrations/difftastic/index')).resolveDifftasticBinaryPath(), args: request.args }
    : {
      command: await requireJavaScriptRuntimeExecutable({ isBunRuntime: isBun(), targetLabel: 'ripgrep launcher' }),
      args: [resolveCliRuntimeAssetPath('scripts', 'ripgrep_launcher.cjs'), '--stdin'],
      // Payload size is governed by the caller, never an OS argv limit.
      stdin: JSON.stringify({ args: request.args, ...(request.paths ? { paths: request.paths } : {}) }),
    },
  watchTree: (targets, options) => startDirectoryTopologyWatchers(targets, options),
  watchFile: (target, onChange, options) => startFileWatcher(target, onChange, options),
});
