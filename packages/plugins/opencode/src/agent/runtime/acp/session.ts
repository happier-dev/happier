import type {
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
  SessionRuntimeCreateResultV1,
} from '@happier-dev/plugin-sdk';

import { OPEN_CODE_ACP_BACKEND_SPEC } from '../../acp/openCodeAcpBackendSpec.js';

export function createOpenCodeAcpSessionRuntime(params: Readonly<{
  ctx: PluginContextV1;
  sessionParams: CreateSessionRuntimeParamsV1;
}>): SessionRuntimeCreateResultV1 | Promise<SessionRuntimeCreateResultV1> {
  const acpEngine = params.ctx.agentRuntime.acp.defineAcpBackend(OPEN_CODE_ACP_BACKEND_SPEC);
  const createSessionRuntime = acpEngine.runtimeCore?.createSessionRuntime;
  if (typeof createSessionRuntime !== 'function') {
    throw new Error('OpenCode ACP backend definition did not expose runtimeCore.createSessionRuntime.');
  }
  return createSessionRuntime(params.sessionParams);
}
