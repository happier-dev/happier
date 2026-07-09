import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { TrackedSession } from '@/daemon/types';
import type {
  ConnectedServiceDaemonRestartDiagnosticInput,
  ConnectedServiceDaemonRestartDiagnosticRecorder,
  ConnectedServiceDaemonRestartTrigger,
} from '../sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';

type ConnectedServiceBindingRef = Readonly<{ serviceId: string; profileId: string }>;

type ConnectedServiceSpawnTargetRef = Readonly<{
  pid: number;
  agentId: CatalogAgentId;
}>;

export function createConnectedServicesAuthUpdatedRestartHandler(params: Readonly<{
  restartRequestedPids: Set<number>;
  pidToTrackedSession: Map<number, TrackedSession>;
  restartAgentIds: ReadonlySet<CatalogAgentId>;
  noRestartRequiredServiceIdsByAgentId?: ReadonlyMap<CatalogAgentId, ReadonlySet<string>>;
  requestRestartSignal?: (params: Readonly<{
    pid: number;
    delayMs: number;
    preferProcessGroup?: boolean;
    shouldSignal?: () => boolean;
    onSignalFailure: (error: unknown) => void;
    restartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticInput;
    recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
    nowMs?: () => number;
    /**
     * Reports whether a restart signal was ACTUALLY emitted. The gated restart dependency can
     * resolve successfully WITHOUT signalling (e.g. the deferred restart was superseded by a newer
     * switch — `switch_cancelled`). The handler reserves the pid in `restartRequestedPids` only when
     * `signaled` is true, so an un-signalled restart never leaks a reservation that would suppress
     * later refresh restarts for the same process.
     */
  }>) => Promise<Readonly<{ signaled: boolean }>>;
  restartSignalDelayMs?: number;
  recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
  nowMs?: () => number;
}>): (event: Readonly<{
  binding: ConnectedServiceBindingRef;
  affectedTargets: ReadonlyArray<ConnectedServiceSpawnTargetRef>;
  trigger?: Extract<ConnectedServiceDaemonRestartTrigger, 'refresh_triggered_restart' | 'reconnect_propagation'>;
}>) => void | Promise<void> {
  return async (event) => {
    const trigger = event.trigger ?? 'refresh_triggered_restart';
    for (const target of event.affectedTargets) {
      if (!params.restartAgentIds.has(target.agentId)) continue;
      if (params.noRestartRequiredServiceIdsByAgentId?.get(target.agentId)?.has(event.binding.serviceId)) continue;
      if (params.restartRequestedPids.has(target.pid)) continue;

      const tracked = params.pidToTrackedSession.get(target.pid);
      if (!tracked) continue;
      if (tracked.startedBy !== 'daemon') continue;
      if (tracked.reattachedFromDiskMarker) continue;
      if (!tracked.childProcess) continue;

      if (params.requestRestartSignal) {
        try {
          // K5:gated_restart(K3) the wired requestRestartSignal is the gated
          // requestConnectedServiceRestartWithDeferral adapter (turn-deferral + spawn-time
          // reachability) injected by startDaemonRuntimeBootstrap; no raw mid-turn SIGTERM.
          const { signaled } = await params.requestRestartSignal({
            pid: target.pid,
            delayMs: params.restartSignalDelayMs ?? 0,
            preferProcessGroup: tracked.startedBy === 'daemon',
            shouldSignal: () => params.pidToTrackedSession.get(target.pid) === tracked,
            restartDiagnostic: {
              trigger,
              sessionId: tracked.happySessionId ?? null,
              agentId: target.agentId,
              serviceId: event.binding.serviceId,
              profileId: event.binding.profileId,
              reason: trigger,
            },
            recordRestartDiagnostic: params.recordRestartDiagnostic,
            nowMs: params.nowMs,
            onSignalFailure: () => {
              params.restartRequestedPids.delete(target.pid);
            },
          });
          // Reserve the pid ONLY when a signal was actually emitted. A gated restart that resolves
          // without signalling (e.g. superseded by a newer switch / switch_cancelled) must not leave
          // a reservation behind, or later refresh restarts for this pid would be suppressed until exit.
          if (signaled) {
            params.restartRequestedPids.add(target.pid);
          }
        } catch {
          params.restartRequestedPids.delete(target.pid);
        }
        continue;
      }

      try {
        tracked.childProcess.kill('SIGTERM');
      } catch {
        continue;
      }
      params.restartRequestedPids.add(target.pid);
    }
  };
}
