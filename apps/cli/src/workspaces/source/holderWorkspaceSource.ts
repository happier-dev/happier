import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile as readHostFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { readRpcErrorCode } from '@happier-dev/protocol/rpc/errors';
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

import type {
  WorkspaceBatchCaptureEntry,
  WorkspaceBatchStatEntry,
  WorkspaceCapturedLeaf,
  WorkspaceChildProcess,
  WorkspaceDirent,
  WorkspaceEntryStats,
  WorkspaceReadHandle,
  WorkspaceSource,
} from './workspaceSource';
import { runWithWorkspaceSource } from './workspaceSource';
import { holderWorkspaceRelativePath, mapHolderWorkspacePath, resolveHolderWorkspaceCommand } from './holderWorkspaceCommand';
import {
  closeHolderConfinedWorkers,
  ConfinedWorkerUnsupportedError,
  getHolderConfinedWorkerClient,
  type ConfinedTargetEntry,
  type ConfinedTargetResult,
} from './confinedWorkerClient';

export { resolveHolderWorkspaceCommand } from './holderWorkspaceCommand';
export { closeHolderConfinedWorkers } from './confinedWorkerClient';

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
  } finally {
    closeHolderConfinedWorkers(holder);
    holder.detach();
    channel.destroy();
  }
}

// Bind the positive resolution to the client so a replacement holder resolves its own PATH.
const holderGitExecutables = new WeakMap<SessionHolderChild, Promise<string | null>>();

async function lookupHolderExecutable(holder: SessionHolderChild, command: string): Promise<string | null> {
  const reply = await holder.request({ op: 'which', command });
  if (reply.ok !== true) {
    throw new PluginError({ code: readRpcErrorCode(reply) ?? 'agent_cli_target_unavailable', retryable: false,
      message: 'The Session target could not resolve a workspace executable' });
  }
  return typeof reply.value === 'string' ? reply.value : null;
}

function unavailable(operation: string): PluginError {
  return new PluginError({ code: 'workspace_source_operation_unavailable', retryable: false,
    message: `This workspace runs in a container target; ${operation} is not available there` });
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function entryStats(entry: ConfinedTargetEntry): WorkspaceEntryStats {
  return {
    isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory', isSymbolicLink: () => entry.kind === 'symlink',
    size: entry.size, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs, mtime: new Date(entry.mtimeMs),
    dev: entry.dev, ino: entry.ino, mode: entry.mode,
  };
}

function throwMetaResultError(result: ConfinedTargetResult): never {
  throw result.code === 'not_directory' ? errno('ENOTDIR', result.message ?? 'Not a directory')
    : result.code === 'EACCES' ? errno('EACCES', result.message ?? 'Permission denied')
    : result.code === 'not_link' ? errno('EINVAL', result.message ?? 'Not a link')
      : result.code === 'symlink_loop' ? errno('ELOOP', result.message ?? 'Too many links')
        : new PluginError({ code: result.code ?? 'workspace_root_unsafe', message: result.message ?? 'Refused', retryable: false });
}

function parseCapturedLeafResult(result: ConfinedTargetResult): WorkspaceCapturedLeaf {
  if (result.status === 'missing') return { kind: 'missing' };
  if (result.status === 'error') throwMetaResultError(result);
  if (result.status === 'leaf' && result.entry?.kind === 'file'
    && typeof result.digest === 'string' && typeof result.contentBase64 === 'string') {
    const content = Buffer.from(result.contentBase64, 'base64');
    if (content.toString('base64') !== result.contentBase64 || content.byteLength !== result.entry.size) {
      throw errno('io_failed', 'Target helper returned invalid leaf content');
    }
    return { kind: 'file', entry: entryStats(result.entry), digest: result.digest, content };
  }
  if (result.status === 'link' && result.entry?.kind === 'symlink' && typeof result.target === 'string') {
    return { kind: 'symlink', entry: entryStats(result.entry), target: result.target };
  }
  if (result.status === 'entry' && result.entry) {
    if (result.entry.kind === 'directory') return { kind: 'directory', entry: entryStats(result.entry) };
    if (result.entry.kind === 'file' && typeof result.digest === 'string') {
      return { kind: 'file', entry: entryStats(result.entry), digest: result.digest, content: null };
    }
    return { kind: 'other', entry: entryStats(result.entry) };
  }
  throw errno('io_failed', 'Target helper returned an invalid leaf capture result');
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
 * - Files, metadata, and confined sync/apply exchanges multiplex over one lazy
 *   persistent `workspace-confined-serve --root <guestRoot>` worker per holder
 *   channel (pinning the canonical root dirfd once at startup). Older guest
 *   binaries that lack `workspace-confined-serve` fall back transparently to
 *   the one-shot `workspace-confined-*` helper subcommands.
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
  hold?: () => () => void;
  /** The digest-checked process-custody helper inside the target. */
  helperPath: string;
}>): WorkspaceSource {
  const root = path.posix.resolve(input.rootPath);
  const guestRoot = path.posix.resolve(input.guestRootPath ?? input.rootPath);
  const relative = (target: string) => holderWorkspaceRelativePath(root, target);
  const holder = (): SessionHolderChild => typeof input.holder === 'function' ? input.holder() : input.holder;
  const worker = () => getHolderConfinedWorkerClient(holder(), input.helperPath, guestRoot);
  const helper: WorkspaceSyncNativeConfinedDependencies = {
    platform: 'linux',
    resolveExecutable: () => input.helperPath,
    spawnChild: (executable, args) => holder().spawnStream({ argv: [executable, ...args] }) as never,
  };

  /** Compatibility fallback: one request line (+ raw content) in, one result line out, per one-shot helper spawn. */
  const runLegacyHelper = (command: 'workspace-confined-meta' | 'workspace-confined-write', request: Record<string, unknown>, content?: Uint8Array) =>
    new Promise<ConfinedTargetResult>((resolve, reject) => {
      const child = holder().spawnStream({ argv: [input.helperPath, command] });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
      child.once('error', reject);
      // A holder that refuses or loses the start fails the queued request writes too; that is this exchange's failure.
      child.stdin.on('error', reject);
      child.once('close', () => {
        try { resolve(JSON.parse(out.split('\n')[0] ?? '') as ConfinedTargetResult); }
        catch { reject(errno('io_failed', 'Target helper returned no result')); }
      });
      child.stdin.write(`${JSON.stringify({ v: 1, rootPath: guestRoot, ...request })}\n`);
      if (content?.byteLength) child.stdin.write(Buffer.from(content));
      child.stdin.end();
    });

  const meta = async (target: string, op: 'lstat' | 'stat' | 'list' | 'readlink' | 'realpath' | 'access-executable') => {
    const relativePath = relative(target);
    let result: ConfinedTargetResult;
    const client = worker();
    if (!client.isUnsupported) {
      try {
        result = await client.meta(op, relativePath);
      } catch (error) {
        if (!(error instanceof ConfinedWorkerUnsupportedError)) throw error;
        result = await runLegacyHelper('workspace-confined-meta', { relativePath, op });
      }
    } else {
      result = await runLegacyHelper('workspace-confined-meta', { relativePath, op });
    }
    if (result.status === 'missing') throw errno('ENOENT', `No such file or directory: ${target}`);
    if (result.status === 'error') throwMetaResultError(result);
    return result;
  };

  const write = async (request: Record<string, unknown>, content?: Uint8Array) => {
    let result: ConfinedTargetResult;
    const client = worker();
    if (!client.isUnsupported) {
      try {
        const { sizeBytes: _sizeBytes, ...workerReq } = request;
        result = await client.write(workerReq, content);
      } catch (error) {
        if (!(error instanceof ConfinedWorkerUnsupportedError)) throw error;
        result = await runLegacyHelper('workspace-confined-write', request, content);
      }
    } else {
      result = await runLegacyHelper('workspace-confined-write', request, content);
    }
    if (result.status === 'error') {
      throw result.code === 'not_directory' ? errno('ENOTDIR', result.message ?? 'Not a directory')
        : new PluginError({ code: result.code ?? 'workspace_root_unsafe', message: result.message ?? 'Refused', retryable: false });
    }
    return result;
  };

  const openExclusiveFileLegacy = async (target: string, relativePath: string) => {
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
      const record = JSON.parse(result.value) as ConfinedTargetResult;
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

  const openExclusiveFile = async (target: string) => {
    const relativePath = relative(target);
    const client = worker();
    if (client.isUnsupported) {
      return await openExclusiveFileLegacy(target, relativePath);
    }
    let opened: Awaited<ReturnType<typeof client.openExclusive>>;
    try {
      opened = await client.openExclusive(relativePath);
    } catch (error) {
      if (error instanceof ConfinedWorkerUnsupportedError) {
        return await openExclusiveFileLegacy(target, relativePath);
      }
      throw error;
    }
    const { result, finish } = opened;
    if (result.status === 'exists') throw errno('EEXIST', `File exists: ${target}`);
    if (result.status === 'error') {
      throw new PluginError({ code: result.code ?? 'workspace_root_unsafe', message: result.message ?? 'Refused', retryable: false });
    }
    if (result.status !== 'opened' || !result.entry || !finish) {
      throw errno('io_failed', 'Target helper did not open the file');
    }
    let settled: Promise<void> | undefined;
    const settle = (record?: Readonly<{ relativePath: string; mode?: number }>) => settled ??= (async () => {
      const done = await finish(record);
      if (done.status === 'error') {
        throw new PluginError({ code: done.code ?? 'workspace_root_unsafe', message: done.message ?? 'Refused', retryable: false });
      }
      if (done.status !== 'done') throw errno('io_failed', 'Target helper did not finish the exclusive file');
    })();
    return {
      mode: result.entry.mode,
      writeFrom: (sourcePath: string, mode?: number) => settle({ relativePath: relative(sourcePath), mode }),
      close: () => settled ? settled.catch(() => undefined) : settle(),
    };
  };

  const spawnDirect = (request: Parameters<WorkspaceSource['spawn']>[0]): WorkspaceChildProcess => {
    const client = holder();
    const child = client.spawnStream(resolveHolderWorkspaceCommand(root, request, guestRoot));
    const gitExecutable = holderGitExecutables.get(client);
    if (gitExecutable) child.once('error', (error: NodeJS.ErrnoException) => {
      // A removed executable can be installed again while the holder remains open.
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') return;
      void gitExecutable.then(executable => {
        if (executable === request.command && holderGitExecutables.get(client) === gitExecutable) holderGitExecutables.delete(client);
      }, () => undefined);
    });
    if (request.stdoutFd !== undefined) child.pipeStdoutTo(createWriteStream('', { fd: request.stdoutFd, autoClose: false }));
    return child as unknown as WorkspaceChildProcess;
  };

  const spawn = (request: Parameters<WorkspaceSource['spawn']>[0]): WorkspaceChildProcess => {
    if (
      request.command === input.helperPath
      && request.cwd === undefined
      && request.env === undefined
      && request.stdoutFd === undefined
    ) {
      const bridged = worker().spawnVirtualConfinedSyncCommand(request.args, () => spawnDirect(request));
      if (bridged) return bridged;
    }
    return spawnDirect(request);
  };

  const readFileLegacy = async (target: string): Promise<Buffer> => {
    const entry = (await meta(target, 'stat')).entry!;
    const outcome = await runNativeConfinedWorkspaceSyncRead({ rootPath: guestRoot, relativePath: relative(target), maxBytes: Math.max(1, entry.size) }, helper);
    if (outcome.status !== 'content') {
      throw outcome.status === 'missing' ? errno('ENOENT', `No such file: ${target}`) : Object.assign(new Error(`Target file is not readable (${outcome.status})`), { code: outcome.status });
    }
    return Buffer.from(outcome.content);
  };

  const readFile = async (target: string): Promise<Buffer> => {
    const relativePath = relative(target);
    const client = worker();
    if (client.isUnsupported) {
      return await readFileLegacy(target);
    }
    let response: Awaited<ReturnType<typeof client.readFile>>;
    try {
      response = await client.readFile(relativePath);
    } catch (error) {
      if (error instanceof ConfinedWorkerUnsupportedError) {
        return await readFileLegacy(target);
      }
      throw error;
    }
    const { result, body } = response;
    if (result.status === 'file') return body;
    if (result.status === 'missing') throw errno('ENOENT', `No such file: ${target}`);
    if (result.status === 'error') throwMetaResultError(result);
    throw Object.assign(new Error(`Target file is not readable (${result.status})`), { code: result.status });
  };

  const observeSyncEntry = async (target: string) => {
    const relativePath = relative(target);
    const client = worker();
    if (!client.isUnsupported) {
      try {
        return await client.observe(relativePath);
      } catch (error) {
        if (!(error instanceof ConfinedWorkerUnsupportedError)) throw error;
      }
    }
    return await runNativeConfinedWorkspaceSyncObserve({ rootPath: guestRoot, relativePath }, helper);
  };

  const captureLeaf = async (target: string): Promise<WorkspaceCapturedLeaf> => {
    const relativePath = relative(target);
    let result: ConfinedTargetResult;
    const client = worker();
    if (!client.isUnsupported) {
      try {
        result = await client.meta('capture-leaf', relativePath);
      } catch (error) {
        if (!(error instanceof ConfinedWorkerUnsupportedError)) throw error;
        result = await runLegacyHelper('workspace-confined-meta', { relativePath, op: 'capture-leaf' });
      }
    } else {
      result = await runLegacyHelper('workspace-confined-meta', { relativePath, op: 'capture-leaf' });
    }
    return parseCapturedLeafResult(result);
  };

  const statBatch = async (
    targets: readonly string[],
    options?: Readonly<{ followSymlinks?: boolean }>,
  ): Promise<readonly WorkspaceBatchStatEntry[]> => {
    const relPaths = targets.map(relative);
    const client = worker();
    if (!client.isUnsupported) {
      try {
        const results = await client.statBatch(relPaths, options);
        return results.map((result): WorkspaceBatchStatEntry => {
          if (result.status === 'missing') return { kind: 'missing' };
          if (result.status === 'entry' && result.entry) return { kind: 'entry', stats: entryStats(result.entry) };
          return { kind: 'error', code: result.code ?? 'workspace_root_unsafe', message: result.message ?? 'Refused' };
        });
      } catch (error) {
        if (!(error instanceof ConfinedWorkerUnsupportedError)) throw error;
      }
    }
    const op = options?.followSymlinks === false ? 'lstat' : 'stat';
    return await Promise.all(targets.map(async (target): Promise<WorkspaceBatchStatEntry> => {
      try {
        const res = await meta(target, op);
        return { kind: 'entry', stats: entryStats(res.entry!) };
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') return { kind: 'missing' };
        return { kind: 'error', code: err.code ?? 'workspace_root_unsafe', message: err.message ?? 'Refused' };
      }
    }));
  };

  const captureBatch = async (targets: readonly string[]): Promise<readonly WorkspaceBatchCaptureEntry[]> => {
    const relPaths = targets.map(relative);
    const client = worker();
    if (!client.isUnsupported) {
      try {
        const results = await client.captureBatch(relPaths);
        return results.map((result): WorkspaceBatchCaptureEntry => {
          if (result.status === 'error') {
            return { kind: 'error', code: result.code ?? 'workspace_root_unsafe', message: result.message ?? 'Refused' };
          }
          return parseCapturedLeafResult(result);
        });
      } catch (error) {
        if (!(error instanceof ConfinedWorkerUnsupportedError)) throw error;
      }
    }
    return await Promise.all(targets.map(async (target): Promise<WorkspaceBatchCaptureEntry> => {
      try {
        return await captureLeaf(target);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        return { kind: 'error', code: err.code ?? 'workspace_root_unsafe', message: err.message ?? 'Refused' };
      }
    }));
  };

  const remove = async (target: string, options?: Readonly<{ recursive?: boolean; force?: boolean }>) => {
    const relativePath = relative(target);
    const expectation = await observeSyncEntry(target);
    if (expectation.kind === 'missing') {
      if (options?.force) return;
      throw errno('ENOENT', `No such file or directory: ${target}`);
    }
    if (expectation.kind === 'directory' && !options?.recursive) throw errno('EISDIR', `Is a directory: ${target}`);
    const expectedDigest = 'digest' in expectation && typeof expectation.digest === 'string' ? expectation.digest : undefined;
    const client = worker();
    if (!client.isUnsupported) {
      try {
        await client.deleteEntry({
          relativePath,
          expectedKind: expectation.kind,
          ...(expectedDigest === undefined ? {} : { expectedDigest }),
        });
        return;
      } catch (error) {
        if (!(error instanceof ConfinedWorkerUnsupportedError)) throw error;
      }
    }
    await runNativeConfinedWorkspaceSyncDelete({ rootPath: guestRoot, relativePath, expectedKind: expectation.kind,
      ...(expectedDigest === undefined ? {} : { expectedDigest }) }, helper);
  };

  const put = (target: string, bytes: Uint8Array, expect: string) =>
    write({ op: 'put', relativePath: relative(target), sizeBytes: bytes.byteLength, expect }, bytes);

  const watch = (target: string, recursive: boolean, onEvent: (event: Readonly<{ path: string; kind: 'directory' | 'file' | 'unknown'; event: string }>) => void,
    onReady?: () => void, onUnavailable?: (error: Error) => void): (() => void) => {
    const release = input.hold?.();
    let client: SessionHolderChild;
    let stream: SessionHolderStreamProcess;
    try {
      client = holder();
      stream = client.spawnStream({ op: 'watch', path: relative(target), recursive });
    } catch (error) {
      release?.();
      throw error;
    }
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
    const disconnected = () => {
      if (client.holderConnectionFailed) onUnavailable?.(errno('holder_disconnected', 'Workspace observation ended with its holder channel'));
    };
    stream.once('spawn', () => onReady?.());
    stream.once('error', (error: Error) => {
      stream.off('close', disconnected);
      onUnavailable?.(error);
    });
    stream.once('close', disconnected);
    if (release) stream.once('close', release);
    return () => {
      stream.off('close', disconnected);
      stream.kill('SIGTERM');
    };
  };

  const source: WorkspaceSource = {
    nativeHelperPath: input.helperPath,
    kind: 'target' as const,
    id: input.id,
    ...(input.hold ? { hold: input.hold } : {}),
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
    observeSyncEntry,
    captureLeaf,
    statBatch,
    captureBatch,
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
      const client = holder();
      if (command !== 'git') return lookupHolderExecutable(client, command);
      const cached = holderGitExecutables.get(client);
      if (cached) return cached;
      const pending = lookupHolderExecutable(client, command);
      holderGitExecutables.set(client, pending);
      const forget = () => { holderGitExecutables.delete(client); };
      void pending.then(path => { if (!path) forget(); }, forget);
      return pending;
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
