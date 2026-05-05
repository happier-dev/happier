import { createCatalogRuntimeCore } from '@/agent/runtime/registry/runtimeCore/catalog';

import { createKiloBackend } from '../acp/backend';
import { createKiloSessionRuntimePlan } from './session';

export function createKiloRuntimeCore() {
  return createCatalogRuntimeCore({
    providerId: 'kilo',
    createHostSessionRuntimePlan: (sessionParams) =>
      createKiloSessionRuntimePlan(sessionParams as Parameters<typeof createKiloSessionRuntimePlan>[0]),
    createRuntime: (opts) => createKiloBackend(opts),
  });
}
