import type {
  PluginContextV1,
  PluginDisposable,
  RegisterBackendEngineV1,
} from '@happier-dev/plugin-sdk';

import { QWEN_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

type PluginApiForQwenV1 = Readonly<{
  registerBackendEngine: (registration: RegisterBackendEngineV1) => PluginDisposable | unknown;
}>;

export function activate(api: PluginApiForQwenV1): void {
  api.registerBackendEngine({
    backendId: 'qwen',
    create: (ctx: PluginContextV1) => ctx.acp.defineAcpBackend(QWEN_ACP_BACKEND_SPEC),
  });
}
