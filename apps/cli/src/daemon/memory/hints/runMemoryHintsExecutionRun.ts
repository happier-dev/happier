import { randomUUID } from 'node:crypto';

import type { AgentBackend, AgentMessageHandler } from '@/agent/core/AgentBackend';
import { configuration } from '@/configuration';
import { createExecutionRunBackend } from '@/agent/executionRuns/runtime/createExecutionRunBackend';

export type MemoryHintsExecutionRunBackendFactory = (opts: Readonly<{
  cwd: string;
  runId: string;
  backendId: string;
  modelId?: string;
  permissionMode: string;
  start: Readonly<{ sessionId: string; intent: 'memory_hints'; retentionPolicy: 'ephemeral' }>;
}>) => AgentBackend;

function createDefaultBackendFactory(): MemoryHintsExecutionRunBackendFactory {
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

export async function runMemoryHintsExecutionRun(params: Readonly<{
  cwd: string;
  sessionId: string;
  backendId: string;
  modelId?: string;
  permissionMode: 'no_tools' | 'read_only';
  prompt: string;
  createBackend?: MemoryHintsExecutionRunBackendFactory;
  timeoutMs?: number | null;
}>): Promise<string> {
  const runId = `memory_hints_${randomUUID()}`;
  const createBackend = params.createBackend ?? createDefaultBackendFactory();

  const backend = createBackend({
    cwd: params.cwd,
    runId,
    backendId: params.backendId,
    modelId: params.modelId,
    permissionMode: params.permissionMode,
    start: {
      sessionId: params.sessionId,
      intent: 'memory_hints',
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

