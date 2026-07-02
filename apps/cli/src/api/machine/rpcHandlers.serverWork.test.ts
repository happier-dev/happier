import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineRpcHandlers } from './rpcHandlers';

describe('rpcHandlers.serverWork', () => {
  it('exposes daemon server-work telemetry through machine RPC', async () => {
    const registered = new Map<string, (raw: unknown) => Promise<unknown>>();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => {
        registered.set(method, handler);
      },
    };

    registerMachineRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as any,
      handlers: {
        spawnSession: async () => ({ type: 'success', sessionId: 's1' } as const),
        stopSession: async () => true,
        requestShutdown: () => {},
        daemonServerWorkScheduler: {
          getSnapshot: () => ({
            pendingKeyCount: 1,
            pendingPayloadBytes: 42,
            purposes: {
              connectedServiceQuotaPersistence: {
                counters: {
                  accepted: 3,
                  coalesced: 2,
                  suppressed: 0,
                  written: 1,
                  failed: 1,
                  deferred: 1,
                  retried: 1,
                },
              },
            },
            keys: {
              'quota:server=abc:account=def:service=openai-codex:profile=work': {
                timeSinceLastSuccessMs: 250,
                backoffReason: 'network',
                nextEligibleAt: 1234,
              },
            },
          }),
        },
      } as any,
    });

    const handler = registered.get((RPC_METHODS as any).DAEMON_SERVER_WORK_STATUS);
    expect(handler).toBeDefined();

    const out = await handler!(null) as any;
    expect(out.v).toBe(1);
    expect(out.pendingKeyCount).toBe(1);
    expect(out.pendingPayloadBytes).toBe(42);
    expect(out.purposes.connectedServiceQuotaPersistence.counters).toMatchObject({
      accepted: 3,
      coalesced: 2,
      written: 1,
      failed: 1,
      deferred: 1,
      retried: 1,
    });
    expect(out.keys['quota:server=abc:account=def:service=openai-codex:profile=work']).toMatchObject({
      timeSinceLastSuccessMs: 250,
      backoffReason: 'network',
      nextEligibleAt: 1234,
    });
  });
});
