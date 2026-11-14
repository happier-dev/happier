import { describe, expect, it } from 'vitest';

import { assertProjectReceivingPlacement } from './projectReceivingPlacement';

const poolId = '12345678-1234-4234-8234-123456789abc';

describe('assertProjectReceivingPlacement', () => {
  it('uses recipient-projected Pool wire data only for structural membership admission', async () => {
    await expect(assertProjectReceivingPlacement({
      choice: { kind: 'workers', destination: { kind: 'pool', poolId, selection: 'automatic' } },
      sourceMachineId: 'source-machine',
      receivingMachineId: 'receiver-machine',
      readPool: async () => ({
        ok: true,
        result: {
          pool: {
            id: poolId,
            name: { kind: 'available', label: { content: { t: 'plain', v: 'Private builders' }, recipientEnvelope: null } },
            description: { kind: 'unavailable' },
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
            members: [{ machineId: 'receiver-machine', priorityTier: 0, enabled: true, state: 'connected' }],
          },
          availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
        },
      }),
    })).resolves.toBeUndefined();
  });
});
