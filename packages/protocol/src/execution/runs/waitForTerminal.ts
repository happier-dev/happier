import { z } from 'zod';

import { ExecutionRunStatusSchema } from './listRequest.js';

/**
 * The statuses an execution run can END on, derived from the canonical enum in `listRequest.ts`
 * rather than restated.
 *
 * This module already owned the terminal *type*; it now owns the terminal *schema* too, because
 * three wire shapes (`execution.run.wait`, `execution.run.start({ waitForCompletion })` and the
 * session-scoped run wait) each inlined `z.enum(['succeeded','failed','cancelled','timeout'])` and
 * `isExecutionRunTerminalStatus` inlined the same four literals a fourth time. Five copies of one
 * vocabulary are five places a member can be added to and four places it can be forgotten — and the
 * presentation adapter (`sessions/work/agentActivity/adapters/fromExecutionRunStatus.ts`) is typed
 * against the canonical enum, so a member living only in a copy would reach a surface with no
 * mapping at all. Deriving keeps the wire members and their order byte-identical.
 */
export const ExecutionRunTerminalStatusSchema = ExecutionRunStatusSchema.exclude(['running']);
export type ExecutionRunTerminalStatus = z.infer<typeof ExecutionRunTerminalStatusSchema>;

export type ExecutionRunWaitFailure = Readonly<{
  ok: false;
  code: string;
  message?: string;
  details?: unknown;
}>;

export type ExecutionRunWaitReadResult<TData, TFailure extends ExecutionRunWaitFailure = ExecutionRunWaitFailure> =
  | Readonly<{ ok: true; data: TData }>
  | TFailure;

export type ExecutionRunWaitLoopResult<TData, TFailure extends ExecutionRunWaitFailure = ExecutionRunWaitFailure> =
  | Readonly<{
      ok: true;
      status: ExecutionRunTerminalStatus;
      result: TData;
    }>
  | TFailure
  | Readonly<{ ok: false; code: 'timeout' }>;

const DEFAULT_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS = 1_000;
const MIN_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS = 250;
const MAX_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS = 60_000;

export function normalizeExecutionRunWaitTimeoutMs(timeoutSeconds: unknown): number | null {
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return null;
  }
  return Math.max(1, Math.floor(timeoutSeconds * 1_000));
}

export function normalizeExecutionRunWaitPollIntervalMs(
  pollIntervalMs: unknown,
  fallbackMs = DEFAULT_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS,
): number {
  const parsed =
    typeof pollIntervalMs === 'number'
      ? pollIntervalMs
      : Number.parseInt(String(pollIntervalMs ?? '').trim(), 10);
  const fallback =
    Number.isFinite(fallbackMs) && fallbackMs > 0
      ? Math.trunc(fallbackMs)
      : DEFAULT_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS;
  const candidate = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
  return Math.max(
    MIN_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS,
    Math.min(MAX_EXECUTION_RUN_WAIT_POLL_INTERVAL_MS, candidate),
  );
}

export function isExecutionRunTerminalStatus(status: unknown): status is ExecutionRunTerminalStatus {
  return ExecutionRunTerminalStatusSchema.safeParse(status).success;
}

function readExecutionRunStatus(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const run = (value as Readonly<Record<string, unknown>>).run;
  if (!run || typeof run !== 'object' || Array.isArray(run)) return undefined;
  return (run as Readonly<Record<string, unknown>>).status;
}

function createAbortError(): Error {
  const error = new Error('Execution-run wait was aborted');
  error.name = 'AbortError';
  return error;
}

async function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw createAbortError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The shared observation loop for an already admitted execution-run transport.
 * It never starts, stops, retries, or retargets a run; a timeout only ends this
 * caller's observation. The host-specific transport supplies the exact read.
 */
export async function waitForExecutionRunTerminal<TData, TFailure extends ExecutionRunWaitFailure>(args: Readonly<{
  runId: string;
  timeoutMs: number | null;
  pollIntervalMs: unknown;
  signal?: AbortSignal;
  readRun: (request: Readonly<{ runId: string }>) => Promise<ExecutionRunWaitReadResult<TData, TFailure>>;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}>): Promise<ExecutionRunWaitLoopResult<TData, TFailure>> {
  const timeoutMs =
    typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? args.timeoutMs
      : null;
  const pollIntervalMs = normalizeExecutionRunWaitPollIntervalMs(args.pollIntervalMs);
  const now = args.now ?? Date.now;
  const deadlineMs = timeoutMs === null ? null : now() + timeoutMs;
  const delay = args.delay ?? delayWithAbort;

  while (deadlineMs === null || now() <= deadlineMs) {
    args.signal?.throwIfAborted();
    const result = await args.readRun({ runId: args.runId });
    if (!result.ok) return result;
    const status = readExecutionRunStatus(result.data);
    if (isExecutionRunTerminalStatus(status)) {
      return { ok: true, status, result: result.data };
    }
    await delay(pollIntervalMs, args.signal);
    args.signal?.throwIfAborted();
  }

  return { ok: false, code: 'timeout' };
}
