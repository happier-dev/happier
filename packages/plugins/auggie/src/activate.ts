import type { PluginApiV1, PluginContextV1 } from '@happier-dev/plugin-sdk';

import { AUGGIE_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

export function activate(api: PluginApiV1): void {
  api.registerBackendEngine({
    backendId: 'auggie',
    create: (ctx: PluginContextV1) => ctx.acp.defineAcpBackend(AUGGIE_ACP_BACKEND_SPEC),
  });
}
