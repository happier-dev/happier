import type {
  CliEngineAdapter,
  CreateCliExecutionRunBackendParams,
} from '@/agent/runtime/registry/engineRegistryTypes';
import type { HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/sessionLoop/runHostSessionRuntime';

import { backend } from '@/backends/gemini/executionRuns/backend';
import { createGeminiSessionRuntimePlan } from './session';

export function createGeminiBindings(): CliEngineAdapter {
  return Object.freeze({
    bindings: Object.freeze({
      async createSessionRuntime(sessionParams: unknown): Promise<HostSessionRuntimePlan> {
        const opts = (() => {
          if (!sessionParams || typeof sessionParams !== 'object') {
            throw new Error('Gemini bindings session opts must be an object');
        }
        const record = sessionParams as Record<string, unknown>;
        if (!record.credentials) {
          throw new Error('Gemini bindings session opts are missing credentials');
        }
        return sessionParams as unknown as HostSessionRuntimeRunOptions;
        })();
        return createGeminiSessionRuntimePlan(opts);
      },
      createExecutionRunBackend: (params: CreateCliExecutionRunBackendParams) =>
        backend(params),
    }),
  });
}
