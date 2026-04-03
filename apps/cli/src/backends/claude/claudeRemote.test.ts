import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@/backends/claude/sdk';
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

vi.mock('./utils/claudeCheckSession', () => ({
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
  options?: Readonly<{
    resume?: string;
    continue?: boolean;
    extraArgs?: readonly string[];
    env?: Readonly<Record<string, string>>;
    customSystemPrompt?: string;
    appendSystemPrompt?: string;
    executable?: string;
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

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(
      createBaseOptions({
        sessionId: 'sess_should_resume',
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
  });

  it('passes the resolved Claude CLI path into the remote launcher env so it does not rediscover it', async () => {
    mockQuery.mockReturnValue(messageStream(resultMessage()));

    const { claudeRemote } = await import('./claudeRemote');

    await claudeRemote(createBaseOptions());

    const call = mockQuery.mock.calls[0]?.[0] as QueryCall | undefined;
    expect(call?.options?.env?.HAPPIER_CLAUDE_PATH).toBe('/resolved/claude-cli.js');
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

  it('passes through --mcp-config to the underlying Claude Code CLI (no parsing/merging)', async () => {
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
    expect(call?.options?.extraArgs).toEqual(['--mcp-config', mcpRaw]);
  });

  it('passes through --mcp-config=<json> to the underlying Claude Code CLI (no parsing/merging)', async () => {
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
    expect(call?.options?.extraArgs).toEqual([arg]);
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

  it('appends Happier MCP config when provided, while preserving user --mcp-config passthrough', async () => {
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
    expect(call?.options?.extraArgs).toEqual(['--mcp-config', userMcp, '--mcp-config', happierMcp]);
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
