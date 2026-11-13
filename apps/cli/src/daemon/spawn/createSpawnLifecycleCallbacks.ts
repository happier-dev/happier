import type { ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

import type {
  DaemonSpawnStartupReadinessFailure,
  TrackedSession,
} from '../types';
import {
  retireUpstreamAuthorityBeforeProcessStop,
  type SessionAttachCleanupByKey,
  type SpawnResourceCleanupByKey,
} from '../sessions/cleanupSessionResources';
import type { SessionTrackingKey } from '../sessions/sessionTrackingKey';
import { removeSessionMarkerIfOwned } from '../sessionRegistry';
import type { ConnectedServiceMaterializedStateObservationBinding } from '../connectedServices/materialization/materializer';
import type { AgentLaunchMaterialization } from '../agentIsolation/agentLaunchMaterials';

type SpawnResourceCleanup = () => void | Promise<void>;
type SessionAttachCleanup = () => Promise<void>;

export type SpawnLifecycleCallbacks = Readonly<{
  onTrackedSessionRegistered?: (trackedSession: TrackedSession) => void;
  persistAcceptedSpawnMarker: (
    trackedSession: TrackedSession,
    options?: Readonly<{
      processPid?: number;
      expectedProcessIdentity?: Readonly<{
        processStartTimeMs: number;
        processCommandHash: string;
      }>;
    }>,
  ) => Promise<void>;
  removeAcceptedSpawnMarkerIfOwned: (
    ownership: Readonly<{
      trackingKey: SessionTrackingKey;
      happySessionId: string;
      processStartTimeMs: number;
      processCommandHash: string;
      isStillOwned: () => boolean;
    }>,
  ) => Promise<boolean>;
  consumeSessionAttachCleanupForSession: (trackingKey: SessionTrackingKey) => void;
  cleanupPendingSessionAttach: () => Promise<void>;
  registerSpawnResourceCleanupForSession: (trackingKey: SessionTrackingKey) => void;
  cleanupSpawnResourcesForSession?: (trackingKey: SessionTrackingKey) => Promise<boolean>;
  /** Registers the accepted spawn's targets: `spawnTrackingKey` keeps them apart until the Session id is known. */
  registerConnectedServiceSpawnTarget: (pid: number, spawnTrackingKey: SessionTrackingKey) => void;
}>;

export function createSpawnLifecycleCallbacks<
  CatalogAgentId extends string,
  ConnectedServicesBindingsRaw,
>(params: Readonly<{
  agentLaunchMaterials?: AgentLaunchMaterialization;
  connectedServicesBindingsRaw: ConnectedServicesBindingsRaw;
  connectedServiceSelectionsEnv?: Readonly<Record<string, string>>;
  connectedServiceSelectionsEnvRaw?: string;
  catalogAgentId: CatalogAgentId | null;
  sessionId?: string;
  sessionDirectory?: string;
  materializationKey: string;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
  materializedStateObservationBinding?: ConnectedServiceMaterializedStateObservationBinding;
  hasConnectedServiceAuth: () => boolean;
  activateConnectedAccountSessionBindingOnCanonicalSession?: (
    sessionId: string,
  ) => Promise<DaemonSpawnStartupReadinessFailure | null>;
  registerConnectedServiceRefreshTarget?: (target: Readonly<{
    pid: number;
    agentId: CatalogAgentId | null;
    sessionId?: string;
    spawnTrackingKey?: string;
    connectedServicesBindingsRaw: ConnectedServicesBindingsRaw;
    materializationKey: string;
  }>) => void;
  registerConnectedServiceQuotaTarget?: (target: Readonly<{
    pid: number;
    sessionId?: string;
    spawnTrackingKey?: string;
    connectedServicesBindingsRaw: ConnectedServicesBindingsRaw;
    connectedServiceSelectionsEnvRaw?: string;
  }>) => void;
  registerConnectedServiceRuntimeTarget?: (target: Readonly<{
    agentLaunchMaterials?: AgentLaunchMaterialization;
    pid: number;
    agentId: CatalogAgentId | null;
    sessionId?: string;
    spawnTrackingKey?: string;
    sessionDirectory?: string;
    connectedServicesBindingsRaw: ConnectedServicesBindingsRaw;
    connectedServiceSelectionsEnv?: Readonly<Record<string, string>>;
    connectedServiceSelectionsEnvRaw?: string;
    materializationKey: string;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
  }>) => void;
  getSpawnResourceCleanupOnExit: () => SpawnResourceCleanup | null;
  onSpawnResourceCleanupArmed: () => void;
  onTrackedSessionRegistered?: (trackedSession: Readonly<Pick<TrackedSession, 'pid' | 'childProcess'>>) => void;
  projectSetupOperation?: TrackedSession['projectSetupOperation'];
  spawnResourceCleanupByKey: SpawnResourceCleanupByKey;
  getSessionAttachCleanup: () => SessionAttachCleanup | null;
  setSessionAttachCleanup: (cleanup: SessionAttachCleanup | null) => void;
  sessionAttachCleanupByKey: SessionAttachCleanupByKey;
  persistAcceptedSpawnMarker: (
    trackedSession: TrackedSession,
    options?: Readonly<{
      processPid?: number;
      expectedProcessIdentity?: Readonly<{
        processStartTimeMs: number;
        processCommandHash: string;
      }>;
    }>,
  ) => Promise<void>;
}>): SpawnLifecycleCallbacks {
  const registerConnectedServiceSpawnTargetNow = (
    pid: number,
    spawnTrackingKey: SessionTrackingKey,
    canonicalSessionId?: string,
  ): void => {
    if (!params.hasConnectedServiceAuth() || !params.connectedServicesBindingsRaw) {
      return;
    }
    const sessionId =
      canonicalSessionId?.trim()
      || params.sessionId?.trim()
      || '';
    params.registerConnectedServiceRefreshTarget?.({
      pid,
      agentId: params.catalogAgentId,
      ...(sessionId ? { sessionId } : {}),
      spawnTrackingKey,
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw,
      ...(typeof params.connectedServiceSelectionsEnvRaw === 'string'
        ? { connectedServiceSelectionsEnvRaw: params.connectedServiceSelectionsEnvRaw }
        : {}),
      materializationKey: params.materializationKey,
    });
    params.registerConnectedServiceQuotaTarget?.({
      pid,
      ...(sessionId ? { sessionId } : {}),
      spawnTrackingKey,
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw,
      ...(typeof params.connectedServiceSelectionsEnvRaw === 'string'
        ? { connectedServiceSelectionsEnvRaw: params.connectedServiceSelectionsEnvRaw }
        : {}),
    });
    params.registerConnectedServiceRuntimeTarget?.({
      ...(params.agentLaunchMaterials ? { agentLaunchMaterials: params.agentLaunchMaterials } : {}),
      pid,
      agentId: params.catalogAgentId,
      ...(sessionId ? { sessionId } : {}),
      spawnTrackingKey,
      ...(typeof params.sessionDirectory === 'string' && params.sessionDirectory.trim().length > 0
        ? { sessionDirectory: params.sessionDirectory.trim() }
        : {}),
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw,
      ...(params.connectedServiceSelectionsEnv
        ? { connectedServiceSelectionsEnv: params.connectedServiceSelectionsEnv }
        : {}),
      ...(typeof params.connectedServiceSelectionsEnvRaw === 'string'
        ? { connectedServiceSelectionsEnvRaw: params.connectedServiceSelectionsEnvRaw }
        : {}),
      materializationKey: params.materializationKey,
      ...(params.connectedServiceMaterializationIdentityV1
        ? { connectedServiceMaterializationIdentityV1: params.connectedServiceMaterializationIdentityV1 }
        : {}),
    });
  };

  const registerSpawnResourceCleanupForSessionNow = (trackingKey: SessionTrackingKey): void => {
    const cleanupOnExit = params.getSpawnResourceCleanupOnExit();
    if (!cleanupOnExit) {
      return;
    }
    params.spawnResourceCleanupByKey.set(trackingKey, cleanupOnExit);
    params.onSpawnResourceCleanupArmed();
  };
  const defersConnectedAccountSessionBinding =
    typeof params.activateConnectedAccountSessionBindingOnCanonicalSession === 'function';
  const registerConnectedServiceSpawnTarget = (pid: number, spawnTrackingKey: SessionTrackingKey): void => {
    if (defersConnectedAccountSessionBinding) return;
    registerConnectedServiceSpawnTargetNow(pid, spawnTrackingKey);
  };
  const registerSpawnResourceCleanupForSession = (trackingKey: SessionTrackingKey): void => {
    if (defersConnectedAccountSessionBinding) return;
    registerSpawnResourceCleanupForSessionNow(trackingKey);
  };
  const cleanupSpawnResourcesForSession = async (
    trackingKey: SessionTrackingKey,
  ): Promise<boolean> =>
    await retireUpstreamAuthorityBeforeProcessStop({
      trackingKey,
      spawnResourceCleanupByKey:
        params.spawnResourceCleanupByKey,
    });

  const consumeSessionAttachCleanupForSession = (trackingKey: SessionTrackingKey): void => {
    const cleanup = params.getSessionAttachCleanup();
    if (!cleanup) {
      return;
    }
    params.sessionAttachCleanupByKey.set(trackingKey, cleanup);
    params.setSessionAttachCleanup(null);
  };

  const cleanupPendingSessionAttach = async (): Promise<void> => {
    const cleanup = params.getSessionAttachCleanup();
    if (!cleanup) {
      return;
    }
    await cleanup();
    params.setSessionAttachCleanup(null);
  };

  return {
    onTrackedSessionRegistered: (trackedSession) => {
      if (params.projectSetupOperation) trackedSession.projectSetupOperation = params.projectSetupOperation;
      if (params.materializedStateObservationBinding) {
        trackedSession.materializedStateObservationBinding = params.materializedStateObservationBinding;
      }
      params.onTrackedSessionRegistered?.(trackedSession);
    },
    persistAcceptedSpawnMarker: async (trackedSession, options) => {
      if (params.activateConnectedAccountSessionBindingOnCanonicalSession) {
        let activationSessionId: string | null = null;
        let activationPromise:
          Promise<DaemonSpawnStartupReadinessFailure | null>
          | null = null;
        trackedSession.activateConnectedAccountSessionBindingOnCanonicalSession =
          async (canonicalSessionId) => {
            const normalizedSessionId = canonicalSessionId.trim();
            if (
              !normalizedSessionId
              || (
                activationSessionId !== null
                && activationSessionId !== normalizedSessionId
              )
            ) {
              return {
                type: 'error',
                errorCode:
                  SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                errorMessage:
                  'connected_account_canonical_session_identity_conflict',
              };
            }
            activationSessionId = normalizedSessionId;
            activationPromise ??= (async () => {
              const retiredStartupFailure = (): DaemonSpawnStartupReadinessFailure | null =>
                trackedSession.reportMarkerCustody?.retiring === true
                  ? trackedSession.spawnStartupReadinessFailure ?? {
                      type: 'error',
                      errorCode: SPAWN_SESSION_ERROR_CODES.CHILD_EXITED_BEFORE_WEBHOOK,
                      errorMessage: 'Runner exited before Connected Account startup custody was ready',
                    }
                  : null;
              const beforeActivation = retiredStartupFailure();
              if (beforeActivation) return beforeActivation;
              const failure =
                await params.activateConnectedAccountSessionBindingOnCanonicalSession!(
                  normalizedSessionId,
                );
              if (failure) return failure;
              // Exit owns retirement while activation is awaiting its canonical
              // Session scope. Never republish that target or rearm its cleanup.
              const afterActivation = retiredStartupFailure();
              if (afterActivation) return afterActivation;
              if (trackedSession.spawnStartupReadinessFailure) {
                return trackedSession.spawnStartupReadinessFailure;
              }
              registerConnectedServiceSpawnTargetNow(
                trackedSession.pid,
                trackedSession.trackingKey,
                normalizedSessionId,
              );
              registerSpawnResourceCleanupForSessionNow(trackedSession.trackingKey);
              return null;
            })();
            return await activationPromise;
          };
      }
      await params.persistAcceptedSpawnMarker(
        trackedSession,
        options,
      );
    },
    removeAcceptedSpawnMarkerIfOwned:
      removeSessionMarkerIfOwned,
    consumeSessionAttachCleanupForSession,
    cleanupPendingSessionAttach,
    registerSpawnResourceCleanupForSession,
    cleanupSpawnResourcesForSession,
    registerConnectedServiceSpawnTarget,
  };
}
