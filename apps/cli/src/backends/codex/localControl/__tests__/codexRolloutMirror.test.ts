import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRolloutMirror } from '../codexRolloutMirror';

type CodexBody = { type?: string; message?: string; callId?: string };
type SessionEvent = { type?: string; message?: string };

const tempDirs = new Set<string>();

function rememberTempDir(path: string): string {
  tempDirs.add(path);
  return path;
}

async function waitFor(assertion: () => void, timeoutMs = 5_000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('CodexRolloutMirror', () => {
  it('emits user + assistant messages and tool calls/results', async () => {
    const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'codex-rollout-mirror-')));
    const filePath = join(root, 'rollout.jsonl');
    await writeFile(filePath, '');

    const userTexts: string[] = [];
    const codexBodies: CodexBody[] = [];
    const sessionEvents: SessionEvent[] = [];
    const codexSessionIds: string[] = [];

    const mirror = new CodexRolloutMirror({
      filePath,
      debug: false,
      onCodexSessionId: (id) => codexSessionIds.push(id),
      session: {
        sendUserTextMessage: (text: string) => userTexts.push(text),
        sendCodexMessage: (body: unknown) => codexBodies.push(body as CodexBody),
        sendSessionEvent: (event: unknown) => sessionEvents.push(event as SessionEvent),
      } as any,
    });

    await mirror.start();
    try {
      await appendFile(filePath, `${JSON.stringify({ type: 'session_meta', payload: { id: 'sid' } })}\n`);
      await appendFile(
        filePath,
        `${JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        })}\n`,
      );
      await appendFile(
        filePath,
        `${JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
        })}\n`,
      );
      await appendFile(
        filePath,
        `${JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', name: 'exec_command', arguments: '{\"cmd\":\"echo hi\"}', call_id: 'call_1' },
        })}\n`,
      );
      await appendFile(
        filePath,
        `${JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
        })}\n`,
      );

      await waitFor(() => {
        expect(codexSessionIds).toEqual(['sid']);
        expect(userTexts).toEqual(['hello']);
        expect(codexBodies.some((b) => b.type === 'message' && b.message === 'hi')).toBe(true);
        expect(codexBodies.some((b) => b.type === 'tool-call' && b.callId === 'call_1')).toBe(true);
        expect(codexBodies.some((b) => b.type === 'tool-call-result' && b.callId === 'call_1')).toBe(true);
      });
      expect(sessionEvents).toEqual([]);
    } finally {
      await mirror.stop();
    }
  });

  it('replays existing JSONL content when starting after lines already exist', async () => {
    const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'codex-rollout-mirror-')));
    const filePath = join(root, 'rollout.jsonl');

    await writeFile(
      filePath,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'sid' } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello-before' }] },
        }),
      ].join('\n') + '\n',
    );

    const codexSessionIds: string[] = [];
    const codexBodies: CodexBody[] = [];

    const mirror = new CodexRolloutMirror({
      filePath,
      debug: false,
      onCodexSessionId: (id) => codexSessionIds.push(id),
      session: {
        sendUserTextMessage: () => {},
        sendCodexMessage: (body: unknown) => codexBodies.push(body as CodexBody),
        sendSessionEvent: () => {},
      } as any,
    });

    await mirror.start();
    try {
      await waitFor(() => {
        expect(codexSessionIds).toEqual(['sid']);
        expect(codexBodies.some((b) => b.type === 'message' && b.message === 'hello-before')).toBe(true);
      });
    } finally {
      await mirror.stop();
    }
  });
});
