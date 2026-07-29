import type { ClaudeRuntimeSessionParams } from '../../shared/runtimeHelpers.js';
import {
  adaptClaudeProviderOperationsForTest,
  createClaudeTestSessionRuntime,
  type ClaudeTestSessionRuntime,
  type ClaudeRuntimeTurnOperations,
} from '../../sessionRuntime.testkit.js';
import {
  createClaudeAgentSdkTurnOperations as createClaudeAgentSdkProviderOperations,
  type ClaudeAgentSdkContext,
  type ClaudeAgentSdkNativeOperations,
  type ClaudeAgentSdkTurnOperationsParams,
} from './session.js';
import {
  readClaudeRuntimeDirectory,
  readClaudeRuntimeEnv,
} from '../../shared/runtimeHelpers.js';

type ClaudeAgentSdkTestOperations = ClaudeAgentSdkNativeOperations & ClaudeRuntimeTurnOperations;

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createClaudeAgentSdkTurnOperations(
  params: ClaudeAgentSdkTurnOperationsParams & Readonly<{ nativeOperationsOnly: true }>,
): ClaudeAgentSdkTestOperations;
export function createClaudeAgentSdkTurnOperations(
  params: ClaudeAgentSdkTurnOperationsParams,
): ClaudeTestSessionRuntime;
export function createClaudeAgentSdkTurnOperations(
  params: ClaudeAgentSdkTurnOperationsParams & Readonly<{ nativeOperationsOnly?: boolean }>,
): ClaudeTestSessionRuntime | ClaudeAgentSdkTestOperations {
  const operations = createClaudeAgentSdkProviderOperations(params);
  const testOperations = adaptClaudeProviderOperationsForTest(operations);
  return params.nativeOperationsOnly === true
    ? testOperations
    : createClaudeTestSessionRuntime(testOperations);
}

export async function bindClaudeAgentSdkFallbackSession(params: Readonly<{
  ctx: ClaudeAgentSdkContext;
  sessionParams: ClaudeRuntimeSessionParams & Readonly<{
    permissionMode?: string | null;
    sessionId?: string | null;
    mcpServers?: ClaudeAgentSdkTurnOperationsParams['mcpServers'];
  }>;
}>) {
  return createClaudeTestSessionRuntime(adaptClaudeProviderOperationsForTest(createClaudeAgentSdkProviderOperations({
    ctx: params.ctx,
    directory: readClaudeRuntimeDirectory(params.sessionParams),
    launchEnv: readClaudeRuntimeEnv(params.sessionParams),
    permissionMode: readString(params.sessionParams.permissionMode) ?? 'default',
    happierSessionId: readString(params.sessionParams.sessionId),
    mcpServers: params.sessionParams.mcpServers,
    publishTranscriptMessages: true,
    enableSessionWorkState: true,
    enableSessionResumability: true,
  })));
}
