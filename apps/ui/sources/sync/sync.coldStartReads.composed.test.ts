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
    // Foreground Settings admission owns its read; Authoring Memory no longer imports Settings.
    const settingsReads = counts.get('/v2/account/settings') ?? 0;
    expect(settingsReads).toBe(1);
    await sync.applyAuthoringMemoryDelta({});
    expect((counts.get('/v2/account/settings') ?? 0) - settingsReads).toBe(0);
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

it('hydrates Sessions over the connected Account socket through its admitted mode, and re-reads after transport loss or mode retirement', async () => {
    const accountId = 'socket-bound-hydration';
    const counts = new Map<string, number>();
    const { profileDefaults } = await import('@/sync/domains/profiles/profile');
    const { createPlainSessionCurrentProjectionRecordFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    let socket: import('socket.io-client').Socket | undefined;
    const restored = await restoreServerAccountForTest({ serverUrl: 'https://socket-bound-hydration.test', accountId,
        configureSocket: current => { socket = current; configureConnectedServerSocketBoundary(current); },
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
            const session = /^\/v2\/sessions\/(socket-bound-[^/]+)$/.exec(path);
            if (session) return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: session[1]! }) });
            const turns = /^\/v1\/sessions\/(socket-bound-[^/]+)\/turns$/.exec(path);
            if (turns) return Response.json({ v: 1, sessionId: turns[1]!, updatedAt: 1, turns: [] });
            return createEmptyAccountBootstrapHttpResponse(path, init);
        },
    });
    disposeHome = restored.dispose;
    const { sync } = await import('./syncEngine');
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    const { invalidateAccountEncryptionModeCacheForChanges } = await import('@/sync/api/account/apiAccountEncryptionMode');
    await sync.awaitBootstrapForegroundAcquisition();
    const currentnessReads = () => counts.get('/v1/account/encryption/currentness') ?? 0;
    const hydrate = async (sessionId: string) => expect(await sync.ensureSessionVisibleForMessageRoute(sessionId, {
        serverId: restored.serverId, forceRefresh: true, hydrateMessages: false,
    })).toMatchObject({ kind: 'available' });
    // The connected Account socket holds the admitted, settled mode.
    await apiSocket.getAccountEncryptionObservationBinding(restored.credentials)!.read();
    const settled = currentnessReads();
    for (let index = 0; index < 10; index++) await hydrate(`socket-bound-${index}`);
    expect(currentnessReads() - settled).toBe(0);

    // A new socket configuration replaces the transport: its predecessor's mode is
    // never borrowed, and hydrations borrow the replacement once it settles.
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
    const replacedBinding = apiSocket.getAccountEncryptionObservationBinding(restored.credentials)!;
    const serverUrl = 'https://socket-bound-hydration.test';
    const beforeReplacementRead = currentnessReads();
    apiSocket.initialize({ endpoint: serverUrl, token: restored.credentials.token, credentials: restored.credentials,
        serverId: restored.serverId, generation: getActiveServerSnapshot().generation,
        request: createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId: restored.serverId, credentials: restored.credentials }),
        isCurrent: () => true }, null);
    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    await waitForHomeGovernance(() => expect(apiSocket.getAccountEncryptionObservationBinding(restored.credentials)).not.toBeNull());
    const replacement = apiSocket.getAccountEncryptionObservationBinding(restored.credentials)!;
    expect(replacement).not.toBe(replacedBinding);
    expect(replacedBinding.isCurrent()).toBe(false);
    // Connecting admits the fresh observation before any hydration borrows it.
    await expect(replacement.read()).resolves.toMatchObject({ mode: 'plain' });
    expect(currentnessReads() - beforeReplacementRead).toBeGreaterThanOrEqual(1);
    const replacementSettled = currentnessReads();
    await hydrate('socket-bound-after-replacement');
    for (let index = 0; index < 3; index++) await hydrate(`socket-bound-replacement-${index}`);
    expect(currentnessReads() - replacementSettled).toBe(0);

    // A committed mode change retires the admitted mode: the next hydration re-reads.
    invalidateAccountEncryptionModeCacheForChanges([{ kind: 'account', entityId: 'self', hint: { encryptionMode: 'plain' } }],
        { serverId: restored.serverId });
    const retired = currentnessReads();
    await hydrate('socket-bound-after-retirement');
    expect(currentnessReads() - retired).toBe(1);

    // Transport loss withdraws the socket binding: no hydration borrows its mode,
    // and the next one admits a fresh read.
    const withdrawn = apiSocket.getAccountEncryptionObservationBinding(restored.credentials)!;
    socket!.connected = false;
    for (const listener of socket!.listeners('disconnect')) listener('transport close');
    expect(apiSocket.getAccountEncryptionObservationBinding(restored.credentials)).toBeNull();
    expect(withdrawn.peek()).toBeNull();
    const lost = currentnessReads();
    await hydrate('socket-bound-after-loss');
    expect(currentnessReads() - lost).toBeGreaterThanOrEqual(1);
});
