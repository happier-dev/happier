import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { Session } from './session';
import type { EnhancedMode } from './loop';

type RpcHandler = (params?: any) => any | Promise<any>;
type SessionFoundHookData = NonNullable<Parameters<Session['onSessionFound']>[1]>;
type RemoteDispatchMockOptions = {
  signal?: AbortSignal;
  onSessionFound?: (sessionId: string) => void;
};

const mockInkRender = vi.fn(() => ({ unmount: vi.fn() }));
vi.mock('ink', () => ({
  render: mockInkRender,
}));

const mockClaudeRemoteDispatch = vi.fn<(opts: unknown) => Promise<void>>();
vi.mock('./remote/claudeRemoteDispatch', () => ({
  claudeRemoteDispatch: mockClaudeRemoteDispatch,
}));

const mockResetParentChain = vi.fn();
const mockUpdateSessionId = vi.fn();
const mockConvert = vi.fn();
const mockConvertSidechainUserMessage = vi.fn();
const mockGenerateInterruptedToolResult = vi.fn();
vi.mock('./utils/sdkToLogConverter', () => ({
  SDKToLogConverter: vi.fn().mockImplementation(() => ({
    resetParentChain: mockResetParentChain,
    updateSessionId: mockUpdateSessionId,
    convert: (...args: any[]) => mockConvert(...args),
    convertSidechainUserMessage: (...args: any[]) => mockConvertSidechainUserMessage(...args),
    generateInterruptedToolResult: (...args: any[]) => mockGenerateInterruptedToolResult(...args),
  })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    warn: vi.fn(),
  },
}));

type SessionClientStub = SessionClientPort & {
  rpcHandlerManager: {
    registerHandler: (method: string, handler: any) => void;
    invokeLocal: (method: string, params: unknown) => Promise<unknown>;
  };
};

type RemoteHarness = {
  session: Session;
  client: SessionClientStub;
  sendClaudeSessionMessage: ReturnType<typeof vi.fn>;
  switchHandlerReady: Promise<RpcHandler>;
};

const createdSessions: Session[] = [];

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function hookWithTranscript(transcriptPath: string): SessionFoundHookData {
  return { transcript_path: transcriptPath };
}

function createRemoteHarness(options?: { sessionId?: string | null }): RemoteHarness {
  const switchDeferred = createDeferred<RpcHandler>();
  const sendClaudeSessionMessage = vi.fn();

  const client: SessionClientStub = {
    sessionId: 'happy_sess_1',
    sendAgentMessage: vi.fn(),
    keepAlive: vi.fn(),
    updateMetadata: vi.fn(),
    updateAgentState: vi.fn((updater) => updater({})),
    rpcHandlerManager: {
      registerHandler: vi.fn((method: string, handler: any) => {
        if (method === 'switch') {
          switchDeferred.resolve(handler);
        }
      }),
      invokeLocal: vi.fn(async () => ({})),
    },
    sendClaudeSessionMessage,
    sendSessionEvent: vi.fn(),
    getMetadataSnapshot: () => null,
    waitForMetadataUpdate: vi.fn(async () => false),
    popPendingMessage: vi.fn(async () => false),
    peekPendingMessageQueueV2Count: vi.fn(async () => 0),
    discardPendingMessageQueueV2All: vi.fn(async () => 0),
    discardCommittedMessageLocalIds: vi.fn(async () => 0),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  };

  const sendToAllDevices = vi.fn();
  const session = new Session({
    client,
    pushSender: { sendToAllDevices } as any,
    path: '/tmp',
    logPath: '/tmp/log',
    sessionId: options?.sessionId ?? null,
    mcpServers: {},
    messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
    onModeChange: () => {},
    hookSettingsPath: '/tmp/hooks.json',
  });

  createdSessions.push(session);

  return {
    session,
    client,
    sendClaudeSessionMessage,
    switchHandlerReady: switchDeferred.promise,
  };
}

describe.sequential('claudeRemoteLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConvert.mockReturnValue(null);
    mockConvertSidechainUserMessage.mockReturnValue(null);
    mockGenerateInterruptedToolResult.mockReturnValue(null);
  });

  afterEach(() => {
    for (const session of createdSessions.splice(0)) {
      session.cleanup();
    }
  });

  it('does not double-reset parent chain when sessionId changes during a remote run', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    const secondDispatchStarted = createDeferred<void>();

    mockClaudeRemoteDispatch
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as RemoteDispatchMockOptions;
        dispatchOpts.onSessionFound?.('sess_1');
      })
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as RemoteDispatchMockOptions;
        secondDispatchStarted.resolve(undefined);
        await waitForAbort(dispatchOpts.signal);
      });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await secondDispatchStarted.promise;

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');

    expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(2);
    expect(mockResetParentChain).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('does not mount Ink UI for daemon-started sessions even when a TTY is available', async () => {
    const originalStdoutIsTTY = process.stdout.isTTY;
    const originalStdinIsTTY = process.stdin.isTTY;

    process.stdout.isTTY = true;
    process.stdin.isTTY = true;

    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    (session as any).startedBy = 'daemon';

    mockInkRender.mockClear();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions;
      await waitForAbort(dispatchOpts.signal);
    });

    try {
      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(session);

      await vi.waitFor(() => {
        expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(1);
      });

      expect(mockInkRender).not.toHaveBeenCalled();

      const switchHandler = await switchHandlerReady;
      expect(await switchHandler({ to: 'local' })).toBe(true);
      await expect(launcherPromise).resolves.toBe('switch');
    } finally {
      process.stdout.isTTY = originalStdoutIsTTY;
      process.stdin.isTTY = originalStdinIsTTY;
    }
  }, 30_000);

  it('respects switch RPC params and is idempotent', async () => {
    const { session, switchHandlerReady } = createRemoteHarness();

    session.onSessionFound('sess_1', hookWithTranscript('/tmp/sess_1.jsonl'));

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions;
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');

    const launcherPromise = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;

    expect(await switchHandler({ to: 'remote' })).toBe(false);
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('treats null sessionId as a new session boundary', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: null });

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions;
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');

    const launcherPromise = claudeRemoteLauncher(session);
    const switchHandler = await switchHandlerReady;

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');

    expect(mockResetParentChain).toHaveBeenCalledTimes(1);
  });

	  it('replaces TaskOutput tool_result transcript payloads with an empty string (content is streamed via sidechain)', async () => {
	    const { session, sendClaudeSessionMessage, switchHandlerReady } = createRemoteHarness();

    const taskOutputToolUseId = 'tool_taskoutput_1';

    // Emit a "TaskOutput" tool_use followed by its tool_result.
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & { onMessage?: (m: unknown) => void };

      dispatchOpts.onMessage?.({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: taskOutputToolUseId,
              name: 'TaskOutput',
              input: { task_id: 'task_1' },
            },
          ],
        },
      });

      // Valid RawJSONLinesSchema record; includes agentId so TaskOutput importer considers it.
      const jsonl = JSON.stringify({ type: 'assistant', uuid: 'uuid_1', agentId: 'agent_1' });

      dispatchOpts.onMessage?.({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: taskOutputToolUseId,
              content: jsonl,
            },
          ],
        },
      });

      await waitForAbort(dispatchOpts.signal);
    });

    // Convert the SDK user message into a RawJSONLines-ish shape that claudeRemoteLauncher rewrites.
    mockConvert.mockImplementation((message: any) => {
      if (message?.type !== 'user') return null;
      const content = Array.isArray(message?.message?.content)
        ? message.message.content.map((item: any) => ({ ...item }))
        : message?.message?.content;
      return {
        type: 'user',
        uuid: 'happy_uuid_1',
        message: { content },
      };
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
	    const launcherPromise = claudeRemoteLauncher(session);

	    await vi.waitFor(() => {
	      expect(sendClaudeSessionMessage).toHaveBeenCalled();
	    });

	    const sent = sendClaudeSessionMessage.mock.calls
	      .map((c: any[]) => c[0])
	      .find((m: any) => {
	      const blocks = m?.message?.content;
	      if (!Array.isArray(blocks)) return false;
	      return blocks.some((b: any) => b?.type === 'tool_result' && b?.tool_use_id === taskOutputToolUseId);
	    });
    expect(sent).toBeTruthy();

    const blocks = (sent as any).message.content as any[];
    const toolResult = blocks.find((b) => b?.type === 'tool_result' && b?.tool_use_id === taskOutputToolUseId);
    expect(toolResult?.content).toBe('');
    expect(String(toolResult?.content)).not.toContain('TaskOutput');
    expect(String(toolResult?.content)).not.toContain('imported=');
    expect(String(toolResult?.content)).not.toContain('buffered=');

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('imports Task subagent output_file JSONL as sidechain messages (without TaskOutput)', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness();

    const dir = await mkdtemp(join(tmpdir(), 'happy-remote-subagent-jsonl-'));
    const agentId = 'aa5e728';
    const jsonlPath = join(dir, `agent-${agentId}.jsonl`);
    const outputSymlinkPath = join(dir, `${agentId}.output`);

    const rootPrompt = {
      type: 'user',
      uuid: 'u1',
      isSidechain: true,
      agentId,
      message: { role: 'user', content: 'Do work' },
    };
    const assistant = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };

    await writeFile(jsonlPath, `${JSON.stringify(rootPrompt)}\n${JSON.stringify(assistant)}\n`, 'utf8');
    await symlink(jsonlPath, outputSymlinkPath);

    try {
      mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as RemoteDispatchMockOptions & { onMessage?: (m: unknown) => void };

        dispatchOpts.onMessage?.({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool_task_1',
                name: 'Task',
                input: { prompt: 'do work' },
              },
            ],
          },
        });

        dispatchOpts.onMessage?.({
          type: 'user',
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_task_1',
                content: `Async agent launched successfully.\nagentId: ${agentId}\noutput_file: ${outputSymlinkPath}\n`,
              },
            ],
          },
        });

        // Simulate file growth and ensure the collector can import incrementally.
        await appendFile(jsonlPath, `${JSON.stringify({ ...assistant, uuid: 'a2' })}\n`, 'utf8');

        await waitForAbort(dispatchOpts.signal);
      });

      // Ignore normal SDK-to-log conversions; we only care about imported file records.
      mockConvert.mockReturnValue(null);

      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(session);

      await vi.waitFor(() => {
        expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'assistant', uuid: 'a1', sidechainId: 'tool_task_1' }),
          expect.objectContaining({ importedFrom: 'claude-subagent-file', claudeAgentId: agentId, sidechainId: 'tool_task_1' }),
        );
      });

      await vi.waitFor(() => {
        expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'assistant', uuid: 'a2', sidechainId: 'tool_task_1' }),
          expect.objectContaining({ importedFrom: 'claude-subagent-file', claudeAgentId: agentId, sidechainId: 'tool_task_1' }),
        );
      });

      const switchHandler = await switchHandlerReady;
      expect(await switchHandler({ to: 'local' })).toBe(true);
      await expect(launcherPromise).resolves.toBe('switch');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('imports Task subagent JSONL from inferred ~/.claude projects path when output_file is missing', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness();

    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happy-claude-config-'));
    const agentId = 'aa5e728';
    const claudeSessionId = 'claude_session_1';

    const { getProjectPath } = await import('./utils/path');
    const projectDir = getProjectPath(session.path, claudeConfigDir);
    const subagentsDir = join(projectDir, claudeSessionId, 'subagents');
    await mkdir(subagentsDir, { recursive: true });

    const jsonlPath = join(subagentsDir, `agent-${agentId}.jsonl`);

    const rootPrompt = {
      type: 'user',
      uuid: 'u1',
      isSidechain: true,
      agentId,
      message: { role: 'user', content: 'Do work' },
    };
    const assistant = {
      type: 'assistant',
      uuid: 'a1',
      isSidechain: true,
      agentId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    };

    await writeFile(jsonlPath, `${JSON.stringify(rootPrompt)}\n${JSON.stringify(assistant)}\n`, 'utf8');

    try {
      (session as any).claudeEnvVars = { CLAUDE_CONFIG_DIR: claudeConfigDir };

      mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as RemoteDispatchMockOptions & { onMessage?: (m: unknown) => void };

        dispatchOpts.onMessage?.({
          type: 'assistant',
          session_id: claudeSessionId,
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tool_task_1',
                name: 'Task',
                input: { prompt: 'do work' },
              },
            ],
          },
        });

        dispatchOpts.onMessage?.({
          type: 'user',
          session_id: claudeSessionId,
          parent_tool_use_id: null,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool_task_1',
                content: `Async agent launched successfully.\nagentId: ${agentId}\n`,
              },
            ],
          },
        });

        await waitForAbort(dispatchOpts.signal);
      });

      // Ignore normal SDK-to-log conversions; we only care about imported file records.
      mockConvert.mockReturnValue(null);

      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(session);

      await vi.waitFor(() => {
        expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'assistant', uuid: 'a1', sidechainId: 'tool_task_1' }),
          expect.objectContaining({ importedFrom: 'claude-subagent-file', claudeAgentId: agentId, sidechainId: 'tool_task_1' }),
        );
      });

      const switchHandler = await switchHandlerReady;
      expect(await switchHandler({ to: 'local' })).toBe(true);
      await expect(launcherPromise).resolves.toBe('switch');
    } finally {
      await rm(claudeConfigDir, { recursive: true, force: true });
    }
  }, 30_000);
});
