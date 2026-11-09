import { afterEach, expect, it } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureUiUsageQueryAccountContext } from '@/sync/api/account/usageQueryResource';
import { projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createOperationAccountCurrentnessSource } from './fetchSessionByIdWithServerScope';
import { runWithServerRequestAuthorityForServerAccountScope } from './createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority, readSessionSnapshotsForAuthority } from './readSessionSnapshotForAuthority';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { prepareSessionPartsRead, readSessionBatchForAuthority, SessionPartsHttpError, SessionPartsInvalidResponseError } from './readSessionBatchForAuthority';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; });

it('shares exact observations across captured transports while fencing a retired borrower independently', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const boundary = createSessionReadBatchHttpBoundary(async request => {
            if (request.path !== '/v2/sessions/captured') return undefined;
            await held;
            return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'captured' }) });
    });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://session-captured.test', accountId: 'account-a' }],
        route: request => boundary.handle(request) });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    const context = captureUiUsageQueryAccountContext(credentials)!;
    let firstCurrent = true;
    const read = (isCurrent: () => boolean) => runWithServerRequestAuthorityForServerAccountScope({
        scope: context.accountLifetime.scope, activeRequest: context.request,
    }, authority => readSessionSnapshotForAuthority({ authority, sessionId: 'captured', isCurrent }));
    const first = read(() => firstCurrent).then(() => 'published', () => 'retired');
    const second = read(() => true);
    await expect.poll(() => home!.requests.filter(request => request.path === '/v2/sessions/read-batch').length).toBeGreaterThan(0);
    firstCurrent = false;
    release();
    await expect(first).resolves.toBe('retired');
    await expect(second).resolves.toMatchObject({ session: { id: 'captured' } });
    expect(home!.requests.filter(request => request.path === '/v2/sessions/read-batch')).toHaveLength(1);
    expect(home!.requests.filter(request => request.method === 'GET' && request.path === '/v2/sessions/captured')).toHaveLength(0);
});

it('gathers overlapping same-authority Session projections across independent consumers without retaining settled observations', async () => {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://session-gather.test', accountId: 'account-a' }],
        route: request => {
            if (request.path !== '/v2/sessions/read-batch') return undefined;
            const { sessionIds } = SessionReadBatchRequestV1Schema.parse(request.body);
            return Response.json({ results: sessionIds.map(sessionId => ({ sessionId,
                detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }) } },
                turns: { status: 200, body: { v: 1, sessionId, updatedAt: 900, turns: [] } },
            })) });
        } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    const context = captureUiUsageQueryAccountContext(credentials)!;
    await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
        const read = (sessionIds: string[]) => readSessionBatchForAuthority({ authority, sessionIds,
            includeSnapshot: true, includeMessages: false, assertCurrent: () => {} });
        const preparing = prepareSessionPartsRead({ request: authority.request, readTransport: authority.readTransport,
            includeSnapshot: true, includeMessages: false, assertCurrent: () => {} });
        const first = read(['first', 'shared']);
        const second = (async () => {
            try {
                for (let depth = 0; depth < 64; depth += 1) await Promise.resolve();
                return await preparing.read(['shared', 'last']);
            } finally { preparing.release(); }
        })();
        const [left, right] = await Promise.all([first, second]);
        expect([...left.keys()]).toEqual(['first', 'shared']);
        expect([...right.keys()]).toEqual(['shared', 'last']);
        const gathered = home!.requests.filter(request => request.path === '/v2/sessions/read-batch');
        expect(gathered).toHaveLength(1);
        expect(SessionReadBatchRequestV1Schema.parse(gathered[0]!.body).sessionIds).toEqual(['first', 'shared', 'last']);
        await read(['shared']);
        expect(home!.requests.filter(request => request.path === '/v2/sessions/read-batch')).toHaveLength(2);
    });
});

it.each([403, 503])('preserves required prefetched turns HTTP %s while optional metadata stays readable', async status => {
    const sessionId = 'required-turns-http';
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://required-turns-http.test', accountId: 'account-a' }],
        route: () => undefined });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    const context = captureUiUsageQueryAccountContext(credentials)!;
    await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
        // These wire parts came from the Usage HTTP boundary. Required interval
        // evidence must preserve their cause when opening the admitted batch.
        const prefetched = new Map([[sessionId, {
            detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }) } },
            turns: { status, body: { error: status === 403 ? 'forbidden' : 'unavailable' } },
        }]]);
        const optional = (await readSessionSnapshotsForAuthority({ authority, sessionIds: [sessionId], prefetched,
            requireTurns: false })).get(sessionId);
        expect(optional).toMatchObject({ ok: true, snapshot: { session: { id: sessionId } } });
        const required = (await readSessionSnapshotsForAuthority({ authority, sessionIds: [sessionId], prefetched,
            requireTurns: true })).get(sessionId);
        expect(required?.ok).toBe(false);
        if (required?.ok === false) {
            expect(required.error).toBeInstanceOf(SessionPartsHttpError);
            expect(required.error).toMatchObject({ httpStatus: status });
        }
    });
});

it.each(['single', 'batch'] as const)('requires admitted turns only for interval demand through %s reads', async transport => {
    let turnsOutcome: 'failed' | 'unavailable' | 'invalid' | 'empty' | 'populated' = 'failed';
    const sessionId = 'retry-turns';
    const boundary = createSessionReadBatchHttpBoundary(request => {
        if (request.path === `/v2/sessions/${sessionId}`) return Response.json({ session:
            createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, seq: 1, updatedAt: 900 }) });
        if (request.path === `/v1/sessions/${sessionId}/turns`) {
            if (turnsOutcome === 'failed') return Response.json({ error: 'unavailable' }, { status: 503 });
            if (turnsOutcome === 'unavailable') return Response.json({ error: 'not_found' }, { status: 404 });
            return Response.json({ v: 1, sessionId: turnsOutcome === 'invalid' ? 'wrong-session' : sessionId, updatedAt: 900,
                turns: turnsOutcome === 'empty' ? [] : [
                    { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 700, updatedAt: 900 },
                ] });
        }
        return undefined;
    });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://required-turns.test', accountId: 'account-a' }],
        route: request => boundary.handle(request) });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    const context = captureUiUsageQueryAccountContext(credentials)!;
    await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
        const currentness = createOperationAccountCurrentnessSource({ credentials, request: authority.request, serverId: authority.scope.serverId });
        const read = async (requireTurns: boolean, includeTurns?: boolean) => {
            if (transport === 'single') return readSessionSnapshotForAuthority({ authority, sessionId, requireTurns, accountCurrentnessSource: currentness });
            const result = (await readSessionSnapshotsForAuthority({ authority, sessionIds: [sessionId], requireTurns, includeTurns, accountCurrentnessSource: currentness })).get(sessionId);
            if (!result?.ok) throw result?.error ?? new Error('Missing batch result');
            return result.snapshot;
        };
        try {
            // Metadata hydration keeps its optional projection even during a turns failure.
            const optional = await read(false);
            expect(optional.session.id).toBe(sessionId);
            expect(optional.session.sessionTurns).toBeUndefined();
            await expect(read(true)).rejects.toMatchObject(transport === 'single'
                ? { name: 'RetryableServerResponseError', status: 503 } : { httpStatus: 503 });
            turnsOutcome = 'unavailable';
            await expect(read(true)).rejects.toMatchObject(transport === 'single'
                ? { errorCode: 'turns_unavailable' } : { httpStatus: 404 });
            turnsOutcome = 'invalid';
            if (transport === 'single') await expect(read(true)).rejects.toMatchObject({ errorCode: 'invalid_response' });
            else await expect(read(true)).rejects.toBeInstanceOf(SessionPartsInvalidResponseError);
            turnsOutcome = 'populated';
            const recovered = await read(true);
            expect(projectSessionUsageWorkEvidence(recovered.session).facts).toMatchObject([
                { evidenceId: 'turn', kind: 'busy', startMs: 100, endMs: 700 },
            ]);
            turnsOutcome = 'empty';
            expect((await read(true)).session.sessionTurns?.turns).toEqual([]);
            if (transport === 'batch') {
                // Metadata consumers omit optional work; interval demand still requires turns.
                expect((await read(false, false)).session.sessionTurns).toBeUndefined();
                expect(SessionReadBatchRequestV1Schema.parse(home!.requests.filter(request => request.path === '/v2/sessions/read-batch').at(-1)!.body).includeTurns).toBe(false);
                expect((await read(true, false)).session.sessionTurns?.turns).toEqual([]);
            }
        } finally { currentness.dispose(); }
    });
});

it.each([false, true])('opens identical single and batch Usage evidence with sharing enabled=%s, quarantining a denied sibling', async sharingEnabled => {
    const ids = ['first', 'second'];
    let duplicateResult = false;
    const detail = (sessionId: string) => ({ session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }) });
    const turns = (sessionId: string) => ({ v: 1, sessionId, updatedAt: 900, turns: [
        { turnId: `${sessionId}-turn`, agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
    ] });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://session-batch.test', accountId: 'account-a' }],
        route: request => {
            if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
                sharing: { session: { enabled: sharingEnabled } },
            } }));
            if (request.path === '/v2/sessions/read-batch') {
                const demand = SessionReadBatchRequestV1Schema.parse(request.body);
                return Response.json({ results: demand.sessionIds.map(sessionId => sessionId === 'denied'
                    ? { sessionId, detail: { status: 404, body: { error: 'Session not found' } } }
                    : { sessionId: duplicateResult ? 'first' : sessionId,
                        detail: { status: 200, body: detail(sessionId) }, turns: { status: 200, body: turns(sessionId) } }) });
            }
            return undefined;
        } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    const context = captureUiUsageQueryAccountContext(credentials)!;
    await getServerFeaturesSnapshot({ serverId: context.accountLifetime.scope.serverId, force: true });
    await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
        const currentness = createOperationAccountCurrentnessSource({ credentials, request: authority.request, serverId: authority.scope.serverId });
        try {
            const abort = new AbortController();
            // Match Hermes' supported AbortSignal surface at the platform boundary.
            Object.defineProperty(abort.signal, 'throwIfAborted', { value: undefined });
            const singles = await Promise.all(ids.map(sessionId => readSessionSnapshotForAuthority({ authority, sessionId, accountCurrentnessSource: currentness })));
            const sessionDataKeys = new Map([...ids, 'denied'].map(id => [id, new Uint8Array(32).fill(71)]));
            const sessionDataKeyEnvelopes = new Map([...ids, 'denied'].map(id => [id, 'previous-envelope']));
            const batch = await readSessionSnapshotsForAuthority({ authority, sessionIds: [...ids, 'denied'], accountCurrentnessSource: currentness,
                sessionDataKeys, sessionDataKeyEnvelopes, signal: abort.signal });
            ids.forEach((id, index) => {
                const result = batch.get(id);
                expect(result).toMatchObject({ ok: true, snapshot: singles[index] });
                if (!result?.ok) throw new Error('Expected admitted batch snapshot');
                expect(projectSessionUsageWorkEvidence(result.snapshot.session)).toEqual(projectSessionUsageWorkEvidence(singles[index]!.session));
            });
            expect(batch.get('denied')).toMatchObject({ ok: false });
            // Admission of plain full tuples retires their old staged encryption
            // material. A failed sibling cannot mutate another Session's keys.
            expect([...sessionDataKeys.keys()]).toEqual(['denied']);
            expect([...sessionDataKeyEnvelopes.keys()]).toEqual(['denied']);
            const batchRequests = home!.requests.filter(request => request.path === '/v2/sessions/read-batch');
            expect(batchRequests).toHaveLength(2);
            expect(batchRequests.every(request => SessionReadBatchRequestV1Schema.parse(request.body).accessProjectionVersion
                === (sharingEnabled ? 1 : undefined))).toBe(true);
            expect(home!.requests.filter(request => request.method === 'GET' && /^\/v2\/sessions\/(first|second)$/.test(request.path))
                ).toHaveLength(0);
            await expect(readSessionSnapshotsForAuthority({ authority, sessionIds: ids, accountCurrentnessSource: currentness,
                isCurrent: () => false })).rejects.toMatchObject({ errorCode: 'stale_response' });
            expect(home!.requests.filter(request => request.path === '/v2/sessions/read-batch')).toHaveLength(2);
            duplicateResult = true;
            await expect(readSessionSnapshotsForAuthority({ authority, sessionIds: [...ids, 'denied'], accountCurrentnessSource: currentness }))
                .rejects.toThrow('Invalid Session batch response');
        } finally { currentness.dispose(); }
    });
});
