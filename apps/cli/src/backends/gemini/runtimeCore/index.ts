import type {
  CliEngineAdapter,
  CreateCliExecutionRunBackendParams,
} from '@/agent/runtime/registry/engineRegistryTypes';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import type { HostSessionRuntimeRunOptions } from '@/agent/runtime/session/loop/runHostSessionRuntime';

import { backend } from '@/backends/gemini/executionRuns/backend';
import { createGeminiSessionRuntimePlan } from './session';

export function createGeminiRuntimeCore(): CliEngineAdapter {
  return Object.freeze({
    runtimeCore: Object.freeze({
      async createSessionRuntime(sessionParams: unknown): Promise<HostSessionRuntimePlan> {
        const opts = (() => {
          if (!sessionParams || typeof sessionParams !== 'object') {
            throw new Error('Gemini runtimeCore session opts must be an object');
        }
        const record = sessionParams as Record<string, unknown>;
        if (!record.credentials) {
          throw new Error('Gemini runtimeCore session opts are missing credentials');
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
