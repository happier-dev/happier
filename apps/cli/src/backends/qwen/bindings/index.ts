import { createCatalogBindings } from '@/agent/runtime/registry/bindings/catalog';

import { createQwenBackend } from '../acp/backend';
import { createQwenSessionRuntimePlan } from './session';

export function createQwenBindings() {
  return createCatalogBindings({
    providerId: 'qwen',
    createHostSessionRuntimePlan: (sessionParams) =>
      createQwenSessionRuntimePlan(sessionParams as Parameters<typeof createQwenSessionRuntimePlan>[0]),
    createRuntime: (opts) => createQwenBackend(opts),
  });
}
