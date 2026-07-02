import { runEphemeralExecutionRunTextPrompt, type EphemeralExecutionRunTextPromptRuntimeFactory } from '@/agent/runtime/bridges/executionRun/runtime/textPrompt';
import { resolveExecutionRunPublicBackendId } from '@/agent/runtime/bridges/executionRun/backendTargets';
import { createExecutionRunTextPromptBackendForTarget } from './textPromptBackend';

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
  intent: string;
  prompt: string;
  createRuntime?: EphemeralExecutionRunTextPromptRuntimeFactory;
  timeoutMs?: number | null;
}>): Promise<string> {
  const backendTarget = params.runner?.backendTarget;
  if (!backendTarget) return '';
  const modelId = normalizeNonEmptyString(params.runner?.modelId) ?? undefined;
  const permissionMode = normalizeNonEmptyString(params.runner?.permissionMode) ?? 'no_tools';
  const resolved = params.createRuntime
      ? {
        backendId: resolveExecutionRunPublicBackendId(backendTarget),
        backend: params.createRuntime({
          cwd: params.cwd,
          runId: `${params.intent}_${Date.now()}`,
          backendId: resolveExecutionRunPublicBackendId(backendTarget),
          backendTarget,
          modelId,
          permissionMode,
          start: {
            sessionId: params.sessionId,
            intent: params.intent,
            retentionPolicy: 'ephemeral' as const,
          },
        }),
        configureSession: undefined,
      }
    : await createExecutionRunTextPromptBackendForTarget({
        cwd: params.cwd,
        sessionId: params.sessionId,
        backendTarget,
        modelId,
        permissionMode,
        intent: params.intent,
      });

  return await runEphemeralExecutionRunTextPrompt({
    cwd: params.cwd,
    sessionId: params.sessionId,
    backendId: resolved.backendId,
    backendTarget,
    modelId,
    permissionMode,
    intent: params.intent,
    prompt: params.prompt,
    createRuntime: () => resolved.backend,
    configureSession: resolved.configureSession,
    timeoutMs: params.timeoutMs,
  });
}
