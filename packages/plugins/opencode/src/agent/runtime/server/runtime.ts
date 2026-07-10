import type { ManagedServerSnapshotV1, PluginContextV1 } from '@happier-dev/plugin-sdk';

import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';
import { createOpenCodeServerRuntimeController } from './runtimeController.js';

export function createOpenCodeServerRuntime(params: Readonly<{
  ctx: PluginContextV1;
  directory: string;
  happierSessionId: string;
  baseUrl: string;
  client?: OpenCodeServerClient;
  env?: Readonly<Record<string, string>>;
  readManagedServerSnapshot?: () => ManagedServerSnapshotV1 | null | undefined;
  setThinking?: (thinking: boolean) => void;
}>): OpenCodeRuntimeTurnOperations {
  return createOpenCodeServerRuntimeController(params);
}
