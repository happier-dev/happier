import type { ExecutionRunIntent } from '@happier-dev/protocol';

import {
  runEphemeralExecutionRunTextPrompt,
  type EphemeralExecutionRunTextPromptStartAction,
} from '@/agent/runtime/bridges/executionRun/runtime/textPrompt';
import type { StoredCredentials } from '@/persistence';

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function runEphemeralExecutionRunTextPromptWithRunnerConfig(params: Readonly<{
  cwd: string;
  sessionId: string;
  runner: Readonly<{
    backendTarget: {
      kind: 'builtInAgent';
      agentId: string;
    } | {
      kind: 'configuredAcpBackend';
      backendId: string;
    };
    modelId?: string;
    permissionMode?: string;
  }>;
  intent: ExecutionRunIntent;
  prompt: string;
  credentials?: StoredCredentials | null;
  signal?: AbortSignal;
  timeoutMs?: number | null;
  executeStart?: EphemeralExecutionRunTextPromptStartAction;
}>): Promise<string> {
  const backendTarget = params.runner?.backendTarget;
  if (!backendTarget) return '';
  const modelId = normalizeNonEmptyString(params.runner?.modelId) ?? undefined;
  const permissionMode = normalizeNonEmptyString(params.runner?.permissionMode) ?? 'no_tools';

  return await runEphemeralExecutionRunTextPrompt({
    sessionId: params.sessionId,
    backendTarget,
    modelId,
    permissionMode,
    intent: params.intent,
    prompt: params.prompt,
    ...(params.credentials !== undefined ? { credentials: params.credentials } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    timeoutMs: params.timeoutMs,
    ...(params.executeStart ? { executeStart: params.executeStart } : {}),
  });
}
