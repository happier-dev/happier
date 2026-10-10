import { describe, expect, it } from 'vitest';
import { SessionSystemRecordListQuerySchema, SessionSystemRecordStoredSchema } from '@happier-dev/protocol';
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
    it('does not retain an unobserved snapshot and truthfully refetches after the final observer leaves', async () => {
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
        stop();

        const remounted = repository.subscribe(session, query, () => {});
        await repository.refresh(session, query);
        expect(requests).toBe(2);
        remounted();
    });

    it('retires a zero-observer entry as soon as its in-flight request settles', async () => {
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
        expect(requests).toBe(2);
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
        expect(repository.getSnapshot(session, query)).toMatchObject({ loading: 'idle', freshness: 'stale', reachability: 'offline', lastError: { status: 'offline' } });
        expect(repository.getSnapshot(session, query).data).toBe(data);
        stop();
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
        denied = true;
        repository.invalidate(session);
        expect(repository.getSnapshot(session, query).freshness).toBe('stale');
        await repository.refresh(session, query);
        expect(repository.getSnapshot(session, query)).toMatchObject({ data: null, lastError: { status: 'forbidden' } });
        stop();
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
        } finally {
            await removeServerProfile(home.id);
        }
    });
});
