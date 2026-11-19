import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile as readHostFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { PluginError } from '@happier-dev/plugin-sdk/errors';

import type { SessionHolderChild, SessionHolderStreamProcess } from '@/subprocess/supervision/sessionHolder';
import { attachSessionHolderWorkspaceChannel } from '@/subprocess/supervision/sessionHolder';
import type { ManagedSessionTarget } from '@/machines/managed/acquire';
import {
  runNativeConfinedWorkspaceSyncDelete,
  runNativeConfinedWorkspaceSyncObserve,
  runNativeConfinedWorkspaceSyncRead,
  type WorkspaceSyncNativeConfinedDependencies,
} from '@/workspaces/sync/workspaceSyncNativeConfinedFileSystem';

import type { WorkspaceChildProcess, WorkspaceDirent, WorkspaceEntryStats, WorkspaceReadHandle, WorkspaceSource } from './workspaceSource';
import { runWithWorkspaceSource } from './workspaceSource';
import { holderWorkspaceRelativePath, mapHolderWorkspacePath, resolveHolderWorkspaceCommand } from './holderWorkspaceCommand';

export { resolveHolderWorkspaceCommand } from './holderWorkspaceCommand';

/** Finite filesystem and command scope on one admitted target root. */
export async function runWithHolderWorkspaceSource<T>(input: Readonly<{
  target: Pick<ManagedSessionTarget, 'id' | 'holderPath' | 'helperPath' | 'openChannel'>;
  rootPath: string;
  signal: AbortSignal;
}>, run: () => Promise<T>): Promise<T> {
  const channel = input.target.openChannel([input.target.holderPath, 'workspace', '--root', input.rootPath], input.signal);
  const holder = await attachSessionHolderWorkspaceChannel(channel).catch(error => { channel.destroy(); throw error; });
  try {
    const source = createHolderWorkspaceSource({ id: input.target.id, rootPath: input.rootPath,
      helperPath: input.target.helperPath, holder });
    return await runWithWorkspaceSource(source, run);
  } finally { holder.detach(); channel.destroy(); }
}

type TargetEntry = Readonly<{ kind: string; size: number; atimeMs: number; mtimeMs: number; ctimeMs: number; mode: number; dev: number; ino: number }>;
type TargetListEntry = Readonly<{ name: string; kind: string; stats?: Pick<TargetEntry, 'size' | 'mtimeMs'> | null }>;
type TargetResult = Readonly<{ status: string; entry?: TargetEntry; entries?: readonly TargetListEntry[];
  target?: string; path?: string; sha256?: string; code?: string; message?: string }>;

function unavailable(operation: string): PluginError {
  return new PluginError({ code: 'workspace_source_operation_unavailable', retryable: false,
    message: `This workspace runs in a container target; ${operation} is not available there` });
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function entryStats(entry: TargetEntry): WorkspaceEntryStats {
  return {
    isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory', isSymbolicLink: () => entry.kind === 'symlink',
    size: entry.size, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs, mtime: new Date(entry.mtimeMs),
    dev: entry.dev, ino: entry.ino, mode: entry.mode,
  };
}

/**
 * The workspace source of a Session held in a target (container/sandbox): the
 * Session's holder, reached over the target's provider channel, runs every
 * operation inside the target. Paths are the target's own absolute paths under
 * the admitted root; nothing here reads this Machine's disk (except a host-staged
 * upload being published into the target).
 *
 * - Commands (Git, ripgrep, difftastic, language servers) are holder streams;
 *   terminals are holder `pty` streams; change events are holder `watch` streams.
 * - Files and metadata go through the process-custody helper in the target (the
 *   helper owns confinement): `workspace-confined-meta` (lstat/stat/list/readlink/
 *   realpath), `workspace-confined-write` (put with expectation, mkdir, rename),
 *   and the existing read/observe/delete exchanges.
 * - Creating symbolic links has no helper operation and rejects with the typed
 *   `workspace_source_operation_unavailable`; nothing falls back to local.
 */
export function createHolderWorkspaceSource(input: Readonly<{
  /** Stable target identity (keys watches and caches per source). */
  id: string;
  /** The admitted workspace root as requests address it (the Session's path). */
  rootPath: string;
  /**
   * The same workspace's root inside the target (the holder's working directory),
   * when the guest keeps it at another path (a container mount, a remote home).
   * Every path crosses as a path relative to the root, so only the helper's
   * absolute root differs. Default: `rootPath`.
   */
  guestRootPath?: string;
  /** The workspace client; a function is asked on every operation (a client that lost its holder is replaced there). */
  holder: SessionHolderChild | (() => SessionHolderChild);
  /** The digest-checked process-custody helper inside the target. */
  helperPath: string;
}>): WorkspaceSource {
  const root = path.posix.resolve(input.rootPath);
  const guestRoot = path.posix.resolve(input.guestRootPath ?? input.rootPath);
  const relative = (target: string) => holderWorkspaceRelativePath(root, target);
  const holder = (): SessionHolderChild => typeof input.holder === 'function' ? input.holder() : input.holder;
  const helper: WorkspaceSyncNativeConfinedDependencies = {
    platform: 'linux',
    resolveExecutable: () => input.helperPath,
    spawnChild: (executable, args) => holder().spawnStream({ argv: [executable, ...args] }) as never,
  };
  /** One request line (+ raw content) in, one result line out, through a helper process in the target. */
  const runHelper = (command: 'workspace-confined-meta' | 'workspace-confined-write', request: Record<string, unknown>, content?: Uint8Array) =>
    new Promise<TargetResult>((resolve, reject) => {
      const child = holder().spawnStream({ argv: [input.helperPath, command] });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
      child.once('error', reject);
      // A holder that refuses or loses the start fails the queued request writes too; that is this exchange's failure.
      child.stdin.on('error', reject);
      child.once('close', () => {
        try { resolve(JSON.parse(out.split('\n')[0] ?? '') as TargetResult); }
        catch { reject(errno('io_failed', 'Target helper returned no result')); }
      });
      child.stdin.write(`${JSON.stringify({ v: 1, rootPath: guestRoot, ...request })}\n`);
      if (content?.byteLength) child.stdin.write(Buffer.from(content));
      child.stdin.end();
    });
  const meta = async (target: string, op: 'lstat' | 'stat' | 'list' | 'readlink' | 'realpath' | 'access-executable') => {
    const result = await runHelper('workspace-confined-meta', { relativePath: relative(target), op });
    if (result.status === 'missing') throw errno('ENOENT', `No such file or directory: ${target}`);
    if (result.status === 'error') {
      throw result.code === 'not_directory' ? errno('ENOTDIR', result.message ?? 'Not a directory')
        : result.code === 'EACCES' ? errno('EACCES', result.message ?? 'Permission denied')
        : result.code === 'not_link' ? errno('EINVAL', result.message ?? 'Not a link')
          : result.code === 'symlink_loop' ? errno('ELOOP', result.message ?? 'Too many links')
            : new PluginError({ code: result.code ?? 'workspace_root_unsafe', message: result.message ?? 'Refused', retryable: false });
    }
    return result;
  };
  const write = async (request: Record<string, unknown>, content?: Uint8Array) => {
    const result = await runHelper('workspace-confined-write', request, content);
    if (result.status === 'error') {
      throw result.code === 'not_directory' ? errno('ENOTDIR', result.message ?? 'Not a directory')
        : new PluginError({ code: result.code ?? 'workspace_root_unsafe', message: result.message ?? 'Refused', retryable: false });
    }
    return result;
  };
  const openExclusiveFile = async (target: string) => {
    const relativePath = relative(target);
    const child = holder().spawnStream({ argv: [input.helperPath, 'workspace-confined-write'] });
    const lines = createInterface({ input: child.stdout });
    const records = lines[Symbol.asyncIterator]();
    let transportError: Error | undefined;
    const failed = (error: Error) => { transportError = error; lines.close(); };
    child.once('error', failed);
    child.stdin.on('error', failed);
    const terminated = new Promise<number | null>(resolve => child.once('close', resolve));
    const next = async () => {
      const result = await records.next();
      if (result.done) throw transportError ?? errno('io_failed', 'Target helper returned no result');
      const record = JSON.parse(result.value) as TargetResult;
      if (record.status === 'exists') throw errno('EEXIST', `File exists: ${target}`);
      if (record.status === 'error') throw new PluginError({ code: record.code ?? 'workspace_root_unsafe',
        message: record.message ?? 'Refused', retryable: false });
      return record;
    };
    child.stdin.write(`${JSON.stringify({ v: 1, rootPath: guestRoot, op: 'open-exclusive', relativePath })}\n`);
    try {
      const opened = await next();
      if (opened.status !== 'opened' || !opened.entry) throw errno('io_failed', 'Target helper did not open the file');
      let settled: Promise<void> | undefined;
      const finish = (record?: Readonly<{ relativePath: string; mode?: number }>) => settled ??= (async () => {
        child.stdin.end(record ? `${JSON.stringify(record)}\n` : undefined);
        if ((await next()).status !== 'done' || await terminated !== 0) throw errno('io_failed', 'Target helper did not finish the exclusive file');
      })().finally(() => lines.close());
      return {
        mode: opened.entry.mode,
        writeFrom: (sourcePath: string, mode?: number) => finish({ relativePath: relative(sourcePath), mode }),
        close: () => settled ? settled.catch(() => undefined) : finish(),
      };
    } catch (error) {
      child.stdin.end();
      lines.close();
      throw error;
    }
  };
  const spawn = (request: Parameters<WorkspaceSource['spawn']>[0]): WorkspaceChildProcess => {
    const child = holder().spawnStream(resolveHolderWorkspaceCommand(root, request, guestRoot));
    if (request.stdoutFd !== undefined) child.stdout.pipe(createWriteStream('', { fd: request.stdoutFd, autoClose: false }));
    return child as unknown as WorkspaceChildProcess;
  };
  const readFile = async (target: string): Promise<Buffer> => {
    const entry = (await meta(target, 'stat')).entry!;
    const outcome = await runNativeConfinedWorkspaceSyncRead({ rootPath: guestRoot, relativePath: relative(target), maxBytes: Math.max(1, entry.size) }, helper);
    if (outcome.status !== 'content') {
      throw outcome.status === 'missing' ? errno('ENOENT', `No such file: ${target}`) : Object.assign(new Error(`Target file is not readable (${outcome.status})`), { code: outcome.status });
    }
    return Buffer.from(outcome.content);
  };
  const remove = async (target: string, options?: Readonly<{ recursive?: boolean; force?: boolean }>) => {
    const relativePath = relative(target);
    const expectation = await runNativeConfinedWorkspaceSyncObserve({ rootPath: guestRoot, relativePath }, helper);
    if (expectation.kind === 'missing') {
      if (options?.force) return;
      throw errno('ENOENT', `No such file or directory: ${target}`);
    }
    if (expectation.kind === 'directory' && !options?.recursive) throw errno('EISDIR', `Is a directory: ${target}`);
    await runNativeConfinedWorkspaceSyncDelete({ rootPath: guestRoot, relativePath, expectedKind: expectation.kind,
      ...('digest' in expectation && typeof expectation.digest === 'string' ? { expectedDigest: expectation.digest } : {}) }, helper);
  };
  const put = (target: string, bytes: Uint8Array, expect: string) =>
    write({ op: 'put', relativePath: relative(target), sizeBytes: bytes.byteLength, expect }, bytes);
  const watch = (target: string, recursive: boolean, onEvent: (event: Readonly<{ path: string; kind: 'directory' | 'file' | 'unknown'; event: string }>) => void,
    onReady?: () => void, onUnavailable?: (error: Error) => void): (() => void) => {
    const stream: SessionHolderStreamProcess = holder().spawnStream({ op: 'watch', path: relative(target), recursive });
    let rest = '';
    stream.stdout.on('data', (chunk: Buffer) => {
      rest += chunk.toString('utf8');
      let end: number;
      while ((end = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, end);
        rest = rest.slice(end + 1);
        const parsed = JSON.parse(line) as { path: string; kind: 'directory' | 'file' | 'unknown'; event: string };
        onEvent({ ...parsed, path: path.posix.join(root, parsed.path) });
      }
    });
    stream.once('spawn', () => onReady?.());
    stream.once('error', (error: Error) => onUnavailable?.(error));
    return () => { stream.kill('SIGTERM'); };
  };
  const source: WorkspaceSource = {
    nativeHelperPath: input.helperPath,
    kind: 'target' as const,
    id: input.id,
    commandPaths: {
      toCommandPath: target => mapHolderWorkspacePath(root, guestRoot, target),
      fromCommandPath: target => mapHolderWorkspacePath(guestRoot, root, target),
    },
    filePublication: {
      async copyFileExclusive(from, to) {
        const result = await write({ op: 'copy-exclusive', relativePath: relative(from), toRelativePath: relative(to) });
        if (result.status === 'missing') throw errno('ENOENT', `No such file: ${from}`);
        if (result.status === 'exists') throw errno('EEXIST', `File exists: ${to}`);
        if (result.status !== 'done' || !result.entry) throw errno('io_failed', 'Target helper did not copy the file');
        return { atime: new Date(result.entry.atimeMs), mtime: new Date(result.entry.mtimeMs) };
      },
      async setFileTimes(target, atime, mtime) {
        await write({ op: 'set-times', relativePath: relative(target), atimeMs: atime.getTime(), mtimeMs: mtime.getTime() });
      },
      async accessExecutable(target) { await meta(target, 'access-executable'); },
      openExclusiveFile,
    },
    stat: async target => entryStats((await meta(target, 'stat')).entry!),
    lstat: async target => entryStats((await meta(target, 'lstat')).entry!),
    // The native JSON codec omits an empty entries slice.
    readdir: async target => ((await meta(target, 'list')).entries ?? []).map((entry): WorkspaceDirent => ({
      name: entry.name, isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory', isSymbolicLink: () => entry.kind === 'symlink',
      ...(entry.stats === undefined ? {} : {
        stats: entry.stats === null ? null : { size: entry.stats.size, mtime: new Date(entry.stats.mtimeMs) },
      }),
    })),
    realpath: async target => path.posix.join(root, (await meta(target, 'realpath')).path ?? ''),
    readlink: async target => {
      // A link's raw text; an absolute target inside the guest root is reported at the addressed root.
      const linkTarget = (await meta(target, 'readlink')).target!;
      const inside = path.posix.isAbsolute(linkTarget) ? path.posix.relative(guestRoot, linkTarget) : null;
      return inside !== null && inside !== '..' && !inside.startsWith('../') ? path.posix.join(root, inside) : linkTarget;
    },
    readFile,
    open: async (target) => {
      const bytes = await readFile(target);
      const stats = await source.lstat(target);
      const handle: WorkspaceReadHandle = {
        read: (async (buffer: Uint8Array, offset: number = 0, length: number = buffer.byteLength - offset, position: number | null = 0) => {
          const start = position ?? 0;
          const slice = bytes.subarray(start, start + length);
          Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(slice, offset);
          return { bytesRead: slice.byteLength, buffer };
        }) as WorkspaceReadHandle['read'],
        close: async () => undefined,
        stat: async () => stats,
      };
      return handle;
    },
    writeFile: async (target, bytes) => { await put(target, bytes, 'any'); },
    mkdir: async (target, options) => {
      const result = await write({ op: 'mkdir', relativePath: relative(target), recursive: options?.recursive === true,
        ...(options?.mode === undefined ? {} : { mode: options.mode }) });
      if (result.status === 'exists') throw errno('EEXIST', `File exists: ${target}`);
    },
    rmdir: async target => {
      const result = await write({ op: 'rmdir', relativePath: relative(target) });
      if (result.status === 'missing') throw errno('ENOENT', `No such directory: ${target}`);
    },
    rename: async (from, to) => {
      const result = await write({ op: 'rename', relativePath: relative(from), toRelativePath: relative(to) });
      if (result.status === 'missing') throw errno('ENOENT', `No such file or directory: ${from}`);
    },
    rm: remove,
    copyFile: async (from, to) => { await put(to, await readFile(from), 'any'); },
    symlink: async () => { throw unavailable('creating links'); },
    openWrite: (target) => {
      // Exclusive create: the bytes are published once, at close, with an `absent` expectation.
      const chunks: Buffer[] = [];
      return {
        write: (bytes: Uint8Array) => { chunks.push(Buffer.from(bytes)); },
        close: async () => {
          const result = await put(target, Buffer.concat(chunks), 'absent');
          if (result.status === 'exists') throw errno('EEXIST', `File exists: ${target}`);
        },
      };
    },
    replaceFile: (async (request: Parameters<WorkspaceSource['replaceFile']>[0]) => {
      const fail = (errorCode: 'expected_file_absent' | 'hash_mismatch' | 'expected_file_missing' | 'file_replace_failed', error: string) =>
        ({ success: false as const, errorCode, error });
      try {
        const expect = request.expectation === undefined ? 'any' : request.expectation === null ? 'absent' : request.expectation;
        if (request.source.kind === 'absent') {
          const current = await meta(request.destPath, 'lstat').catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (request.expectation === null && current) return fail('expected_file_absent', 'File already exists but was expected to be new');
          if (typeof request.expectation === 'string') {
            if (!current) return fail('expected_file_missing', 'File does not exist but hash was provided');
            const actual = createHash('sha256').update(await readFile(request.destPath)).digest('hex');
            if (actual !== request.expectation) return fail('hash_mismatch', 'File content changed since it was read');
          }
          if (current) await remove(request.destPath);
          return { success: true as const, hash: null };
        }
        if (request.source.kind === 'move') {
          const moved = await readFile(request.source.path);
          if (createHash('sha256').update(moved).digest('hex') !== request.source.expectedHash) return fail('hash_mismatch', 'File content changed since it was read');
          const result = await put(request.destPath, moved, 'absent');
          if (result.status === 'exists') return fail('expected_file_absent', 'File already exists but was expected to be new');
          await remove(request.source.path);
          return { success: true as const, hash: request.source.expectedHash };
        }
        // A staged upload lives in this Machine's private transfer staging; its bytes are published into the target.
        const bytes = request.source.kind === 'bytes' ? request.source.bytes : await readHostFile(request.source.path);
        const result = await put(request.destPath, bytes, expect);
        if (result.status === 'written') return { success: true as const, hash: result.sha256! };
        if (result.status === 'exists') return fail('expected_file_absent', 'File already exists but was expected to be new');
        if (result.status === 'changed') return fail('hash_mismatch', 'File content changed since it was read');
        return fail('expected_file_missing', 'File does not exist but hash was provided');
      } catch (error) {
        return fail('file_replace_failed', error instanceof Error ? error.message : 'Failed to replace file');
      }
    }) as WorkspaceSource['replaceFile'],
    resolveExecutable: async (command: string) => {
      if (path.posix.isAbsolute(command)) return command;
      const reply = await holder().request({ op: 'which', command });
      if (reply.ok !== true) {
        throw new PluginError({ code: 'agent_cli_target_unavailable', retryable: false,
          message: 'The Session target could not resolve a workspace executable' });
      }
      return reply.ok === true && typeof reply.value === 'string' ? reply.value : null;
    },
    spawn,
    // The target's own tools on its PATH; a missing tool is the consumer's typed missing-tool outcome.
    toolLaunch: async (request) => request.tool === 'difftastic'
      ? { command: 'difft', args: request.args }
      : { command: 'rg', args: [...request.args, ...(request.paths?.length ? ['--', ...request.paths] : [])] },
    watchTree: (targets, options) => {
      const disposers = targets.map(target => watch(target.directory, true, (event) => {
        if (event.kind === 'directory' || event.event !== 'change') void target.onStructuralChange(event.path, event.kind);
        else void (target.onFileChange ?? target.onStructuralChange)(event.path);
      }, options?.onReady, options?.onUnavailable));
      return () => { for (const dispose of disposers) dispose(); };
    },
    watchFile: (target, onChange, options) => {
      const directory = path.posix.dirname(target);
      const dispose = watch(directory, false, (event) => {
        if (event.path === target) void onChange(target);
      }, () => { void options?.onWatcherAttached?.(); if (options?.emitInitial) void onChange(target); }, options?.onWatcherUnavailable);
      return dispose;
    },
  };
  return Object.freeze(source);
}
