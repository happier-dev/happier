import { createCatalogRuntimeCore } from '@/agent/runtime/registry/runtimeCore/catalog';

import { createKimiBackend } from '../acp/backend';
import { createKimiSessionRuntimePlan } from './session';

export function createKimiRuntimeCore() {
  return createCatalogRuntimeCore({
    providerId: 'kimi',
    createHostSessionRuntimePlan: (sessionParams) =>
      createKimiSessionRuntimePlan(sessionParams as Parameters<typeof createKimiSessionRuntimePlan>[0]),
    createRuntime: (opts) => createKimiBackend(opts),
  });
}
