import { describe, expect, it, vi } from 'vitest';

import type { registerMachineExternalSessionsRpcHandlers } from './rpcHandlers.externalSessions';

const registerExternalSessions = vi.hoisted(() => vi.fn<
  typeof registerMachineExternalSessionsRpcHandlers
>(() => ({
  hostExternalSessionActionExecutor: {
    execute: async () => ({
      ok: false as const,
      errorCode: 'test_fixture_unavailable',
      error: 'External Action ingress is not exercised by this fixture.',
    }),
  },
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
