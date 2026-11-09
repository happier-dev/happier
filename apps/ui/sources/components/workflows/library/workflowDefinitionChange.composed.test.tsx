import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { CurrentCursorResponseSchema, type ChangeEntry } from '@happier-dev/protocol/changes';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createArtifactBodyUpdateFixture, createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
installDisconnectedServerSocketBoundary();
// Load the real cold Sync graph during collection, outside the per-hook budget.
await loadSyncSingletonForTests();
let disposeHome: (() => Promise<void>) | undefined;
afterEach(async () => { await standardCleanup(); await disposeHome?.(); disposeHome = undefined; });

it('one committed definition save publishes one fact and reads only that Artifact; unrelated changes read none', async () => {
    const accountId = 'definition-change-account';
    const definitionId = '00000000-0000-4000-8000-000000000273';
    const boundary = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'plain' });
    const requests: { path: string; method: string; afterSave: boolean; ids?: unknown }[] = [];
    let afterSave = false;
    let deletionReadBaseline = 0;
    let unrelatedChange: ChangeEntry | undefined;
    let socket: Socket | undefined;
    const { profileDefaults } = await import('@/sync/domains/profiles/profile');
    const restored = await restoreServerAccountForTest({
        serverUrl: 'https://definition-change.example.test', accountId,
        configureSocket: port => { socket = port; configureConnectedServerSocketBoundary(port); },
        request: async (input, init) => {
            const url = new URL(String(input));
            const path = url.pathname;
            const method = init?.method ?? 'GET';
            const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
            requests.push({ path, method, afterSave,
                ...(body && typeof body === 'object' && 'artifactIds' in body ? { ids: body.artifactIds } : {}) });
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: accountId });
            if (path === '/v3/automations/query') return Response.json({ automations: [], nextCursor: null });
            if (unrelatedChange && path === '/v2/changes') {
                const after = Number(url.searchParams.get('after') ?? 0);
                return Response.json({ changes: after < unrelatedChange.cursor ? [unrelatedChange] : [],
                    nextCursor: Math.max(after, unrelatedChange.cursor) });
            }
            if (unrelatedChange && path === '/v2/cursor') return Response.json({ cursor: unrelatedChange.cursor, changesFloor: 0 });
            const response = await boundary.handle(url.pathname + url.search, init);
            if (method === 'DELETE' && response?.ok) deletionReadBaseline = requests.filter(r => r.path === '/v1/artifacts/read').length;
            if (path.startsWith(`/v1/artifacts/${definitionId}`) && (method === 'POST' || method === 'DELETE') && response?.ok) afterSave = true;
            return response ?? createEmptyAccountBootstrapHttpResponse(path, init);
        },
    });
    disposeHome = restored.dispose;
    const { sync } = await import('@/sync/sync');
    const { createWorkflowDefinition, updateWorkflowDefinition, deleteWorkflowDefinition } = await import('@/sync/domains/workflows/workflowDefinitionActions');
    const { subscribeHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const { useWorkflowDefinitionLibrary } = await import('./workflowLibraryReads');
    await sync.awaitBootstrapForegroundAcquisition();
    const definition = createWorkflowDefinitionFixture({ blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } }] });
    const created = await createWorkflowDefinition({ definitionId, definition, metadata: { title: 'Before' } });
    // The observed Account B control held eleven definitions. Exact change work
    // must stay selected at that corpus size, with neighboring identities retained.
    const neighborIds = Array.from({ length: 10 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
    for (const id of neighborIds) await createWorkflowDefinition({ definitionId: id, definition, metadata: { title: 'Neighbor' } });
    await sync.resumeSync('changes-catch-up');
    const hook = await renderHook(() => useWorkflowDefinitionLibrary());
    const secondReader = await renderHook(() => useWorkflowDefinitionLibrary());
    await waitForHomeGovernance(() => expect(hook.getCurrent().definitions).toHaveLength(11));
    const neighbor = hook.getCurrent().definitions.find(row => row.definitionId === neighborIds[0]);
    await waitForHomeGovernance(() => expect(secondReader.getCurrent().status).toBe('loaded'));
    const wakes: unknown[] = [];
    let unrelatedConsumed = 0;
    const release = subscribeHomeAccountChange(event => {
        if (event.serverId === restored.serverId && event.workflowDefinitionsAffect) wakes.push(event);
        if (event.serverId === restored.serverId && event.feedPageConsumed && event.changeKinds?.includes('session')) unrelatedConsumed++;
    });
    const deliver = async (event: unknown) => {
        if (!socket || socket.listenersAny().length === 0) throw new Error('Home update ingress is not registered');
        await act(async () => { await Promise.all(socket!.listenersAny().map(listener => listener('update', event))); });
    };
    try {
        await act(async () => {
            await updateWorkflowDefinition({ definitionId, expectedRevision: created.revision, definition, metadata: { title: 'After' } });
        });
        const stored = boundary.read(definitionId)!;
        await deliver(createArtifactBodyUpdateFixture(stored, 10));
        await deliver({ id: 'definition-feed-wake', seq: 11, createdAt: stored.updatedAt,
            body: { t: 'account-change', entityIds: [definitionId], changeKinds: ['artifact'] } });
        await act(async () => { await sync.resumeSync('changes-catch-up'); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().definitions[0]?.metadata?.title).toBe('After'));
        expect(secondReader.getCurrent().definitions).toBe(hook.getCurrent().definitions);
        expect(hook.getCurrent().definitions.find(row => row.definitionId === neighborIds[0])).toBe(neighbor);
        expect.soft(wakes, 'A mutation receipt and its feed row describe one change fact').toHaveLength(1);
        expect.soft(requests.filter(r => r.afterSave && r.path === '/v1/artifacts'), 'An exact change must not list the inventory').toHaveLength(0);
        expect.soft(requests.filter(r => r.afterSave && r.path === '/v1/artifacts/read').map(r => r.ids), 'Only the changed Artifact is refreshed').toEqual([[definitionId]]);

        const saveCounts = { definitions: 11, readers: 2, wakes: wakes.length,
            inventoryReads: requests.filter(r => r.afterSave && r.path === '/v1/artifacts').length,
            exactReads: requests.filter(r => r.afterSave && r.path === '/v1/artifacts/read').length };
        afterSave = false;
        const mutations = () => requests.filter(r => r.path === `/v1/artifacts/${definitionId}` && r.method === 'POST');
        const writesBefore = mutations().length;
        const rowsBefore = hook.getCurrent().definitions;
        await act(async () => { await updateWorkflowDefinition({ definitionId,
            expectedRevision: { headerVersion: stored.headerVersion, bodyVersion: stored.bodyVersion! }, definition, metadata: { title: 'After' } }); });
        expect(mutations()).toHaveLength(writesBefore);
        expect(wakes).toHaveLength(1);
        expect(hook.getCurrent().definitions).toBe(rowsBefore);
        const deleteWakesBefore = wakes.length;
        const deleteInventoryBefore = requests.filter(r => r.path === '/v1/artifacts').length;
        await act(async () => { await deleteWorkflowDefinition({ definitionId }); });
        expect(hook.getCurrent().deletedDefinitionId).toBe(definitionId);
        await deliver({ id: 'deleted-definition-receipt', seq: 13, createdAt: stored.updatedAt,
            body: { t: 'delete-artifact', artifactId: definitionId } });
        await deliver({ id: 'deleted-definition-feed', seq: 14, createdAt: stored.updatedAt,
            body: { t: 'account-change', entityIds: [definitionId], changeKinds: ['artifact'] } });
        await act(async () => { await sync.resumeSync('changes-catch-up'); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().definitions).toHaveLength(10));
        const deleteWakes = wakes.length - deleteWakesBefore;
        const deleteReads = requests.filter(r => r.path === '/v1/artifacts/read').length - deletionReadBaseline;
        expect(deleteWakes, 'Deletion acknowledgement must not publish a competing change fact').toBe(1);
        expect(requests.filter(r => r.path === '/v1/artifacts')).toHaveLength(deleteInventoryBefore);
        expect(deleteReads).toBe(1);

        // The external Session-only page is last so its fixture cursor never
        // replaces the Artifact boundary's independently committed ledger.
        const readCount = requests.filter(r => r.path.startsWith('/v1/artifacts')).length;
        const cursorResponse = await boundary.handle('/v2/cursor');
        const { cursor } = CurrentCursorResponseSchema.parse(await cursorResponse!.json());
        unrelatedChange = { kind: 'session', entityId: 'unrelated-session', cursor: cursor + 1, changedAt: stored.updatedAt, hint: null };
        await deliver({ id: 'unrelated-session-wake', seq: 15, createdAt: stored.updatedAt,
            body: { t: 'account-change', entityIds: ['unrelated-session'], changeKinds: ['session'] } });
        await act(async () => { await sync.resumeSync('changes-catch-up'); });
        expect(wakes).toHaveLength(deleteWakesBefore + 1);
        expect(unrelatedConsumed).toBe(1);
        const unrelatedReads = requests.filter(r => r.path.startsWith('/v1/artifacts')).length - readCount;
        expect(unrelatedReads).toBe(0);
        console.info('FIX273_F4_COUNTS', JSON.stringify({ ...saveCounts, unrelatedReads,
            unchangedSaveWrites: mutations().length - writesBefore, deleteWakes, deleteReads }));
    } finally { release(); await secondReader.unmount(); await hook.unmount(); }
});
