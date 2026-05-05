import { createCatalogRuntimeCore } from '@/agent/runtime/registry/runtimeCore/catalog';

import { createPiRpcBackend } from '../rpc/backend';
import { createPiSessionRuntimePlan } from './session';

export function createPiRuntimeCore() {
  return createCatalogRuntimeCore({
    providerId: 'pi',
    createHostSessionRuntimePlan: (sessionParams) =>
      createPiSessionRuntimePlan(sessionParams as Parameters<typeof createPiSessionRuntimePlan>[0]),
    createRuntime: (opts) => createPiRpcBackend(opts),
    usesPermissionHandler: false,
  });
}
