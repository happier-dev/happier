import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';

const { runStandardAcpProviderMock } = vi.hoisted(() => ({
  runStandardAcpProviderMock: vi.fn(),
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

vi.mock('@/backends/pi/acp/runtime', () => ({
  createPiAcpRuntime: vi.fn(),
}));

vi.mock('@/backends/pi/acp/backend', async () => {
  const actual = await vi.importActual<typeof import('@/backends/pi/acp/backend')>('@/backends/pi/acp/backend');
  return {
    ...actual,
    buildPiToolsForPermissionMode: actual.buildPiToolsForPermissionMode,
  };
});

vi.mock('@/backends/pi/ui/PiTerminalDisplay', () => ({
  PiTerminalDisplay: vi.fn(),
}));

describe('runPi', () => {
  const credentials: Credentials = {
    token: 'test-token',
    encryption: { type: 'legacy', secret: new Uint8Array([1]) },
  };

  let runPi: typeof import('./runPi').runPi;

  beforeAll(async () => {
    ({ runPi } = await import('./runPi'));
  }, 60_000);

  beforeEach(() => {
    runStandardAcpProviderMock.mockReset();
    runStandardAcpProviderMock.mockResolvedValue(undefined);
  });

  it('disables MCP server resolution for Pi sessions', async () => {
    await runPi({ credentials });

    expect(runStandardAcpProviderMock).toHaveBeenCalledTimes(1);
    expect(runStandardAcpProviderMock.mock.calls[0]?.[1]).toMatchObject({
      flavor: 'pi',
      supportsMcpServers: false,
    });
  });
});
