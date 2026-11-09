import { afterEach, expect, it, vi } from 'vitest';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => { await disposeHome?.(); disposeHome = undefined; });

it('reads an Account Action inventory while unrelated foreground bootstrap is held', async () => {
    const accountId = 'foreground-inventory-account';
    const cursorStarted = createDeferred<void>();
    const releaseCursor = createDeferred<void>();
    let inventoryReads = 0;
    const { profileDefaults } = await import('@/sync/domains/profiles/profile');
    const restored = await restoreServerAccountForTest({ serverUrl: 'https://foreground-inventory.test', accountId,
        request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
            if (path === '/v2/cursor') {
                cursorStarted.resolve();
                await releaseCursor.promise;
                return Response.json({ cursor: 37, changesFloor: 0 });
            }
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 37 });
            if (path === '/v1/artifacts') { inventoryReads++; return Response.json([]); }
            return createEmptyAccountBootstrapHttpResponse(path, init);
        },
    });
    disposeHome = restored.dispose;
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const context = await captureLazyActionAccountContext(restored.serverId);
    let pending: ReturnType<typeof context.listArtifacts> | undefined;
    try {
        await cursorStarted.promise;
        pending = context.listArtifacts({});
        await vi.waitFor(() => expect(inventoryReads).toBe(1));
        expect(await pending).toMatchObject({ items: [] });
    } finally {
        releaseCursor.resolve();
        await pending;
        context.dispose();
    }
});
