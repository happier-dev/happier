import { randomUUID } from 'node:crypto';

import type { AgentMessage } from '@/agent/core/AgentBackend';
import { createExecutionRunRuntime } from '@/agent/runtime/bridges/executionRun/runtime/create';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import { configuration } from '@/configuration';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';

export type EphemeralExecutionRunTextPromptRuntimeFactory = (opts: Readonly<{
  cwd: string;
  runId: string;
  backendId: string;
  backendTarget?: BackendTargetRefV1;
  modelId?: string;
  permissionMode: string;
  start: Readonly<{ sessionId: string; intent: string; retentionPolicy: 'ephemeral' }>;
}>) => ExecutionRunHostRuntime;

function createDefaultRuntimeFactory(): EphemeralExecutionRunTextPromptRuntimeFactory {
  return (opts) =>
    createExecutionRunRuntime({
      cwd: opts.cwd,
      runId: opts.runId,
      backendId: opts.backendId,
      ...(opts.backendTarget ? { backendTarget: opts.backendTarget } : {}),
      modelId: opts.modelId,
      permissionMode: opts.permissionMode,
      start: opts.start,
    });
}

export async function runEphemeralExecutionRunTextPrompt(params: Readonly<{
  cwd: string;
  sessionId: string;
  backendId: string;
  backendTarget?: BackendTargetRefV1;
  modelId?: string;
  permissionMode: string;
  intent: string;
  prompt: string;
  createRuntime?: EphemeralExecutionRunTextPromptRuntimeFactory;
  configureSession?: (sessionId: string) => Promise<void>;
  timeoutMs?: number | null;
}>): Promise<string> {
  const intent = String(params.intent ?? '').trim() || 'execution_run';
  const runId = `${intent}_${randomUUID()}`;
  const createRuntime = params.createRuntime ?? createDefaultRuntimeFactory();

  const runtime = createRuntime({
    cwd: params.cwd,
    runId,
    backendId: params.backendId,
    ...(params.backendTarget ? { backendTarget: params.backendTarget } : {}),
    modelId: params.modelId,
    permissionMode: params.permissionMode,
    start: {
      sessionId: params.sessionId,
      intent,
      retentionPolicy: 'ephemeral',
    },
  });

  const handler = (msg: AgentMessage) => {
    if (msg.type !== 'model-output') return;
    if (typeof msg.fullText === 'string') {
      buffer = msg.fullText;
      sawFullText = true;
      return;
    }
    if (typeof msg.textDelta === 'string' && !sawFullText) {
      buffer += msg.textDelta;
    }
  };

  let buffer = '';
  let sawFullText = false;

  const unsubscribeMessages = runtime.subscribeMessages(handler);

  try {
    const started = await runtime.provisionSession();
    if (params.configureSession) {
      await params.configureSession(started.sessionId);
    }
    await runtime.sendPrompt(started.sessionId, params.prompt);

    const timeoutMs =
      typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs >= 1
        ? Math.floor(params.timeoutMs)
        : typeof configuration.executionRunsBoundedTimeoutMs === 'number'
          && Number.isFinite(configuration.executionRunsBoundedTimeoutMs)
          && configuration.executionRunsBoundedTimeoutMs >= 1
          ? Math.floor(configuration.executionRunsBoundedTimeoutMs)
          : null;

    if (runtime.waitForTurnCompletion) {
      if (typeof timeoutMs === 'number') {
        await runtime.waitForTurnCompletion(timeoutMs);
      } else {
        await runtime.waitForTurnCompletion();
      }
    }

    return buffer.trim();
  } finally {
    unsubscribeMessages();
    try {
      await runtime.dispose();
    } catch {
      // best-effort
    }
  }
}
