import { createCatalogBindings } from '@/agent/runtime/registry/bindings/catalog';

import { createCopilotBackend } from '../acp/backend';
import { createCopilotSessionRuntimePlan } from './session';

export function createCopilotBindings() {
  return createCatalogBindings({
    providerId: 'copilot',
    createHostSessionRuntimePlan: (sessionParams) =>
      createCopilotSessionRuntimePlan(sessionParams as Parameters<typeof createCopilotSessionRuntimePlan>[0]),
    createRuntime: (opts) => createCopilotBackend(opts),
  });
}
