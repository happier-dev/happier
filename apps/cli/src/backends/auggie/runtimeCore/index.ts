import { createCatalogRuntimeCore } from '@/agent/runtime/registry/runtimeCore/catalog';

import { createAuggieBackend } from '../acp/backend';
import { createAuggieSessionRuntimePlan } from './session';

export function createAuggieRuntimeCore() {
  return createCatalogRuntimeCore({
    providerId: 'auggie',
    createHostSessionRuntimePlan: (sessionParams) =>
      createAuggieSessionRuntimePlan(sessionParams as Parameters<typeof createAuggieSessionRuntimePlan>[0]),
    createRuntime: (opts) => createAuggieBackend(opts),
  });
}
