import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { EnhancedMode } from './loop';

const mockQuery = vi.fn();
const ensureJavaScriptRuntimeExecutableMock = vi.fn(async () => '/managed/js-runtime');
const resolveClaudeCliPathMock = vi.fn(() => '/resolved/claude-cli.js');

vi.mock('@/backends/claude/sdk', () => ({
  query: mockQuery,
  AbortError: class AbortError extends Error {},
}));

vi.mock('@/integrations/watcher/awaitFileExist', () => ({
  awaitFileExist: vi.fn(() => {
    throw new Error('awaitFileExist should not be called');
  }),
}));

vi.mock('./utils/claudeCheckSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./utils/claudeCheckSession')>()),
  claudeCheckSession: vi.fn(() => false),
}));

vi.mock('./utils/claudeFindLastSession', () => ({
  claudeFindLastSession: vi.fn(() => 'last-session-id'),
}));

vi.mock('@/lib', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
  },
}));

vi.mock('./utils/remoteSystemPrompt', () => ({
  getClaudeRemoteSystemPrompt: () => 'REMOTE_PROMPT',
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

vi.mock('./utils/resolveClaudeCliPath', () => ({
  resolveClaudeCliPath: resolveClaudeCliPathMock,
}));

type RemoteOptions = Parameters<(typeof import('./claudeRemote'))['claudeRemote']>[0];
type QueryCall = Readonly<{
  prompt?: AsyncIterable<SDKUserMessage>;
  onPromptTransportOutcome?: (
    message: SDKUserMessage,
    outcome: 'accepted' | 'rejected_before_effect' | 'effect_may_have_occurred',
  ) => void;
  options?: Readonly<{
    resume?: string;
    continue?: boolean;
    extraArgs?: readonly string[];
    env?: Readonly<Record<string, string>>;
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
    executable?: string;
    includeHookEvents?: boolean;
  }>;
}>;

function resultMessage(): SDKMessage {
  return { type: 'result' };
}

function systemInitMessage(sessionId: string): SDKMessage {
  return { type: 'system', subtype: 'init', session_id: sessionId };
}

function defaultMode(overrides?: Partial<EnhancedMode>): EnhancedMode {
  return {
    permissionMode: 'default',
    ...overrides,
  };
}

async function* messageStream(...messages: SDKMessage[]): AsyncGenerator<SDKMessage, void, void> {
  for (const message of messages) {
    yield message;
  }
}

function createBaseOptions(overrides?: Partial<RemoteOptions>): RemoteOptions {
  return {
    sessionId: null,
    transcriptPath: null,
    path: '/tmp',
    hookSettingsPath: '/tmp/hooks.json',
    happierMcpConfigJson: undefined,
    canCallTool: vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} })),
    isAborted: () => false,
    nextMessage: async () => ({ message: 'hello', mode: defaultMode() }),
    onReady: vi.fn(),
    onSessionFound: vi.fn(),
    onMessage: vi.fn(),
    ...overrides,
  };
}

describe('claudeRemote', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    ensureJavaScriptRuntimeExecutableMock.mockReset();
    ensureJavaScriptRuntimeExecutableMock.mockResolvedValue('/managed/js-runtime');
    resolveClaudeCliPathMock.mockReset();
    resolveClaudeCliPathMock.mockReturnValue('/resolved/claude-cli.js');
  });

  it('keeps resume sessionId even if claudeCheckSession returns false (avoid false-negative context loss)', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-remote-materialized-'));
    const transcriptPath = join(dir, 'sess_should_resume.jsonl');
    await writeFile(transcriptPath, '{"type":"summary"}\n', 'utf8');

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(
      createBaseOptions({
        sessionId: 'sess_should_resume',
        transcriptPath,
      }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.resume).toBe('sess_should_resume');
  });

  it('bootstraps the managed JavaScript runtime before starting the SDK query', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(createBaseOptions());

    expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalled();
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.executable).toBe('/managed/js-runtime');
    expect(call?.options?.includeHookEvents).toBe(true);
  });

  it('arms workflow startup reconciliation after the legacy query observer installs', async () => {
    const order: string[] = [];
    mockQuery.mockImplementation(() => {
      order.push('query-installed');
      return messageStream(resultMessage());
    });

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(createBaseOptions({
      onWorkflowActivityObserverReady: () => { order.push('workflow-armed'); },
      runtimeActivityAdapter: {
        activateObservation: vi.fn(async () => { order.push('runtime-offered'); }),
      } as any,
    }));

    expect(order).toEqual(['query-installed', 'workflow-armed', 'runtime-offered']);
  });

  it('reports only failed required-hook responses fenced to the current provider session', async () => {
    const onProviderActivityObservationLost = vi.fn();
    const onMessage = vi.fn();
    const messages = [
      systemInitMessage('current-session'),
      {
        type: 'system', subtype: 'hook_response', session_id: 'current-session',
        hook_name: 'required-post-tool-use', hook_event: 'PostToolUse', outcome: 'success',
      },
      {
        type: 'system', subtype: 'hook_response', session_id: 'current-session',
        hook_name: 'permission', hook_event: 'PermissionRequest', outcome: 'error',
      },
      {
        type: 'system', subtype: 'hook_response', session_id: 'current-session',
        hook_name: 'status', hook_event: 'Stop', outcome: 'error',
      },
      {
        type: 'system', subtype: 'hook_started', session_id: 'current-session',
        hook_name: 'required-post-tool-use', hook_event: 'PostToolUse',
      },
      {
        type: 'system', subtype: 'hook_progress', session_id: 'current-session',
        hook_name: 'required-post-tool-use', hook_event: 'PostToolUse',
      },
      {
        type: 'system', subtype: 'hook_response', session_id: 'stale-session',
        hook_name: 'required-subagent-start', hook_event: 'SubagentStart', outcome: 'error',
      },
      {
        type: 'system', subtype: 'hook_response', session_id: 'current-session',
        hook_name: 'required-post-tool-use', hook_event: 'PostToolUse', outcome: 'cancelled',
      },
      {
        type: 'system', subtype: 'hook_response', session_id: 'current-session',
        hook_name: 'required-subagent-stop', hook_event: 'SubagentStop', outcome: 'error',
      },
    ] as SDKMessage[];
    mockQuery.mockImplementation((config: { onMessageReceived?: (message: SDKMessage) => void }) => ({
      async *[Symbol.asyncIterator]() {
        for (const message of messages) {
          config.onMessageReceived?.(message);
          yield message;
        }
      },
    }));
    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(createBaseOptions({ onProviderActivityObservationLost, onMessage }));

    expect(onProviderActivityObservationLost).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(systemInitMessage('current-session'));
  });

  it('installs the authenticated hook plugin before legacy provider input', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));
    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(createBaseOptions({
      hookPluginDir: '/tmp/happier-hook-plugin',
    } as Partial<RemoteOptions>));

    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.extraArgs).toEqual([
      '--plugin-dir',
      '/tmp/happier-hook-plugin',
    ]);
  });

  it('confirms provider acceptance after the legacy SDK reports successful prompt transport', async () => {
    const onPromptAcceptedByProvider = vi.fn();
    mockQuery.mockImplementation((config: QueryCall & { prompt: AsyncIterable<SDKUserMessage> }) => ({
      async *[Symbol.asyncIterator]() {
        const consumed = await config.prompt[Symbol.asyncIterator]().next();
        if (!consumed.done) {
          config.onPromptTransportOutcome?.(consumed.value, 'accepted');
        }
        yield resultMessage();
      },
    }));
    let didSendPrompt = false;

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(createBaseOptions({
      nextMessage: async () => {
        if (didSendPrompt) return null;
        didSendPrompt = true;
        return {
          message: 'hello',
          mode: defaultMode(),
          maxUserMessageSeq: 7,
          userMessageLocalIds: ['legacy-local-7'],
        } as any;
      },
      onPromptAcceptedByProvider,
    } as any));

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(onPromptAcceptedByProvider).toHaveBeenCalledTimes(1);
    expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
      maxUserMessageSeq: 7,
      userMessageLocalIds: ['legacy-local-7'],
    });
  });

  it('passes the resolved Claude CLI path into the remote launcher env so it does not rediscover it', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(createBaseOptions());

    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.env?.HAPPIER_CLAUDE_PATH).toBe('/resolved/claude-cli.js');
  });

  it('emits structured compaction events for manual compact commands', async () => {
    const onCompletionEvent = vi.fn();
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(createBaseOptions({
      nextMessage: async () => ({ message: '/compact', mode: defaultMode() }),
      onCompletionEvent,
    }));

    expect(onCompletionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'context-compaction',
      phase: 'started',
      provider: 'claude',
      source: 'user-command',
      trigger: 'manual',
      lifecycleId: expect.any(String),
    }));
    expect(onCompletionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'context-compaction',
      phase: 'completed',
      provider: 'claude',
      source: 'provider-event',
      trigger: 'manual',
      lifecycleId: expect.any(String),
    }));
    const events = onCompletionEvent.mock.calls.map((call) => call[0]);
    expect(events).not.toContain('Compaction started');
    expect(events).not.toContain('Compaction completed');
  });

  it('forwards the resolved Claude config dir override into the remote launcher env', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/tmp/happier-claude-config');
    vi.unstubAllGlobals();

    try {
      const { claudeRemote } = await import('./claudeRemote');

      await claudeRemote(createBaseOptions());

      const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
      expect(call?.options?.env?.CLAUDE_CONFIG_DIR).toBe('/tmp/happier-claude-config');
      expect(call?.options?.env?.HAPPIER_CLAUDE_PATH).toBe('/resolved/claude-cli.js');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('honors --continue in remote mode by passing continue=true to the SDK', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(
      createBaseOptions({
        claudeArgs: ['--continue'],
      }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.continue).toBe(true);
  });

  it('materializes inline --mcp-config JSON before invoking the underlying Claude Code CLI', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    const mcpRaw = JSON.stringify({ mcpServers: { fixture: { type: 'stdio', command: 'node', args: ['server.mjs'] } } });
    await claudeRemote(
      createBaseOptions({
        claudeArgs: ['--mcp-config', mcpRaw],
      }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.extraArgs?.[0]).toBe('--mcp-config');
    const configPath = call?.options?.extraArgs?.[1];
    expect(configPath).not.toBe(mcpRaw);
    expect(JSON.stringify(call?.options?.extraArgs)).not.toContain('server.mjs');
    await expect(stat(configPath!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('materializes inline --mcp-config=<json> before invoking the underlying Claude Code CLI', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    const mcpRaw = JSON.stringify({ mcpServers: { fixture: { type: 'stdio', command: 'node', args: ['server.mjs'] } } });
    const arg = `--mcp-config=${mcpRaw}`;
    await claudeRemote(
      createBaseOptions({
        claudeArgs: [arg],
      }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    const materializedArg = call?.options?.extraArgs?.[0];
    expect(materializedArg).toMatch(/^--mcp-config=.+/);
    expect(materializedArg).not.toBe(arg);
    expect(materializedArg).not.toContain('server.mjs');
    await expect(stat(materializedArg!.slice('--mcp-config='.length))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes materialized MCP config when the remote Claude query is aborted', async () => {
    let configPath: string | undefined;
    mockQuery.mockImplementation((call: QueryCall) => {
      configPath = call.options?.extraArgs?.[1];
      return {
        async *[Symbol.asyncIterator]() {
          const { AbortError } = await import('@/backends/claude/sdk');
          throw new AbortError('synthetic abort');
        },
      };
    });

    const { claudeRemote } = await import('./claudeRemote');
    const mcpRaw = JSON.stringify({
      mcpServers: { fixture: { type: 'stdio', command: 'mcp-server', env: { TOKEN: 'synthetic-abort' } } },
    });

    await claudeRemote(createBaseOptions({
      claudeArgs: ['--mcp-config', mcpRaw],
    }));

    expect(configPath).toBeTruthy();
    await expect(stat(configPath!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('injects --effort when the mode specifies a non-default reasoningEffort', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(
      createBaseOptions({
        nextMessage: async () => ({
          message: 'hello',
          mode: defaultMode({ model: 'claude-opus-4-6', reasoningEffort: 'medium' }),
        }),
      }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.extraArgs).toEqual(['--effort', 'medium']);
  });

  it('injects --effort high for Opus 4.7 because xhigh is the model default', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(
      createBaseOptions({
        nextMessage: async () => ({
          message: 'hello',
          mode: defaultMode({ model: 'claude-opus-4-7', reasoningEffort: 'high' }),
        }),
      }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.extraArgs).toEqual(['--effort', 'high']);
  });

  it('injects Claude Code experimental Agent Teams env var when enabled on the mode', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(
      createBaseOptions({
        nextMessage: async () => ({
          message: 'hello',
          mode: defaultMode({ claudeCodeExperimentalAgentTeamsEnabled: true }),
        }),
      }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });

  it('exposes a turn interrupt handler that calls the underlying query interrupt()', async () => {
    const interrupt = vi.fn(async () => {});
    let capturedTurnInterrupt: null | (() => Promise<void>) = null;

    mockQuery.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield resultMessage();
      },
      interrupt,
    } as any);

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(
      createBaseOptions({
        setTurnInterrupt: (next: (() => Promise<void>) | null) => {
          if (next) capturedTurnInterrupt = next;
        },
      } as any),
    );

    if (!capturedTurnInterrupt) {
      throw new Error('Expected claudeRemote to register a turn interrupt handler');
    }
    await (capturedTurnInterrupt as unknown as () => Promise<void>)();
    expect(interrupt).toHaveBeenCalled();
  });

  it('forwards --setting-sources when claudeRemoteSettingSourcesV2 selects a subset', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(
      createBaseOptions({
        nextMessage: async () => ({
          message: 'hello',
          mode: defaultMode({ claudeRemoteSettingSourcesV2: ['project'] as any }),
        }),
      }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.extraArgs).toEqual(['--setting-sources', 'project']);
  });

  it('does not force --setting-sources when claudeRemoteSettingSourcesV2 selects all sources', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(
      createBaseOptions({
        nextMessage: async () => ({
          message: 'hello',
          mode: defaultMode({ claudeRemoteSettingSourcesV2: ['user', 'project', 'local'] as any }),
        }),
      }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.extraArgs).toBeUndefined();
  });

  it('does not forward an invalid --setting-sources override when claudeRemoteSettingSourcesV2 selects no sources', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(
      createBaseOptions({
        nextMessage: async () => ({
          message: 'hello',
          mode: defaultMode({ claudeRemoteSettingSourcesV2: [] as any }),
        }),
      }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.extraArgs).toBeUndefined();
  });

  it('does not forward a legacy "none" setting-sources override to the Claude Code CLI', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(
      createBaseOptions({
        nextMessage: async () => ({
          message: 'hello',
          mode: defaultMode({ claudeRemoteSettingSources: 'none' as any }),
        }),
      }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.extraArgs).toBeUndefined();
  });

  it('appends Happier MCP config after user MCP config while keeping both payloads out of argv', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    const happierMcp = JSON.stringify({
      mcpServers: { happier: { type: 'stdio', command: 'node', args: ['happier-mcp.mjs', '--url', 'http://127.0.0.1:1234'] } },
    });
    const userMcp = JSON.stringify({ mcpServers: { fixture: { type: 'stdio', command: 'node', args: ['server.mjs'] } } });

    await claudeRemote(
      createBaseOptions({
        happierMcpConfigJson: happierMcp,
        claudeArgs: ['--mcp-config', userMcp],
      }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.extraArgs?.filter((arg) => arg === '--mcp-config')).toHaveLength(2);
    expect(JSON.stringify(call?.options?.extraArgs)).not.toContain('server.mjs');
    expect(JSON.stringify(call?.options?.extraArgs)).not.toContain('happier-mcp.mjs');
    const configPaths = [call?.options?.extraArgs?.[1], call?.options?.extraArgs?.[3]];
    for (const configPath of configPaths) {
      expect(configPath).not.toBe(userMcp);
      expect(configPath).not.toBe(happierMcp);
      await expect(stat(configPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('treats --resume (no id) as resume-last-session in remote mode', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(
      createBaseOptions({
        claudeArgs: ['--resume'],
      }),
    );

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.resume).toBe('last-session-id');
  });

  it('calls onSessionFound from system init without waiting for transcript file', async () => {
    mockQuery.mockReturnValue(messageStream(systemInitMessage('sess_1'), resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    const onSessionFound = vi.fn();
    let nextCount = 0;

    await claudeRemote(
      createBaseOptions({
        onSessionFound,
        nextMessage: async () => {
          nextCount += 1;
          if (nextCount === 1) {
            return { message: 'hello', mode: defaultMode() };
          }
          return null;
        },
      }),
    );

    expect(onSessionFound).toHaveBeenCalledWith('sess_1');
  });

  it('appends the remote system prompt only once when both custom and append prompts are provided', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(
      createBaseOptions({
        nextMessage: async () => ({
          message: 'hello',
          mode: defaultMode({
            customSystemPrompt: 'CUSTOM',
            appendSystemPrompt: 'APPEND',
          }),
        }),
      }),
    );

    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    const custom = String(call?.options?.customSystemPrompt ?? '');
    const append = String(call?.options?.appendSystemPrompt ?? '');
    const occurrences = (custom + '\n' + append).split('REMOTE_PROMPT').length - 1;
    expect(occurrences).toBe(1);
    expect(custom).toContain('CUSTOM');
    expect(custom).not.toContain('REMOTE_PROMPT');
    expect(append).toContain('APPEND');
    expect(append).toContain('REMOTE_PROMPT');
  });

  it('does not pass an explicit allowedTools allowlist by default (so user MCP tools are not hidden)', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(createBaseOptions());

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0]?.[0];
    expect(call?.options?.allowedTools).toBeUndefined();
  });
});
