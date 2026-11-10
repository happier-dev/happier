import { describe, expect, it } from 'vitest';
import { InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry } from './lease';

describe('connected service auth group switch lease', () => {
    it('reports no active profile when a completed result explicitly has no selected profile', async () => {
        const registry = new InMemoryConnectedServiceAuthGroupSwitchLeaseRegistry();
        const input = { serviceId: 'service', groupId: 'group' };
        const owner = registry.acquire(input);
        const waiter = registry.acquire(input);
        if (owner.kind !== 'owner' || waiter.kind !== 'loser') throw new Error('expected shared lease');

        owner.completeResult({
            status: 'no_eligible_member',
            activeProfileId: undefined,
            generation: 1,
            groupExhausted: true,
            retryAtMs: null,
            excluded: [],
        });

        expect(await waiter.waitForOwner()).toMatchObject({ activeProfileId: null, generation: 1 });
    });
});
