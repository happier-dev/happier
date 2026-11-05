import { afterEach, expect, it, vi } from 'vitest';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => { await disposeHome?.(); disposeHome = undefined; });

it('shares Account facts during cold restore while preserving a fresh authority admission', async () => {
    const accountId = 'cold-start-reads';
    const counts = new Map<string, number>();
    const { profileDefaults } = await import('@/sync/domains/profiles/profile');
    const restored = await restoreServerAccountForTest({ serverUrl: 'https://cold-start-reads.test', accountId,
        configureSocket: configureConnectedServerSocketBoundary,
        request: async (input, init) => {
            const path = new URL(String(input)).pathname;
            counts.set(path, (counts.get(path) ?? 0) + 1);
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
            if (path === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
            if (path === '/v2/changes') return Response.json({ changes: [], nextCursor: 0 });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        },
    });
    disposeHome = restored.dispose;
    const { sync } = await import('./syncEngine');
    await sync.awaitBootstrapForegroundAcquisition();
    await sync.applyAuthoringMemoryDelta({});
    // Initial Settings admission and the later legacy import are separate
    // operations. The import's three unchanged aliases share one census.
    expect(counts.get('/v2/account/settings')).toBe(2);
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { fetchAccountEncryptionIdentity, fetchAccountEncryptionMode } = await import('@/sync/api/account/apiAccountEncryptionMode');
    const context = await captureLazyActionAccountContext(restored.serverId);
    try {
        const beforeBorrowers = counts.get('/v1/account/encryption/currentness') ?? 0;
        const identities = await Promise.all(Array.from({ length: 20 }, () => fetchAccountEncryptionIdentity(
            context.credentials, { request: context.request, usage: 'identity' })));
        expect(identities.every(identity => identity.mode === 'plain')).toBe(true);
        // The lazy context has not admitted its transport yet. Concurrent identity
        // borrowers of this exact request still own only one physical read.
        expect((counts.get('/v1/account/encryption/currentness') ?? 0) - beforeBorrowers).toBe(1);
        const beforeAuthority = counts.get('/v1/account/encryption/currentness') ?? 0;
        await fetchAccountEncryptionIdentity(context.credentials, { request: context.request, usage: 'fresh-authority' });
        expect(counts.get('/v1/account/encryption/currentness')).toBe(beforeAuthority + 1);
        await context.resolveAccountMode();
        const beforeBoundReads = {
            mode: counts.get('/v1/account/encryption') ?? 0,
            currentness: counts.get('/v1/account/encryption/currentness') ?? 0,
        };
        await Promise.all(Array.from({ length: 20 }, () => fetchAccountEncryptionMode(context.credentials, {
            request: context.request, usage: 'identity',
        })));
        expect({ mode: counts.get('/v1/account/encryption') ?? 0,
            currentness: counts.get('/v1/account/encryption/currentness') ?? 0 }).toEqual(beforeBoundReads);
    } finally { context.dispose(); }
});
