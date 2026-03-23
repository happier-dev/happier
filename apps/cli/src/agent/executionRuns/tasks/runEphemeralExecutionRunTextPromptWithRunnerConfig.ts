import { runEphemeralExecutionRunTextPrompt, type EphemeralExecutionRunTextPromptBackendFactory } from '../runtime/runEphemeralExecutionRunTextPrompt';
import { createExecutionRunTextPromptBackendForTarget } from './createExecutionRunTextPromptBackendForTarget';

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
  createBackend?: EphemeralExecutionRunTextPromptBackendFactory;
  timeoutMs?: number | null;
}>): Promise<string> {
  const backendTarget = params.runner?.backendTarget;
  if (!backendTarget) return '';
  const modelId = normalizeNonEmptyString(params.runner?.modelId) ?? undefined;
  const permissionMode = normalizeNonEmptyString(params.runner?.permissionMode) ?? 'no_tools';
  const resolved = params.createBackend
    ? {
        backendId: backendTarget.kind === 'builtInAgent' ? backendTarget.agentId : 'customAcp',
        backend: params.createBackend({
          cwd: params.cwd,
          runId: `${params.intent}_${Date.now()}`,
          backendId: backendTarget.kind === 'builtInAgent' ? backendTarget.agentId : 'customAcp',
          backendTarget,
          modelId,
          permissionMode,
          start: {
            sessionId: params.sessionId,
            intent: params.intent,
            retentionPolicy: 'ephemeral' as const,
          },
        }),
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
    createBackend: () => resolved.backend,
    configureSession: resolved.configureSession,
    timeoutMs: params.timeoutMs,
  });
}
