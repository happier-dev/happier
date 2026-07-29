import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';
import { createOpenCodeServerRuntimeController } from './runtimeController.js';
import type {
  OpenCodeManagedServerSnapshot,
  OpenCodeRuntimeContext,
} from './runtimeContext.js';

export function createOpenCodeServerRuntime(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
  directory: string;
  happierSessionId: string;
  baseUrl: string;
  client: OpenCodeServerClient;
  env?: Readonly<Record<string, string>>;
  readManagedServerSnapshot?: () => OpenCodeManagedServerSnapshot | null | undefined;
}>): OpenCodeRuntimeTurnOperations {
  return createOpenCodeServerRuntimeController(params);
}
