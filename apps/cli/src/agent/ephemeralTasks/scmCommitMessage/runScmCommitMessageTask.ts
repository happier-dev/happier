import type { AgentMessage } from '@/agent/core/AgentBackend';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

import { buildCommitMessagePrompt } from './buildCommitMessagePrompt';
import { loadScmCommitMessageContext } from './loadScmCommitMessageContext';
import { parseCommitMessageModelOutput } from './parseCommitMessageModelOutput';

async function runOneShotBackend(params: Readonly<{
  backend: ExecutionRunHostRuntime;
  prompt: string;
}>): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let buffer = '';
  const onMessage = (msg: AgentMessage) => {
    if (msg.type !== 'model-output') return;
    if (typeof msg.fullText === 'string') {
      buffer = msg.fullText;
    } else if (typeof msg.textDelta === 'string') {
      buffer += msg.textDelta;
    }
  };

  const unsubscribeMessages = params.backend.subscribeMessages(onMessage);

  try {
    const started = await params.backend.provisionSession();
    const childSessionId = started.sessionId;
    await params.backend.sendPrompt(childSessionId, params.prompt);
    if (params.backend.waitForTurnCompletion) {
      await params.backend.waitForTurnCompletion();
    }
    return { ok: true, text: buffer.trim() };
  } catch (e: any) {
    return { ok: false, error: e instanceof Error ? e.message : 'Task failed' };
  } finally {
    unsubscribeMessages();
    try {
      await params.backend.dispose();
    } catch {
      // ignore
    }
  }
}

export async function runScmCommitMessageTask(params: Readonly<{
  workingDirectory: string;
  createBackend: () => ExecutionRunHostRuntime;
  instructions?: string;
  scope?: unknown;
  maxFiles?: number;
  maxTotalDiffChars?: number;
}>): Promise<
  | { ok: true; result: { title: string; body: string; message: string; confidence?: number } }
  | { ok: false; errorCode: string; error: string }
> {
  const context = await loadScmCommitMessageContext({
    workingDirectory: params.workingDirectory,
    maxFiles: typeof params.maxFiles === 'number' ? params.maxFiles : 20,
    maxTotalDiffChars: typeof params.maxTotalDiffChars === 'number' ? params.maxTotalDiffChars : 60_000,
    scope: params.scope,
  });
  if (!context.ok) return context;

  const prompt = buildCommitMessagePrompt({
    snapshot: context.snapshot,
    diffsByPath: context.diffsByPath,
    instructions: params.instructions,
  });

  const backend = params.createBackend();
  const res = await runOneShotBackend({ backend, prompt });
  if (!res.ok) return { ok: false, errorCode: 'task_failed', error: res.error };

  const parsed = parseCommitMessageModelOutput(res.text);
  if (!parsed) return { ok: false, errorCode: 'invalid_output', error: 'Empty output' };

  return {
    ok: true,
    result: {
      title: parsed.title,
      body: typeof parsed.body === 'string' ? parsed.body : '',
      message: parsed.message ?? parsed.title,
      ...(typeof parsed.confidence === 'number' ? { confidence: parsed.confidence } : {}),
    },
  };
}
