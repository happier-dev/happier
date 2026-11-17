import { lstat, mkdir, readFile, realpath, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { userInfo } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { classifySpawnFailure } from '@/processes/spawnFailure/classifySpawnFailure';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { isCanonicalConnectedServiceMaterializedRoot,
  ensurePrivateConnectedServiceMaterializedRoot } from '../connectedServices/materialize/privateMaterializedRoot';
import { writeBytesAtomic } from '../../utils/fs/writeJsonAtomic';
import { AGENT_LAUNCH_NATIVE_HOME_RELATIVE_PATH, parseAgentLaunchPayload, type AgentLaunchPayload, type AgentLaunchFramePayload } from './agentLaunchFrame';
import { createBestEffortCleanupDirectory } from '../connectedServices/materialization/materializer';
import { grantExactUidPathAccess } from '@/utils/fs/unixPathAccess';
import { prepareAgentLaunchIdentityCache, retireAgentLaunchOperationRuntime, resolveAgentLaunchNativeEnvironment } from './agentLaunchRuntime';
import { AgentLaunchDiagnosticError, createAgentLaunchStderr, type AgentLaunchFailure, type AgentLaunchFailureStage } from './agentLaunchDiagnostics';

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
  await ensurePrivateConnectedServiceMaterializedRoot(join(payload.runtimeHome, AGENT_LAUNCH_NATIVE_HOME_RELATIVE_PATH));
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
  if (io.signal?.aborted) throw new AgentLaunchDiagnosticError({ stage: 'caller_cancelled' });
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
    if (payload.accountSettingsApplication) {
      const { applyAgentLaunchAccountSettings } = await import('./agentLaunchAccountSettings');
      await applyAgentLaunchAccountSettings(payload, io.signal);
    }
    if (io.signal?.aborted) throw new AgentLaunchDiagnosticError({ stage: 'caller_cancelled' });
    const { spawnSupervisedPluginProcess } = await import('../../plugins/runtime/exec/processSupervisor');
    if (io.signal?.aborted) throw new AgentLaunchDiagnosticError({ stage: 'caller_cancelled' });
    const identity = userInfo();
    const environment = { ...resolveAgentLaunchNativeEnvironment(payload.runtimeHome), ...payload.environment,
      HOME: io.agentHome, USER: identity.username, LOGNAME: identity.username, SHELL: '/bin/sh',
      XDG_CACHE_HOME: cacheHome };
    if (io.terminal) {
      // Framing has finished. Close Node's duplicated TTY read handle while
      // the shim is still foreground; fd 0 remains available for inheritance.
      // Closing it at process teardown would restore termios from a background
      // group after shell job control, stopping the shim with SIGTTOU.
      io.input.destroy();
      // The payload shares the actual foreground terminal. Pipes would lose
      // isatty, job control and kernel window-size propagation.
      const mask = process.umask(0o002);
      const child = (() => {
        try { return spawn(payload.executable, [...payload.args], { cwd: payload.cwd, env: environment,
          stdio: 'inherit', detached: false }); }
        catch (error) { throw new AgentLaunchDiagnosticError({ stage: 'exec', errno: classifySpawnFailure(error).errno }); }
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
          child.once('error', error => reject(new AgentLaunchDiagnosticError({ stage: 'exec', errno: classifySpawnFailure(error).errno })));
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
          // Protocol stdout stays binary. The shim owns one redacted stderr
          // tail; forwarding noise would bury its failure in outer head capture.
          maxStdoutBytes: 0, maxStderrBytes: 0 });
      } catch (error) { throw new AgentLaunchDiagnosticError({ stage: 'exec', errno: classifySpawnFailure(error).errno }); }
      finally { process.umask(mask); }
    })();
    const stderr = createAgentLaunchStderr(payload);
    let firstFailure: AgentLaunchFailure | undefined;
    const record = (failure: AgentLaunchFailure) => { firstFailure ??= failure; };
    const cancelled = () => record({ stage: 'caller_cancelled' });
    const execFailed = (error: unknown) => record({ stage: 'exec', errno: classifySpawnFailure(error).errno });
    const exited = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (exitCode !== 0 || signal) record({ stage: 'child_exit', exitCode, signal });
    };
    supervised.child.once('error', execFailed);
    supervised.child.once('exit', exited);
    io.signal?.addEventListener('abort', cancelled, { once: true });
    if (io.signal?.aborted) cancelled();
    const pipe = (stage: AgentLaunchFailureStage, work: Promise<void>) => work.catch(async () => {
      // A child exit can close stdin before its exit event is delivered. That
      // shutdown is a consequence; retain the native exit rather than EPIPE.
      if (stage !== 'stdin' || supervised.child.exitCode === null && supervised.child.signalCode === null) record({ stage });
      await supervised.dispose();
    });
    try {
      // The supervisor already observes output, making these streams flowing.
      // Attach forwarding before yielding: Bun can deliver a finite child's
      // output before the spawn continuation runs, and zero-byte capture drops it.
      const output = [
        pipe('stdout', pipeline(supervised.child.stdout, io.stdout, { end: false })),
        pipe('stderr', pipeline(supervised.child.stderr, stderr.stream)),
      ];
      // Keep stdin behind native cwd/exec admission so a failed spawn retains
      // its initiating exec diagnostic rather than consequent input shutdown.
      try { await once(supervised.child, 'spawn'); }
      catch { throw new AgentLaunchDiagnosticError(firstFailure ?? { stage: 'exec' }); }
      const [result] = await Promise.all([
        supervised.handle.wait(),
        pipe('stdin', pipeline(io.input, supervised.child.stdin)),
        ...output,
      ]);
      const observed = result.termination.observed;
      const tail = stderr.readTail();
      if (firstFailure) {
        const diagnostic = new AgentLaunchDiagnosticError(firstFailure, tail);
        if (firstFailure.stage !== 'child_exit') throw diagnostic;
        // A native nonzero exit is still a process result for readiness/finite
        // callers. Retain its diagnostic if subsequent material cleanup fails.
        executionFailure = diagnostic;
        try { await pipeline(Readable.from([`${diagnostic.message}\n`]), io.stderr, { end: false }); }
        catch { throw diagnostic; }
      } else if (tail) {
        try { await pipeline(Readable.from([tail]), io.stderr, { end: false }); }
        catch { throw new AgentLaunchDiagnosticError({ stage: 'stderr' }, tail); }
      }
      if (observed.kind === 'exit') return { code: observed.exitCode, signal: null };
      // This host supervisor observes Node child signals; the portable SDK widens their type.
      if (observed.kind === 'signal') return { code: null, signal: observed.signal as NodeJS.Signals };
      throw Object.assign(new Error('agent_launch_transport_unavailable'), { code: 'agent_launch_transport_unavailable' });
    } finally {
      io.signal?.removeEventListener('abort', cancelled);
      supervised.child.off('error', execFailed);
      supervised.child.off('exit', exited);
      try { await supervised.dispose(); } finally { stderr.close(); }
    }
  } catch (error) {
    executionFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    await cleanupMaterial().catch((error: unknown) => { cleanupFailures.push(error); });
    await cleanupNativeSocketDirectory().catch((error: unknown) => { cleanupFailures.push(error); });
    if (cleanupFailures.length) {
      if (executionFailure instanceof AgentLaunchDiagnosticError) {
        // Secondary cleanup must not replace the initiating native diagnostic.
        // Retain its failures as a cause; only the redacted preview is public.
        executionFailure.cause = new AggregateError(cleanupFailures, 'Agent launch cleanup failed');
        throw executionFailure;
      }
      if (executionFailure !== undefined) throw new AggregateError([executionFailure, ...cleanupFailures], 'Agent launch and cleanup failed');
      if (cleanupFailures.length === 1) throw cleanupFailures[0];
      throw new AggregateError(cleanupFailures, 'Agent launch cleanup failed');
    }
  }
}
