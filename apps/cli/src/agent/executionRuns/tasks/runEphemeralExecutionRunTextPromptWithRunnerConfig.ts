import { runEphemeralExecutionRunTextPrompt, type EphemeralExecutionRunTextPromptBackendFactory } from '../runtime/runEphemeralExecutionRunTextPrompt';

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function runEphemeralExecutionRunTextPromptWithRunnerConfig(params: Readonly<{
  cwd: string;
  sessionId: string;
  runner: Readonly<{
    backendId: string;
    modelId?: string;
    permissionMode?: string;
  }>;
  intent: string;
  prompt: string;
  createBackend?: EphemeralExecutionRunTextPromptBackendFactory;
  timeoutMs?: number | null;
}>): Promise<string> {
  const backendId = normalizeNonEmptyString(params.runner?.backendId) ?? '';
  if (!backendId) return '';
  const modelId = normalizeNonEmptyString(params.runner?.modelId) ?? undefined;
  const permissionMode = normalizeNonEmptyString(params.runner?.permissionMode) ?? 'no_tools';

  return await runEphemeralExecutionRunTextPrompt({
    cwd: params.cwd,
    sessionId: params.sessionId,
    backendId,
    modelId,
    permissionMode,
    intent: params.intent,
    prompt: params.prompt,
    createBackend: params.createBackend,
    timeoutMs: params.timeoutMs,
  });
}
