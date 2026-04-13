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
  catalogAgentId: CatalogAgentId;
  materializationKey: string;
  hasConnectedServiceAuth: () => boolean;
  registerConnectedServiceRefreshTarget?: (target: Readonly<{
    pid: number;
    agentId: CatalogAgentId;
    connectedServicesBindingsRaw: ConnectedServicesBindingsRaw;
    materializationKey: string;
  }>) => void;
  registerConnectedServiceQuotaTarget?: (target: Readonly<{
    pid: number;
    connectedServicesBindingsRaw: ConnectedServicesBindingsRaw;
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
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw,
      materializationKey: params.materializationKey,
    });
    params.registerConnectedServiceQuotaTarget?.({
      pid,
      connectedServicesBindingsRaw: params.connectedServicesBindingsRaw,
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
