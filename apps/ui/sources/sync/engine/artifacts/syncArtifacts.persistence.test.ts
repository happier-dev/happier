import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createDeferred } from '@/dev/testkit';
import { createArtifactsDomain, type ArtifactsDomain } from '@/sync/store/domains/artifacts';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resetMmkvStoresForTests } from '@/dev/reactNativeMmkvStub';
import { CurrentCursorResponseSchema, ChangesResponseSchema } from '@happier-dev/protocol/changes';
import { ArtifactReadBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ApprovalRequestV1Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

// Load the real graph before the shared per-test reachability reset. Cold source
// transforms belong to collection, outside the hook's finite cleanup budget.
await vi.importActual('@/sync/domains/machines/reachability/machineReachability');

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const currentCursor = (cursor: number) => json(CurrentCursorResponseSchema.parse({ cursor, changesFloor: 0 }));
const scope = { serverId: 'inventory-home', accountId: 'inventory-person' };
function head(id: string, version = 1): Artifact {
    return { id, kind: 'prompt', header: encodePlainArtifactStoredContent({ title: id, kind: 'prompt_doc.v2' }),
        headerVersion: version, bodyVersion: version, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        ownerAccountId: scope.accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
        seq: version, createdAt: 1, updatedAt: version };
}

const inventoryOperations = new Map<AbortController, Promise<void>>();
async function retireInventoryOperations() {
    while (inventoryOperations.size > 0) {
        const operations = [...inventoryOperations];
        for (const [controller] of operations) controller.abort();
        await Promise.allSettled(operations.map(([, completion]) => completion));
    }
}

async function load(request: (path: string, init?: RequestInit) => Promise<Response>, options: {
    scope?: typeof scope; credentials?: AuthCredentials; store?: StoreApi<ArtifactsDomain>; kinds?: readonly string[]; controller?: AbortController;
} = {}) {
    const store = options.store ?? createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
    const controller = options.controller ?? new AbortController();
    const started = createDeferred<void>();
    const completion = (async () => {
        try {
            const { prepareWarmCacheStorage } = await import('@/sync/domains/state/warmCachePersistence');
            await prepareWarmCacheStorage();
            const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
            throwIfAborted(controller.signal);
            let startedWith = store.getState().artifacts;
            const inventory = fetchAndApplyArtifactsList({ credentials: options.credentials ?? { token: 'test-bearer' },
                encryption: null, artifactDataKeys: new Map(), serverId: (options.scope ?? scope).serverId,
                inventoryScope: options.scope ?? scope,
                request, signal: controller.signal, kinds: options.kinds,
                inventoryReadStartedWith: startedWith,
                hydrateArtifacts: rows => { store.getState().applyArtifacts(rows); startedWith = store.getState().artifacts; },
                applyArtifacts: (rows, source) => {
                    store.getState().applyArtifacts(rows, source !== undefined ? startedWith : undefined, options.kinds, source);
                } });
            started.resolve();
            await inventory;
            // A timed-out body's await must not resume as success and start another read.
            throwIfAborted(controller.signal);
        } finally { started.resolve(); }
    })();
    inventoryOperations.set(controller, completion);
    const settled = () => { inventoryOperations.delete(controller); };
    void completion.then(settled, settled);
    await started.promise;
    return { store, completion };
}

describe('device-persisted Artifact inventory through the real writer and store', () => {
    beforeEach(async () => {
        await retireInventoryOperations();
        // Test-only MMKV boundary: all domain, storage placement, serialization and HTTP admission remain real.
        resetMmkvStoresForTests();
        vi.resetModules();
    });
    afterEach(async () => {
        await retireInventoryOperations();
        vi.resetModules();
    });

    async function seed(credentials?: AuthCredentials) {
        const first = await load(async path => path === '/v2/cursor' ? currentCursor(10) : json([head('retained'), head('deleted')]), { credentials });
        await first.completion;
        vi.resetModules(); // A new app process retains only device storage.
    }

    it('settles a retired real inventory before the next device-store boundary', async () => {
        const entered = createDeferred<void>(), release = createDeferred<Response>();
        const controller = new AbortController();
        const read = await load(async path => {
            if (path === '/v2/cursor') return currentCursor(10);
            entered.resolve(); return release.promise;
        }, { controller });
        try {
            await entered.promise;
            let settled = false;
            const retirement = retireInventoryOperations().then(() => { settled = true; });
            expect(controller.signal.aborted).toBe(true);
            await Promise.resolve();
            expect(settled).toBe(false);
            release.resolve(json([head('retired')]));
            await retirement;
            await expect(read.completion).rejects.toMatchObject({ name: 'AbortError' });
        } finally { release.resolve(json([head('retired')])); await read.completion.catch(() => undefined); }
        expect(read.store.getState().artifacts).toEqual({});
        vi.resetModules();
        const paths: string[] = [];
        const next = await load(async path => { paths.push(path); return path === '/v2/cursor' ? currentCursor(10) : json([]); });
        await next.completion;
        expect(paths.some(path => path.startsWith('/v1/artifacts?'))).toBe(true);
        expect(next.store.getState().artifacts.retired).toBeUndefined();
    });

    it('does not consume or replace the full-inventory checkpoint for a narrow Context read', async () => {
        await seed();
        const { createArtifactListHttpResponse } = await import('@/dev/testkit/harness/artifactStoreBoundary');
        const selected = { ...head('context-doc'), kindHint: 'prompt_doc.v2' };
        const narrowed = await load(async path => {
            expect(path).toContain('/v1/artifacts?');
            return createArtifactListHttpResponse(new URL(path, 'https://context-checkpoint.test'), [selected]);
        }, { kinds: ['prompt_doc.v2'] });
        await narrowed.completion;
        expect(Object.keys(narrowed.store.getState().artifacts)).toEqual(['context-doc']);
        expect(narrowed.store.getState().artifactsLoaded).toBe(false);
        expect(narrowed.store.getState().artifactInventoryKindsLoaded).toEqual(['prompt_doc.v2']);
        const full = await load(async path => {
            expect(path).toBe('/v2/cursor');
            return currentCursor(10);
        });
        await full.completion;
        expect(Object.keys(full.store.getState().artifacts).sort()).toEqual(['deleted', 'retained']);
        expect(full.store.getState().artifactsLoaded).toBe(true);
    });

    it('retains the admitted persistence carrier across unchanged hydration and projects only changed headers', async () => {
        const persistence = await import('@/sync/domains/state/warmCachePersistence');
        // Observe the real producer's outputs; the writer, schemas and MMKV remain real.
        const saves = vi.spyOn(persistence, 'saveArtifactInventoryWarmCache');
        const rows = Array.from({ length: 2000 }, (_, index) => ({ ...head(`closed-${index}`), kindHint: 'prompt_doc.v2' }));
        let offset = 0;
        const first = await load(async path => {
            if (path === '/v2/cursor') return currentCursor(10);
            const limit = Number(new URL(path, 'https://inventory.test').searchParams.get('limit'));
            const page = rows.slice(offset, offset + limit);
            offset += page.length;
            return json(page);
        });
        await first.completion;
        const initial = saves.mock.calls.at(-1)![2];
        const retained = persistence.loadArtifactInventoryWarmCache(scope.serverId, scope.accountId, initial.binding)!;
        saves.mockClear();
        const stringify = vi.spyOn(JSON, 'stringify');
        const encodedScopes = () => stringify.mock.calls.filter(([value]) => value !== null && typeof value === 'object'
            && 'binding' in value && 'artifacts' in value);
        try {
            for (let arrival = 0; arrival < 20; arrival++) {
                const next = await load(async path => {
                    expect(path).toBe('/v2/cursor');
                    return currentCursor(10);
                }, { store: first.store });
                await next.completion;
            }
            expect(new Set(saves.mock.calls.map(([, , entry]) => entry)).size).toBe(1);
            expect(saves.mock.calls.every(([, , entry]) => entry === retained)).toBe(true);
            expect(encodedScopes()).toHaveLength(0);

            const cursorOnly = await load(async path => path === '/v2/cursor' ? currentCursor(11)
                : json(ChangesResponseSchema.parse({ changes: [
                    { kind: 'machine', entityId: 'busy-machine', cursor: 11, changedAt: 1 },
                ], nextCursor: 11 })), { store: first.store });
            await cursorOnly.completion;
            const advanced = saves.mock.calls.at(-1)![2];
            expect(advanced.cursor).toBe('11');
            expect(advanced.artifacts).toBe(retained.artifacts);
            expect(encodedScopes()).toHaveLength(1);
            const admittedAdvanced = persistence.loadArtifactInventoryWarmCache(scope.serverId, scope.accountId, initial.binding)!;

            const changed = { ...head('closed-173', 2), kindHint: 'prompt_doc.v2' };
            const next = await load(async path => {
                if (path === '/v2/cursor') return currentCursor(12);
                if (path.startsWith('/v2/changes?')) return json(ChangesResponseSchema.parse({ changes: [
                    { kind: 'artifact', entityId: changed.id, cursor: 12, changedAt: 2 },
                ], nextCursor: 12 }));
                expect(path).toBe('/v1/artifacts/read');
                return json({ projection: 'headers', items: [{ artifactId: changed.id, ok: true, artifact: changed }] });
            }, { store: first.store });
            await next.completion;
            const updated = saves.mock.calls.at(-1)![2];
            expect(updated.artifacts).toHaveLength(rows.length);
            expect(updated.artifacts.filter((row, index) => row !== admittedAdvanced.artifacts[index]).map(row => row.id))
                .toEqual([changed.id]);
            expect(updated.artifacts.find(row => row.id === changed.id)?.headerVersion).toBe(2);
            expect(encodedScopes()).toHaveLength(2);
            expect(persistence.loadArtifactInventoryWarmCache(scope.serverId, scope.accountId, initial.binding)).toEqual(updated);

            // A retained checkpoint is also the retry input when device storage rejected it.
            const { MMKV } = await import('react-native-mmkv');
            const write = vi.spyOn(MMKV.prototype, 'set');
            write.mockImplementationOnce(() => { throw new Error('device temporarily unavailable'); });
            try {
                const rejected = await load(async path => path === '/v2/cursor' ? currentCursor(13)
                    : json(ChangesResponseSchema.parse({ changes: [
                        { kind: 'machine', entityId: 'busy-machine', cursor: 13, changedAt: 1 },
                    ], nextCursor: 13 })), { store: first.store });
                await rejected.completion;
                const latest = persistence.loadArtifactInventoryWarmCache(scope.serverId, scope.accountId, initial.binding)!;
                expect(latest.cursor).toBe('13');
                const retry = await load(async path => {
                    expect(path).toBe('/v2/cursor');
                    return currentCursor(13);
                }, { store: first.store });
                await retry.completion;
                expect(saves.mock.calls.at(-1)![2]).toBe(latest);
                expect(write.mock.calls.filter(([key]) => key === 'artifact-inventory-warm-cache-v1:inventory-home:inventory-person'))
                    .toHaveLength(2);
            } finally { write.mockRestore(); }
        } finally {
            stringify.mockRestore();
            saves.mockRestore();
        }
    });

    it('refreshes one changed header among 35000 retained documents with one exact header set read', async () => {
        const rows = Array.from({ length: 35000 }, (_, index) => head(`closed-${index}`));
        let offset = 0;
        const first = await load(async path => {
            if (path === '/v2/cursor') return currentCursor(10);
            const query = new URL(path, 'https://inventory.test').searchParams;
            const limit = Number(query.get('limit'));
            const page = rows.slice(offset, offset + limit);
            offset += page.length;
            return json(page);
        });
        await first.completion;
        vi.resetModules();
        const changed = head('closed-173', 2);
        let inventoryPages = 0;
        const selections: unknown[] = [];
        const next = await load(async (path, init) => {
            if (path === '/v2/cursor') return currentCursor(11);
            if (path.startsWith('/v2/changes?')) return json(ChangesResponseSchema.parse({ changes: [
                { kind: 'artifact', entityId: changed.id, cursor: 11, changedAt: 2 },
            ], nextCursor: 11 }));
            if (path.startsWith('/v1/artifacts?')) { inventoryPages++; return json(rows); }
            expect(path).toBe('/v1/artifacts/read');
            selections.push(JSON.parse(String(init?.body)));
            return json({ projection: 'headers', items: [{ artifactId: changed.id, ok: true, artifact: changed }] });
        });
        await next.completion;
        expect(inventoryPages).toBe(0);
        expect(selections).toEqual([{ artifactIds: [changed.id], projection: 'headers' }]);
        expect(Object.keys(next.store.getState().artifacts)).toHaveLength(rows.length);
        expect(next.store.getState().artifacts[changed.id]?.headerVersion).toBe(2);
    });

    it('catches up 35000 closed documents through exact header reads without body demand or a replay loop', async () => {
        const first = await load(async path => path === '/v2/cursor' ? currentCursor(10) : json([]));
        await first.completion;
        vi.resetModules();
        const rows = Array.from({ length: 35000 }, (_, index) => head(`closed-${index}`));
        let bodyRequests = 0;
        let bodyIds = 0;
        let headerPages = 0;
        let headerSetIds = 0;
        const request = async (path: string, init?: RequestInit) => {
            if (path === '/v2/cursor') return currentCursor(35010);
            if (path.startsWith('/v2/changes?')) {
                const after = Number(new URL(path, 'https://inventory.test').searchParams.get('after'));
                const offset = after - 10;
                const changed = rows.slice(offset, offset + 500);
                return json(ChangesResponseSchema.parse({ changes: changed.map((row, index) => ({
                    kind: 'artifact', entityId: row.id, cursor: after + index + 1, changedAt: 1,
                })), nextCursor: after + changed.length }));
            }
            if (path === '/v1/artifacts/read') {
                const input = JSON.parse(String(init?.body));
                if (input.projection === 'headers') {
                    headerSetIds += input.artifactIds.length;
                    const byId = new Map(rows.map(row => [row.id, row]));
                    return json({ projection: 'headers', items: input.artifactIds.map((artifactId: string) => ({
                        artifactId, ok: true, artifact: byId.get(artifactId),
                    })) });
                }
                bodyRequests += 1;
                bodyIds += input.artifactIds.length;
                return json({ error: 'artifact_content_unavailable' }, 500);
            }
            expect(path).toMatch(/^\/v1\/artifacts\?/);
            const query = new URL(path, 'https://inventory.test').searchParams;
            expect(query.has('includeBody')).toBe(false);
            const limit = Number(query.get('limit'));
            const page = rows.slice(headerPages * limit, (headerPages + 1) * limit);
            headerPages += 1;
            return json(page);
        };
        const next = await load(request);
        const failure = await next.completion.then(() => null, error => error);
        expect(bodyIds).toBe(0);
        expect(bodyRequests).toBe(0);
        expect(headerPages).toBe(0);
        expect(headerSetIds).toBe(rows.length);
        expect(failure).toBeNull();
        expect(Object.keys(next.store.getState().artifacts)).toHaveLength(rows.length);
        expect(next.store.getState().artifactsLoaded).toBe(true);
        const completedPages = headerPages;
        vi.resetModules();
        const repeated = await load(request);
        await repeated.completion;
        expect(bodyRequests).toBe(0);
        expect(headerPages).toBe(completedPages);
        expect(headerSetIds).toBe(rows.length);
        expect(repeated.store.getState().artifactsLoaded).toBe(true);
    });

    it('catches up an approval header through the retained cursor and acquires its body only on reader demand', async () => {
        await seed();
        const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        const artifact = { ...head('new-approval'), kind: 'other' as const,
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) };
        const paths: string[] = [];
        let bodyReads = 0;
        const request = async (path: string, init?: RequestInit) => {
            paths.push(path);
            if (path === '/v2/cursor') return currentCursor(11);
            if (path.startsWith('/v2/changes?after=10&')) return json(ChangesResponseSchema.parse({ changes: [
                { kind: 'artifact', entityId: artifact.id, cursor: 11, changedAt: 1 },
            ], nextCursor: 11 }));
            if (path.startsWith('/v1/artifacts?')) return json([{ ...artifact, body: undefined }]);
            expect(path).toBe('/v1/artifacts/read');
            const input = JSON.parse(String(init?.body));
            expect(input.artifactIds).toEqual([artifact.id]);
            if (input.projection === 'headers') return json({ projection: 'headers', items: [
                { artifactId: artifact.id, ok: true, artifact: { ...artifact, body: undefined } },
            ] });
            bodyReads += 1;
            return json(ArtifactReadBatchResponseV1Schema.parse({ items: [
                { artifactId: artifact.id, ok: true, artifact, recipientCensus: null },
            ] }));
        };
        const next = await load(request);
        await next.completion;
        expect(next.store.getState().artifacts[artifact.id]?.header?.kind).toBe('approval_request.v1');
        expect(next.store.getState().artifacts[artifact.id]?.body).toBeUndefined();
        expect(bodyReads).toBe(0);
        expect(next.store.getState().artifactsLoaded).toBe(true);
        expect(paths.some(path => path.startsWith('/v1/artifacts?'))).toBe(false);

        const { listInboxArtifactBodyHydrationRequests } = await import('@/sync/domains/artifacts/inboxArtifacts');
        const demand = listInboxArtifactBodyHydrationRequests(Object.values(next.store.getState().artifacts), scope.serverId, scope.accountId);
        expect(demand.map(item => item.artifactId)).toEqual([artifact.id]);
        const { fetchAndApplyArtifactBodies } = await import('./syncArtifacts');
        const results = await fetchAndApplyArtifactBodies({ credentials: { token: 'test-bearer' },
            artifactIds: demand.map(item => item.artifactId), request, encryption: null, artifactDataKeys: new Map(),
            applyArtifacts: rows => next.store.getState().applyArtifacts(rows) });
        expect(results).toEqual([{ status: 'fulfilled', value: undefined }]);
        expect(bodyReads).toBe(1);
        expect(next.store.getState().artifacts[artifact.id]?.body).toBe(JSON.stringify(approval));
        const { isOpenApprovalInboxArtifact } = await import('@/sync/domains/artifacts/approvalArtifacts');
        expect(isOpenApprovalInboxArtifact(next.store.getState().artifacts[artifact.id]!)).toBe(true);
        expect(listInboxArtifactBodyHydrationRequests(Object.values(next.store.getState().artifacts), scope.serverId, scope.accountId)).toEqual([]);
    });

    it('settles at the captured change frontier while unrelated Account writes continue', async () => {
        await seed();
        let pages = 0;
        const next = await load(async path => {
            if (path === '/v2/cursor') return currentCursor(11);
            pages += 1;
            if (pages > 3) return json({ changes: [], nextCursor: 13 });
            return json(ChangesResponseSchema.parse({ changes: [
                { kind: 'machine', entityId: 'busy-machine', cursor: 10 + pages, changedAt: 1 },
            ], nextCursor: 10 + pages }));
        });
        await expect(next.completion).resolves.toBeUndefined();
        expect(pages).toBe(1);
        expect(next.store.getState().artifactsLoaded).toBe(true);
    });

    it('retains legacy and locked headers across cold and warm inventories without read-side hint writes', async () => {
        const rows: Artifact[] = [head('known'), { ...head('unclassified'), kind: null },
            { ...head('board'), kind: 'other', header: encodePlainArtifactStoredContent({ kind: 'work-board.v1', title: 'Board' }) },
            { ...head('locked'), kind: null, encryptionMode: 'e2ee', dataEncryptionKey: 'unavailable-key', header: 'ciphertext' }];
        rows.push({ ...head('layout'), kind: 'other', header: encodePlainArtifactStoredContent({ kind: 'widget-area-layout.v1', title: 'My view' }) });
        const before = rows.map(row => ({ ...row }));
        const requests: string[] = [];
        const request = async (path: string, init?: RequestInit) => {
            requests.push(path);
            expect(init?.method ?? 'GET').toBe('GET');
            if (path === '/v2/cursor') return currentCursor(10);
            expect(path).toContain('/v1/artifacts?');
            return json(rows);
        };
        const first = await load(request);
        await first.completion;
        expect(first.store.getState().artifacts.locked?.isDecrypted).toBe(false);
        expect(first.store.getState().artifacts.unclassified?.rawHeader?.kind).toBe('prompt_doc.v2');
        requests.length = 0;
        vi.resetModules();
        const next = await load(request);
        await next.completion;
        expect(requests).toEqual(['/v2/cursor']);
        expect(next.store.getState().artifactsLoaded).toBe(true);
        expect(next.store.getState().artifacts.unclassified?.kind).toBeNull();
        expect(next.store.getState().artifacts.locked?.isDecrypted).toBe(false);
        expect(rows).toEqual(before);
    });

    it('hydrates stale rows before catch-up, then refreshes changed and deleted headers without reading bodies', async () => {
        await seed();
        const gate = createDeferred<Response>();
        const paths: string[] = [];
        const reloaded = await load(async (path, init) => {
            paths.push(path);
            if (path === '/v2/cursor') return currentCursor(12);
            if (path.startsWith('/v2/changes?after=10&')) return gate.promise;
            if (path.startsWith('/v2/changes?after=12&')) return json({ changes: [], nextCursor: 12 });
            if (path.startsWith('/v1/artifacts?')) return json([head('retained', 2)]);
            expect(path).toBe('/v1/artifacts/read');
            expect(JSON.parse(String(init?.body))).toEqual({ artifactIds: ['retained', 'deleted'], projection: 'headers' });
            return json({ projection: 'headers', items: [
                { artifactId: 'retained', ok: true, artifact: head('retained', 2) },
                { artifactId: 'deleted', ok: false, error: 'artifact_not_found', status: 404, retryable: false },
            ] });
        });
        try {
            await vi.waitFor(() => expect(reloaded.store.getState().artifacts.retained?.title).toBe('retained'));
            expect(reloaded.store.getState().artifactsLoaded).toBe(false);
        } finally {
            gate.resolve(json(ChangesResponseSchema.parse({ changes: [
                { kind: 'artifact', entityId: 'retained', cursor: 11, changedAt: 1 },
                { kind: 'artifact', entityId: 'deleted', cursor: 12, changedAt: 1 },
            ], nextCursor: 12 })));
            await reloaded.completion;
        }
        expect(Object.keys(reloaded.store.getState().artifacts)).toEqual(['retained']);
        expect(reloaded.store.getState().artifacts.retained?.headerVersion).toBe(2);
        expect(reloaded.store.getState().artifactsLoaded).toBe(true);
        expect(paths.some(path => path.startsWith('/v1/artifacts?'))).toBe(false);
        vi.resetModules();
        const next = await load(async path => {
            if (path === '/v2/cursor') return currentCursor(12);
            expect(path).toMatch(/^\/v2\/changes\?after=12&/);
            return json({ changes: [], nextCursor: 12 });
        });
        await next.completion;
        expect(Object.keys(next.store.getState().artifacts)).toEqual(['retained']);
    });

    it('falls back to a full listing only when the retained cursor is gone', async () => {
        await seed();
        const paths: string[] = [];
        const next = await load(async path => {
            paths.push(path);
            if (path.startsWith('/v2/changes')) return json({ error: 'cursor-gone', currentCursor: 30 }, 410);
            if (path === '/v2/cursor') return currentCursor(30);
            return json([head('replacement')]);
        });
        await next.completion;
        expect(Object.keys(next.store.getState().artifacts)).toEqual(['replacement']);
        expect(paths.some(path => path.startsWith('/v1/artifacts?'))).toBe(true);
    });

    it.each(['account', 'home', 'key', 'credential'] as const)('isolates persisted inventory on %s changes', async change => {
        await seed({ token: 'test-bearer', secret: 'test-only-material-a' });
        const gate = createDeferred<Response>();
        const paths: string[] = [];
        const next = await load(async path => {
            paths.push(path);
            if (path === '/v2/cursor') return currentCursor(20);
            return gate.promise;
        }, { scope: change === 'account' ? { ...scope, accountId: 'another-person' }
            : change === 'home' ? { ...scope, serverId: 'another-home' } : scope,
            credentials: { token: change === 'credential' ? 'another-test-bearer' : 'test-bearer',
                secret: change === 'key' ? 'test-only-material-b' : 'test-only-material-a' } });
        try {
            await vi.waitFor(() => expect(paths.some(path => path.startsWith('/v1/artifacts?'))).toBe(true));
            expect(next.store.getState().artifacts).toEqual({});
            expect(next.store.getState().artifactsLoaded).toBe(false);
        } finally { gate.resolve(json([])); await next.completion; }
    });

    it('keeps failed catch-up last-known, without granting coverage or starting a full listing', async () => {
        await seed();
        const paths: string[] = [];
        const next = await load(async path => { paths.push(path); return path === '/v2/cursor'
            ? currentCursor(11) : json({ error: 'unavailable' }, 503); });
        await expect(next.completion).rejects.toThrow('Artifact inventory changes are unavailable');
        expect(next.store.getState().artifacts.retained?.title).toBe('retained');
        expect(next.store.getState().artifactsLoaded).toBe(false);
        expect(paths.every(path => path === '/v2/cursor' || path.startsWith('/v2/changes?after=10&'))).toBe(true);
    });

    it('does not checkpoint a changed header refusal or replace the retained row with absence', async () => {
        await seed();
        const afters: string[] = [];
        const request = async (path: string, init?: RequestInit) => {
            if (path === '/v2/cursor') return currentCursor(11);
            if (path.startsWith('/v2/changes?')) {
                afters.push(new URL(path, 'https://inventory.test').searchParams.get('after')!);
                return json(ChangesResponseSchema.parse({ changes: [
                    { kind: 'artifact', entityId: 'retained', cursor: 11, changedAt: 2 },
                ], nextCursor: 11 }));
            }
            expect(path).toBe('/v1/artifacts/read');
            expect(JSON.parse(String(init?.body))).toEqual({ artifactIds: ['retained'], projection: 'headers' });
            return json({ projection: 'headers', items: [{ artifactId: 'retained', ok: false,
                error: 'artifact_content_unavailable', status: 500, retryable: true }] });
        };
        const first = await load(request);
        await expect(first.completion).rejects.toThrow();
        expect(first.store.getState().artifacts.retained?.headerVersion).toBe(1);
        expect(first.store.getState().artifactsLoaded).toBe(false);
        vi.resetModules();
        const next = await load(request);
        await expect(next.completion).rejects.toThrow();
        expect(afters).toEqual(['10', '10']);
    });

    it('preserves demanded body and custody while checkpointing current header access at an unchanged cursor', async () => {
        const first = await load(async path => path === '/v2/cursor' ? currentCursor(10) : json([head('retained')]));
        await first.completion;
        const retained = first.store.getState().artifacts.retained;
        if (!retained?.isDecrypted) throw new Error('Expected an opened inventory header');
        const opened = { ...retained, access: 'view' as const, body: 'demanded body',
            storageIdentity: { contentKeyEnvelope: 'test-only-envelope', provenanceKeyEnvelope: null,
                header: 'test-only-stored-header-evidence' } };
        first.store.getState().updateArtifact(opened);
        const persistence = await import('@/sync/domains/state/warmCachePersistence');
        const saves = vi.spyOn(persistence, 'saveArtifactInventoryWarmCache');
        const next = await load(async path => {
            if (path === '/v2/cursor') return currentCursor(10);
            expect(path).toMatch(/^\/v2\/changes\?after=10&/);
            return json({ changes: [], nextCursor: 10 });
        }, { store: first.store });
        await next.completion;
        expect(next.store.getState().artifacts.retained).toBe(opened);
        try {
            const checkpoint = saves.mock.calls.at(-1)![2];
            expect(checkpoint.artifacts.find(row => row.id === opened.id)?.access).toBe('view');
            expect(persistence.loadArtifactInventoryWarmCache(scope.serverId, scope.accountId, checkpoint.binding))
                .toEqual(checkpoint);
            expect(checkpoint.artifacts[0]).not.toHaveProperty('body');
            expect(checkpoint.artifacts[0]).not.toHaveProperty('storageIdentity');
            expect(JSON.stringify(checkpoint)).not.toContain('test-only-stored-header-evidence');
        } finally { saves.mockRestore(); }
    });

    it('removes the Home inventory on the real credential-removal path', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        const home = await upsertAndActivateServer({ serverUrl: 'https://inventory-signout.test', scope: 'device' });
        const localScope = { ...scope, serverId: home.id };
        const first = await load(async path => path === '/v2/cursor' ? currentCursor(10) : json([head('retained')]), { scope: localScope });
        await first.completion;
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBe(true);
        vi.resetModules();
        const paths: string[] = [];
        const next = await load(async path => {
            paths.push(path);
            return path === '/v2/cursor' ? currentCursor(20) : json([]);
        }, { scope: localScope });
        await next.completion;
        expect(next.store.getState().artifacts).toEqual({});
        expect(paths.some(path => path.startsWith('/v2/changes'))).toBe(false);
        expect(paths.some(path => path.startsWith('/v1/artifacts?'))).toBe(true);
    });
});
