import type { ConnectedServiceMaterializationIdentityV1 } from '@happier-dev/protocol';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

import type {
  DaemonSpawnStartupReadinessFailure,
  TrackedSession,
} from '../types';
import {
  retireUpstreamAuthorityBeforeProcessStop,
} from '../sessions/cleanupPidSessionResources';
import { removeSessionMarkerIfOwned } from '../sessionRegistry';

type SpawnResourceCleanup = () => void | Promise<void>;
type SessionAttachCleanup = () => Promise<void>;

export type SpawnLifecycleCallbacks = Readonly<{
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
      pid: number;
      happySessionId: string;
      processStartTimeMs: number;
      processCommandHash: string;
      isStillOwned: () => boolean;
    }>,
  ) => Promise<boolean>;
  consumeSessionAttachCleanupForPid: (pid: number) => void;
  cleanupPendingSessionAttach: () => Promise<void>;
  registerSpawnResourceCleanupForPid: (pid: number) => void;
  cleanupSpawnResourcesForPid?: (pid: number) => Promise<boolean>;
  registerConnectedServiceSpawnTarget: (pid: number) => void;
}>;

export function createSpawnLifecycleCallbacks<
  CatalogAgentId extends string,
  ConnectedServicesBindingsRaw,
>(params: Readonly<{
  connectedServicesBindingsRaw: ConnectedServicesBindingsRaw;
  connectedServiceSelectionsEnv?: Readonly<Record<string, string>>;
  connectedServiceSelectionsEnvRaw?: string;
  catalogAgentId: CatalogAgentId;
  sessionId?: string;
  sessionDirectory?: string;
  materializationKey: string;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
  hasConnectedServiceAuth: () => boolean;
  activateConnectedAccountSessionBindingOnCanonicalSession?: (
    sessionId: string,
  ) => Promise<DaemonSpawnStartupReadinessFailure | null>;
  registerConnectedServiceRefreshTarget?: (target: Readonly<{
    pid: number;
    agentId: CatalogAgentId;
    sessionId?: string;
    connectedServicesBindingsRaw: ConnectedServicesBindingsRaw;
    materializationKey: string;
  }>) => void;
  registerConnectedServiceQuotaTarget?: (target: Readonly<{
    pid: number;
    sessionId?: string;
    connectedServicesBindingsRaw: ConnectedServicesBindingsRaw;
    connectedServiceSelectionsEnvRaw?: string;
  }>) => void;
  registerConnectedServiceRuntimeTarget?: (target: Readonly<{
    pid: number;
    agentId: CatalogAgentId;
    sessionId?: string;
    sessionDirectory?: string;
    connectedServicesBindingsRaw: ConnectedServicesBindingsRaw;
    connectedServiceSelectionsEnv?: Readonly<Record<string, string>>;
    connectedServiceSelectionsEnvRaw?: string;
    materializationKey: string;
    connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
  }>) => void;
  getSpawnResourceCleanupOnExit: () => SpawnResourceCleanup | null;
  onSpawnResourceCleanupArmed: () => void;
  spawnResourceCleanupByPid: Map<number, SpawnResourceCleanup>;
  getSessionAttachCleanup: () => SessionAttachCleanup | null;
  setSessionAttachCleanup: (cleanup: SessionAttachCleanup | null) => void;
  sessionAttachCleanupByPid: Map<number, SessionAttachCleanup>;
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
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw,
      ...(typeof params.connectedServiceSelectionsEnvRaw === 'string'
        ? { connectedServiceSelectionsEnvRaw: params.connectedServiceSelectionsEnvRaw }
        : {}),
      materializationKey: params.materializationKey,
    });
    params.registerConnectedServiceQuotaTarget?.({
      pid,
      ...(sessionId ? { sessionId } : {}),
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw,
      ...(typeof params.connectedServiceSelectionsEnvRaw === 'string'
        ? { connectedServiceSelectionsEnvRaw: params.connectedServiceSelectionsEnvRaw }
        : {}),
    });
    params.registerConnectedServiceRuntimeTarget?.({
      pid,
      agentId: params.catalogAgentId,
      ...(sessionId ? { sessionId } : {}),
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

  const registerSpawnResourceCleanupForPidNow = (pid: number): void => {
    const cleanupOnExit = params.getSpawnResourceCleanupOnExit();
    if (!cleanupOnExit) {
      return;
    }
    params.spawnResourceCleanupByPid.set(pid, cleanupOnExit);
    params.onSpawnResourceCleanupArmed();
  };
  const defersConnectedAccountSessionBinding =
    typeof params.activateConnectedAccountSessionBindingOnCanonicalSession === 'function';
  const registerConnectedServiceSpawnTarget = (pid: number): void => {
    if (defersConnectedAccountSessionBinding) return;
    registerConnectedServiceSpawnTargetNow(pid);
  };
  const registerSpawnResourceCleanupForPid = (pid: number): void => {
    if (defersConnectedAccountSessionBinding) return;
    registerSpawnResourceCleanupForPidNow(pid);
  };
  const cleanupSpawnResourcesForPid = async (
    pid: number,
  ): Promise<boolean> =>
    await retireUpstreamAuthorityBeforeProcessStop({
      pid,
      spawnResourceCleanupByPid:
        params.spawnResourceCleanupByPid,
    });

  const consumeSessionAttachCleanupForPid = (pid: number): void => {
    const cleanup = params.getSessionAttachCleanup();
    if (!cleanup) {
      return;
    }
    params.sessionAttachCleanupByPid.set(pid, cleanup);
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
              const failure =
                await params.activateConnectedAccountSessionBindingOnCanonicalSession!(
                  normalizedSessionId,
                );
              if (failure) return failure;
              if (trackedSession.spawnStartupReadinessFailure) {
                return trackedSession.spawnStartupReadinessFailure;
              }
              registerConnectedServiceSpawnTargetNow(
                trackedSession.pid,
                normalizedSessionId,
              );
              registerSpawnResourceCleanupForPidNow(trackedSession.pid);
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
    consumeSessionAttachCleanupForPid,
    cleanupPendingSessionAttach,
    registerSpawnResourceCleanupForPid,
    cleanupSpawnResourcesForPid,
    registerConnectedServiceSpawnTarget,
  };
}
