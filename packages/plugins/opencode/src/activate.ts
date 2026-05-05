import type { RegisterBackendEngineV1 } from '@happier-dev/plugin-sdk';

import { createOpenCodeBackendEngine } from './engine/createOpenCodeBackendEngine.js';

type PluginApiForOpenCodeV1 = Readonly<{
  registerBackendEngine: (registration: RegisterBackendEngineV1) => unknown;
}>;

export function activate(api: PluginApiForOpenCodeV1): void {
  api.registerBackendEngine({
    backendId: 'opencode',
    create: async (ctx) => {
      ctx.logger.info('[plugins/opencode] Creating backend engine');
      return createOpenCodeBackendEngine();
    },
  });
}
