import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';

import {
  createCatalogProviderExecutionRunBackend,
  type CatalogProviderExecutionRunBackendConfig,
} from '@/agent/runtime/bridges/executionRun/runtime/catalog';

import type {
  CliRuntimeCoreFactory,
  CreateCliExecutionRunBackendParams,
} from '../engineRegistryTypes';

export interface CatalogRuntimeCoreConfig extends CatalogProviderExecutionRunBackendConfig {
  createHostSessionRuntimePlan: (sessionParams: unknown) => Promise<HostSessionRuntimePlan> | HostSessionRuntimePlan;
}

export function createCatalogRuntimeCore(
  config: CatalogRuntimeCoreConfig,
): CliRuntimeCoreFactory {
  return (_bindingParams) => Object.freeze({
    runtimeCore: Object.freeze({
      async createSessionRuntime(sessionParams: unknown): Promise<HostSessionRuntimePlan> {
        return await config.createHostSessionRuntimePlan(sessionParams);
      },
      createExecutionRunBackend(opts: CreateCliExecutionRunBackendParams) {
        return createCatalogProviderExecutionRunBackend(config, opts);
      },
    }),
  });
}
