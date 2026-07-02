type SpawnResourceCleanup = () => void;
type SessionAttachCleanup = () => Promise<void>;

export type SpawnLifecycleCallbacks = Readonly<{
  consumeSessionAttachCleanupForPid: (pid: number) => void;
  cleanupPendingSessionAttach: () => Promise<void>;
  registerSpawnResourceCleanupForPid: (pid: number) => void;
  registerConnectedServiceSpawnTarget: (pid: number) => void;
}>;

export function createSpawnLifecycleCallbacks<
  CatalogAgentId extends string,
  ConnectedServicesBindingsRaw,
>(params: Readonly<{
  connectedServicesBindingsRaw: ConnectedServicesBindingsRaw;
  connectedServiceSelectionsEnvRaw?: string;
  catalogAgentId: CatalogAgentId;
  sessionId?: string;
  materializationKey: string;
  hasConnectedServiceAuth: () => boolean;
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
  getSpawnResourceCleanupOnExit: () => SpawnResourceCleanup | null;
  onSpawnResourceCleanupArmed: () => void;
  spawnResourceCleanupByPid: Map<number, SpawnResourceCleanup>;
  getSessionAttachCleanup: () => SessionAttachCleanup | null;
  setSessionAttachCleanup: (cleanup: SessionAttachCleanup | null) => void;
  sessionAttachCleanupByPid: Map<number, SessionAttachCleanup>;
}>): SpawnLifecycleCallbacks {
  const registerConnectedServiceSpawnTarget = (pid: number): void => {
    if (!params.hasConnectedServiceAuth() || !params.connectedServicesBindingsRaw) {
      return;
    }
    params.registerConnectedServiceRefreshTarget?.({
      pid,
      agentId: params.catalogAgentId,
      ...(typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
        ? { sessionId: params.sessionId.trim() }
        : {}),
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw,
      ...(typeof params.connectedServiceSelectionsEnvRaw === 'string'
        ? { connectedServiceSelectionsEnvRaw: params.connectedServiceSelectionsEnvRaw }
        : {}),
      materializationKey: params.materializationKey,
    });
    params.registerConnectedServiceQuotaTarget?.({
      pid,
      ...(typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
        ? { sessionId: params.sessionId.trim() }
        : {}),
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw,
      ...(typeof params.connectedServiceSelectionsEnvRaw === 'string'
        ? { connectedServiceSelectionsEnvRaw: params.connectedServiceSelectionsEnvRaw }
        : {}),
    });
  };

  const registerSpawnResourceCleanupForPid = (pid: number): void => {
    const cleanupOnExit = params.getSpawnResourceCleanupOnExit();
    if (!cleanupOnExit) {
      return;
    }
    params.spawnResourceCleanupByPid.set(pid, cleanupOnExit);
    params.onSpawnResourceCleanupArmed();
  };

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
    consumeSessionAttachCleanupForPid,
    cleanupPendingSessionAttach,
    registerSpawnResourceCleanupForPid,
    registerConnectedServiceSpawnTarget,
  };
}
