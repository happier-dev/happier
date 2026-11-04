import { expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { CurrentCursorResponseSchema, CursorGoneErrorSchema } from '@happier-dev/protocol/changes';
import { ArtifactReadBatchHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createPlainAccountEncryptionCurrentnessFixture } from '../fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '../fixtures/projectAccountRows';
import { createEmptyAccountBootstrapHttpResponse } from '../fixtures/accountBootstrapHttpBoundary';
import { createArtifactListHttpResponse, createArtifactReadBatchHttpResponse, projectArtifactBoundaryReadRow, type ArtifactStoreBoundary } from './artifactStoreBoundary';
import { installSessionOpsNetworkBoundary, type SessionOpsNetworkBoundary } from './sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from './syncSingletonLoader';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import type { InvalidateSync } from '@/utils/sessions/sync';
import type { ChangesCursorScope } from '@/sync/domains/state/persistence';

/** Prime the real Sync graph only after its transport boundary is installed. */
export async function initializeArtifactInventoryDemandHarness() {
    const network = await installSessionOpsNetworkBoundary();
    try { await loadSyncSingletonForTests(); } finally { await network.dispose(); }
}

/** Shared native and web demand scenarios replace HTTP/Socket/OS ports, keeping Sync and stores real. */
export async function createArtifactInventoryDemandHarness() {
    const network = await installSessionOpsNetworkBoundary();
    const fixture: {
        network: SessionOpsNetworkBoundary;
        pages: Array<{ kinds: string | null; headers: number }>;
        inventory: Artifact[];
        artifactStore: ArtifactStoreBoundary | null;
        artifactWrites: Array<{ path: string; body: unknown }>;
        holdList: ((signal?: AbortSignal | null, url?: URL) => Promise<void>) | null;
        holdBodies: (() => Promise<void>) | null;
        bodyReads: string[][];
        headerReads: string[][];
        exactReads: string[];
        currentCursor: number;
        changesReads: Array<{ after: string | null; outcome: 'gone' | 'ok'; cursor: number }>;
        cursorReads: number[];
        accountId: string;
        cursorGone: boolean;
        listFailure: number | null;
    } = { network, pages: [], inventory: [], artifactStore: null, artifactWrites: [], holdList: null, holdBodies: null, bodyReads: [], headerReads: [], exactReads: [],
        currentCursor: 0, changesReads: [], cursorReads: [], accountId: '', cursorGone: false, listFailure: null };

    async function recoverSnapshot() {
        const { sync } = await import('@/sync/sync');
        await (sync as unknown as { snapshotRefreshOnResume(options: { mode: 'fallback'; reason: string }): Promise<void> })
            .snapshotRefreshOnResume({ mode: 'fallback', reason: 'artifact-demand-contract' });
    }
    async function settleInventory() {
        const { sync } = await import('@/sync/sync');
        await (sync as unknown as { artifactsSync: InvalidateSync }).artifactsSync.awaitQueue();
    }
    async function readChangesCursor() {
        const { sync } = await import('@/sync/sync');
        const { loadChangesCursor } = await import('@/sync/domains/state/persistence');
        // Web checkpoints include the incumbent tab identity, not just Home + Account.
        const scope = (sync as unknown as { getChangesCursorScope(): ChangesCursorScope | null }).getChangesCursorScope();
        return loadChangesCursor(scope);
    }
    async function readChangesCursorState() {
        const { sync } = await import('@/sync/sync');
        const owner = sync as unknown as { getChangesCursorScope(): ChangesCursorScope | null; changesCursor: string | null };
        return { persisted: await readChangesCursor(), live: owner.changesCursor, scope: owner.getChangesCursorScope(),
            changesReads: fixture.changesReads, cursorReads: fixture.cursorReads };
    }
    async function dispose() {
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        await network.dispose();
    }
    try {
        const home = await fixture.network.addHome('https://artifact-demand.example.test', 'artifact-demand-account');
        fixture.accountId = home.accountId;
        fixture.inventory = Array.from({ length: 3502 }, (_, index): Artifact => {
            const kind = index === 0 ? 'prompt_doc.v2' : index === 1 ? 'approval_request.v1' : 'markdown';
            return { id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
                kind: 'other', kindHint: kind, ownerAccountId: home.accountId, access: 'owner',
                encryptionMode: 'plain', publicAudience: 'none',
                header: encodePlainArtifactStoredContent({ kind, title: 'Inventory fixture' }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                headerVersion: 1, bodyVersion: 1, seq: index, createdAt: index, updatedAt: index };
        });
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        network.setHttpResponder(async (input, init) => {
            const url = new URL(String(input));
            const path = url.pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            if (path === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (path === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture());
            if (path === '/v2/account/session-drafts/list') return Response.json({ items: [] });
            if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: fixture.accountId });
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                features: { workflows: { enabled: false }, automations: { enabled: false }, social: { friends: { enabled: false } } },
            }));
            if (path === '/v2/cursor') {
                fixture.cursorReads.push(fixture.currentCursor);
                return Response.json(CurrentCursorResponseSchema.parse({ cursor: fixture.currentCursor, changesFloor: 0 }));
            }
            if (path === '/v2/changes') {
                if (fixture.cursorGone) {
                    fixture.cursorGone = false;
                    fixture.changesReads.push({ after: url.searchParams.get('after'), outcome: 'gone', cursor: fixture.currentCursor });
                    return Response.json(CursorGoneErrorSchema.parse({ error: 'cursor-gone', currentCursor: fixture.currentCursor }), { status: 410 });
                }
                fixture.changesReads.push({ after: url.searchParams.get('after'), outcome: 'ok', cursor: fixture.currentCursor });
                return Response.json({ changes: [], nextCursor: fixture.currentCursor });
            }
            if (path === '/v2/sessions' || path === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            if (path === '/v2/session-organization') return Response.json({ error: 'Not found' }, { status: 404 });
            if (path === '/v1/machines') return Response.json([]);
            if (path === '/v1/artifacts') {
                if (fixture.listFailure) return Response.json({ error: 'artifact_access_forbidden' }, { status: fixture.listFailure });
                const response = await fixture.artifactStore?.handle(path + url.search, init)
                    ?? createArtifactListHttpResponse(url, fixture.inventory);
                const body = await response.clone().json();
                fixture.pages.push({ kinds: url.searchParams.get('kinds'), headers: Array.isArray(body) ? body.length : body.items.length });
                await fixture.holdList?.(init?.signal, url);
                return response;
            }
            if (path === '/v1/artifacts/read') {
                const body = ArtifactReadBatchHttpInputV1Schema.parse(JSON.parse(String(init?.body)));
                const response = await fixture.artifactStore?.handle(path, init) ?? createArtifactReadBatchHttpResponse(body, artifactId => {
                    const artifact = fixture.inventory.find(row => row.id === artifactId);
                    return artifact ? { artifactId, ok: true, artifact, recipientCensus: null }
                        : { artifactId, ok: false, error: 'artifact_not_found', status: 404, retryable: false };
                });
                const frame = await response.clone().json();
                const ids = frame.items.map((item: { artifactId: string }) => item.artifactId);
                if ('projection' in body) fixture.headerReads.push(ids);
                else {
                    fixture.bodyReads.push(ids);
                    await fixture.holdBodies?.();
                }
                return response;
            }
            const artifactResponse = fixture.artifactStore?.handle(path + url.search, init);
            if (artifactResponse) {
                if (init?.method === 'POST') fixture.artifactWrites.push({ path, body: JSON.parse(String(init.body)) });
                return artifactResponse;
            }
            const exactArtifact = /^\/v1\/artifacts\/([^/]+)$/.exec(path);
            if (exactArtifact && (init?.method === undefined || init.method === 'GET')) {
                const artifactId = decodeURIComponent(exactArtifact[1]!);
                fixture.exactReads.push(artifactId);
                const artifact = fixture.inventory.find(row => row.id === artifactId);
                return artifact ? Response.json(projectArtifactBoundaryReadRow(artifact))
                    : Response.json({ error: 'artifact_not_found' }, { status: 404 });
            }
            if (path === '/v1/feed') return Response.json({ items: [], hasMore: false });
            return createEmptyAccountBootstrapHttpResponse(path + url.search, init);
        });
        await loadSyncSingletonForTests();
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        const { sync, syncSwitchServer } = await import('@/sync/sync');
        const { storage } = await import('@/sync/domains/state/storage');
        await syncSwitchServer(null);
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        await vi.waitFor(() => {
            expect(storage.getState().isDataReady).toBe(true);
        }, { timeout: 30_000 });
        expect(await sync.awaitBootstrapForegroundAcquisition()).toBe(true);
        // Drain the real bootstrap queue before measuring its physical HTTP cost.
        await (sync as unknown as { artifactsSync: InvalidateSync }).artifactsSync.awaitQueue();
        return Object.assign(fixture, { recoverSnapshot, settleInventory, readChangesCursor, readChangesCursorState, dispose });
    } catch (error) {
        await dispose();
        throw error;
    }
}
