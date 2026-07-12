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
    const capturedConfig: { current: null | Readonly<{ createRuntime: (args: any) => unknown }> } = { current: null };
    runStandardAcpProviderMock.mockImplementation(async (_opts: unknown, config: unknown) => {
      capturedConfig.current = config as Readonly<{ createRuntime: (args: any) => unknown }>;
    });

    const runtime = { kind: 'runtime' };
    createCatalogProviderAcpRuntimeMock.mockReturnValue(runtime);

    await runCatalogDefinedAcpAgent('kiro', {
      credentials: { token: 'token' } as any,
    });

    if (!capturedConfig.current) {
      throw new Error('Expected ACP runtime config to be captured');
    }

    const runtimeConfig = capturedConfig.current;
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
      sessionIdentity: { kind: 'manifest-metadata' },
      memoryRecallGuidance: {
        enabled: true,
        machineId: 'machine-123',
      },
    }));
  });

  it('derives runtime-only identity for catalog agents whose manifest does not support vendor resume', async () => {
    const capturedConfig: { current: null | Readonly<{ createRuntime: (args: any) => unknown }> } = { current: null };
    runStandardAcpProviderMock.mockImplementation(async (_opts: unknown, config: unknown) => {
      capturedConfig.current = config as Readonly<{ createRuntime: (args: any) => unknown }>;
    });
    createCatalogProviderAcpRuntimeMock.mockReturnValue({ kind: 'runtime' });

    await runCatalogDefinedAcpAgent('customAcp', {
      credentials: { token: 'token' } as any,
    });

    if (!capturedConfig.current) throw new Error('Expected ACP runtime config to be captured');
    capturedConfig.current.createRuntime({
      directory: '/repo',
      machineId: 'machine-123',
      session: { id: 'session-1' },
      messageBuffer: { id: 'buffer-1' },
      mcpServers: {},
      permissionHandler: { handleToolCall: vi.fn() },
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      memoryRecallGuidanceEnabled: false,
    });

    expect(createCatalogProviderAcpRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'customAcp',
      sessionIdentity: { kind: 'runtime-only', reason: 'vendor-resume-unsupported' },
    }));
  });
});
