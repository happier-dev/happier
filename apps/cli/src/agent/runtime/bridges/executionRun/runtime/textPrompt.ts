import type {
  ActionExecuteResult,
  ActionExecutorContext,
  BackendTargetRefV1,
  ExecutionRunIntent,
} from '@happier-dev/protocol';

import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

type ExecutionRunStartAction = (
  input: unknown,
  context: ActionExecutorContext,
) => Promise<ActionExecuteResult>;

export type EphemeralExecutionRunTextPromptStartAction = ExecutionRunStartAction;

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stableFailure(code: string): Error & Readonly<{ code: string }> {
  return Object.assign(new Error(code), { code });
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeWaitTimeoutSeconds(timeoutMs: unknown): number | undefined {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 1) {
    return undefined;
  }
  const seconds = Math.ceil(timeoutMs / 1_000);
  return Number.isSafeInteger(seconds) && seconds >= 1 ? seconds : undefined;
}

function readCanonicalTextResult(result: ActionExecuteResult): string {
  if (!result.ok) throw stableFailure(result.errorCode);

  const started = readRecord(result.result);
  const wait = readRecord(started.wait);
  if (wait.ok !== true) {
    const code = normalizeNonEmptyString(wait.code) ?? 'execution_run_wait_unavailable';
    throw stableFailure(code);
  }
  if (wait.status !== 'succeeded') {
    throw stableFailure('execution_run_failed');
  }

  const observation = readRecord(wait.result);
  const output = observation.latestToolResult;
  if (typeof output !== 'string') {
    throw stableFailure('execution_run_output_invalid');
  }
  return output.trim();
}

async function createCanonicalStartAction(params: Readonly<{
  credentials?: StoredCredentials | null;
  signal?: AbortSignal;
}>): Promise<ExecutionRunStartAction> {
  const credentials = params.credentials ?? await readStoredCredentials();
  if (!credentials) throw stableFailure('not_authenticated');

  const executor = createCliActionExecutorFromCredentials({ credentials });
  const bound = params.signal
    ? executor.bindInvocation(params.signal)
    : executor;
  return async (input, context) => await bound.execute(
    'execution.run.start',
    input,
    context,
  );
}

/**
 * Thin compatibility adapter for the former text-prompt helper. Run identity,
 * runtime selection, output collection, cancellation, and waiting now belong
 * to the incumbent execution.run.start Action and its existing waiter.
 */
export async function runEphemeralExecutionRunTextPrompt(params: Readonly<{
  sessionId: string;
  backendTarget: BackendTargetRefV1;
  modelId?: string;
  permissionMode: string;
  intent: ExecutionRunIntent;
  prompt: string;
  credentials?: StoredCredentials | null;
  signal?: AbortSignal;
  timeoutMs?: number | null;
  executeStart?: EphemeralExecutionRunTextPromptStartAction;
}>): Promise<string> {
  params.signal?.throwIfAborted();
  const executeStart = params.executeStart ?? await createCanonicalStartAction({
    ...(params.credentials !== undefined ? { credentials: params.credentials } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const modelId = normalizeNonEmptyString(params.modelId);
  const waitTimeoutSeconds = normalizeWaitTimeoutSeconds(params.timeoutMs);
  const result = await executeStart({
    intent: params.intent,
    backendTarget: params.backendTarget,
    ...(modelId ? { modelId } : {}),
    permissionMode: params.permissionMode,
    retentionPolicy: 'ephemeral',
    runClass: 'bounded',
    ioMode: 'request_response',
    instructions: params.prompt,
    waitForCompletion: true,
    ...(waitTimeoutSeconds !== undefined
      ? { waitTimeoutSeconds }
      : {}),
  }, {
    surface: 'cli',
    authority: 'account_automation',
    defaultSessionId: params.sessionId,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  return readCanonicalTextResult(result);
}
