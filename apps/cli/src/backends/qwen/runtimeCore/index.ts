import { createCatalogRuntimeCore } from '@/agent/runtime/registry/runtimeCore/catalog';

import { createQwenBackend } from '../acp/backend';
import { createQwenSessionRuntimePlan } from './session';

export function createQwenRuntimeCore() {
  return createCatalogRuntimeCore({
    providerId: 'qwen',
    createHostSessionRuntimePlan: (sessionParams) =>
      createQwenSessionRuntimePlan(sessionParams as Parameters<typeof createQwenSessionRuntimePlan>[0]),
    createRuntime: (opts) => createQwenBackend(opts),
  });
}
