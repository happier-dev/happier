import type {
  PluginDisposable,
} from '@happier-dev/plugin-sdk';
import type { BundledRegisterBackendEngineV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';

import { createPiBackendEngine } from './agent/runtime/engine.js';

type PluginApiForPiV1 = Readonly<{
  registerBackendEngine: (registration: BundledRegisterBackendEngineV1) => PluginDisposable | unknown;
}>;

export function activate(api: PluginApiForPiV1): void {
  api.registerBackendEngine({
    backendId: 'pi',
    create: createPiBackendEngine,
  });
}
