import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRolloutMirror } from '../codexRolloutMirror';

type CodexBody = { type?: string; message?: string; callId?: string };
type SessionEvent = { type?: string; message?: string };
type CommittedAgentMessage = {
  provider: string;
  body: { type?: string; message?: string; text?: string };
  localId: string;
  meta?: Record<string, unknown>;
};

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
    const userTexts: string[] = [];
    const codexBodies: CodexBody[] = [];
    const sessionEvents: SessionEvent[] = [];
    const codexSessionIds: string[] = [];
    const committedMessages: CommittedAgentMessage[] = [];

    const mirror = new CodexRolloutMirror({
      filePath: '/tmp/codex-rollout-mirror-unused.jsonl',
      debug: false,
      onCodexSessionId: (id) => {
        codexSessionIds.push(id);
      },
      session: {
        sendUserTextMessage: (text: string) => userTexts.push(text),
        sendCodexMessage: (body: unknown) => codexBodies.push(body as CodexBody),
        sendAgentMessageCommitted: async (
          provider: string,
          body: unknown,
          opts: { localId: string; meta?: Record<string, unknown> },
        ) => {
          committedMessages.push({
            provider,
            body: body as { type?: string; message?: string; text?: string },
            localId: opts.localId,
            meta: opts.meta,
          });
        },
        sendTranscriptDraftDelta: () => {},
        sendSessionEvent: (event: unknown) => sessionEvents.push(event as SessionEvent),
      } as any,
    });

    await (mirror as any).onJson({ type: 'session_meta', payload: { id: 'sid' } });
    await (mirror as any).onJson({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    });
    await (mirror as any).onJson({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    });
    await (mirror as any).onJson({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ' there' }] },
    });
    await (mirror as any).onJson({
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"echo hi"}', call_id: 'call_1' },
    });
    await (mirror as any).onJson({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    });

    expect(codexSessionIds).toEqual(['sid']);
    expect(userTexts).toEqual(['hello']);
    expect(committedMessages.some((m) => m.provider === 'codex' && m.body.type === 'message' && m.body.message === 'hi')).toBe(true);
    expect(committedMessages.some((m) => m.provider === 'codex' && m.body.type === 'message' && m.body.message === 'hi there')).toBe(true);
    const segmentLocalIds = committedMessages
      .filter((m) => m.body.type === 'message')
      .map((m) => ((m.meta?.happierStreamSegmentV1 as { segmentLocalId?: string } | undefined)?.segmentLocalId ?? null))
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    expect(new Set(segmentLocalIds).size).toBe(1);
    expect(codexBodies.some((b) => b.type === 'tool-call' && b.callId === 'call_1')).toBe(true);
    expect(codexBodies.some((b) => b.type === 'tool-call-result' && b.callId === 'call_1')).toBe(true);
    expect(sessionEvents).toEqual([]);
  });

  it('awaits codexSessionId publishing before processing later rollout lines', async () => {
    const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'codex-rollout-mirror-')));
    const filePath = join(root, 'rollout.jsonl');
    await writeFile(
      filePath,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'sid' } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', name: 'exec_command', arguments: '{\"cmd\":\"echo hi\"}', call_id: 'call_1' },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const codexBodies: CodexBody[] = [];
    let resolvePublish!: () => void;
    const publishPromise = new Promise<void>((resolve) => {
      resolvePublish = resolve;
    });

    const mirror = new CodexRolloutMirror({
      filePath,
      debug: false,
      onCodexSessionId: async () => {
        await publishPromise;
      },
      session: {
        sendUserTextMessage: () => {},
        sendCodexMessage: (body: unknown) => codexBodies.push(body as CodexBody),
        sendSessionEvent: () => {},
      } as any,
    });

    const startPromise = mirror.start();
    try {
      // Mirror should not process subsequent lines until codexSessionId publishing completes.
      expect(codexBodies.some((b) => b.type === 'tool-call')).toBe(false);

      resolvePublish();

      await startPromise;
      await waitFor(() => {
        expect(codexBodies.some((b) => b.type === 'tool-call' && b.callId === 'call_1')).toBe(true);
      });
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
    const committedMessages: CommittedAgentMessage[] = [];

    const mirror = new CodexRolloutMirror({
      filePath,
      debug: false,
      onCodexSessionId: (id) => {
        codexSessionIds.push(id);
      },
      session: {
        sendUserTextMessage: () => {},
        sendCodexMessage: (body: unknown) => codexBodies.push(body as CodexBody),
        sendAgentMessageCommitted: async (provider: string, body: unknown, opts: { localId: string }) => {
          committedMessages.push({
            provider,
            body: body as { type?: string; message?: string; text?: string },
            localId: opts.localId,
          });
        },
        sendTranscriptDraftDelta: () => {},
        sendSessionEvent: () => {},
      } as any,
    });

    await mirror.start();
    try {
      await waitFor(() => {
        expect(codexSessionIds).toEqual(['sid']);
        expect(committedMessages.some((m) => m.provider === 'codex' && m.body.type === 'message' && m.body.message === 'hello-before')).toBe(true);
      });
    } finally {
      await mirror.stop();
    }
  });
});
