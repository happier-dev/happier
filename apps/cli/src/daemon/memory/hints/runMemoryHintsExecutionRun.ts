import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import type { AgentMessage } from '@/agent/core/AgentMessage';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

export type MemoryHintsExecutionRunBackendFactory = (opts: Readonly<{
  cwd: string;
  runId: string;
  backendId: string;
  backendTarget?: BackendTargetRefV1;
  modelId?: string;
  permissionMode: string;
  start: Readonly<{ sessionId: string; intent: string; retentionPolicy: 'ephemeral' }>;
}>) => ExecutionRunHostRuntime;

function isValidTimeoutMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1;
}

async function resolveInjectedRuntimeTimeoutMs(timeoutMs: number | null | undefined): Promise<number | null> {
  if (isValidTimeoutMs(timeoutMs)) return Math.floor(timeoutMs);

  const { configuration } = await import('@/configuration');
  const configured = configuration.executionRunsBoundedTimeoutMs;
  return isValidTimeoutMs(configured) ? Math.floor(configured) : null;
}

async function runWithInjectedBackend(params: Readonly<{
  cwd: string;
  sessionId: string;
  backendId: string;
  modelId?: string;
  permissionMode: 'no_tools' | 'read_only';
  prompt: string;
  createBackend: MemoryHintsExecutionRunBackendFactory;
  timeoutMs?: number | null;
}>): Promise<string> {
  const backendTarget = { kind: 'builtInAgent' as const, agentId: params.backendId };
  const runtime = params.createBackend({
    cwd: params.cwd,
    runId: `memory_hints_${Date.now()}`,
    backendId: params.backendId,
    backendTarget,
    ...(params.modelId ? { modelId: params.modelId } : {}),
    permissionMode: params.permissionMode,
    start: {
      sessionId: params.sessionId,
      intent: 'memory_hints',
      retentionPolicy: 'ephemeral',
    },
  });

  let buffer = '';
  let sawFullText = false;
  const onMessage = (msg: AgentMessage) => {
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

  const unsubscribe = runtime.subscribeMessages(onMessage);
  try {
    const started = await runtime.provisionSession();
    await runtime.sendPrompt(started.sessionId, params.prompt);
    if (runtime.waitForTurnCompletion) {
      const timeoutMs = await resolveInjectedRuntimeTimeoutMs(params.timeoutMs);
      if (typeof timeoutMs === 'number') {
        await runtime.waitForTurnCompletion(timeoutMs);
      } else {
        await runtime.waitForTurnCompletion();
      }
    }
    return buffer.trim();
  } finally {
    unsubscribe();
    try {
      await runtime.dispose();
    } catch {
      // best-effort
    }
  }
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
  if (params.createBackend) {
    return await runWithInjectedBackend({
      cwd: params.cwd,
      sessionId: params.sessionId,
      backendId: params.backendId,
      ...(params.modelId ? { modelId: params.modelId } : {}),
      permissionMode: params.permissionMode,
      prompt: params.prompt,
      createBackend: params.createBackend,
      timeoutMs: params.timeoutMs,
    });
  }

  const { runEphemeralExecutionRunTextPromptWithRunnerConfig } = await import(
    '@/agent/executionRuns/tasks/textPromptWithRunnerConfig'
  );
  return await runEphemeralExecutionRunTextPromptWithRunnerConfig({
    cwd: params.cwd,
    sessionId: params.sessionId,
    runner: {
      backendTarget: { kind: 'builtInAgent', agentId: params.backendId },
      modelId: params.modelId,
      permissionMode: params.permissionMode,
    },
    intent: 'memory_hints',
    prompt: params.prompt,
    createRuntime: params.createBackend,
    timeoutMs: params.timeoutMs,
  });
}
