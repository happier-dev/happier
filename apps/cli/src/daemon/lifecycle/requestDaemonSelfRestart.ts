import { isPidPresent } from '@happier-dev/cli-common/process';
import { CredentialRequestRedirectError, fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import type { DaemonLocallyPersistedState } from '@/persistence';
import { readDaemonState } from '@/persistence';
import { logger } from '@/ui/logger';
import { spawnDetachedDaemonStartSync } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import type { DetachedDaemonStartProcess } from '@/daemon/runtime/spawnDetachedDaemonStartSync';
import { buildDaemonControlHttpHeaders, DAEMON_CONTROL_TOKEN_HEADER } from '@/daemon/controlHttp';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';
import {
  hasObservableDaemonStartProcessExited,
  hasObservableDaemonStartProcessRunning,
  waitForDaemonRunningWithinBudget,
  type DaemonStartProcessObservation,
} from '@/daemon/waitForDaemonRunningWithinBudget';

export type RequestDaemonSelfRestartResult =
  | { status: 'exited' }
  | { status: 'spawn_failed'; error: unknown }
  | { status: 'replacement_not_confirmed' };

type SpawnDetachedDaemonStartSync = (
  options?: Parameters<typeof spawnDetachedDaemonStartSync>[0],
) => Promise<Partial<DetachedDaemonStartProcess>>;
type ReadDaemonState = () => Promise<DaemonLocallyPersistedState | null>;
type ConfirmReplacementDaemonState = (state: DaemonLocallyPersistedState) => Promise<boolean>;
/**
 * Subscribes to whether this daemon's machine socket is online. The listener is called
 * immediately with the current value; the returned function unsubscribes.
 */
export type ObserveMachineConnectionOnline = (listener: (online: boolean) => void) => () => void;
type MachineConnectionHandover = 'handed_over' | 'not_connected' | 'successor_stopped' | 'budget_elapsed';

/**
 * The handover input for a self-restart: the incumbent's machine connection, observed as online or
 * not. A successor sent to another server can never take this socket over, so none is offered.
 */
export function resolveMachineConnectionHandover(params: Readonly<{
  successorServerUrl?: string;
  configuredServerUrl: string;
  getMachineClient: () => Readonly<{
    onConnectionStateChange: (listener: (state: ManagedConnectionState) => void) => () => void;
  }> | null;
}>): { observeMachineConnectionOnline?: ObserveMachineConnectionOnline } {
  if (
    params.successorServerUrl
    && normalizeServerHttpBaseUrl(params.successorServerUrl)
      !== normalizeServerHttpBaseUrl(params.configuredServerUrl)
  ) {
    return {};
  }
  return {
    observeMachineConnectionOnline: (listener) => {
      const client = params.getMachineClient();
      if (!client) {
        listener(false);
        return () => {};
      }
      return client.onConnectionStateChange((state) => listener(state.phase === 'online'));
    },
  };
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number | null | undefined): boolean {
  // `isPidPresent` owns "can this value even name a process", so this only narrows the type.
  return typeof pid === 'number' && isPidPresent(pid);
}

function hasAuthenticatedPingDetails(state: DaemonLocallyPersistedState): boolean {
  const httpPort = typeof state.httpPort === 'number' && Number.isFinite(state.httpPort)
    ? state.httpPort
    : null;
  const controlToken = typeof state.controlToken === 'string' ? state.controlToken.trim() : '';
  return Boolean(httpPort && controlToken);
}

async function confirmReplacementDaemonState(state: DaemonLocallyPersistedState): Promise<boolean> {
  if (!isPidAlive(state.pid)) return false;

  const httpPort = typeof state.httpPort === 'number' && Number.isFinite(state.httpPort)
    ? state.httpPort
    : null;
  const controlToken = typeof state.controlToken === 'string' ? state.controlToken.trim() : '';
  if (!httpPort || !controlToken) {
    return true;
  }

  try {
    const response = await fetchWithCredentialRedirectRefusal(`http://127.0.0.1:${httpPort}/ping`, {
      method: 'POST',
      headers: buildDaemonControlHttpHeaders(controlToken),
      body: '{}',
      signal: AbortSignal.timeout(1_000),
    }, undefined, new Set([DAEMON_CONTROL_TOKEN_HEADER]));
    if (!response.ok) return false;

    const rawBody = await response.text();
    if (!rawBody.trim()) return true;
    const parsed = JSON.parse(rawBody) as unknown;
    return !(parsed && typeof parsed === 'object' && (parsed as { success?: unknown }).success === false);
  } catch (error) {
    if (error instanceof CredentialRequestRedirectError) throw error;
    return false;
  }
}

export async function waitForReplacementDaemon(params: Readonly<{
  ownPid: number;
  expectedCliVersion: string;
  expectedRuntimeId?: string | null;
  timeoutMs: number;
  deadlineAtMs?: number;
  pollMs: number;
  startupProcess?: DaemonStartProcessObservation;
  readDaemonStateImpl?: ReadDaemonState;
  confirmReplacementStateImpl?: ConfirmReplacementDaemonState;
}>): Promise<boolean> {
  const {
    ownPid,
    expectedRuntimeId,
    timeoutMs,
    pollMs,
    readDaemonStateImpl = readDaemonState,
    confirmReplacementStateImpl = confirmReplacementDaemonState,
  } = params;
  const normalizedExpectedCliVersion = String(params.expectedCliVersion ?? '').trim();
  const normalizedExpectedRuntimeId = typeof expectedRuntimeId === 'string' ? expectedRuntimeId.trim() : '';
  const deadline = params.deadlineAtMs ?? Date.now() + timeoutMs;
  let lastObserved: Readonly<{
    pid: number;
    startedWithCliVersion?: string;
    runtimeId?: string;
    reason: string;
  }> | null = null;
  const isStillStarting = () => params.startupProcess !== undefined
    && hasObservableDaemonStartProcessRunning(params.startupProcess);
  const replacementConfirmed = (Date.now() < deadline || isStillStarting())
    && await waitForDaemonRunningWithinBudget({
      isRunning: async () => {
        const daemonState = await readDaemonStateImpl();
        if (daemonState) {
          const observed = {
            pid: daemonState.pid,
            startedWithCliVersion: daemonState.startedWithCliVersion,
            runtimeId: daemonState.runtimeId,
          };
          if (daemonState.pid === ownPid) {
            lastObserved = { ...observed, reason: 'own_pid' };
          } else if (normalizedExpectedCliVersion && daemonState.startedWithCliVersion !== normalizedExpectedCliVersion) {
            lastObserved = { ...observed, reason: 'version_mismatch' };
          } else if (normalizedExpectedRuntimeId && daemonState.runtimeId !== normalizedExpectedRuntimeId) {
            lastObserved = { ...observed, reason: 'runtime_mismatch' };
          } else if (normalizedExpectedRuntimeId && !hasAuthenticatedPingDetails(daemonState)) {
            lastObserved = { ...observed, reason: 'authenticated_ping_unavailable' };
          } else if (await confirmReplacementStateImpl(daemonState)) {
            return true;
          } else {
            lastObserved = { ...observed, reason: 'confirmation_failed' };
          }
        } else {
          lastObserved = null;
        }
        return false;
      },
      shouldAbort: () => (
        lastObserved?.pid === (params.startupProcess?.detachedDaemonPid ?? params.startupProcess?.pid)
        && (lastObserved?.reason === 'version_mismatch' || lastObserved?.reason === 'runtime_mismatch')
      ) || (
        params.startupProcess !== undefined
        && hasObservableDaemonStartProcessExited(params.startupProcess)
      ),
      isStillStarting,
      onStillStarting: () => logger.debug('[DAEMON RUN] Replacement daemon is still starting; waiting for authenticated readiness'),
      timeoutMs,
      initialTimeoutMs: Math.max(0, deadline - Date.now()),
      pollMs,
    });
  if (replacementConfirmed) return true;
  logger.debug('[DAEMON RUN] Replacement daemon confirmation ended without authenticated readiness', {
    expectedCliVersion: normalizedExpectedCliVersion || undefined,
    expectedRuntimeId: normalizedExpectedRuntimeId || undefined,
    lastObserved,
  });
  return false;
}

/**
 * After the successor is confirmed, the incumbent keeps serving its machine socket until the
 * server moves the machine connection to the successor. The server's machine-socket ownership
 * registry admits one socket per machine runtime and disconnects the older one when the
 * successor's socket claims it, so the incumbent leaving `online` is the handover itself.
 * If the successor stops first, the incumbent still exits, as it did before the handover existed
 * (the successor owns the lock and state by now). The restart verification budget bounds the
 * wait so a successor that never connects cannot keep two daemons serving indefinitely.
 */
async function waitForMachineConnectionHandover(params: Readonly<{
  observeOnline: ObserveMachineConnectionOnline;
  successorPid: number;
  timeoutMs: number;
  pollMs: number;
  readDaemonStateImpl: ReadDaemonState;
}>): Promise<MachineConnectionHandover> {
  const deadline = Date.now() + params.timeoutMs;
  let online = false;
  let resolveOffline: () => void = () => {};
  const wentOffline = new Promise<'offline'>((resolve) => {
    resolveOffline = () => resolve('offline');
  });
  const unsubscribe = params.observeOnline((next) => {
    online = next;
    if (!next) resolveOffline();
  });
  try {
    if (!online) return 'not_connected';
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return 'budget_elapsed';
      const tick = await Promise.race([
        wentOffline,
        delay(Math.min(params.pollMs, remainingMs)).then(() => 'poll' as const),
      ]);
      if (tick === 'offline') return 'handed_over';
      const state = await params.readDaemonStateImpl().catch(() => null);
      if (state?.pid !== params.successorPid || !isPidAlive(params.successorPid)) return 'successor_stopped';
    }
  } finally {
    unsubscribe();
  }
}

export async function requestDaemonSelfRestart(params: Readonly<{
  runtimeId?: string | null;
  expectedCliVersion: string;
  ownPid?: number;
  timeoutMs: number;
  deadlineAtMs?: number;
  pollMs: number;
  postConfirmationOverlapMs?: number;
  onReplacementConfirmed?: () => Promise<void>;
  /** Present when the successor connects to this daemon's server, so the socket can be handed over. */
  observeMachineConnectionOnline?: ObserveMachineConnectionOnline;
  takeover?: boolean;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  spawnDetachedDaemonStartSyncImpl?: SpawnDetachedDaemonStartSync;
  readDaemonStateImpl?: ReadDaemonState;
  confirmReplacementStateImpl?: ConfirmReplacementDaemonState;
  exitProcess?: (code: number) => never | void;
}>): Promise<RequestDaemonSelfRestartResult> {
  const {
    expectedCliVersion,
    timeoutMs,
    pollMs,
    postConfirmationOverlapMs = 0,
    takeover = true,
    env = process.env,
    spawnDetachedDaemonStartSyncImpl = spawnDetachedDaemonStartSync,
    readDaemonStateImpl = readDaemonState,
    confirmReplacementStateImpl = confirmReplacementDaemonState,
    exitProcess = (code: number) => process.exit(code),
  } = params;

  const runtimeId = typeof params.runtimeId === 'string' ? params.runtimeId.trim() : '';
  const restartEnv: Record<string, string | undefined> = {
    ...env,
    HAPPIER_DAEMON_STARTUP_SOURCE: 'self-restart',
    ...(runtimeId ? { HAPPIER_DAEMON_RUNTIME_ID: runtimeId } : {}),
    ...(takeover ? { HAPPIER_DAEMON_TAKEOVER: '1' } : {}),
  };

  let spawned: Partial<DetachedDaemonStartProcess>;
  try {
    spawned = await spawnDetachedDaemonStartSyncImpl({
      startupSource: 'self-restart',
      env: restartEnv,
    });
    spawned.unref?.();
  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to spawn replacement daemon for self-restart', error);
    return { status: 'spawn_failed', error };
  }

  // Assigned by the confirmation callback; the cast keeps the closure write visible to narrowing.
  let confirmedSuccessorPid = null as number | null;
  const replacementConfirmed = await waitForReplacementDaemon({
    ownPid: params.ownPid ?? process.pid,
    expectedCliVersion,
    expectedRuntimeId: runtimeId,
    timeoutMs,
    ...(params.deadlineAtMs === undefined ? {} : { deadlineAtMs: params.deadlineAtMs }),
    pollMs,
    startupProcess: spawned,
    readDaemonStateImpl,
    confirmReplacementStateImpl: async (state) => {
      const confirmed = await confirmReplacementStateImpl(state);
      if (confirmed) confirmedSuccessorPid = state.pid;
      return confirmed;
    },
  });
  if (!replacementConfirmed || confirmedSuccessorPid === null) {
    logger.debug('[DAEMON RUN] Replacement daemon was not confirmed. Keeping current daemon alive.');
    return { status: 'replacement_not_confirmed' };
  }

  logger.debug('[DAEMON RUN] Replacement daemon confirmed.');
  await params.onReplacementConfirmed?.();
  const handover: MachineConnectionHandover = params.observeMachineConnectionOnline
    ? await waitForMachineConnectionHandover({
      observeOnline: params.observeMachineConnectionOnline,
      successorPid: confirmedSuccessorPid,
      timeoutMs,
      pollMs,
      readDaemonStateImpl,
    })
    : 'not_connected';
  // Once the server moved the socket, exit before this daemon's reconnect could claim it back.
  if (handover !== 'handed_over') await delay(postConfirmationOverlapMs);
  logger.debug('[DAEMON RUN] Exiting current daemon process after self-restart handover.', { handover });
  exitProcess(0);
  return { status: 'exited' };
}
