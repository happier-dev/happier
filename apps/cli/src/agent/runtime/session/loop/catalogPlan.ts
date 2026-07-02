import { initialMachineMetadata } from '@/daemon/startDaemon';
import { logger } from '@/ui/logger';
import type {
  HostSessionRuntimeConfig,
  HostSessionRuntimeFactoryParams,
  HostSessionRuntimeRunOptions,
} from '@/agent/runtime/session/loop/runHostSessionRuntime';
import {
  HOST_SESSION_RUNTIME_PLAN_KIND,
  type HostSessionRuntimePlan,
} from '@/agent/runtime/session/loop/lifecycle';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';

type CatalogHostSessionRuntimePlanConfig<TRuntime extends RuntimeTurnOperations> = Omit<
  HostSessionRuntimeConfig,
  'createSessionRuntime'
> & Readonly<{
  createNativeRuntime: (params: HostSessionRuntimeFactoryParams) => TRuntime | Promise<TRuntime>;
}>;

export type CatalogHostSessionRuntimeDefaults<TRuntime extends RuntimeTurnOperations> = Omit<
  CatalogHostSessionRuntimePlanConfig<TRuntime>,
  | 'backendDisplayName'
  | 'uiLogPrefix'
  | 'providerName'
  | 'waitingForCommandLabel'
  | 'agentMessageType'
  | 'machineMetadata'
  | 'onAttachMetadataSnapshotMissing'
> & Readonly<{
  displayName: string;
  backendDisplayName?: string;
  uiLogPrefix?: string;
  providerName?: string;
  waitingForCommandLabel?: string;
  agentMessageType?: HostSessionRuntimeConfig['agentMessageType'];
  attachMetadataLogLabel?: string;
}>;

export function createCatalogHostSessionRuntimeConfig<TRuntime extends RuntimeTurnOperations>(params: Readonly<{
  providerId: string;
  config: CatalogHostSessionRuntimeDefaults<TRuntime>;
}>): CatalogHostSessionRuntimePlanConfig<TRuntime> {
  const {
    displayName,
    backendDisplayName = displayName,
    uiLogPrefix = `[${backendDisplayName}]`,
    providerName = displayName,
    waitingForCommandLabel = displayName,
    agentMessageType = params.providerId,
    checkpointToolProtocol = 'acp',
    attachMetadataLogLabel = params.providerId,
    ...config
  } = params.config;

  return {
    ...config,
    backendDisplayName,
    uiLogPrefix,
    providerName,
    waitingForCommandLabel,
    agentMessageType,
    checkpointToolProtocol,
    machineMetadata: initialMachineMetadata,
    onAttachMetadataSnapshotMissing: (error) => {
      logger.debug(
        `[${attachMetadataLogLabel}] Failed to fetch session metadata snapshot before attach startup update; continuing without metadata write (non-fatal)`,
        error ?? undefined,
      );
    },
  };
}

export function createCatalogHostSessionRuntimePlan<
  TOptions extends HostSessionRuntimeRunOptions,
  TRuntime extends RuntimeTurnOperations,
>(params: Readonly<{
  providerId: string;
  opts: TOptions;
  config: CatalogHostSessionRuntimePlanConfig<TRuntime>;
}>): HostSessionRuntimePlan {
  const { createNativeRuntime, ...config } = params.config;

  return {
    kind: HOST_SESSION_RUNTIME_PLAN_KIND,
    providerId: params.providerId,
    opts: params.opts,
    config: {
      ...config,
      createSessionRuntime: async (runtimeParams) => {
        const nativeRuntime = await createNativeRuntime(runtimeParams);
        return {
          operations: nativeRuntime,
          nativeRuntime,
        };
      },
    },
  };
}
