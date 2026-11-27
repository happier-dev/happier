import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Dirent, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

import type { WorkspaceSyncEntryExpectationV1 } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { ManagedWorkspaceAddressV2Schema, type WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import type { DirectoryTopologyWatchTarget, StartDirectoryTopologyWatcherOptions } from '@/integrations/watcher/startDirectoryTopologyWatcher';
import type { StartFileWatcherOptions } from '@/integrations/watcher/startFileWatcher';
import { localWorkspaceSource } from './localWorkspaceSource';
import { readHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';
import type { GuardedFileReplaceInput, GuardedFileReplaceResult, GuardedFileAbsenceResult } from '@/rpc/handlers/fileSystem/commitGuardedFileReplace';
import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';

/** Facts a consumer reads from an entry; node `Stats` satisfies it for the local disk. */
export type WorkspaceEntryStats = Pick<Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'size' | 'mtimeMs' | 'ctimeMs' | 'mtime' | 'dev' | 'ino' | 'mode'>;
export type WorkspaceDirent = Pick<Dirent, 'name' | 'isFile' | 'isDirectory' | 'isSymbolicLink'> & Readonly<{
  /** null means stat was unavailable; undefined means this source did not supply it. */
  stats?: Pick<WorkspaceEntryStats, 'size' | 'mtime'> | null;
}>;
/** Positional reads over one opened file; node `FileHandle` satisfies it. */
export type WorkspaceReadHandle = Pick<FileHandle, 'read' | 'close'> & Readonly<{ stat(): Promise<WorkspaceEntryStats> }>;

/** One atomic confined leaf capture from a target workspace (single helper exchange). */
export type WorkspaceCapturedLeaf =
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'directory'; entry: WorkspaceEntryStats }>
  | Readonly<{ kind: 'other'; entry: WorkspaceEntryStats }>
  | Readonly<{ kind: 'symlink'; entry: WorkspaceEntryStats; target: string }>
  | Readonly<{ kind: 'file'; entry: WorkspaceEntryStats; digest: string; content: Buffer | null }>;

export type WorkspaceBatchStatEntry =
  | Readonly<{ kind: 'entry'; stats: WorkspaceEntryStats }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'error'; code: string; message: string }>;

export type WorkspaceBatchCaptureEntry =
  | WorkspaceCapturedLeaf
  | Readonly<{ kind: 'error'; code: string; message: string }>;

export type WorkspaceWriteStream = Readonly<{
  write(bytes: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
}>;

/** A process started in the source's own OS with `cwd` interpreted there. */
export type WorkspaceSpawnRequest = Readonly<{
  command: string;
  args: readonly string[];
  /** Interpreted in the source's OS; omitted = the source's default directory. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Host-owned descriptor receiving stdout instead of a pipe (stdout is then not readable). */
  stdoutFd?: number;
}>;
export type WorkspaceChildProcess = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'on' | 'once' | 'kill'> & Readonly<{
  /** Stop the process and its descendants where they run. */
  terminateTree(): Promise<void>;
}>;

/**
 * The one port through which workspace consumers reach the bytes, metadata,
 * commands and change events of the workspace an admitted request addressed.
 * `local` is this process's disk. A `target` is the disk of the Session's
 * execution target (container/sandbox), reached by the session host's
 * per-Session holder: each member maps 1:1 to one framed holder op
 * (`stat`, `lstat`, `readdir`, `realpath`, `readlink`, `readFile`, `open/read`,
 * `mkdir`, `rename`, `rm`, `copyFile`, `symlink`, `openWrite`, `writeFile`, `replaceFile`, `spawn`,
 * `resolveExecutable`, `toolLaunch`, `watchTree`, `watchFile`). A target source confines every
 * path to its admitted root with the target's own link facts
 * (`confineWorkspaceTargetPath` in the path policy owner) and never falls back
 * to this process's disk.
 */
export interface WorkspaceSource {
  readonly kind: 'local' | 'target';
  /** Native path authorization when the daemon itself cannot traverse this source. */
  validatePathWithinRoot?(target: string, root: string): Promise<import('@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization').FilesystemPathAuthorizationResult>;
  /** The host-admitted native helper location in this source's OS. */
  readonly nativeHelperPath?: string;
  /** Identity for keys that dedupe per workspace (watches, caches): never shared across sources. */
  readonly id: string;
  /** Keep an admitted Agent-less holder channel alive for the duration of one consumer. */
  hold?(): () => void;
  /** Translate absolute paths passed to or reported by a command whose root has another name in its OS. */
  readonly commandPaths?: Readonly<{ toCommandPath(path: string): string; fromCommandPath(path: string): string }>;
  /** Native Sync capture compares this target preimage with the staged material. */
  observeSyncEntry?(path: string): Promise<WorkspaceSyncEntryExpectationV1>;
  /** Atomic confined leaf capture (stat + digest + bytes/readlink in one helper exchange). */
  captureLeaf?(path: string): Promise<WorkspaceCapturedLeaf>;
  /** Batch confined stat/lstat over one persistent target worker RTT. */
  statBatch?(paths: readonly string[], options?: Readonly<{ followSymlinks?: boolean }>): Promise<readonly WorkspaceBatchStatEntry[]>;
  /** Batch atomic confined leaf capture over one persistent target worker RTT. */
  captureBatch?(paths: readonly string[]): Promise<readonly WorkspaceBatchCaptureEntry[]>;
  /** Publication effects. Read-only sources omit these operations. */
  readonly filePublication?: Readonly<{
    copyFileExclusive(from: string, to: string): Promise<Readonly<{ atime: Date; mtime: Date }>>;
    setFileTimes(path: string, atime: Date, mtime: Date): Promise<void>;
    accessExecutable(path: string): Promise<void>;
    openExclusiveFile(path: string): Promise<Readonly<{
      mode: number;
      writeFrom(sourcePath: string, mode?: number): Promise<void>;
      close(): Promise<void>;
    }>>;
  }>;
  stat(path: string): Promise<WorkspaceEntryStats>;
  lstat(path: string): Promise<WorkspaceEntryStats>;
  readdir(path: string): Promise<WorkspaceDirent[]>;
  realpath(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  /** `noFollow` refuses a final symbolic link (O_NOFOLLOW where the OS has it). */
  open(path: string, options?: Readonly<{ noFollow?: boolean }>): Promise<WorkspaceReadHandle>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  mkdir(path: string, options?: Readonly<{ recursive?: boolean; mode?: number }>): Promise<void>;
  /** Empty directory only: concurrent contents are preserved. */
  rmdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: Readonly<{ recursive?: boolean; force?: boolean }>): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  /**
   * Stream bytes into a new file (exclusive create, `EEXIST` if present). The local
   * disk writes synchronously, so a synchronous producer (a Git stdout consumer)
   * keeps today's ordering; a target returns promises the caller awaits before close.
   * Holder ops: `open_write {path, mode}` → stream id, `write {id, bytes}`, `close {id}`.
   */
  openWrite(path: string, options?: Readonly<{ mode?: number }>): WorkspaceWriteStream;
  /** Conditional create/replace/delete with the existing expected-hash outcomes. */
  replaceFile(input: GuardedFileReplaceInput & Readonly<{ source: Readonly<{ kind: 'absent' }> }>): Promise<GuardedFileAbsenceResult>;
  replaceFile(input: GuardedFileReplaceInput): Promise<GuardedFileReplaceResult>;
  /**
   * Locate a named executable on the source's PATH; `null` is the typed missing-tool outcome.
   * The local disk answers synchronously so command start keeps today's ordering.
   */
  resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | null | Promise<string | null>;
  /** Start synchronously so callers attach listeners before any spawn error is delivered. */
  spawn(request: WorkspaceSpawnRequest): WorkspaceChildProcess;
  /**
   * How a workspace tool runs in this source: local uses Happier's packaged tool
   * (ripgrep through its stdin-fed launcher, bundled difftastic); a target uses its own `rg`/`difft`.
   */
  toolLaunch(request: Readonly<{ tool: WorkspaceTool; args: readonly string[]; paths?: readonly string[] }>): Promise<Readonly<{ command: string; args: readonly string[]; stdin?: string }>>;
  watchTree(targets: readonly DirectoryTopologyWatchTarget[], options?: StartDirectoryTopologyWatcherOptions): () => void;
  watchFile(path: string, onChange: (path: string) => void | Promise<void>, options?: StartFileWatcherOptions): () => void;
}

export type WorkspaceTool = 'ripgrep' | 'difftastic';

/** Placement facts of one admitted request; selection reads nothing else. */
export type WorkspaceSourcePlacement = Readonly<{
  sessionId?: string;
  rootPath?: string;
  workspace?: Extract<WorkspaceAddressV2, { kind: 'managed' }>;
  /** Host-private Account custody for a managed Project target. */
  requesterAccountId?: string;
}>;

/**
 * Supplied by the Session placement owner (session host): returns the target
 * source of a Session that runs inside an execution target, or `null` when the
 * request addresses this Machine's disk. A target that is stopped/unreachable is
 * returned as a target source whose operations reject with a typed outcome.
 */
export type WorkspaceTargetSourceResolver = (placement: WorkspaceSourcePlacement) => WorkspaceSource | null;

/**
 * Why AsyncLocalStorage: the admitted request context (RpcHandlerContext) is
 * rebuilt field-by-field by the canonical Action dispatcher into the
 * protocol-owned ActionExecutorContext, which must not carry host-private
 * objects; host-private request facts already ride ALS (server URL, requester
 * credentials, SCM command runner). Deferred work must capture the source
 * (`currentWorkspaceSource()` at start, then `runWithWorkspaceSource`).
 */
const selectedSource = new AsyncLocalStorage<WorkspaceSource>();
// Resolved at call time: module cycles (local source ↔ tool integrations) must not capture an uninitialized binding.
let unboundSource: WorkspaceSource | undefined;

export function workspaceTargetUnavailable(): PluginError {
  return new PluginError({ code: 'workspace_target_unavailable', message: 'The managed workspace is unavailable' });
}

/** The single source decision, made once at request admission. */
export async function selectWorkspaceSource(
  placement: WorkspaceSourcePlacement,
  resolveTarget?: WorkspaceTargetSourceResolver,
  readRetainedSessionWorkspace?: (sessionId: string) => Promise<Readonly<{ requiresManagedTarget?: true }> | null>,
  restoreManagedWorkspaceTarget?: (workspace: NonNullable<WorkspaceSourcePlacement['workspace']>) => Promise<WorkspaceSource | null>,
): Promise<WorkspaceSource> {
  const target = resolveTarget?.(placement);
  if (target?.kind === 'target') return target;
  if (placement.workspace) {
    if (!placement.sessionId) {
      const restored = await restoreManagedWorkspaceTarget?.(placement.workspace);
      if (restored?.kind === 'target') return restored;
    }
    throw workspaceTargetUnavailable();
  }
  if (placement.sessionId && readRetainedSessionWorkspace) {
    const retained = await readRetainedSessionWorkspace(placement.sessionId);
    if (!retained || retained.requiresManagedTarget) throw workspaceTargetUnavailable();
  }
  return target ?? localWorkspaceSource;
}

/** Bind the admitted request's source for every consumer reached by `effect`. */
export function runWithWorkspaceSource<T>(source: WorkspaceSource, effect: () => T): T {
  return selectedSource.run(source, effect);
}

export async function runWithWorkspaceSourceDemand<T>(source: WorkspaceSource, effect: () => T | Promise<T>): Promise<T> {
  const release = source.hold?.();
  try {
    return await runWithWorkspaceSource(source, effect);
  } finally {
    release?.();
  }
}

/** Bind each arrival's selected source before its handler runs (registrars without their own admission wrapper). */
export function bindWorkspaceSourceRegistrar(
  registrar: RpcHandlerRegistrar,
  select: (context: RpcHandlerContext | undefined, input: unknown) => WorkspaceSource | Promise<WorkspaceSource>,
): RpcHandlerRegistrar {
  return { ...registrar, registerHandler<TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) {
    registrar.registerHandler<TRequest, TResponse>(method, async (input, context) =>
      runWithWorkspaceSourceDemand(await select(context, input), () => handler(input, context)));
  } };
}

/**
 * The source of the current admitted request, else of the hosted Session whose
 * work this is, else this Machine's disk (Machine-level work, local by definition).
 */
export function currentWorkspaceSource(): WorkspaceSource {
  return selectedSource.getStore() ?? readHostedSessionScope()?.workspaceSource ?? unboundSource ?? localWorkspaceSource;
}

/**
 * Guard seam for test harnesses: replace the unbound default with a source that
 * fails, so any consumer reached outside a captured source fails its test instead
 * of silently reading this Machine's disk. Returns the restore function.
 */
export function replaceUnboundWorkspaceSource(source: WorkspaceSource | undefined): () => void {
  const previous = unboundSource;
  unboundSource = source;
  return () => { unboundSource = previous; };
}

function readField(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/** The placement facts an admitted request carries: its Session and workspace address. */
export function readWorkspaceSourcePlacement(
  context: Readonly<{ sessionActionOrigin?: Readonly<{ caller: Readonly<{ sessionId: string }> }>; authorization?: unknown }> | undefined,
  input: unknown,
): WorkspaceSourcePlacement {
  const authorization = context?.authorization;
  const sessionId = context?.sessionActionOrigin?.caller.sessionId
    ?? (readString(authorization, 'kind') === 'session.write' ? readString(authorization, 'sessionId') : undefined);
  const rootPath = readString(input, 'rootPath') ?? readString(input, 'directory') ?? readString(input, 'cwd');
  const address = readField(input, 'workspace');
  const workspace = address === undefined ? undefined : ManagedWorkspaceAddressV2Schema.safeParse(address);
  if (workspace?.success === false) throw workspaceTargetUnavailable();
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(rootPath ? { rootPath } : {}),
    ...(workspace?.success ? { workspace: workspace.data } : {}),
  };
}
