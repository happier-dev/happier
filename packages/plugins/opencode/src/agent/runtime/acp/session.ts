import type {
  CreateSessionRuntimeParamsV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import type { BundledSessionRuntimeCreateResultV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';

import { OPEN_CODE_ACP_BACKEND_SPEC } from '../../acp/openCodeAcpBackendSpec.js';

export function createOpenCodeAcpSessionRuntime(params: Readonly<{
  ctx: PluginContextV1;
  sessionParams: CreateSessionRuntimeParamsV1;
}>): BundledSessionRuntimeCreateResultV1 | Promise<BundledSessionRuntimeCreateResultV1> {
  const acpEngine = params.ctx.acp.defineAcpBackend(OPEN_CODE_ACP_BACKEND_SPEC);
  const createSessionRuntime = acpEngine.runtimeCore?.createSessionRuntime;
  if (typeof createSessionRuntime !== 'function') {
    throw new Error('OpenCode ACP backend definition did not expose runtimeCore.createSessionRuntime.');
  }
  return createSessionRuntime(params.sessionParams);
}
