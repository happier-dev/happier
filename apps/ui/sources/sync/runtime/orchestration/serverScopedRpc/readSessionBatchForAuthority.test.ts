import { afterEach, expect, it, vi } from 'vitest';
import { SessionReadBatchRequestV1Schema, SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { ServerAccountRequestAuthority } from './createServerRequestWithServerScope';
import { readSessionBatchForAuthority, resetSessionPartsReadsForTests, SessionPartsInvalidResponseError } from './readSessionBatchForAuthority';
import { readSessionByIdHttp } from '@/sync/engine/sessions/sessionByIdHttp';
import { createCapturedServerReadTransport } from './capturedServerReadTransport';
import * as sessionPartsRead from './readSessionBatchForAuthority';
import { countReadBorrowers, countTransportRequests } from '@/dev/testkit';

const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) ,
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
}));
afterEach(() => { vi.restoreAllMocks(); runtimeFetch.mockReset(); resetSessionPartsReadsForTests(); });

function fixtureAuthority(request: ServerAccountRequestAuthority['request']): ServerAccountRequestAuthority {
    runtimeFetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({});
        return await request(`${url.pathname}${url.search}`, init);
    });
    return { scope: { serverId: 'home', accountId: 'account' },
        context: { scope: 'scoped', targetServerId: 'home', targetServerUrl: 'https://home.example.test',
            targetAccountId: 'account', token: 'token', credentials: { token: 'token' }, encryption: null, timeoutMs: 30_000 },
        request, release: async () => {}, readTransport: createCapturedServerReadTransport({ serverId: 'home',
            profile: { serverUrl: 'https://home.example.test' }, credentials: { token: 'token' } }) };
}

function responseFor(init?: RequestInit) {
    const input = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
    return Response.json({ results: input.sessionIds.map(sessionId => ({ sessionId,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }) } },
        ...(input.includeSnapshot && input.includeTurns !== false ? { turns: { status: 200, body: { v: 1, sessionId, updatedAt: 1, turns: [] } } } : {}),
    })) });
}

it.each(['detail', 'turns'] as const)('rejects a successful %s part naming another Session before disclosing the batch', async part => {
    let mismatched = true;
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
        const body = SessionReadBatchResponseV1Schema.parse(await responseFor(init).json());
        return Response.json({ results: body.results.map(row => !mismatched ? row : {
            ...row,
            ...(part === 'detail' ? { detail: { status: 200, body: { session:
                createPlainSessionCurrentProjectionRecordFixture({ id: 'other-session' }) } } }
                : { turns: { status: 200, body: { v: 1, sessionId: 'other-session', updatedAt: 1, turns: [] } } }),
        }) });
    });
    const authority = fixtureAuthority(request);
    const onResult = vi.fn();
    const read = () => readSessionBatchForAuthority({ authority, sessionIds: ['requested-session'],
        includeSnapshot: true, includeMessages: false, onResult, assertCurrent: () => {} });
    await expect(read()).rejects.toBeInstanceOf(SessionPartsInvalidResponseError);
    expect(onResult).not.toHaveBeenCalled();
    mismatched = false;
    expect((await read()).get('requested-session')?.detail).toMatchObject({ status: 200,
        body: { session: { id: 'requested-session' } } });
    expect(request).toHaveBeenCalledTimes(2);
});

it.each([404, 403] as const)('classifies a whole batch %s without issuing scalar reads', async status => {
    const request = vi.fn(async () => Response.json({ error: 'not_found' }, { status }));
    const authority = fixtureAuthority(request);
    const failed = await readSessionBatchForAuthority({ authority, sessionIds: ['a'], includeSnapshot: true,
        includeMessages: false, assertCurrent: () => {} }).catch((error: unknown) => error);
    expect(failed).toMatchObject({ httpStatus: status, ...(status === 404 ? {
        updateRequired: { kind: 'update_required', operation: 'session.detail', component: 'server', reason: 'session_read_batch_unsupported' },
    } : {}) });
    if (status === 403) expect(failed).toMatchObject({ updateRequired: undefined });
    expect(request).toHaveBeenCalledTimes(1);
});

it('gathers overlapping authoritative Session demands in one HTTP batch and rereads after settlement', async () => {
    const request = vi.fn(async (_path: string, init?: RequestInit) => responseFor(init));
    const authority = fixtureAuthority(request);
    const read = (sessionIds: string[]) => readSessionBatchForAuthority({ authority, sessionIds,
        includeSnapshot: true, includeMessages: false, assertCurrent: () => {} });
    const [first, second] = await Promise.all([read(['a', 'b']), read(['b', 'c'])]);
    expect([...first.keys()]).toEqual(['a', 'b']);
    expect([...second.keys()]).toEqual(['b', 'c']);
    expect(request).toHaveBeenCalledTimes(1);
    expect(SessionReadBatchRequestV1Schema.parse(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).sessionIds).toEqual(['a', 'b', 'c']);
    await read(['b']);
    expect(request).toHaveBeenCalledTimes(2);
});

it('keeps exact managed-subtree proof separate by root and rereads after a target is detached', async () => {
    let attached = true;
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
        const input = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
        return attached && input.underSessionId === 'lead' ? responseFor(init)
            : Response.json({ results: input.sessionIds.map(sessionId => ({ sessionId,
                detail: { status: 404, body: { error: 'not_found' } } })) });
    });
    const authority = fixtureAuthority(request);
    const read = (underSessionId: string) => readSessionBatchForAuthority({ authority, sessionIds: ['child'],
        underSessionId, includeSnapshot: true, includeTurns: false, includeMessages: false, assertCurrent: () => {} });
    const [owner, other] = await Promise.all([read('lead'), read('other')]);
    expect(owner.get('child')?.detail?.status).toBe(200);
    expect(other.get('child')?.detail?.status).toBe(404);
    attached = false;
    expect((await read('lead')).get('child')?.detail?.status).toBe(404);
    expect(request).toHaveBeenCalledTimes(3);
});

it('attributes real exact and collection admission before the queue and separates repeated demand from physical requests', async () => {
    const physical = countTransportRequests(async (_path: string, init?: RequestInit) => responseFor(init), path => path);
    const authority = fixtureAuthority(physical.request);
    const exactBorrowers = countReadBorrowers(sessionPartsRead.readSessionParts, params => params.sessionIds);
    const collectionBorrowers = countReadBorrowers(sessionPartsRead.readSessionBatchForAuthority, params => params.sessionIds);
    // Observe the real public entrypoints without replacing their domain logic.
    vi.spyOn(sessionPartsRead, 'readSessionParts').mockImplementation(exactBorrowers.request);
    vi.spyOn(sessionPartsRead, 'readSessionBatchForAuthority').mockImplementation(collectionBorrowers.request);
    const exact = () => readSessionByIdHttp({ sessionId: 'private-exact', serverId: 'home', token: 'token',
        request: authority.request, readTransport: authority.readTransport, accessProjectionVersion: 1 });
    const exactReads = [exact(), exact()] as const;
    const collection = sessionPartsRead.readSessionBatchForAuthority({ authority, sessionIds: ['private-exact', 'private-other'],
        includeSnapshot: true, includeTurns: false, includeMessages: false, accessProjectionVersion: 1, assertCurrent: () => {} });
    // Logical provenance exists synchronously; dispatch has not run yet.
    expect(physical.read()).toEqual({});
    expect(exactBorrowers.read().reduce((count, borrower) => count + borrower.calls, 0)).toBe(2);
    expect(collectionBorrowers.read().reduce((count, borrower) => count + borrower.idCount, 0)).toBe(2);
    const [first, second, rows] = await Promise.all([...exactReads, collection] as const);
    expect(first).toMatchObject({ ok: true, body: { session: { id: 'private-exact' } } });
    expect(second).toEqual(first);
    expect([...rows.keys()]).toEqual(['private-exact', 'private-other']);
    expect(physical.read()).toEqual({ '/v2/sessions/read-batch': 1 });
    await expect(exact()).resolves.toMatchObject({ ok: true });
    expect(physical.read()).toEqual({ '/v2/sessions/read-batch': 2 });
    const attribution = exactBorrowers.read();
    expect(attribution.reduce((count, borrower) => count + borrower.calls, 0)).toBe(3);
    expect(attribution.reduce((count, borrower) => count + borrower.idCount, 0)).toBe(3);
    expect(attribution.every(borrower => borrower.provenance[0]?.source === 'apps/ui/sources/sync/engine/sessions/sessionByIdHttp.ts'
        && borrower.provenance[0].method?.endsWith('readSessionByIdHttp'))).toBe(true);
    expect(JSON.stringify([...attribution, ...collectionBorrowers.read()])).not.toMatch(/private-exact|private-other/);
});

it('merges exact detail entrypoints and context collections at the same neutral Session parts owner', async () => {
    const request = vi.fn(async (path: string, init?: RequestInit) => path === '/v2/sessions/read-batch'
        ? responseFor(init) : Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: path.split('/').at(-1)!.split('?')[0]! }) }));
    const authority = fixtureAuthority(request);
    const exact = (sessionId: string) => readSessionByIdHttp({ sessionId, serverId: 'home', token: 'token',
        request: authority.request, readTransport: authority.readTransport, accessProjectionVersion: 1 });
    const [a, b, contexts] = await Promise.all([exact('a'), exact('b'), readSessionBatchForAuthority({ authority,
        sessionIds: ['b', 'c'], includeSnapshot: true, includeTurns: false, includeMessages: false,
        accessProjectionVersion: 1, assertCurrent: () => {} })]);
    expect(a).toMatchObject({ ok: true, body: { session: { id: 'a' } } });
    expect(b).toMatchObject({ ok: true, body: { session: { id: 'b' } } });
    expect([...contexts.keys()]).toEqual(['b', 'c']);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('/v2/sessions/read-batch');
    expect(SessionReadBatchRequestV1Schema.parse(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).sessionIds).toEqual(['a', 'b', 'c']);
});

it('acquires an exact full snapshot with its turns from the same batch as a full collection', async () => {
    const request = vi.fn(async (_path: string, init?: RequestInit) => responseFor(init));
    const authority = fixtureAuthority(request);
    const [exact, collection] = await Promise.all([
        readSessionByIdHttp({ sessionId: 'a', serverId: 'home', token: 'token', request: authority.request,
            readTransport: authority.readTransport, projection: 'snapshot' }),
        readSessionBatchForAuthority({ authority, sessionIds: ['a', 'b'], includeSnapshot: true,
            includeMessages: false, assertCurrent: () => {} }),
    ]);
    expect(exact.turns).toEqual(collection.get('a')?.turns);
    expect(exact.turns).toMatchObject({ status: 200, body: { sessionId: 'a', turns: [] } });
    expect(request).toHaveBeenCalledTimes(1);
});

it('fences one retired borrower without rejecting another current borrower of its overlapping batch', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const request = vi.fn(async (_path: string, init?: RequestInit) => { await held; return responseFor(init); });
    const authority = fixtureAuthority(request);
    let firstCurrent = true;
    const first = readSessionBatchForAuthority({ authority, sessionIds: ['a', 'b'], includeSnapshot: true,
        includeMessages: false, assertCurrent: () => { if (!firstCurrent) throw new Error('retired'); } })
        .then(() => 'disclosed', () => 'retired');
    const second = readSessionBatchForAuthority({ authority, sessionIds: ['b', 'c'], includeSnapshot: true,
        includeMessages: false, assertCurrent: () => {} });
    await vi.waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(0));
    firstCurrent = false;
    release();
    await expect(first).resolves.toBe('retired');
    expect([...(await second).keys()]).toEqual(['b', 'c']);
    expect(request).toHaveBeenCalledTimes(1);
});

it('detaches a cancelled overlap while retaining typed per-record refusals for a surviving borrower', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let physicalSignal: AbortSignal | null | undefined;
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
        physicalSignal = init?.signal;
        await held;
        const body = SessionReadBatchResponseV1Schema.parse(await responseFor(init).json());
        return Response.json({ results: body.results.map(row => row.sessionId === 'denied'
            ? { sessionId: row.sessionId, detail: { status: 403, body: { error: 'credential_scope_denied' } } } : row) });
    });
    const authority = fixtureAuthority(request);
    const abort = new AbortController();
    const cancelled = readSessionBatchForAuthority({ authority, sessionIds: ['a', 'shared'], includeSnapshot: true,
        includeMessages: false, signal: abort.signal, assertCurrent: () => {} }).catch(() => 'cancelled');
    const survivor = readSessionBatchForAuthority({ authority, sessionIds: ['shared', 'denied'], includeSnapshot: true,
        includeMessages: false, assertCurrent: () => {} });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    abort.abort();
    await expect(cancelled).resolves.toBe('cancelled');
    expect(physicalSignal?.aborted).toBe(false);
    release();
    const results = await survivor;
    expect(results.get('shared')?.detail?.status).toBe(200);
    expect(results.get('denied')).toEqual({ sessionId: 'denied', detail: { status: 403, body: { error: 'credential_scope_denied' } } });
});

it('keeps required turns and fresh witnesses distinct and recovers after a whole-batch refusal', async () => {
    const request = vi.fn(async (_path: string, init?: RequestInit) => responseFor(init));
    const authority = fixtureAuthority(request);
    const base = { authority, sessionIds: ['same'], includeSnapshot: true, includeMessages: false, assertCurrent: () => {} };
    await Promise.all([readSessionBatchForAuthority({ ...base, includeTurns: false }), readSessionBatchForAuthority(base),
        readSessionBatchForAuthority({ ...base, fresh: true })]);
    expect(request).toHaveBeenCalledTimes(3);
    request.mockImplementationOnce(async () => Response.json({ error: 'account_unavailable' }, { status: 503 }));
    await expect(readSessionBatchForAuthority(base)).rejects.toMatchObject({ httpStatus: 503, body: { error: 'account_unavailable' } });
    expect((await readSessionBatchForAuthority(base)).get('same')?.turns?.status).toBe(200);
    await expect(readSessionBatchForAuthority({ ...base, includeSnapshot: false, includeTurns: true,
        includeMessages: true })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(5);
});
