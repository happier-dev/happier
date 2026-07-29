import { describe, expect, it, vi } from 'vitest';

const registerExternalSessions = vi.hoisted(() => vi.fn<
  (input: Readonly<Record<string, unknown>>) => Readonly<{
    dispose(): Promise<void>;
  }>
>(() => ({
  dispose: vi.fn(async () => undefined),
})));

vi.mock('./rpcHandlers.externalSessions', () => ({
  registerMachineExternalSessionsRpcHandlers: registerExternalSessions,
}));

import { registerMachineRpcHandlers } from './rpcHandlers';

describe('machine RPC session-hook production composition', () => {
  it('passes currentMachineId independently of status-demand availability', async () => {
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const registration = registerMachineRpcHandlers({
      rpcHandlerManager: {
        registerHandler: (
          method: string,
          handler: (input: unknown) => Promise<unknown>,
        ) => {
          handlers.set(method, handler);
        },
      } as never,
      handlers: {
        spawnSession: async () => ({
          type: 'success' as const,
          sessionId: 'session-1',
        }),
        stopSession: async () => true,
        requestShutdown: () => undefined,
      },
      deps: {
        currentMachineId: 'machine-1',
      },
    });

    expect(registerExternalSessions).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
    }));
    expect(registerExternalSessions.mock.calls[0]?.[0]).not.toHaveProperty(
      'statusDemand',
    );

    await registration.dispose();
  });
});
