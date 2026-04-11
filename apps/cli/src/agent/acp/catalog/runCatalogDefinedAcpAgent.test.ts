import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createCatalogProviderAcpRuntimeMock,
  getProviderCliRuntimeSpecMock,
  listSessionMarkersMock,
  runStandardAcpProviderMock,
  writeSessionMarkerMock,
} = vi.hoisted(() => ({
  createCatalogProviderAcpRuntimeMock: vi.fn(),
  getProviderCliRuntimeSpecMock: vi.fn(),
  listSessionMarkersMock: vi.fn(),
  runStandardAcpProviderMock: vi.fn(),
  writeSessionMarkerMock: vi.fn(),
}));

vi.mock('@happier-dev/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/agents')>();
  return {
    ...actual,
    getProviderCliRuntimeSpec: getProviderCliRuntimeSpecMock,
  };
});

vi.mock('@/agent/runtime/runStandardAcpProvider', () => ({
  runStandardAcpProvider: runStandardAcpProviderMock,
}));

vi.mock('@/agent/acp/runtime/createCatalogProviderAcpRuntime', () => ({
  createCatalogProviderAcpRuntime: createCatalogProviderAcpRuntimeMock,
}));

vi.mock('@/daemon/sessionRegistry', () => ({
  listSessionMarkers: listSessionMarkersMock,
  writeSessionMarker: writeSessionMarkerMock,
}));

vi.mock('@/daemon/startDaemon', () => ({
  initialMachineMetadata: { host: 'test-host', platform: 'darwin', happyCliVersion: '0.0.0-test', homeDir: '/tmp', happyHomeDir: '/tmp/happy', happyLibDir: '/tmp/happy/lib' },
}));

vi.mock('@/agent/runtime/formatProviderPromptErrorMessage', () => ({
  formatProviderPromptErrorMessage: () => 'prompt-error',
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('./ui/CatalogDefinedAcpTerminalDisplay', () => ({
  CatalogDefinedAcpTerminalDisplay: () => null,
}));

import { runCatalogDefinedAcpAgent } from './runCatalogDefinedAcpAgent';

describe('runCatalogDefinedAcpAgent', () => {
  beforeEach(() => {
    createCatalogProviderAcpRuntimeMock.mockReset();
    getProviderCliRuntimeSpecMock.mockReset();
    listSessionMarkersMock.mockReset();
    runStandardAcpProviderMock.mockReset();
    writeSessionMarkerMock.mockReset();
    getProviderCliRuntimeSpecMock.mockReturnValue({
      title: 'Kiro CLI',
      binaryName: 'kiro',
    });
  });

  it('forwards machine identity and memory recall guidance to the catalog ACP runtime', async () => {
    let capturedConfig: null | Readonly<{ createRuntime: (args: any) => unknown }> = null;
    runStandardAcpProviderMock.mockImplementation(async (_opts: unknown, config: unknown) => {
      capturedConfig = config as Readonly<{ createRuntime: (args: any) => unknown }>;
    });

    const runtime = { kind: 'runtime' };
    createCatalogProviderAcpRuntimeMock.mockReturnValue(runtime);

    await runCatalogDefinedAcpAgent('kiro', {
      credentials: { token: 'token' } as any,
    });

    if (!capturedConfig) {
      throw new Error('Expected ACP runtime config to be captured');
    }

    const runtimeConfig = capturedConfig as Readonly<{ createRuntime: (args: any) => unknown }>;
    const createdRuntime = runtimeConfig.createRuntime({
      directory: '/repo',
      machineId: 'machine-123',
      session: { id: 'session-1' },
      messageBuffer: { id: 'buffer-1' },
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn() },
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      memoryRecallGuidanceEnabled: true,
    });

    expect(createdRuntime).toBe(runtime);
    expect(createCatalogProviderAcpRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'kiro',
      directory: '/repo',
      session: { id: 'session-1' },
      memoryRecallGuidance: {
        enabled: true,
        machineId: 'machine-123',
      },
    }));
  });

  it('publishes provider session ids for catalog ACP agents that declare a vendor resume metadata field', async () => {
    let capturedConfig: null | Readonly<{ createRuntime: (args: any) => unknown }> = null;
    runStandardAcpProviderMock.mockImplementation(async (_opts: unknown, config: unknown) => {
      capturedConfig = config as Readonly<{ createRuntime: (args: any) => unknown }>;
    });

    createCatalogProviderAcpRuntimeMock.mockReturnValue({ kind: 'runtime' });

    await runCatalogDefinedAcpAgent('ohMyPi', {
      credentials: { token: 'token' } as any,
    });

    if (!capturedConfig) {
      throw new Error('Expected ACP runtime config to be captured');
    }

    const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
      return updater({ existing: true });
    });

    (capturedConfig as Readonly<{ createRuntime: (args: any) => unknown }>).createRuntime({
      directory: '/repo',
      machineId: 'machine-123',
      session: {
        id: 'session-1',
        updateMetadata,
      },
      messageBuffer: { id: 'buffer-1' },
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn() },
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      memoryRecallGuidanceEnabled: false,
    });

    const runtimeArgs = createCatalogProviderAcpRuntimeMock.mock.calls.at(-1)?.[0];
    expect(runtimeArgs?.provider).toBe('ohMyPi');
    expect(runtimeArgs?.onSessionIdChange).toBeTypeOf('function');

    runtimeArgs?.onSessionIdChange?.('omp-session-1');

    expect(updateMetadata).toHaveBeenCalledTimes(1);
    const updater = updateMetadata.mock.calls[0]?.[0] as ((metadata: Record<string, unknown>) => Record<string, unknown>) | undefined;
    expect(updater?.({ existing: true })).toEqual({
      existing: true,
      ohMyPiSessionId: 'omp-session-1',
    });
  });

  it('refreshes the existing daemon marker when the provider session id is discovered after startup', async () => {
    let capturedConfig: null | Readonly<{ createRuntime: (args: any) => unknown }> = null;
    runStandardAcpProviderMock.mockImplementation(async (_opts: unknown, config: unknown) => {
      capturedConfig = config as Readonly<{ createRuntime: (args: any) => unknown }>;
    });
    listSessionMarkersMock.mockResolvedValue([
      {
        pid: 321,
        happySessionId: 'session-1',
        happyHomeDir: '/tmp/happy-home',
        createdAt: 1,
        updatedAt: 2,
        flavor: 'ohMyPi',
        startedBy: 'daemon',
        cwd: '/repo',
        processCommandHash: 'a'.repeat(64),
        processCommand: 'oh-my-pi --run',
        respawn: { version: 1, directory: '/repo', backendTarget: { kind: 'builtInAgent', agentId: 'ohMyPi' } },
        metadata: {
          flavor: 'ohMyPi',
          hostPid: 321,
          path: '/repo',
          startedBy: 'daemon',
        },
      },
    ]);
    createCatalogProviderAcpRuntimeMock.mockReturnValue({ kind: 'runtime' });

    await runCatalogDefinedAcpAgent('ohMyPi', {
      credentials: { token: 'token' } as any,
    });

    if (!capturedConfig) {
      throw new Error('Expected ACP runtime config to be captured');
    }

    let metadataSnapshot: Record<string, unknown> = {
      flavor: 'ohMyPi',
      hostPid: 321,
      path: '/repo',
      startedBy: 'daemon',
    };
    const updateMetadata = vi.fn((updater: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
      metadataSnapshot = updater(metadataSnapshot);
      return metadataSnapshot;
    });

    (capturedConfig as Readonly<{ createRuntime: (args: any) => unknown }>).createRuntime({
      directory: '/repo',
      machineId: 'machine-123',
      session: {
        sessionId: 'session-1',
        updateMetadata,
        getMetadataSnapshot: () => metadataSnapshot,
      },
      messageBuffer: { id: 'buffer-1' },
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn() },
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      memoryRecallGuidanceEnabled: false,
    });

    const runtimeArgs = createCatalogProviderAcpRuntimeMock.mock.calls.at(-1)?.[0];
    runtimeArgs?.onSessionIdChange?.('omp-session-1');
    await vi.waitFor(() => {
      expect(writeSessionMarkerMock).toHaveBeenCalledTimes(1);
    });

    expect(updateMetadata).toHaveBeenCalledTimes(1);
    expect(writeSessionMarkerMock).toHaveBeenCalledWith(expect.objectContaining({
      pid: 321,
      happySessionId: 'session-1',
      flavor: 'ohMyPi',
      cwd: '/repo',
      processCommandHash: 'a'.repeat(64),
      processCommand: 'oh-my-pi --run',
      respawn: { version: 1, directory: '/repo', backendTarget: { kind: 'builtInAgent', agentId: 'ohMyPi' } },
      metadata: expect.objectContaining({
        flavor: 'ohMyPi',
        hostPid: 321,
        path: '/repo',
        startedBy: 'daemon',
        ohMyPiSessionId: 'omp-session-1',
      }),
    }));
  });
});
