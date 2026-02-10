import { describe, expect, it } from 'vitest';

import { invokeRpcAcrossMachineIds } from '../../src/testkit/providers/scenarios/scenarioCatalog';

describe('providers: capability probe RPC ack timeouts', () => {
  it(
    'caps rpcCall ack timeout to the remaining overall budget',
    { timeout: 1_500 },
    async () => {
      const startedAt = Date.now();
      await expect(
        invokeRpcAcrossMachineIds({
          ui: {
            rpcCall: async (_method: string, _payload: string, timeoutMs: number) => {
              // Simulate an RPC layer that blocks until its own timeout.
              await new Promise((resolve) => setTimeout(resolve, timeoutMs));
              return { errorCode: 'RPC_METHOD_NOT_AVAILABLE' };
            },
          } as any,
          machineIds: ['machine-1'],
          method: 'capabilities.detect',
          payload: { hello: 'world' },
          secret: Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1)),
          timeoutMs: 100,
        }),
      ).rejects.toThrow(/unavailable after wait/);

      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(800);
    },
  );

  it(
    'does not hang if rpcCall never resolves',
    { timeout: 1_500 },
    async () => {
      const startedAt = Date.now();
      await expect(
        invokeRpcAcrossMachineIds({
          ui: {
            rpcCall: async () => {
              await new Promise(() => {});
              return { errorCode: 'RPC_METHOD_NOT_AVAILABLE' };
            },
          } as any,
          machineIds: ['machine-1'],
          method: 'capabilities.detect',
          payload: { hello: 'world' },
          secret: Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1)),
          timeoutMs: 75,
        }),
      ).rejects.toThrow(/unavailable after wait/);

      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(800);
    },
  );
});
