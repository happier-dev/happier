import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StandardAcpProviderConfig } from '@/agent/runtime/runStandardAcpProvider';
import type { Credentials } from '@/persistence';

const { runStandardAcpProviderMock, createCursorAcpRuntimeMock } = vi.hoisted(() => ({
  runStandardAcpProviderMock: vi.fn(),
  createCursorAcpRuntimeMock: vi.fn(),
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

vi.mock('@/backends/cursor/acp/runtime', () => ({
  createCursorAcpRuntime: createCursorAcpRuntimeMock,
}));

vi.mock('@/backends/cursor/ui/CursorTerminalDisplay', () => ({
  CursorTerminalDisplay: vi.fn(),
}));

describe('runCursor', () => {
  const credentials: Credentials = {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array([1]) },
  };

  let runCursor: typeof import('./runCursor').runCursor;

  beforeAll(async () => {
    ({ runCursor } = await import('./runCursor'));
  }, 60_000);

  beforeEach(() => {
    runStandardAcpProviderMock.mockReset();
    runStandardAcpProviderMock.mockResolvedValue(undefined);
    createCursorAcpRuntimeMock.mockReset();
    createCursorAcpRuntimeMock.mockReturnValue({ dispose: vi.fn() });
  });

  it('passes Cursor CLI path settings to the ACP runtime backend environment', async () => {
    await runCursor({
      credentials,
      cursorBinaryPath: '/opt/cursor/cursor-agent',
      cursorAgentFallbackEnabled: false,
      cursorApiEndpoint: 'https://cursor.example.test',
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

    expect(createCursorAcpRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        HAPPIER_CURSOR_PATH: '/opt/cursor/cursor-agent',
        HAPPIER_CURSOR_AGENT_FALLBACK_ENABLED: '0',
        HAPPIER_CURSOR_API_ENDPOINT: 'https://cursor.example.test',
      }),
    }));
  });

  it('configures Cursor resume failures to fail closed instead of silently starting fresh', async () => {
    await runCursor({ credentials });

    const config = runStandardAcpProviderMock.mock.calls[0]?.[1] as StandardAcpProviderConfig | undefined;
    expect(config?.failClosedOnResumeFailure).toBe(true);
  });
});
