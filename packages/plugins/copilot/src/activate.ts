import type {
  PluginContextV1,
  PluginDisposable,
  RegisterBackendEngineV1,
} from '@happier-dev/plugin-sdk';

import { COPILOT_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

type CopilotPluginApiV1 = Readonly<{
  registerBackendEngine: (registration: RegisterBackendEngineV1) => PluginDisposable | unknown;
}>;

export function activate(api: CopilotPluginApiV1): void {
  api.registerBackendEngine({
    backendId: 'copilot',
    create: (ctx: PluginContextV1) => ctx.acp.defineAcpBackend(COPILOT_ACP_BACKEND_SPEC),
  });
}
