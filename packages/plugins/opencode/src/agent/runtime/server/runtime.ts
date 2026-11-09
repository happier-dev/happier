import type { ManagedServiceSnapshot } from '@happier-dev/plugin-sdk/managed-services';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

import type { OpenCodeRuntimeTurnOperations } from './operations.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';
import type { OpenCodeMcpRegistrationResult, OpenCodeSessionMcpProjection } from './mcpRegistration.js';
import type { OpenCodeServerDialect } from './dialect.js';
import { createOpenCodeServerRuntimeController } from './runtimeController.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import {
  resolveOpenCodeRuntimeScope,
  type OpenCodeHostRuntimeIdentity,
} from './runtimeEvents.js';

export function createOpenCodeServerRuntime(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
  directory: string;
  client: OpenCodeServerClient;
  env?: Readonly<Record<string, string>>;
  permissionMode?: string | null;
  finiteExecutionRun?: boolean;
  workspaceWrites?: NonNullable<AgentSessionOpenRequest['configuration']>['workspaceWrites'];
  mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
  dialect?: OpenCodeServerDialect;
  providerModelId?: string;
  readManagedServiceSnapshot?: () => ManagedServiceSnapshot | null | undefined;
  mcpRegistration: Promise<OpenCodeMcpRegistrationResult>;
  mcpProjection: OpenCodeSessionMcpProjection;
}> & OpenCodeHostRuntimeIdentity): OpenCodeRuntimeTurnOperations {
  return createOpenCodeServerRuntimeController({
    ...params,
    scope: resolveOpenCodeRuntimeScope(params),
  });
}
