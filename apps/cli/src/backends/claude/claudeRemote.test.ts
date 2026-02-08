import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@/backends/claude/sdk';
import type { EnhancedMode } from './loop';

const mockQuery = vi.fn();

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

type RemoteOptions = Parameters<(typeof import('./claudeRemote'))['claudeRemote']>[0];

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
    allowedTools: [],
    mcpServers: {},
    hookSettingsPath: '/tmp/hooks.json',
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
    const call = mockQuery.mock.calls[0]?.[0];
    expect(call?.options?.resume).toBe('sess_should_resume');
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
    const call = mockQuery.mock.calls[0]?.[0];
    expect(call?.options?.continue).toBe(true);
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
    const call = mockQuery.mock.calls[0]?.[0];
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

    const call = mockQuery.mock.calls[0]?.[0];
    const custom = String(call?.options?.customSystemPrompt ?? '');
    const append = String(call?.options?.appendSystemPrompt ?? '');
    const occurrences = (custom + '\n' + append).split('REMOTE_PROMPT').length - 1;
    expect(occurrences).toBe(1);
    expect(custom).toContain('CUSTOM');
    expect(custom).not.toContain('REMOTE_PROMPT');
    expect(append).toContain('APPEND');
    expect(append).toContain('REMOTE_PROMPT');
  });
});
