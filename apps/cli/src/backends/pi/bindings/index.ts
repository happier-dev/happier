import { createCatalogBindings } from '@/agent/runtime/registry/bindings/catalog';

import { createPiRpcBackend } from '../rpc/backend';
import { createPiSessionRuntimePlan } from './session';

export function createPiBindings() {
  return createCatalogBindings({
    providerId: 'pi',
    createHostSessionRuntimePlan: (sessionParams) =>
      createPiSessionRuntimePlan(sessionParams as Parameters<typeof createPiSessionRuntimePlan>[0]),
    createRuntime: (opts) => createPiRpcBackend(opts),
    usesPermissionHandler: false,
  });
}
