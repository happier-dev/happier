import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';

const OUTPUT_MARKER = '__HAPPIER_GENERATOR_MODULE_JSON__';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const INSPECTION_TIMEOUT_MS = 180_000;

type InspectionPayload = Readonly<{
  exportNames: readonly string[];
  values: Readonly<Record<string, unknown>>;
}>;

type PendingInspection = Readonly<{
  path: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>;

export type TypescriptModuleInspectionSession = Readonly<{
  inspect(path: string): Promise<unknown>;
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
  const child = spawn(process.execPath, ['--max-old-space-size=2048', workerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  onSpawn?.(child.pid);
  const pending = new Map<number, PendingInspection>();
  let nextId = 1;
  let stdoutBuffer = '';
  let stderr = '';
  let closed = false;
  let closeError: Error | undefined;

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
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  };
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${stderrDecoder.write(chunk)}`.slice(-MAX_RESPONSE_BYTES);
  });
  child.stdin.on('error', (error) => {
    closeError ??= error;
    rejectPending(error);
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += stdoutDecoder.write(chunk);
    if (Buffer.byteLength(stdoutBuffer, 'utf8') > MAX_RESPONSE_BYTES) {
      closeError = new Error('TypeScript inspection worker output exceeded its bounded buffer');
      child.kill('SIGKILL');
      return;
    }
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
      clearTimeout(request.timeout);
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
      const error = closeError ?? (status === 0 && signal === null
        ? undefined
        : new Error(
          `TypeScript inspection worker exited${signal ? ` with ${signal}` : ` with status ${String(status)}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
        ));
      if (error) rejectPending(error);
      resolveClosed();
    });
  });

  return Object.freeze({
    inspect(path: string): Promise<unknown> {
      if (closed || child.stdin.destroyed) {
        return Promise.reject(new Error(`Failed to inspect TypeScript module ${path}: inspection worker is closed`));
      }
      const id = nextId;
      nextId += 1;
      return new Promise((resolveInspection, rejectInspection) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          child.kill('SIGKILL');
          rejectInspection(new Error(`Failed to inspect TypeScript module ${path}: timed out`));
        }, INSPECTION_TIMEOUT_MS);
        pending.set(id, {
          path,
          resolve: resolveInspection,
          reject: rejectInspection,
          timeout,
        });
        child.stdin.write(`${JSON.stringify({ id, path })}\n`);
      });
    },
    async close(): Promise<void> {
      if (!closed && !child.stdin.destroyed) child.stdin.end();
      await closedPromise;
    },
  });
}

const activeInspectionSession = new AsyncLocalStorage<TypescriptModuleInspectionSession>();

export async function inspectTypescriptModule(path: string): Promise<unknown> {
  const active = activeInspectionSession.getStore();
  if (active) return await active.inspect(path);
  const session = createTypescriptModuleInspectionSession();
  try {
    return await session.inspect(path);
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
