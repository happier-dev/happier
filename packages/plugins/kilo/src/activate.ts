import type {
  PluginContextV1,
  PluginDisposable,
  RegisterBackendEngineV1,
} from '@happier-dev/plugin-sdk';

import { KILO_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

type KiloPluginApiV1 = Readonly<{
  registerBackendEngine: (registration: RegisterBackendEngineV1) => PluginDisposable | unknown;
}>;

export function activate(api: KiloPluginApiV1): void {
  api.registerBackendEngine({
    backendId: 'kilo',
    create: (ctx: PluginContextV1) => ctx.acp.defineAcpBackend(KILO_ACP_BACKEND_SPEC),
  });
}
