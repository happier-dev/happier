import { afterEach, describe, expect, it, vi } from 'vitest';

const { runBackendSessionCliCommandMock } = vi.hoisted(() => ({
  runBackendSessionCliCommandMock: vi.fn(async (_params: unknown) => undefined),
}));

vi.mock('@/cli/runBackendSessionCliCommand', () => ({
  runBackendSessionCliCommand: runBackendSessionCliCommandMock,
}));

import { handleBuiltInCliCommand } from './command';

describe('handleBuiltInCliCommand', () => {
  afterEach(() => {
    runBackendSessionCliCommandMock.mockReset();
  });

  it('routes catalog-defined ACP sessions through backendIdForSessionRuntime rather than loadRun', async () => {
    await handleBuiltInCliCommand('kiro', {
      args: ['kiro'],
      rawArgv: ['kiro'],
      terminalRuntime: null,
    } as never);

    expect(runBackendSessionCliCommandMock).toHaveBeenCalledTimes(1);
    const callArg = runBackendSessionCliCommandMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(callArg).toEqual(expect.objectContaining({
      backendIdForSessionRuntime: 'kiro',
      agentIdForAccountSettings: 'kiro',
    }));
    expect(callArg && 'loadRun' in callArg).toBe(false);
  });
});
