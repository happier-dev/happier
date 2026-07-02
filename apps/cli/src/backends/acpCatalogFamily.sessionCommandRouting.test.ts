import { describe, expect, it, vi } from 'vitest';

const runBackendSessionCliCommandMock = vi.fn(async (_params: unknown) => undefined);

vi.mock('@/cli/runBackendSessionCliCommand', () => ({
  runBackendSessionCliCommand: runBackendSessionCliCommandMock,
}));

import type { CommandContext } from '@/cli/commandRegistry';

const providers = Object.freeze([
  { id: 'pi', importHandler: async () => (await import('@/backends/pi/cli/command')).handlePiCliCommand },
] as const);

describe('ACP catalog family CLI session commands (routing)', () => {
  it('routes through backendIdForSessionRuntime (no loadRun) for each host-owned ACP provider', async () => {
    for (const provider of providers) {
      runBackendSessionCliCommandMock.mockClear();
      const handler = await provider.importHandler();

      const context: CommandContext = {
        args: [provider.id],
        rawArgv: [provider.id],
        terminalRuntime: null,
      };
      await handler(context);

      expect(runBackendSessionCliCommandMock).toHaveBeenCalledTimes(1);
      const callArg = runBackendSessionCliCommandMock.mock.calls[0]![0] as unknown as Record<string, unknown>;

      expect(callArg).toEqual(expect.objectContaining({
        backendIdForSessionRuntime: provider.id,
        agentIdForAccountSettings: provider.id,
      }));
      expect('loadRun' in callArg).toBe(false);
    }
  });
});
