import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  createExecutionRunHostRuntimeFromAgentBackendMock,
  claudeRuntimeMock,
  ClaudeSdkAgentBackendMock,
} = vi.hoisted(() => {
  const claudeRuntimeMock = {
    startSession: vi.fn(async () => ({ sessionId: 'legacy-agent-backend-session' })),
    loadSession: vi.fn(async () => ({ sessionId: 'legacy-agent-backend-session' })),
    readResumeSupport: vi.fn(async () => true),
    provisionSession: vi.fn(async () => ({ sessionId: 'claude-exec-run' })),
    sendPrompt: vi.fn(async () => undefined),
    sendSteerPrompt: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    onMessage: vi.fn(),
    offMessage: vi.fn(),
    subscribeMessages: vi.fn(() => () => undefined),
    respondToPermission: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };

  return {
    createExecutionRunHostRuntimeFromAgentBackendMock: vi.fn(() => {
      throw new Error('central execution-run AgentBackend adapter should not be used in the Claude execution-run factory');
    }),
    claudeRuntimeMock,
    ClaudeSdkAgentBackendMock: vi.fn(() => claudeRuntimeMock),
  };
});

vi.mock('@/agent/executionRuns/runtime/backend.testkit', () => ({
  createExecutionRunHostRuntimeFromAgentBackend: createExecutionRunHostRuntimeFromAgentBackendMock,
}));

vi.mock('@/backends/claude/sdkAgentBackend/ClaudeSdkAgentBackend', () => ({
  ClaudeSdkAgentBackend: ClaudeSdkAgentBackendMock,
}));

describe('claude execution run factory direct host runtime', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('creates the Claude SDK execution-run runtime directly without the central AgentBackend adapter', async () => {
    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    const runtime = executionRunBackendFactory({
      cwd: '/tmp/claude-worktree',
      backendId: 'claude',
      modelId: 'opus',
      permissionMode: 'safe-yolo',
      isolation: {
        env: {
          HAPPIER_CLAUDE_PATH: '/tmp/fake-claude',
        },
        settingsPath: '/tmp/claude/settings.json',
      },
    } as any);

    expect(runtime).not.toBe(claudeRuntimeMock);
    expect('startSession' in runtime).toBe(false);
    expect('loadSession' in runtime).toBe(false);
    expect('onMessage' in runtime).toBe(false);
    expect('offMessage' in runtime).toBe(false);
    expect(runtime).toMatchObject({
      readResumeSupport: expect.any(Function),
      provisionSession: expect.any(Function),
      sendPrompt: expect.any(Function),
      sendSteerPrompt: expect.any(Function),
      cancel: expect.any(Function),
      subscribeMessages: expect.any(Function),
      respondToPermission: expect.any(Function),
      waitForTurnCompletion: expect.any(Function),
      dispose: expect.any(Function),
    });
    expect(ClaudeSdkAgentBackendMock).toHaveBeenCalledTimes(1);
    expect(ClaudeSdkAgentBackendMock).toHaveBeenCalledWith({
      cwd: '/tmp/claude-worktree',
      modelId: 'opus',
      permissionPolicy: 'parent_session_prompt',
      settingsPath: '/tmp/claude/settings.json',
      env: {
        HAPPIER_CLAUDE_PATH: '/tmp/fake-claude',
      },
    });
    await runtime.readResumeSupport();
    await runtime.provisionSession({ initialPrompt: 'hello' });
    await runtime.sendPrompt('claude-exec-run', 'ping');
    await runtime.sendSteerPrompt?.('claude-exec-run', 'steer');
    await runtime.respondToPermission?.('request-1', true);
    await runtime.waitForTurnCompletion?.(100);
    await runtime.dispose();
    expect(claudeRuntimeMock.readResumeSupport).toHaveBeenCalledTimes(1);
    expect(claudeRuntimeMock.provisionSession).toHaveBeenCalledWith({ initialPrompt: 'hello' });
    expect(claudeRuntimeMock.sendPrompt).toHaveBeenCalledWith('claude-exec-run', 'ping');
    expect(claudeRuntimeMock.sendSteerPrompt).toHaveBeenCalledWith('claude-exec-run', 'steer');
    expect(claudeRuntimeMock.respondToPermission).toHaveBeenCalledWith('request-1', true);
    expect(claudeRuntimeMock.waitForTurnCompletion).toHaveBeenCalledWith(100);
    expect(claudeRuntimeMock.dispose).toHaveBeenCalledTimes(1);
    expect(createExecutionRunHostRuntimeFromAgentBackendMock).not.toHaveBeenCalled();
  });
});
