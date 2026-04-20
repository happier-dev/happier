import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  createExecutionRunHostRuntimeFromAgentBackendMock,
  coderabbitRuntimeMock,
  CodeRabbitReviewBackendMock,
} = vi.hoisted(() => {
  const coderabbitRuntimeMock = {
    readResumeSupport: vi.fn(async () => false),
    provisionSession: vi.fn(async () => ({ sessionId: 'coderabbit-exec-run' })),
    sendPrompt: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    subscribeMessages: vi.fn(() => () => undefined),
    dispose: vi.fn(async () => undefined),
  };

  return {
    createExecutionRunHostRuntimeFromAgentBackendMock: vi.fn(() => {
      throw new Error('central execution-run AgentBackend adapter should not be used in the CodeRabbit execution-run factory');
    }),
    coderabbitRuntimeMock,
    CodeRabbitReviewBackendMock: vi.fn(() => coderabbitRuntimeMock),
  };
});

vi.mock('@/agent/executionRuns/runtime/backend.testkit', () => ({
  createExecutionRunHostRuntimeFromAgentBackend: createExecutionRunHostRuntimeFromAgentBackendMock,
}));

vi.mock('./CodeRabbitReviewBackend.js', () => ({
  CodeRabbitReviewBackend: CodeRabbitReviewBackendMock,
}));

describe('coderabbit execution run factory direct host runtime', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('creates the CodeRabbit execution-run runtime directly without the central AgentBackend adapter', async () => {
    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    const runtime = executionRunBackendFactory({
      cwd: '/tmp/coderabbit-worktree',
      backendId: 'coderabbit',
      permissionMode: 'read_only',
      start: {
        intent: 'review',
      },
      isolation: {
        env: {
          HAPPIER_CODERABBIT_REVIEW_CMD: 'coderabbit',
          EXTRA_FLAG: '1',
        },
      },
    } as any);

    expect(runtime).toBe(coderabbitRuntimeMock);
    expect(CodeRabbitReviewBackendMock).toHaveBeenCalledTimes(1);
    expect(CodeRabbitReviewBackendMock).toHaveBeenCalledWith({
      cwd: '/tmp/coderabbit-worktree',
      env: expect.objectContaining({
        HAPPIER_CODERABBIT_REVIEW_CMD: 'coderabbit',
        EXTRA_FLAG: '1',
      }),
      start: {
        intent: 'review',
      },
    });
    expect(createExecutionRunHostRuntimeFromAgentBackendMock).not.toHaveBeenCalled();
  });
});
