import { lstat, mkdir, readFile, realpath, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { userInfo } from 'node:os';
import { spawn } from 'node:child_process';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { isCanonicalConnectedServiceMaterializedRoot,
  ensurePrivateConnectedServiceMaterializedRoot } from '../connectedServices/materialize/privateMaterializedRoot';
import { writeBytesAtomic } from '../../utils/fs/writeJsonAtomic';
import { parseAgentLaunchPayload, type AgentLaunchPayload, type AgentLaunchFramePayload } from './agentLaunchFrame';
import { createBestEffortCleanupDirectory } from '../connectedServices/materialization/materializer';
import { grantExactUidPathAccess } from '@/utils/fs/unixPathAccess';
import { prepareAgentLaunchIdentityCache, retireAgentLaunchOperationRuntime } from './agentLaunchRuntime';

async function prepareNativeSocketDirectory(payload: AgentLaunchPayload): Promise<() => Promise<void>> {
  const directory = payload.nativeSocketDirectory;
  if (!directory) return async () => {};
  await mkdir(directory.path, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const entry = await lstat(directory.path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()
    || (entry.mode & 0o777) !== 0o700) throw new AgentLaunchMaterialError();
  const cleanup = async () => { await rm(directory.path, { recursive: true, force: true }); };
  try {
    // Codex accepts a native-owned alias parent without group/other write.
    // Host traversal is sufficient for lstat(alias); its target stays private.
    await grantExactUidPathAccess({ path: directory.path, uid: directory.daemonUid, access: '--x', directory: true });
    return cleanup;
  } catch (error) { await cleanup(); throw error; }
}

export class AgentLaunchMaterialError extends Error {
  readonly code = 'agent_launch_material_invalid';
  constructor() { super('agent_launch_material_invalid'); }
}

async function assertMaterialParent(home: string, path: string): Promise<void> {
  if (!await isCanonicalConnectedServiceMaterializedRoot({ baseDir: home, rootDir: dirname(path), allowMissing: true })) {
    throw new AgentLaunchMaterialError();
  }
}

async function prepareAgentLaunchMaterials(input: AgentLaunchPayload, agentHome: string) {
  let payload: AgentLaunchPayload;
  try { payload = parseAgentLaunchPayload(input); } catch { throw new AgentLaunchMaterialError(); }
  const home = await realpath(agentHome);
  if (payload.runtimeHome !== resolve(payload.runtimeHome)
    || !await isCanonicalConnectedServiceMaterializedRoot({ baseDir: home, rootDir: payload.runtimeHome, allowMissing: true })) {
    throw new AgentLaunchMaterialError();
  }
  // Validate every selected destination before creating or publishing anything.
  // Provider-owned state is neither enumerated nor replaced by this projection.
  const uid = process.getuid?.();
  const entries = await Promise.all(payload.selectedMaterials.map(async file => {
    const path = join(payload.runtimeHome, file.relativePath);
    await assertMaterialParent(home, path);
    const current = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (current && (!current.isFile() || current.isSymbolicLink() || uid !== undefined && current.uid !== uid)) {
      throw new AgentLaunchMaterialError();
    }
    return { path, current, bytes: Buffer.from(file.contentBase64, 'base64') };
  }));
  // Finish directory ownership/privacy admission before cleanup can acquire
  // selected bytes. A directory refusal must retain all preexisting files.
  await ensurePrivateConnectedServiceMaterializedRoot(payload.runtimeHome);
  for (const entry of entries) await ensurePrivateConnectedServiceMaterializedRoot(dirname(entry.path));
  return { payload, entries };
}

async function publishPreparedAgentLaunchMaterials({ entries }: Awaited<ReturnType<typeof prepareAgentLaunchMaterials>>): Promise<void> {
  for (const entry of entries) {
    if (entry.current && (entry.current.mode & 0o777) === 0o600 && entry.bytes.equals(await readFile(entry.path))) continue;
    await writeBytesAtomic(entry.path, entry.bytes);
  }
}

/** The existing materialization lease supplies this complete, selected projection. */
export async function publishAgentLaunchMaterials(input: AgentLaunchPayload, agentHome: string): Promise<void> {
  await publishPreparedAgentLaunchMaterials(await prepareAgentLaunchMaterials(input, agentHome));
}

export async function executeAgentLaunchPayload(input: AgentLaunchFramePayload, io: Readonly<{
  agentHome: string; input: Readable; stdout: Writable; stderr: Writable; signal?: AbortSignal;
  /** Actual process terminal only; the fixed RunAs shim derives this from isTTY. */
  terminal?: Readonly<{ accepted(): void }>;
}>): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> {
  io.signal?.throwIfAborted();
  if ('action' in input) {
    await retireAgentLaunchOperationRuntime(await realpath(io.agentHome), input.runtimeHome);
    return { code: 0, signal: null };
  }
  const prepared = await prepareAgentLaunchMaterials(input, io.agentHome);
  const payload = prepared.payload;
  // Validation grants cleanup custody before the first selected write. Refused
  // destinations never gain it, while partial publication remains covered.
  // This finally runs as the Agent identity; the daemon never writes/removes Agent-owned material.
  const cleanupMaterial = createBestEffortCleanupDirectory(payload.runtimeHome, async root => {
    const home = await realpath(io.agentHome);
    // Selected files are launch material even when they live beside retained
    // native resume state. Unlink only those exact files, never the native tree.
    for (const file of payload.selectedMaterials) {
      const path = join(root, file.relativePath);
      await assertMaterialParent(home, path);
      await rm(path, { force: true });
    }
    if (payload.selectedMaterials.some(file => file.relativePath.startsWith('files/'))) {
      // Another invocation may share the retained runtime Home. Empty-only
      // removal cannot consume its selected files or primary Session context.
      await assertMaterialParent(home, join(root, 'files/entry'));
      await rmdir(join(root, 'files')).catch((error: unknown) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      });
    }
  }, { failureMode: 'reject' });
  let executionFailure: unknown;
  let cleanupNativeSocketDirectory = async () => {};
  try {
    const cacheHome = await prepareAgentLaunchIdentityCache(await realpath(io.agentHome));
    await publishPreparedAgentLaunchMaterials(prepared);
    cleanupNativeSocketDirectory = await prepareNativeSocketDirectory(payload);
    io.signal?.throwIfAborted();
    const { spawnSupervisedPluginProcess } = await import('../../plugins/runtime/exec/processSupervisor');
    io.signal?.throwIfAborted();
    const identity = userInfo();
    const environment = { ...payload.environment, HOME: io.agentHome, USER: identity.username, LOGNAME: identity.username,
      SHELL: '/bin/sh', XDG_CONFIG_HOME: join(payload.runtimeHome, '.config'),
      XDG_DATA_HOME: join(payload.runtimeHome, '.local/share'), XDG_STATE_HOME: join(payload.runtimeHome, '.local/state'),
      XDG_CACHE_HOME: cacheHome };
    if (io.terminal) {
      // The payload shares the actual foreground terminal. Pipes would lose
      // isatty, job control and kernel window-size propagation.
      const mask = process.umask(0o002);
      const child = (() => {
        try { return spawn(payload.executable, [...payload.args], { cwd: payload.cwd, env: environment,
          stdio: 'inherit', detached: false }); }
        finally { process.umask(mask); }
      })();
      let stop: Promise<void> | undefined;
      const interrupt = () => {
        if (child.pid && !stop) {
          stop = terminateProcessTree(child);
          // Preserve the failure for the awaited custody settlement below.
          void stop.catch(() => undefined);
        }
      };
      io.signal?.addEventListener('abort', interrupt, { once: true });
      if (io.signal?.aborted) interrupt();
      try {
        const result = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolve, reject) => {
          child.once('error', reject);
          child.once('spawn', () => { io.terminal!.accepted(); });
          child.once('exit', (code, signal) => resolve({ code, signal }));
        });
        await stop;
        return result;
      } finally {
        io.signal?.removeEventListener('abort', interrupt);
        await stop;
      }
    }
    const mask = process.umask(0o002);
    const supervised = (() => {
      try {
        return spawnSupervisedPluginProcess({ command: payload.executable, args: payload.args, cwd: payload.cwd,
          env: environment, signals: io.signal ? [io.signal] : [], spawnOptions: { detached: true },
          // Output travels through the live pipes; do not retain another copy.
          maxStdoutBytes: 0, maxStderrBytes: 0 });
      } finally { process.umask(mask); }
    })();
    const pipe = (work: Promise<void>) => work.catch(async (error: unknown) => {
      await supervised.dispose();
      throw error;
    });
    try {
      const [result, input, output, errorOutput] = await Promise.all([
        supervised.handle.wait(),
        pipe(pipeline(io.input, supervised.child.stdin)).then(() => null, error => error as unknown),
        pipe(pipeline(supervised.child.stdout, io.stdout, { end: false })).then(() => null, error => error as unknown),
        pipe(pipeline(supervised.child.stderr, io.stderr, { end: false })).then(() => null, error => error as unknown),
      ]);
      // A provider may exit before consuming all stdin. Preserve its actual exit;
      // unrelated stream errors remain failures and have already stopped the tree.
      const inputCode = input && typeof input === 'object' ? Reflect.get(input, 'code') : undefined;
      if (output || errorOutput || input && inputCode !== 'EPIPE' && inputCode !== 'ERR_STREAM_PREMATURE_CLOSE') {
        throw Object.assign(new Error('agent_launch_stream_failed'), { code: 'agent_launch_stream_failed' });
      }
      const observed = result.termination.observed;
      if (observed.kind === 'exit') return { code: observed.exitCode, signal: null };
      // This host supervisor observes Node child signals; the portable SDK widens their type.
      if (observed.kind === 'signal') return { code: null, signal: observed.signal as NodeJS.Signals };
      throw Object.assign(new Error('agent_launch_transport_unavailable'), { code: 'agent_launch_transport_unavailable' });
    } finally { await supervised.dispose(); }
  } catch (error) {
    executionFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await cleanupMaterial().catch((error: unknown) => { cleanupFailures.push(error); });
    await cleanupNativeSocketDirectory().catch((error: unknown) => { cleanupFailures.push(error); });
    if (cleanupFailures.length) {
      if (executionFailure !== undefined) throw new AggregateError([executionFailure, ...cleanupFailures], 'Agent launch and cleanup failed');
      if (cleanupFailures.length === 1) throw cleanupFailures[0];
      throw new AggregateError(cleanupFailures, 'Agent launch cleanup failed');
    }
  }
}
