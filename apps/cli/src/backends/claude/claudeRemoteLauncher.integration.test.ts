import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';
import { Session } from './session';
import type { EnhancedMode } from './loop';
import { hashClaudeEnhancedModeForQueue } from './remote/modeHash';
import { readFile } from 'node:fs/promises';
import { accountSettingsParse } from '@happier-dev/protocol';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

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

vi.mock('@/integrations/watcher/startFileWatcher', () => ({
  startFileWatcher: (_file: string, onFileChange: (file: string) => void) => {
    // Match the real watcher contract ("watch + read once" consumers are race-free)
    // without spawning long-lived FS watchers in integration tests.
    onFileChange(_file);
    return () => {};
  },
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: () => undefined,
    debugLargeJson: () => undefined,
    warn: () => undefined,
  },
}));

vi.mock('@/lib', () => ({
  logger: {
    debug: () => undefined,
    debugLargeJson: () => undefined,
    warn: () => undefined,
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
  sendToAllDevices: ReturnType<typeof vi.fn>;
  sendClaudeSessionMessage: ReturnType<typeof vi.fn>;
  abortHandlerReady: Promise<RpcHandler>;
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
  const abortDeferred = createDeferred<RpcHandler>();
  const sendClaudeSessionMessage = vi.fn();

  const client: SessionClientStub = {
    sessionId: 'happy_sess_1',
    sendAgentMessage: vi.fn(),
    keepAlive: vi.fn(),
    updateMetadata: vi.fn(),
    updateAgentState: vi.fn((updater) => updater({})),
    rpcHandlerManager: {
      registerHandler: vi.fn((method: string, handler: any) => {
        if (method === 'abort') {
          abortDeferred.resolve(handler);
        }
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
    messageQueue: new MessageQueue2<EnhancedMode>(hashClaudeEnhancedModeForQueue),
    onModeChange: () => {},
    hookSettingsPath: '/tmp/hooks.json',
  });

  createdSessions.push(session);

  return {
    session,
    client,
    sendToAllDevices,
    sendClaudeSessionMessage,
    abortHandlerReady: abortDeferred.promise,
    switchHandlerReady: switchDeferred.promise,
  };
}

describe.sequential('claudeRemoteLauncher', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setActiveAccountSettingsSnapshot({
      source: 'none',
      settings: accountSettingsParse({}),
      settingsVersion: 0,
      loadedAtMs: 0,
      settingsSecretsReadKeys: [],
    });
    mockConvert.mockReturnValue(null);
    mockConvertSidechainUserMessage.mockReturnValue(null);
    mockGenerateInterruptedToolResult.mockReturnValue(null);
    mockClaudeRemoteDispatch.mockImplementation(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions;
      await waitForAbort(dispatchOpts.signal);
    });
  });

  it('interrupts the current turn before switching to local mode when a turn interrupt handler is available', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchObserved = createDeferred<void>();
    const interruptObserved = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      opts.onSessionFound?.('sess_agent_sdk', hookWithTranscript('/tmp/sess_agent_sdk.jsonl'));
      opts.setTurnInterrupt?.(async () => {
        interruptObserved.resolve();
      });
      dispatchObserved.resolve();
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');

    await waitWithin(Promise.resolve(switchHandler({ to: 'local' })), 'switch handler did not resolve');
    await waitWithin(interruptObserved.promise, 'turn interrupt was not invoked during switch');

    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');
  });

  it('surfaces a turn_aborted agent message when abort is requested and a turn interrupt handler is available', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchObserved = createDeferred<void>();
    const interruptObserved = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      opts.onSessionFound?.('sess_agent_sdk', hookWithTranscript('/tmp/sess_agent_sdk.jsonl'));
      opts.setTurnInterrupt?.(async () => {
        interruptObserved.resolve(undefined);
      });
      dispatchObserved.resolve(undefined);
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');
    const abortHandler = await waitWithin(harness.abortHandlerReady, 'abort handler was not registered');
    await abortHandler();
    await waitWithin(interruptObserved.promise, 'turn interrupt was not invoked during abort');

    const agentMessages = (harness.client.sendAgentMessage as any).mock.calls.map((call: any[]) => call?.[1]);
    const hasTurnAborted = agentMessages.some((msg: any) => msg?.type === 'turn_aborted');
    expect(hasTurnAborted).toBe(true);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');
  });

  it('does not mark the session as abort-requested when abort is handled via a turn interrupt handler', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();
    const noteAbortRequestedSpy = vi.spyOn(harness.session, 'noteUserAbortRequested');
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchObserved = createDeferred<void>();
    const interruptObserved = createDeferred<void>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      opts.onSessionFound?.('sess_agent_sdk', hookWithTranscript('/tmp/sess_agent_sdk.jsonl'));
      opts.setTurnInterrupt?.(async () => {
        interruptObserved.resolve(undefined);
      });
      dispatchObserved.resolve(undefined);
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');
    const abortHandler = await waitWithin(harness.abortHandlerReady, 'abort handler was not registered');
    await abortHandler();
    await waitWithin(interruptObserved.promise, 'turn interrupt was not invoked during abort');

    expect(noteAbortRequestedSpy).not.toHaveBeenCalled();

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');
  });

  it('clears the stored Claude session id after an exit-code-1 resume failure so subsequent launches do not loop on a dead session', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const deadSessionId = 'dead-session-id';
    const harness = createRemoteHarness({ sessionId: deadSessionId });
    harness.session.queue.push('first', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const firstDispatchObserved = createDeferred<void>();
    const secondDispatchObserved = createDeferred<void>();
    const secondDispatchSessionIdObserved = createDeferred<string | null>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      firstDispatchObserved.resolve();
      expect(opts.sessionId).toBe(deadSessionId);
      throw new Error('Claude Code process exited with code 1');
    });

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      opts.onSessionFound?.('fresh-session-id', hookWithTranscript('/tmp/fresh-session.jsonl'));
      secondDispatchSessionIdObserved.resolve(opts.sessionId ?? null);
      secondDispatchObserved.resolve();
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    await waitWithin(firstDispatchObserved.promise, 'first dispatch did not run');

    harness.session.queue.push('second', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);
    await waitWithin(secondDispatchObserved.promise, 'second dispatch did not run');

    await expect(waitWithin(secondDispatchSessionIdObserved.promise, 'did not observe second dispatch session id')).resolves.toBeNull();

    await waitWithin(Promise.resolve(switchHandler({ to: 'local' })), 'switch handler did not resolve');
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');
  });

  it('does not strip assistant text/thinking blocks when the legacy runner is selected (even if streamed transcript writer is available)', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();

    // Ensure the remote launcher considers streamed transcript writing available.
    (harness.client as any).sendAgentMessageCommitted = vi.fn(async () => {});

    // Seed a first queued message that disables the Agent SDK runner (legacy path).
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: false } as any);

    const dispatchObserved = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      const first = await opts.nextMessage();
      expect(first?.mode?.claudeRemoteAgentSdkEnabled).toBe(false);

      // Ensure switch/exit handlers have session info to work with.
      opts.onSessionFound?.('sess_legacy', hookWithTranscript('/tmp/sess_legacy.jsonl'));

      // Emit a plain assistant message (no tool blocks) as the legacy runner would.
      opts.onMessage?.({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Thinking...' },
            { type: 'text', text: 'Hello from legacy.' },
          ],
        },
      });

      dispatchObserved.resolve();
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');

    await waitWithin(Promise.resolve(switchHandler({ to: 'local' })), 'switch handler did not resolve');

    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');

    // The legacy runner must keep text/thinking content intact when converting.
    const convertedArg = mockConvert.mock.calls[0]?.[0] as any;
    const blocks = Array.isArray(convertedArg?.message?.content) ? convertedArg.message.content : [];
    expect(blocks.some((b: any) => b?.type === 'text' && b?.text === 'Hello from legacy.')).toBe(true);
    expect(blocks.some((b: any) => b?.type === 'thinking' && b?.thinking === 'Thinking...')).toBe(true);
  });

  it('does not strip assistant text/thinking blocks when the Agent SDK runner is selected', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();
    (harness.client as any).sendAgentMessageCommitted = vi.fn(async () => {});
    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchObserved = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      const first = await opts.nextMessage();
      expect(first?.mode?.claudeRemoteAgentSdkEnabled).toBe(true);

      opts.onSessionFound?.('sess_agentsdk', hookWithTranscript('/tmp/sess_agentsdk.jsonl'));
      opts.onMessage?.({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Agent SDK thinking...' },
            { type: 'text', text: 'Hello from Agent SDK.' },
          ],
        },
      });

      dispatchObserved.resolve(undefined);
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');

    await waitWithin(Promise.resolve(switchHandler({ to: 'local' })), 'switch handler did not resolve');
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');

    const convertedArg = mockConvert.mock.calls[0]?.[0] as any;
    const blocks = Array.isArray(convertedArg?.message?.content) ? convertedArg.message.content : [];
    expect(blocks.some((b: any) => b?.type === 'text' && b?.text === 'Hello from Agent SDK.')).toBe(true);
    expect(blocks.some((b: any) => b?.type === 'thinking' && b?.thinking === 'Agent SDK thinking...')).toBe(true);
  });

  it('does not strip assistant text/thinking blocks in the launcher when the Agent SDK runner is selected', async () => {
    const waitWithin = async <T,>(promise: Promise<T>, label: string, ms: number = 5000): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), ms);
          timer.unref?.();
        }),
      ]);
    };

    const harness = createRemoteHarness();
    (harness.client as any).sendAgentMessageCommitted = vi.fn(async () => {});

    harness.session.queue.push('hello', { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } as any);

    const dispatchObserved = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: any) => {
      opts.onRunnerSelected?.('agentSdk');
      const first = await opts.nextMessage();
      expect(first?.mode?.claudeRemoteAgentSdkEnabled).toBe(true);
      opts.onSessionFound?.('sess_agent_sdk', hookWithTranscript('/tmp/sess_agent_sdk.jsonl'));
      opts.onMessage?.({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Thinking...' },
            { type: 'text', text: 'Hello from agent sdk.' },
          ],
        },
      });
      dispatchObserved.resolve(undefined);
      await waitForAbort(opts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(harness.session);

    const switchHandler = await waitWithin(harness.switchHandlerReady, 'switch handler was not registered');
    await waitWithin(dispatchObserved.promise, 'remote dispatch mock did not run');

    await waitWithin(Promise.resolve(switchHandler({ to: 'local' })), 'switch handler did not resolve');
    await expect(waitWithin(launcherPromise, 'launcher did not terminate')).resolves.toBe('switch');

    const convertedArg = mockConvert.mock.calls[0]?.[0] as any;
    const blocks = Array.isArray(convertedArg?.message?.content) ? convertedArg.message.content : [];
    expect(blocks.some((b: any) => b?.type === 'text' && b?.text === 'Hello from agent sdk.')).toBe(true);
    expect(blocks.some((b: any) => b?.type === 'thinking' && b?.thinking === 'Thinking...')).toBe(true);
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

      const { claudeRemoteDispatch } = await import('./remote/claudeRemoteDispatch');
      expect(claudeRemoteDispatch).toBe(mockClaudeRemoteDispatch);

      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
      const launcherPromise = claudeRemoteLauncher(session);

      await vi.waitFor(() => {
        expect(mockClaudeRemoteDispatch).toHaveBeenCalled();
      }, { timeout: 2000 });

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

  it('includes Claude Code debug/stderr tails and keeps the launcher alive on exit code 1 (no tight retries)', async () => {
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

      const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
      const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');

      const launcherPromise = claudeRemoteLauncher(session);

      const deadlineMs = Date.now() + 1500;
      while (Date.now() < deadlineMs) {
        const sent = (session.client.sendSessionEvent as any).mock.calls
          .map((call: any[]) => call?.[0]?.message)
          .filter((value: unknown) => typeof value === 'string')
          .join('\n');
        if (sent.includes('Claude Code process exited with code 1')) break;
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(mockClaudeRemoteDispatch).toHaveBeenCalledTimes(1);

      const sent = (session.client.sendSessionEvent as any).mock.calls
        .map((call: any[]) => call?.[0]?.message)
        .filter((value: unknown) => typeof value === 'string')
        .join('\n');

      expect(sent).toContain('Claude Code process exited with code 1');
      expect(sent).toContain('debug tail');
      expect(sent).toContain('stderr tail');

      const switchHandler = await switchHandlerReady;
      expect(await switchHandler({ to: 'local' })).toBe(true);
      await expect(launcherPromise).resolves.toBe('switch');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('retries after exit code 1 and still delivers subsequent queued prompts', async () => {
    const exitError = new Error('Claude Code process exited with code 1');
    const firstProcessed = createDeferred<void>();
    const restartedFirstSeen = createDeferred<any>();
    const restartedSecondSeen = createDeferred<any>();

    mockClaudeRemoteDispatch
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        await dispatchOpts.nextMessage?.();
        firstProcessed.resolve(undefined);
        throw exitError;
      })
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        restartedFirstSeen.resolve(await dispatchOpts.nextMessage?.());
        restartedSecondSeen.resolve(await dispatchOpts.nextMessage?.());
        await waitForAbort(dispatchOpts.signal);
      });

    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    session.queue.push('hello', { permissionMode: 'default' } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await firstProcessed.promise;
    session.queue.push('again', { permissionMode: 'default' } satisfies EnhancedMode);

    const restartedFirst = await restartedFirstSeen.promise;
    expect(restartedFirst?.message).toContain('again');

    session.queue.push('third', { permissionMode: 'default' } satisfies EnhancedMode);

    const restartedSecond = await restartedSecondSeen.promise;
    expect(restartedSecond?.message).toContain('third');

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('clears the Claude session id after an abort-triggered exit code 1 so the next launch does not keep resuming a dead session', async () => {
    const exitError = new Error('Claude Code process exited with code 1');

    const firstDispatchStarted = createDeferred<void>();
    const secondDispatchObserved = createDeferred<any>();

    mockClaudeRemoteDispatch
      .mockImplementationOnce(async (opts: any) => {
        firstDispatchStarted.resolve(undefined);
        await waitForAbort(opts.signal);
        throw exitError;
      })
      .mockImplementationOnce(async (opts: any) => {
        secondDispatchObserved.resolve({ sessionId: opts.sessionId, transcriptPath: opts.transcriptPath });
        await waitForAbort(opts.signal);
      });

    const { session, abortHandlerReady, switchHandlerReady } = createRemoteHarness({ sessionId: 'dead-session-id' });
    session.queue.push('hello', { permissionMode: 'default' } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await firstDispatchStarted.promise;
    const abortHandler = await abortHandlerReady;
    await abortHandler();

    session.queue.push('after abort', { permissionMode: 'default' } satisfies EnhancedMode);

    const secondDispatch = await secondDispatchObserved.promise;
    expect(secondDispatch.sessionId).toBeNull();

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('relaunches between turns when a spawn-only setting changes (reasoning effort), preserving message order', async () => {
    const firstSeen = createDeferred<any>();
    const secondDispatchFirstSeen = createDeferred<any>();
    const firstDispatchSawRestartBoundary = createDeferred<void>();

    mockClaudeRemoteDispatch
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        const first = await dispatchOpts.nextMessage?.();
        firstSeen.resolve(first);
        const second = await dispatchOpts.nextMessage?.();
        expect(second).toBeNull();
        firstDispatchSawRestartBoundary.resolve(undefined);
      })
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        secondDispatchFirstSeen.resolve(await dispatchOpts.nextMessage?.());
        await waitForAbort(dispatchOpts.signal);
      });

    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });

    session.queue.push('first', {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
      model: 'claude-opus-4-6',
    } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const first = await firstSeen.promise;
    expect(first?.message).toContain('first');

    // Change reasoning effort: this must restart between turns (Agent SDK effort is spawn-only),
    // but the message must be preserved and delivered after restart.
    session.queue.push('second', {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
      model: 'claude-opus-4-6',
      reasoningEffort: 'low',
    } satisfies EnhancedMode);

    await firstDispatchSawRestartBoundary.promise;

    const second = await secondDispatchFirstSeen.promise;
    expect(second?.message).toContain('second');

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('continues to detect mode changes after a relaunch boundary by updating the current mode hash when replaying a pending message', async () => {
    const firstDispatchFirstSeen = createDeferred<any>();
    const firstDispatchSawRestartBoundary = createDeferred<void>();

    const secondDispatchFirstSeen = createDeferred<any>();
    const secondDispatchSawRestartBoundary = createDeferred<void>();

    const thirdDispatchFirstSeen = createDeferred<any>();

    mockClaudeRemoteDispatch
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        firstDispatchFirstSeen.resolve(await dispatchOpts.nextMessage?.());
        expect(await dispatchOpts.nextMessage?.()).toBeNull();
        firstDispatchSawRestartBoundary.resolve(undefined);
      })
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        secondDispatchFirstSeen.resolve(await dispatchOpts.nextMessage?.());
        expect(await dispatchOpts.nextMessage?.()).toBeNull();
        secondDispatchSawRestartBoundary.resolve(undefined);
      })
      .mockImplementationOnce(async (opts: unknown) => {
        const dispatchOpts = opts as any;
        thirdDispatchFirstSeen.resolve(await dispatchOpts.nextMessage?.());
        await waitForAbort(dispatchOpts.signal);
      });

    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });

    session.queue.push('low1', {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
      model: 'claude-opus-4-6',
      reasoningEffort: 'low',
    } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const firstDispatchFirst = await firstDispatchFirstSeen.promise;
    expect(firstDispatchFirst?.message).toContain('low1');

    session.queue.push('max2', {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
      model: 'claude-opus-4-6',
      reasoningEffort: 'max',
    } satisfies EnhancedMode);

    await firstDispatchSawRestartBoundary.promise;

    const secondDispatchFirst = await secondDispatchFirstSeen.promise;
    expect(secondDispatchFirst?.message).toContain('max2');

    session.queue.push('low3', {
      permissionMode: 'default',
      claudeRemoteAgentSdkEnabled: true,
      model: 'claude-opus-4-6',
      reasoningEffort: 'low',
    } satisfies EnhancedMode);

    await secondDispatchSawRestartBoundary.promise;

    const thirdDispatchFirst = await thirdDispatchFirstSeen.promise;
    expect(thirdDispatchFirst?.message).toContain('low3');

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
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

  it('uses Claude session account settings for ready webhook dispatch when no active snapshot is available', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 202,
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const { session, sendToAllDevices, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });
    session.accountSettings = accountSettingsParse({
      notificationChannelsV1: [
        {
          v: 1,
          id: 'webhook-ready',
          kind: 'webhook',
          enabled: true,
          url: 'https://hooks.example.test/ready',
          topics: {
            ready: true,
            permissionRequest: false,
            userActionRequest: false,
          },
          readyIncludeMessageText: false,
        },
      ],
    });

    const dispatchStarted = createDeferred<void>();
    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      dispatchStarted.resolve(undefined);
      await dispatchOpts.onReady?.();
      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const switchHandler = await switchHandlerReady;
    await dispatchStarted.promise;

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    expect(sendToAllDevices).not.toHaveBeenCalled();

    const url = fetchSpy.mock.calls.at(0)?.at(0);
    expect(url).toBe('https://hooks.example.test/ready');

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

    expect(await switchHandler({ to: 'remote' })).toBe(true);
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  });

  it('appends CHANGE_TITLE_INSTRUCTION to the first queued prompt only', async () => {
    const { session, switchHandlerReady } = createRemoteHarness({ sessionId: 'sess_0' });

    const firstSeen = createDeferred<any>();
    const secondSeen = createDeferred<any>();

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as any;
      const first = await dispatchOpts.nextMessage?.();
      firstSeen.resolve(first);
      const second = await dispatchOpts.nextMessage?.();
      secondSeen.resolve(second);
      await waitForAbort(dispatchOpts.signal);
    });

    // Push one message at a time so MessageQueue2 doesn't batch both into a single prompt.
    session.queue.push('hello', { permissionMode: 'default' } satisfies EnhancedMode);

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    const first = await firstSeen.promise;
    expect(first?.message).toContain(CHANGE_TITLE_INSTRUCTION);

    session.queue.push('again', { permissionMode: 'default' } satisfies EnhancedMode);

    const second = await secondSeen.promise;
    expect(second?.message).not.toContain(CHANGE_TITLE_INSTRUCTION);

    const switchHandler = await switchHandlerReady;
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

  it('imports TaskOutput JSONL records into the Task sidechain with claude-taskoutput metadata', async () => {
    const { session, sendClaudeSessionMessage, switchHandlerReady } = createRemoteHarness();

    const taskToolUseId = 'tool_task_1';
    const taskOutputToolUseId = 'tool_taskoutput_1';
    const agentId = 'agent_1';

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & { onMessage?: (m: unknown) => void };

      dispatchOpts.onMessage?.({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: taskToolUseId,
              name: 'Task',
              input: { prompt: 'do work' },
            },
            {
              type: 'tool_use',
              id: taskOutputToolUseId,
              name: 'TaskOutput',
              input: { task_id: agentId, block: true, timeout: 2000 },
            },
          ],
        },
      });

      dispatchOpts.onMessage?.({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: taskToolUseId, content: `agentId: ${agentId}` }],
        },
      });

      dispatchOpts.onMessage?.({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: taskOutputToolUseId,
              content: `${JSON.stringify({
                type: 'assistant',
                uuid: 'uuid_1',
                parentUuid: null,
                timestamp: new Date().toISOString(),
                sessionId: 'sess_1',
                userType: 'external',
                cwd: '/tmp',
                version: '0.0.0',
                gitBranch: 'main',
                isSidechain: true,
                agentId,
                message: { role: 'assistant', content: [{ type: 'text', text: 'SUBTASK_OK' }] },
              })}\n`,
            },
          ],
        },
      });

      dispatchOpts.onMessage?.({
        type: 'result',
        subtype: 'success',
        result: 'DONE_1',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
      });

      await waitForAbort(dispatchOpts.signal);
    });

    mockConvert.mockImplementation((message: any) => {
      if (message?.type !== 'assistant' && message?.type !== 'user') return null;
      const content = Array.isArray(message?.message?.content)
        ? message.message.content.map((item: any) => ({ ...item }))
        : message?.message?.content;
      return {
        type: message.type,
        uuid: `happy_${message.type}_${Math.random().toString(36).slice(2)}`,
        message: { role: message?.message?.role ?? message.type, content },
      };
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await vi.waitFor(() => {
      const imported = sendClaudeSessionMessage.mock.calls.find(
        (c: any[]) => c?.[1]?.importedFrom === 'claude-taskoutput' && c?.[0]?.sidechainId === taskToolUseId,
      );
      expect(imported).toBeTruthy();
    });

    const importedCall = sendClaudeSessionMessage.mock.calls.find(
      (c: any[]) => c?.[1]?.importedFrom === 'claude-taskoutput' && c?.[0]?.sidechainId === taskToolUseId,
    );
    expect(importedCall?.[1]).toMatchObject({
      importedFrom: 'claude-taskoutput',
      claudeTaskOutputToolUseId: taskOutputToolUseId,
      claudeTaskId: agentId,
      claudeAgentId: agentId,
      claudeRemoteSessionId: 'sess_1',
    });
    expect(importedCall?.[0]).toMatchObject({
      type: 'assistant',
      isSidechain: true,
      sidechainId: taskToolUseId,
      message: { role: 'assistant', content: [{ type: 'text', text: 'SUBTASK_OK' }] },
    });

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

  it('emits a canonical Diff transcript tool after a successful write-like turn', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness();

    mockConvert.mockImplementation((message: any) => {
      if (message?.type === 'assistant') {
        const content = Array.isArray(message?.message?.content) ? message.message.content : [];
        return {
          type: 'assistant',
          uuid: `assistant-${content[0]?.id ?? 'msg'}`,
          isSidechain: false,
          message: { role: 'assistant', content },
        };
      }
      if (message?.type === 'user') {
        const content = Array.isArray(message?.message?.content) ? message.message.content : [];
        return {
          type: 'user',
          uuid: `user-${content[0]?.tool_use_id ?? 'msg'}`,
          isSidechain: false,
          message: { role: 'user', content },
        };
      }
      return null;
    });

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & { onMessage?: (m: unknown) => void };

      dispatchOpts.onMessage?.({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool_edit_1',
              name: 'Edit',
              input: { file_path: 'src/app.ts', old_string: 'old', new_string: 'new' },
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
              tool_use_id: 'tool_edit_1',
              content: 'OK',
              is_error: false,
            },
          ],
        },
      });

      dispatchOpts.onMessage?.({
        type: 'result',
        subtype: 'success',
        session_id: 'sess_1',
      });

      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);
    const sendClaudeSessionMessageMock = client.sendClaudeSessionMessage as ReturnType<typeof vi.fn>;

    await vi.waitFor(() => {
      const diffCall = sendClaudeSessionMessageMock.mock.calls.find((call: any[]) => {
        const content = Array.isArray(call?.[0]?.message?.content) ? call[0].message.content : [];
        return content.some((block: any) => block?.type === 'tool_use' && block?.name === 'Diff');
      });
      expect(diffCall).toBeTruthy();
    });

    const diffCall = sendClaudeSessionMessageMock.mock.calls.find((call: any[]) => {
      const content = Array.isArray(call?.[0]?.message?.content) ? call[0].message.content : [];
      return content.some((block: any) => block?.type === 'tool_use' && block?.name === 'Diff');
    });
    const diffCallBlock = diffCall?.[0]?.message?.content?.find((block: any) => block?.type === 'tool_use' && block?.name === 'Diff');
    expect(diffCallBlock?.input?._happier).toMatchObject({
      protocol: 'claude',
      provider: 'claude',
      canonicalToolName: 'Diff',
      sessionChangeScope: 'turn',
      source: 'provider_tool',
    });

    const diffResult = sendClaudeSessionMessageMock.mock.calls.find((call: any[]) => {
      const content = Array.isArray(call?.[0]?.message?.content) ? call[0].message.content : [];
      return content.some((block: any) => block?.type === 'tool_result' && typeof block?.tool_use_id === 'string');
    });
    expect(diffResult).toBeTruthy();

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
  }, 30_000);

  it('inserts a synthetic sidechain prompt root for Agent tool uses (Claude Agent Teams)', async () => {
    const { session, client, switchHandlerReady } = createRemoteHarness();

    mockConvert.mockReturnValue(null);
    mockConvertSidechainUserMessage.mockReturnValue({
      type: 'user',
      uuid: 'u_side_1',
      isSidechain: true,
      sidechainId: 'tool_agent_1',
      message: { role: 'user', content: 'Agent prompt' },
    });

    mockClaudeRemoteDispatch.mockImplementationOnce(async (opts: unknown) => {
      const dispatchOpts = opts as RemoteDispatchMockOptions & { onMessage?: (m: unknown) => void };

      dispatchOpts.onMessage?.({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool_agent_1',
              name: 'Agent',
              input: { prompt: 'Agent prompt' },
            },
          ],
        },
      });

      await waitForAbort(dispatchOpts.signal);
    });

    const { claudeRemoteLauncher } = await import('./claudeRemoteLauncher');
    const launcherPromise = claudeRemoteLauncher(session);

    await vi.waitFor(() => {
      expect(mockConvertSidechainUserMessage).toHaveBeenCalledWith('tool_agent_1', 'Agent prompt');
    });

    await vi.waitFor(() => {
      expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'user', sidechainId: 'tool_agent_1', isSidechain: true }),
        undefined,
      );
    });

    const switchHandler = await switchHandlerReady;
    expect(await switchHandler({ to: 'local' })).toBe(true);
    await expect(launcherPromise).resolves.toBe('switch');
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
