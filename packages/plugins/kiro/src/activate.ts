import type {
  PluginApi,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';

import { KIRO_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: 'kiro',
    create: (ctx: PluginContextV1) => ctx.agentRuntime.acp.defineAcpBackend(KIRO_ACP_BACKEND_SPEC),
  });
}
