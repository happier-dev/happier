import { randomUUID } from 'node:crypto';

import type { AgentBackend, AgentMessageHandler } from '@/agent/core/AgentBackend';
import { createExecutionRunBackend } from '@/agent/executionRuns/runtime/createExecutionRunBackend';
import { configuration } from '@/configuration';

export type EphemeralExecutionRunTextPromptBackendFactory = (opts: Readonly<{
  cwd: string;
  runId: string;
  backendId: string;
  modelId?: string;
  permissionMode: string;
  start: Readonly<{ sessionId: string; intent: string; retentionPolicy: 'ephemeral' }>;
}>) => AgentBackend;

function createDefaultBackendFactory(): EphemeralExecutionRunTextPromptBackendFactory {
  return (opts) =>
    createExecutionRunBackend({
      cwd: opts.cwd,
      runId: opts.runId,
      backendId: opts.backendId,
      modelId: opts.modelId,
      permissionMode: opts.permissionMode,
      start: opts.start,
    });
}

export async function runEphemeralExecutionRunTextPrompt(params: Readonly<{
  cwd: string;
  sessionId: string;
  backendId: string;
  modelId?: string;
  permissionMode: string;
  intent: string;
  prompt: string;
  createBackend?: EphemeralExecutionRunTextPromptBackendFactory;
  timeoutMs?: number | null;
}>): Promise<string> {
  const intent = String(params.intent ?? '').trim() || 'execution_run';
  const runId = `${intent}_${randomUUID()}`;
  const createBackend = params.createBackend ?? createDefaultBackendFactory();

  const backend = createBackend({
    cwd: params.cwd,
    runId,
    backendId: params.backendId,
    modelId: params.modelId,
    permissionMode: params.permissionMode,
    start: {
      sessionId: params.sessionId,
      intent,
      retentionPolicy: 'ephemeral',
    },
  });

  const handler: AgentMessageHandler = (msg) => {
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

  backend.onMessage(handler);

  try {
    const started = await backend.startSession();
    await backend.sendPrompt(started.sessionId, params.prompt);

    const timeoutMs =
      typeof params.timeoutMs === 'number'
        ? params.timeoutMs
        : typeof configuration.executionRunsBoundedTimeoutMs === 'number'
          ? configuration.executionRunsBoundedTimeoutMs
          : null;

    if (backend.waitForResponseComplete) {
      if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 1) {
        await backend.waitForResponseComplete(timeoutMs);
      } else {
        await backend.waitForResponseComplete();
      }
    }

    return buffer.trim();
  } finally {
    try {
      await backend.dispose();
    } catch {
      // best-effort
    }
  }
}
