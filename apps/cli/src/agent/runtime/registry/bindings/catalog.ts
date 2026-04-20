import type { HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';

import {
  createCatalogProviderExecutionRunBackend,
  type CatalogProviderExecutionRunBackendConfig,
} from '@/agent/executionRuns/runtime/backends/catalogProvider';

import type {
  CliBindingsFactory,
  CreateCliExecutionRunBackendParams,
} from '../engineRegistryTypes';

export interface CatalogBindingsConfig extends CatalogProviderExecutionRunBackendConfig {
  createHostSessionRuntimePlan: (sessionParams: unknown) => Promise<HostSessionRuntimePlan> | HostSessionRuntimePlan;
}

export function createCatalogBindings(
  config: CatalogBindingsConfig,
): CliBindingsFactory {
  return (_bindingParams) => Object.freeze({
    bindings: Object.freeze({
      async createSessionRuntime(sessionParams: unknown): Promise<HostSessionRuntimePlan> {
        return await config.createHostSessionRuntimePlan(sessionParams);
      },
      createExecutionRunBackend(opts: CreateCliExecutionRunBackendParams) {
        return createCatalogProviderExecutionRunBackend(config, opts);
      },
    }),
  });
}
