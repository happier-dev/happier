import type { ManagedServiceSnapshot } from '@happier-dev/plugin-sdk/managed-services';

import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';
import type { OpenCodeMcpRegistrationResult } from './mcpRegistration.js';
import { createOpenCodeServerRuntimeController } from './runtimeController.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';

export function createOpenCodeServerRuntime(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
  directory: string;
  happierSessionId: string;
  client: OpenCodeServerClient;
  env?: Readonly<Record<string, string>>;
  readManagedServiceSnapshot?: () => ManagedServiceSnapshot | null | undefined;
  mcpRegistration: Promise<OpenCodeMcpRegistrationResult>;
}>): OpenCodeRuntimeTurnOperations {
  return createOpenCodeServerRuntimeController(params);
}
