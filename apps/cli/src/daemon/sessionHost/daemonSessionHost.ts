import type { SessionLifecycleStateReason } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { isPidPresent } from '@happier-dev/cli-common/process';
import { resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

import type { SpawnFailureLimitsReader } from '@/processes/spawnFailure/classifySpawnFailure';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import {
  SESSION_HOST_READY_LINE,
  addLocalSessionHostSession,
  endLocalSessionHostSession,
  handOverLocalSessionHost,
  holdLocalSessionHost,
  listLocalSessionHostPids,
  readIdleLocalSessionHost,
  readLocalSessionHostLiveWork,
  removeExitedSessionHostDescriptor,
  stopIdleLocalSessionHost,
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
import { SessionInputLiveWorkSchema } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import type { SessionInputLiveWork } from '@/agent/runtime/session/input/_types';

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
  end(lifecycleStateReason?: SessionLifecycleStateReason): Promise<boolean>;
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
   * A Session is about to be created on this Machine (New Session intent): ensure the host (the same
   * single launch as an add; nothing starts when one runs) and hold it, so it loads the runner code
   * now and the next add finds it ready. Resolves when the hold ends: `signal` aborted (the intent
   * ended) or the host is gone. Once no Session and no hold remains, the host ends as it does after
   * its last Session.
   */
  prestart(signal: AbortSignal): Promise<void>;
  /** Read the current host through its own admission owner for automatic memory reclaim. */
  readIdleHost(signal: AbortSignal): Promise<Readonly<{ pid: number; stop(signal: AbortSignal): Promise<boolean> }> | undefined>;
  /** Daemon shutdown retires an idle host. Live Sessions keep their host for reattachment. */
  stopIdleHost(): Promise<void>;
  /**
   * Daemon restart: the reattached Sessions whose process is a live session host (marker pid,
   * birth and command identity) are hosted Sessions again — Stop goes through the host and each
   * Session's end is observed for that Session only — and that host takes new Sessions.
   * Also reconciles host descriptors that have no live Session to re-observe.
   * Returns how many Sessions were adopted.
   */
  adoptReattachedSessions(input: Readonly<{
    trackedSessions: Iterable<TrackedSession>;
    observeExit: (pid: number, exit: ChildExit) => void | Promise<void>;
    readPersistedLifecycle: (sessionId: string, tracked: TrackedSession) => Promise<Readonly<{
      metadata: Record<string, unknown> | null;
      archivedAt: unknown;
    }>>;
    stopReattachedSession: (sessionId: string, tracked: TrackedSession) => Promise<void>;
    /** The re-adopted Session's current live work, read once from its host (a restarted daemon holds no push). */
    observeLiveWork?: (tracked: TrackedSession, liveWork: SessionInputLiveWork) => void;
    /**
     * Whether a live host runs the daemon's current runtime (by its process command). A host from
     * before a CLI update hands its Sessions over to a current host and exits (see the handover).
     */
    isCurrentRuntime?: (processCommand: string) => boolean;
  }>): number;
}>;

type HostExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
type HostLaunchResult = RunningHost | Extract<SpawnSessionResult, { type: 'error' }>;
type HostLaunch = { outcome: Promise<HostLaunchResult>; host: RunningHost | null };
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
    end: async (lifecycleStateReason) => {
      const result = await endLocalSessionHostSession({ hostPid: host.pid, trackingKey,
        ...(lifecycleStateReason ? { lifecycleStateReason } : {}) });
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
    const ready = new RegExp(`^${SESSION_HOST_READY_LINE} (\\d+)$`);
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', line => {
        const match = ready.exec(line);
        if (match) resolve(Number(match[1]));
      });
    }
    child.once('exit', () => resolve(null));
  });
}

/**
 * The daemon's one session host: at most one host process runs at a time; Sessions are added to it
 * over its owner-only local endpoint. A host that exited or was retired
 * is replaced by a new one on the next add.
 */
export function createDaemonSessionHost(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  directory: string;
  runnerLaunchOptions?: HappyCliSubprocessLaunchOptions;
  readSpawnFailureLimits?: SpawnFailureLimitsReader;
  logDebug: (message: string, payload?: unknown) => void;
}>): DaemonSessionHost {
  let currentHost: HostLaunch | null = null;

  const launchHost = async (): Promise<HostLaunchResult> => {
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

  const ensureHost = async (): Promise<HostLaunchResult> => {
    const pending = currentHost;
    if (pending) {
      const existing = await pending.outcome;
      if (currentHost !== pending) return await ensureHost();
      if (!('type' in existing) && existing.isRunning()) return existing;
    }
    // One launch shared by concurrent adds (assigned before any await); it settles once spawned.
    const launched: HostLaunch = { outcome: launchHost(), host: null };
    currentHost = launched;
    const outcome = await launched.outcome;
    if (!('type' in outcome)) launched.host = outcome;
    return outcome;
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
    const { closing, admissionFailure } = await session.ended;
    if (closing) {
      // Only forget the host that refused this Add. A concurrent Add may
      // already have started its replacement.
      if (currentHost?.host === host) currentHost = null;
    }
    return { status: closing ? 'closing' as const : 'failed' as const, result: {
      type: 'error' as const, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      errorMessage: `Session host PID ${host.pid} did not admit the Session${admissionFailure ? ` (${admissionFailure.code})` : ''}`,
      ...(admissionFailure ? { errorDetail: admissionFailure } : {}),
    } };
  };

  return {
    prestart: async (signal) => {
      if (signal.aborted) return;
      const host = await ensureHost();
      if ('type' in host || signal.aborted) return;
      const hold = holdLocalSessionHost({ hostPid: host.pid });
      const release = () => hold.release();
      signal.addEventListener('abort', release, { once: true });
      await hold.closed;
      signal.removeEventListener('abort', release);
    },
    readIdleHost: async (signal) => {
      const host = currentHost?.host;
      if (!host?.isRunning()) return;
      const stop = await readIdleLocalSessionHost(host.pid, signal);
      if (!stop || currentHost?.host !== host || !host.isRunning()) return;
      return { pid: host.pid, stop: async stopSignal => {
        if (stopSignal.aborted || currentHost?.host !== host || !host.isRunning()) return false;
        const stopping = await stop(stopSignal);
        logger.infoFile('[DAEMON RUN] Guard requested idle Session host retirement', { pid: host.pid, stopping });
        return stopping;
      } };
    },
    stopIdleHost: async () => {
      // An intent may have launched a host just before daemon shutdown canceled it.
      const host = await currentHost?.outcome;
      if (!host || 'type' in host || !host.isRunning()) return;
      if (await stopIdleLocalSessionHost(host.pid)) await host.exited;
    },
    addSession: async (request) => {
      const first = await addToHost(request);
      if (first.status !== 'closing') return first;
      // The retiring host did not admit the Session. Use the current host or launch one.
      const second = await addToHost(request);
      return second.status === 'closing' ? { status: 'failed' as const, result: second.result } : second;
    },
    adoptReattachedSessions: ({ trackedSessions, observeExit, readPersistedLifecycle, stopReattachedSession, observeLiveWork, isCurrentRuntime }) => {
      type AdoptedHost = Readonly<{ host: RunningHost; markLost(): void; current: boolean; reconciled: Array<Promise<boolean>> }>;
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
        const adoptedHost = { host, markLost: () => { lost = true; }, current, reconciled: [] };
        adoptedHosts.set(pid, adoptedHost);
        // A live host of the current runtime takes new Sessions (no second host is started).
        if (current) currentHost ??= { outcome: Promise.resolve(host), host };
        return adoptedHost;
      };
      let adopted = 0;
      for (const tracked of trackedSessions) {
        if (!tracked.reattachedFromDiskMarker || tracked.hostedSession || !isSessionHostProcessCommand(tracked.processCommand)) continue;
        const { host, markLost, reconciled } = adoptHost(tracked.pid, tracked.processCommand ?? '');
        const watched = watchLocalSessionHostSession({ hostPid: host.pid, trackingKey: tracked.trackingKey });
        const handle = createHostedSessionHandle(host, tracked.trackingKey, watched);
        let resolveObserved!: () => void;
        const observed = new Promise<void>((resolve) => { resolveObserved = resolve; });
        tracked.hostedSession = { end: handle.end, observed };
        adopted += 1;
        const sessionId = tracked.happySessionId;
        reconciled.push(watched.admitted.then(async (admitted) => {
          if (!admitted || !sessionId) return admitted;
          if (observeLiveWork) {
            const liveWork = SessionInputLiveWorkSchema.safeParse(
              await readLocalSessionHostLiveWork({ hostPid: host.pid, trackingKey: tracked.trackingKey }));
            if (liveWork.success) observeLiveWork(tracked, liveWork.data);
          }
          try {
            const state = await readPersistedLifecycle(sessionId, tracked);
            const admission = resolveSessionAutoResumeAdmissionV1({
              ...state, machineAvailable: true, authorityAvailable: state.metadata !== null,
            });
            if (admission === 'archived' || admission === 'held_by_person') {
              await stopReattachedSession(sessionId, tracked);
            }
          } catch {
            logger.warn('[DAEMON RUN] Could not apply recorded lifecycle to a reattached hosted Session', {
              trackingKey: tracked.trackingKey,
            });
          }
          return true;
        }));
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
      for (const { host, current, reconciled } of adoptedHosts.values()) {
        void Promise.all(reconciled).then(async (admitted) => {
          if (!admitted.some(Boolean)) {
            await stopIdleLocalSessionHost(host.pid);
            return;
          }
          if (current) return;
          // After applying recorded lifecycle changes, hand watched Sessions over through the
          // existing crash recovery path so the current host can adopt their held Agents.
          const handingOver = await handOverLocalSessionHost({ hostPid: host.pid });
          logger.debug('[DAEMON RUN] Session host of an older runtime asked to hand over', { hostPid: host.pid, handingOver });
        }).catch((error: unknown) => {
          logger.warn('[DAEMON RUN] Session host reconciliation failed', {
            hostPid: host.pid, error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      // A detached host publishes its own descriptor before any Session can write its marker.
      void listLocalSessionHostPids().then(async (pids) => {
        await Promise.all(pids.filter(pid => !adoptedHosts.has(pid) && pid !== currentHost?.host?.pid).map(stopIdleLocalSessionHost));
      }).catch((error: unknown) => {
        logger.warn('[DAEMON RUN] Session host descriptor reconciliation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return adopted;
    },
  };
}

/**
 * The spawn placement decision: headless daemon-started Sessions run in the daemon's session host
 * across supported platforms. A host that is already running when the daemon starts (its Sessions
 * reattached from markers) is adopted so its Sessions can be stopped and observed through it.
 */
export function createSessionHostPlacement(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
  logDebug: (message: string, payload?: unknown) => void;
}>): Readonly<{
  place: () => DaemonSessionHost;
  /** New Session intent: prestart the host where Sessions are hosted (see `DaemonSessionHost.prestart`). */
  prestart: (signal: AbortSignal) => Promise<void>;
  adoptReattachedSessions: DaemonSessionHost['adoptReattachedSessions'];
  readIdleHost: DaemonSessionHost['readIdleHost'];
  stopIdleHost: DaemonSessionHost['stopIdleHost'];
}> {
  let host: DaemonSessionHost | null = null;
  const place = (): DaemonSessionHost =>
    host ??= createDaemonSessionHost({ processEnv: params.processEnv, directory: process.cwd(), logDebug: params.logDebug });
  return {
    place,
    prestart: async (signal) => { await place().prestart(signal); },
    adoptReattachedSessions: (input) => place().adoptReattachedSessions(input),
    readIdleHost: async signal => await host?.readIdleHost(signal),
    stopIdleHost: async () => { await host?.stopIdleHost(); },
  };
}
