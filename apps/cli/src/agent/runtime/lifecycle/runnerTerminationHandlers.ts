import type { EventEmitter } from 'node:events';
import { readSessionRuntimeFailureCause } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { writeSessionExitReportSync } from '@/session/diagnostics/sessionExitReport';
import { logger } from '@/ui/logger';
import { formatErrorForUi } from '@/ui/formatErrorForUi';

import { readHostedSessionScope, sessionProcessEnvironment, type HostedSessionScope } from './hostedSessionScope';

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
        terminationReason: params.outcome.terminationReason,
      },
    });
  } catch {
    // Diagnostic writes must never prevent process termination.
  }
}

type SessionRegistration = Readonly<{
  terminate: (event: RunnerTerminationEvent) => void;
  shouldTerminateOnUnhandledRejection?: (reason: unknown) => boolean;
}>;

/**
 * One owner per process for process signals, fatal errors and exit. Sessions
 * register with it; the process exits when its last Session has terminated.
 */
type ProcessTerminationHost = {
  sessions: Set<SessionRegistration>;
  dispose: () => void;
};
const processTerminationHosts = new WeakMap<ProcessLike, ProcessTerminationHost>();

type RunnerFatalEvent = Extract<RunnerTerminationEvent, { kind: 'unhandledRejection' | 'uncaughtException' }>;

function readFatalError(event: RunnerFatalEvent): unknown {
  return event.kind === 'unhandledRejection' ? event.reason : event.error;
}

function retainHostedFatalCause(scope: HostedSessionScope | undefined, failure: unknown): boolean {
  if (!scope?.end) return false;
  const cause = readSessionRuntimeFailureCause(failure);
  if (!cause) return false;
  scope.failureCause = cause;
  return true;
}

function reportUnattributedFatal(event: RunnerFatalEvent, scope: HostedSessionScope | undefined): void {
  const failure = readFatalError(event);
  try {
    logger.fatal(failure);
  } catch {
    // Fatal diagnostics must never stop the other hosted Sessions.
  }
  // A Session's startup can refuse before its runtime installs a process
  // listener. It still owns its command exit and any startup cleanup already bound.
  if (scope?.end && retainHostedFatalCause(scope, failure)) {
    requestHostedSessionTermination(scope, event);
    scope.end(computeRunnerTerminationOutcome(event).exitCode);
  }
}

function attachProcessTerminationHost(processLike: ProcessLike): ProcessTerminationHost {
  const existing = processTerminationHosts.get(processLike);
  if (existing) return existing;
  const sessions = new Set<SessionRegistration>();
  // A failure raised inside a hosted Session belongs to that Session, even
  // before registration. Without a hosted scope a sole runner owns the failure.
  const owningSession = (scope: HostedSessionScope | undefined): SessionRegistration | null => {
    for (const session of sessions) if (session === scope?.termination) return session;
    if (!scope?.end && sessions.size === 1) return sessions.values().next().value ?? null;
    return null;
  };
  const onSigterm = () => { for (const session of [...sessions]) session.terminate({ kind: 'signal', signal: 'SIGTERM' }); };
  const onSigint = () => { for (const session of [...sessions]) session.terminate({ kind: 'signal', signal: 'SIGINT' }); };
  const onUnhandledRejection = (reason: unknown) => {
    const event = { kind: 'unhandledRejection', reason } as const;
    const scope = readHostedSessionScope();
    const session = owningSession(scope);
    if (!session) {
      reportUnattributedFatal(event, scope);
      return;
    }
    const shouldTerminate = session.shouldTerminateOnUnhandledRejection;
    if (typeof shouldTerminate === 'function') {
      try {
        if (!shouldTerminate(reason)) {
          return;
        }
      } catch {
        // Defensive: if policy throws, treat as fatal.
      }
    }
    session.terminate(event);
  };
  const onUncaughtException = (error: unknown) => {
    const event = { kind: 'uncaughtException', error } as const;
    const scope = readHostedSessionScope();
    const session = owningSession(scope);
    if (!session) {
      reportUnattributedFatal(event, scope);
      return;
    }
    session.terminate(event);
  };
  processLike.on('SIGTERM', onSigterm);
  processLike.on('SIGINT', onSigint);
  processLike.on('unhandledRejection', onUnhandledRejection);
  processLike.on('uncaughtException', onUncaughtException);
  const host: ProcessTerminationHost = {
    sessions,
    dispose: () => {
      processLike.removeListener('SIGTERM', onSigterm);
      processLike.removeListener('SIGINT', onSigint);
      processLike.removeListener('unhandledRejection', onUnhandledRejection);
      processLike.removeListener('uncaughtException', onUncaughtException);
      processTerminationHosts.delete(processLike);
    },
  };
  processTerminationHosts.set(processLike, host);
  return host;
}

function leaveProcessTerminationHost(processLike: ProcessLike, session: SessionRegistration): ProcessTerminationHost | null {
  const host = processTerminationHosts.get(processLike);
  if (!host || !host.sessions.delete(session)) return null;
  if (host.sessions.size === 0) host.dispose();
  return host;
}

/**
 * End the current Session's command with `exitCode`: a Session added to a session host ends only
 * itself (the host reports its end), a one-Session runner exits its process as before.
 */
export function endSessionCommand(exitCode: number): void {
  const end = readHostedSessionScope()?.end;
  if (end) {
    end(exitCode);
    return;
  }
  process.exit(exitCode);
}

/** Bind the runtime's ordinary Stop before native construction can enter its refusal receiver. */
export function bindHostedSessionStop(stop: () => Promise<void>, processLifecycleOwnership?: 'self' | 'caller'): void {
  const scope = readHostedSessionScope();
  if (!scope?.end || processLifecycleOwnership === 'caller') return;
  const registration = { terminate: () => {
    void stop().catch((error: unknown) => {
      logger.infoFile('[RunnerTermination] Hosted Stop failed', { cause: formatErrorForUi(error) });
    });
  } } satisfies SessionRegistration;
  scope.termination = registration;
  if (scope.failureCause) registration.terminate();
}

/** Request termination of the Session whose scope this is (a host's per-Session Stop); false before it registered. */
export function requestHostedSessionTermination(scope: HostedSessionScope, event: RunnerTerminationEvent): boolean {
  const registration = scope.termination as SessionRegistration | null;
  if (!registration || typeof registration.terminate !== 'function') return false;
  registration.terminate(event);
  return true;
}

export function registerRunnerTerminationHandlers(params: Readonly<{
  process: ProcessLike;
  exit: (code: number) => void;
  onTerminate: (event: RunnerTerminationEvent, outcome: RunnerTerminationOutcome) => void | Promise<void>;
  /**
   * A composition root that owns process close decisions can retain the
   * canonical runtime termination path without installing a competing set of
   * process listeners or exiting behind that owner's confirmation UI.
   */
  processLifecycleOwnership?: 'self' | 'caller';
  sessionExitReport?: RunnerTerminationSessionExitReportOptions | null;
  /**
   * Optional policy hook to decide whether an unhandled rejection should
   * terminate this Session.
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

  const terminationTimeoutMs = readRunnerTerminationTimeoutMs(sessionProcessEnvironment());
  const ownsProcessLifecycle = params.processLifecycleOwnership !== 'caller';
  const sessionScope = ownsProcessLifecycle ? readHostedSessionScope() : undefined;

  const terminate = (event: RunnerTerminationEvent) => {
    if (terminated) return;
    terminated = true;

    if (event.kind === 'unhandledRejection' || event.kind === 'uncaughtException') {
      try {
        const failure = readFatalError(event);
        retainHostedFatalCause(sessionScope, failure);
        logger.fatal(failure);
      } catch {
        // Fatal diagnostics must never replace runner cleanup and exit semantics.
      }
    }

    const outcome = computeRunnerTerminationOutcome(event);
    writeRunnerTerminationSessionExitReport({ options: params.sessionExitReport, event, outcome });
    const terminationWork = Promise.resolve()
      .then(() => params.onTerminate(event, outcome))
      .catch((error: unknown) => {
        try {
          logger.infoFile('[RunnerTermination] Cleanup failed', {
            phase: 'termination-cleanup',
            terminationKind: event.kind,
            cause: formatErrorForUi(error),
          });
          logger.flushSync();
        } catch {
          // Diagnostics must never replace the original termination outcome.
        }
      });
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
        if (!ownsProcessLifecycle) return;
        const host = leaveProcessTerminationHost(params.process, registration);
        // A Session added to a session host ends only itself and reports its end to the host.
        sessionScope?.end?.(outcome.exitCode);
        // The process ends with its last registration (a session host holds its own while it runs).
        if (host && host.sessions.size === 0) params.exit(outcome.exitCode);
      });
  };

  const registration: SessionRegistration = {
    terminate,
    ...(params.shouldTerminateOnUnhandledRejection
      ? { shouldTerminateOnUnhandledRejection: params.shouldTerminateOnUnhandledRejection }
      : {}),
  };
  if (ownsProcessLifecycle) {
    attachProcessTerminationHost(params.process).sessions.add(registration);
    if (sessionScope) sessionScope.termination = registration;
  }

  return {
    requestTermination: terminate,
    whenTerminated,
    dispose: () => {
      if (!ownsProcessLifecycle || terminated) return;
      leaveProcessTerminationHost(params.process, registration);
    },
  };
}
