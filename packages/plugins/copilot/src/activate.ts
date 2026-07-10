import type {
  PluginApi,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';

import { COPILOT_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: 'copilot',
    create: (ctx: PluginContextV1) => ctx.agentRuntime.acp.defineAcpBackend(COPILOT_ACP_BACKEND_SPEC),
  });
}
