import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';

const OUTPUT_MARKER = '__HAPPIER_GENERATOR_MODULE_JSON__';
// Retain recent stderr only for failure diagnostics; this does not bound responses.
const STDERR_DIAGNOSTIC_TAIL_CHARS = 4 * 1024 * 1024;
const ESBUILD_EXIT_MARKER = '__HAPPIER_INSPECTION_ESBUILD_EXIT__';
// Written by the worker as it exits, before its esbuild service sees EOF.
const WORKER_EXIT_MARKER = '__HAPPIER_INSPECTION_WORKER_EXIT__';
// A partial stderr line is kept only to find the reporter's short marker line.
const STDERR_LINE_CARRY_CHARS = 256;

/**
 * tsx transforms in the worker through esbuild's synchronous API, which blocks
 * the worker's main thread on an esbuild service thread with no deadline. When
 * that thread dies (e.g. a binary whose version does not match the API), its
 * esbuild process exits and the worker can never report it: the worker sat in
 * futex wait beside a defunct esbuild child (IMPL-01C 2026-11-17). The service
 * runs through esbuildServiceExit.sh, which reports the service's exit on the
 * worker's stderr, so this session fails on that event instead of waiting.
 */
function esbuildServiceEnvironment(): NodeJS.ProcessEnv {
  // The reporter is a POSIX shell script; esbuild requires a native executable on Windows.
  if (process.platform === 'win32') return process.env;
  let binary = process.env.ESBUILD_BINARY_PATH;
  if (!binary) {
    try {
      const requireFromTsx = createRequire(createRequire(import.meta.url).resolve('tsx/package.json'));
      binary = createRequire(requireFromTsx.resolve('esbuild')).resolve(`@esbuild/${process.platform}-${process.arch}/bin/esbuild`);
    } catch (error) {
      process.stderr.write(`[typescript-inspection] esbuild service exit reporting unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      return process.env;
    }
  }
  return {
    ...process.env,
    ESBUILD_BINARY_PATH: fileURLToPath(new URL('./esbuildServiceExit.sh', import.meta.url)),
    HAPPIER_INSPECTION_ESBUILD_BINARY: binary,
  };
}

type InspectionPayload = Readonly<{
  exportNames: readonly string[];
  values: Readonly<Record<string, unknown>>;
}>;

type PendingInspection = Readonly<{
  path: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}>;

/** Exports whose values the caller reads; export names are always reported. Omit to answer every export. */
export type TypescriptModuleInspectionOptions = Readonly<{ exports?: readonly string[] }>;

export type TypescriptModuleInspectionSession = Readonly<{
  inspect(path: string, options?: TypescriptModuleInspectionOptions): Promise<unknown>;
  close(): Promise<void>;
}>;

function projectInspectionPayload(path: string, payload: unknown): unknown {
  if (
    payload === null
    || typeof payload !== 'object'
    || !Array.isArray((payload as InspectionPayload).exportNames)
    || (payload as InspectionPayload).values === null
    || typeof (payload as InspectionPayload).values !== 'object'
  ) {
    throw new Error(`Failed to inspect TypeScript module ${path}: invalid isolated module result`);
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const exportName of (payload as InspectionPayload).exportNames) {
    if (typeof exportName !== 'string') {
      throw new Error(`Failed to inspect TypeScript module ${path}: invalid export name`);
    }
    out[exportName] = (payload as InspectionPayload).values[exportName];
  }
  return out;
}

export function createTypescriptModuleInspectionSession({
  onSpawn,
}: Readonly<{ onSpawn?: (pid: number | undefined) => void }> = {}): TypescriptModuleInspectionSession {
  const workerPath = fileURLToPath(new URL('./typescriptModuleInspectionWorker.mjs', import.meta.url));
  const sourceRuntimePath = fileURLToPath(new URL('../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--conditions=happier-source', '--import', sourceRuntimePath,
    '--max-old-space-size=2048', workerPath], {
    // Global tsx hooks also consult cwd. Inspect against this source tree, not
    // a caller's declaration-emission tsconfig (which may resolve stale SDKs).
    cwd: fileURLToPath(new URL('../../../../../', import.meta.url)),
    env: esbuildServiceEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  onSpawn?.(child.pid);
  const pending = new Map<number, PendingInspection>();
  let nextId = 1;
  let stdoutBuffer = '';
  let stderr = '';
  let stderrLine = '';
  let esbuildExitStatus: string | undefined;
  let workerExiting = false;
  let closing = false;
  let closed = false;
  let closeError: Error | undefined;
  let terminalError: Error | undefined;

  /**
   * The worker answers over pipes, and a pipe chunk ends wherever the kernel
   * filled the buffer — routinely in the middle of a multi-byte character.
   * `chunk.toString('utf8')` decodes each chunk in isolation, so a split
   * sequence becomes replacement characters on both sides of the seam and the
   * JSON around it stays perfectly valid.
   *
   * That is not theoretical here: this is the path a bundled plugin's manifest
   * takes, translations included, and the corruption was published into a
   * shipped `.happier-plugin/plugin.json` as mojibake in a zh-Hans string.
   * `StringDecoder` holds an incomplete sequence until its remaining bytes
   * arrive, which is the whole fix.
   */
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  };
  // The worker's own esbuild service exited while the worker still runs. A
  // worker that exits by itself ends its service too; it announces that first.
  const onEsbuildServiceExit = (status: string) => {
    if (closing || closed || workerExiting) return;
    esbuildExitStatus ??= status;
    child.kill('SIGKILL');
  };
  child.stderr.on('data', (chunk: Buffer) => {
    const text = stderrDecoder.write(chunk);
    stderr = `${stderr}${text}`.slice(-STDERR_DIAGNOSTIC_TAIL_CHARS);
    stderrLine += text;
    for (let newline = stderrLine.indexOf('\n'); newline >= 0; newline = stderrLine.indexOf('\n')) {
      const line = stderrLine.slice(0, newline);
      stderrLine = stderrLine.slice(newline + 1);
      if (line.startsWith(WORKER_EXIT_MARKER)) { workerExiting = true; continue; }
      if (!line.startsWith(ESBUILD_EXIT_MARKER)) continue;
      const [ownerPid, status] = line.slice(ESBUILD_EXIT_MARKER.length).trim().split(/\s+/u);
      if (Number(ownerPid) === child.pid) onEsbuildServiceExit(status ?? 'unknown');
    }
    stderrLine = stderrLine.slice(-STDERR_LINE_CARRY_CHARS);
  });
  child.stdin.on('error', (error) => {
    closeError ??= error;
    rejectPending(error);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += stdoutDecoder.write(chunk);
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      const markerIndex = line.lastIndexOf(OUTPUT_MARKER);
      if (markerIndex < 0) continue;
      let parsedResponse: unknown;
      try {
        parsedResponse = JSON.parse(line.slice(markerIndex + OUTPUT_MARKER.length));
      } catch {
        closeError = new Error('TypeScript inspection worker returned invalid JSON');
        child.kill('SIGKILL');
        return;
      }
      if (parsedResponse === null || typeof parsedResponse !== 'object' || Array.isArray(parsedResponse)) {
        closeError = new Error('TypeScript inspection worker returned an invalid response');
        child.kill('SIGKILL');
        return;
      }
      const response = parsedResponse as Record<string, unknown>;
      const responseId = response.id;
      if (!Number.isSafeInteger(responseId)) continue;
      const request = pending.get(responseId as number);
      if (!request) continue;
      pending.delete(responseId as number);
      if (response.ok !== true) {
        request.reject(new Error(
          `Failed to inspect TypeScript module ${request.path}: ${String(response.error ?? 'unknown worker error')}`,
        ));
        continue;
      }
      try {
        request.resolve(projectInspectionPayload(request.path, response.payload));
      } catch (error) {
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
  child.once('error', (error) => {
    closeError = error;
    rejectPending(error);
  });
  const closedPromise = new Promise<void>((resolveClosed) => {
    child.once('close', (status, signal) => {
      closed = true;
      const error = closeError ?? (esbuildExitStatus !== undefined && signal === 'SIGKILL'
        ? new Error(`TypeScript inspection worker: its esbuild service exited (status ${esbuildExitStatus}); `
          + 'the worker cannot transform further modules')
        : status === 0 && signal === null && pending.size === 0
        ? undefined
        : new Error(
          `TypeScript inspection worker exited${signal ? ` with ${signal}` : ` with status ${String(status)}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
        ));
      terminalError = error;
      if (error) rejectPending(error);
      resolveClosed();
    });
  });

  return Object.freeze({
    inspect(path: string, options?: TypescriptModuleInspectionOptions): Promise<unknown> {
      if (closed || child.stdin.destroyed) {
        // Name the worker's terminal cause; "closed" alone hides why a build failed.
        const cause = terminalError ?? closeError;
        return Promise.reject(new Error(
          `Failed to inspect TypeScript module ${path}: inspection worker is closed${cause ? ` (${cause.message})` : ''}`,
          ...(cause ? [{ cause }] : []),
        ));
      }
      const id = nextId;
      nextId += 1;
      return new Promise((resolveInspection, rejectInspection) => {
        // Publication owns the operation lifetime. A queued/module-local timer
        // cannot distinguish slow valid source evaluation from a stuck worker.
        // Worker failure still rejects pending work; caller cancellation owns
        // process termination instead of an independent guessed deadline.
        pending.set(id, {
          path,
          resolve: resolveInspection,
          reject: rejectInspection,
        });
        child.stdin.write(`${JSON.stringify({ id, path, ...(options?.exports ? { exports: options.exports } : {}) })}\n`);
      });
    },
    async close(): Promise<void> {
      closing = true;
      if (!closed && !child.stdin.destroyed) child.stdin.end();
      await closedPromise;
    },
  });
}

const activeInspectionSession = new AsyncLocalStorage<TypescriptModuleInspectionSession>();

export async function inspectTypescriptModule(path: string, options?: TypescriptModuleInspectionOptions): Promise<unknown> {
  const active = activeInspectionSession.getStore();
  if (active) return await active.inspect(path, options);
  const session = createTypescriptModuleInspectionSession();
  try {
    return await session.inspect(path, options);
  } finally {
    await session.close();
  }
}

export async function withTypescriptModuleInspectionSession<T>(operation: () => Promise<T>): Promise<T> {
  const session = createTypescriptModuleInspectionSession();
  try {
    return await activeInspectionSession.run(session, operation);
  } finally {
    await session.close();
  }
}
