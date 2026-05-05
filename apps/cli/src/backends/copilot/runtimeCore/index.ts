import { createCatalogRuntimeCore } from '@/agent/runtime/registry/runtimeCore/catalog';

import { createCopilotBackend } from '../acp/backend';
import { createCopilotSessionRuntimePlan } from './session';

export function createCopilotRuntimeCore() {
  return createCatalogRuntimeCore({
    providerId: 'copilot',
    createHostSessionRuntimePlan: (sessionParams) =>
      createCopilotSessionRuntimePlan(sessionParams as Parameters<typeof createCopilotSessionRuntimePlan>[0]),
    createRuntime: (opts) => createCopilotBackend(opts),
  });
}
