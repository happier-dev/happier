import type { EventEmitter } from 'node:events';

import { writeSessionExitReportSync } from '@/session/diagnostics/sessionExitReport';

import {
  computeRunnerTerminationOutcome,
  type RunnerTerminationEvent,
  type RunnerTerminationOutcome,
} from './runnerTerminationOutcome';

type ProcessLike = Pick<EventEmitter, 'on' | 'removeListener'>;
type RunnerTerminationSessionExitReportOptions = Readonly<{
  baseDir?: string;
  sessionId?: string | null;
  pid?: number;
  now?: () => number;
}>;

function clampTerminationTimeoutMs(rawValue: unknown, fallbackMs: number, maxMs: number): number {
  const raw = Number.parseInt(String(rawValue ?? ''), 10);
  const configured = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallbackMs;
  return Math.max(250, Math.min(maxMs, configured));
}

function readRunnerTerminationTimeoutMs(env?: NodeJS.ProcessEnv): number {
  return clampTerminationTimeoutMs(env?.HAPPIER_RUNNER_TERMINATION_TIMEOUT_MS, 10_000, 60_000);
}

export type RunnerTerminationHandlerRegistration = Readonly<{
  requestTermination: (event: RunnerTerminationEvent) => void;
  whenTerminated: Promise<Readonly<{ event: RunnerTerminationEvent; outcome: RunnerTerminationOutcome }>>;
  dispose: () => void;
}>;

function writeRunnerTerminationSessionExitReport(params: Readonly<{
  options: RunnerTerminationSessionExitReportOptions | null | undefined;
  event: RunnerTerminationEvent;
  outcome: RunnerTerminationOutcome;
}>): void {
  const options = params.options;
  if (!options) return;

  const observedAt = options.now?.() ?? Date.now();
  try {
    writeSessionExitReportSync({
      baseDir: options.baseDir,
      sessionId: options.sessionId ?? null,
      pid: options.pid ?? process.pid,
      report: {
        observedAt,
        observedBy: 'session',
        reason: 'runner-termination',
        terminationKind: params.event.kind,
        terminationSignal: params.event.kind === 'signal' ? params.event.signal : null,
        terminationRequestedAt: observedAt,
        terminationReason: params.outcome.archiveReason ?? null,
      },
    });
  } catch {
    // Diagnostic writes must never prevent process termination.
  }
}

export function registerRunnerTerminationHandlers(params: Readonly<{
  process: ProcessLike;
  exit: (code: number) => void;
  onTerminate: (event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>;
  sessionExitReport?: RunnerTerminationSessionExitReportOptions | null;
  /**
   * Optional policy hook to decide whether an unhandled rejection should
   * terminate the runner process.
   *
   * Defaults to terminating on all unhandled rejections.
   */
  shouldTerminateOnUnhandledRejection?: (reason: unknown) => boolean;
}>): RunnerTerminationHandlerRegistration {
  let terminated = false;
  let resolveWhenTerminated: (value: Readonly<{ event: RunnerTerminationEvent; outcome: RunnerTerminationOutcome }>) => void;
  const whenTerminated = new Promise<Readonly<{ event: RunnerTerminationEvent; outcome: RunnerTerminationOutcome }>>((resolve) => {
    resolveWhenTerminated = resolve;
  });

  const terminationTimeoutMs = readRunnerTerminationTimeoutMs(process.env);

  const terminate = (event: RunnerTerminationEvent) => {
    if (terminated) return;
    terminated = true;

    const outcome = computeRunnerTerminationOutcome(event);
    writeRunnerTerminationSessionExitReport({ options: params.sessionExitReport, event, outcome });
    const terminationWork = Promise.resolve()
      .then(() => params.onTerminate(event, outcome))
      .catch(() => undefined);
    const completion = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), terminationTimeoutMs);
      terminationWork.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    completion
      .catch(() => undefined)
      .finally(() => {
        resolveWhenTerminated({ event, outcome });
        params.exit(outcome.exitCode);
      });
  };

  const onSigterm = () => terminate({ kind: 'signal', signal: 'SIGTERM' });
  const onSigint = () => terminate({ kind: 'signal', signal: 'SIGINT' });
  const onUnhandledRejection = (reason: unknown) => {
    const shouldTerminate = params.shouldTerminateOnUnhandledRejection;
    if (typeof shouldTerminate === 'function') {
      try {
        if (!shouldTerminate(reason)) {
          return;
        }
      } catch {
        // Defensive: if policy throws, treat as fatal.
      }
    }
    terminate({ kind: 'unhandledRejection', reason });
  };
  const onUncaughtException = (error: unknown) => terminate({ kind: 'uncaughtException', error });

  params.process.on('SIGTERM', onSigterm);
  params.process.on('SIGINT', onSigint);
  params.process.on('unhandledRejection', onUnhandledRejection);
  params.process.on('uncaughtException', onUncaughtException);

  return {
    requestTermination: terminate,
    whenTerminated,
    dispose: () => {
      params.process.removeListener('SIGTERM', onSigterm);
      params.process.removeListener('SIGINT', onSigint);
      params.process.removeListener('unhandledRejection', onUnhandledRejection);
      params.process.removeListener('uncaughtException', onUncaughtException);
    },
  };
}
