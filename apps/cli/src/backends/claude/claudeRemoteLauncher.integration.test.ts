import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { Session } from './session';
import type { EnhancedMode } from './loop';
import { readFile } from 'node:fs/promises';

vi.mock('@/agent/runtime/createHappierMcpBridge', () => ({
  createHappierMcpBridge: vi.fn(async () => ({
    happierMcpServer: { url: 'http://127.0.0.1:1234', stop: vi.fn() },
    mcpServers: {
      happier: {
        command: 'node',
        args: ['happier-mcp.mjs', '--url', 'http://127.0.0.1:1234'],
      },
    },
  })),
}));

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
    getMetadataSnapshot: () => (options as any)?.metadata ?? null,
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

  it('flushes agent-team inbox messages on shutdown', async () => {
    const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const tmpRoot = await mkdtemp(join(tmpdir(), 'happier-claude-team-inbox-'));
    const claudeConfigDir = join(tmpRoot, 'claude-config');
    const teamName = 'happier-ui-test';
    const inboxDir = join(claudeConfigDir, 'teams', teamName, 'inboxes');
    const leadInboxPath = join(inboxDir, 'team-lead.json');

    try {
      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
      await mkdir(inboxDir, { recursive: true });
      await writeFile(
        leadInboxPath,
        JSON.stringify(
          [
            {
              from: 'Alpha',
              text: 'hello from alpha',
              timestamp: 't1',
              read: false,
            },
          ],
          null,
          2,
        ),
        'utf-8',
      );

      const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
      const dispatchStarted = createDeferred<void>();

      const toolUseIdAlpha = 'toolu_alpha_1';

      mockConvert
        .mockReturnValueOnce({
          type: 'assistant',
          uuid: 'u_team_create',
          message: {
            role: 'assistant',
            model: 'test',
            content: [{ type: 'tool_use', id: 'toolu_team_create_1', name: 'AgentTeamCreate', input: { team_name: teamName } }],
          },
        })
        .mockReturnValueOnce({
          type: 'assistant',
          uuid: 'u_spawn_alpha',
          message: {
            role: 'assistant',
            model: 'test',
            content: [{ type: 'tool_use', id: toolUseIdAlpha, name: 'Agent', input: { team_name: teamName, name: 'Alpha' } }],
          },
        })
        .mockReturnValue(null);

      mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        dispatchStarted.resolve(undefined);
        // Minimal SDK messages; converter is mocked so shape doesn't matter beyond type checks.
        dispatchOpts.onMessage?.({ type: 'assistant', uuid: 'sdk_u1', message: { role: 'assistant', content: [] } });
        dispatchOpts.onMessage?.({ type: 'assistant', uuid: 'sdk_u2', message: { role: 'assistant', content: [] } });
        await waitForAbort(dispatchOpts.signal);
      });

      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(session);

      const switchHandler = await switchHandlerReady;
      await dispatchStarted.promise;

      expect(await switchHandler({ to: 'local' })).toBe(true);
      await expect(launcherPromise).resolves.toBe('switch');

      const afterRaw = await readFile(leadInboxPath, 'utf-8');
      const after = JSON.parse(afterRaw);
      expect(Array.isArray(after)).toBe(true);
      expect(after[0]?.read).toBe(true);
    } finally {
      if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('backfills agent-team inbox mapping from transcriptPath on startup', async () => {
    const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const tmpRoot = await mkdtemp(join(tmpdir(), 'happier-claude-team-inbox-seed-'));
    const claudeConfigDir = join(tmpRoot, 'claude-config');
    const teamName = 'happier-ui-test';
    const inboxDir = join(claudeConfigDir, 'teams', teamName, 'inboxes');
    const leadInboxPath = join(inboxDir, 'team-lead.json');
    const transcriptPath = join(tmpRoot, 'sess_0.jsonl');

    try {
      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
      await mkdir(inboxDir, { recursive: true });
      await writeFile(
        leadInboxPath,
        JSON.stringify(
          [
            {
              from: 'Alpha',
              text: 'hello from alpha (seed)',
              timestamp: 't1',
              read: false,
            },
          ],
          null,
          2,
        ),
        'utf-8',
      );

      // Minimal transcript history that establishes the team name + maps Alpha -> tool_use id.
      const transcriptLines = [
        JSON.stringify({
          type: 'assistant',
          uuid: 'u_team_create',
          message: {
            role: 'assistant',
            model: 'test',
            content: [{ type: 'tool_use', id: 'toolu_team_create_1', name: 'AgentTeamCreate', input: { team_name: teamName } }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'u_spawn_alpha',
          message: {
            role: 'assistant',
            model: 'test',
            content: [{ type: 'tool_use', id: 'toolu_alpha_1', name: 'Agent', input: { team_name: teamName, name: 'Alpha' } }],
          },
        }),
        '',
      ].join('\n');
      await writeFile(transcriptPath, transcriptLines, 'utf-8');

      const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
      session.transcriptPath = transcriptPath;

      const dispatchStarted = createDeferred<void>();
      mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as RemoteDispatchMockOptions;
        dispatchStarted.resolve(undefined);
        await waitForAbort(dispatchOpts.signal);
      });

      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(session);

      const switchHandler = await switchHandlerReady;
      await dispatchStarted.promise;

      expect(await switchHandler({ to: 'local' })).toBe(true);
      await expect(launcherPromise).resolves.toBe('switch');

      const afterRaw = await readFile(leadInboxPath, 'utf-8');
      const after = JSON.parse(afterRaw);
      expect(Array.isArray(after)).toBe(true);
      expect(after[0]?.read).toBe(true);
    } finally {
      if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

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

  it('passes through user --mcp-config args and does not parse/merge them into happier MCP config before dispatch', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    const dispatchStarted = createDeferred<void>();

    const userMcpConfig = JSON.stringify({
      mcpServers: {
        custom: { type: 'http', url: 'http://127.0.0.1:9999' },
      },
    });
    session.claudeArgs = ['--mcp-config', userMcpConfig, '--max-turns', '3'];

    let captured: any = null;
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      captured = opts as any;
      dispatchStarted.resolve(undefined);
      await waitForAbort((captured as any)?.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await dispatchStarted.promise;
    expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(1);

    expect(Array.isArray(captured?.claudeArgs)).toBe(true);
    expect(captured?.claudeArgs).toEqual(['--mcp-config', userMcpConfig, '--max-turns', '3']);

    const parsed = JSON.parse(String(captured?.happierMcpConfigJson ?? 'null'));
    expect(parsed?.mcpServers?.happier).toBeTruthy();
    expect(parsed?.mcpServers?.custom).toBeUndefined();

    expect(Object.prototype.hasOwnProperty.call(captured?.happierMcpServers ?? {}, 'happier')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(captured?.happierMcpServers ?? {}, 'custom')).toBe(false);

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('passes resumeSessionAt from metadata snapshot into the remote dispatch options', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({
      sessionId: 'sess_0',
      metadata: { claudeLastAssistantUuid: 'asst_uuid_1' },
    } as any);

    const dispatchStarted = createDeferred<void>();
    let capturedOpts: any = null;
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      capturedOpts = opts as any;
      dispatchStarted.resolve(undefined);
      await waitForAbort((capturedOpts as any).signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await dispatchStarted.promise;

    expect(capturedOpts?.resumeSessionAt).toBe('asst_uuid_1');

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('includes Claude Code debug/stderr tails and exits on exit code 1 (no tight retries)', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'happy-claude-exit1-'));
    try {
      const debugFilePath = join(tmpRoot, 'claude-code-debug.log');
      const stderrFilePath = join(tmpRoot, 'claude-code-stderr.log');
      await writeFile(debugFilePath, ['debug one', 'debug two', 'debug tail'].join('\n') + '\n');
      await writeFile(stderrFilePath, ['stderr one', 'stderr tail'].join('\n') + '\n');

      const exitError = new Error('Claude Code process exited with code 1');
      (exitError as any).happierClaudeCodeArtifacts = {
        debugFilePath,
        stderrFilePath,
      };

      mockClaudeRemoteDispatch.mockRejectedValueOnce(exitError);

      const { session } = createRemoteHarness({ sessionId: 'sess_0' });
      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');

      await expect(claudeRemoteLauncher(session)).resolves.toBe('exit');
      expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(1);

      const sent = (session.client.sendSessionEvent as any).mock.calls
        .map((call: any[]) => call?.[0]?.message)
        .filter((value: unknown) => typeof value === 'string')
        .join('\n');

      expect(sent).toContain('Claude Code process exited with code 1');
      expect(sent).toContain('debug tail');
      expect(sent).toContain('stderr tail');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('persists the last assistant uuid into session metadata when observed in remote messages', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });

    const dispatchStarted = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      dispatchStarted.resolve(undefined);
      dispatchOpts.onMessage?.({
        type: 'assistant',
        uuid: 'asst_uuid_2',
        session_id: 'sess_0',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      });
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await dispatchStarted.promise;

    expect(client.updateMetadata).toHaveBeenCalled();
    const updater = (client.updateMetadata as any).mock.calls[0][0];
    expect(updater({})).toEqual(expect.objectContaining({ claudeLastAssistantUuid: 'asst_uuid_2' }));

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('does not persist assistant uuids from sidechain messages (parent_tool_use_id)', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });

    const dispatchStarted = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      dispatchStarted.resolve(undefined);
      dispatchOpts.onMessage?.({
        type: 'assistant',
        uuid: 'asst_uuid_sidechain',
        session_id: 'sess_0',
        parent_tool_use_id: 'toolu_parent',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi from sidechain' }] },
      });
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await dispatchStarted.promise;

    const updateCalls = (client.updateMetadata as any).mock.calls ?? [];
    for (const [updater] of updateCalls) {
      expect(typeof updater).toBe('function');
      expect(updater({})).not.toHaveProperty('claudeLastAssistantUuid');
    }

    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
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

  it('injects Happier MCP servers into the remote dispatch options', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      expect(dispatchOpts?.happierMcpServers?.happier).toBeTruthy();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await vi.waitFor(() => {
      expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(1);
    });

    const switchHandler = await switchHandlerReady;
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

        const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        try {
          process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

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
          if (typeof previousClaudeConfigDir === 'string') {
            process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
          } else {
            delete process.env.CLAUDE_CONFIG_DIR;
          }
          await rm(claudeConfigDir, { recursive: true, force: true });
        }
      }, 30_000);
});
