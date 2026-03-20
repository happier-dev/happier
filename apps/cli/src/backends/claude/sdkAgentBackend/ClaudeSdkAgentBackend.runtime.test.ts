import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const ensureJavaScriptRuntimeExecutableMock = vi.fn(async () => '/managed/js-runtime');

vi.mock('@/backends/claude/sdk/query', () => ({
  query: queryMock,
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

vi.mock('@/agent/runtime/subprocessArtifacts', () => ({
  createSubprocessStderrAppender: vi.fn(async () => null),
}));

function createQueryResult(): ReturnType<typeof queryMock> {
  return {
    async *[Symbol.asyncIterator]() {},
    interrupt: vi.fn(async () => {}),
  };
}

describe('ClaudeSdkAgentBackend runtime bootstrap', () => {
  beforeEach(() => {
    queryMock.mockReset();
    ensureJavaScriptRuntimeExecutableMock.mockReset();
    ensureJavaScriptRuntimeExecutableMock.mockResolvedValue('/managed/js-runtime');
    queryMock.mockReturnValue(createQueryResult());
  });

  it('bootstraps the managed JavaScript runtime before starting the SDK query', async () => {
    const { ClaudeSdkAgentBackend } = await import('./ClaudeSdkAgentBackend');

    const backend = new ClaudeSdkAgentBackend({
      cwd: '/tmp',
      modelId: 'default',
      permissionPolicy: 'no_tools',
    });

    try {
      await backend.startSession();
    } finally {
      await backend.dispose();
    }

    expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          executable: '/managed/js-runtime',
        }),
      }),
    );
  });
});
