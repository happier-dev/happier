import { afterEach, describe, expect, it, vi } from 'vitest';

const { runBackendSessionCliCommandMock } = vi.hoisted(() => ({
  runBackendSessionCliCommandMock: vi.fn(async (_params: unknown) => undefined),
}));

vi.mock('@/cli/runBackendSessionCliCommand', () => ({
  runBackendSessionCliCommand: runBackendSessionCliCommandMock,
}));

import { handleConfiguredAcpCatalogCliCommand } from './handleCatalogCliCommand';

describe('handleConfiguredAcpCatalogCliCommand', () => {
  afterEach(() => {
    runBackendSessionCliCommandMock.mockReset();
  });

  it('routes configured ACP sessions through the concrete backend id and carries the configured backend target via extra options', async () => {
    await handleConfiguredAcpCatalogCliCommand({
      args: ['acp-catalog', '--backend', 'custom-backend'],
      rawArgv: ['acp-catalog', '--backend', 'custom-backend'],
      terminalRuntime: null,
    } as never);

    expect(runBackendSessionCliCommandMock).toHaveBeenCalledTimes(1);
    const callArg = runBackendSessionCliCommandMock.mock.calls[0]?.[0] as {
      backendIdForSessionRuntime?: string;
      loadAccountSettings?: boolean;
      resolveExtraOptions?: (args: string[]) => Record<string, unknown>;
      loadRun?: unknown;
    } | undefined;

    expect(callArg).toEqual(expect.objectContaining({
      backendIdForSessionRuntime: 'custom-backend',
      loadAccountSettings: true,
      resolveExtraOptions: expect.any(Function),
    }));
    expect(callArg).not.toHaveProperty('runtimeAuthorityAgentId');
    expect(callArg && 'loadRun' in callArg).toBe(false);
    expect(callArg?.resolveExtraOptions?.(['--backend', 'custom-backend'])).toEqual({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-backend' },
    });
  });
});
