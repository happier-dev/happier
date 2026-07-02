import type { PluginContextV1, PluginDisposable } from '@happier-dev/plugin-sdk';
import type { BundledRegisterBackendEngineV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';

import { createOhMyPiBackendEngine } from './agent/runtime/engine.js';

type PluginApiForOhMyPiV1 = Readonly<{
  registerBackendEngine: (registration: BundledRegisterBackendEngineV1) => PluginDisposable | unknown;
}>;

export function activate(api: PluginApiForOhMyPiV1): void {
  api.registerBackendEngine({
    backendId: 'ohMyPi',
    create: (ctx: PluginContextV1) => createOhMyPiBackendEngine(ctx),
  });
}
