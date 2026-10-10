import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { ExecutionRunStatusSchema } from './listRequest.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';

/**
 * The statuses an execution run can END on, derived from the canonical enum in
 * `listRequest.ts` instead of restating the literals: the wait/start-and-wait
 * wire shapes and `isExecutionRunTerminalStatus` previously inlined this
 * vocabulary five times, and the presentation adapter is typed against the
 * canonical enum. Deriving keeps the wire members and their order byte-identical.
 */
export const ExecutionRunTerminalStatusSchema = lazyZodSchema(() => ExecutionRunStatusSchema.exclude(['running']));
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
  | Readonly<{ ok: true; status: 'running'; disposition: 'needs_attention'; result: TData }>
  | Readonly<{ ok: true; status: z.infer<typeof ExecutionRunStatusSchema>; disposition: 'snapshot'; result: TData }>
  | Readonly<{
      ok: true;
      status: ExecutionRunTerminalStatus;
      disposition: 'observation_timeout';
      result: TData;
      runId: string;
      timeoutMs: number;
      observedAtMs: number;
      deadlineAtMs: number;
    }>
  | Readonly<{
      ok: true;
      status: 'running';
      disposition: 'observation_timeout';
      runId: string;
      timeoutMs: number;
      observedAtMs: number;
      deadlineAtMs: number;
    }>
  | TFailure;

export const ExecutionRunWaitConditionSchema = lazyZodSchema(() => z.enum(['terminal', 'needs_attention', 'terminal_or_needs_attention', 'change']));
export type ExecutionRunWaitCondition = z.infer<typeof ExecutionRunWaitConditionSchema>;

export function normalizeExecutionRunWaitTimeoutMs(timeoutSeconds: unknown): number | null {
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return null;
  }
  return Math.max(1, Math.floor(timeoutSeconds * 1_000));
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

/** Permission facts are projected by the host from its current request store. */
export function executionRunNeedsAttention(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('run' in value)) return false;
  const run = value.run;
  if (!run || typeof run !== 'object' || !('attention' in run)) return false;
  const attention = run.attention;
  return readExecutionRunStatus(value) === 'running' && !!attention && typeof attention === 'object'
    && 'kind' in attention && attention.kind === 'permission_required'
    && 'requestIds' in attention && Array.isArray(attention.requestIds) && attention.requestIds.length > 0;
}

function createAbortError(): Error {
  const error = new Error('Execution-run wait was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * The shared event-driven observer for an already admitted execution run.
 * It never starts, stops, retries, or retargets a run; a timeout only ends this
 * caller's observation. The host supplies its canonical terminal promise and
 * exact snapshot read, so callers do not create polling sockets or duplicate
 * run-lifecycle state.
 */
export async function waitForExecutionRunTerminal<TData, TFailure extends ExecutionRunWaitFailure>(args: Readonly<{
  runId: string;
  timeoutMs: number | null;
  signal?: AbortSignal;
  condition?: ExecutionRunWaitCondition;
  /** The last owner snapshot for passive state observation, not an event-history cursor. */
  after?: unknown;
  readRun: (request: Readonly<{ runId: string }>) => Promise<ExecutionRunWaitReadResult<TData, TFailure>>;
  waitForTerminal: (runId: string, signal?: AbortSignal) => Promise<void>;
  /** Registration must happen before this function returns its promise. */
  waitForChange?: (runId: string, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}>): Promise<ExecutionRunWaitLoopResult<TData, TFailure>> {
  const timeoutMs =
    typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? args.timeoutMs
      : null;
  const now = args.now ?? Date.now;
  const deadlineMs = timeoutMs === null ? null : now() + timeoutMs;
  const condition = args.condition ?? 'terminal';
  const match = (data: TData): ExecutionRunWaitLoopResult<TData, TFailure> | null => {
    const status = readExecutionRunStatus(data);
    if (condition === 'change') {
      // Compare the transport shape, not property insertion order or optional
      // undefined values omitted by JSON delivery. Reuse the Protocol comparator.
      return args.after === undefined || !sameStrictJsonValue(
        JSON.parse(JSON.stringify(data)), JSON.parse(JSON.stringify(args.after)),
      )
        ? { ok: true, status: ExecutionRunStatusSchema.parse(status), disposition: 'snapshot', result: data } : null;
    }
    if (condition !== 'terminal' && executionRunNeedsAttention(data)) {
      return { ok: true, status: 'running', disposition: 'needs_attention', result: data };
    }
    return condition !== 'needs_attention' && isExecutionRunTerminalStatus(status)
      ? { ok: true, status, result: data } : null;
  };

  args.signal?.throwIfAborted();
  const initial = await args.readRun({ runId: args.runId });
  if (!initial.ok) return initial;
  const initialMatch = match(initial.data);
  // A public terminal projection can precede transcript/retained completion
  // custody. Only passive snapshots and attention bypass that host barrier.
  if (initialMatch && 'disposition' in initialMatch) return initialMatch;
  // The initial snapshot is asynchronous. Re-check before creating the terminal
  // observation so an abort delivered during that read cannot be lost before
  // the listener below is attached.
  args.signal?.throwIfAborted();

  const terminalObserverAbort = new AbortController();
  let conditionResult: ExecutionRunWaitLoopResult<TData, TFailure> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  const terminal = condition === 'terminal' || initialMatch !== null
    ? args.waitForTerminal(args.runId, terminalObserverAbort.signal).then(() => 'terminal' as const)
    : (async () => {
        if (!args.waitForChange) throw new Error('Execution-run condition observation requires the owner change source');
        while (true) {
          terminalObserverAbort.signal.throwIfAborted();
          const change = args.waitForChange(args.runId, terminalObserverAbort.signal);
          // Keep an abort rejection handled even when the re-read matches first.
          void change.catch(() => {});
          const current = await args.readRun({ runId: args.runId });
          conditionResult = current.ok ? match(current.data) : current;
          if (conditionResult) {
            if (conditionResult.ok && !('disposition' in conditionResult)) {
              // A combined wait must preserve the same completion/custody
              // barrier as a terminal-only wait, not stop at an early projection.
              await args.waitForTerminal(args.runId, terminalObserverAbort.signal);
              const settled = await args.readRun({ runId: args.runId });
              conditionResult = settled.ok ? match(settled.data) : settled;
              if (!conditionResult) throw new Error('Execution-run terminal owner resolved without matching state');
            }
            return 'terminal' as const;
          }
          await change;
        }
      })();
  const observationEnd = new Promise<'timeout'>((resolve, reject) => {
    if (timeoutMs !== null) {
      const arm = () => {
        const remainingMs = deadlineMs! - now();
        // Node uses a signed 32-bit timer delay. This chunks scheduling only;
        // it never caps the caller's observation duration.
        timer = setTimeout(() => {
          if (now() < deadlineMs!) arm();
          else resolve('timeout');
        }, Math.min(2_147_483_647, Math.max(0, remainingMs)));
      };
      arm();
    }
    if (args.signal) {
      onAbort = () => reject(createAbortError());
      args.signal.addEventListener('abort', onAbort, { once: true });
      if (args.signal.aborted) onAbort();
    }
  });

  let disposition: 'terminal' | 'timeout';
  try {
    disposition = timeoutMs === null && !args.signal
      ? await terminal
      : await Promise.race([terminal, observationEnd]);
  } finally {
    terminalObserverAbort.abort(createAbortError());
    if (timer !== null) clearTimeout(timer);
    if (onAbort && args.signal) args.signal.removeEventListener('abort', onAbort);
  }

  args.signal?.throwIfAborted();
  // Attention can clear again before an asynchronous second read. Return the
  // actual owner snapshot that satisfied the requested condition.
  if (disposition === 'terminal' && conditionResult) return conditionResult;
  const final = await args.readRun({ runId: args.runId });
  if (!final.ok) return final;
  const finalMatch = match(final.data);
  // Expiration while custody is pending ends observation, even if the public
  // snapshot already projects a terminal status. It cannot certify completion.
  if (finalMatch && (disposition === 'terminal' || 'disposition' in finalMatch)) return finalMatch;

  if (disposition === 'terminal') {
    throw new Error('Execution-run terminal signal resolved before its canonical state became terminal');
  }
  if (deadlineMs === null || timeoutMs === null) {
    throw new Error('Execution-run wait timed out without an observation deadline');
  }

  const observedAtMs = now();
  const finalStatus = readExecutionRunStatus(final.data);
  if (isExecutionRunTerminalStatus(finalStatus)) {
    return { ok: true, status: finalStatus, disposition: 'observation_timeout', result: final.data,
      runId: args.runId, timeoutMs, observedAtMs, deadlineAtMs: deadlineMs };
  }
  return {
    ok: true,
    status: 'running',
    disposition: 'observation_timeout',
    runId: args.runId,
    timeoutMs,
    observedAtMs,
    deadlineAtMs: deadlineMs,
  };
}
