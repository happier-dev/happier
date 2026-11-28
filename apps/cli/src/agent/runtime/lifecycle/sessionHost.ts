import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionLifecycleStateReason } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { EventEmitter } from 'node:events';

import { logger } from '@/ui/logger';
import {
  serveLocalSessionHost,
  SESSION_HOST_HANDOVER_EXIT_CODE,
  SessionHostClosingError,
  type SessionHostAddRequest,
  type SessionHostCommandEnd,
  type SessionHostLaunchRecordV1,
  type LocalSessionHostEndResult,
} from '@/session/transport/rpc/localSessionRpcChannel';
import { shareAccountUpdatesInThisProcess } from '@/api/session/sharedAccountUpdatesSocket';

import { readHostedSessionScope, runAddedHostedSession, saveHostedSessionForHandover, type HostedSessionScope } from './hostedSessionScope';
import { registerRunnerTerminationHandlers, requestHostedSessionTermination } from './runnerTerminationHandlers';
import type { RunnerTerminationEvent } from './runnerTerminationOutcome';
import type { ProcessBirthWitness } from '@/daemon/processIdentity';

export { SESSION_HOST_IDLE_EXPIRED_LINE, SESSION_HOST_READY_LINE } from '@/session/transport/rpc/localSessionRpcChannel';

// Cover an immediate follow-up Start while bounding retention of a loaded runner.
// The P03 source fixture exercises a two-second idle gap, and the New Session prestart
// fixture exercises ten seconds of think time. The compiled host import alone was
// about 105 MiB PSS, and a provider-loaded host can retain about 336 MiB.
const SESSION_HOST_IDLE_GRACE_MS = 10_000;

export type SessionHost = Readonly<{
  /** Same contract as the daemon's add call: resolves with the Session's exit code when it ends. */
  addSession(request: SessionHostAddRequest): Promise<SessionHostCommandEnd>;
  endSession(trackingKey: string, lifecycleStateReason?: SessionLifecycleStateReason): LocalSessionHostEndResult;
  /** This running Session's end, for a daemon that re-observes it after a restart. */
  watchSession(trackingKey: string): Promise<SessionHostCommandEnd> | null;
  /** Hand every Session to a newer host (see `LocalSessionHostAdmission.handOver`). */
  handOver(): boolean;
  /** Keep the host for a Session about to be created (see `LocalSessionHostAdmission.hold`). */
  hold(): () => void;
  /** Settles after idle retirement or process termination. */
  whenEnded: Promise<void>;
}>;

/**
 * One process that runs many daemon-started Sessions. Each added Session runs the ordinary runner
 * command (its own argv, environment and working directory) inside its own hosted Session scope; a
 * Session that fails or is stopped ends only itself. The host holds its own registration with the
 * process termination owner, so the process lives while the host runs and signals still fan out to
 * every Session. It stays warm for a grace period after its last Session or hold ends. A daemon
 * that expects a Session soon (a New Session intent) holds the host and preloads the runner.
 */
export async function startSessionHost(params: Readonly<{
  /**
   * Runs one Session's runner command line (the CLI dispatch in production) with the launch facts
   * its daemon admitted, inside that Session's scope.
   */
  runSessionCommand: (argv: readonly string[], launch: SessionHostLaunchRecordV1) => Promise<void>;
  /** The daemon that launched this host: the only caller admitted on its endpoint. */
  readTrustedCaller: () => Promise<ProcessBirthWitness | null>;
  /** Loads the runner code a Session command runs, before the first held-for Session arrives. */
  preloadSessionRunner?: () => Promise<unknown>;
  reportIdleExpiry?: () => void;
  process?: Pick<EventEmitter, 'on' | 'removeListener'>;
  exit?: (code: number) => void;
}>): Promise<SessionHost> {
  const sessions = new Map<string, { scope: HostedSessionScope | null; ended: Promise<SessionHostCommandEnd> }>();
  // Every hosted Session of one Account shares one Account update connection.
  shareAccountUpdatesInThisProcess();
  let closing = false;
  let holds = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  // An ended runner can call end() in its own scope. Allocate the timer in the host's
  // scope so it does not retain the ended Session's context for the idle period.
  const runInHostScope = AsyncLocalStorage.snapshot();
  const cancelIdleEnd = (): void => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  let runnerPreload: Promise<unknown> | null = null;
  let retireEndpoint: (() => Promise<void>) | null = null;
  const exit = params.exit ?? ((code: number) => process.exit(code));
  const termination = registerRunnerTerminationHandlers({
    process: params.process ?? process,
    exit,
    onTerminate: async () => {
      closing = true;
      cancelIdleEnd();
      await retireEndpoint?.();
    },
  });
  const retireIfIdle = (event: RunnerTerminationEvent): boolean => {
    if (sessions.size > 0 || holds > 0 || closing) return false;
    closing = true;
    cancelIdleEnd();
    termination.requestTermination(event);
    return true;
  };
  const endWhenIdle = (): void => {
    if (sessions.size > 0 || holds > 0 || closing || idleTimer !== undefined) return;
    idleTimer = runInHostScope(() => setTimeout(() => {
      if (retireIfIdle({ kind: 'exit', code: 0 })) {
        logger.infoFile('[session-host] Idle grace expired', { idleGraceMs: SESSION_HOST_IDLE_GRACE_MS });
        logger.flushSync();
        params.reportIdleExpiry?.();
      }
    }, SESSION_HOST_IDLE_GRACE_MS));
  };

  const addSession = (request: SessionHostAddRequest): Promise<SessionHostCommandEnd> => {
    if (closing) throw new SessionHostClosingError('The session host is ending');
    if (sessions.has(request.trackingKey)) throw new Error('This Session is already hosted');
    cancelIdleEnd();
    let resolveEnded!: (end: SessionHostCommandEnd) => void;
    const session = {
      scope: null as HostedSessionScope | null,
      ended: new Promise<SessionHostCommandEnd>((resolve) => { resolveEnded = resolve; }),
    };
    sessions.set(request.trackingKey, session);
    let ended = false;
    const end = (exitCode: number): void => {
      if (ended) return;
      ended = true;
      sessions.delete(request.trackingKey);
      const failureCause = session.scope?.failureCause;
      resolveEnded({ exitCode, ...(failureCause ? { failureCause } : {}) });
      endWhenIdle();
    };
    const launch = request.launch ?? {};
    // Admission can throw while parsing policy, before the async command starts.
    void (async () => {
      await runAddedHostedSession({ environment: { ...request.env }, workingDirectory: request.cwd, end,
        ...(launch.runnerBootstrap ? { runnerBootstrap: launch.runnerBootstrap } : {}) }, async () => {
        session.scope = readHostedSessionScope() ?? null;
        await params.runSessionCommand(request.argv, launch);
      });
    })().then(() => end(0), (error: unknown) => {
      logger.warn('[session-host] Session command failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      end(1);
    });
    return session.ended;
  };
  const endSession = (trackingKey: string, lifecycleStateReason?: SessionLifecycleStateReason): LocalSessionHostEndResult => {
    const scope = sessions.get(trackingKey)?.scope;
    if (!scope) return { status: 'not_hosted' };
    return { status: requestHostedSessionTermination(scope, { kind: 'signal', signal: 'SIGTERM',
      ...(lifecycleStateReason ? { lifecycleStateReason } : {}) })
      ? 'termination_requested' : 'termination_unavailable' };
  };
  const watchSession = (trackingKey: string) => sessions.get(trackingKey)?.ended ?? null;
  const readSessionLiveWork = (trackingKey: string) => sessions.get(trackingKey)?.scope?.readLiveWork?.() ?? null;
  const hold = (preloadRunner = true): (() => void) => {
    if (closing) throw new SessionHostClosingError('The session host is ending');
    cancelIdleEnd();
    holds += 1;
    if (preloadRunner) {
      runnerPreload ??= (params.preloadSessionRunner?.() ?? Promise.resolve()).catch((error: unknown) => {
        // The Session command loads the same code itself; a failed preload only loses the head start.
        logger.warn('[session-host] Runner preload failed', { error: error instanceof Error ? error.message : String(error) });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds -= 1;
      endWhenIdle();
    };
  };
  // Update: the same path as a crash, without the loss. No Session is ended (ending one would end its
  // Agent); the host stops admitting, writes its holder acknowledgements and exits, and the newer
  // host adopts every holder, which replays only the output this host never delivered.
  const handOver = (): boolean => {
    if (closing) return false;
    closing = true;
    cancelIdleEnd();
    void (async () => {
      await retireEndpoint?.();
      const { handOverSessionHolderClients, pauseSessionHolderDelivery } = await import('@/subprocess/supervision/sessionHolder');
      // Agent output this host took is already acknowledged, so the newer host never replays it:
      // stop taking more (it stays in the holders for the newer host), then save what was taken.
      pauseSessionHolderDelivery();
      await Promise.all([...sessions.values()].map(async session => {
        if (session.scope) await saveHostedSessionForHandover(session.scope);
      }));
      await handOverSessionHolderClients();
    })().catch((error: unknown) => {
      logger.warn('[session-host] Handover flush failed', { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => exit(SESSION_HOST_HANDOVER_EXIT_CODE));
    return true;
  };

  try {
    retireEndpoint = await serveLocalSessionHost({ addSession, endSession, watchSession, readSessionLiveWork, handOver, hold,
      stopIfIdle: () => retireIfIdle({ kind: 'signal', signal: 'SIGTERM' }),
      readTrustedCaller: params.readTrustedCaller });
  } catch (error) {
    closing = true;
    termination.dispose();
    throw error;
  }
  return {
    addSession,
    endSession,
    watchSession,
    handOver,
    hold,
    whenEnded: termination.whenTerminated.then(() => undefined),
  };
}
