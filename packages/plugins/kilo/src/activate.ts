import type {
  PluginApi,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';

import { KILO_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: 'kilo',
    create: (ctx: PluginContextV1) => ctx.agentRuntime.acp.defineAcpBackend(KILO_ACP_BACKEND_SPEC),
  });
}
