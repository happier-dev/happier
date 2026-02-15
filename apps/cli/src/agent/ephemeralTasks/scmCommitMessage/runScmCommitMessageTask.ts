import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';

import { buildCommitMessagePrompt } from './buildCommitMessagePrompt';
import { loadScmCommitMessageContext } from './loadScmCommitMessageContext';
import { parseCommitMessageModelOutput } from './parseCommitMessageModelOutput';

async function runOneShotBackend(params: Readonly<{
  backend: AgentBackend;
  prompt: string;
}>): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let buffer = '';
  const onMessage: AgentMessageHandler = (msg) => {
    if (msg.type !== 'model-output') return;
    const anyMsg = msg as any as AgentMessage;
    if (typeof (anyMsg as any).fullText === 'string') {
      buffer = String((anyMsg as any).fullText);
    } else if (typeof (anyMsg as any).textDelta === 'string') {
      buffer += String((anyMsg as any).textDelta);
    }
  };

  params.backend.onMessage(onMessage);

  try {
    const started = await params.backend.startSession();
    const childSessionId: SessionId = started.sessionId;
    await params.backend.sendPrompt(childSessionId, params.prompt);
    if (params.backend.waitForResponseComplete) {
      await params.backend.waitForResponseComplete();
    }
    return { ok: true, text: buffer.trim() };
  } catch (e: any) {
    return { ok: false, error: e instanceof Error ? e.message : 'Task failed' };
  } finally {
    try {
      await params.backend.dispose();
    } catch {
      // ignore
    }
  }
}

export async function runScmCommitMessageTask(params: Readonly<{
  workingDirectory: string;
  createBackend: () => AgentBackend;
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
