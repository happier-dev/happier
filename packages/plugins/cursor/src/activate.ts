import type {
  PluginDisposable,
} from '@happier-dev/plugin-sdk';
import type { BundledRegisterBackendEngineV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';

import { createCursorBackendEngine } from './agent/runtime/engine.js';

type PluginApiForCursorV1 = Readonly<{
  registerBackendEngine: (registration: BundledRegisterBackendEngineV1) => PluginDisposable | unknown;
}>;

export function activate(api: PluginApiForCursorV1): void {
  api.registerBackendEngine({
    backendId: 'cursor',
    create: async (ctx) => {
      ctx.logger.info('[plugins/cursor] Creating backend engine');
      return createCursorBackendEngine(ctx);
    },
  });
}
