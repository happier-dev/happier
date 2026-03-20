import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createCatalogProviderAcpRuntimeMock,
  getProviderCliRuntimeSpecMock,
  runStandardAcpProviderMock,
} = vi.hoisted(() => ({
  createCatalogProviderAcpRuntimeMock: vi.fn(),
  getProviderCliRuntimeSpecMock: vi.fn(),
  runStandardAcpProviderMock: vi.fn(),
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

vi.mock('./ui/CatalogDefinedAcpTerminalDisplay', () => ({
  CatalogDefinedAcpTerminalDisplay: () => null,
}));

import { runCatalogDefinedAcpAgent } from './runCatalogDefinedAcpAgent';

describe('runCatalogDefinedAcpAgent', () => {
  beforeEach(() => {
    createCatalogProviderAcpRuntimeMock.mockReset();
    getProviderCliRuntimeSpecMock.mockReset();
    runStandardAcpProviderMock.mockReset();
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
});
