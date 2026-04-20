import { createCatalogBindings } from '@/agent/runtime/registry/bindings/catalog';

import { createKimiBackend } from '../acp/backend';
import { createKimiSessionRuntimePlan } from './session';

export function createKimiBindings() {
  return createCatalogBindings({
    providerId: 'kimi',
    createHostSessionRuntimePlan: (sessionParams) =>
      createKimiSessionRuntimePlan(sessionParams as Parameters<typeof createKimiSessionRuntimePlan>[0]),
    createRuntime: (opts) => createKimiBackend(opts),
  });
}
