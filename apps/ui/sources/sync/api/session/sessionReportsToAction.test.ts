import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCreationKeyV1Schema } from '@happier-dev/protocol';

const machineRpc = vi.hoisted(() => vi.fn());
// The exact daemon is a remote boundary; creation and source-key adapters stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpc,
}));

// Load the real UI graph once during collection, not inside each test's runtime budget.
// Persistence captures its adapter on first use, so give that adapter a test-only scope.
vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `reports-to-bootstrap-${crypto.randomUUID()}`);
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { upsertServerProfile, resetServerProfilesRuntimeForTests } = await import('@/sync/domains/server/serverProfiles');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { setRuntimeFetch, resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createSessionReportsToAction } = await import('./sessionReportsToAction');
const { loadSessionReportsToEligibility } = await import('@/sync/ops/relations/sessionReportsToEligibility');
const { dispatchSessionSpawnNewWithReportsToPreparation } = await import('@/sync/ops/actions/sessionSpawnNewAction');

let testHomeId: string | null = null;

afterEach(async () => {
    try {
        // The retirement case writes through the real credential owner, including its cache.
        if (testHomeId) await TokenStorage.removeCredentialsForServerUrl('https://reports.example', { serverId: testHomeId });
    } finally {
        resetRuntimeFetch();
        getPersistenceStorage().clearAll();
        storage.setState(storage.getInitialState(), true);
        resetServerProfilesRuntimeForTests();
        testHomeId = null;
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        machineRpc.mockReset();
    }
});

async function setup() {
    vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `reports-to-${crypto.randomUUID()}`);
    // Reset only the owner caches; each case gets fresh scoped profile persistence.
    resetServerProfilesRuntimeForTests();
    const active = await upsertAndActivateServer({ serverUrl: 'https://active.example', name: 'Active' });
    const home = await upsertServerProfile({ serverUrl: 'https://reports.example', name: 'Reports' });
    testHomeId = home.id;
    storage.getState().activateProfileScope({ serverId: active.id, accountId: 'account' });
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    // Persistent credentials and HTTP are the only replaced system boundaries.
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
    const request = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ ok: true, sessionId: 'child/id', leadSessionId: 'lead', attachedAt: 1 }), { status: 200 }));
    setRuntimeFetch(async (url, init) => new URL(String(url)).pathname === '/v1/auth/ping'
        ? new Response('{}', { status: 200 }) : request(String(url), init));
    const account = await captureLazyActionAccountContext(home.id);
    return { home, account, request, TokenStorage, token, execute: createSessionReportsToAction(account) };
}

const input = { sessionId: 'child/id', leadSessionId: 'lead', expectedLeadSessionId: null };
const context = { surface: 'ui', authority: 'present_user' } as const;

describe('reportsTo captured Home Action transport', () => {
    it('loads one qualified read-only eligibility batch and retires it with the captured credential', async () => {
        const env = await setup();
        try {
            const projection = { sessionId: input.sessionId, currentLeadSessionId: null, candidates: [
                { sessionId: 'lead', allowed: false, reason: 'pairwise' },
            ] };
            env.request.mockResolvedValue(new Response(JSON.stringify(projection), { status: 200 }));
            const evidence = await loadSessionReportsToEligibility({ serverId: env.home.id, sessionId: input.sessionId,
                candidateSessionIds: ['lead', 'lead'] });
            expect(evidence).toMatchObject({ ...projection, serverId: env.home.id, accountId: 'account' });
            expect(evidence?.isCurrent()).toBe(true);
            const call = env.request.mock.calls.find(([url]) => url.endsWith('/reports-to/options'));
            expect(JSON.parse(String(call?.[1]?.body))).toEqual({ candidateSessionIds: ['lead'] });
            await TokenStorage.removeCredentialsForServerUrl('https://reports.example', { serverId: env.home.id });
            expect(evidence?.isCurrent()).toBe(false);
            evidence?.dispose();
        } finally { env.account.dispose(); }
    });

    it('withholds unavailable or mismatched eligibility instead of inventing a refusal', async () => {
        const env = await setup();
        try {
            for (const response of [
                new Response('{}', { status: 404 }),
                new Response(JSON.stringify({ sessionId: 'foreign', currentLeadSessionId: null, candidates: [] }), { status: 200 }),
                new Response(JSON.stringify({ sessionId: input.sessionId, currentLeadSessionId: null, candidates: [] }), { status: 200 }),
            ]) {
                env.request.mockResolvedValue(response);
                expect(await loadSessionReportsToEligibility({ serverId: env.home.id, sessionId: input.sessionId,
                    candidateSessionIds: ['lead'] })).toBeNull();
            }
        } finally { env.account.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('prepares a spawn-time reportsTo attachment from the real %s scoped source reader', async (encryptionMode) => {
        const env = await setup();
        const committed = { type: 'success', disposition: 'created', sessionId: input.sessionId,
            executionTarget: { serverId: env.home.id, machineId: 'creator-machine' },
            organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
        try {
            machineRpc.mockResolvedValue(committed);
            env.request.mockImplementation(async () => new Response(JSON.stringify({ session: {
                id: input.sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
                archivedAt: null, metadata: '{}', metadataVersion: 1, agentState: null,
                agentStateVersion: 0, pendingCount: 0, pendingVersion: 0, dataEncryptionKey: null, encryptionMode,
            } }), { status: 200 }));
            const result = await dispatchSessionSpawnNewWithReportsToPreparation({ payload: {
                creationKey: SessionCreationKeyV1Schema.parse('child-create'), executionTarget: committed.executionTarget,
                directory: { kind: 'path', path: '/repo' }, reportsTo: { sessionId: input.leadSessionId },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            } });
            expect(result).toEqual(encryptionMode === 'plain' ? committed : {
                ok: false, errorCode: 'session_follow_source_key_preparation_waiting',
                error: 'session_follow_source_key_preparation_waiting', details: {
                    status: 'waiting', reason: 'source_key_unavailable', edgeCommitted: true, source: committed,
                },
            });
            expect(env.request.mock.calls.some(([url]) => new URL(url).pathname === '/v2/sessions/child%2Fid')).toBe(true);
        } finally { env.account.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('prepares the committed attachment from the real %s source reader without inventing Account keys', async (encryptionMode) => {
        const env = await setup();
        const committed = { ok: true, sessionId: input.sessionId, leadSessionId: input.leadSessionId, attachedAt: 1 };
        try {
            env.request.mockImplementation(async (url) => new Response(JSON.stringify(
                new URL(url).pathname.includes('/reports-to') ? committed : { session: {
                    id: input.sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
                    archivedAt: null, metadata: '{}', metadataVersion: 1, agentState: null,
                    agentStateVersion: 0, pendingCount: 0, pendingVersion: 0, dataEncryptionKey: null,
                    encryptionMode,
                } },
            ), { status: 200 }));
            const result = await env.execute({ ...input, context, serverId: env.home.id });
            expect(result).toEqual(encryptionMode === 'plain' ? committed : {
                ok: false, errorCode: 'session_follow_source_key_preparation_waiting',
                error: 'session_follow_source_key_preparation_waiting', details: {
                    status: 'waiting', reason: 'source_key_unavailable', edgeCommitted: true, source: committed,
                },
            });
            expect(env.request.mock.calls.some(([url]) => new URL(url).pathname === '/v2/sessions/child%2Fid')).toBe(true);
        } finally { env.account.dispose(); }
    });

    it('detaches without requesting source material', async () => {
        const env = await setup();
        const detached = { ok: true, sessionId: input.sessionId, leadSessionId: null, attachedAt: null };
        try {
            env.request.mockResolvedValue(new Response(JSON.stringify(detached), { status: 200 }));
            await expect(env.execute({ ...input, leadSessionId: null, expectedLeadSessionId: input.leadSessionId, context, serverId: env.home.id })).resolves.toEqual(detached);
            expect(env.request.mock.calls.every(([url]) => new URL(url).pathname.includes('/reports-to'))).toBe(true);
        } finally { env.account.dispose(); }
    });

    it('keeps the captured Home when focus changes and preserves a typed CAS refusal', async () => {
        const env = await setup();
        try {
            await upsertAndActivateServer({ serverUrl: 'https://other.example', name: 'Other' });
            env.request.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'reports_to_cas_conflict' }), { status: 409 }));
            await expect(env.execute({ ...input, context, serverId: env.home.id })).resolves.toEqual({ ok: false, error: 'reports_to_cas_conflict' });
            const call = env.request.mock.calls.find(([url]) => url.includes('/reports-to'));
            expect(call?.[0]).toBe('https://reports.example/v1/sessions/child%2Fid/reports-to');
            expect(JSON.parse(String(call?.[1]?.body))).toEqual({ leadSessionId: 'lead', expectedLeadSessionId: null });
        } finally { env.account.dispose(); }
    });

    it('rejects a foreign attachment response and a mismatched Home before dispatch', async () => {
        const env = await setup();
        try {
            env.request.mockResolvedValue(new Response(JSON.stringify({ ok: true, sessionId: 'other', leadSessionId: 'lead', attachedAt: 1 }), { status: 200 }));
            await expect(env.execute({ ...input, context, serverId: env.home.id })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
            env.request.mockClear();
            await expect(env.execute({ ...input, context, serverId: 'different-home' })).resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
            expect(env.request.mock.calls).toEqual([]);
        } finally { env.account.dispose(); }
    });

    it('does not publish a response after the captured credential retires', async () => {
        const env = await setup();
        try {
            env.request.mockImplementation(async () => {
                await env.TokenStorage.setCredentialsForServerUrl('https://reports.example', { serverId: env.home.id }, { token: `${env.token}-rotated` });
                return new Response(JSON.stringify({ ok: true, sessionId: input.sessionId, leadSessionId: input.leadSessionId, attachedAt: 1 }), { status: 200 });
            });
            await expect(env.execute({ ...input, context, serverId: env.home.id })).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        } finally { env.account.dispose(); }
    });
});
