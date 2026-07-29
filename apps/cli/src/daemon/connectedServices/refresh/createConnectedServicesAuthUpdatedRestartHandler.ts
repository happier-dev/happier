import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceId } from '@happier-dev/protocol';
import type { StopSessionResult } from '@/daemon/sessions/stopSessionContract';
import type { ConnectedServiceProjectedCredentialPresence } from '../accountGroups/generation/connectedServiceProjectionSnapshot';
import type {
  ConnectedServiceDaemonRestartDiagnosticInput,
  ConnectedServiceDaemonRestartDiagnosticRecorder,
  ConnectedServiceDaemonRestartTrigger,
} from '../sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';

export type ConnectedServiceBindingRef = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;

export type ConnectedServiceSpawnTargetRef = Readonly<{
  pid: number;
  agentId: CatalogAgentId;
  sessionId?: string | null;
  materializationKey?: string | null;
}>;

export async function settleConnectedServiceCredentialDeletion(params: Readonly<{
  binding: ConnectedServiceBindingRef;
  affectedTargets: ReadonlyArray<ConnectedServiceSpawnTargetRef>;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  isCredentialTargetPresent: (input: Readonly<{
    target: ConnectedServiceSpawnTargetRef;
    binding: ConnectedServiceBindingRef;
  }>) => boolean;
}>): Promise<void> {
  const targetsBySessionId = new Map<string, ConnectedServiceSpawnTargetRef[]>();
  for (const target of params.affectedTargets) {
    const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
    if (!sessionId) {
      throw new Error('connected_service_credential_deletion_target_session_unavailable');
    }
    const targets = targetsBySessionId.get(sessionId) ?? [];
    targets.push(target);
    targetsBySessionId.set(sessionId, targets);
  }
  for (const [sessionId, targets] of targetsBySessionId) {
    const result = await params.stopSession(sessionId);
    const exactTargetsAbsent = targets.every((target) => !params.isCredentialTargetPresent({
      target,
      binding: params.binding,
    }));
    if (
      (result.status !== 'stopped' && result.status !== 'not_found')
      || !exactTargetsAbsent
    ) {
      throw new Error(`connected_service_credential_deletion_not_settled:${result.status}`);
    }
  }
}

export function createConnectedServicesAuthUpdatedRestartHandler(params: Readonly<{
  restartRequestedPids: Set<number>;
  pidToTrackedSession: Map<number, TrackedSession>;
  restartAgentIds: ReadonlySet<CatalogAgentId>;
  shouldRestartForCredentialUpdate?: (input: Readonly<{
    agentId: CatalogAgentId;
    serviceId: ConnectedServiceId;
  }>) => boolean;
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
  stopSession?: (sessionId: string) => Promise<StopSessionResult>;
  isCredentialTargetPresent?: (input: Readonly<{
    target: ConnectedServiceSpawnTargetRef;
    binding: ConnectedServiceBindingRef;
  }>) => boolean;
}>): (event: Readonly<{
  binding: ConnectedServiceBindingRef;
  affectedTargets: ReadonlyArray<ConnectedServiceSpawnTargetRef>;
  trigger?: Extract<ConnectedServiceDaemonRestartTrigger, 'refresh_triggered_restart' | 'reconnect_propagation'>;
  credentialPresence?: ConnectedServiceProjectedCredentialPresence;
}>) => void | Promise<void> {
  return async (event) => {
    if (event.credentialPresence?.status === 'absent') {
      if (!params.stopSession || !params.isCredentialTargetPresent) {
        throw new Error('connected_service_credential_deletion_lifecycle_owner_unavailable');
      }
      await settleConnectedServiceCredentialDeletion({
        binding: event.binding,
        affectedTargets: event.affectedTargets,
        stopSession: params.stopSession,
        isCredentialTargetPresent: params.isCredentialTargetPresent,
      });
      return;
    }
    const trigger = event.trigger ?? 'refresh_triggered_restart';
    for (const target of event.affectedTargets) {
      if (
        params.shouldRestartForCredentialUpdate
          ? !params.shouldRestartForCredentialUpdate({
              agentId: target.agentId,
              serviceId: event.binding.serviceId,
            })
          : !params.restartAgentIds.has(target.agentId)
      ) continue;
      if (params.noRestartRequiredServiceIdsByAgentId?.get(target.agentId)?.has(event.binding.serviceId)) continue;
      if (params.restartRequestedPids.has(target.pid)) continue;

      const tracked = params.pidToTrackedSession.get(target.pid);
      if (!tracked) continue;
      if (tracked.startedBy !== 'daemon') continue;
      // A surviving reattached runner retains runtime authority after daemon replacement. The
      // shared gated signal path can address its live pid even though this daemon has no ChildProcess
      // handle. Only the legacy direct-kill fallback still requires that handle.
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

      const childProcess = tracked.childProcess;
      if (!childProcess) continue;
      try {
        childProcess.kill('SIGTERM');
      } catch {
        continue;
      }
      params.restartRequestedPids.add(target.pid);
    }
  };
}
