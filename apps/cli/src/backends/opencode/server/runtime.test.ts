import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createOpenCodeServerRuntime } from './runtime';
import type { OpenCodeGlobalEvent } from './types';

function createFakeClient() {
  let onEvent: ((evt: OpenCodeGlobalEvent) => void) | null = null;
  let directoryOverride: string | null = null;
  return {
    sessionCreate: vi.fn(async () => ({ id: 'ses_1' })),
    sessionGet: vi.fn(async ({ sessionId }: { sessionId: string }) => ({ id: sessionId })),
    sessionMessagesList: vi.fn(async () => ([] as unknown[])),
    sessionPromptAsync: vi.fn(async () => {}),
    sessionAbort: vi.fn(async () => {}),
    sessionFork: vi.fn(async () => ({ id: 'ses_fork' })),
    setDirectoryOverride: vi.fn((next: string) => {
      directoryOverride = next;
    }),
    globalConfigGet: vi.fn(async () => ({ model: 'openai/gpt-5.2' })),
    agentsList: vi.fn(async () => ([{ name: 'build', description: 'Build agent' }])),
    providersList: vi.fn(async () => ([
      {
        id: 'openai',
        env: ['OPENAI_API_KEY'],
        models: {
          'gpt-5.2': { id: 'gpt-5.2', name: 'GPT-5.2', status: 'active', capabilities: { toolcall: true, input: { text: true } } },
        },
      },
    ])),
    questionReply: vi.fn(async () => true),
    questionReject: vi.fn(async () => true),
    questionList: vi.fn(async () => ([] as unknown[])),
    permissionReply: vi.fn(async () => true),
    permissionList: vi.fn(async () => ([] as unknown[])),
    subscribeGlobalEvents: vi.fn(async ({ onEvent: cb }: { onEvent: (evt: OpenCodeGlobalEvent) => void }) => {
      onEvent = cb;
    }),
    dispose: vi.fn(async () => {}),
    __emit: (evt: OpenCodeGlobalEvent) => onEvent?.(evt),
    __getDirectoryOverride: () => directoryOverride,
  };
}

function createFakeSession() {
  const meta: Record<string, unknown> = {};
  let lastSeq = 0;
  return {
    keepAlive: vi.fn(),
    sendAgentMessage: vi.fn(),
    sendUserTextMessageCommitted: vi.fn(async () => {}),
    sendAgentMessageCommitted: vi.fn(async () => {}),
    ensureMetadataSnapshot: vi.fn(async () => ({ ok: true })),
    getMetadataSnapshot: () => meta,
    updateMetadata: vi.fn(async (updater: (prev: any) => any) => {
      const next = updater(meta);
      Object.keys(meta).forEach((k) => delete meta[k]);
      Object.assign(meta, next);
    }),
    getLastObservedMessageSeq: () => lastSeq,
    __setLastObservedMessageSeq: (value: number) => {
      lastSeq = value;
    },
    __getMetadata: () => meta,
  } as any;
}

describe('createOpenCodeServerRuntime', () => {
  it('publishes session mode/model lists into metadata on start (best-effort)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    await expect.poll(() => session.updateMetadata.mock.calls.length).toBeGreaterThan(0);
    const metadata = session.__getMetadata();
    expect(metadata).toMatchObject({
      acpSessionModesV1: expect.objectContaining({
        v: 1,
        provider: 'opencode',
        currentModeId: 'build',
        availableModes: [expect.objectContaining({ id: 'build' })],
      }),
      acpSessionModelsV1: expect.objectContaining({
        v: 1,
        provider: 'opencode',
        currentModelId: 'openai/gpt-5.2',
        availableModels: [expect.objectContaining({ id: 'openai/gpt-5.2' })],
      }),
    });
  });

  it('applies the OpenCode session directory on resume (uses sessionGet.directory)', async () => {
    const client = createFakeClient() as any;
    client.sessionGet = vi.fn(async ({ sessionId }: { sessionId: string }) => ({ id: sessionId, directory: '/correct' }));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/wrong',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });
    expect(client.setDirectoryOverride).toHaveBeenCalledWith('/correct');
    expect(client.__getDirectoryOverride()).toBe('/correct');
  });

  it('applies the OpenCode session directory after sessionCreate when available', async () => {
    const client = createFakeClient() as any;
    client.sessionCreate = vi.fn(async () => ({ id: 'ses_1', directory: '/created' }));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/fallback',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    expect(client.setDirectoryOverride).toHaveBeenCalledWith('/created');
    expect(client.__getDirectoryOverride()).toBe('/created');
  });

  it('sends prompt_async with a stable OpenCode-style messageID when localId is provided and waits for session.idle', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    await runtime.setSessionMode('build');
    await runtime.setSessionModel('openai/gpt-5.2');
    await runtime.setSessionConfigOption('telemetry', true);
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-1' });

    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      sessionId: 'ses_1',
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5.2' },
      config: { telemetry: true },
      parts: [{ type: 'text', text: 'hello' }],
    });
    expect(firstCall.messageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(session.__getMetadata()?.opencodeUserMessageIdMapV1?.byLocalId?.['local-1']).toBe(firstCall.messageId);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('does not resolve a turn on a stale idle event that arrived before prompt_async', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    // Stale idle seen before prompt_async should not cause immediate resolution once we start the turn.
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-stale-idle' });

    const early = await Promise.race([
      promptPromise.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => {
        const timer = setTimeout(() => resolve('pending'), 25);
        timer.unref?.();
      }),
    ]);
    expect(early).toBe('pending');

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('does not resolve a turn on session.idle until some provider activity is observed after prompt_async', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-idle-before-activity' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    const early = await Promise.race([
      promptPromise.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => {
        const timer = setTimeout(() => resolve('pending'), 25);
        timer.unref?.();
      }),
    ]);
    expect(early).toBe('pending');

    // Once we see provider activity, an idle signal can complete the turn.
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('does not treat session.status busy as sufficient activity to resolve a turn on idle', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-busy-only' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    const early = await Promise.race([
      promptPromise.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => {
        const timer = setTimeout(() => resolve('pending'), 250);
        timer.unref?.();
      }),
    ]);
    expect(early).toBe('pending');

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('ignores message.part updates for messages that existed before the turn (prevents stale event replays from resolving turns)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    client.sessionMessagesList.mockResolvedValueOnce([
      { info: { id: 'msg_old_user', role: 'user', sessionID: 'ses_1', time: { created: 1 } }, parts: [{ type: 'text', text: 'old' }] },
      { info: { id: 'msg_old_asst', role: 'assistant', sessionID: 'ses_1', time: { created: 2 } }, parts: [{ type: 'text', text: 'old' }] },
    ]);

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-stale-replay' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    // Simulate an event replay for an older assistant message arriving during the new turn.
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_old', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_old_asst', partID: 'part_old', delta: 'OLD' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    const early = await Promise.race([
      promptPromise.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => {
        const timer = setTimeout(() => resolve('pending'), 250);
        timer.unref?.();
      }),
    ]);
    expect(early).toBe('pending');

    // Now emit a new assistant delta for a message created during this turn.
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_new', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_new_asst', partID: 'part_new', delta: 'NEW' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('maps question.asked into AskUserQuestion and replies via question.reply', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved', answers: { q1: 'a, b' } })),
    };

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'que_1',
          sessionID: 'ses_1',
          questions: [
            {
              question: 'q1',
              header: 'Q1',
              options: [
                { label: 'a', description: 'A' },
                { label: 'b', description: 'B' },
              ],
              multiple: true,
            },
          ],
        },
      },
    });

    await expect.poll(() => client.questionReply.mock.calls.length).toBe(1);

    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'que_1',
      'AskUserQuestion',
      expect.objectContaining({
        questions: [
          expect.objectContaining({ question: 'q1', header: 'Q1', multiSelect: true }),
        ],
      }),
    );

    expect(client.questionReply).toHaveBeenCalledWith({ requestId: 'que_1', answers: [['a', 'b']] });
    expect(session.sendAgentMessage).toHaveBeenCalledWith(
      'opencode',
      expect.objectContaining({ type: 'tool-result', callId: 'que_1' }),
    );
  });

  it('does not double-handle questions when question.asked arrives and the control-plane poll also sees it', async () => {
    const client = createFakeClient() as any;
    const session = createFakeSession();
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved', answers: { q1: 'deep' } })),
    };

    client.questionList = vi.fn(async () => ([
      {
        id: 'que_1',
        sessionID: 'ses_1',
        questions: [
          { question: 'q1', header: 'Q1', options: [{ label: 'deep', description: 'Deep' }], multiple: false },
        ],
      },
    ]));

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    client.sessionPromptAsync = vi.fn(async () => {
      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'question.asked',
          properties: {
            id: 'que_1',
            sessionID: 'ses_1',
            questions: [{ question: 'q1', header: 'Q1', options: [{ label: 'deep', description: 'Deep' }], multiple: false }],
          },
        },
      });
    });

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-q-dedupe' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(promptPromise).resolves.toBeUndefined();

    expect(permissionHandler.handleToolCall).toHaveBeenCalledTimes(1);
    expect(client.questionReply).toHaveBeenCalledTimes(1);
  });

  it('dedupes cumulative text deltas and streams with a stable happierStreamKey per OpenCode message', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-dedupe' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'Hello' },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'Hello.' },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'Hello.' },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(promptPromise).resolves.toBeUndefined();

    const messageCalls: Array<{ message: string; streamKey: string | undefined }> = session.sendAgentMessage.mock.calls
      .filter((call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'message')
      .map((call: any[]) => ({
        message: call[1]?.message,
        streamKey: call[2]?.meta?.happierStreamKey,
      }));

    expect(messageCalls.map((c) => c.message)).toEqual(['Hello', '.']);
    expect(messageCalls[0]?.streamKey).toBeTruthy();
    expect(messageCalls[1]?.streamKey).toBe(messageCalls[0]?.streamKey);
  });

  it('does not mix streaming keys across different OpenCode messageIDs in the same turn', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-multi-msg' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'A' },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', messageID: 'msg_asst_2', partID: 'part_1', delta: 'B' },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(promptPromise).resolves.toBeUndefined();

    const messageCalls: Array<{ message: string; streamKey: string | undefined }> = session.sendAgentMessage.mock.calls
      .filter((call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'message')
      .map((call: any[]) => ({
        message: call[1]?.message,
        streamKey: call[2]?.meta?.happierStreamKey,
      }))
      .filter((c: { message: string; streamKey: string | undefined }) => c.message === 'A' || c.message === 'B');

    expect(messageCalls).toHaveLength(2);
    expect(messageCalls[0]?.streamKey).toBeTruthy();
    expect(messageCalls[1]?.streamKey).toBeTruthy();
    expect(messageCalls[1]?.streamKey).not.toBe(messageCalls[0]?.streamKey);
  });

  it('dedupes repeated cumulative text deltas across partIDs for the same OpenCode messageID', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-dedupe-partids' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'OK' },
      },
    });

    // Some OpenCode builds can emit the same cumulative text again under a different partID.
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: { part: { id: 'part_2', type: 'text', sessionID: 'ses_1' } },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_2', delta: 'OK' },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(promptPromise).resolves.toBeUndefined();

    const deltas = session.sendAgentMessage.mock.calls
      .filter((call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'message')
      .map((call: any[]) => call[1]?.message);

    expect(deltas).toEqual(['OK']);
  });

  it('streams reasoning deltas as a single thinking message with a stable happierStreamKey', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-thinking-stream' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: { part: { id: 'reason_1', type: 'reasoning', sessionID: 'ses_1' } },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'reason_1', delta: 'A' },
      },
    });
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.delta',
        properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'reason_1', delta: 'AB' },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(promptPromise).resolves.toBeUndefined();

    const thinkingCalls: Array<{ text: string; streamKey: string | undefined }> = session.sendAgentMessage.mock.calls
      .filter((call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'thinking')
      .map((call: any[]) => ({
        text: call[1]?.text,
        streamKey: call[2]?.meta?.happierStreamKey,
      }));

    expect(thinkingCalls.map((c) => c.text)).toEqual(['A', 'B']);
    expect(thinkingCalls[0]?.streamKey).toBeTruthy();
    expect(thinkingCalls[1]?.streamKey).toBe(thinkingCalls[0]?.streamKey);
  });

  it('resolves turns when OpenCode emits session.status idle without a session.idle event', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-2' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
    });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('does not emit duplicate task_complete when both session.status idle and session.idle arrive for a turn', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-3' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(promptPromise).resolves.toBeUndefined();

    const taskCompleteCalls = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'task_complete',
    );
    expect(taskCompleteCalls.length).toBe(1);
  });

  it('polls for pending permission requests and replies while a turn is in-flight', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) };

    client.permissionList.mockImplementation(async () => ([
      {
        id: 'per_1',
        sessionID: 'ses_1',
        permission: 'external_directory',
        patterns: ['/tmp/*'],
        always: ['/tmp/*'],
        metadata: {},
      },
    ]));

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: permissionHandler as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-4' });

    await expect.poll(() => client.permissionList.mock.calls.length).toBeGreaterThan(0);
    await expect.poll(() => client.permissionReply.mock.calls.length).toBe(1);
    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'per_1',
      'external_directory',
      expect.objectContaining({ permission: 'external_directory' }),
    );
    expect(client.permissionReply).toHaveBeenCalledWith({ requestId: 'per_1', reply: 'once' });

    // Complete the turn once permissions are cleared + idle is observed.
    client.permissionList.mockResolvedValueOnce([]);
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(promptPromise).resolves.toBeUndefined();
  });

  it('re-emits tool-call when a tool update gains additional input fields (e.g. command)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-tool-update' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    const emitToolUpdate = (input: unknown) => {
      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_tool_1',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_1',
              callID: 'call_1',
              tool: 'bash',
              state: { status: 'running', input },
            },
          },
        },
      });
    };

    emitToolUpdate({});
    emitToolUpdate({ command: 'echo hi' });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });
    await expect(promptPromise).resolves.toBeUndefined();

    const calls = session.sendAgentMessage.mock.calls
      .filter((c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'tool-call' && c?.[1]?.callId === 'call_1');
    expect(calls.length).toBe(2);
  });

  it('imports remote transcript history into a fresh session on resume (meta.importedFrom="acp-history")', async () => {
    const client = createFakeClient() as any;
    client.sessionMessagesList = vi.fn(async () => ([
      {
        info: { role: 'user', id: 'msg_u1', time: { created: 1 }, sessionID: 'ses_remote' },
        parts: [{ type: 'text', text: 'phase1 user' }],
      },
      {
        info: { role: 'assistant', id: 'msg_a1', time: { created: 2 }, sessionID: 'ses_remote' },
        parts: [{ type: 'text', text: 'IMPORT_PHASE1_TEXT_OK' }],
      },
    ]));

    const session = createFakeSession();
    session.__setLastObservedMessageSeq(0);

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });

    await expect.poll(() => session.sendAgentMessageCommitted.mock.calls.length).toBeGreaterThan(0);
    const importedAssistant = session.sendAgentMessageCommitted.mock.calls.find(
      (c: any[]) =>
        c?.[0] === 'opencode' &&
        c?.[1]?.type === 'message' &&
        typeof c?.[1]?.message === 'string' &&
        c[1].message.includes('IMPORT_PHASE1_TEXT_OK') &&
        c?.[2]?.meta?.importedFrom === 'acp-history',
    );
    expect(importedAssistant).toBeTruthy();
  });

  it('does not import remote history when resuming into an existing Happier session', async () => {
    const client = createFakeClient() as any;
    client.sessionMessagesList = vi.fn(async () => ([
      {
        info: { role: 'assistant', id: 'msg_a1', time: { created: 2 }, sessionID: 'ses_remote' },
        parts: [{ type: 'text', text: 'SHOULD_NOT_IMPORT' }],
      },
    ]));

    const session = createFakeSession();
    session.__getMetadata().opencodeSessionId = 'ses_remote';

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({ resumeId: 'ses_remote' });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(client.sessionMessagesList).not.toHaveBeenCalled();
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(session.sendUserTextMessageCommitted).not.toHaveBeenCalled();
  });

  it('imports Task child session messages as a sidechain (meta.importedFrom="acp-sidechain")', async () => {
    const client = createFakeClient() as any;
    client.sessionMessagesList = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId !== 'ses_child') return [];
      return [
        {
          info: { role: 'assistant', id: 'msg_child_a1', time: { created: 10 }, sessionID: sessionId },
          parts: [{ type: 'text', text: 'SUBTASK_OK' }],
        },
      ];
    });

    const session = createFakeSession();

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-task-sidechain' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_task_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_task_1',
            callID: 'call_task_1',
            tool: 'task',
            state: {
              status: 'completed',
              output: '<task_metadata>\\nsession_id: ses_child\\n</task_metadata>\\nSUBTASK_OK',
              title: 'Run subtask',
              metadata: {},
            },
          },
        },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });
    await expect(promptPromise).resolves.toBeUndefined();

    await expect.poll(() => session.sendAgentMessageCommitted.mock.calls.length).toBeGreaterThan(0);
    const sidechainCall = session.sendAgentMessageCommitted.mock.calls.find(
      (c: any[]) =>
        c?.[0] === 'opencode' &&
        c?.[1]?.type === 'message' &&
        c?.[1]?.sidechainId === 'call_task_1' &&
        c?.[2]?.meta?.importedFrom === 'acp-sidechain',
    );
    expect(sidechainCall).toBeTruthy();
  });

  it('cancel resolves even if the OpenCode abort endpoint hangs (does not wedge runner abort handling)', async () => {
    const prior = process.env.HAPPIER_OPENCODE_SERVER_ABORT_TIMEOUT_MS;
    process.env.HAPPIER_OPENCODE_SERVER_ABORT_TIMEOUT_MS = '25';
    try {
      const client = createFakeClient() as any;
      client.sessionAbort = vi.fn(async () => await new Promise<void>(() => {}));

      const session = createFakeSession();
      const runtime = createOpenCodeServerRuntime(
        {
          directory: '/tmp',
          session,
          messageBuffer: new MessageBuffer(),
          mcpServers: {},
          permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
          onThinkingChange: vi.fn(),
        },
        {
          createClient: async () => client as any,
        },
      );

      await runtime.startOrLoad({});

      const outcome = await Promise.race([
        runtime.cancel().then(() => 'cancelled' as const),
        new Promise<'timeout'>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 250);
          timer.unref?.();
        }),
      ]);

      expect(outcome).toBe('cancelled');
    } finally {
      if (typeof prior === 'string') {
        process.env.HAPPIER_OPENCODE_SERVER_ABORT_TIMEOUT_MS = prior;
      } else {
        delete process.env.HAPPIER_OPENCODE_SERVER_ABORT_TIMEOUT_MS;
      }
    }
  });

  it('cancel rejects an in-flight turn so sendPromptWithMeta does not hang forever', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime(
      {
        directory: '/tmp',
        session,
        messageBuffer: new MessageBuffer(),
        mcpServers: {},
        permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
        onThinkingChange: vi.fn(),
      },
      {
        createClient: async () => client as any,
      },
    );

    await runtime.startOrLoad({});
    runtime.beginTurn();

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-cancel' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    await runtime.cancel();

    const outcome = await Promise.race([
      promptPromise.then(() => 'resolved' as const).catch(() => 'rejected' as const),
      new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 250);
        timer.unref?.();
      }),
    ]);

    expect(outcome).toBe('rejected');
  });
});
