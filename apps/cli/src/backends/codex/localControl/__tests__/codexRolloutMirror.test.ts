import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, appendFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRolloutMirror } from '../codexRolloutMirror';

type CodexBody = { type?: string; message?: string; callId?: string };
type SessionEvent = { type?: string; message?: string };
type CommittedAgentMessage = {
  provider: string;
  body: { type?: string; message?: string; text?: string; sidechainId?: string };
  localId: string;
  meta?: Record<string, unknown>;
};
type AgentBody = { type?: string; message?: string; text?: string; name?: string; callId?: string; sidechainId?: string; output?: unknown; input?: unknown };

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
  it('emits main rollout lifecycle events without turning them into transcript output', async () => {
    const lifecycleEvents: unknown[] = [];
    const codexBodies: CodexBody[] = [];
    const sessionEvents: SessionEvent[] = [];

    const mirror = new CodexRolloutMirror({
      filePath: '/tmp/codex-rollout-mirror-unused.jsonl',
      debug: true,
      onCodexSessionId: () => {},
      onTurnLifecycleEvent: (event) => {
        lifecycleEvents.push(event);
      },
      session: {
        sendUserTextMessage: () => {},
        sendCodexMessage: (body: unknown) => codexBodies.push(body as CodexBody),
        sendSessionEvent: (event: unknown) => sessionEvents.push(event as SessionEvent),
      } as any,
    });

    await (mirror as any).onJson({
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn_1' },
    });
    await (mirror as any).onJson({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn_1' },
    });
    await (mirror as any).onSubagentJson('child-thread', {
      type: 'event_msg',
      payload: { type: 'turn_aborted', turn_id: 'child_turn', reason: 'interrupted' },
    });

    expect(lifecycleEvents).toEqual([
      {
        type: 'turn_started',
        providerTurnId: 'turn_1',
        source: 'codex_rollout_task_started',
      },
      {
        type: 'turn_terminal',
        providerTurnId: 'turn_1',
        reason: 'completed',
        source: 'codex_rollout_task_complete',
      },
    ]);
    expect(codexBodies).toEqual([]);
    expect(sessionEvents).toEqual([]);
  });

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

  it('mirrors child rollout activity into a synthetic SubAgent sidechain', async () => {
    const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'codex-rollout-subagent-')));
    const parentDir = join(root, 'sessions', '2026', '03', '20');
    const parentThreadId = '019d0c2e-465b-7b80-a424-5c0e7f42c4e5';
    const childThreadId = '019d0c2e-711a-7b02-abbe-011b1da4d22e';
    const parentFilePath = join(parentDir, `rollout-2026-03-20T17-57-32-${parentThreadId}.jsonl`);
    const childFilePath = join(parentDir, `rollout-2026-03-20T17-57-43-${childThreadId}.jsonl`);
    await mkdir(parentDir, { recursive: true });
    await writeFile(parentFilePath, '', 'utf8');
    await writeFile(childFilePath, '', 'utf8');

    const codexSessionIds: string[] = [];
    const userTexts: string[] = [];
    const agentBodies: AgentBody[] = [];
    const committedMessages: CommittedAgentMessage[] = [];

    const mirror = new CodexRolloutMirror({
      filePath: parentFilePath,
      codexHome: root,
      debug: false,
      onCodexSessionId: (id) => {
        codexSessionIds.push(id);
      },
      session: {
        sendUserTextMessage: (text: string) => userTexts.push(text),
        sendCodexMessage: () => {},
        sendAgentMessage: (_provider: string, body: unknown) => {
          agentBodies.push(body as AgentBody);
        },
        sendAgentMessageCommitted: async (
          provider: string,
          body: unknown,
          opts: { localId: string; meta?: Record<string, unknown> },
        ) => {
          committedMessages.push({
            provider,
            body: body as { type?: string; message?: string; text?: string; sidechainId?: string },
            localId: opts.localId,
            meta: opts.meta,
          });
        },
        sendSessionEvent: () => {},
      } as any,
    });

    await mirror.start();
    try {
      await appendFile(
        parentFilePath,
        [
          JSON.stringify({ type: 'session_meta', payload: { id: 'sid' } }),
          JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'collab_agent_spawn_end',
              call_id: 'call_spawn',
              sender_thread_id: parentThreadId,
              new_thread_id: childThreadId,
              new_agent_nickname: 'Lovelace',
              new_agent_role: 'explorer',
              prompt: 'inspect the repo',
              status: 'pending_init',
            },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: `<subagent_notification>\n{\"agent_id\":\"${childThreadId}\",\"status\":{\"completed\":\"done\"}}\n</subagent_notification>`,
                },
              ],
            },
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      await appendFile(
        childFilePath,
        [
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'child summary' }] },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pwd"}', call_id: 'child_call_1' },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call_output', call_id: 'child_call_1', output: 'ok' },
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      await appendFile(
        parentFilePath,
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'collab_waiting_end',
            sender_thread_id: parentThreadId,
            call_id: 'call_wait',
            agent_statuses: [
              {
                thread_id: childThreadId,
                agent_nickname: 'Lovelace',
                agent_role: 'explorer',
                status: { completed: 'done' },
              },
            ],
          },
        }) + '\n',
        'utf8',
      );

      await waitFor(() => {
        expect(codexSessionIds).toEqual(['sid']);
        expect(agentBodies.some((body) => body.type === 'tool-call' && body.name === 'SubAgent' && body.callId === childThreadId)).toBe(true);
        expect(agentBodies.some((body) => body.type === 'tool-call' && body.name === 'Bash' && body.callId === 'child_call_1' && body.sidechainId === childThreadId)).toBe(true);
        expect(agentBodies.some((body) => body.type === 'tool-result' && body.callId === 'child_call_1' && body.sidechainId === childThreadId)).toBe(true);
        expect(agentBodies.some((body) => body.type === 'tool-result' && body.callId === childThreadId)).toBe(true);
      });
    } finally {
      await mirror.stop();
    }

    expect(userTexts).toEqual([]);
    expect(
      committedMessages.some(
        (message) =>
          message.provider === 'codex' &&
          message.body.type === 'message' &&
          message.body.message === 'child summary' &&
          message.body.sidechainId === childThreadId,
      ),
    ).toBe(true);
  });

  it('synthesizes a SubAgent sidechain from raw spawn_agent rollout plumbing when collab events are absent', async () => {
    const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'codex-rollout-raw-subagent-')));
    const parentDir = join(root, 'sessions', '2026', '03', '20');
    const parentThreadId = '019d0c76-8acc-7281-b2d6-ceead01514f8';
    const childThreadId = '019d0c76-df4c-7190-b58e-bf50cebf8afd';
    const parentFilePath = join(parentDir, `rollout-2026-03-20T19-16-28-${parentThreadId}.jsonl`);
    const childFilePath = join(parentDir, `rollout-2026-03-20T19-16-50-${childThreadId}.jsonl`);
    await mkdir(parentDir, { recursive: true });
    await writeFile(parentFilePath, '', 'utf8');
    await writeFile(childFilePath, '', 'utf8');

    const agentBodies: AgentBody[] = [];
    const committedMessages: CommittedAgentMessage[] = [];

    const mirror = new CodexRolloutMirror({
      filePath: parentFilePath,
      codexHome: root,
      debug: false,
      onCodexSessionId: () => {},
      session: {
        sendUserTextMessage: () => {},
        sendCodexMessage: () => {},
        sendAgentMessage: (_provider: string, body: unknown) => {
          agentBodies.push(body as AgentBody);
        },
        sendAgentMessageCommitted: async (
          provider: string,
          body: unknown,
          opts: { localId: string; meta?: Record<string, unknown> },
        ) => {
          committedMessages.push({
            provider,
            body: body as { type?: string; message?: string; text?: string; sidechainId?: string },
            localId: opts.localId,
            meta: opts.meta,
          });
        },
        sendSessionEvent: () => {},
      } as any,
    });

    await mirror.start();
    try {
      await appendFile(
        parentFilePath,
        [
          JSON.stringify({ type: 'session_meta', payload: { id: parentThreadId } }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'function_call',
              name: 'spawn_agent',
              arguments: JSON.stringify({
                agent_type: 'default',
                message: 'Read README.md and summarize it',
              }),
              call_id: 'call_spawn_1',
            },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'call_spawn_1',
              output: JSON.stringify({
                agent_id: childThreadId,
                nickname: 'Bacon',
              }),
            },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: `<subagent_notification>\n{"agent_id":"${childThreadId}","status":{"completed":"done"}}\n</subagent_notification>`,
                },
              ],
            },
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      await appendFile(
        childFilePath,
        [
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'child summary' }] },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pwd"}', call_id: 'child_call_1' },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call_output', call_id: 'child_call_1', output: 'ok' },
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      await waitFor(() => {
        expect(agentBodies.some((body) => body.type === 'tool-call' && body.name === 'SubAgent' && body.callId === childThreadId)).toBe(true);
        expect(agentBodies.some((body) => body.type === 'tool-call' && body.name === 'Bash' && body.callId === 'child_call_1' && body.sidechainId === childThreadId)).toBe(true);
        expect(agentBodies.some((body) => body.type === 'tool-result' && body.callId === childThreadId)).toBe(true);
      });
    } finally {
      await mirror.stop();
    }

    expect(
      committedMessages.some(
        (message) =>
          message.provider === 'codex' &&
          message.body.type === 'message' &&
          message.body.message === 'child summary' &&
          message.body.sidechainId === childThreadId,
      ),
    ).toBe(true);
  });
});
