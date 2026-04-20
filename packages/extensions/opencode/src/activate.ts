import type { RegisterBackendEngineV1 } from '@happier-dev/extension-sdk';

import { createOpenCodeBackendEngine } from './engine/createOpenCodeBackendEngine.js';

type ExtensionApiForOpenCodeV1 = Readonly<{
  registerBackendEngine: (registration: RegisterBackendEngineV1) => unknown;
}>;

export function activate(api: ExtensionApiForOpenCodeV1): void {
  api.registerBackendEngine({
    backendId: 'opencode',
    create: async (ctx) => {
      ctx.logger.info('[extensions/opencode] Creating backend engine');
      return createOpenCodeBackendEngine();
    },
  });
}
