import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createDeferred } from '@/dev/testkit';
import { storage as syncStorage } from '@/sync/domains/state/storage';
import { fetchAndApplyMachines } from '@/sync/engine/machines/syncMachines';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { readSessionByIdHttp, resetSessionByIdHttpReadsForTests } from '@/sync/engine/sessions/sessionByIdHttp';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { StaleServerGenerationError } from '@/sync/http/client';
import { apiSocket } from './apiSocket';

installTokenStorageWebPlatformMocks();
vi.mock('socket.io-client', async () => {
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: () => createSocketIoBoundaryStub().socket };
});

const oldToken = `e30.${Buffer.from(JSON.stringify({ sub: 'session-account' })).toString('base64url')}.signature`;
const newToken = oldToken.replace(/signature$/, 'renewed-signature');
const endpoint = 'https://session-recovery.example.test';
let storage: ReturnType<typeof installLocalStorageMock>;
let locks: ReturnType<typeof installWebLockManagerMock>;

beforeEach(async () => {
    storage = installLocalStorageMock();
    locks = installWebLockManagerMock();
    setRuntimeFetch(async () => Response.json({}));
    await upsertAndActivateServer({ serverUrl: endpoint, name: 'Session recovery' });
    await TokenStorage.setCredentials({ token: oldToken });
});
afterEach(async () => {
    apiSocket.disconnect();
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
    await stopAllEndpointSupervisorsForTests();
    resetSessionByIdHttpReadsForTests();
    resetRuntimeFetch();
    locks.restore();
    storage.restore();
    vi.restoreAllMocks();
});

function prepare() {
    const snapshot = getActiveServerSnapshot();
    const target = { endpoint, serverId: snapshot.serverId, generation: snapshot.generation };
    apiSocket.initialize({ ...target, token: oldToken, credentials: { token: oldToken } }, null);
    const request = apiSocket.createRequestForPreparedTarget(target);
    const readTransport = apiSocket.createReadTransportForPreparedTarget(target);
    if (!readTransport) throw new Error('Expected an installed prepared read transport');
    return { target, request, readTransport };
}

it('does not publish a retired Machine census as an unavailable Home and settles its replacement', async () => {
    const initialState = syncStorage.getState();
    const retired = prepare();
    const replacement = prepare();
    const serverId = replacement.target.serverId;
    const row = createPlainMachineRowFixture({ id: 'restored-machine', accountId: 'session-account' });
    setRuntimeFetch(async input => new URL(String(input)).pathname === '/v1/machines'
        ? Response.json([row]) : Response.json({}));
    syncStorage.setState({ machines: {}, machineListByServerId: {}, machineListStatusByServerId: { [serverId]: 'loading' } });
    const params = {
        credentials: { token: oldToken },
        encryption: null,
        expectedAccountMode: 'plain' as const,
        machineDataKeys: new Map(),
        sourceServerId: serverId,
        throwOnError: true,
        applyMachines: (machines: Parameters<typeof initialState.applyMachines>[0], replace: boolean) =>
            syncStorage.getState().applyMachines(machines, replace, { sourceServerId: serverId }),
        onListComplete: () => syncStorage.getState().markMachineListSettled(serverId),
        onListUnavailable: () => syncStorage.getState().markMachineListUnavailable(serverId),
    };
    try {
        await fetchAndApplyMachines({ ...params, readTransport: retired.readTransport }).catch(error => {
            if (!(error instanceof StaleServerGenerationError)) throw error;
        });
        expect(syncStorage.getState().machineListStatusByServerId[serverId]).toBe('loading');
        await fetchAndApplyMachines({ ...params, readTransport: replacement.readTransport });
        expect(syncStorage.getState().machineListStatusByServerId[serverId]).toBe('idle');
        expect(syncStorage.getState().machines[row.id]?.availability?.kind).toBe('available');
        setRuntimeFetch(async input => new URL(String(input)).pathname === '/v1/machines'
            ? Response.json({ error: 'invalid_request' }, { status: 400 }) : Response.json({}));
        await expect(fetchAndApplyMachines({ ...params, readTransport: replacement.readTransport }))
            .rejects.toBeInstanceOf(Error);
        expect(syncStorage.getState().machineListStatusByServerId[serverId]).toBe('error');
    } finally {
        syncStorage.setState(initialState, true);
    }
});

function parts(init?: RequestInit) {
    const demand = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
    return Response.json({ results: demand.sessionIds.map(sessionId => ({ sessionId,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }) } },
        ...(demand.includeTurns !== false ? { turns: { status: 200, body: { v: 1, sessionId, updatedAt: 1, turns: [] } } } : {}),
    })) });
}

it.each([
    { method: 'GET', path: '/v2/sessions/session', body: undefined },
    { method: 'POST', path: '/v2/sessions/read-batch', body: { sessionIds: ['session'], includeSnapshot: true, includeTurns: false } },
    { method: 'POST', path: '/v1/artifacts/read', body: { artifactIds: ['artifact'] } },
    { method: 'POST', path: '/v1/machines/read-batch', body: { machineIds: ['machine'] } },
] as const)('recovers a prepared $method $path read once after a 401 and retains the replacement bearer without user interaction', async ({ method, path, body }) => {
    const authorizations: Array<string | null> = [];
    const init = { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) };
    setRuntimeFetch(async (input, init) => {
        if (new URL(String(input)).pathname !== path) return Response.json({});
        authorizations.push(new Headers(init?.headers).get('Authorization'));
        if (authorizations.length === 1) {
            await TokenStorage.setCredentials({ token: newToken });
            return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        if (path === '/v2/sessions/read-batch') return parts(init);
        if (method === 'GET') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'session' }) });
        return path === '/v1/artifacts/read'
            ? Response.json({ items: [{ artifactId: 'artifact', ok: false, error: 'artifact_not_found', status: 404, retryable: false }] })
            : Response.json({ results: [{ machineId: 'machine', status: 'not_found' }] });
    });
    const binding = prepare();
    if (path === '/v2/sessions/read-batch') {
        await expect(readSessionByIdHttp({ ...binding, sessionId: 'session', token: oldToken, retry: 'none' }))
            .resolves.toMatchObject({ ok: true, body: { session: { id: 'session' } } });
    } else {
        await expect(binding.request(path, init, { retry: 'none' }, async (response) => ({ status: response.status, body: await response.json() })))
            .resolves.toMatchObject({ status: 200, body: method === 'GET' ? { session: { id: 'session' } }
                : path === '/v1/artifacts/read' ? { items: [{ artifactId: 'artifact' }] } : { results: [{ machineId: 'machine' }] } });
    }
    expect(authorizations).toEqual([`Bearer ${oldToken}`, `Bearer ${newToken}`]);
    expect(await TokenStorage.getCredentials()).toEqual({ token: newToken });
    await expect(apiSocket.request(path, init, { retry: 'none' }))
        .resolves.toHaveProperty('status', 200);
    expect(authorizations.at(-1)).toBe(`Bearer ${newToken}`);
});

it('does not lend an incumbent pending Session read to an identical-fields reinitialized prepared configuration', async () => {
    const issued = createDeferred<void>();
    const release = createDeferred<void>();
    let reads = 0;
    setRuntimeFetch(async (input, init) => {
        if (new URL(String(input)).pathname !== '/v2/sessions/read-batch') return Response.json({});
        reads += 1;
        if (reads === 1) { issued.resolve(); await release.promise; }
        return parts(init);
    });
    const firstBinding = prepare();
    const first = readSessionByIdHttp({ ...firstBinding, sessionId: 'session', token: oldToken, retry: 'none' })
        .then(() => 'disclosed', () => 'retired');
    await issued.promise;
    const nextBinding = prepare();
    const next = readSessionByIdHttp({ ...nextBinding, sessionId: 'session', token: oldToken, retry: 'none' })
        .catch(error => ({ error }));
    try {
        await vi.waitFor(() => expect(reads).toBe(2));
    } finally { release.resolve(); await Promise.all([first, next]); }
    await expect(first).resolves.toBe('retired');
    await expect(next).resolves.toMatchObject({ ok: true, body: { session: { id: 'session' } } });
});

it('admits its own recovered response but refuses later dispatch from the old credential capture when no socket is installed', async () => {
    let reads = 0;
    setRuntimeFetch(async (input) => {
        if (new URL(String(input)).pathname !== '/v2/sessions/session') return Response.json({});
        reads += 1;
        if (reads === 1) {
            await TokenStorage.setCredentials({ token: newToken });
            return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'session' }) });
    });
    const binding = prepare();
    const consume = async (response: Response): Promise<unknown> => await response.json();
    await expect(binding.readTransport.read('/v2/sessions/session', { method: 'GET' }, { retry: 'none' }, consume))
        .resolves.toMatchObject({ session: { id: 'session' } });
    expect(reads).toBe(2);
    await expect(binding.readTransport.read('/v2/sessions/session', { method: 'GET' }, { retry: 'none' }, consume))
        .rejects.toMatchObject({ name: 'StaleServerGenerationError' });
    expect(reads).toBe(2);
    await expect(apiSocket.request('/v2/sessions/session', { method: 'GET' }, { retry: 'none' }, consume))
        .resolves.toMatchObject({ session: { id: 'session' } });
    expect(reads).toBe(3);
});

it('uses the installed incumbent origin for a logical active read and refuses a mismatched basis before issuing HTTP', async () => {
    const snapshot = getActiveServerSnapshot();
    const target = { endpoint, serverId: snapshot.serverId, generation: snapshot.generation };
    const incumbentOrigin = 'http://127.0.0.1:47231';
    apiSocket.initialize({ ...target, runtimeOrigin: incumbentOrigin, carrier: 'iroh',
        token: oldToken, credentials: { token: oldToken } }, null);
    const reads: string[] = [];
    setRuntimeFetch(async input => {
        if (new URL(String(input)).pathname !== '/v2/sessions/session') return Response.json({});
        reads.push(String(input));
        return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'session' }) });
    });
    const transport = apiSocket.createReadTransportForActiveServer(target);
    if (!transport) throw new Error('Expected the installed active read transport');
    await expect(transport.read('/v2/sessions/session', { method: 'GET' }, { retry: 'none' }, async response => await response.json()))
        .resolves.toMatchObject({ session: { id: 'session' } });
    expect(reads).toEqual([`${incumbentOrigin}/v2/sessions/session`]);
    for (const mismatch of [
        { ...target, serverId: 'another-home' },
        { ...target, generation: target.generation + 1 },
        { ...target, endpoint: 'https://another-home.example.test' },
    ]) {
        expect(() => apiSocket.createReadTransportForActiveServer(mismatch)).toThrow(StaleServerGenerationError);
    }
    expect(reads).toHaveLength(1);
});
