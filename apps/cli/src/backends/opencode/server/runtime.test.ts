import { describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { buildChangeTitleInstruction } from '@/agent/runtime/changeTitleInstruction';
import { logger } from '@/ui/logger';

import { createOpenCodeServerRuntime } from './runtime';
import type { OpenCodeGlobalEvent } from './types';

function createFakeClient() {
  let onEvent: ((evt: OpenCodeGlobalEvent) => void) | null = null;
  let directoryOverride: string | null = null;
  let statusType: string = 'idle';
  return {
    sessionCreate: vi.fn(async () => ({ id: 'ses_1' })),
    sessionGet: vi.fn(async ({ sessionId }: { sessionId: string }) => ({ id: sessionId })),
    sessionMessagesList: vi.fn(async () => ([] as unknown[])),
    sessionPromptAsync: vi.fn(async () => {}),
    sessionAbort: vi.fn(async () => {}),
    sessionFork: vi.fn(async () => ({ id: 'ses_fork' })),
    sessionStatusList: vi.fn(async () => ({ ses_1: { type: statusType } })),
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
    mcpAdd: vi.fn(async () => ({})),
    mcpDisconnect: vi.fn(async () => true),
    questionReply: vi.fn(async () => true),
    questionReject: vi.fn(async () => true),
    questionList: vi.fn(async () => ([] as unknown[])),
    permissionReply: vi.fn(async () => true),
    permissionList: vi.fn(async () => ([] as unknown[])),
    subscribeGlobalEvents: vi.fn(async ({ onEvent: cb }: { onEvent: (evt: OpenCodeGlobalEvent) => void }) => {
      onEvent = cb;
    }),
    dispose: vi.fn(async () => {}),
    // Real OpenCode SSE subscribers do not await the callback return value.
    __emit: async (evt: OpenCodeGlobalEvent) => {
      onEvent?.(evt);
    },
    __setStatusType: (next: string) => {
      statusType = next;
    },
    __getDirectoryOverride: () => directoryOverride,
  };
}

function createFakeSession() {
  const meta: Record<string, unknown> = {};
  let lastSeq = 0;
  return {
    keepAlive: vi.fn(),
    sendAgentMessage: vi.fn(),
    sendTranscriptDraftDelta: vi.fn(),
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

type DraftTranscriptRow = Readonly<{
  provider: unknown;
  localId: string | undefined;
  segmentKind: 'assistant' | 'thinking' | undefined;
  sidechainId: string | null;
  deltaText: string;
  createdAtMs: number | undefined;
}>;

type CommittedTranscriptBody = Readonly<Record<string, unknown> & {
  type?: 'message' | 'thinking';
  message?: string;
  text?: string;
  sidechainId?: string | null;
}>;

type CommittedTranscriptMeta = Readonly<Record<string, unknown> & {
  happierStreamKey?: string;
  happierStreamSegmentV1?: Record<string, unknown>;
  importedFrom?: string;
  remoteSessionId?: string;
}>;

type CommittedTranscriptRow = Readonly<{
  provider: unknown;
  body: CommittedTranscriptBody;
  localId: string | undefined;
  meta: CommittedTranscriptMeta;
  callOrder: number | undefined;
}>;

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function readSegmentKind(value: unknown): DraftTranscriptRow['segmentKind'] {
  return value === 'assistant' || value === 'thinking' ? value : undefined;
}

function getDraftTranscriptRows(
  session: ReturnType<typeof createFakeSession>,
  opts?: { segmentKind?: 'assistant' | 'thinking'; sidechainId?: string | null },
): DraftTranscriptRow[] {
  const rows = (session.sendTranscriptDraftDelta as any).mock.calls
    .map((call: any[]) => ({
      provider: call?.[0],
      localId: readOptionalString(call?.[1]?.localId),
      segmentKind: readSegmentKind(call?.[1]?.segmentKind),
      sidechainId: readOptionalString(call?.[1]?.sidechainId) ?? null,
      deltaText: call?.[1]?.deltaText ?? '',
      createdAtMs: readOptionalNumber(call?.[1]?.createdAtMs),
    })) as DraftTranscriptRow[];
  return rows
    .filter((row) => (opts?.segmentKind ? row.segmentKind === opts.segmentKind : true))
    .filter((row) => (opts?.sidechainId !== undefined ? row.sidechainId === opts.sidechainId : true));
}

function getCommittedTranscriptRows(
  session: ReturnType<typeof createFakeSession>,
  opts?: { type?: 'message' | 'thinking'; sidechainId?: string | null },
): CommittedTranscriptRow[] {
  const rows = (session.sendAgentMessageCommitted as any).mock.calls
    .map((call: any[], index: number) => ({
      provider: call?.[0],
      body: (call?.[1] ?? {}) as CommittedTranscriptBody,
      localId: readOptionalString(call?.[2]?.localId),
      meta: (call?.[2]?.meta ?? {}) as CommittedTranscriptMeta,
      callOrder: (session.sendAgentMessageCommitted as any).mock.invocationCallOrder?.[index],
    })) as CommittedTranscriptRow[];
  return rows
    .filter((row) => (opts?.type ? row.body.type === opts.type : true))
    .filter((row) => (opts?.sidechainId !== undefined ? (row.body.sidechainId ?? null) === opts.sidechainId : true));
}

async function flushTranscriptCommitMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

describe('createOpenCodeServerRuntime', () => {
  const OPENCODE_CHANGE_TITLE_INSTRUCTION = buildChangeTitleInstruction({ preferredToolName: 'happier_change_title' });

  it('registers local MCP servers via the OpenCode /mcp API for the session directory', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        happier: {
          command: process.execPath,
          args: ['--version'],
          env: { HAPPIER_TEST_MCP: '1' },
        },
      },
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    expect(client.mcpAdd).toHaveBeenCalledWith({
      name: 'happier',
      config: {
        type: 'local',
        enabled: true,
        command: [process.execPath, '--version'],
        environment: { HAPPIER_TEST_MCP: '1' },
      },
    });
  });

  it('continues registering later MCP servers when one MCP add fails', async () => {
    const client = createFakeClient();
    client.mcpAdd
      .mockRejectedValueOnce(new Error('first add failed'))
      .mockResolvedValueOnce({});
    const session = createFakeSession();
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        broken_first: {
          command: process.execPath,
          args: ['--version'],
        },
        healthy_second: {
          command: process.execPath,
          args: ['--help'],
        },
      },
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    expect(client.mcpAdd).toHaveBeenCalledTimes(2);
    expect(client.mcpAdd).toHaveBeenNthCalledWith(1, {
      name: 'broken_first',
      config: {
        type: 'local',
        enabled: true,
        command: [process.execPath, '--version'],
      },
    });
    expect(client.mcpAdd).toHaveBeenNthCalledWith(2, {
      name: 'healthy_second',
      config: {
        type: 'local',
        enabled: true,
        command: [process.execPath, '--help'],
      },
    });
    expect(debugSpy).toHaveBeenCalledWith(
      '[OpenCodeServer] Failed to register MCP server (non-fatal)',
      expect.objectContaining({ serverName: 'broken_first', error: expect.any(Error) }),
    );
    debugSpy.mockRestore();
  });

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

  it('creates a session with the safe-yolo ruleset when permission mode is safe-yolo', async () => {
    const client = createFakeClient() as any;
    client.sessionCreate = vi.fn(async () => ({ id: 'ses_1' }));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'safe-yolo',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    expect(client.sessionCreate).toHaveBeenCalledTimes(1);
    const firstCall = (client.sessionCreate as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      permission: expect.arrayContaining([
        { permission: '*', pattern: '*', action: 'ask' },
        { permission: 'edit', pattern: '*', action: 'allow' },
        { permission: 'bash', pattern: '*', action: 'ask' },
        { permission: 'external_directory', pattern: '*', action: 'ask' },
      ]),
    });
  });

  it('creates a session with the read-only ruleset when permission mode is read-only', async () => {
    const client = createFakeClient() as any;
    client.sessionCreate = vi.fn(async () => ({ id: 'ses_1' }));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'read-only',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    expect(client.sessionCreate).toHaveBeenCalledTimes(1);
    const firstCall = (client.sessionCreate as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      permission: expect.arrayContaining([
        { permission: '*', pattern: '*', action: 'deny' },
        { permission: 'edit', pattern: '*', action: 'deny' },
        { permission: 'bash', pattern: '*', action: 'deny' },
        { permission: 'external_directory', pattern: '*', action: 'deny' },
        { permission: 'read', pattern: '*', action: 'allow' },
      ]),
    });
  });

  it('creates a session with the yolo ruleset when permission mode is yolo', async () => {
    const client = createFakeClient() as any;
    client.sessionCreate = vi.fn(async () => ({ id: 'ses_1' }));

    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'yolo',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    expect(client.sessionCreate).toHaveBeenCalledTimes(1);
    const firstCall = (client.sessionCreate as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      permission: expect.arrayContaining([
        { permission: '*', pattern: '*', action: 'allow' },
        { permission: 'edit', pattern: '*', action: 'allow' },
        { permission: 'bash', pattern: '*', action: 'allow' },
        { permission: 'external_directory', pattern: '*', action: 'allow' },
      ]),
    });
  });

  it('dedupes thinking signals for repeated busy/idle events and does not flood keepAlive', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const onThinkingChange = vi.fn();

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange,
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    runtime.beginTurn();
    await client.__emit({ directory: '/tmp', payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } } });
    await client.__emit({ directory: '/tmp', payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } } });
    await client.__emit({ directory: '/tmp', payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    await client.__emit({ directory: '/tmp', payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });
    runtime.flushTurn();

    expect(onThinkingChange.mock.calls).toEqual([[true], [false]]);
    expect(session.keepAlive.mock.calls).toEqual([[true, 'remote'], [false, 'remote']]);
  });

  it('publishes keepAlive when a turn starts and ends without status events', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const onThinkingChange = vi.fn();

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange,
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});

    runtime.beginTurn();
    runtime.flushTurn();

    expect(onThinkingChange.mock.calls).toEqual([[true], [false]]);
    expect(session.keepAlive.mock.calls).toEqual([[true, 'remote'], [false, 'remote']]);
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
      parts: [{ type: 'text', text: `hello\n\n${OPENCODE_CHANGE_TITLE_INSTRUCTION}` }],
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

  it('appends CHANGE_TITLE_INSTRUCTION to the first prompt only', async () => {
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
    const firstPromptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      sessionId: 'ses_1',
      parts: [{ type: 'text', text: `hello\n\n${OPENCODE_CHANGE_TITLE_INSTRUCTION}` }],
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'ok' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });
    await expect(firstPromptPromise).resolves.toBeUndefined();

    runtime.beginTurn();
    const secondPromptPromise = (runtime as any).sendPromptWithMeta({ text: 'again' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(2);
    const secondCall = (client.sessionPromptAsync as any).mock.calls[1]?.[0] as any;
    expect(secondCall).toMatchObject({
      sessionId: 'ses_1',
      parts: [{ type: 'text', text: 'again' }],
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_2', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_2', partID: 'part_2', delta: 'ok' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });
    await expect(secondPromptPromise).resolves.toBeUndefined();
  });

  it('does not transcribe change_title tool parts as tool-call/tool-result messages', async () => {
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
    (session.sendAgentMessage as any).mockClear();

    await client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_title_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_1',
            callID: 'call_title_1',
            tool: 'happier_change_title',
            state: {
              status: 'completed',
              input: { title: 'My Title' },
              output: 'ok',
            },
          },
        },
      },
    });

    expect(session.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('canonicalizes custom MCP tool aliases from configured OpenCode servers before sending transcript tool events', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {
        qa_marker_stdio_20260306: {
          type: 'local',
          command: 'node',
          args: ['server.js'],
        } as any,
      },
      permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any,
      onThinkingChange: vi.fn(),
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    (session.sendAgentMessage as any).mockClear();

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_custom_mcp_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_custom_1',
            callID: 'call_custom_mcp_1',
            tool: 'qa_marker_stdio_20260306_get_marker',
            state: {
              status: 'completed',
              input: {},
              output: 'marker-ok',
            },
          },
        },
      },
    });
    await flushTranscriptCommitMicrotasks();

    expect(session.sendAgentMessage).toHaveBeenCalledWith(
      'opencode',
      expect.objectContaining({
        type: 'tool-call',
        callId: 'call_custom_mcp_1',
        name: 'mcp__qa_marker_stdio_20260306__get_marker',
      }),
      expect.any(Object),
    );
  });

  it('does not trigger unhandledRejection when an async event handler path throws during tool processing', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    (session.sendAgentMessage as any).mockImplementation(() => {
      throw new Error('tool send failed');
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
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

      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part_tool_unhandled_1',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_unhandled_1',
              callID: 'call_unhandled_1',
              tool: 'bash',
              state: {
                status: 'completed',
                input: { command: 'echo hi' },
                output: 'ok',
              },
            },
          },
        },
      });

      await flushTranscriptCommitMicrotasks();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it('omits custom messageID for the first prompt after resume and restores it on later prompts', async () => {
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

    await runtime.startOrLoad({ resumeId: 'ses_remote' });

    runtime.beginTurn();
    const firstPromptPromise = (runtime as any).sendPromptWithMeta({ text: 'first after resume', localId: 'resume-local-1' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    expect(firstCall).toMatchObject({
      sessionId: 'ses_remote',
      parts: [{ type: 'text', text: `first after resume\n\n${OPENCODE_CHANGE_TITLE_INSTRUCTION}` }],
    });
    expect(firstCall.messageId).toBeUndefined();

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_first', type: 'text', sessionID: 'ses_remote' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_remote', messageID: 'msg_asst_first', partID: 'part_first', delta: 'ok' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_remote' } },
    });
    await expect(firstPromptPromise).resolves.toBeUndefined();

    runtime.beginTurn();
    const secondPromptPromise = (runtime as any).sendPromptWithMeta({ text: 'second after resume', localId: 'resume-local-2' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(2);
    const secondCall = (client.sessionPromptAsync as any).mock.calls[1]?.[0] as any;
    expect(secondCall).toMatchObject({
      sessionId: 'ses_remote',
      parts: [{ type: 'text', text: 'second after resume' }],
    });
    expect(secondCall.messageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_second', type: 'text', sessionID: 'ses_remote' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_remote', messageID: 'msg_asst_second', partID: 'part_second', delta: 'ok' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_remote' } },
    });
    await expect(secondPromptPromise).resolves.toBeUndefined();
  });

  it('backfills vendor-assigned user messageID for the first prompt after resume', async () => {
    const client = createFakeClient() as any;
    const session = createFakeSession();
    session.__getMetadata().opencodeSessionId = 'ses_remote';

    let promptSent = false;
    client.sessionPromptAsync = vi.fn(async () => {
      promptSent = true;
    });
    client.sessionMessagesList = vi.fn(async () => {
      if (!promptSent) {
        return [
          {
            info: { id: 'msg_existing_1', role: 'assistant', time: { created: 1 } },
            parts: [{ type: 'text', text: 'existing' }],
          },
        ];
      }
      return [
        {
          info: { id: 'msg_existing_1', role: 'assistant', time: { created: 1 } },
          parts: [{ type: 'text', text: 'existing' }],
        },
        {
          info: { id: 'msg_vendor_user_1', role: 'user', time: { created: 2 } },
          parts: [{ type: 'text', text: 'first after resume' }],
        },
      ];
    });

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

    runtime.beginTurn();
    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'first after resume', localId: 'resume-local-1' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);
    const firstCall = (client.sessionPromptAsync as any).mock.calls[0]?.[0] as any;
    expect(firstCall.messageId).toBeUndefined();

    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_first', type: 'text', sessionID: 'ses_remote' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_remote', messageID: 'msg_asst_first', partID: 'part_first', delta: 'ok' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_remote' } },
    });
    await expect(promptPromise).resolves.toBeUndefined();

    expect(session.__getMetadata()?.opencodeUserMessageIdMapV1?.byLocalId?.['resume-local-1']).toBe('msg_vendor_user_1');
  });

  it('imports text turns that originate directly from the OpenCode TUI', async () => {
    const client = createFakeClient() as any;
    const session = createFakeSession();
    let stage: 'initial' | 'busy' | 'idle' = 'initial';

    client.sessionMessagesList = vi.fn(async () => {
      if (stage === 'initial') return [];
      if (stage === 'busy') {
        return [
          {
            info: { id: 'msg_live_user_1', role: 'user', time: { created: 1 } },
            parts: [{ type: 'text', text: 'hello from the TUI' }],
          },
        ];
      }
      return [
        {
          info: { id: 'msg_live_user_1', role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'hello from the TUI' }],
        },
        {
          info: { id: 'msg_live_assistant_1', role: 'assistant', time: { created: 2 } },
          parts: [{ type: 'text', text: 'reply from the TUI turn' }],
        },
      ];
    });

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

    stage = 'busy';
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
    });
    await flushTranscriptCommitMicrotasks();

    expect(session.sendUserTextMessageCommitted).toHaveBeenCalledWith(
      'hello from the TUI',
      expect.objectContaining({
        meta: expect.objectContaining({
          importedFrom: 'acp-live-sync',
          remoteSessionId: 'ses_1',
        }),
      }),
    );

    stage = 'idle';
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });
    await flushTranscriptCommitMicrotasks();

    expect(session.sendUserTextMessageCommitted).toHaveBeenCalledTimes(1);
    expect(session.sendAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      expect.objectContaining({
        type: 'message',
        message: 'reply from the TUI turn',
      }),
      expect.objectContaining({
        meta: expect.objectContaining({
          importedFrom: 'acp-live-sync',
          remoteSessionId: 'ses_1',
        }),
      }),
    );
  });

  it('waits until idle before importing remote assistant text for externally-originated turns', async () => {
    const client = createFakeClient() as any;
    const session = createFakeSession();
    let stage: 'initial' | 'busy' | 'idle' = 'initial';

    client.sessionMessagesList = vi.fn(async () => {
      if (stage === 'initial') return [];
      if (stage === 'busy') {
        return [
          {
            info: { id: 'msg_live_user_2', role: 'user', time: { created: 1 } },
            parts: [{ type: 'text', text: 'question from the TUI' }],
          },
          {
            info: { id: 'msg_live_assistant_2', role: 'assistant', time: { created: 2 } },
            parts: [{ type: 'text', text: 'partial assistant reply' }],
          },
        ];
      }
      return [
        {
          info: { id: 'msg_live_user_2', role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'question from the TUI' }],
        },
        {
          info: { id: 'msg_live_assistant_2', role: 'assistant', time: { created: 2 } },
          parts: [{ type: 'text', text: 'final assistant reply from idle' }],
        },
      ];
    });

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

    stage = 'busy';
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
    });
    await flushTranscriptCommitMicrotasks();

    expect(session.sendUserTextMessageCommitted).toHaveBeenCalledWith(
      'question from the TUI',
      expect.objectContaining({
        meta: expect.objectContaining({
          importedFrom: 'acp-live-sync',
          remoteSessionId: 'ses_1',
        }),
      }),
    );
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();

    stage = 'idle';
    await client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });
    await flushTranscriptCommitMicrotasks();

    expect(session.sendAgentMessageCommitted).toHaveBeenCalledTimes(1);
    expect(session.sendAgentMessageCommitted).toHaveBeenCalledWith(
      'opencode',
      expect.objectContaining({
        type: 'message',
        message: 'final assistant reply from idle',
      }),
      expect.objectContaining({
        meta: expect.objectContaining({
          importedFrom: 'acp-live-sync',
          remoteSessionId: 'ses_1',
        }),
      }),
    );
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

  it('does not crash if session.error rejects the turn during prompt_async', async () => {
    const client = createFakeClient() as any;
    client.sessionPromptAsync = vi.fn(async () => {
      client.__emit({
        directory: '/tmp',
        payload: { type: 'session.error', properties: { sessionID: 'ses_1', error: { message: 'Model not found' } } },
      });
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

    await expect((runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-error' })).rejects.toBeTruthy();
  });

  it('responds to approved_for_session permissions with once (vendor should not persist approvals)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = { handleToolCall: vi.fn(async () => ({ decision: 'approved_for_session' })) } as any;

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'default',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'perm_1',
          sessionID: 'ses_1',
          permission: 'edit',
          patterns: ['../outside.txt'],
          always: ['../*'],
          metadata: {},
          tool: { messageID: 'msg_tool_1', callID: 'call_1' },
        },
      },
    });

    await expect.poll(() => client.permissionReply.mock.calls.length).toBe(1);
    expect(client.permissionReply).toHaveBeenCalledWith({ requestId: 'perm_1', reply: 'once' });
  });

  it('auto-rejects permission.asked requests in read-only mode (no UI prompt)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) } as any;

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'read-only',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'perm_ro',
          sessionID: 'ses_1',
          permission: 'edit',
          patterns: ['AGENTS.md'],
          always: ['*'],
          metadata: {},
        },
      },
    });

    await expect.poll(() => client.permissionReply.mock.calls.length).toBe(1);
    expect(client.permissionReply).toHaveBeenCalledWith({ requestId: 'perm_ro', reply: 'reject' });
    expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
  });

  it('auto-approves permission.asked requests in yolo mode (no UI prompt)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = { handleToolCall: vi.fn(async () => ({ decision: 'denied' })) } as any;

    const runtime = createOpenCodeServerRuntime({
      directory: '/tmp',
      session,
      messageBuffer: new MessageBuffer(),
      mcpServers: {},
      permissionHandler,
      onThinkingChange: vi.fn(),
      getPermissionMode: () => 'yolo',
    }, {
      createClient: async () => client as any,
    });

    await runtime.startOrLoad({});
    runtime.beginTurn();

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'permission.asked',
        properties: {
          id: 'perm_yolo',
          sessionID: 'ses_1',
          permission: 'edit',
          patterns: ['AGENTS.md'],
          always: ['*'],
          metadata: {},
        },
      },
    });

    await expect.poll(() => client.permissionReply.mock.calls.length).toBe(1);
    expect(client.permissionReply).toHaveBeenCalledWith({ requestId: 'perm_yolo', reply: 'once' });
    expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
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

  it('auto-acknowledges internal OpenCode title update questions without surfacing AskUserQuestion', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved', answers: { q1: 'should-not-be-used' } })),
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
          id: 'que_title_1',
          sessionID: 'ses_1',
          questions: [
            {
              question: '(Internal) Ignore',
              header: 'Title update',
              options: [{ label: 'OK', description: 'Acknowledge' }],
              multiple: false,
            },
          ],
        },
      },
    });

    await expect.poll(() => client.questionReply.mock.calls.length).toBe(1);

    expect(permissionHandler.handleToolCall).not.toHaveBeenCalled();
    expect(client.questionReply).toHaveBeenCalledWith({ requestId: 'que_title_1', answers: [['OK']] });

    const sentToolResult = session.sendAgentMessage.mock.calls.some((call: unknown[]) => {
      const message = call[1];
      if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
      const rec = message as Record<string, unknown>;
      return rec.type === 'tool-result' && rec.callId === 'que_title_1';
    });
    expect(sentToolResult).toBe(false);
  });

  it('handles question.asked for Task child sessions (prevents sub-agent stalls)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved', answers: { q1: 'answer' } })),
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

    // Register a child session via a Task tool part emitted from the parent session.
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_task_child_reg',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_task_reg',
            callID: 'call_task_reg',
            tool: 'task',
            state: { status: 'running', input: { description: 'Run child' }, metadata: { sessionId: 'ses_child_1' } },
          },
        },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'question.asked',
        properties: {
          id: 'que_child_1',
          sessionID: 'ses_child_1',
          questions: [{ question: 'q1', header: 'Q1', options: [], multiple: false }],
        },
      },
    });

    await expect.poll(() => client.questionReply.mock.calls.length).toBe(1);
    expect(permissionHandler.handleToolCall).toHaveBeenCalledTimes(1);
    expect(client.questionReply).toHaveBeenCalledWith({ requestId: 'que_child_1', answers: [['answer']] });
  });

  it('treats location-based OpenCode questions as freeform (options are a UI hint, not a real choice)', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved', answers: { 'Which file should I inspect?': 'README.md' } })),
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
          id: 'que_freeform',
          sessionID: 'ses_1',
          questions: [
            {
              question: 'Which file should I inspect?',
              header: 'File to inspect',
              locations: [],
              options: [
                { label: 'Type path now', description: 'Provide the repo-relative file path you want me to inspect.' },
              ],
              multiple: false,
            },
          ],
        },
      },
    });

    await expect.poll(() => client.questionReply.mock.calls.length).toBe(1);

    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'que_freeform',
      'AskUserQuestion',
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            question: 'Which file should I inspect?',
            header: 'File to inspect',
            options: [],
            freeform: expect.objectContaining({
              placeholder: 'Type path now',
              description: 'Provide the repo-relative file path you want me to inspect.',
            }),
          }),
        ],
      }),
    );

    expect(client.questionReply).toHaveBeenCalledWith({ requestId: 'que_freeform', answers: [['README.md']] });
  });

  it('treats single-option "type/enter" OpenCode questions as freeform even when locations are omitted', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved', answers: { 'Which file should I inspect?': 'README.md' } })),
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
          id: 'que_freeform_2',
          sessionID: 'ses_1',
          questions: [
            {
              question: 'Which file should I inspect?',
              header: 'File to inspect',
              options: [
                { label: 'Type your own answer', description: 'Enter the file path you want me to inspect.' },
              ],
              multiple: false,
            },
          ],
        },
      },
    });

    await expect.poll(() => client.questionReply.mock.calls.length).toBe(1);

    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'que_freeform_2',
      'AskUserQuestion',
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            options: [],
            freeform: expect.objectContaining({ placeholder: 'Type your own answer' }),
          }),
        ],
      }),
    );
  });

  it('supports OpenCode questions with suggestions plus a typed "other" answer (freeform + options) and does not split commas', async () => {
    const client = createFakeClient();
    const session = createFakeSession();
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved', answers: { q1: 'Custom goal, with commas' } })),
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
          id: 'que_other_combo',
          sessionID: 'ses_1',
          questions: [
            {
              question: 'q1',
              header: 'Q1',
              options: [
                { label: 'Option A', description: 'A' },
                { label: 'Other (type below)', description: 'Type a different goal.' },
              ],
              multiple: false,
            },
          ],
        },
      },
    });

    await expect.poll(() => client.questionReply.mock.calls.length).toBe(1);

    expect(permissionHandler.handleToolCall).toHaveBeenCalledWith(
      'que_other_combo',
      'AskUserQuestion',
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            question: 'q1',
            header: 'Q1',
            options: [{ label: 'Option A', description: 'A' }],
            freeform: expect.objectContaining({ placeholder: 'Other (type below)', description: 'Type a different goal.' }),
          }),
        ],
      }),
    );

    expect(client.questionReply).toHaveBeenCalledWith({ requestId: 'que_other_combo', answers: [['Custom goal, with commas']] });
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

  it('dedupes cumulative text deltas and streams transcript-vNext updates with a stable happierStreamKey per OpenCode message', async () => {
    const prevFlush = process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS = '0';
    vi.useFakeTimers();
    try {
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

      let queuedEvent = client.__emit({
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
      await vi.runAllTimersAsync();

      await expect(promptPromise).resolves.toBeUndefined();
      await flushTranscriptCommitMicrotasks();
      await flushTranscriptCommitMicrotasks();
      await flushTranscriptCommitMicrotasks();

      const draftCalls = getDraftTranscriptRows(session, { segmentKind: 'assistant' });
      expect(draftCalls.map((c) => c.deltaText)).toEqual(['Hello', '.']);
      expect(draftCalls[0]?.localId).toBeTruthy();
      expect(draftCalls[1]?.localId).toBe(draftCalls[0]?.localId);

      const committedCalls = getCommittedTranscriptRows(session, { type: 'message' });
      expect(committedCalls.map((c) => c.body?.message)).toEqual(['Hello', 'Hello.']);
      expect(committedCalls[0]?.localId).toBeTruthy();
      expect(committedCalls[1]?.localId).toBe(committedCalls[0]?.localId);
      expect(committedCalls[0]?.meta?.happierStreamKey).toBeTruthy();
      expect(committedCalls[1]?.meta?.happierStreamKey).toBe(committedCalls[0]?.meta?.happierStreamKey);
      expect(committedCalls[1]?.meta?.happierStreamSegmentV1).toMatchObject({
        segmentKind: 'assistant',
        segmentLocalId: draftCalls[0]?.localId,
        segmentState: 'complete',
      });
    } finally {
      vi.useRealTimers();
      if (typeof prevFlush === 'string') process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS = prevFlush;
      else delete process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    }
  });

  it('buffers tiny text deltas into fewer transcript messages by default (prevents per-token transcript spam)', async () => {
    const prevFlush = process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    delete process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    vi.useFakeTimers();
    try {
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

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-buffer-default' });
      // Avoid expect.poll under fake timers; let the async prompt setup yield once.
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);

      let queuedEvent = client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } },
        },
      });

      for (const ch of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
        queuedEvent = client.__emit({
          directory: '/tmp',
          payload: {
            type: 'message.part.delta',
            properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: ch },
          },
        });
      }

      await queuedEvent;
      expect(getDraftTranscriptRows(session, { segmentKind: 'assistant' })).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(60);
      await flushTranscriptCommitMicrotasks();

      const draftCallsAfterFlush = getDraftTranscriptRows(session, { segmentKind: 'assistant' });
      expect(draftCallsAfterFlush.map((c) => c.deltaText)).toEqual(['abcdefghij']);
      expect(typeof draftCallsAfterFlush[0]?.localId).toBe('string');

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });

      await expect(promptPromise).resolves.toBeUndefined();

      const committedCalls = getCommittedTranscriptRows(session, { type: 'message' });
      expect(committedCalls[committedCalls.length - 1]?.body?.message).toBe('abcdefghij');
      expect(committedCalls[committedCalls.length - 1]?.meta?.happierStreamSegmentV1).toMatchObject({
        segmentState: 'complete',
      });
    } finally {
      vi.useRealTimers();
      if (typeof prevFlush === 'string') process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS = prevFlush;
      else delete process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    }
  });

  it('flushes buffered text chunks repeatedly while a turn is streaming (does not stall after the first flush)', async () => {
    const prevFlush = process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS = '50';
    vi.useFakeTimers();
    try {
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

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-buffer-multi-flush' });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.updated',
          properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } },
        },
      });

      for (const ch of ['a', 'b', 'c', 'd', 'e']) {
        client.__emit({
          directory: '/tmp',
          payload: {
            type: 'message.part.delta',
            properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: ch },
          },
        });
      }

      await vi.advanceTimersByTimeAsync(60);
      const firstFlushCalls = getDraftTranscriptRows(session, { segmentKind: 'assistant' }).map((call) => call.deltaText);
      expect(firstFlushCalls).toEqual(['abcde']);

      for (const ch of ['f', 'g', 'h', 'i', 'j']) {
        client.__emit({
          directory: '/tmp',
          payload: {
            type: 'message.part.delta',
            properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: ch },
          },
        });
      }

      await vi.advanceTimersByTimeAsync(60);
      const secondFlushCalls = getDraftTranscriptRows(session, { segmentKind: 'assistant' }).map((call) => call.deltaText);
      expect(secondFlushCalls).toEqual(['abcde', 'fghij']);

      client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });

      await expect(promptPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      if (typeof prevFlush === 'string') process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS = prevFlush;
      else delete process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    }
  });

  it('does not mix transcript-vNext localIds across different OpenCode messageIDs in the same turn', async () => {
    const prevFlush = process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS = '0';
    try {
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

      const draftCalls = getDraftTranscriptRows(session, { segmentKind: 'assistant' })
        .filter((c) => c.deltaText === 'A' || c.deltaText === 'B');

      expect(draftCalls).toHaveLength(2);
      expect(draftCalls[0]?.localId).toBeTruthy();
      expect(draftCalls[1]?.localId).toBeTruthy();
      expect(draftCalls[1]?.localId).not.toBe(draftCalls[0]?.localId);

      const committedCalls = getCommittedTranscriptRows(session, { type: 'message' })
        .filter((c) => c.body?.message === 'A' || c.body?.message === 'B');
      expect(committedCalls[0]?.meta?.happierStreamKey).toBeTruthy();
      expect(committedCalls[1]?.meta?.happierStreamKey).toBeTruthy();
      expect(committedCalls[1]?.meta?.happierStreamKey).not.toBe(committedCalls[0]?.meta?.happierStreamKey);
    } finally {
      if (typeof prevFlush === 'string') process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS = prevFlush;
      else delete process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    }
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

    const deltas = getDraftTranscriptRows(session, { segmentKind: 'assistant' }).map((row) => row.deltaText);

    expect(deltas).toEqual(['OK']);
  });

  it('streams reasoning deltas through transcript-vNext with a stable happierStreamKey', async () => {
    const prevFlush = process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS = '0';
    try {
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

      const draftCalls = getDraftTranscriptRows(session, { segmentKind: 'thinking' });
      expect(draftCalls.map((c) => c.deltaText)).toEqual(['A', 'B']);
      expect(draftCalls[0]?.localId).toBeTruthy();
      expect(draftCalls[1]?.localId).toBe(draftCalls[0]?.localId);

      const committedCalls = getCommittedTranscriptRows(session, { type: 'thinking' });
      expect(committedCalls.map((c) => c.body?.text)).toEqual(['A', 'AB']);
      expect(committedCalls[0]?.localId).toBeTruthy();
      expect(committedCalls[1]?.localId).toBe(committedCalls[0]?.localId);
      expect(committedCalls[0]?.meta?.happierStreamKey).toBeTruthy();
      expect(committedCalls[1]?.meta?.happierStreamKey).toBe(committedCalls[0]?.meta?.happierStreamKey);
      expect(committedCalls[1]?.meta?.happierStreamSegmentV1).toMatchObject({
        segmentLocalId: draftCalls[0]?.localId,
      });
    } finally {
      if (typeof prevFlush === 'string') process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS = prevFlush;
      else delete process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    }
  });

  it('flushes streamed assistant text before emitting an OpenCode tool-call boundary', async () => {
    const prevFlush = process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS = '5000';
    vi.useFakeTimers();
    let runtime: ReturnType<typeof createOpenCodeServerRuntime> | null = null;
    try {
      const client = createFakeClient();
      const session = createFakeSession();
      runtime = createOpenCodeServerRuntime({
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

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-tool-boundary-stream' });
      void promptPromise.catch(() => {});
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      expect(client.sessionPromptAsync).toHaveBeenCalledTimes(1);

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.updated', properties: { part: { id: 'part_text_1', type: 'text', sessionID: 'ses_1' } } },
      });
      await client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_tool_boundary_1', partID: 'part_text_1', delta: 'HELLO' } },
      });

      expect(getDraftTranscriptRows(session, { segmentKind: 'assistant' })).toHaveLength(0);

      await client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.created',
          properties: {
            part: {
              id: 'part_tool_1',
              type: 'tool',
              sessionID: 'ses_1',
              messageID: 'msg_tool_1',
              callID: 'call_tool_1',
              tool: 'bash',
              state: { status: 'running', input: { command: 'echo hi' } },
            },
          },
        },
      });
      await flushTranscriptCommitMicrotasks();

      expect(getDraftTranscriptRows(session, { segmentKind: 'assistant' }).map((row) => row.deltaText)).toEqual(['HELLO']);

      const committedCalls = getCommittedTranscriptRows(session, { type: 'message' }).filter(
        (row) => String(row.meta?.happierStreamKey ?? '').includes('msg_asst_tool_boundary_1'),
      );
      expect(committedCalls.map((row) => row.body?.message)).toEqual(['HELLO', 'HELLO']);
      expect(committedCalls[1]?.meta?.happierStreamSegmentV1).toMatchObject({
        segmentState: 'complete',
      });

      const toolCalls = (session.sendAgentMessage as any).mock.calls.filter(
        (call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'tool-call' && call?.[1]?.callId === 'call_tool_1',
      );
      expect(toolCalls).toHaveLength(1);
      const toolCallOrder = (session.sendAgentMessage as any).mock.invocationCallOrder.find(
        (_: unknown, index: number) => toolCalls.includes((session.sendAgentMessage as any).mock.calls[index]),
      );
      expect(toolCallOrder).toBeGreaterThan(committedCalls[1]?.callOrder ?? 0);

      await client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });
    } finally {
      await runtime?.cancel().catch(() => {});
      await runtime?.reset().catch(() => {});
      vi.useRealTimers();
      if (typeof prevFlush === 'string') process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS = prevFlush;
      else delete process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    }
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

  it('resolves turns when the control-plane /session/status reports idle and idle SSE signals are missing', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
      process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    try {
      const client = createFakeClient();
      // OpenCode 1.2.17 omits idle sessions from /session/status (it only returns busy sessions),
      // so we need to treat "missing entry" as idle once turn activity has been observed.
      const baseStatusList = client.sessionStatusList;
      client.sessionStatusList = vi.fn(async () => {
        const statuses = await baseStatusList();
        const rec = statuses && typeof statuses === 'object' && !Array.isArray(statuses) ? (statuses as any).ses_1 : null;
        const statusType = rec && typeof rec === 'object' ? String((rec as any).type ?? '') : '';
        if (statusType === 'idle') return {};
        return statuses as any;
      });
      // Pre-prompt idle wait (if enabled) should not block the first prompt; we want to
      // simulate the session becoming busy only after prompt_async is accepted.
      client.sessionPromptAsync = vi.fn(async () => {
        client.__setStatusType('busy');
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
      try {

        await runtime.startOrLoad({});
        runtime.beginTurn();

        const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-status-idle' });
        await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

        client.__emit({
          directory: '/tmp',
          payload: { type: 'message.part.updated', properties: { part: { id: 'part_1', type: 'text', sessionID: 'ses_1' } } },
        });
        client.__emit({
          directory: '/tmp',
          payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
        });

        client.__setStatusType('idle');

        const outcome = await Promise.race([
          promptPromise.then(() => 'resolved' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
        ]);
        expect(outcome).toBe('resolved');
        expect(client.sessionStatusList.mock.calls.length).toBeGreaterThan(0);
      } finally {
        await runtime.cancel().catch(() => {});
        await runtime.reset().catch(() => {});
      }
    } finally {
      if (prevPollInterval === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      }
      if (prevStatusPoll === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
      }
    }
  });

  it('backfills assistant text after the backfill grace window when idle is observed (ensures long turns still show final output)', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    const prevBackfillGrace = process.env.HAPPIER_OPENCODE_SERVER_ASSISTANT_BACKFILL_GRACE_MS;
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    process.env.HAPPIER_OPENCODE_SERVER_ASSISTANT_BACKFILL_GRACE_MS = '100';
    try {
      const client = createFakeClient() as any;
      const session = createFakeSession();

      let promptSent = false;
      let assistantReady = false;

      client.sessionPromptAsync = vi.fn(async () => {
        promptSent = true;
        client.__setStatusType('busy');
      });

      client.sessionMessagesList = vi.fn(async () => {
        if (!promptSent) return [];
        if (!assistantReady) return [];
        return [
          {
            info: { id: 'msg_asst_long_turn_1', role: 'assistant', time: { created: 2 } },
            parts: [{ type: 'text', text: 'LONG_TURN_ASSISTANT_OUTPUT_OK' }],
          },
        ];
      });

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
      try {

        await runtime.startOrLoad({});
        runtime.beginTurn();

        const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-backfill-after-grace' });
        await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

        // Ensure the turn has activity (so it can resolve on idle) even if assistant text deltas were missed.
        client.__emit({
          directory: '/tmp',
          payload: { type: 'message.part.updated', properties: { part: { id: 'part_reason_1', type: 'reasoning', sessionID: 'ses_1' } } },
        });
        client.__emit({
          directory: '/tmp',
          payload: {
            type: 'message.part.delta',
            properties: { sessionID: 'ses_1', messageID: 'msg_asst_long_turn_1', partID: 'part_reason_1', delta: 'thinking...' },
          },
        });

        // Wait beyond the backfill grace window, then mark the assistant message as available and emit idle.
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        assistantReady = true;
        client.__setStatusType('idle');
        client.__emit({
          directory: '/tmp',
          payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
        });

        await expect(promptPromise).resolves.toBeUndefined();
        await flushTranscriptCommitMicrotasks();

        const committedCalls = getCommittedTranscriptRows(session, { type: 'message' }).filter(
          (row) => typeof row.meta.happierStreamKey === 'string' && row.meta.happierStreamKey.length > 0,
        );
        const matching = committedCalls.filter((row) => String(row.meta.happierStreamKey).includes('msg_asst_long_turn_1'));
        expect(matching.length).toBeGreaterThan(0);
        expect(new Set(matching.map((row) => row.localId)).size).toBe(1);
        expect(matching[matching.length - 1]?.body?.message).toContain('LONG_TURN_ASSISTANT_OUTPUT_OK');
        expect(matching[matching.length - 1]?.meta?.happierStreamSegmentV1).toMatchObject({
          segmentState: 'complete',
        });
      } finally {
        await runtime.cancel().catch(() => {});
        await runtime.reset().catch(() => {});
      }
    } finally {
      if (prevPollInterval === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      }
      if (prevStatusPoll === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
      }
      if (prevBackfillGrace === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_ASSISTANT_BACKFILL_GRACE_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_ASSISTANT_BACKFILL_GRACE_MS = prevBackfillGrace;
      }
    }
  });

  it('waits for the OpenCode session to become idle before sending a new prompt (avoids busy-session wedges after abort)', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    const prevPrePromptWaitMs = process.env.HAPPIER_OPENCODE_SERVER_PREPROMPT_IDLE_WAIT_MS;
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    process.env.HAPPIER_OPENCODE_SERVER_PREPROMPT_IDLE_WAIT_MS = '5000';
    try {
      const client = createFakeClient() as any;
      const session = createFakeSession();

      let statusType: 'busy' | 'idle' = 'busy';
      let statusCalls = 0;
      const callSequence: string[] = [];
      client.sessionStatusList = vi.fn(async () => {
        statusCalls += 1;
        if (statusCalls >= 2) statusType = 'idle';
        callSequence.push(`status:${statusType}`);
        return { ses_1: { type: statusType } };
      });
      client.sessionPromptAsync = vi.fn(async () => {
        callSequence.push('prompt');
        if (statusType !== 'idle') {
          throw new Error('session is busy');
        }
      });

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

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-preprompt-idle' });
      await expect.poll(() => (client.sessionPromptAsync as any).mock.calls.length).toBe(1);
      expect(callSequence.indexOf('prompt')).toBeGreaterThanOrEqual(0);
      expect(callSequence.indexOf('prompt')).toBeGreaterThan(callSequence.findIndex((v) => v === 'status:idle'));

      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_asst_1', partID: 'part_1', delta: 'hi' } },
      });
      client.__emit({
        directory: '/tmp',
        payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } },
      });

      await expect(promptPromise).resolves.toBeUndefined();
      expect((client.sessionPromptAsync as any).mock.calls.length).toBe(1);
      expect((client.sessionStatusList as any).mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      if (prevPollInterval === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      }
      if (prevStatusPoll === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
      }
      if (prevPrePromptWaitMs === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_PREPROMPT_IDLE_WAIT_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_PREPROMPT_IDLE_WAIT_MS = prevPrePromptWaitMs;
      }
    }
  });

  it('backfills assistant text from the control plane when idle is observed but SSE deltas were missed (streams with happierStreamKey)', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    try {
      const client = createFakeClient() as any;
      const session = createFakeSession();

      let promptSent = false;
      client.sessionPromptAsync = vi.fn(async () => {
        promptSent = true;
        client.__setStatusType('idle');
      });
      client.sessionMessagesList = vi.fn(async () => {
        if (!promptSent) return [];
        return [
          {
            info: { id: 'msg_asst_backfill_1', role: 'assistant', time: { created: 2 } },
            parts: [{ type: 'text', text: '| col_a | col_b |\\n| --- | --- |\\n| a | b |\\n\\nSTREAM_TABLE_E2E_OK' }],
          },
        ];
      });

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

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'please stream a table', localId: 'local-backfill-1' });
      await expect(promptPromise).resolves.toBeUndefined();
      await flushTranscriptCommitMicrotasks();

      const committedCalls = getCommittedTranscriptRows(session, { type: 'message' }).filter(
        (row) => typeof row?.meta?.happierStreamKey === 'string' && row.meta.happierStreamKey.length > 0,
      );
      const matching = committedCalls.filter((row) => String(row.meta.happierStreamKey).includes('msg_asst_backfill_1'));
      expect(matching.length).toBeGreaterThan(0);
      expect(new Set(matching.map((row) => row.localId)).size).toBe(1);
      expect(matching[matching.length - 1]?.body?.message).toContain('STREAM_TABLE_E2E_OK');
      expect(matching[matching.length - 1]?.meta?.happierStreamSegmentV1).toMatchObject({
        segmentState: 'complete',
      });
    } finally {
      if (prevPollInterval === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      }
      if (prevStatusPoll === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
      }
    }
  });

  it('backfills assistant text from the control plane even when the turn had tool/thinking activity but no assistant text chunks were streamed', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    try {
      const client = createFakeClient() as any;
      const session = createFakeSession();

      let promptSent = false;
      let releasePrompt!: () => void;
      const gate = new Promise<void>((resolve) => {
        releasePrompt = () => resolve();
      });

      client.sessionPromptAsync = vi.fn(async () => {
        await gate;
        promptSent = true;
        client.__setStatusType('idle');
      });

      client.sessionMessagesList = vi.fn(async () => {
        if (!promptSent) return [];
        return [
          {
            info: { id: 'msg_asst_backfill_2', role: 'assistant', time: { created: 2 } },
            parts: [{ type: 'text', text: '| col_a | col_b |\\n| --- | --- |\\n| a | b |\\n\\nSTREAM_TABLE_E2E_OK' }],
          },
        ];
      });

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

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'please stream a table', localId: 'local-backfill-2' });
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      // Simulate turn activity (reasoning deltas), but never stream assistant text deltas.
      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.updated', properties: { part: { id: 'part_reason_1', type: 'reasoning', sessionID: 'ses_1' } } },
      });
      client.__emit({
        directory: '/tmp',
        payload: {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst_backfill_2', partID: 'part_reason_1', delta: 'thinking...' },
        },
      });

      releasePrompt();
      await expect(promptPromise).resolves.toBeUndefined();
      await flushTranscriptCommitMicrotasks();

      const committedCalls = getCommittedTranscriptRows(session, { type: 'message' }).filter(
        (row) => typeof row?.meta?.happierStreamKey === 'string' && row.meta.happierStreamKey.length > 0,
      );
      const matching = committedCalls.filter((row) => String(row.meta.happierStreamKey).includes('msg_asst_backfill_2'));
      const chunks = matching.map((row) => String(row.body?.message ?? ''));
      expect(matching.length).toBeGreaterThan(0);
      expect(new Set(matching.map((row) => row.localId)).size).toBe(1);
      expect(matching[matching.length - 1]?.body?.message).toContain('STREAM_TABLE_E2E_OK');
      expect(matching.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (prevPollInterval === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      }
      if (prevStatusPoll === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
      }
    }
  });

  it('aborts turns when control-plane status polling repeatedly fails (prevents wedged thinking)', async () => {
    const prevPollInterval = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
    const prevStatusPoll = process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
    const prevMaxFailures = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_MAX_CONSECUTIVE_FAILURES;
    const prevGraceMs = process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_FAILURE_GRACE_MS;

    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = '25';
    process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = '1';
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_MAX_CONSECUTIVE_FAILURES = '2';
    process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_FAILURE_GRACE_MS = '1000';
    try {
      const client = createFakeClient() as any;
      client.sessionStatusList = vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1234');
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

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-control-plane-fail' });
      // Avoid unhandled rejections in the RED phase (turn may be canceled in finally).
      void promptPromise.catch(() => {});
      await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

      try {
        await expect.poll(() =>
          session.sendAgentMessage.mock.calls.some((call: any[]) => call?.[0] === 'opencode' && call?.[1]?.type === 'turn_aborted'),
        ).toBe(true);
      } finally {
        await runtime.cancel().catch(() => {});
        await runtime.reset().catch(() => {});
      }

      await expect(promptPromise).rejects.toBeTruthy();
    } finally {
      if (prevPollInterval === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS = prevPollInterval;
      }
      if (prevStatusPoll === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATUS_POLL_ENABLED = prevStatusPoll;
      }
      if (prevMaxFailures === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_MAX_CONSECUTIVE_FAILURES;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_MAX_CONSECUTIVE_FAILURES = prevMaxFailures;
      }
      if (prevGraceMs === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_FAILURE_GRACE_MS;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_CONTROL_POLL_FAILURE_GRACE_MS = prevGraceMs;
      }
    }
  });

  it('surfaces session.error as an agent message (so model failures are visible)', async () => {
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

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-error' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'session.error',
        properties: {
          sessionID: 'ses_1',
          error: {
            name: 'UnknownError',
            data: { message: 'Model not found: openai/does_not_exist.' },
          },
        },
      },
    });

    await expect(promptPromise).rejects.toBeTruthy();

    const errorMessages = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'message',
    );
    expect(errorMessages.length).toBeGreaterThan(0);
    expect(errorMessages[0]?.[1]?.message).toContain('Model not found');
  });

  it('emits tool-result errors with { status: \"failed\" } and omits empty metadata (matches ACP dialect baselines)', async () => {
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

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-tool-error' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'tool_part_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_asst_1',
            callID: 'call_1',
            tool: 'Read',
            state: {
              status: 'error',
              error: 'Error: File not found: /tmp/missing.txt',
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

    const toolResultCalls = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'tool-result',
    );

    expect(toolResultCalls).toHaveLength(1);
    expect(toolResultCalls[0]?.[1]).toMatchObject({
      callId: 'call_1',
      isError: true,
      output: {
        status: 'failed',
        error: 'Error: File not found: /tmp/missing.txt',
      },
    });
    expect(toolResultCalls[0]?.[1]?.output?.metadata).toBeUndefined();
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

	  it('emits a single tool-call when tool updates gain additional input fields (e.g. command)', async () => {
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
	    expect(calls.length).toBe(1);
	    expect((calls[0]?.[1] as any)?.input?.command).toBe('echo hi');
	  });

  it('emits tool-call for tool parts on message.part.created (reduces perceived batching)', async () => {
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

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-tool-created' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.created',
        properties: {
          part: {
            id: 'part_tool_created_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_1',
            callID: 'call_created_1',
            tool: 'bash',
            state: { status: 'running', input: { command: 'echo hi' } },
          },
        },
      },
    });

    // Ensure turn completion still proceeds even if tool activity is missed.
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

    const toolCalls = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'tool-call' && c?.[1]?.callId === 'call_created_1',
    );
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]?.[1]?.name).toBe('bash');
  });

  it('aliases OpenCode grep tool to search (normalizes downstream to CodeSearch)', async () => {
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

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-grep-alias' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part_tool_grep_1',
            type: 'tool',
            sessionID: 'ses_1',
            messageID: 'msg_tool_grep_1',
            callID: 'call_grep_1',
            tool: 'grep',
            state: { status: 'running', input: { pattern: 'TOKEN', path: '/tmp' } },
          },
        },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });
    await expect(promptPromise).resolves.toBeUndefined();

    const toolCalls = session.sendAgentMessage.mock.calls.filter(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'tool-call' && c?.[1]?.callId === 'call_grep_1',
    );
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]?.[1]?.name).toBe('search');
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
    expect(client.sessionMessagesList).toHaveBeenCalledTimes(1);
    expect(client.sessionMessagesList).toHaveBeenCalledWith({ sessionId: 'ses_remote' });
    expect(session.sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(session.sendUserTextMessageCommitted).not.toHaveBeenCalled();
  });

  it('streams Task child session deltas and tool calls into a sidechain (during the turn)', async () => {
    const client = createFakeClient() as any;
    client.sessionMessagesList = vi.fn(async () => ([] as unknown[]));

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

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-task-sidechain-stream' });
    await expect.poll(() => client.sessionPromptAsync.mock.calls.length).toBe(1);

    // Parent Task tool part references a child session early via metadata.
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
              status: 'running',
              input: { description: 'Run child' },
              metadata: { sessionId: 'ses_child_1' },
            },
          },
        },
      },
    });

    // Child session streams text.
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_child_text_1', type: 'text', sessionID: 'ses_child_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_child_1', messageID: 'msg_child_asst_1', partID: 'part_child_text_1', delta: 'CH' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_child_1', messageID: 'msg_child_asst_1', partID: 'part_child_text_1', delta: 'CHILD_OK' } },
    });

    // Child session streams tools.
    client.__emit({
      directory: '/tmp',
      payload: {
        type: 'message.part.created',
        properties: {
          part: {
            id: 'part_child_tool_1',
            type: 'tool',
            sessionID: 'ses_child_1',
            messageID: 'msg_child_tool_1',
            callID: 'call_child_tool_1',
            tool: 'bash',
            state: { status: 'running', input: { command: 'echo child' } },
          },
        },
      },
    });

    // Parent assistant activity so the turn can resolve even if sidechain routing is broken.
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.updated', properties: { part: { id: 'part_parent_text_1', type: 'text', sessionID: 'ses_1' } } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_parent_asst_1', partID: 'part_parent_text_1', delta: 'PARENT_OK' } },
    });
    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    await expect(promptPromise).resolves.toBeUndefined();

    const sidechainText = getCommittedTranscriptRows(session, { type: 'message', sidechainId: 'call_task_1' }).find(
      (row) => row.body?.message === 'CHILD_OK',
    );
    expect(sidechainText).toBeTruthy();
    expect(sidechainText?.meta).toMatchObject({
      importedFrom: 'acp-sidechain',
      remoteSessionId: 'ses_child_1',
      sidechainId: 'call_task_1',
    });
    expect(typeof sidechainText?.meta?.happierStreamKey).toBe('string');
    expect(sidechainText?.meta?.happierSidechainStreamKey).toBe(sidechainText?.meta?.happierStreamKey);

    const sidechainToolCall = session.sendAgentMessage.mock.calls.find(
      (c: any[]) => c?.[0] === 'opencode' && c?.[1]?.type === 'tool-call' && c?.[1]?.sidechainId === 'call_task_1' && c?.[1]?.callId === 'call_child_tool_1',
    );
    expect(sidechainToolCall).toBeTruthy();
    expect(sidechainToolCall?.[2]?.meta).toMatchObject({
      importedFrom: 'acp-sidechain',
      remoteSessionId: 'ses_child_1',
      sidechainId: 'call_task_1',
    });
  });

  it('streams sidechain text as incremental deltas (avoids duplicate prefixes when OpenCode emits cumulative deltas)', async () => {
    const prevFlush = process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS = '50';
    vi.useFakeTimers();
    try {
      const client = createFakeClient() as any;
      client.sessionMessagesList = vi.fn(async () => ([] as unknown[]));

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

      const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-sidechain-incremental' });
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
              state: { status: 'running', input: { description: 'Run child' }, metadata: { sessionId: 'ses_child_1' } },
            },
          },
        },
      });

      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.updated', properties: { part: { id: 'part_child_text_1', type: 'text', sessionID: 'ses_child_1' } } },
      });

      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_child_1', messageID: 'msg_child_asst_1', partID: 'part_child_text_1', delta: 'H' } },
      });
      await vi.advanceTimersByTimeAsync(60);

      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_child_1', messageID: 'msg_child_asst_1', partID: 'part_child_text_1', delta: 'HE' } },
      });
      await vi.advanceTimersByTimeAsync(60);

      const sidechainChunks = getDraftTranscriptRows(session, { segmentKind: 'assistant', sidechainId: 'call_task_1' })
        .map((c) => String(c.deltaText ?? ''));

      expect(sidechainChunks).toEqual(['H', 'E']);

      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.updated', properties: { part: { id: 'part_parent_text_1', type: 'text', sessionID: 'ses_1' } } },
      });
      client.__emit({
        directory: '/tmp',
        payload: { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_parent_asst_1', partID: 'part_parent_text_1', delta: 'PARENT_OK' } },
      });
      client.__emit({
        directory: '/tmp',
        payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      });

      await expect(promptPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
      if (typeof prevFlush === 'string') process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS = prevFlush;
      else delete process.env.HAPPIER_OPENCODE_SERVER_STREAM_DELTA_FLUSH_MS;
    }
  });

	  it('imports Task child session messages as a sidechain (meta.importedFrom="acp-sidechain")', async () => {
	    const client = createFakeClient() as any;
    let resolveChildMessages!: (value: any[]) => void;
    const childMessagesPromise = new Promise<any[]>((resolve) => {
      resolveChildMessages = (value) => resolve(value);
    });
    client.sessionMessagesList = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId !== 'ses_child') return [];
      return await childMessagesPromise;
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
              output:
                'task_id: ses_child (for resuming to continue this task if needed)\\n\\n<task_result>\\nSUBTASK_OK\\n</task_result>',
              title: 'Run subtask',
              metadata: { sessionId: 'ses_child' },
            },
          },
        },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    let didResolve = false;
    void promptPromise.then(() => {
      didResolve = true;
    });

    // Give the runtime a chance to observe the idle signal and start sidechain import.
    // The turn must not resolve while the Task sidechain import is still pending.
    await expect.poll(() => (client.sessionMessagesList as any).mock.calls.some((c: any[]) => c?.[0]?.sessionId === 'ses_child')).toBe(true);
    expect(didResolve).toBe(false);

    resolveChildMessages([
      {
        info: { role: 'assistant', id: 'msg_child_a1', time: { created: 10 }, sessionID: 'ses_child' },
        parts: [{ type: 'text', text: 'SUBTASK_OK' }],
      },
    ]);

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

  it('does not resolve the turn before a late Task sidechain import starts when idle arrives early', async () => {
    const client = createFakeClient() as any;
    client.sessionMessagesList = vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (sessionId === 'ses_child') {
        return [
          {
            info: { role: 'assistant', id: 'msg_child_a1', time: { created: 10 }, sessionID: 'ses_child' },
            parts: [{ type: 'text', text: 'SUBTASK_OK' }],
          },
        ];
      }
      return [];
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

    const promptPromise = (runtime as any).sendPromptWithMeta({ text: 'hello', localId: 'local-task-sidechain-idle-early' });
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
              status: 'running',
              input: { prompt: 'Respond with EXACTLY: SUBTASK_OK' },
            },
          },
        },
      },
    });

    client.__emit({
      directory: '/tmp',
      payload: { type: 'session.idle', properties: { sessionID: 'ses_1' } },
    });

    let didResolve = false;
    void promptPromise.then(() => {
      didResolve = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(didResolve).toBe(false);

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
              output:
                '<task_metadata>\\nsession_id: ses_child\\n</task_metadata>\\n\\n<task_result>\\nSUBTASK_OK\\n</task_result>',
              title: 'Run subtask',
              metadata: { sessionId: 'ses_child' },
            },
          },
        },
      },
    });

    await expect(promptPromise).resolves.toBeUndefined();
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
