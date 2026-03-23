import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const {
  createOpenCodeSharedLocalControlMock,
  getLatestLocalControlParams,
  resetLatestLocalControlParams,
} = vi.hoisted(() => {
  let latestLocalControlParams: unknown = null;
  return {
    createOpenCodeSharedLocalControlMock: vi.fn((params: unknown) => {
      latestLocalControlParams = params;
      const startingMode = (
        params && typeof params === 'object' && (params as { startingMode?: unknown }).startingMode === 'local'
      ) ? 'local' : 'remote';
      return {
        resolveKeepAliveMode: () => startingMode,
        shouldRenderTerminalDisplay: () => startingMode === 'remote',
        onAfterStart: async () => undefined,
        onSessionSwap: async () => undefined,
        dispose: async () => undefined,
      };
    }),
    getLatestLocalControlParams: () => latestLocalControlParams,
    resetLatestLocalControlParams: () => {
      latestLocalControlParams = null;
    },
  };
});

const { readSharedManagedOpenCodeServerStateBestEffortMock } = vi.hoisted(() => ({
  readSharedManagedOpenCodeServerStateBestEffortMock: vi.fn(),
}));

vi.mock('./acp/runtime', () => ({
  createOpenCodeAcpRuntime: createOpenCodeAcpRuntimeMock,
}));

vi.mock('./server/runtime', () => ({
  createOpenCodeServerRuntime: createOpenCodeServerRuntimeMock,
}));

vi.mock('./localControl/createOpenCodeSharedLocalControl', () => ({
  createOpenCodeSharedLocalControl: createOpenCodeSharedLocalControlMock,
}));

vi.mock('./server/sharedManagedServer', () => ({
  isLoopbackManagedOpenCodeBaseUrl: (rawBaseUrl: string) => {
    const value = rawBaseUrl.trim();
    if (!value) return false;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      const port = Number.parseInt(url.port, 10);
      if (!Number.isFinite(port) || port <= 0) return false;
      const host = url.hostname.toLowerCase();
      return host === 'localhost' || host === '::1' || host.startsWith('127.');
    } catch {
      return false;
    }
  },
  readSharedManagedOpenCodeServerStateBestEffort: readSharedManagedOpenCodeServerStateBestEffortMock,
}));

describe('runOpenCode', () => {
  const credentials: Credentials = {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array([1]) },
  };
  const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  let runOpenCode: typeof import('./runOpenCode').runOpenCode;

  beforeAll(async () => {
    ({ runOpenCode } = await import('./runOpenCode'));
  }, 60_000);

  beforeEach(() => {
    runStandardAcpProviderMock.mockReset();
    updateAgentStateBestEffortMock.mockReset();
    createOpenCodeAcpRuntimeMock.mockReset();
    createOpenCodeServerRuntimeMock.mockReset();
    createOpenCodeSharedLocalControlMock.mockClear();
    readSharedManagedOpenCodeServerStateBestEffortMock.mockReset();
    resetLatestLocalControlParams();
    delete process.env.HAPPIER_OPENCODE_BACKEND_MODE;
    delete process.env.HAPPIER_OPENCODE_SERVER_URL;
  });

  afterEach(() => {
    if (stdoutIsTTYDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutIsTTYDescriptor);
    }
    if (stdinIsTTYDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinIsTTYDescriptor);
    }
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

  it('defaults terminal-started server sessions to local keep-alive mode', async () => {
    let resolveKeepAliveMode: (() => 'local' | 'remote') | null = null;
    let startRuntimeBeforeFirstPrompt: boolean | undefined;
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    runStandardAcpProviderMock.mockImplementationOnce(async (_opts: unknown, config: unknown) => {
      if (!config || typeof config !== 'object') {
        throw new Error('Expected runStandardAcpProvider config to be an object');
      }
      resolveKeepAliveMode = (config as { resolveKeepAliveMode?: () => 'local' | 'remote' }).resolveKeepAliveMode ?? null;
      startRuntimeBeforeFirstPrompt = (config as { startRuntimeBeforeFirstPrompt?: boolean }).startRuntimeBeforeFirstPrompt;
    });

    await runOpenCode({ credentials, startedBy: 'terminal' });

    expect(resolveKeepAliveMode).toBeTypeOf('function');
    if (!resolveKeepAliveMode) {
      throw new Error('Expected resolveKeepAliveMode to be defined');
    }
    const getKeepAliveMode = resolveKeepAliveMode as () => 'local' | 'remote';
    expect(getKeepAliveMode()).toBe('local');
    expect(startRuntimeBeforeFirstPrompt).toBe(true);
  });

  it('keeps explicit remote starts in remote keep-alive mode', async () => {
    let resolveKeepAliveMode: (() => 'local' | 'remote') | null = null;
    let startRuntimeBeforeFirstPrompt: boolean | undefined;

    runStandardAcpProviderMock.mockImplementationOnce(async (_opts: unknown, config: unknown) => {
      if (!config || typeof config !== 'object') {
        throw new Error('Expected runStandardAcpProvider config to be an object');
      }
      resolveKeepAliveMode = (config as { resolveKeepAliveMode?: () => 'local' | 'remote' }).resolveKeepAliveMode ?? null;
      startRuntimeBeforeFirstPrompt = (config as { startRuntimeBeforeFirstPrompt?: boolean }).startRuntimeBeforeFirstPrompt;
    });

    await runOpenCode({ credentials, startedBy: 'terminal', startingMode: 'remote' as any });

    expect(resolveKeepAliveMode).toBeTypeOf('function');
    if (!resolveKeepAliveMode) {
      throw new Error('Expected resolveKeepAliveMode to be defined');
    }
    const getKeepAliveMode = resolveKeepAliveMode as () => 'local' | 'remote';
    expect(getKeepAliveMode()).toBe('remote');
    expect(startRuntimeBeforeFirstPrompt).toBe(true);
  });

  it('does not eagerly start the runtime in acp mode', async () => {
    process.env.HAPPIER_OPENCODE_BACKEND_MODE = 'acp';
    let startRuntimeBeforeFirstPrompt: boolean | undefined;

    runStandardAcpProviderMock.mockImplementationOnce(async (_opts: unknown, config: unknown) => {
      if (!config || typeof config !== 'object') {
        throw new Error('Expected runStandardAcpProvider config to be an object');
      }
      startRuntimeBeforeFirstPrompt = (config as { startRuntimeBeforeFirstPrompt?: boolean }).startRuntimeBeforeFirstPrompt;
    });

    await runOpenCode({ credentials, startedBy: 'terminal' });

    expect(startRuntimeBeforeFirstPrompt).toBe(false);
  });

  it('ignores non-loopback managed server state when resolving local-control baseUrl', async () => {
    readSharedManagedOpenCodeServerStateBestEffortMock.mockResolvedValueOnce({
      baseUrl: 'http://example.com:8080',
      pid: 123,
      startedAtMs: 1,
    });

    runStandardAcpProviderMock.mockResolvedValueOnce(undefined);

    await runOpenCode({ credentials, startedBy: 'terminal' });

    const params = getLatestLocalControlParams() as { getServerBaseUrl?: () => Promise<string | null> } | null;
    expect(params?.getServerBaseUrl).toBeTypeOf('function');
    await expect(params?.getServerBaseUrl?.()).resolves.toBeNull();
  });
});
