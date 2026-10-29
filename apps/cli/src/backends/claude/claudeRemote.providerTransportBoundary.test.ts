import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SDKMessage, SDKUserMessage } from '@/backends/claude/sdk';
import type { EnhancedMode } from './loop';
import { claudeRemote } from './claudeRemote';

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock('@/backends/claude/sdk', () => ({
  query: mockQuery,
  AbortError: class AbortError extends Error {},
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

vi.mock('./utils/ensureClaudeJsRuntimeExecutable', () => ({
  ensureClaudeJsRuntimeExecutable: vi.fn(async () => '/managed/js-runtime'),
}));

vi.mock('./utils/resolveClaudeCliPath', () => ({
  resolveClaudeCliPath: vi.fn(() => '/resolved/claude-cli.js'),
}));

type RemoteOptions = Parameters<(typeof import('./claudeRemote'))['claudeRemote']>[0];
type QueryConfig = Readonly<{
  prompt: AsyncIterable<SDKUserMessage>;
  onMessageReceived: (message: SDKMessage) => void;
}>;

function defaultMode(): EnhancedMode {
  return { permissionMode: 'default' };
}

function createOptions(overrides?: Partial<RemoteOptions>): RemoteOptions {
  let didReadInitial = false;
  return {
    sessionId: null,
    transcriptPath: null,
    path: '/tmp',
    hookSettingsPath: '/tmp/hooks.json',
    canCallTool: vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} })),
    isAborted: () => false,
    nextMessage: async () => {
      if (didReadInitial) return null;
      didReadInitial = true;
      return {
        message: 'exact queued prompt',
        mode: defaultMode(),
        maxUserMessageSeq: 17,
        userMessageLocalIds: ['local-17'],
      };
    },
    onReady: vi.fn(),
    onSessionFound: vi.fn(),
    onMessage: vi.fn(),
    ...overrides,
  };
}

describe('claudeRemote provider transport boundary', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('drains queued provider turns before requesting another Pending prompt', async () => {
    let reachedQueuedContinuation = false;
    const onReady = vi.fn();
    mockQuery.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', queued_turn_count: 1 };
        reachedQueuedContinuation = true;
        yield { type: 'result', subtype: 'success', queued_turn_count: 0 };
      },
    });

    await claudeRemote(createOptions({ onReady }));

    expect(reachedQueuedContinuation).toBe(true);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('does not accept a queued prompt when startup fails before input consumption', async () => {
    const onPromptAcceptedByProvider = vi.fn();

    mockQuery.mockImplementation((_rawConfig: QueryConfig) => {
      return {
        async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
          throw new Error('provider failed after input admission');
        },
      };
    });

    await expect(claudeRemote(createOptions({
      onPromptAcceptedByProvider,
    }))).rejects.toThrow('provider failed after input admission');
    expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();
  });

  it('keeps prompt settlement accepted when the provider stream later fails', async () => {
    const onPromptAcceptedByProvider = vi.fn();
    const onPromptTransportFailure = vi.fn();
    mockQuery.mockImplementation((rawConfig: QueryConfig) => {
      const providerRead = rawConfig.prompt[Symbol.asyncIterator]().next();
      return {
        async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
          const consumed = await providerRead;
          if (consumed.done) throw new Error('expected exact queued SDK prompt');
          rawConfig.onMessageReceived({ ...consumed.value, isReplay: true, session_id: 'native-session' });
          throw new Error('stdin EPIPE after write attempt');
        },
      };
    });

    await expect(claudeRemote(createOptions({
      onPromptAcceptedByProvider,
      onPromptTransportFailure,
    } as Partial<RemoteOptions>))).rejects.toThrow('stdin EPIPE after write attempt');

    expect(onPromptAcceptedByProvider).toHaveBeenCalledExactlyOnceWith({
      maxUserMessageSeq: 17,
      userMessageLocalIds: ['local-17'],
    });
    expect(onPromptTransportFailure).not.toHaveBeenCalled();
  });

  it('reports uncertainty without accepting when the provider fails before acknowledgment', async () => {
    const acceptedLocalIds: Array<readonly string[]> = [];
    const onPromptTransportFailure = vi.fn();
    mockQuery.mockReturnValue({
      async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
        throw new Error('SDK admission rejected before prompt consumption');
      },
    });

    await expect(claudeRemote(createOptions({
      onPromptAcceptedByProvider: (acceptance) => {
        acceptedLocalIds.push(acceptance.userMessageLocalIds);
      },
      onPromptTransportFailure,
    }))).rejects.toThrow('SDK admission rejected before prompt consumption');

    expect(acceptedLocalIds).toEqual([]);
    expect(onPromptTransportFailure).toHaveBeenCalledExactlyOnceWith({
      kind: 'effect_may_have_occurred', maxUserMessageSeq: 17, userMessageLocalIds: ['local-17'],
    });
  });

  it('keeps the provider prompt stream closed when Runtime Activity observer activation rejects', async () => {
    let providerReadSettled = false;
    mockQuery.mockImplementation((rawConfig: QueryConfig) => {
      void rawConfig.prompt[Symbol.asyncIterator]().next().then(() => {
        providerReadSettled = true;
      });
      return {
        async *[Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
          yield { type: 'result' } as SDKMessage;
        },
      };
    });
    const runtimeActivityAdapter = {
      readCurrentState: () => 'idle' as const,
      publishBeforeRuntimeStart: vi.fn(async () => {}),
      activateObservation: vi.fn(async () => { throw new Error('observer activation failed'); }),
      observeActivity: vi.fn(async () => {}),
      publishCurrent: vi.fn(async () => {}),
      handleRuntimeLoss: vi.fn(async () => {}),
    };
    const onPromptAcceptedByProvider = vi.fn();
    const onPromptTransportFailure = vi.fn();

    await expect(claudeRemote(createOptions({
      runtimeActivityAdapter,
      onPromptAcceptedByProvider,
      onPromptTransportFailure,
    }))).rejects.toThrow('observer activation failed');

    await Promise.resolve();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(runtimeActivityAdapter.activateObservation).toHaveBeenCalledTimes(1);
    expect(providerReadSettled).toBe(false);
    expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();
    expect(onPromptTransportFailure).toHaveBeenCalledExactlyOnceWith({
      kind: 'rejected_before_effect',
      maxUserMessageSeq: 17,
      userMessageLocalIds: ['local-17'],
    });
  });
});
