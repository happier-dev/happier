import { createCatalogBindings } from '@/agent/runtime/registry/bindings/catalog';

import { createKiloBackend } from '../acp/backend';
import { createKiloSessionRuntimePlan } from './session';

export function createKiloBindings() {
  return createCatalogBindings({
    providerId: 'kilo',
    createHostSessionRuntimePlan: (sessionParams) =>
      createKiloSessionRuntimePlan(sessionParams as Parameters<typeof createKiloSessionRuntimePlan>[0]),
    createRuntime: (opts) => createKiloBackend(opts),
  });
}
