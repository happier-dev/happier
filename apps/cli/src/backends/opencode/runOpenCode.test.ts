import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

const { runStandardAcpProviderMock } = vi.hoisted(() => ({
  runStandardAcpProviderMock: vi.fn(),
}));

const { updateAgentStateBestEffortMock } = vi.hoisted(() => ({
  updateAgentStateBestEffortMock: vi.fn(),
}));

vi.mock('@/agent/runtime/runStandardAcpProvider', () => ({
  runStandardAcpProvider: runStandardAcpProviderMock,
}));

vi.mock('@/api/session/sessionWritesBestEffort', () => ({
  updateAgentStateBestEffort: updateAgentStateBestEffortMock,
}));

const { createOpenCodeAcpRuntimeMock, createOpenCodeServerRuntimeMock } = vi.hoisted(() => ({
  createOpenCodeAcpRuntimeMock: vi.fn(() => ({ getSessionId: () => 'ses_acp' })),
  createOpenCodeServerRuntimeMock: vi.fn(() => ({ getSessionId: () => 'ses_server' })),
}));

vi.mock('./acp/runtime', () => ({
  createOpenCodeAcpRuntime: createOpenCodeAcpRuntimeMock,
}));

vi.mock('./server/runtime', () => ({
  createOpenCodeServerRuntime: createOpenCodeServerRuntimeMock,
}));

describe('runOpenCode', () => {
  const credentials: Credentials = {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array([1]) },
  };

  let runOpenCode: typeof import('./runOpenCode').runOpenCode;

  beforeAll(async () => {
    ({ runOpenCode } = await import('./runOpenCode'));
  });

  beforeEach(() => {
    runStandardAcpProviderMock.mockReset();
    updateAgentStateBestEffortMock.mockReset();
    createOpenCodeAcpRuntimeMock.mockReset();
    createOpenCodeServerRuntimeMock.mockReset();
    delete process.env.HAPPIER_OPENCODE_BACKEND_MODE;
  });

  it('does not block startup while waiting for metadata snapshot publish prerequisites', async () => {
    const ensureMetadataSnapshot = vi.fn(() => new Promise<null>(() => {}));
    const updateMetadata = vi.fn(async () => {});

    let onAfterStartOutcome: 'completed' | 'timed_out' = 'timed_out';

    runStandardAcpProviderMock.mockImplementationOnce(async (_opts: unknown, config: unknown) => {
      if (!config || typeof config !== 'object') {
        throw new Error('Expected runStandardAcpProvider config to be an object');
      }
      const maybeOnAfterStart = (config as { onAfterStart?: unknown }).onAfterStart;
      if (typeof maybeOnAfterStart !== 'function') {
        throw new Error('Expected runStandardAcpProvider config to provide onAfterStart');
      }

      const onAfterStartPromise = Promise.resolve(
        maybeOnAfterStart({
          session: { ensureMetadataSnapshot, updateMetadata },
          runtime: { getSessionId: () => 'opencode-session-1' },
        }),
      );

      onAfterStartOutcome = await Promise.race([
        onAfterStartPromise.then(() => 'completed' as const),
        new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 25)),
      ]);

      await Promise.resolve();
    });

    await runOpenCode({ credentials });

    expect(onAfterStartOutcome).toBe('completed');
    expect(updateAgentStateBestEffortMock).toHaveBeenCalledTimes(1);
    expect(ensureMetadataSnapshot).toHaveBeenCalledTimes(1);
    expect(updateMetadata).not.toHaveBeenCalled();
  }, 15_000);

  it('publishes askUserQuestionAnswersInPermission capability seed in server mode', async () => {
    runStandardAcpProviderMock.mockImplementationOnce(async (_opts: unknown, config: unknown) => {
      if (!config || typeof config !== 'object') {
        throw new Error('Expected runStandardAcpProvider config to be an object');
      }
      const maybeOnAfterStart = (config as { onAfterStart?: unknown }).onAfterStart;
      if (typeof maybeOnAfterStart !== 'function') {
        throw new Error('Expected runStandardAcpProvider config to provide onAfterStart');
      }

      maybeOnAfterStart({
        session: { ensureMetadataSnapshot: vi.fn(() => new Promise<null>(() => {})), updateMetadata: vi.fn(async () => {}) },
        runtime: { getSessionId: () => 'opencode-session-1' },
      });
    });

    await runOpenCode({ credentials });

    expect(updateAgentStateBestEffortMock).toHaveBeenCalledTimes(1);
  });

  it('does not publish askUserQuestionAnswersInPermission capability seed in acp mode', async () => {
    process.env.HAPPIER_OPENCODE_BACKEND_MODE = 'acp';

    runStandardAcpProviderMock.mockImplementationOnce(async (_opts: unknown, config: unknown) => {
      if (!config || typeof config !== 'object') {
        throw new Error('Expected runStandardAcpProvider config to be an object');
      }
      const maybeOnAfterStart = (config as { onAfterStart?: unknown }).onAfterStart;
      if (typeof maybeOnAfterStart !== 'function') {
        throw new Error('Expected runStandardAcpProvider config to provide onAfterStart');
      }

      maybeOnAfterStart({
        session: { ensureMetadataSnapshot: vi.fn(() => new Promise<null>(() => {})), updateMetadata: vi.fn(async () => {}) },
        runtime: { getSessionId: () => 'opencode-session-1' },
      });
    });

    await runOpenCode({ credentials });

    expect(updateAgentStateBestEffortMock).toHaveBeenCalledTimes(0);
  });

  it('defaults to server runtime when backend mode is not specified', async () => {
    runStandardAcpProviderMock.mockImplementationOnce(async (_opts: unknown, config: unknown) => {
      if (!config || typeof config !== 'object') {
        throw new Error('Expected runStandardAcpProvider config to be an object');
      }
      const createRuntime = (config as { createRuntime?: unknown }).createRuntime;
      if (typeof createRuntime !== 'function') {
        throw new Error('Expected runStandardAcpProvider config to provide createRuntime');
      }

      createRuntime({
        directory: '/tmp',
        metadata: { path: '/tmp' },
        session: {},
        messageBuffer: {},
        mcpServers: {},
        permissionHandler: {},
        getPermissionMode: () => 'default',
        setThinking: () => {},
      });
    });

    await runOpenCode({ credentials });

    expect(createOpenCodeServerRuntimeMock).toHaveBeenCalledTimes(1);
    expect(createOpenCodeAcpRuntimeMock).toHaveBeenCalledTimes(0);
  });

  it('uses ACP runtime when backend mode is explicitly set to acp', async () => {
    process.env.HAPPIER_OPENCODE_BACKEND_MODE = 'acp';

    runStandardAcpProviderMock.mockImplementationOnce(async (_opts: unknown, config: unknown) => {
      if (!config || typeof config !== 'object') {
        throw new Error('Expected runStandardAcpProvider config to be an object');
      }
      const createRuntime = (config as { createRuntime?: unknown }).createRuntime;
      if (typeof createRuntime !== 'function') {
        throw new Error('Expected runStandardAcpProvider config to provide createRuntime');
      }

      createRuntime({
        directory: '/tmp',
        metadata: { path: '/tmp' },
        session: {},
        messageBuffer: {},
        mcpServers: {},
        permissionHandler: {},
        getPermissionMode: () => 'default',
        setThinking: () => {},
      });
    });

    await runOpenCode({ credentials });

    expect(createOpenCodeAcpRuntimeMock).toHaveBeenCalledTimes(1);
    expect(createOpenCodeServerRuntimeMock).toHaveBeenCalledTimes(0);
  });
});
