import { describe, expect, it, vi } from 'vitest';
import { LegacyHostSessionSystemRecordSchema, SessionSystemRecordListQuerySchema, SessionSystemRecordStoredSchema } from '@happier-dev/protocol';
import { createSessionSystemRecordRepository } from './repository';
import { selectWorkflowSystemRecordQuery } from './compatibility/legacyHostTransport';
import { invalidateSessionSystemRecordsFromChanges } from './changeWatch';
import { openSessionStoredContent, type OpenSessionStoredContentResult, type SessionStoredContentContext } from '@happier-dev/sync-client';
import { makeSessionWorkflowRunSnapshot } from '@/dev/testkit/fixtures/sessionWorkflowActivityFixtures';

const scope = { serverId: 'home-a', accountId: 'alice' };
const session = { serverId: 'home-a', sessionId: 'session-one' };
const query = { type: 'list', namespace: 'activity', kind: 'workflow_run.v1' } as const;
const record = {
    id: 'record-one',
    address: { owner: 'host', namespace: 'activity', kind: 'workflow_run.v1', localId: 'run-one' },
    content: { t: 'plain', v: { v: 1 } },
    revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
    createdAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
};
const page = () => new Response(JSON.stringify({ records: [record], nextCursor: null, hasNext: false }));

describe('Account-scoped Session System Record repository', () => {
    it('addresses matching list pages without scanning retained unrelated selectors', async () => {
        const repository = createSessionSystemRecordRepository({ scope, request: async path => {
            const params = new URL(path, 'https://home-a').searchParams;
            const localId = params.get('localId') ?? 'run-one';
            const current = { ...record, id: localId, address: { ...record.address, localId } };
            return Response.json(path.includes('/record?') ? { record: current } : { records: [current], nextCursor: null, hasNext: false });
        } });
        let unrelatedQueryVisits = 0;
        for (let index = 0; index < 1000; index++) {
            await repository.refresh(session, { get type() { unrelatedQueryVisits++; return 'list' as const; },
                namespace: 'activity', kind: 'workflow_run.v1', localId: `unrelated-${index}` });
        }
        const matching = [
            { type: 'list', namespace: 'activity' },
            { type: 'list', namespace: 'activity', kind: 'workflow_run.v1' },
            { type: 'list', namespace: 'activity', localId: 'run-one' },
            { type: 'list', namespace: 'activity', kind: 'workflow_run.v1', localId: 'run-one', cursor: 'next', limit: 1 },
        ] as const;
        // Parse the wire fixture once, preserving the host-address discriminant.
        const address = SessionSystemRecordStoredSchema.parse(record).address;
        if (address.owner !== 'host') throw new Error('Expected host fixture');
        const read = { type: 'read', address } as const;
        await repository.refresh(session, read);
        for (const retained of matching) await repository.refresh(session, retained);
        const otherSession = { ...session, sessionId: 'other-session' };
        await repository.refresh(otherSession, read);
        unrelatedQueryVisits = 0;
        repository.invalidate(session, [address, address]);
        expect(unrelatedQueryVisits).toBe(0);
        expect(repository.getSnapshot(session, read).freshness).toBe('stale');
        for (const retained of matching) expect(repository.getSnapshot(session, retained).freshness).toBe('stale');
        expect(repository.getSnapshot(otherSession, read).freshness).toBe('fresh');
        repository.retire();
    });
    it('keeps legacy workflow invalidation addressed and preserves retained hidden queries through release', async () => {
        const selection = selectWorkflowSystemRecordQuery({ localId: 'run-one', protocolVersions: null });
        if (selection.status !== 'ready') throw new Error('Expected supported predecessor reader');
        const legacy = selection.query;
        const otherLegacy = { type: 'legacy_workflow', localId: 'other-run' } as const;
        let reads = 0;
        const repository = createSessionSystemRecordRepository({ scope, request: async path => {
            reads++;
            const localId = new URL(path, 'https://home-a').searchParams.get('localId') ?? 'run-one';
            return Response.json({ record: LegacyHostSessionSystemRecordSchema.parse({
                id: localId, sessionId: session.sessionId, namespace: 'activity', kind: 'workflow_run.v1', localId,
                content: { t: 'plain', v: makeSessionWorkflowRunSnapshot({ runId: localId }) },
                createdAt: record.createdAt, updatedAt: record.updatedAt,
            }) });
        } });
        const release = repository.subscribe(session, legacy, () => {});
        await repository.refresh(session, legacy);
        await repository.refresh(session, otherLegacy);
        release();
        repository.invalidate(session, [{ owner: 'host', namespace: 'activity', kind: 'workflow_run.v1', localId: 'run-one' }]);
        expect(repository.getSnapshot(session, legacy).freshness).toBe('stale');
        expect(repository.getSnapshot(session, otherLegacy).freshness).toBe('fresh');
        expect(reads).toBe(2);
        const remount = repository.subscribe(session, legacy, () => {});
        await repository.refresh(session, legacy);
        expect(reads).toBe(3);
        repository.invalidateLegacyWorkflows(session);
        expect(repository.getSnapshot(session, otherLegacy).freshness).toBe('stale');
        remount();
        repository.retire();
        expect(repository.getSnapshot(session, legacy).lastError).toEqual({ status: 'forbidden' });
    });
    it('keeps a shared explicit count read alive when the mounted rail releases its demand', async () => {
        let resolveReply: ((response: Response) => void) | undefined;
        let requests = 0;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            requests++; return await new Promise<Response>(resolve => { resolveReply = resolve; });
        } });
        const release = repository.acquireBoardItemCount(session, { isCurrent: () => true, readCapabilities: () => ({ readTranscript: true, editSessionRecords: false }) });
        const explicit = repository.fetchBoardItemCount(session);
        release();
        resolveReply!(new Response(JSON.stringify({ count: 7 })));
        await expect(explicit).resolves.toEqual({ status: 'ok', value: { count: 7 } });
        expect(repository.readBoardItemCount(session)).toBe(7);
        expect(requests).toBe(1);
        repository.retire();
    });
    it('retires obsolete count replies and settles an unsupported count without retries or body fallback', async () => {
        let resolveReply: ((response: Response) => void) | undefined;
        let requests = 0;
        const repository = createSessionSystemRecordRepository({ scope, retryBackoff: { minDelayMs: 1, maxDelayMs: 1 }, request: async () => {
            requests++; return await new Promise<Response>(resolve => { resolveReply = resolve; });
        } });
        const published: (number | null)[] = [];
        const stop = repository.subscribeBoardItemCount(session, () => published.push(repository.readBoardItemCount(session)));
        const authority = { isCurrent: () => true, readCapabilities: () => ({ readTranscript: true, editSessionRecords: false }) };
        const release = repository.acquireBoardItemCount(session, authority);
        release();
        resolveReply!(new Response(JSON.stringify({ count: 9 })));
        await Promise.resolve(); await Promise.resolve();
        expect(repository.readBoardItemCount(session)).toBeNull();
        const releaseNext = repository.acquireBoardItemCount(session, authority);
        const unsupported = repository.fetchBoardItemCount(session);
        resolveReply!(new Response(JSON.stringify({ records: [], nextCursor: null, hasNext: false })));
        await expect(unsupported).resolves.toEqual({ status: 'invalid_response' });
        expect(requests).toBe(2);
        expect(published).not.toContain(9);
        expect(repository.readBoardItemCount(session)).toBeNull();
        repository.invalidate(session); repository.refreshObserved({ force: true });
        await Promise.resolve();
        expect(requests).toBe(2);
        releaseNext(); stop(); repository.retire();
    });
    it('shares one count acquisition per mounted address, without detail reads, retry or refetch', async () => {
        const requests: string[] = [];
        const repository = createSessionSystemRecordRepository({ scope, retryBackoff: { minDelayMs: 1, maxDelayMs: 1 },
            request: async path => { requests.push(path); return new Response(JSON.stringify({ count: 4 })); } });
        const authority = { isCurrent: () => true, readCapabilities: () => ({ readTranscript: true, editSessionRecords: false }) };
        const listener = vi.fn();
        const stopListening = repository.subscribeBoardItemCount(session, listener);
        expect(requests).toEqual([]);
        const release = repository.acquireBoardItemCount(session, authority);
        const releasePeer = repository.acquireBoardItemCount(session, authority);
        await vi.waitFor(() => expect(repository.readBoardItemCount(session)).toBe(4));
        expect(requests).toHaveLength(1);
        repository.invalidate(session);
        expect(repository.readBoardItemCount(session)).toBeNull();
        repository.refreshObserved({ force: true });
        const releaseLater = repository.acquireBoardItemCount(session, authority);
        await Promise.resolve();
        expect(requests).toHaveLength(1);
        releaseLater(); releasePeer(); release(); stopListening(); repository.retire();
    });
    it('reuses complete held record inventories, counting records rather than layout placeholders', async () => {
        let requests = 0;
        const itemRecord = { ...record, content: { t: 'encrypted', c: 'unopened-item' }, address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'note' } };
        const layoutRecord = { ...record, id: 'layout-row', content: { t: 'encrypted', c: 'unopened-layout' }, address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' } };
        const repository = createSessionSystemRecordRepository({ scope, request: async path => {
            requests++;
            return new Response(JSON.stringify(path.includes('kind=layout.v1')
                ? { record: layoutRecord }
                : { records: [itemRecord, layoutRecord], nextCursor: null, hasNext: false }));
        } });
        await repository.refresh(session, { type: 'read', address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' } });
        expect(repository.readBoardItemCount(session)).toBeNull();
        // The mounted Board owner observes the complete namespace, including layout.
        await repository.refresh(session, { type: 'list', namespace: 'surface' });
        expect(repository.readBoardItemCount(session)).toBe(1);
        const release = repository.acquireBoardItemCount(session, { isCurrent: () => true, readCapabilities: () => ({ readTranscript: true, editSessionRecords: false }) });
        await Promise.resolve();
        expect(requests).toBe(2);
        repository.invalidate(session);
        const releaseLater = repository.acquireBoardItemCount(session, { isCurrent: () => true, readCapabilities: () => ({ readTranscript: true, editSessionRecords: false }) });
        await Promise.resolve();
        expect(requests).toBe(2);
        releaseLater(); release(); repository.retire();
    });
    it('reuses a complete paged item inventory and counts overlapping record identities once', async () => {
        let requests = 0;
        const itemRecord = { ...record, content: { t: 'encrypted', c: 'unopened-item' }, address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'note' } };
        const repository = createSessionSystemRecordRepository({ scope, request: async path => {
            requests++;
            const last = path.includes('cursor=next');
            return new Response(JSON.stringify({ records: last ? [itemRecord, { ...itemRecord, id: 'record-two',
                address: { ...itemRecord.address, localId: 'second' } }] : [itemRecord], nextCursor: last ? null : 'next', hasNext: !last }));
        } });
        await repository.refresh(session, { type: 'list', namespace: 'surface', kind: 'item.v1' });
        expect(repository.readBoardItemCount(session)).toBeNull();
        await repository.refresh(session, { type: 'list', namespace: 'surface', kind: 'item.v1', cursor: 'next' });
        expect(repository.readBoardItemCount(session)).toBe(2);
        const release = repository.acquireBoardItemCount(session, { isCurrent: () => true, readCapabilities: () => ({ readTranscript: true, editSessionRecords: false }) });
        await Promise.resolve();
        expect(requests).toBe(2);
        release(); repository.retire();
    });
    it('keeps an already stale hidden query stable and still refreshes it when observed again', async () => {
        let requests = 0;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => { requests++; return page(); } });
        const stop = repository.subscribe(session, query, () => {});
        await repository.refresh(session, query);
        stop();
        repository.invalidate(session);
        const stale = repository.getSnapshot(session, query);
        repository.invalidate(session);
        expect(repository.getSnapshot(session, query)).toBe(stale);
        expect(requests).toBe(1);
        const notify = vi.fn();
        const remounted = repository.subscribe(session, query, notify);
        await repository.refresh(session, query);
        expect(requests).toBe(2);
        expect(repository.getSnapshot(session, query)).toMatchObject({ freshness: 'fresh', loading: 'idle' });
        expect(notify).toHaveBeenCalled();
        remounted();
        repository.retire();
    });
    it('shares an addressed item opening across subscribers and reopens only when crypto context changes', async () => {
        const value = { v: 1, destination: 'transcript', title: 'Visual', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Visible' } } } };
        const surfaceRecord = SessionSystemRecordStoredSchema.parse({ ...record,
            address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'visual' },
            content: { t: 'encrypted', c: 'cipher' },
        });
        const repository = createSessionSystemRecordRepository({ scope, request: async () => page() });
        let decryptions = 0;
        const context: SessionStoredContentContext = { mode: 'e2ee', encryption: {
            encryptRaw: async () => 'cipher', decryptRaw: async () => { decryptions++; return value; },
        } };
        const first = repository.openSurfaceItem(surfaceRecord, context);
        const concurrent = repository.openSurfaceItem(surfaceRecord, { ...context });
        expect(await first).toMatchObject({ status: 'ready', value: { title: 'Visual' } });
        expect(await concurrent).toMatchObject({ status: 'ready' });
        expect(decryptions).toBe(1);
        expect(await repository.openSurfaceItem(surfaceRecord, { mode: 'plain' })).toEqual({ status: 'mode_mismatch' });
        expect(await repository.openSurfaceItem(surfaceRecord, { mode: 'e2ee', encryption: null })).toEqual({ status: 'locked' });
        expect(decryptions).toBe(1);
    });
    it('retains an unobserved snapshot for its Account lifetime without refetching on remount', async () => {
        let requests = 0;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            requests += 1;
            return page();
        } });

        const empty = repository.getSnapshot(session, query);
        expect(repository.getSnapshot(session, query)).toBe(empty);
        const stop = repository.subscribe(session, query, () => {});
        await repository.refresh(session, query);
        expect(requests).toBe(1);
        const loaded = repository.getSnapshot(session, query);
        stop();

        expect(repository.getSnapshot(session, query)).toBe(loaded);
        const remounted = repository.subscribe(session, query, () => {});
        expect(repository.getSnapshot(session, query)).toBe(loaded);
        expect(requests).toBe(1);
        remounted();
        repository.retire();
        expect(repository.getSnapshot(session, query)).toMatchObject({ data: null, lastError: { status: 'forbidden' } });
    });

    it('retains a read that finishes after its last observer leaves', async () => {
        let requests = 0;
        let settle: ((response: Response) => void) | undefined;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            requests += 1;
            return await new Promise<Response>((resolve) => { settle = resolve; });
        } });
        const stop = repository.subscribe(session, query, () => {});
        const pending = repository.refresh(session, query);
        stop();
        settle!(page());
        await pending;

        const remounted = repository.subscribe(session, query, () => {});
        expect(repository.getSnapshot(session, query)).toMatchObject({ data: { records: [record] }, loading: 'idle' });
        expect(requests).toBe(1);
        remounted();
    });

    it('marks hidden data stale on a content-free wake without ambient work and refreshes it in place on remount', async () => {
        let requests = 0;
        let settle: ((response: Response) => void) | undefined;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            requests++;
            if (requests === 1) return page();
            return new Promise<Response>(resolve => { settle = resolve; });
        } });
        const stop = repository.subscribe(session, query, () => {});
        await repository.refresh(session, query);
        const data = repository.getSnapshot(session, query).data;
        stop();
        repository.invalidateAll();
        repository.refreshObserved({ force: true });
        expect(requests).toBe(1);
        expect(repository.getSnapshot(session, query)).toMatchObject({ data, freshness: 'stale', loading: 'idle' });
        const remounted = repository.subscribe(session, query, () => {});
        expect(repository.getSnapshot(session, query)).toMatchObject({ data, loading: 'refreshing' });
        const pending = repository.refresh(session, query);
        const updated = { ...record, revision: 'ssr1.AAAACHN5c3JlY18xAAAAAg' };
        settle!(Response.json({ records: [updated], nextCursor: null, hasNext: false }));
        await pending;
        expect(repository.getSnapshot(session, query)).toMatchObject({ data: { records: [updated] }, freshness: 'fresh', loading: 'idle' });
        remounted();
    });

    it('isolates a failing listener and still notifies the remaining observers', async () => {
        const repository = createSessionSystemRecordRepository({ scope, request: async () => page() });
        let laterNotifications = 0;
        const stopThrowing = repository.subscribe(session, query, () => { throw new Error('optional observer failed'); });
        const stopLater = repository.subscribe(session, query, () => { laterNotifications += 1; });

        await expect(repository.refresh(session, query)).resolves.toBeUndefined();
        expect(laterNotifications).toBeGreaterThan(0);
        expect(() => repository.invalidate(session)).not.toThrow();

        stopThrowing();
        stopLater();
    });

    it('reopens observed stored bytes on key readiness without issuing a second record GET', async () => {
        let gets = 0;
        const encryptedRecord = { ...record, content: { t: 'encrypted', c: 'cipher' } };
        const read = {
            type: 'read',
            address: { owner: 'host', namespace: 'activity', kind: 'workflow_run.v1', localId: 'run-one' },
        } as const;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            gets += 1;
            return new Response(JSON.stringify({ record: encryptedRecord }));
        } });
        let context: SessionStoredContentContext = { mode: 'e2ee', encryption: null };
        let opened: Promise<OpenSessionStoredContentResult>;
        const reopen = () => { opened = openSessionStoredContent(context, repository.getSnapshot(session, read).data?.content); };
        const stop = repository.subscribe(session, read, reopen);
        await repository.refresh(session, read);
        reopen();
        expect(await opened!).toEqual({ status: 'locked' });
        // Session crypto is the external boundary; repository and envelope dispatch remain real.
        context = { mode: 'e2ee', encryption: { encryptRaw: async () => 'cipher', decryptRaw: async () => ({ v: 1 }) } };
        repository.notifyContentContextChanged(session);
        expect(await opened!).toEqual({ status: 'ready', value: { v: 1 } });
        expect(gets).toBe(1);
        stop();
    });

    it('ignores another Account and refreshes observed data after a coalesced ordinary Session change', async () => {
        let revision = record.revision;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => new Response(JSON.stringify({ records: [{ ...record, revision }], nextCursor: null, hasNext: false })) });
        const stop = repository.subscribe(session, query, () => {});
        await repository.refresh(session, query);
        const changes = [{ kind: 'session', entityId: session.sessionId, cursor: 2, changedAt: 2, hint: { type: 'messages' } }] as const;
        invalidateSessionSystemRecordsFromChanges({ scope: { ...scope, accountId: 'bob' }, changes, repository });
        expect(repository.getSnapshot(session, query).freshness).toBe('fresh');
        revision = 'ssr1.AAAACHN5c3JlY18xAAAAAg';
        invalidateSessionSystemRecordsFromChanges({ scope, changes, repository });
        await repository.refresh(session, query);
        expect(repository.getSnapshot(session, query).data?.records[0].revision).toBe(revision);
        stop();
    });
    it('invalidates from the exact Session/share identity regardless of absent or malformed hints', async () => {
        const repository = createSessionSystemRecordRepository({ scope, request: async () => page() });
        const stop = repository.subscribe(session, query, () => {});
        await repository.refresh(session, query);

        for (const change of [
            { kind: 'session', entityId: session.sessionId, cursor: 1, changedAt: 1 },
            { kind: 'share', entityId: session.sessionId, cursor: 2, changedAt: 2, hint: { v: 1, sessionSurfaces: 'invalid' } },
        ] as const) {
            invalidateSessionSystemRecordsFromChanges({ scope, changes: [change], repository });
            expect(repository.getSnapshot(session, query).freshness).toBe('stale');
            await repository.refresh(session, query);
        }

        stop();
    });
    it('sends only the strict host list contract and preserves unchanged records after refresh', async () => {
        const repository = createSessionSystemRecordRepository({ scope, request: async (path) => {
            const requestQuery = Object.fromEntries(new URL(path, 'https://home-a').searchParams);
            if (!SessionSystemRecordListQuerySchema.safeParse(requestQuery).success) return new Response(JSON.stringify({ error: 'invalid query', code: 'plugin_session_record_invalid_query' }), { status: 400 });
            return page();
        } });
        const stop = repository.subscribe(session, query, () => {});
        await repository.refresh(session, query);
        const initial = repository.getSnapshot(session, query).data;
        expect(initial).toMatchObject({ records: [record] });
        await repository.refresh(session, query);
        expect(repository.getSnapshot(session, query).data).toBe(initial);
        stop();
    });
    it('coalesces reads and retains last-known data during an offline refresh', async () => {
        let resolveRequest: ((response: Response) => void) | undefined;
        let requests = 0;
        let offline = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            requests += 1;
            if (offline) throw new TypeError('network unavailable');
            return await new Promise<Response>((resolve) => { resolveRequest = resolve; });
        } });
        expect(repository.getSnapshot(session, query)).toMatchObject({ data: null, loading: 'idle', freshness: 'stale' });
        const stop = repository.subscribe(session, query, () => {});
        const first = repository.refresh(session, query);
        const concurrent = repository.refresh(session, query);
        expect(repository.getSnapshot(session, query).loading).toBe('initial');
        expect(requests).toBe(1);
        resolveRequest!(page());
        await Promise.all([first, concurrent]);
        const data = repository.getSnapshot(session, query).data;
        expect(data).toMatchObject({ records: [record] });
        offline = true;
        const refresh = repository.refresh(session, query);
        expect(repository.getSnapshot(session, query)).toMatchObject({ loading: 'refreshing', data });
        await refresh;
        // A read that did not finish never proves the Home unreachable or the record gone: the
        // last record stays, reachable, and is not staled by the failure itself.
        expect(repository.getSnapshot(session, query)).toMatchObject({ loading: 'idle', freshness: 'fresh', reachability: 'reachable', lastError: { status: 'offline' } });
        expect(repository.getSnapshot(session, query).data).toBe(data);
        stop();
    });

    it('keeps the last record through a failed read and re-reads on the sync backoff until it answers or its last observer leaves', async () => {
        vi.useFakeTimers();
        try {
            let requests = 0;
            let failing = false;
            const repository = createSessionSystemRecordRepository({
                scope,
                retryBackoff: { minDelayMs: 500, maxDelayMs: 30_000 },
                request: async () => {
                    requests += 1;
                    if (failing) throw new TypeError('network unavailable');
                    return page();
                },
            });
            const stop = repository.subscribe(session, query, () => {});
            await repository.refresh(session, query);
            const data = repository.getSnapshot(session, query).data;
            expect(data).toMatchObject({ records: [record] });

            failing = true;
            repository.invalidate(session);
            await vi.advanceTimersByTimeAsync(0);
            // Invalidated and unreadable: still the last record, reachable, rereading (never "offline").
            expect(repository.getSnapshot(session, query)).toMatchObject({ freshness: 'stale', loading: 'refreshing', reachability: 'reachable', lastError: { status: 'offline' } });
            expect(repository.getSnapshot(session, query).data).toBe(data);
            const failedRequests = requests;

            await vi.advanceTimersByTimeAsync(30_000);
            expect(requests).toBeGreaterThan(failedRequests);
            expect(repository.getSnapshot(session, query).data).toBe(data);

            failing = false;
            await vi.advanceTimersByTimeAsync(30_000);
            expect(repository.getSnapshot(session, query)).toMatchObject({ freshness: 'fresh', loading: 'idle', reachability: 'reachable', lastError: null });

            failing = true;
            repository.invalidate(session);
            await vi.advanceTimersByTimeAsync(0);
            stop();
            const afterLeaving = requests;
            await vi.advanceTimersByTimeAsync(120_000);
            expect(requests).toBe(afterLeaving);
        } finally { vi.useRealTimers(); }
    });

    it('does not re-read a definitive refusal on the backoff', async () => {
        vi.useFakeTimers();
        try {
            let requests = 0;
            const repository = createSessionSystemRecordRepository({
                scope,
                retryBackoff: { minDelayMs: 500, maxDelayMs: 30_000 },
                request: async () => {
                    requests += 1;
                    return new Response(JSON.stringify({ error: 'denied', code: 'plugin_session_record_forbidden' }), { status: 403 });
                },
            });
            const stop = repository.subscribe(session, query, () => {});
            await vi.advanceTimersByTimeAsync(0);
            expect(repository.getSnapshot(session, query)).toMatchObject({ data: null, lastError: { status: 'forbidden' } });
            const settled = requests;
            await vi.advanceTimersByTimeAsync(120_000);
            expect(requests).toBe(settled);
            stop();
        } finally { vi.useRealTimers(); }
    });

    it('refreshes an observed fresh projection when reconnect asks it to converge', async () => {
        let requests = 0;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => {
            requests += 1;
            return page();
        } });
        const stop = repository.subscribe(session, query, () => {});
        await repository.refresh(session, query);
        expect(requests).toBe(1);
        expect(repository.getSnapshot(session, query).freshness).toBe('fresh');

        repository.refreshObserved({ force: true });
        expect(repository.getSnapshot(session, query).freshness).toBe('stale');
        await repository.refresh(session, query);

        expect(requests).toBe(2);
        expect(repository.getSnapshot(session, query).freshness).toBe('fresh');
        stop();
    });

    it('isolates Home invalidation and discards late content when its Account scope retires', async () => {
        let resolveRequest: ((response: Response) => void) | undefined;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => new Promise<Response>((resolve) => { resolveRequest = resolve; }) });
        expect(repository.isCurrent()).toBe(true);
        const pending = repository.refresh(session, query);
        repository.retire();
        expect(repository.isCurrent()).toBe(false);
        resolveRequest!(page());
        await pending;
        expect(repository.getSnapshot(session, query).data).toBeNull();
        expect(repository.getSnapshot(session, query).lastError).toEqual({ status: 'forbidden' });
    });

    it('invalidates only its exact Home and retires readable data on access denial', async () => {
        let denied = false;
        const repository = createSessionSystemRecordRepository({ scope, request: async () => denied
            ? new Response(JSON.stringify({ error: 'denied', code: 'plugin_session_record_forbidden' }), { status: 403 })
            : page() });
        const stop = repository.subscribe(session, query, () => {});
        await repository.refresh(session, query);
        repository.invalidate({ ...session, serverId: 'home-b' });
        expect(repository.getSnapshot(session, query).freshness).toBe('fresh');
        stop();
        denied = true;
        repository.invalidate(session);
        expect(repository.getSnapshot(session, query).freshness).toBe('stale');
        const remounted = repository.subscribe(session, query, () => {});
        await repository.refresh(session, query);
        expect(repository.getSnapshot(session, query)).toMatchObject({ data: null, lastError: { status: 'forbidden' } });
        remounted();
    });

    it.each(['strict', 'legacy'] as const)('serves a %s Session query addressed by the device-local id of a Home its scope names by published identity', async (protocol) => {
        // The captured Account scope names an identity-bearing Home by its `srv_*` scope id,
        // while a Board or Workflow surface addresses its Session by the device-local profile
        // id. Both name one Home, so reads and invalidation must reach the same projection.
        const { adoptHomeProfile, removeServerProfile, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const home = await adoptHomeProfile({
            descriptor: {
                serverUrl: 'https://records-identity-home.example',
                homeServerIdentityId: 'srv_records-home',
                displayName: 'Records Home',
            },
            source: 'manual',
            suggestedName: 'Records Home',
        });
        try {
            const scopeId = resolveServerProfileScopeIdForIdentifier(home.id);
            expect(scopeId).not.toBe(home.id);
            const selected = selectWorkflowSystemRecordQuery({ localId: record.address.localId, protocolVersions: null });
            if (selected.status !== 'ready') throw new Error('Expected negotiated legacy workflow query');
            const sessionQuery = protocol === 'legacy' ? selected.query : query;
            let requests = 0;
            const repository = createSessionSystemRecordRepository({
                scope: { serverId: scopeId, accountId: 'alice' },
                request: async () => {
                    requests += 1;
                    return protocol === 'legacy' ? new Response(JSON.stringify({ record: {
                        id: record.id, sessionId: session.sessionId,
                        namespace: record.address.namespace, kind: record.address.kind, localId: record.address.localId,
                        content: { t: 'plain', v: makeSessionWorkflowRunSnapshot({ runId: 'run-one' }) },
                        createdAt: record.createdAt, updatedAt: record.updatedAt,
                    } })) : page();
                },
            });
            const localAddress = { serverId: home.id, sessionId: 'session-one' };

            const stop = repository.subscribe(localAddress, sessionQuery, () => {});
            await repository.refresh(localAddress, sessionQuery);
            expect(requests).toBe(1);
            expect(repository.getSnapshot(localAddress, sessionQuery)).toMatchObject({ freshness: 'fresh', lastError: null });
            // The scope's own address reads the same entry rather than a second projection.
            expect(repository.getSnapshot({ serverId: scopeId, sessionId: 'session-one' }, sessionQuery).data)
                .toBe(repository.getSnapshot(localAddress, sessionQuery).data);

            repository.invalidate({ serverId: scopeId, sessionId: 'session-one' });
            expect(repository.getSnapshot(localAddress, sessionQuery).freshness).toBe('stale');
            await repository.refresh(localAddress, sessionQuery);
            expect(requests).toBe(2);

            // A different Home is still refused without a request.
            expect(repository.getSnapshot({ serverId: 'home-b', sessionId: 'session-one' }, sessionQuery).lastError).toEqual({ status: 'forbidden' });
            stop();
            const loaded = repository.getSnapshot(localAddress, sessionQuery);
            const remounted = repository.subscribe(localAddress, sessionQuery, () => {});
            expect(repository.getSnapshot(localAddress, sessionQuery)).toBe(loaded);
            expect(requests).toBe(2);
            remounted();
        } finally {
            await removeServerProfile(home.id);
        }
    });
});
