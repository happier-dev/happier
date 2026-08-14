import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StandardAcpProviderConfig } from '@/agent/runtime/runStandardAcpProvider';
import type { Credentials } from '@/persistence';

const { runStandardAcpProviderMock, createKimiAcpRuntimeMock } = vi.hoisted(() => ({
  runStandardAcpProviderMock: vi.fn(),
  createKimiAcpRuntimeMock: vi.fn(),
}));

vi.mock('@/daemon/startDaemon', () => ({
  initialMachineMetadata: {
    host: 'host',
    platform: 'darwin',
    happyCliVersion: '1.0.0',
    homeDir: '/tmp',
    happyHomeDir: '/tmp/.happy',
    happyLibDir: '/tmp/lib',
  },
}));

vi.mock('@/agent/runtime/runStandardAcpProvider', () => ({
  runStandardAcpProvider: runStandardAcpProviderMock,
}));

vi.mock('@/backends/kimi/acp/runtime', () => ({
  createKimiAcpRuntime: createKimiAcpRuntimeMock,
}));

vi.mock('@/backends/kimi/ui/KimiTerminalDisplay', () => ({
  KimiTerminalDisplay: vi.fn(),
}));

describe('runKimi', () => {
  const credentials: Credentials = {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array([1]) },
  };

  let runKimi: typeof import('./runKimi').runKimi;

  beforeAll(async () => {
    ({ runKimi } = await import('./runKimi'));
  }, 60_000);

  beforeEach(() => {
    runStandardAcpProviderMock.mockReset();
    runStandardAcpProviderMock.mockResolvedValue(undefined);
    createKimiAcpRuntimeMock.mockReset();
    createKimiAcpRuntimeMock.mockReturnValue({ dispose: vi.fn() });
  });

  it('passes the Kimi ACP Python selector setting to the ACP runtime backend', async () => {
    await runKimi({
      credentials,
      kimiAcpPythonSelector: 'poll',
    });

    const config = runStandardAcpProviderMock.mock.calls[0]?.[1] as StandardAcpProviderConfig | undefined;
    expect(config).toBeDefined();

    config?.createRuntime({
      directory: '/repo',
      metadata: { path: '/repo' } as never,
      machineId: 'machine-1',
      session: { sessionId: 'session-1', updateMetadata: vi.fn() } as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: { requestPermission: vi.fn() } as never,
      getPermissionMode: () => 'default',
      getAbortSignal: () => new AbortController().signal,
      setThinking: vi.fn(),
      memoryRecallGuidanceEnabled: false,
      turnAssistantPreviewTracker: {} as never,
      providerInputConsumer: {} as never,
    });

    expect(createKimiAcpRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      kimiAcpPythonSelector: 'poll',
    }));
  });
});
