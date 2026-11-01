import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, appendFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRolloutMirror } from '../codexRolloutMirror';
import {
  DeferredApiSessionClient,
  type DeferredApiSessionTarget,
} from '@/agent/runtime/startup/DeferredApiSessionClient';
import type { ApiSessionClient } from '@/api/session/sessionClient';

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

async function runMirrorProcess(params: Readonly<{
  filePath: string;
  session: unknown;
}>): Promise<void> {
  const mirror = new CodexRolloutMirror({
    filePath: params.filePath,
    debug: false,
    onCodexSessionId: () => {},
    session: params.session as any,
  });
  await mirror.start();
  await mirror.stop();
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('CodexRolloutMirror', () => {
  it('replays reasoning summaries as separate thinking messages before the assistant answer', async () => {
    const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'codex-rollout-reasoning-')));
    const filePath = join(root, 'rollout.jsonl');
    await writeFile(filePath, [
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'First check' }], encrypted_content: 'opaque-private-reasoning' } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Second check' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    const rows = new Map<string, AgentBody>();
    await runMirrorProcess({ filePath, session: {
      sendAgentMessageCommitted: async (_provider: string, body: AgentBody, opts: { localId: string }) => {
        rows.set(opts.localId, body);
      },
      sendCodexMessage: () => {}, sendSessionEvent: () => {},
    } });
    const bodies = [...rows.values()];
    const thinking = bodies.filter(body => body.type === 'thinking');
    expect(thinking.map(body => body.text)).toEqual(['First check', 'Second check']);
    expect(bodies.filter(body => body.type === 'message').map(body => body.message)).toEqual(['answer']);
    expect(bodies.indexOf(thinking[1]!)).toBeLessThan(bodies.findIndex(body => body.type === 'message'));
    expect(JSON.stringify(bodies)).not.toContain('opaque-private-reasoning');
  });

  it('replays a rollout user message through the fast-start deferred session boundary', async () => {
    const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'codex-rollout-deferred-')));
    const filePath = join(root, 'rollout.jsonl');
    await writeFile(filePath, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex-session-1' } }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi from the terminal' }],
        },
      }),
      '',
    ].join('\n'), 'utf8');

    const committedUserMessages: Array<{ text: string; localId: string }> = [];
    const deferred = new DeferredApiSessionClient({
      placeholderSessionId: 'PID-deferred-rollout',
      limits: { maxEntries: 20, maxBytes: 20_000 },
    });
    await deferred.attach({
      sessionId: 'happier-session-1',
      rpcHandlerManager: { registerHandler: () => {}, invokeLocal: async () => ({}) },
      sendUserTextMessageCommitted: async (text: string, opts: { localId: string }) => {
        committedUserMessages.push({ text, localId: opts.localId });
      },
    } as unknown as DeferredApiSessionTarget);

    const mirror = new CodexRolloutMirror({
      filePath,
      debug: false,
      onCodexSessionId: () => {},
      session: deferred as unknown as ApiSessionClient,
    });
    try {
      await mirror.start();
    } finally {
      await mirror.stop();
    }

    expect(committedUserMessages).toEqual([
      {
        text: 'hi from the terminal',
        localId: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
  });

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

  it('awaits exact commits for root compaction markers and reuses their rollout source identity', async () => {
    const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'codex-rollout-compaction-')));
    const filePath = join(root, 'rollout.jsonl');
    const compactionLine = {
      type: 'event_msg',
      payload: { type: 'context_compacted', turn_id: 'turn_compact' },
    };
    await writeFile(filePath, `${JSON.stringify(compactionLine)}\n`, 'utf8');
    const rolloutStats = await stat(filePath);

    const bestEffortSessionEvents: SessionEvent[] = [];
    const committedSessionEvents: Array<{
      event: SessionEvent;
      localId: string;
    }> = [];
    let releaseFirstCommit!: () => void;
    const firstCommit = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve;
    });

    const mirror = new CodexRolloutMirror({
      filePath,
      debug: false,
      onCodexSessionId: () => {},
      session: {
        sendUserTextMessage: () => {},
        sendCodexMessage: () => {},
        sendSessionEvent: (event: unknown) => bestEffortSessionEvents.push(event as SessionEvent),
        sendSessionEventCommitted: async (event: unknown, opts: { localId: string }) => {
          committedSessionEvents.push({ event: event as SessionEvent, localId: opts.localId });
          if (committedSessionEvents.length === 1) {
            await firstCommit;
            return { localId: opts.localId, didWrite: true };
          }
          return { localId: opts.localId, didWrite: false };
        },
      } as any,
    });

    let startSettled = false;
    const startPromise = mirror.start().finally(() => {
      startSettled = true;
    });
    try {
      await waitFor(() => {
        expect(committedSessionEvents).toHaveLength(1);
      });
      expect(startSettled).toBe(false);

      releaseFirstCommit();
      await startPromise;

      await (mirror as any).onJson(compactionLine, {
        lineStartOffsetBytes: 0,
        fileIdentity: { dev: rolloutStats.dev, ino: rolloutStats.ino },
      });
    } finally {
      releaseFirstCommit();
      await startPromise.catch(() => undefined);
      await mirror.stop();
    }

    expect(bestEffortSessionEvents).toEqual([]);
    expect(committedSessionEvents).toHaveLength(2);
    expect(committedSessionEvents[0]?.localId).toBe(committedSessionEvents[1]?.localId);
    expect(committedSessionEvents[0]?.localId).toMatch(/^[a-f0-9]{64}$/);
    expect(committedSessionEvents.map(({ event }) => event)).toEqual(
      Array.from({ length: 2 }, () => expect.objectContaining({
          type: 'context-compaction',
          phase: 'completed',
          lifecycleId: 'codex:context-compaction:turn_compact',
          provider: 'codex',
          source: 'provider-event',
          providerEventId: 'turn_compact',
      })),
    );
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
        sendCodexMessageCommitted: async (body: unknown) => {
          codexBodies.push(body as CodexBody);
        },
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
          agentBodies.push(body as AgentBody);
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
            payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'child reasoning' }] },
          }),
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
        expect(agentBodies.some((body) => body.type === 'thinking' && body.text === 'child reasoning' && body.sidechainId === childThreadId)).toBe(true);
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
          agentBodies.push(body as AgentBody);
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

  it('reuses the acknowledged source identity after a crash between one line effect and cursor commit', async () => {
    const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'codex-rollout-effect-recovery-')));
    const filePath = join(root, 'rollout.jsonl');
    await writeFile(
      filePath,
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"pwd"}',
          call_id: 'call_process_loss',
        },
      }) + '\n',
      'utf8',
    );

    const attempts: string[] = [];
    const acknowledged = new Set<string>();
    let crashAfterFirstAcknowledgement = true;
    const acknowledge = (identity: string | undefined): void => {
      const effectiveIdentity = identity ?? `unacknowledged-${attempts.length}`;
      attempts.push(effectiveIdentity);
      acknowledged.add(effectiveIdentity);
      if (crashAfterFirstAcknowledgement) {
        crashAfterFirstAcknowledgement = false;
        throw new Error('simulated process loss after effect acknowledgement');
      }
    };
    const session = {
      sendUserTextMessage: () => {},
      sendCodexMessage: () => acknowledge(undefined),
      sendCodexMessageCommitted: async (_body: unknown, opts: { localId: string }) => acknowledge(opts.localId),
      sendAgentMessage: (_provider: string, _body: unknown, opts?: { localId?: string }) => acknowledge(opts?.localId),
      sendAgentMessageCommitted: async (_provider: string, _body: unknown, opts: { localId: string }) => acknowledge(opts.localId),
      sendSessionEvent: () => {},
    };

    await runMirrorProcess({ filePath, session });
    await runMirrorProcess({ filePath, session });
    const attemptsAfterRecovery = attempts.length;
    await runMirrorProcess({ filePath, session });

    expect(new Set(attempts)).toEqual(new Set([attempts[0]!]));
    expect(acknowledged.size).toBe(1);
    expect(attempts).toHaveLength(3);
    expect(attempts.length).toBe(attemptsAfterRecovery + 1);
  });

  it('replays a consumed multi-effect line until every deterministic source identity is acknowledged', async () => {
    const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'codex-rollout-multi-effect-recovery-')));
    const filePath = join(root, 'rollout.jsonl');
    await writeFile(
      filePath,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'collab_waiting_end',
          agent_statuses: [
            { thread_id: 'child-one', status: { completed: 'first result' } },
            { thread_id: 'child-two', status: { completed: 'second result' } },
          ],
        },
      }) + '\n',
      'utf8',
    );

    const attempts: string[] = [];
    const acknowledged = new Set<string>();
    let crashBeforeThirdEffect = true;
    const acknowledge = (identity: string | undefined): void => {
      const effectiveIdentity = identity ?? `unacknowledged-${attempts.length}`;
      attempts.push(effectiveIdentity);
      if (crashBeforeThirdEffect && attempts.length === 3) {
        crashBeforeThirdEffect = false;
        throw new Error('simulated process loss after read cursor intent but before all line effects');
      }
      acknowledged.add(effectiveIdentity);
    };
    const session = {
      sendUserTextMessage: () => {},
      sendCodexMessage: () => acknowledge(undefined),
      sendCodexMessageCommitted: async (_body: unknown, opts: { localId: string }) => acknowledge(opts.localId),
      sendAgentMessage: (_provider: string, _body: unknown, opts?: { localId?: string }) => acknowledge(opts?.localId),
      sendAgentMessageCommitted: async (_provider: string, _body: unknown, opts: { localId: string }) => acknowledge(opts.localId),
      sendSessionEvent: () => {},
    };

    await runMirrorProcess({ filePath, session });
    await runMirrorProcess({ filePath, session });
    const attemptsAfterRecovery = attempts.length;
    await runMirrorProcess({ filePath, session });

    expect(attempts[3]).toBe(attempts[0]);
    expect(attempts[4]).toBe(attempts[1]);
    expect(attempts[5]).toBe(attempts[2]);
    expect(new Set(attempts.slice(7))).toEqual(acknowledged);
    expect(acknowledged.size).toBe(4);
    expect(attempts).toHaveLength(11);
    expect(attempts.length).toBe(attemptsAfterRecovery + 4);
  });

  it('redrives inferred subagent completion state after the completion effect rejects', async () => {
    const childThreadId = 'child-retry-after-rejection';
    const attempts: Array<{ type?: string; localId: string }> = [];
    let rejectCompletion = true;
    const mirror = new CodexRolloutMirror({
      filePath: '/tmp/codex-rollout-mirror-unused.jsonl',
      debug: false,
      onCodexSessionId: () => {},
      session: {
        sendUserTextMessage: () => {},
        sendCodexMessage: () => {},
        sendAgentMessageCommitted: async (
          _provider: string,
          body: { type?: string },
          opts: { localId: string },
        ) => {
          attempts.push({ type: body.type, localId: opts.localId });
          if (body.type === 'tool-result' && rejectCompletion) {
            rejectCompletion = false;
            throw new Error('subagent completion was not acknowledged');
          }
        },
        sendSessionEvent: () => {},
      } as any,
    });
    const completionLine = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: `<subagent_notification>\n{"agent_id":"${childThreadId}","status":{"completed":"done"}}\n</subagent_notification>`,
        }],
      },
    };
    const source = {
      lineStartOffsetBytes: 42,
      fileIdentity: { dev: 7, ino: 11 },
    };

    await expect((mirror as any).onJson(completionLine, source)).rejects.toThrow(
      'subagent completion was not acknowledged',
    );
    await expect((mirror as any).onJson(completionLine, source)).resolves.toBeUndefined();

    expect(attempts.map(({ type }) => type)).toEqual([
      'tool-call',
      'tool-result',
      'tool-result',
    ]);
    expect(attempts[1]?.localId).toBe(attempts[2]?.localId);
    await mirror.stop();
  });

  it('redrives a rejected subagent start from the same live rollout row', async () => {
    const root = rememberTempDir(await mkdtemp(join(tmpdir(), 'codex-rollout-subagent-start-rejection-')));
    const filePath = join(root, 'rollout.jsonl');
    const childThreadId = 'child-retry-start-after-rejection';
    await writeFile(
      filePath,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'collab_agent_spawn_end',
          call_id: 'call_spawn_retry',
          sender_thread_id: 'parent-thread',
          new_thread_id: childThreadId,
          new_agent_nickname: 'Retry',
          new_agent_role: 'explorer',
          prompt: 'retry this start',
          status: 'pending_init',
        },
      }) + '\n',
      'utf8',
    );

    const attempts: string[] = [];
    let rejectFirstStart = true;
    const mirror = new CodexRolloutMirror({
      filePath,
      debug: false,
      onCodexSessionId: () => {},
      session: {
        sendUserTextMessage: () => {},
        sendCodexMessage: () => {},
        sendAgentMessageCommitted: async (
          _provider: string,
          body: { type?: string; callId?: string },
          opts: { localId: string },
        ) => {
          if (body.type !== 'tool-call' || body.callId !== childThreadId) return;
          attempts.push(opts.localId);
          if (rejectFirstStart) {
            rejectFirstStart = false;
            throw new Error('subagent start was not acknowledged');
          }
        },
        sendSessionEvent: () => {},
        // Narrow session-boundary fixture: this regression exercises only committed subagent starts.
      } as any,
    });

    try {
      await mirror.start();
      await waitFor(() => {
        expect(attempts).toHaveLength(2);
      });
      expect(attempts[0]).toBe(attempts[1]);
    } finally {
      await mirror.stop();
    }
  });

  it('shares an in-flight subagent start acknowledgement across concurrent observations', async () => {
    const childThreadId = 'child-concurrent-start';
    const spawnLine = {
      type: 'event_msg',
      payload: {
        type: 'collab_agent_spawn_end',
        call_id: 'call_spawn_concurrent',
        sender_thread_id: 'parent-thread',
        new_thread_id: childThreadId,
        status: 'pending_init',
      },
    };
    let releaseStart!: () => void;
    const startAcknowledgement = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const attempts: string[] = [];
    const mirror = new CodexRolloutMirror({
      filePath: '/tmp/codex-rollout-mirror-unused.jsonl',
      debug: false,
      onCodexSessionId: () => {},
      session: {
        sendUserTextMessage: () => {},
        sendCodexMessage: () => {},
        sendAgentMessageCommitted: async (
          _provider: string,
          body: { type?: string; callId?: string },
          opts: { localId: string },
        ) => {
          if (body.type !== 'tool-call' || body.callId !== childThreadId) return;
          attempts.push(opts.localId);
          await startAcknowledgement;
        },
        sendSessionEvent: () => {},
        // Narrow session-boundary fixture: this concurrency check exercises only committed subagent starts.
      } as any,
    });

    const first = (mirror as any).onJson(spawnLine, {
      lineStartOffsetBytes: 10,
      fileIdentity: { dev: 7, ino: 11 },
    });
    await waitFor(() => {
      expect(attempts).toHaveLength(1);
    });
    let secondSettled = false;
    const second = (mirror as any).onJson(spawnLine, {
      lineStartOffsetBytes: 20,
      fileIdentity: { dev: 7, ino: 11 },
    }).finally(() => {
      secondSettled = true;
    });

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(secondSettled).toBe(false);
      expect(attempts).toHaveLength(1);
      releaseStart();
      await Promise.all([first, second]);
      expect(attempts).toHaveLength(1);
    } finally {
      releaseStart();
      await Promise.allSettled([first, second]);
      await mirror.stop();
    }
  });
});
