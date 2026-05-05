import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

const { runHostSessionRuntimeMock } = vi.hoisted(() => ({
  runHostSessionRuntimeMock: vi.fn(),
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

vi.mock('@/agent/runtime/session/loop/runHostSessionRuntime', () => ({
  runHostSessionRuntime: runHostSessionRuntimeMock,
}));

vi.mock('@/backends/pi/acp/runtime', () => ({
  createPiAcpRuntime: vi.fn(),
}));

vi.mock('@/backends/pi/ui/PiTerminalDisplay', () => ({
  PiTerminalDisplay: vi.fn(),
}));

describe('Pi runtimeCore session runtime', () => {
  const credentials: Credentials = {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array([1]) },
  };

  let runPiSessionRuntime: typeof import('./session').runPiSessionRuntime;

  beforeAll(async () => {
    ({ runPiSessionRuntime } = await import('./session'));
  }, 60_000);

  beforeEach(() => {
    runHostSessionRuntimeMock.mockReset();
    runHostSessionRuntimeMock.mockResolvedValue(undefined);
  });

  it('disables MCP server resolution for Pi sessions', async () => {
    await runPiSessionRuntime({ credentials });

    expect(runHostSessionRuntimeMock).toHaveBeenCalledTimes(1);
    const runtimeConfig = runHostSessionRuntimeMock.mock.calls[0]?.[1] as {
      resolvePermissionModeQueueKey?: (permissionMode?: string) => string;
    } | undefined;

    expect(runtimeConfig).toMatchObject({
      flavor: 'pi',
      supportsMcpServers: false,
    });
    expect(runtimeConfig?.resolvePermissionModeQueueKey?.('read-only')).toBe('read,grep,find,ls');
    expect(runtimeConfig?.resolvePermissionModeQueueKey?.('acceptEdits')).toBe('read,edit,write,grep,find,ls');
  });
});
