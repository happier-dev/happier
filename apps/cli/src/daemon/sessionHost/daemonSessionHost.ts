import type { ChildProcess } from 'node:child_process';

import { isPidPresent } from '@happier-dev/cli-common/process';

import type { SpawnFailureLimitsReader } from '@/processes/spawnFailure/classifySpawnFailure';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import {
  SESSION_HOST_READY_LINE,
  addLocalSessionHostSession,
  endLocalSessionHostSession,
  handOverLocalSessionHost,
  removeExitedSessionHostDescriptor,
  watchLocalSessionHostSession,
  type LocalSessionHostSession,
  type SessionHostCommandEnd,
  type SessionHostAddRequest,
} from '@/session/transport/rpc/localSessionRpcChannel';
import { logger } from '@/ui/logger';
import type { HappyCliSubprocessLaunchOptions } from '@/utils/spawnHappyCLI';

import { buildDaemonOwnedSpawnChildEnv } from '../spawn/daemonOwnedSpawnChildEnvironment';
import { launchDetachedHappierProcess } from '../spawn/launchDetachedHappierProcess';
import { buildChildExitBeforeWebhookFailure } from '../spawn/childStderrDiagnostic';
import type { ChildExit } from '../sessions/onChildExited';
import type { TrackedSession } from '../types';

const SESSION_HOST_COMMAND = 'session-host';

/** Whether a process command line is this daemon's session host (`happier session-host`). */
export function isSessionHostProcessCommand(command: string | undefined): boolean {
  return typeof command === 'string' && command.trim().split(/\s+/).includes(SESSION_HOST_COMMAND);
}

/** One Session running in the daemon's session host. */
export type HostedSessionHandle = Readonly<{
  hostPid: number;
  /**
   * This Session's end: its exit code, or, when the host connection broke, the host process's own
   * exit (`hostLost`): a crashed host ends each of its Sessions with its exit code or signal.
   */
  ended: Promise<HostedSessionEnd>;
  /** Ask the host to end this Session; false when the host does not run it. */
  end(): Promise<boolean>;
}>;

export type HostedSessionEnd = Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null; hostLost: boolean; failureCause?: SessionHostCommandEnd['failureCause'] }>;

export type DaemonSessionHost = Readonly<{
  /**
   * Ensure the session host process exists (launched through the daemon's runner launch owner),
   * then add this Session to it. No process is started when the host already runs.
   */
  addSession(request: SessionHostAddRequest): Promise<
    | Readonly<{ status: 'added'; session: HostedSessionHandle }>
    | Readonly<{ status: 'failed'; result: SpawnSessionResult }>
  >;
  /**
   * Daemon restart: the reattached Sessions whose process is a live session host (marker pid,
   * birth and command identity) are hosted Sessions again — Stop goes through the host and each
   * Session's end is observed for that Session only — and that host takes new Sessions.
   * Returns how many Sessions were adopted.
   */
  adoptReattachedSessions(input: Readonly<{
    trackedSessions: Iterable<TrackedSession>;
    observeExit: (pid: number, exit: ChildExit) => void | Promise<void>;
    /**
     * Whether a live host runs the daemon's current runtime (by its process command). A host from
     * before a CLI update hands its Sessions over to a current host and exits (see the handover).
     */
    isCurrentRuntime?: (processCommand: string) => boolean;
  }>): number;
}>;

type HostExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
type RunningHost = Readonly<{
  pid: number;
  ready: Promise<boolean>;
  isRunning(): boolean;
  /** The host process's exit; null for a host this daemon adopted (not its child). */
  exited: Promise<HostExit> | null;
}>;

/** One Session's handle on its host, whatever daemon launched the host. */
function createHostedSessionHandle(host: RunningHost, trackingKey: string, session: LocalSessionHostSession): HostedSessionHandle {
  return {
    hostPid: host.pid,
    ended: session.ended.then(async ({ exitCode, failureCause }): Promise<HostedSessionEnd> => {
      if (exitCode !== null) return { exitCode, signal: null, hostLost: false, ...(failureCause ? { failureCause } : {}) };
      // The host connection broke: the host process is gone, and its exit is this Session's end.
      const exit = host.exited ? await host.exited : null;
      return { exitCode: exit?.code ?? null, signal: exit?.signal ?? null, hostLost: true };
    }),
    end: async () => {
      const result = await endLocalSessionHostSession({ hostPid: host.pid, trackingKey });
      if (result.status === 'termination_requested') return true;
      logger.warn('[DAEMON STOP] Hosted Session end refused', { hostPid: host.pid, trackingKey, status: result.status });
      return false;
    },
  };
}

/**
 * Resolves with the host's own pid once it printed its ready line, null if it exited first. The
 * launched process may be a launch supervisor (Linux scope exec), so only the host names its pid:
 * its endpoint descriptor, its Sessions' reports and their markers all carry that pid.
 */
function waitForHostReady(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    let buffered = '';
    const onData = (chunk: Buffer | string) => {
      buffered += String(chunk);
      const ready = new RegExp(`${SESSION_HOST_READY_LINE} (\\d+)\\n`).exec(buffered);
      if (!ready) return;
      // Keep draining the host's stdout so a full pipe can never block it.
      child.stdout?.off('data', onData);
      child.stdout?.resume();
      child.off('exit', onExit);
      resolve(Number(ready[1]));
    };
    const onExit = () => {
      child.stdout?.off('data', onData);
      resolve(null);
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

/**
 * The daemon's one session host: at most one host process runs at a time; Sessions are added to it
 * over its owner-only local endpoint. A host that ended (idle after its last Session, or crashed)
 * is replaced by a new one on the next add.
 */
export function createDaemonSessionHost(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  directory: string;
  runnerLaunchOptions?: HappyCliSubprocessLaunchOptions;
  readSpawnFailureLimits?: SpawnFailureLimitsReader;
  logDebug: (message: string, payload?: unknown) => void;
}>): DaemonSessionHost {
  let currentHost: Promise<RunningHost | Extract<SpawnSessionResult, { type: 'error' }>> | null = null;

  const launchHost = async (): Promise<RunningHost | Extract<SpawnSessionResult, { type: 'error' }>> => {
    const launched = await launchDetachedHappierProcess({
      args: ['session-host'],
      directory: params.directory,
      processEnv: params.processEnv,
      // The host serves the daemon's Home and server; ambient session-control keys are stripped.
      extraEnv: buildDaemonOwnedSpawnChildEnv(),
      ...(params.runnerLaunchOptions ? { runnerLaunchOptions: params.runnerLaunchOptions } : {}),
      ...(params.readSpawnFailureLimits ? { readSpawnFailureLimits: params.readSpawnFailureLimits } : {}),
      logDebug: params.logDebug,
    });
    if (launched.status !== 'launched') {
      return launched.result.type === 'error' ? launched.result : {
        type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED, errorMessage: 'Session host launch failed',
      };
    }
    const { child, pid: launchedPid } = launched.launch;
    const exited = new Promise<HostExit>((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); });
    const pid = await waitForHostReady(child);
    params.logDebug('[DAEMON RUN] Session host launched', { launchedPid, pid });
    if (pid === null) {
      const exit = await exited;
      launched.launch.flushDiagnostics();
      const stderr = launched.launch.readStderr();
      return buildChildExitBeforeWebhookFailure({ pid: launchedPid, ...exit,
        stderrTail: stderr.head, failureCause: stderr.failureCause });
    }
    void exited.then(() => removeExitedSessionHostDescriptor(pid)).catch((error: unknown) => {
      params.logDebug('[DAEMON RUN] Exited session host descriptor not removed', { pid, error });
    });
    return { pid, ready: Promise.resolve(true), isRunning: () => child.exitCode === null && child.signalCode === null, exited };
  };

  const ensureHost = async (): Promise<RunningHost | Extract<SpawnSessionResult, { type: 'error' }>> => {
    const pending = currentHost;
    if (pending) {
      const existing = await pending;
      if (currentHost !== pending) return await ensureHost();
      if (!('type' in existing) && existing.isRunning()) return existing;
    }
    // One launch shared by concurrent adds (assigned before any await); it settles once spawned.
    currentHost = launchHost();
    return await currentHost;
  };

  type AddResult = Awaited<ReturnType<DaemonSessionHost['addSession']>>
    | Readonly<{ status: 'closing'; result: SpawnSessionResult }>;
  const addToHost = async (request: SessionHostAddRequest): Promise<AddResult> => {
    const host = await ensureHost();
    if ('type' in host) return { status: 'failed' as const, result: host };
    if (!await host.ready) {
      return { status: 'failed' as const, result: {
        type: 'error' as const, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
        errorMessage: `Session host PID ${host.pid} exited before it was ready`,
      } };
    }
    const session = addLocalSessionHostSession({ hostPid: host.pid, request });
    if (await session.admitted) {
      return { status: 'added' as const, session: createHostedSessionHandle(host, request.trackingKey, session) };
    }
    const { closing } = await session.ended;
    return { status: closing ? 'closing' as const : 'failed' as const, result: {
      type: 'error' as const, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: `Session host PID ${host.pid} did not admit the Session`,
    } };
  };

  return {
    addSession: async (request) => {
      const first = await addToHost(request);
      if (first.status !== 'closing') return first;
      // The host was ending after its last Session (idle); a new host takes this Session.
      currentHost = null;
      const second = await addToHost(request);
      return second.status === 'closing' ? { status: 'failed' as const, result: second.result } : second;
    },
    adoptReattachedSessions: ({ trackedSessions, observeExit, isCurrentRuntime }) => {
      type AdoptedHost = Readonly<{ host: RunningHost; markLost(): void; current: boolean; watched: Array<Promise<boolean>> }>;
      const adoptedHosts = new Map<number, AdoptedHost>();
      const adoptHost = (pid: number, processCommand: string): AdoptedHost => {
        const known = adoptedHosts.get(pid);
        if (known) return known;
        let lost = false;
        const current = isCurrentRuntime?.(processCommand) ?? true;
        const host: RunningHost = {
          pid,
          ready: Promise.resolve(true),
          // A broken Session connection means the host died, even if its pid is reused later.
          isRunning: () => !lost && isPidPresent(pid),
          exited: null,
        };
        const adoptedHost = { host, markLost: () => { lost = true; }, current, watched: [] };
        adoptedHosts.set(pid, adoptedHost);
        // A live host of the current runtime takes new Sessions (no second host is started).
        if (current) currentHost ??= Promise.resolve(host);
        return adoptedHost;
      };
      let adopted = 0;
      for (const tracked of trackedSessions) {
        if (!tracked.reattachedFromDiskMarker || tracked.hostedSession || !isSessionHostProcessCommand(tracked.processCommand)) continue;
        const { host, markLost, watched: watchedOnHost } = adoptHost(tracked.pid, tracked.processCommand ?? '');
        const watched = watchLocalSessionHostSession({ hostPid: host.pid, trackingKey: tracked.trackingKey });
        watchedOnHost.push(watched.admitted);
        const handle = createHostedSessionHandle(host, tracked.trackingKey, watched);
        let resolveObserved!: () => void;
        const observed = new Promise<void>((resolve) => { resolveObserved = resolve; });
        tracked.hostedSession = { end: handle.end, observed };
        adopted += 1;
        void (async () => {
          const trackingKey = tracked.trackingKey;
          const refusal = await watched.admitted ? null : await watched.ended;
          if (refusal && !refusal.notHosted && !refusal.closing) {
            // Refused for another reason (host unreachable or peer check): keep this Session's
            // custody; the host process's own disappearance is observed as for any tracked pid.
            logger.warn('[DAEMON RUN] Reattached hosted Session could not be re-observed; retaining custody', { trackingKey });
            return;
          }
          let exit: ChildExit;
          if (refusal?.notHosted) {
            // The live host no longer runs it: the Session ended while no daemon observed it.
            exit = { reason: 'process-exited', code: null, signal: null, trackingKey };
          } else {
            const end = await handle.ended;
            if (end.hostLost) markLost();
            // A broken connection or a host no longer serving = the host process is gone: an
            // unexpected end of this Session (its respawn may adopt its held Agent).
            exit = end.hostLost
              ? { reason: 'process-missing', code: null, signal: null, trackingKey }
              : { reason: 'process-exited', code: end.exitCode, signal: null, trackingKey,
                ...(end.failureCause ? { failureCause: end.failureCause } : {}) };
          }
          await observeExit(host.pid, exit);
        })().catch((error: unknown) => {
          logger.warn('[DAEMON RUN] Reattached hosted Session exit observation failed', {
            trackingKey: tracked.trackingKey, error: error instanceof Error ? error.message : String(error),
          });
        }).finally(resolveObserved);
      }
      for (const { host, current, watched } of adoptedHosts.values()) {
        if (current) continue;
        // A host of an older runtime (CLI update): once each of its Sessions is observed here, it
        // hands them over and exits; each Session then takes the crash path (unexpected end → spare
        // its held Agent → respawn into the current host → adopt), so live Sessions move with no gap.
        void Promise.all(watched).then(async () => {
          const handingOver = await handOverLocalSessionHost({ hostPid: host.pid });
          logger.debug('[DAEMON RUN] Session host of an older runtime asked to hand over', { hostPid: host.pid, handingOver });
        }).catch((error: unknown) => {
          logger.warn('[DAEMON RUN] Session host handover request failed', {
            hostPid: host.pid, error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return adopted;
    },
  };
}

/**
 * The spawn placement decision: headless daemon-started Sessions run in the daemon's session host
 * (a one-Session runner is the same command in its own process). Windows keeps one runner process
 * per Session: callers cannot yet verify the local pipe server's identity. A host that is already
 * running when the daemon starts (its Sessions reattached from markers) is adopted: its Sessions
 * must be stopped and observed through it.
 */
export function createSessionHostPlacement(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  logDebug: (message: string, payload?: unknown) => void;
  platform?: NodeJS.Platform;
}>): Readonly<{
  place: () => DaemonSessionHost | undefined;
  adoptReattachedSessions: DaemonSessionHost['adoptReattachedSessions'];
}> {
  let host: DaemonSessionHost | null = null;
  const daemonHost = (): DaemonSessionHost =>
    host ??= createDaemonSessionHost({ processEnv: params.processEnv, directory: process.cwd(), logDebug: params.logDebug });
  return {
    place: () => (params.platform ?? process.platform) === 'win32' ? undefined : daemonHost(),
    adoptReattachedSessions: (input) => {
      const hosted = [...input.trackedSessions].filter(tracked => isSessionHostProcessCommand(tracked.processCommand));
      return hosted.length === 0 ? 0 : daemonHost().adoptReattachedSessions({ ...input, trackedSessions: hosted });
    },
  };
}
