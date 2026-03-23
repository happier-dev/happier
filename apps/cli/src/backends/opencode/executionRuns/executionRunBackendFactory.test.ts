import { afterEach, describe, expect, it, vi } from 'vitest';

const { createOpenCodeBackendMock } = vi.hoisted(() => ({
  createOpenCodeBackendMock: vi.fn(() => ({ dispose: async () => undefined })),
}));

const { createOpenCodeServerExecutionRunBackendMock } = vi.hoisted(() => ({
  createOpenCodeServerExecutionRunBackendMock: vi.fn(() => ({ dispose: async () => undefined })),
}));

vi.mock('@/backends/opencode/acp/backend', () => ({
  createOpenCodeBackend: createOpenCodeBackendMock,
}));

vi.mock('./createOpenCodeServerExecutionRunBackend', () => ({
  createOpenCodeServerExecutionRunBackend: createOpenCodeServerExecutionRunBackendMock,
}));

describe('executionRunBackendFactory (opencode)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('defaults execution runs to the OpenCode server adapter', async () => {
    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    executionRunBackendFactory({
      cwd: '/tmp/opencode-worktree',
      backendId: 'opencode',
      permissionMode: 'read_only',
      permissionHandler: {
        handleToolCall: vi.fn(async () => ({ decision: 'approved_for_session' })),
      },
      isolation: {
        env: {
          HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
        },
      },
    } as any);

    expect(createOpenCodeServerExecutionRunBackendMock).toHaveBeenCalledTimes(1);
    expect(createOpenCodeServerExecutionRunBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/opencode-worktree',
      env: { HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096' },
      permissionMode: 'read-only',
    }));
    expect(createOpenCodeBackendMock).not.toHaveBeenCalled();
  });

  it('retains explicit ACP fallback when the execution-run env opts into acp mode', async () => {
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved_for_session' })),
    };
    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    executionRunBackendFactory({
      cwd: '/tmp/opencode-worktree',
      backendId: 'opencode',
      permissionMode: 'read_only',
      permissionHandler,
      isolation: {
        env: {
          HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
          HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
        },
      },
    } as any);

    expect(createOpenCodeBackendMock).toHaveBeenCalledTimes(1);
    expect(createOpenCodeBackendMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/tmp/opencode-worktree',
      env: {
        HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
        HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
      },
      permissionHandler,
      permissionMode: 'read-only',
    }));
    expect(createOpenCodeServerExecutionRunBackendMock).not.toHaveBeenCalled();
  });

  it('honors the account-settings OpenCode backend mode when no explicit env override is set', async () => {
    const permissionHandler = {
      handleToolCall: vi.fn(async () => ({ decision: 'approved_for_session' })),
    };
    const { executionRunBackendFactory } = await import('./executionRunBackendFactory');

    executionRunBackendFactory({
      cwd: '/tmp/opencode-worktree',
      backendId: 'opencode',
      permissionMode: 'read_only',
      permissionHandler,
      accountSettings: {
        opencodeBackendMode: 'acp',
      },
      isolation: {
        env: {
          HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
        },
      },
    } as any);

    expect(createOpenCodeBackendMock).toHaveBeenCalledTimes(1);
    expect(createOpenCodeServerExecutionRunBackendMock).not.toHaveBeenCalled();
  });
});
