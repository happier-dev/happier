import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { storage } from '@/sync/domains/state/storage';
import type { InvalidateSync } from '@/utils/sessions/sync';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => { await disposeHome?.(); disposeHome = undefined; });

// A cold process has no preceding Home transition. Mixing this case into a
// multi-Home singleton suite legitimately adds the incumbent recovery reads.
it('captures one initial base across cold Account restore before the first feed checkpoint', async () => {
    const accountId = 'initial-base-account';
    const fleet = Array.from({ length: 137 }, (_, index) => createPlainMachineRowFixture({ id: `initial-${index}`, accountId }));
    const requests: string[] = [];
    const { profileDefaults } = await import('@/sync/domains/profiles/profile');
    const restored = await restoreServerAccountForTest({
        serverUrl: 'https://initial-base.example.test', accountId,
        request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            requests.push(path);
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
            if (path === '/v2/cursor') return Response.json({ cursor: 37, changesFloor: 0 });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 37 });
            if (path === '/v1/machines') return Response.json(fleet);
            if (path === '/v1/artifacts') return Response.json([]);
            if (path === '/v1/friends' || path === '/v1/friends/requests') return Response.json({ friends: [], requests: [] });
            if (path === '/v1/kv') return Response.json({ items: [] });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        },
    });
    disposeHome = restored.dispose;
    const { sync } = await import('@/sync/sync');
    const queues = sync as unknown as { settingsSync: InvalidateSync; profileSync: InvalidateSync;
        machinesSync: InvalidateSync; sessionsSync: InvalidateSync; artifactsSync: InvalidateSync; pluginAvailabilitySync: InvalidateSync };
    const settleInventory = () => Promise.all([queues.settingsSync, queues.profileSync, queues.machinesSync, queues.sessionsSync,
        queues.artifactsSync, queues.pluginAvailabilitySync].map(queue => queue.awaitQueue()));
    await sync.awaitBootstrapForegroundAcquisition();
    await sync.refreshMachines();
    await settleInventory();
    expect(requests.filter(path => path === '/v2/cursor')).toHaveLength(1);
    expect(requests.filter(path => path === '/v2/changes')).toHaveLength(0);
    // A new object with byte-equal credentials is the same Account authority.
    await sync.switchServer({ ...restored.credentials });
    await sync.awaitBootstrapForegroundAcquisition();
    await sync.refreshMachines();
    await sync.resumeSync('changes-catch-up');
    await settleInventory();
    expect(requests.filter(path => path === '/v2/cursor')).toHaveLength(1);
    expect(Object.keys(storage.getState().machines)).toHaveLength(137);
});
