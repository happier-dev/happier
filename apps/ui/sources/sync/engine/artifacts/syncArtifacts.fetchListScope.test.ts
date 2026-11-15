import { afterEach, describe, expect, it, vi } from 'vitest';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import {
    ApprovalRequestV1Schema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createDeferred } from '@/dev/testkit';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { sealArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import { encodeBase64 } from '@/encryption/base64';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { readArtifactProvenance } from '@/components/artifacts/artifactBrowserModel';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { signAccountContentKeyBindingV1} from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { computeContentPublicKeyFingerprint} from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { openEncryptedDataKeyEnvelopeV1} from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import {
    type ArtifactRecipientKeyEnvelopeCommitInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { decodeBase64 } from '@/encryption/base64';
import { shouldRetryError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { createStore } from 'zustand/vanilla';
import { createArtifactsDomain, type ArtifactsDomain } from '@/sync/store/domains/artifacts';
import { createArtifactListHttpResponse, createArtifactReadBatchHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { artifactInventorySelectionOptions, type ArtifactInventorySelection } from '@/sync/domains/artifacts/artifactInventory';
import { selectArtifactInventoryRows } from '@/sync/store/domains/artifactInventoryIndex';

const runtimeFetch = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) ,
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The shared setup resets this real owner; load its cold graph outside the hook budget.
await vi.importActual('@/sync/domains/machines/reachability/machineReachability');

function json(value: unknown): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function plainHead(index: number): Artifact {
    return { id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        kind: 'other', kindHint: null,
        ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ title: `Document ${index}` }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: index, createdAt: index, updatedAt: index };
}

describe('fetchAndApplyArtifactsList', () => {
    it('preserves a concurrent Session receipt when a pending-state census observes settlement and proves true deletion by exact id', async () => {
        const { fetchAndApplyArtifactsList, decryptArtifactListItems } = await import('./syncArtifacts');
        const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent', actionId: 'session.list', actionArgs: {}, summary: 'Read sessions' });
        const make = (index: number, request: typeof approval) => ({ ...plainHead(index), publicAudience: 'none' as const, kindHint: 'approval_request.v1',
            approvalState: request.status, approvalSessionId: 's1',
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)) });
        const initial = [make(1, approval), make(2, approval)];
        const settled = { ...make(1, ApprovalRequestV1Schema.parse({ ...approval, status: 'rejected', updatedAtMs: 2,
            decision: { kind: 'reject', decidedAtMs: 2 } })), headerVersion: 2, bodyVersion: 2 };
        const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
        store.getState().applyArtifacts((await decryptArtifactListItems({ artifacts: initial, encryption: null,
            artifactDataKeys: new Map() })).filter((row): row is DecryptedArtifact => row !== null));
        const sessionStarted = createDeferred<void>(), releaseSession = createDeferred<void>();
        const exactHeaders: string[][] = [];
        const request = async (path: string, init?: RequestInit) => {
            const url = new URL(path, 'https://pending-absence.test');
            if (url.pathname === '/v1/artifacts/read') {
                const input: { artifactIds: string[]; projection: string } = JSON.parse(String(init?.body));
                expect(input.projection).toBe('headers');
                exactHeaders.push(input.artifactIds);
                return createArtifactReadBatchHttpResponse(input, id => id === settled.id
                    ? { artifactId: id, ok: true, artifact: settled }
                    : { artifactId: id, ok: false, error: 'artifact_not_found', status: 404, retryable: false });
            }
            if (url.searchParams.has('approvalSessionIds')) { sessionStarted.resolve(); await releaseSession.promise; }
            return createArtifactListHttpResponse(url, [settled]);
        };
        const read = (selection: ArtifactInventorySelection) => {
            const baseline = store.getState().artifacts;
            const demand = { ...artifactInventorySelectionOptions(selection), getCurrentArtifacts: () => store.getState().artifacts,
                inventorySelectionReadStartedWith: selectArtifactInventoryRows(store.getState(), selection) };
            return fetchAndApplyArtifactsList({ ...demand, credentials: { token: 'pending-absence' }, encryption: null,
                artifactDataKeys: new Map(), request, inventoryReadStartedWith: baseline,
                applyArtifacts: (rows, source) => store.getState().applyArtifacts(rows, baseline, selection, source) });
        };
        const sessionRead = read({ approvalSessionIds: ['s1'] });
        try {
            await sessionStarted.promise;
            await read('inboxOpen');
        } finally { releaseSession.resolve(); }
        await sessionRead;
        expect(store.getState().artifacts[settled.id]?.header?.approvalStatus).toBe('rejected');
        expect(store.getState().artifacts[initial[1]!.id]).toBeUndefined();
        expect(exactHeaders).toEqual([[initial[0]!.id, initial[1]!.id]]);
        expect(store.getState().artifactsLoaded).toBe(false);
    });
    it('reads only open approval headers beside 10000 settled receipts', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const request = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 'visible-session' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'Review access' });
        const row = (index: number, open: boolean) => ({ ...plainHead(index), kindHint: 'approval_request.v1',
            approvalState: open ? 'open' as const : 'rejected' as const, approvalSessionId: 'visible-session',
            header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(open ? request
                : { ...request, status: 'rejected', decision: { kind: 'reject', decidedAtMs: 2 } })) });
        const inventory = [...Array.from({ length: 10000 }, (_, index) => row(index, false)), row(10000, true), row(10001, true)];
        const pages: number[] = [];
        const admitted: DecryptedArtifact[] = [];
        const selection = { kinds: ['approval_request.v1'], approvalStates: ['open'] as const };
        await fetchAndApplyArtifactsList({ ...selection, credentials: { token: 'open-cost' }, encryption: null,
            artifactDataKeys: new Map(), request: async path => {
                const response = createArtifactListHttpResponse(new URL(path, 'https://approval-cost.test'), inventory);
                const body = await response.clone().json();
                pages.push(Array.isArray(body) ? body.length : body.items.length);
                return response;
            }, applyArtifacts: rows => { admitted.push(...rows); } });
        expect(pages).toEqual([2]);
        expect(admitted.map(item => item.id).sort()).toEqual(inventory.slice(-2).map(item => item.id).sort());
    });
    afterEach(() => {
        runtimeFetch.mockReset();
        vi.resetModules();
    });

    it.each(['plain', 'e2ee'] as const)('retains parsed %s inventory rows before real-store publication on cold and typed refreshes', async mode => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(21)) : null;
        const key = new Uint8Array(32).fill(22);
        const codec = new ArtifactEncryption(key);
        const envelope = encryption ? encodeBase64(await encryption.encryptEncryptionKey(key)) : ARTIFACT_PLAIN_DATA_KEY_MARKER;
        const headers = Array.from({ length: 64 }, (_, index) => ({ kind: 'markdown', title: `Document ${index + 1}`, sessions: ['session'] }));
        const seal = (header: typeof headers[number]) => mode === 'plain'
            ? Promise.resolve(encodePlainArtifactStoredContent(header)) : codec.encryptHeader(header);
        const initial = await Promise.all(headers.map(async (header, index): Promise<Artifact> => ({
            ...plainHead(index + 1), encryptionMode: mode, dataEncryptionKey: envelope,
            kindHint: 'markdown', header: await seal(header),
        })));
        for (const kinds of [undefined, ['markdown']]) {
            const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
            const artifactDataKeys = new Map();
            let inventory = initial;
            const emitted: number[] = [];
            const read = () => {
                const baseline = store.getState().artifacts;
                return fetchAndApplyArtifactsList({ credentials: { token: 'parsed-row-retention' }, encryption, artifactDataKeys,
                    kinds, inventoryReadStartedWith: baseline, includeProvenance: false,
                    request: async path => createArtifactListHttpResponse(new URL(path, 'https://parsed-rows.test'), inventory),
                    applyArtifacts: (rows, source) => {
                        emitted.push(rows.filter(row => row !== baseline[row.id]).length);
                        store.getState().applyArtifacts(rows, baseline, kinds, source);
                    } });
            };
            await read();
            const baseline = store.getState().artifacts;
            emitted.length = 0;
            // Pass-through observation of real JSON decoding, not a replacement parser.
            const parse = vi.spyOn(JSON, 'parse');
            const headerJson = new Set(headers.map(header => JSON.stringify(mode === 'plain' ? { t: 'plain', v: header } : header)));
            try {
                for (let index = 0; index < 3; index++) {
                    // Account Actions own fresh invocation-local key custody;
                    // the third read must unwrap again, not borrow Sync's map.
                    if (index === 2) artifactDataKeys.clear();
                    await read();
                }
                expect(emitted).toEqual([0, 0, 0]);
                expect(parse.mock.calls.filter(([text]) => headerJson.has(text))).toHaveLength(0);
                expect(store.getState().artifacts).toBe(baseline);
                inventory = await Promise.all(initial.map(async (row, index) => index === 0 ? {
                    ...row, header: await seal({ ...headers[index]!, title: 'Changed document' }), headerVersion: 2,
                } : row));
                await read();
                expect(emitted.at(-1)).toBe(1);
                expect(store.getState().artifacts[initial[0]!.id]?.title).toBe('Changed document');
                for (const row of initial.slice(1)) expect(store.getState().artifacts[row.id]).toBe(baseline[row.id]);
                // An authenticated grant or changed bytes at the same revision
                // must not inherit a previously admitted content projection.
                inventory = inventory.map((row, index) => index === 1 ? { ...row, access: 'view' as const } : row);
                await read();
                expect(store.getState().artifacts[initial[1]!.id]?.access).toBe('view');
                expect(emitted.at(-1)).toBe(1);
                inventory = inventory.map((row, index) => index === 2 ? { ...row, header: 'invalid stored header' } : row);
                await read();
                expect(store.getState().artifacts[initial[2]!.id]?.isDecrypted).toBe(false);
                inventory = inventory.map((row, index) => index === 2 ? initial[index]! : row);
                await read();
                expect(store.getState().artifacts[initial[2]!.id]?.isDecrypted).toBe(true);
                if (encryption) {
                    inventory = inventory.map((row, index) => index === 3 ? { ...row,
                        dataEncryptionKey: encodeBase64(new Uint8Array(48).fill(99)) } : row);
                    await read();
                    expect(store.getState().artifacts[initial[3]!.id]?.isDecrypted).toBe(false);
                }
            } finally { parse.mockRestore(); }
        }
    });

    it('matches full membership for a stale baseline beside a locked neighbour while preserving concurrent changes', async () => {
        const { fetchAndApplyArtifactsList, decryptArtifactListItems } = await import('./syncArtifacts');
        const kind = 'prompt_doc.v2';
        const doc = (id: number): Artifact => ({ ...plainHead(id), kindHint: kind,
            header: encodePlainArtifactStoredContent({ kind, title: `Prompt ${id}` }) });
        const stale = doc(1), edited = doc(2), deleted = doc(3), created = doc(4), current = doc(5);
        const { kindHint: _hint, ...legacy } = doc(6);
        const locked = { ...legacy, kind: null, header: 'unreadable legacy header' };
        const inventory = [current, deleted, locked];
        const outcomes: Array<Record<string, DecryptedArtifact>> = [];
        for (const kinds of [undefined, [kind]]) {
            const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
            const opened = await decryptArtifactListItems({ artifacts: [stale, edited, deleted], encryption: null, artifactDataKeys: new Map() });
            store.getState().applyArtifacts(opened.filter((row): row is DecryptedArtifact => row !== null));
            const baseline = store.getState().artifacts;
            let raced = false;
            await fetchAndApplyArtifactsList({ credentials: { token: 'full-narrow-parity' }, encryption: null,
                artifactDataKeys: new Map(), kinds, request: async path => {
                    if (!raced) {
                        raced = true;
                        const changes = await decryptArtifactListItems({ artifacts: [{ ...edited, headerVersion: 2 }, created], encryption: null, artifactDataKeys: new Map() });
                        store.getState().applyArtifacts(changes.filter((row): row is DecryptedArtifact => row !== null));
                        store.getState().deleteArtifact(deleted.id);
                    }
                    return createArtifactListHttpResponse(new URL(path, 'https://full-narrow.test'), inventory);
                }, applyArtifacts: (rows, source) => store.getState().applyArtifacts(rows,
                    source === undefined ? undefined : baseline, kinds, source) });
            expect(store.getState().artifacts[stale.id]).toBeUndefined();
            expect(store.getState().artifacts[deleted.id]).toBeUndefined();
            expect(store.getState().artifacts[edited.id]?.headerVersion).toBe(2);
            expect(store.getState().artifacts[created.id]).toBeDefined();
            expect(store.getState().artifacts[locked.id]?.isDecrypted).toBe(false);
            expect(store.getState().artifactsLoaded).toBe(kinds === undefined);
            outcomes.push(store.getState().artifacts);
        }
        expect(outcomes[1]).toEqual(outcomes[0]);
    });

    it('opens Context with one exact-kind header page despite 35000 unrelated headers', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const kinds = ['memory_doc.v1', 'prompt_bundle.v2', 'prompt_doc.v2'];
        const relevant = kinds.map((kind, index) => ({ ...plainHead(index + 1), kindHint: kind,
            header: encodePlainArtifactStoredContent({ kind, title: kind }) }));
        const inventory = [...relevant, ...Array.from({ length: 35000 }, (_, index) => ({
            ...plainHead(index + 4), kindHint: 'markdown',
            header: encodePlainArtifactStoredContent({ kind: 'markdown', title: 'Unrelated' }),
        }))];
        const pages: { headers: number; query: string }[] = [];
        const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
        const before = store.getState().artifacts;
        const demand = { kinds };
        await fetchAndApplyArtifactsList({ ...demand, credentials: { token: 'token' }, encryption: null,
            artifactDataKeys: new Map(), request: async path => {
                const url = new URL(path, 'https://context-count.test');
                const response = createArtifactListHttpResponse(url, inventory);
                const body = await response.clone().json();
                pages.push({ headers: Array.isArray(body) ? body.length : body.items.length, query: url.search });
                return response;
            }, applyArtifacts: (rows, source) => store.getState().applyArtifacts(rows,
                source !== undefined ? before : undefined, kinds, source) });
        // Read cost is the contract: a narrow Context open must never drain unrelated headers.
        expect(pages).toHaveLength(1);
        expect(pages.reduce((total, page) => total + page.headers, 0)).toBe(3);
        expect(new URLSearchParams(pages[0]!.query).get('kinds')).toBe(JSON.stringify(kinds));
        expect(Object.keys(store.getState().artifacts).sort()).toEqual(relevant.map(row => row.id).sort());
        expect(store.getState().artifactsLoaded).toBe(false);
    });

    it('opens the browser with one listed header page despite 35000 private headers, retaining unknown and indexed null-kind documents', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const listed = ['prompt_doc.v2', 'new.document.v99', null].map((kind, index): Artifact => ({
            ...plainHead(index + 1), kindHint: kind,
            header: encodePlainArtifactStoredContent({ ...(kind === null ? {} : { kind }), title: 'Listed' }),
        }));
        const inventory: Artifact[] = [...listed, ...Array.from({ length: 35000 }, (_, index) => ({
            ...plainHead(index + 4), kindHint: 'approval_request.v1',
            header: encodePlainArtifactStoredContent({ kind: 'approval_request.v1', title: 'Private' }),
        }))];
        const pages: { headers: number; query: string }[] = [];
        const admitted: DecryptedArtifact[] = [];
        const demand = { browserListed: true as const };
        await fetchAndApplyArtifactsList({ ...demand, credentials: { token: 'browser-count' }, encryption: null,
            artifactDataKeys: new Map(), request: async path => {
                const url = new URL(path, 'https://browser-count.test');
                const response = createArtifactListHttpResponse(url, inventory);
                const body = await response.clone().json();
                pages.push({ headers: Array.isArray(body) ? body.length : body.items.length, query: url.search });
                return response;
            }, applyArtifacts: rows => { admitted.splice(0, admitted.length, ...rows); } });
        expect(pages).toHaveLength(1);
        expect(pages.reduce((sum, page) => sum + page.headers, 0)).toBe(3);
        expect(new URLSearchParams(pages[0]!.query).get('browserListed')).toBe('true');
        expect(admitted.map(row => row.id).sort()).toEqual(listed.map(row => row.id).sort());
    });

    it('withdraws Inbox completeness for an opaque unknown arrival but not a proven unrelated opaque kind', async () => {
        const { decryptArtifactListItems } = await import('./syncArtifacts');
        const { INBOX_ARTIFACT_KINDS, isInboxArtifactBodyAdmissionComplete } = await import('@/sync/domains/artifacts/inboxArtifacts');
        const { isArtifactInventoryLoaded } = await import('@/sync/domains/artifacts/artifactInventory');
        const { kindHint: _hint, ...legacy } = plainHead(1);
        const [unknown, unrelated] = await decryptArtifactListItems({ artifacts: [
            { ...legacy, kind: null, header: 'unreadable stored header' },
            { ...plainHead(2), kindHint: 'markdown', header: 'unreadable stored header' },
        ], encryption: null, artifactDataKeys: new Map() });
        expect(unknown?.isDecrypted).toBe(false);
        expect(unrelated?.isDecrypted).toBe(false);
        const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
        store.getState().applyArtifacts([], store.getState().artifacts, INBOX_ARTIFACT_KINDS);
        expect(isArtifactInventoryLoaded(store.getState(), INBOX_ARTIFACT_KINDS)).toBe(true);
        store.getState().addArtifact(unrelated!);
        expect(isInboxArtifactBodyAdmissionComplete(Object.values(store.getState().artifacts), 'owner')).toBe(true);
        store.getState().addArtifact(unknown!);
        expect(isInboxArtifactBodyAdmissionComplete(Object.values(store.getState().artifacts), 'owner')).toBe(false);
    });

    it('retains opaque browser observations but refuses a completed readable answer so Retry remains available', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const inventory = [plainHead(1), { ...plainHead(2), header: 'unreadable stored header' }];
        const publications: { rows: DecryptedArtifact[]; source: string | undefined }[] = [];
        const demand = { browserListed: true as const };
        await expect(fetchAndApplyArtifactsList({ ...demand, credentials: { token: 'browser-opaque' }, encryption: null,
            artifactDataKeys: new Map(), request: async path => createArtifactListHttpResponse(new URL(path, 'https://browser-opaque.test'), inventory),
            applyArtifacts: (rows, source) => { publications.push({ rows, source }); } }))
            .rejects.toMatchObject({ code: 'artifact_content_unavailable', canTryAgain: false });
        expect(publications).toHaveLength(1);
        expect(publications[0]!.source).toBe('unreadable');
        expect(publications[0]!.rows.map(row => [row.id, row.isDecrypted])).toEqual([
            [inventory[0]!.id, true], [inventory[1]!.id, false],
        ]);
    });

    it('uses canonical legacy discovery past page 500 and refuses incomplete kind membership', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const kinds = ['memory_doc.v1', 'prompt_bundle.v2', 'prompt_doc.v2'];
        const legacy = Array.from({ length: 1001 }, (_, index) => {
            const { kindHint: _hint, ...head } = plainHead(index + 1);
            return { ...head, kind: null, header: encodePlainArtifactStoredContent({
                kind: index === 0 ? 'memory_doc.v1' : 'markdown', title: 'Legacy',
            }) };
        });
        const requests: { unclassified: boolean; headers: number }[] = [];
        const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
        const request = async (path: string, init?: RequestInit) => {
            const url = new URL(path, 'https://context-legacy.test');
            // Legacy labels are this read's own write; this fixture keeps the rows unclassified.
            if (init?.method === 'POST') return json({ items: (JSON.parse(String(init.body)) as { items: { artifactId: string }[] }).items
                .map(item => ({ artifactId: item.artifactId, success: true })) });
            const response = createArtifactListHttpResponse(url, legacy);
            const body = await response.clone().json();
            requests.push({ unclassified: url.searchParams.has('unclassified'), headers: body.items.length });
            return response;
        };
        const read = () => {
            const before = store.getState().artifacts;
            return fetchAndApplyArtifactsList({ kinds, credentials: { token: 'legacy-token' }, encryption: null,
                artifactDataKeys: new Map(), request,
                applyArtifacts: (rows, source) => store.getState().applyArtifacts(rows,
                    source !== undefined ? before : undefined, kinds, source) });
        };
        await read();
        expect(requests.map(page => page.headers)).toEqual([0, 500, 500, 1]);
        expect(Object.keys(store.getState().artifacts)).toEqual([legacy[0]!.id]);
        expect(store.getState().artifactInventoryKindsLoaded).toEqual(kinds);
        expect(store.getState().artifactsLoaded).toBe(false);

        store.setState({ artifactInventoryKindsLoaded: [] });
        legacy[1] = { ...legacy[1]!, header: 'unreadable' };
        await expect(read()).resolves.toBeUndefined();
        expect(store.getState().artifactInventoryKindsLoaded).toEqual([]);
        expect(store.getState().artifactInventoryKindsPartial).toEqual(kinds);
        expect(store.getState().artifacts[legacy[1]!.id]?.isDecrypted).toBe(false);
        expect(store.getState().artifacts[legacy[0]!.id]?.rawHeader?.kind).toBe('memory_doc.v1');
    });

    it('classifies the caller\'s own legacy headers once at the selected read, never received ones', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const home = createArtifactStoreBoundary({ ownerAccountId: () => 'owner', encryptionMode: 'plain' });
        const legacy = (index: number, ownerAccountId: string): Artifact => {
            const { kindHint: _hint, ...head } = plainHead(index);
            return { ...head, kind: null, ownerAccountId, header: encodePlainArtifactStoredContent({ kind: 'prompt_doc.v2', title: 'Legacy' }) };
        };
        const own = Array.from({ length: 600 }, (_, index) => legacy(index + 1, 'owner'));
        const received = [legacy(601, 'other'), legacy(602, 'other')];
        for (const row of [...own, ...received]) home.replaceStoredRow(row);
        for (const row of received) home.seedAccountGrant(row.id, 'owner', 'edit');
        const calls: { method: string; path: string; body?: { items: { artifactId: string }[] } }[] = [];
        const read = () => fetchAndApplyArtifactsList({ kinds: ['prompt_doc.v2'], credentials: { token: 'token' }, encryption: null,
            artifactDataKeys: new Map(), applyArtifacts: () => {}, request: async (path, init) => {
                calls.push({ method: init?.method ?? 'GET', path, ...(init?.method === 'POST' ? { body: JSON.parse(String(init.body)) } : {}) });
                return await home.handle(path, init) ?? json({ error: 'not_found' });
            } });
        const writes = () => calls.filter(call => call.method === 'POST' && call.path === '/v1/artifacts/query-hints/batch');
        const legacyPages = () => calls.filter(call => call.method === 'GET' && call.path.includes('unclassified='));

        await read();
        expect(writes()).toHaveLength(1);
        expect(writes()[0]!.body!.items.map(item => item.artifactId).sort()).toEqual(own.map(row => row.id).sort());
        expect(own.every(row => home.read(row.id)?.kindHint === 'prompt_doc.v2')).toBe(true);
        expect(received.every(row => !Object.hasOwn(home.read(row.id)!, 'kindHint'))).toBe(true);
        calls.length = 0;

        await read();
        expect(writes()).toHaveLength(0);
        // Only the received rows remain for the owner's own key holder to classify.
        expect(legacyPages()).toHaveLength(1);
    });

    it('never writes classification while repeatedly opening 35000 unclassified or stale inventory headers', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const rows = Array.from({ length: 35000 }, (_, index) => {
            const { kindHint: _legacyHint, ...legacy } = plainHead(index + 1);
            return { ...legacy, kind: index % 2 === 0 ? null : 'skill' as const,
                header: encodePlainArtifactStoredContent({ kind: 'role.v1' }) };
        });
        const writes: unknown[] = [];
        const refresh = () => fetchAndApplyArtifactsList({ credentials: { token: 'token' }, encryption: null,
            artifactDataKeys: new Map(), applyArtifacts: () => {}, request: async (path, init) => {
                if (init?.method === 'POST') { writes.push(JSON.parse(String(init.body))); return json({ success: true }); }
                expect(path).toContain('/v1/artifacts');
                return createArtifactListHttpResponse(new URL(path, 'http://localhost'), rows);
            } });
        await refresh();
        await refresh();
        expect(writes).toHaveLength(0);
    });

    it('keeps body batch successes, missing identities and malformed content independent', async () => {
        const { fetchArtifactsWithBodiesFromApi, decryptArtifactWithBody } = await import('./syncArtifacts');
        const readable: Artifact = { ...plainHead(1), publicAudience: 'none', body: encodePlainArtifactStoredContent({ body: 'Current instructions' }) };
        const malformed: Artifact = { ...plainHead(2), publicAudience: 'none', body: 'invalid body' };
        const missing = plainHead(3).id;
        const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
        const prior = await Promise.all([readable, malformed].map(artifact => decryptArtifactWithBody({
            artifact: { ...artifact, body: encodePlainArtifactStoredContent({ body: 'Old instructions' }) },
            encryption: null, artifactDataKeys: new Map(),
        })));
        store.getState().applyArtifacts(prior.filter((row): row is DecryptedArtifact => row !== null));
        const previousArtifacts = store.getState().artifacts;
        const result = await fetchArtifactsWithBodiesFromApi({ credentials: { token: 'token' }, encryption: null,
            artifactDataKeys: new Map(), previousArtifacts, artifactIds: [readable.id, missing, malformed.id],
            request: async (path, init) => {
                expect(path).toBe('/v1/artifacts/read');
                expect(JSON.parse(String(init?.body))).toEqual({ artifactIds: [readable.id, missing, malformed.id] });
                return json({ items: [
                    { artifactId: readable.id, ok: true, artifact: readable, recipientCensus: null },
                    { artifactId: missing, ok: false, error: 'artifact_not_found', status: 404, retryable: false },
                    { artifactId: malformed.id, ok: true, artifact: malformed, recipientCensus: null },
                ] });
            } });
        expect(result[0]).toMatchObject({ status: 'fulfilled', value: { id: readable.id, body: 'Current instructions' } });
        const current = result[0];
        if (current?.status !== 'fulfilled' || !current.value?.isDecrypted) throw new Error('Expected current readable body');
        expect(current.value.header).toBe(previousArtifacts[readable.id]?.header);
        expect(result[1]).toEqual({ status: 'fulfilled', value: null });
        // The shared codec retains a readable header but never invents an unreadable body.
        expect(result[2]).toMatchObject({ status: 'fulfilled', value: { id: malformed.id, body: undefined } });
    });

    it('does not open or publish body batches after their captured request is cancelled', async () => {
        const { fetchArtifactsWithBodiesFromApi } = await import('./syncArtifacts');
        const controller = new AbortController();
        const artifact = { ...plainHead(1), publicAudience: 'none', body: encodePlainArtifactStoredContent({ body: 'Instructions' }) };
        await expect(fetchArtifactsWithBodiesFromApi({ credentials: { token: 'token' }, encryption: null,
            artifactDataKeys: new Map(), artifactIds: [artifact.id], signal: controller.signal,
            request: async () => {
                controller.abort();
                return json({ items: [{ artifactId: artifact.id, ok: true, artifact, recipientCensus: null }] });
            } })).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('publishes demanded bodies without inventory readiness, then reconciles a completed inventory', async () => {
        const store = createStore<ArtifactsDomain>((set, get) => createArtifactsDomain({ set, get }));
        const { fetchAndApplyArtifactBodies, fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        const artifact = { ...plainHead(1), publicAudience: 'none', body: encodePlainArtifactStoredContent({ body: 'Demanded content' }) };
        const params = { credentials: { token: 'token' }, encryption: null, artifactDataKeys: new Map(),
            request: async (path: string) => path === '/v1/artifacts/read'
                ? json({ items: [{ artifactId: artifact.id, ok: true, artifact, recipientCensus: null }] }) : json([]),
            applyArtifacts: store.getState().applyArtifacts };
        await fetchAndApplyArtifactBodies({ ...params, artifactIds: [artifact.id] });
        expect(store.getState().artifacts[artifact.id]?.body).toBe('Demanded content');
        expect(store.getState().artifactsLoaded).toBe(false);
        const readStartedWith = store.getState().artifacts;
        await fetchAndApplyArtifactsList({ ...params,
            applyArtifacts: (rows, source) => store.getState().applyArtifacts(rows, source === 'inventory' ? readStartedWith : undefined) });
        expect(store.getState().artifactsLoaded).toBe(true);
        expect(store.getState().artifacts).toEqual({});
    });

    it('continues beyond the first transport page without evicting older heads', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://artifact-complete-list.test', scope: 'device' });
        const firstPage = Array.from({ length: 500 }, (_, index) => plainHead(502 - index));
        const secondPage = [plainHead(2), plainHead(1)];
        const last = firstPage.at(-1)!;
        const cursor = encodeBase64(new TextEncoder().encode(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })), 'base64url');
        const cursors: Array<string | null> = [];
        const limits: Array<string | null> = [];
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname !== '/v1/artifacts') return json({ ok: true });
            const requestedCursor = target.searchParams.get('cursor');
            cursors.push(requestedCursor);
            limits.push(target.searchParams.get('limit'));
            return json(requestedCursor === null ? firstPage : secondPage);
        });
        const rows = new Map<string, DecryptedArtifact>();
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        await fetchAndApplyArtifactsList({ credentials: { token: 'token' }, encryption: null, artifactDataKeys: new Map(),
            applyArtifacts: artifacts => { for (const artifact of artifacts) rows.set(artifact.id, artifact); } });
        expect(cursors).toEqual([null, cursor]);
        expect(limits).toEqual(['500', '500']);
        expect(rows.size).toBe(502);
        expect(rows.get(secondPage[1]!.id)?.title).toBe('Document 1');
    });

    it('keeps independent header and exact body reads on the supplied Account transport', async () => {
        const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
        await upsertAndActivateServer({ serverUrl: 'https://different-active-home.test', scope: 'device' });
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const approval = ApprovalRequestV1Schema.parse({ v: 1, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'agent', sessionId: 's1' }, requestedSurface: 'agent',
            actionId: 'session.list', actionArgs: {}, summary: 'List sessions' });
        const head = { ...plainHead(1), kindHint: 'approval_request.v1', header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)) };
        const origins: string[] = [];
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname.startsWith('/v1/artifacts')) origins.push(target.origin);
            const artifact = { ...head, publicAudience: 'none', body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }) };
            return json(target.pathname === '/v1/artifacts' ? [head] : target.pathname === '/v1/artifacts/read'
                ? { items: [{ artifactId: head.id, ok: true, recipientCensus: null, artifact }] } : artifact);
        });
        const { fetchAndApplyArtifactsList, fetchArtifactsWithBodiesFromApi } = await import('./syncArtifacts');
        const bound = { credentials: { token: 'token' }, encryption: null, artifactDataKeys: new Map(),
            request: createServerFetchAtEndpoint({ endpointUrl: 'https://captured-artifact-home.test',
                serverId: 'captured-home', credentials: { token: 'token' } }),
            signal: new AbortController().signal, applyArtifacts: vi.fn() };
        await fetchAndApplyArtifactsList(bound);
        expect(origins).toEqual(['https://captured-artifact-home.test']);
        const [detail] = await fetchArtifactsWithBodiesFromApi({ ...bound, artifactIds: [head.id] });
        expect(detail).toMatchObject({ status: 'fulfilled', value: { body: JSON.stringify(approval) } });
        expect(origins).toEqual(['https://captured-artifact-home.test', 'https://captured-artifact-home.test']);
    });

    it('batches selected encrypted exact reads and rejects a changed caller key', async () => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(21));
        const key = new Uint8Array(32).fill(22);
        const artifactEncryption = new ArtifactEncryption(key);
        const dataEncryptionKey = encodeBase64(await encryption.encryptEncryptionKey(key));
        const changedDataEncryptionKey = encodeBase64(await encryption.encryptEncryptionKey(new Uint8Array(32).fill(23)));
        const rows: Artifact[] = await Promise.all([1, 2].map(async index => ({ ...plainHead(index),
            kindHint: 'approval_request.v1',
            encryptionMode: 'e2ee' as const, dataEncryptionKey,
            header: await artifactEncryption.encryptHeader({ title: `Profile ${index}`, kind: 'approval_request.v1', approvalStatus: 'open' }),
            body: await artifactEncryption.encryptBody({ body: `Profile body ${index}` }), publicAudience: 'none' as const })));
        const paths: string[] = [];
        let changed = false;
        const signingSecret = new Uint8Array(32).fill(24);
        const signingPublic = ed25519.getPublicKey(signingSecret);
        const recipientSecret = new Uint8Array(32).fill(25);
        const recipientPublic = x25519.getPublicKey(recipientSecret);
        const recipientFingerprint = computeContentPublicKeyFingerprint(recipientPublic);
        const signature = signAccountContentKeyBindingV1({ accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]),
            contentPublicKey: recipientPublic });
        const prepared: ArtifactRecipientKeyEnvelopeCommitInputV1[] = [];
        const census = (artifact: Artifact) => ({ artifactId: artifact.id, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
            dataEncryptionKey, callerDataEncryptionKey: changed ? changedDataEncryptionKey : dataEncryptionKey,
            recipients: [{ recipientAccountId: 'recipient', contentKey: { status: 'available',
                accountSigningPublicKey: Buffer.from(signingPublic).toString('hex'), contentPublicKey: encodeBase64(recipientPublic),
                contentPublicKeySignature: encodeBase64(signature) }, contentPublicKeyFingerprint: recipientFingerprint,
                encryptedDataKey: null, recipientContentPublicKeyFingerprint: null }] });
        const request = vi.fn(async (path: string, init?: RequestInit) => {
            const target = new URL(path, 'https://captured.test');
            paths.push(target.pathname);
            if (target.pathname === '/v1/artifacts') return json(rows.map(({ body: _body, ...head }) => head));
            if (target.pathname === '/v1/artifacts/read') {
                const { artifactIds } = JSON.parse(String(init?.body)) as { artifactIds: string[] };
                const selected = artifactIds.map(id => rows.find(row => row.id === id)!);
                return json({ items: selected.map(artifact => ({ artifactId: artifact.id, ok: true, artifact,
                    recipientCensus: census(artifact) })) });
            }
            if (target.pathname.endsWith('/key-envelopes')) {
                const input = JSON.parse(String(init?.body)) as ArtifactRecipientKeyEnvelopeCommitInputV1;
                expect(input.expectedDataEncryptionKey).toBe(dataEncryptionKey);
                expect(input.recipientKeyEnvelopes.map(item => item.recipientAccountId)).toEqual(['recipient']);
                expect(openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(input.recipientKeyEnvelopes[0]!.encryptedDataKey),
                    recipientSecretKeyOrSeed: recipientSecret })).toEqual(key);
                prepared.push(input);
                return json({ appliedRecipientAccountIds: ['recipient'], skippedRecipientAccountIds: [] });
            }
            const artifact = rows.find(row => target.pathname === `/v1/artifacts/${row.id}`
                || target.pathname === `/v1/artifacts/${row.id}/access/recipients`);
            if (artifact) return json(target.pathname.endsWith('/recipients') ? census(artifact) : artifact);
            return json({ error: 'unexpected request' });
        });
        const { fetchArtifactsWithBodiesFromApi } = await import('./syncArtifacts');
        const params = { credentials: { token: 'token' }, encryption, artifactDataKeys: new Map(), request };
        const details = await fetchArtifactsWithBodiesFromApi({ ...params, artifactIds: rows.map(row => row.id) });
        expect(paths.filter(path => !path.endsWith('/key-envelopes'))).toEqual(['/v1/artifacts/read']);
        expect(prepared.map(input => input.artifactId).sort()).toEqual(rows.map(row => row.id).sort());
        expect(details).toMatchObject([{ status: 'fulfilled', value: { body: 'Profile body 1' } },
            { status: 'fulfilled', value: { body: 'Profile body 2' } }]);
        // One-row and batched body demand share the live recipient census,
        // not a separate GET after opening each detail.
        paths.length = 0;
        prepared.length = 0;
        const { fetchArtifactWithBodyFromApi } = await import('./syncArtifacts');
        await expect(fetchArtifactWithBodyFromApi({ ...params, artifactId: rows[0]!.id }))
            .resolves.toMatchObject({ body: 'Profile body 1' });
        expect(paths.filter(path => !path.endsWith('/key-envelopes'))).toEqual(['/v1/artifacts/read']);
        expect(prepared.map(input => input.artifactId)).toEqual([rows[0]!.id]);
        changed = true;
        prepared.length = 0;
        const refused = await fetchArtifactsWithBodiesFromApi({ ...params, artifactIds: rows.map(row => row.id) });
        expect(refused).toMatchObject(rows.map(() => ({ status: 'rejected', reason: { code: 'artifact_data_key_changed' } })));
        expect(prepared).toEqual([]);
    });

    it('drops fetched artifacts when the captured sync scope is stale before apply', async () => {
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');

        const applyArtifacts = vi.fn();
        await fetchAndApplyArtifactsList({
            credentials: { token: 'token-a', secret: 'secret-a' },
            encryption: null,
            artifactDataKeys: new Map(),
            applyArtifacts,
            shouldContinue: () => false,
        });

        expect(applyArtifacts).not.toHaveBeenCalled();
    });

    it('keeps missing, refused and incomplete exact body results distinct from header acquisition', async () => {
        const head = { ...plainHead(1), header: encodePlainArtifactStoredContent({ title: 'Approval', kind: 'approval_request.v1', approvalStatus: 'open' }) };
        let batch: unknown = { items: [{ artifactId: head.id, ok: false, error: 'artifact_not_found', status: 404, retryable: false }] };
        const request = async (path: string) => json(path.startsWith('/v1/artifacts?') ? [head] : batch);
        const { fetchAndApplyArtifactsList, fetchArtifactsWithBodiesFromApi } = await import('./syncArtifacts');
        const applied: DecryptedArtifact[][] = [];
        const params = { credentials: { token: 'token' }, encryption: null, artifactDataKeys: new Map(), request,
            applyArtifacts: (rows: DecryptedArtifact[]) => applied.push(rows) };
        await fetchAndApplyArtifactsList(params);
        expect(applied).toHaveLength(1);
        expect(applied[0]?.[0]?.body).toBeUndefined();
        expect(await fetchArtifactsWithBodiesFromApi({ ...params, artifactIds: [head.id] }))
            .toEqual([{ status: 'fulfilled', value: null }]);
        batch = { items: [{ artifactId: head.id, ok: false, error: 'artifact_content_unavailable', status: 409, retryable: false }] };
        const [refusal] = await fetchArtifactsWithBodiesFromApi({ ...params, artifactIds: [head.id] });
        expect(refusal).toMatchObject({ status: 'rejected', reason: { code: 'artifact_content_unavailable' } });
        expect(refusal?.status === 'rejected' && shouldRetryError(refusal.reason)).toBe(false);
        batch = { items: [{ artifactId: head.id, ok: false, error: 'artifact_content_unavailable', status: 500, retryable: true }] };
        const [ownerFailure] = await fetchArtifactsWithBodiesFromApi({ ...params, artifactIds: [head.id] });
        expect(ownerFailure).toMatchObject({ status: 'rejected', reason: { code: 'artifact_content_unavailable', status: 500 } });
        expect(ownerFailure?.status === 'rejected' && shouldRetryError(ownerFailure.reason)).toBe(true);
        // Census refuses with the existing generic access error, not the exact detail's terminal409.
        batch = { items: [{ artifactId: head.id, ok: false, error: 'artifact_content_unavailable', status: 409, retryable: true }] };
        const [censusFailure] = await fetchArtifactsWithBodiesFromApi({ ...params, artifactIds: [head.id] });
        expect(censusFailure).toMatchObject({ status: 'rejected', reason: { code: 'artifact_content_unavailable', status: 409 } });
        expect(censusFailure?.status === 'rejected' && shouldRetryError(censusFailure.reason)).toBe(true);
        batch = { items: [] };
        await expect(fetchArtifactsWithBodiesFromApi({ ...params, artifactIds: [head.id] }))
            .rejects.toMatchObject({ code: 'artifact_content_unavailable' });
        expect(applied).toHaveLength(1);
    });

    it('keeps a failed batch HTTP read retryable through the existing retry owner', async () => {
        const head = { ...plainHead(1), header: encodePlainArtifactStoredContent({ title: 'Approval', kind: 'approval_request.v1', approvalStatus: 'open' }) };
        const request = async (path: string) => path.startsWith('/v1/artifacts?') ? json([head])
            : Response.json({ error: 'artifact_content_unavailable' }, { status: 500 });
        const { fetchArtifactsWithBodiesFromApi } = await import('./syncArtifacts');
        const refusal = await fetchArtifactsWithBodiesFromApi({ credentials: { token: 'token' }, encryption: null,
            artifactDataKeys: new Map(), request, artifactIds: [head.id] }).catch((error: unknown) => error);
        expect(refusal).toMatchObject({ code: 'artifact_content_unavailable', status: 500 });
        expect(shouldRetryError(refusal)).toBe(true);
    });

    it.each(['plain', 'e2ee'] as const)('retains opened %s private source on cold header-only Browser refresh without loading document bodies', async mode => {
        const { upsertAndActivateServer, getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const home = await upsertAndActivateServer({ serverUrl: `https://artifact-cold-${mode}.test`, scope: 'device' });
        expect(getActiveServerSnapshot().serverUrl).toBe(home.serverUrl);
        const encryption = mode === 'plain' ? null : await Encryption.create(new Uint8Array(32).fill(9));
        const contentKey = new Uint8Array(32).fill(10);
        const privateKey = new Uint8Array(32).fill(11);
        const id = '11111111-1111-4111-8111-111111111111';
        const source = { sessionId: 'session', machineId: 'machine', path: 'private/output.ts', sha: 'a'.repeat(64) };
        const provenance = { savedBy: { kind: 'agent' as const, accountId: 'owner', sessionId: source.sessionId }, source };
        const row = { id, kind: 'other' as const, kindHint: null, ownerAccountId: 'owner', access: 'owner' as const, encryptionMode: mode,
            header: mode === 'plain' ? encodePlainArtifactStoredContent({ title: 'Published output' }) : await new ArtifactEncryption(contentKey).encryptHeader({ title: 'Published output' }),
            headerVersion: 1, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2,
            dataEncryptionKey: encryption ? encodeBase64(await encryption.encryptEncryptionKey(contentKey)) : ARTIFACT_PLAIN_DATA_KEY_MARKER,
            provenance: await sealArtifactPrivateRevisionMetadata({ mode, artifactId: id, bodyVersion: 2, provenance, dataKey: privateKey }),
            provenanceDataEncryptionKey: encryption ? encodeBase64(await encryption.encryptEncryptionKey(privateKey)) : null,
        };
        runtimeFetch.mockImplementation(async (url: unknown) => {
            const target = new URL(String(url));
            if (target.pathname !== '/v1/artifacts') return json({ ok: true });
            expect(target.origin).toBe(home.serverUrl);
            expect(target.searchParams.has('includeBody')).toBe(false);
            return json([row]);
        });
        const applied: DecryptedArtifact[][] = [];
        const { fetchAndApplyArtifactsList } = await import('./syncArtifacts');
        await fetchAndApplyArtifactsList({ credentials: { token: 'token' }, encryption, artifactDataKeys: new Map(), includeProvenance: true,
            applyArtifacts: rows => applied.push(rows) });
        expect(applied[0]?.[0]).toMatchObject({ id, bodyVersion: 2, provenance });
        expect(applied[0]?.[0]?.body).toBeUndefined();
        expect(readArtifactProvenance(applied[0]![0]!)).toEqual(source);
        expect(applied[0]?.[0]?.rawHeader).not.toHaveProperty('source');
        if (mode === 'e2ee') {
            const viewerEncryption = await Encryption.create(new Uint8Array(32).fill(12));
            const viewerContentWrap = encodeBase64(await viewerEncryption.encryptEncryptionKey(contentKey));
            const viewerPrivateWrap = encodeBase64(await viewerEncryption.encryptEncryptionKey(privateKey));
            expect(viewerPrivateWrap).not.toBe(row.provenanceDataEncryptionKey);
            // The HTTP boundary projects content-only custody without private metadata.
            const viewerRow = { ...row, access: 'view' as const, dataEncryptionKey: viewerContentWrap,
                provenance: null, provenanceDataEncryptionKey: null };
            runtimeFetch.mockImplementation(async (url: unknown) => json(new URL(String(url)).pathname === '/v1/artifacts' ? [viewerRow] : { ok: true }));
            await fetchAndApplyArtifactsList({ credentials: { token: 'viewer' }, encryption: viewerEncryption, includeProvenance: true,
                artifactDataKeys: new Map(), applyArtifacts: rows => applied.push(rows) });
            expect(applied[1]?.[0]).toMatchObject({ id, isDecrypted: true, title: 'Published output' });
            expect(readArtifactProvenance(applied[1]![0]!)).toBeNull();
            runtimeFetch.mockImplementation(async (url: unknown) => json(new URL(String(url)).pathname === '/v1/artifacts' ? [{ ...viewerRow,
                provenance: row.provenance, provenanceDataEncryptionKey: viewerPrivateWrap }] : { ok: true }));
            await fetchAndApplyArtifactsList({ credentials: { token: 'viewer' }, encryption: viewerEncryption, includeProvenance: true,
                artifactDataKeys: new Map(), applyArtifacts: rows => applied.push(rows) });
            expect(applied[2]?.[0]).toMatchObject({ id, bodyVersion: 2, provenance });
            expect(readArtifactProvenance(applied[2]![0]!)).toEqual(source);
            expect(await new ArtifactEncryption(contentKey).decryptHeaderRaw(row.provenance)).toBeNull();
        }
        expect(runtimeFetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).not.toContain(`/v1/artifacts/${id}`);
    });
});
