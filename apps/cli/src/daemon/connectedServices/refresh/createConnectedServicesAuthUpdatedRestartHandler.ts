import type { CatalogAgentId } from '@/backends/types';
import type { TrackedSession } from '@/daemon/types';
import type { ConnectedServiceCredentialLifecycleDescriptor } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import { readConnectedServiceChildSelectionsFromEnv } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import type { ConnectedServiceId, StopSessionResult } from '@happier-dev/protocol';
import type {
  ConnectedServiceDaemonRestartDiagnosticInput,
  ConnectedServiceDaemonRestartDiagnosticRecorder,
  ConnectedServiceDaemonRestartTrigger,
} from '../sessionAuthSwitch/requestConnectedServiceSessionRestartSignal';

type ConnectedServiceBindingRef = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId?: string;
  generation?: number;
}>;

type ConnectedServiceSpawnTargetRef = Readonly<{
  pid: number;
  agentId: CatalogAgentId;
  accessTokenRefresh?: Readonly<{
    mode: 'daemon_callback';
    serviceIds: ReadonlyArray<ConnectedServiceId>;
  }> | null;
}>;

export type ConnectedServicesAuthUpdatedRestartBlockedDiagnostic = Readonly<{
  serviceId: string;
  profileId: string;
  agentId: CatalogAgentId;
  pid: number;
  reason:
    | 'tracked_session_missing'
    | 'not_daemon_started'
    | 'unsupported_restart_signal';
  startedBy: string | null;
  hasChildProcess: boolean;
  hasProcessGroupPid: boolean;
  reattachedFromDiskMarker: boolean;
}>;

export class ConnectedServiceCredentialDeletionNotSettledError extends Error {
  constructor(
    readonly target: ConnectedServiceSpawnTargetRef,
    readonly binding: ConnectedServiceBindingRef,
    readonly stopResult: StopSessionResult | null,
  ) {
    super('connected_service_credential_deletion_not_settled');
    this.name = 'ConnectedServiceCredentialDeletionNotSettledError';
  }
}

function normalizeGroupGeneration(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

function resolveConnectedServiceBindingGroupMetadata(input: Readonly<{
  tracked: TrackedSession;
  binding: ConnectedServiceBindingRef;
}>): Readonly<{ groupId: string | null; generation: number | null }> {
  const explicitGroupId = typeof input.binding.groupId === 'string' && input.binding.groupId.trim()
    ? input.binding.groupId.trim()
    : '';
  const explicitGeneration = normalizeGroupGeneration(input.binding.generation);
  if (explicitGroupId || explicitGeneration !== null) {
    return {
      groupId: explicitGroupId || null,
      generation: explicitGeneration,
    };
  }

  const selections = readConnectedServiceChildSelectionsFromEnv(
    input.tracked.spawnOptions?.environmentVariables ?? {},
  );
  const groupSelection = selections.find((selection) =>
    selection.kind === 'group'
    && selection.serviceId === input.binding.serviceId
    && selection.activeProfileId === input.binding.profileId
  );
  if (!groupSelection || groupSelection.kind !== 'group') {
    return { groupId: null, generation: null };
  }

  return {
    groupId: groupSelection.groupId,
    generation: normalizeGroupGeneration(groupSelection.generation),
  };
}

export function createConnectedServicesAuthUpdatedRestartHandler(params: Readonly<{
  restartRequestedPids: Set<number>;
  pidToTrackedSession: Map<number, TrackedSession>;
  resolveLifecycleDescriptor: (agentId: CatalogAgentId) => Promise<ConnectedServiceCredentialLifecycleDescriptor>;
  /**
   * K3: the handler hands the resolved tracked session, its session id, and the
   * gated-restart target descriptor to this dependency in addition to the raw
   * pid/signal fields. The daemon wires this to the gated restart primitive
   * (requestConnectedServiceRestartWithDeferral) so a credential-refresh /
   * reconnect restart inherits turn-deferral + the spawn-time reachability gate
   * instead of sending a raw mid-turn SIGTERM. A raw-signal adapter may still be
   * supplied in tests; the extra context is additive.
   */
  requestRestartSignal: (params: Readonly<{
    pid: number;
    tracked: TrackedSession;
    sessionId: string | null;
    target: Readonly<{
      serviceId: string;
      profileId: string;
      groupId: string;
      generation: number | null;
    }>;
    processGroupPid?: number | null;
    delayMs: number;
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
  stopSessionForCredentialDeletion?: (input: Readonly<{
    tracked: TrackedSession;
    target: ConnectedServiceSpawnTargetRef;
    binding: ConnectedServiceBindingRef;
  }>) => StopSessionResult | Promise<StopSessionResult>;
  restartEnabled?: boolean;
  resolveProcessGroupPid: (tracked: TrackedSession) => number | null;
  restartSignalDelayMs: number;
  recordRestartDiagnostic?: ConnectedServiceDaemonRestartDiagnosticRecorder;
  nowMs?: () => number;
  onRestartSignalFailure?: (error: unknown, target: ConnectedServiceSpawnTargetRef) => void;
  onRestartBlocked?: (diagnostic: ConnectedServicesAuthUpdatedRestartBlockedDiagnostic) => void;
}>): (event: Readonly<{
  binding: ConnectedServiceBindingRef;
  affectedTargets: ReadonlyArray<ConnectedServiceSpawnTargetRef>;
  mutation?: 'replaced' | 'deleted';
  trigger?: Extract<ConnectedServiceDaemonRestartTrigger, 'refresh_triggered_restart' | 'reconnect_propagation'>;
}>) => Promise<void> {
  return async (event) => {
    const trigger = event.trigger ?? 'refresh_triggered_restart';
    const emitBlocked = (
      target: ConnectedServiceSpawnTargetRef,
      tracked: TrackedSession | null,
      processGroupPid: number | null,
      reason: ConnectedServicesAuthUpdatedRestartBlockedDiagnostic['reason'],
    ) => {
      params.onRestartBlocked?.({
        serviceId: event.binding.serviceId,
        profileId: event.binding.profileId,
        agentId: target.agentId,
        pid: target.pid,
        reason,
        startedBy: tracked?.startedBy ?? null,
        hasChildProcess: Boolean(tracked?.childProcess),
        hasProcessGroupPid: processGroupPid !== null,
        reattachedFromDiskMarker: Boolean(tracked?.reattachedFromDiskMarker),
      });
    };

    for (const target of event.affectedTargets) {
      const tracked = params.pidToTrackedSession.get(target.pid);
      if (event.mutation === 'deleted') {
        if (!tracked) {
          emitBlocked(target, null, null, 'tracked_session_missing');
          throw new ConnectedServiceCredentialDeletionNotSettledError(target, event.binding, null);
        }
        if (!params.stopSessionForCredentialDeletion) {
          throw new Error('Credential deletion lifecycle owner is not configured');
        }
        const stopResult = await params.stopSessionForCredentialDeletion({
          tracked,
          target,
          binding: event.binding,
        });
        if (stopResult.status === 'stopped') continue;
        if (
          stopResult.status === 'not_found'
          && params.pidToTrackedSession.get(target.pid) !== tracked
        ) continue;
        throw new ConnectedServiceCredentialDeletionNotSettledError(
          target,
          event.binding,
          stopResult,
        );
      }
      if (params.restartEnabled === false) continue;
      const descriptor = await params.resolveLifecycleDescriptor(target.agentId);
      if (!(descriptor.serviceIds as readonly string[]).includes(event.binding.serviceId)) continue;
      const refreshedCredentialApplication = descriptor.refreshedCredentialApplication;
      if (refreshedCredentialApplication.mode !== 'restart_required') continue;
      if ((refreshedCredentialApplication.noRestartRequiredServiceIds ?? []).some((serviceId) => serviceId === event.binding.serviceId)) continue;
      const callbackConditionalService = (
        refreshedCredentialApplication.noRestartRequiredWhenAccessTokenCallbackServiceIds ?? []
      ).some((serviceId) => serviceId === event.binding.serviceId);
      const accessTokenCallbackActive = target.accessTokenRefresh?.mode === 'daemon_callback'
        && target.accessTokenRefresh.serviceIds.includes(event.binding.serviceId);
      if (
        accessTokenCallbackActive
        && callbackConditionalService
      ) {
        continue;
      }
      // Broker-conditional no-restart: skip the restart ONLY when this running target actually holds a
      // broker binding for the service. A non-brokered shape (e.g. a Pi claude-subscription setup-token
      // baked as a raw api_key at spawn) has no broker to hot-apply the reconnected credential, so it
      // falls through to a restart instead of being silently skipped by service id alone.
      const brokerConditionalServiceId = (refreshedCredentialApplication.noRestartRequiredWhenBrokeredServiceIds ?? [])
        .find((serviceId) => serviceId === event.binding.serviceId);
      if (brokerConditionalServiceId) {
        const brokered = refreshedCredentialApplication.isTargetBrokeredForBinding?.({
          serviceId: brokerConditionalServiceId,
          environmentVariables: params.pidToTrackedSession.get(target.pid)?.spawnOptions?.environmentVariables ?? {},
        }) ?? false;
        if (brokered) continue;
      }
      if (params.restartRequestedPids.has(target.pid)) continue;

      if (!tracked) {
        emitBlocked(target, null, null, 'tracked_session_missing');
        continue;
      }
      if (tracked.startedBy !== 'daemon') {
        emitBlocked(target, tracked, null, 'not_daemon_started');
        continue;
      }
      const processGroupPid = params.resolveProcessGroupPid(tracked);
      if (!tracked.childProcess && processGroupPid === null) {
        emitBlocked(target, tracked, processGroupPid, 'unsupported_restart_signal');
        continue;
      }

      const bindingGroupMetadata = resolveConnectedServiceBindingGroupMetadata({
        tracked,
        binding: event.binding,
      });
      // The gated restart owner may intentionally remain pending until a safe turn boundary.
      // Scheduling that existing owner is sufficient; refresh/reconnect distribution must not
      // retain credential-rotation custody while waiting for future conversational activity.
      // Reserve while the canonical request itself is pending so a later refresh cannot schedule a
      // duplicate restart. A resolved no-signal/cancelled request releases the reservation below.
      params.restartRequestedPids.add(target.pid);
      let restartRequest: Promise<Readonly<{ signaled: boolean }>>;
      try {
        // K5:gated_restart credential refresh inherits canonical deferral and reachability checks.
        restartRequest = params.requestRestartSignal({
          pid: target.pid,
          tracked,
          sessionId: tracked.happySessionId ?? null,
          target: {
            serviceId: event.binding.serviceId,
            profileId: event.binding.profileId,
            groupId: bindingGroupMetadata.groupId ?? '',
            generation: bindingGroupMetadata.generation,
          },
          processGroupPid,
          delayMs: params.restartSignalDelayMs,
          shouldSignal: () => params.pidToTrackedSession.get(target.pid) === tracked,
          restartDiagnostic: {
            trigger,
            sessionId: tracked.happySessionId ?? null,
            agentId: target.agentId,
            serviceId: event.binding.serviceId,
            profileId: event.binding.profileId,
            groupId: bindingGroupMetadata.groupId,
            generation: bindingGroupMetadata.generation,
            reason: trigger,
          },
          recordRestartDiagnostic: params.recordRestartDiagnostic,
          nowMs: params.nowMs,
          onSignalFailure: (error) => {
            params.restartRequestedPids.delete(target.pid);
            params.onRestartSignalFailure?.(error, target);
          },
        });
      } catch (error) {
        params.restartRequestedPids.delete(target.pid);
        params.onRestartSignalFailure?.(error, target);
        continue;
      }
      void restartRequest.then(({ signaled }) => {
        // A gated restart that resolves without signalling (e.g. superseded by a newer switch /
        // switch_cancelled) must not leave a reservation behind.
        if (!signaled) params.restartRequestedPids.delete(target.pid);
      }).catch((error) => {
        params.restartRequestedPids.delete(target.pid);
        params.onRestartSignalFailure?.(error, target);
      });
    }
  };
}
