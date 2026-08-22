import { initialMachineMetadata } from '@/daemon/machine/metadata';
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
import type { HostSessionRuntimeFactoryResult } from '@/agent/runtime/session/loop/factoryResult';
import {
  resolveRuntimeActivityApplicability,
  type RuntimeActivityApplicability,
} from '@/agent/runtime/session/activity/runtimeActivityApplicability';

type CatalogHostSessionRuntimePlanConfig<TRuntime extends RuntimeTurnOperations> = Omit<
  HostSessionRuntimeConfig,
  'createSessionRuntime'
> & Readonly<{
  createNativeRuntime: (
    params: HostSessionRuntimeFactoryParams,
  ) => TRuntime
    | HostSessionRuntimeFactoryResult<TRuntime>
    | Promise<TRuntime | HostSessionRuntimeFactoryResult<TRuntime>>;
}>;

function isHostSessionRuntimeFactoryResult<TRuntime extends RuntimeTurnOperations>(
  value: TRuntime | HostSessionRuntimeFactoryResult<TRuntime>,
): value is HostSessionRuntimeFactoryResult<TRuntime> {
  return typeof value === 'object' && value !== null && 'operations' in value;
}

export type CatalogHostSessionRuntimeDefaults<TRuntime extends RuntimeTurnOperations> = Omit<
  CatalogHostSessionRuntimePlanConfig<TRuntime>,
  | 'backendDisplayName'
  | 'uiLogPrefix'
  | 'providerName'
  | 'waitingForCommandLabel'
  | 'agentMessageType'
  | 'machineMetadata'
  | 'onAttachMetadataSnapshotMissing'
  | 'runtimeActivityApplicability'
> & Readonly<{
  displayName: string;
  backendDisplayName?: string;
  uiLogPrefix?: string;
  providerName?: string;
  waitingForCommandLabel?: string;
  agentMessageType?: HostSessionRuntimeConfig['agentMessageType'];
  attachMetadataLogLabel?: string;
  runtimeActivityApplicability?: RuntimeActivityApplicability;
}>;

export function createCatalogHostSessionRuntimeConfig<TRuntime extends RuntimeTurnOperations>(params: Readonly<{
  agentId: string;
  config: CatalogHostSessionRuntimeDefaults<TRuntime>;
}>): CatalogHostSessionRuntimePlanConfig<TRuntime> {
  const runtimeActivityApplicabilityDeclarationPresent = Object.prototype.hasOwnProperty.call(
    params.config,
    'runtimeActivityApplicability',
  );
  const {
    displayName,
    backendDisplayName = displayName,
    uiLogPrefix = `[${backendDisplayName}]`,
    providerName = displayName,
    waitingForCommandLabel = displayName,
    agentMessageType = params.agentId,
    checkpointToolProtocol = 'acp',
    attachMetadataLogLabel = params.agentId,
    runtimeActivityApplicability: runtimeActivityApplicabilityDeclaration,
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
    runtimeActivityApplicability: resolveRuntimeActivityApplicability(
      runtimeActivityApplicabilityDeclaration,
      { declarationPresent: runtimeActivityApplicabilityDeclarationPresent },
    ),
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
  agentId: string;
  opts: TOptions;
  config: CatalogHostSessionRuntimePlanConfig<TRuntime>;
}>): HostSessionRuntimePlan {
  const { createNativeRuntime, ...config } = params.config;

  return {
    kind: HOST_SESSION_RUNTIME_PLAN_KIND,
    agentId: params.agentId,
    opts: params.opts,
    config: {
      ...config,
      createSessionRuntime: async (runtimeParams) => {
        const createdNativeRuntime = await createNativeRuntime(runtimeParams);
        if (isHostSessionRuntimeFactoryResult(createdNativeRuntime)) {
          return {
            operations: createdNativeRuntime.operations,
            nativeRuntime: createdNativeRuntime.nativeRuntime ?? null,
            ...(createdNativeRuntime.terminalRemoteModeLoop
              ? {
                  terminalRemoteModeLoop:
                    createdNativeRuntime.terminalRemoteModeLoop,
                }
              : {}),
            ...(createdNativeRuntime.admittedProviderBindingHandoff
              ? {
                  admittedProviderBindingHandoff:
                    createdNativeRuntime.admittedProviderBindingHandoff,
                }
              : {}),
          };
        }
        return {
          operations: createdNativeRuntime,
          nativeRuntime: createdNativeRuntime,
        };
      },
    },
  };
}
