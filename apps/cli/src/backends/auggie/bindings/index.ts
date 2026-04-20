import { createCatalogBindings } from '@/agent/runtime/registry/bindings/catalog';

import { createAuggieBackend } from '../acp/backend';
import { createAuggieSessionRuntimePlan } from './session';

export function createAuggieBindings() {
  return createCatalogBindings({
    providerId: 'auggie',
    createHostSessionRuntimePlan: (sessionParams) =>
      createAuggieSessionRuntimePlan(sessionParams as Parameters<typeof createAuggieSessionRuntimePlan>[0]),
    createRuntime: (opts) => createAuggieBackend(opts),
  });
}
