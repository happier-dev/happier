import type {
  PluginApi,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';

import { QWEN_ACP_BACKEND_SPEC } from './agent/acp/definition.js';

export function activate(api: PluginApi): void {
  api.registerAgentRuntime({
    agentId: 'qwen',
    create: (ctx: PluginContextV1) => ctx.agentRuntime.acp.defineAcpBackend(QWEN_ACP_BACKEND_SPEC),
  });
}
