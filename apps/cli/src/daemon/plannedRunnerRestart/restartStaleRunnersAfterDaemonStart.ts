import type { Settings } from '@/persistence';
import type { TrackedSession } from '@/daemon/types';
import { resolveTrackedSessionActiveTurn } from '@/daemon/sessions/trackedSessionActiveTurn';

import type { SessionRunnerEntrypointIdentity } from '../sessionRunnerRuntime/types';
import { restartAllSessionRunnersOnCurrentRuntime } from './restartSessionRunnerOnCurrentRuntime';
import type { PlannedRunnerRestartMode, RestartAllSessionRunnersResult, RestartSessionRunnerRequest } from './types';

type RestartAllInput = Parameters<typeof restartAllSessionRunnersOnCurrentRuntime>[0];

export type RestartStaleSessionRunnersAfterDaemonStartOutcome =
  | Readonly<{ status: 'disabled' }>
  | Readonly<{ status: 'shutting_down' }>
  | Readonly<{
    status: 'completed';
    request: Readonly<{ mode: PlannedRunnerRestartMode; reason: RestartSessionRunnerRequest['reason'] }>;
    result: RestartAllSessionRunnersResult;
  }>
  | Readonly<{ status: 'failed' }>;

const REQUEST = {
  mode: 'if_stale',
  reason: 'restart_session_runners_on_update_config',
} as const satisfies Readonly<{ mode: PlannedRunnerRestartMode; reason: RestartSessionRunnerRequest['reason'] }>;

/**
 * Opt-in (`restartSessionRunnersOnUpdate`) startup pass that moves idle tracked runners still
 * pinned to an older CLI runtime onto the current one. `if_stale` makes same-version daemon
 * restarts a no-op. Never throws: failures are logged and the daemon keeps running.
 */
export async function restartStaleSessionRunnersAfterDaemonStart(input: Readonly<{
  readSettings: () => Promise<Pick<Settings, 'restartSessionRunnersOnUpdate'>>;
  isShuttingDown: () => boolean;
  resolveCurrentIdentity: () => SessionRunnerEntrypointIdentity;
  trackedSessions: () => ReadonlyArray<TrackedSession>;
  requestRestart: RestartAllInput['requestRestart'];
  resolveActivityDisabledReason?: RestartAllInput['resolveActivityDisabledReason'];
  refreshTrackedSessionRuntimeSnapshot?: RestartAllInput['refreshTrackedSessionRuntimeSnapshot'];
  readServerRuntimeActivity?: RestartAllInput['readServerRuntimeActivity'];
  logDebug: (message: string, payload?: unknown) => void;
  logWarn: (message: string, payload?: unknown) => void;
}>): Promise<RestartStaleSessionRunnersAfterDaemonStartOutcome> {
  try {
    const settings = await input.readSettings();
    if (settings.restartSessionRunnersOnUpdate !== true) return { status: 'disabled' };
    if (input.isShuttingDown()) return { status: 'shutting_down' };

    const trackedSessions = input.trackedSessions();
    // A fresh daemon has not observed turn lifecycle events for reattached runners yet, so the
    // in-memory activity gate reads them as idle. An unattended restart must also honor the
    // active turn persisted in the runner's session marker.
    const hasPersistedActiveTurn = (sessionId: string): boolean => trackedSessions.some(
      (tracked) => tracked.happySessionId === sessionId && resolveTrackedSessionActiveTurn(tracked) !== null,
    );
    const result = await restartAllSessionRunnersOnCurrentRuntime({
      ...REQUEST,
      currentIdentity: input.resolveCurrentIdentity(),
      trackedSessions,
      requestRestart: input.requestRestart,
      resolveActivityDisabledReason: (sessionId) =>
        input.resolveActivityDisabledReason?.(sessionId)
        ?? (hasPersistedActiveTurn(sessionId) ? 'turn_in_progress' : null),
      ...(input.refreshTrackedSessionRuntimeSnapshot
        ? { refreshTrackedSessionRuntimeSnapshot: input.refreshTrackedSessionRuntimeSnapshot }
        : {}),
      ...(input.readServerRuntimeActivity ? { readServerRuntimeActivity: input.readServerRuntimeActivity } : {}),
      shouldContinue: () => !input.isShuttingDown(),
    });

    const summary = {
      ...REQUEST,
      requestedCount: result.requestedCount,
      restartedCount: result.restartedCount,
      skippedCount: result.skippedCount,
      failedCount: result.failedCount,
      results: result.results.map((entry) => ({
        sessionId: entry.sessionId,
        status: entry.status,
        ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
      })),
    };
    if (result.failedCount > 0) {
      input.logWarn('[DAEMON RUN] Automatic session runner restart after daemon start had failures', summary);
    } else {
      input.logDebug('[DAEMON RUN] Automatic session runner restart after daemon start finished', summary);
    }
    return { status: 'completed', request: REQUEST, result };
  } catch (error) {
    input.logWarn('[DAEMON RUN] Automatic session runner restart after daemon start failed', {
      ...REQUEST,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'failed' };
  }
}
