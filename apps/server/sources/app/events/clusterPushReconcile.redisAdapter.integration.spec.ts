import { describe, expect, it, vi } from 'vitest';
import { startRedisAdapterRecoveryCluster } from '@/testkit/redisAdapterRecoveryCluster';
import { MACHINE_ACCESS_LOSS_EVENT, registerMachineAccessLossHandler } from './machineAccessLoss';
import { registerClusterPushReconcile } from './clusterPushReconcile';

// A node whose own Redis link fails can lose the access-loss push it publishes (the root
// client rejects the queued PUBLISH after its retries), while its peers' subscribers stay up and
// so never resubscribe. The sender's peers must still re-check once the sender is back.
describe('cluster push reconcile after the sender loses its own Redis link', () => {
    it('makes each peer re-check once when the sender is ready again, and the peer never received the push', async () => {
        const cluster = await startRedisAdapterRecoveryCluster();
        const [nodeA, nodeB] = cluster.nodes;
        const reconciles = { a: 0, b: 0 };
        const releases = [
            registerClusterPushReconcile({ io: nodeA.io, redis: nodeA.owner, reconcile: () => { reconciles.a += 1; } }),
            registerClusterPushReconcile({ io: nodeB.io, redis: nodeB.owner, reconcile: () => { reconciles.b += 1; } }),
        ];
        const received: unknown[] = [];
        releases.push(registerMachineAccessLossHandler(nodeB.io, input => { received.push(input); }));
        try {
            await cluster.refuseNode(0);
            // The access-loss push and a probe share node A's root queue; the probe's rejection marks
            // the moment ioredis gave up on the queued commands (MaxRetriesPerRequestError).
            nodeA.io.serverSideEmit(MACHINE_ACCESS_LOSS_EVENT, { accountId: 'account-1', machineId: 'machine-1' });
            const probe = nodeA.redis.ping().then(() => 'delivered', () => 'rejected');
            expect(await probe).toBe('rejected');
            expect(nodeB.redis.status).toBe('ready');
            await cluster.acceptNode(0);
            await cluster.waitForRecovery();
            await vi.waitFor(() => { if (reconciles.b === 0) throw new Error('Peer has not re-checked yet'); },
                { timeout: 20_000, interval: 50 });
            // Control: the push itself was lost.
            expect(received).toEqual([]);
            // One re-check on the peer (node A re-checks for its own resubscribed subscriber).
            expect(reconciles.b).toBe(1);
        } finally {
            for (const release of releases) release();
            await cluster.close();
        }
    }, 120_000);
});
