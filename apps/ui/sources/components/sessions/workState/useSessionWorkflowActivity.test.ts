import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeaturesResponseSchema, projectSessionAccessCapabilitiesV1, type SessionWorkflowRunSnapshotV1 } from '@happier-dev/protocol';

import {
    createDeferred,
    makeSessionWorkflowActivityMetadata,
    makeSessionWorkflowRunHeadline,
    makeSessionWorkflowRunSnapshot,
    renderHook,
} from '@/dev/testkit';

import { installLocalStorageMock, type LocalStorageMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';

// Device storage and network are the only substituted owners; workflow, crypto
// projection, Session hydration, scope lifetime and repository logic remain real.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { return kvStore.get(key); }
    set(key: string, value: string) { kvStore.set(key, value); }
    delete(key: string) { kvStore.delete(key); }
    getAllKeys() { return [...kvStore.keys()]; }
    clearAll() { kvStore.clear(); }
} }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' }, AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) } });
});
const fetchWorkflowRunSnapshot = vi.fn<(params: { sessionId: string; runId: string }) => Promise<SessionWorkflowRunSnapshotV1 | null>>();
const network = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>());
// Adapt Metro's lazy require to Vitest's module loader; return the real singleton.
const runtimeModule = vi.hoisted(() => ({ sync: null as typeof import('@/sync/sync').sync | null }));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({ getSyncSingleton: () => {
    if (!runtimeModule.sync) throw new Error('Real sync singleton must be loaded before rendering');
    return runtimeModule.sync;
} }));
vi.mock('@/sync/api/session/apiSocket', () => ({ apiSocket: {
    onMessage: vi.fn(), onError: vi.fn(), onReconnected: vi.fn(),
    onStatusChange: vi.fn(() => () => {}), onConnectionStateChange: vi.fn(() => () => {}),
    connect: vi.fn(), disconnect: vi.fn(), initialize: vi.fn(), invalidateRequests: vi.fn(), request: (path: string, init?: RequestInit) => network(`https://workflow.example${path}`, init),
} }));
let localStorage: LocalStorageMockHandle;
let serverId: string;
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }

const headlineRun = makeSessionWorkflowRunHeadline;
const metadata = makeSessionWorkflowActivityMetadata;

function snapshot(runId: string, over: Partial<SessionWorkflowRunSnapshotV1> = {}): SessionWorkflowRunSnapshotV1 {
    return makeSessionWorkflowRunSnapshot({ runId, title: `Snapshot ${runId}`, ...over });
}

beforeEach(async () => {
    kvStore.clear();
    localStorage = installLocalStorageMock();
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
    const { storage } = await import('@/sync/domains/state/storage');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const { sync } = await import('@/sync/syncEngine');
    runtimeModule.sync = sync;
    (sync as unknown as { resetServerScopedRuntimeState(): void }).resetServerScopedRuntimeState();
    resetServerFeaturesClientForTests();
    const home = await upsertServerProfile({ serverUrl: 'https://workflow.example', name: 'Workflow test' });
    await setActiveServerId(home.id, { scope: 'device' });
    serverId = getActiveServerSnapshot().serverId;
    storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
    await TokenStorage.setCredentials({ token: 'e30.eyJzdWIiOiJhbGljZSJ9.signature' });
    fetchWorkflowRunSnapshot.mockReset();
    fetchWorkflowRunSnapshot.mockImplementation(async ({ runId }) => snapshot(runId));
    network.mockReset();
    network.mockImplementation(async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/v1/auth/ping') return json({ ok: true });
        if (parsed.pathname === '/v1/features') return json(FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, board: { enabled: true } } }, capabilities: { session: { systemRecords: { protocolVersions: [1] } } } }));
        if (parsed.pathname === '/v2/sessions/sess_1') return json({ session: {
            id: 'sess_1', createdAt: 1, updatedAt: 2, seq: 1, active: true, activeAt: 2,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
            encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 1,
            metadata: JSON.stringify({ readStateV1: null }), agentStateVersion: 1, agentState: null, share: null,
        } });
        if (parsed.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 1 });
        if (parsed.pathname === '/v1/account/encryption/currentness') return json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
        if (parsed.pathname === '/v2/account/settings') return json({ content: null, version: 0 });
        if (parsed.pathname.endsWith('/system-records/record')) {
            const localId = parsed.searchParams.get('localId')!;
            const runId = localId.replace(/^activity:workflow_run:v1:/, '');
            const value = await fetchWorkflowRunSnapshot({ sessionId: 'sess_1', runId });
            return json({ record: value ? {
                id: `record-${runId}`, address: { owner: 'host', namespace: 'activity', kind: 'workflow_run.v1', localId },
                content: { t: 'plain', v: value }, revision: value.recordRevision === '2' ? 'ssr1.AAAACHN5c3JlY18xAAAAAg' : 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
                createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
            } : null });
        }
        return json({ error: `Unexpected route ${parsed.pathname}` }, 404);
    });
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => network(String(url), init));
});
afterEach(async () => {
    const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
    await resetServerReachabilitySupervisors();
    localStorage?.restore();
    vi.unstubAllGlobals();
});

async function renderActivity(params: Readonly<{
    metadata: unknown;
    enabled?: boolean;
}>) {
    const { useSessionWorkflowActivity } = await import('./useSessionWorkflowActivity');
    return renderHook(
        (props: { metadata: unknown; enabled?: boolean }) =>
            useSessionWorkflowActivity({ sessionId: 'sess_1', serverId, metadata: props.metadata, enabled: props.enabled }),
        { initialProps: params, flushOptions: { cycles: 40 } },
    );
}

async function renderForToolUseId(params: Readonly<{
    metadata: unknown;
    toolUseId: string | null | undefined;
}>) {
    const { useWorkflowRunForToolUseId } = await import('./useSessionWorkflowActivity');
    return renderHook(
        (props: { metadata: unknown; toolUseId: string | null | undefined }) =>
            useWorkflowRunForToolUseId({ sessionId: 'sess_1', serverId, metadata: props.metadata, toolUseId: props.toolUseId }),
        { initialProps: params, flushOptions: { cycles: 40 } },
    );
}

describe('Board Action Account retirement', () => {
    it('reports the retired Account scope without disclosing its mutation result', async () => {
        const fallback = network.getMockImplementation()!;
        let dispatched = false;
        network.mockImplementation(async (url, init) => {
            const pathname = new URL(url).pathname;
            if (pathname.endsWith('/system-records/record')) return json({ record: null });
            if (pathname.endsWith('/board') && init?.method === 'PUT') {
                dispatched = true;
                const { storage } = await import('@/sync/domains/state/storage');
                storage.getState().activateProfileScope({ serverId, accountId: 'bob' });
                return json({ operation: 'update_layout', outcome: 'updated', layoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' });
            }
            return fallback(url, init);
        });
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor({ resolveServerIdForSessionId: () => serverId });
        const result = await executor.execute('session.board.layout.update', {
            sessionId: 'sess_1', expectedLayoutRevision: null,
            operation: { op: 'tab.create', tabId: 'overview', title: 'Private title' },
        }, { surface: 'ui', serverId, defaultSessionId: 'sess_1' });
        expect(dispatched).toBe(true);
        expect(result).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(JSON.stringify(result)).not.toContain('Private title');
        expect(JSON.stringify(result)).not.toContain('ssr1.');
    });
});

describe('useSessionWorkflowActivity — active workflow refresh continuity', () => {
    it('does not recover missing Home authority from the ambient active Home', async () => {
        const { useSessionWorkflowActivity } = await import('./useSessionWorkflowActivity');
        const hook = await renderHook(
            () => useSessionWorkflowActivity({
                sessionId: 'sess_1',
                metadata: metadata([headlineRun({ runId: 'run_without_home' })]),
            }),
            { flushOptions: { cycles: 40 } },
        );

        expect(hook.getCurrent().runDetailById.get('run_without_home')).toEqual({
            state: 'missing',
            runId: 'run_without_home',
            reason: 'offline',
        });
        expect(fetchWorkflowRunSnapshot).not.toHaveBeenCalled();
    });

    it('selects the provenance-bounded predecessor workflow reader before the read and never fabricates host-V1 authority', async () => {
        const fallback = network.getMockImplementation()!;
        const seenRecordRequests: Array<{ url: URL; headers: Headers }> = [];
        network.mockImplementation(async (url, init) => {
            const parsed = new URL(url);
            if (parsed.pathname === '/v1/features') {
                return json({ error: 'Feature endpoint is unavailable on this predecessor' }, 404);
            }
            if (parsed.pathname.endsWith('/system-records/record')) {
                seenRecordRequests.push({ url: parsed, headers: new Headers(init?.headers) });
                const localId = parsed.searchParams.get('localId')!;
                const runId = localId.replace(/^activity:workflow_run:v1:/, '');
                return json({ record: {
                    id: `legacy-${runId}`,
                    sessionId: 'sess_1',
                    namespace: 'activity',
                    kind: 'workflow_run.v1',
                    localId,
                    content: { t: 'plain', v: snapshot(runId, { title: 'Loaded through predecessor transport' }) },
                    createdAt: '2026-09-05T00:00:00.000Z',
                    updatedAt: '2026-09-05T00:00:00.000Z',
                } });
            }
            return await fallback(url, init);
        });

        const hook = await renderActivity({ metadata: metadata([headlineRun({ runId: 'run_legacy' })]) });

        await vi.waitFor(() => {
            expect(hook.getCurrent().loadedRunsById.get('run_legacy')?.title).toBe('Loaded through predecessor transport');
        });
        expect(seenRecordRequests).toHaveLength(1);
        expect(seenRecordRequests[0].url.searchParams.has('owner')).toBe(false);
        expect(seenRecordRequests[0].headers.has('x-happier-session-system-records-protocol')).toBe(false);
        expect(seenRecordRequests[0].headers.has('x-happier-plugin-id')).toBe(false);
    });

    it('reports unavailable Home authority instead of leaving a workflow loading indefinitely', async () => {
        serverId = '';
        const hook = await renderActivity({ metadata: metadata([headlineRun({ runId: 'run_a' })]) });
        expect(hook.getCurrent().runDetailById.get('run_a')).toEqual({ state: 'missing', runId: 'run_a', reason: 'offline' });
        expect(fetchWorkflowRunSnapshot).not.toHaveBeenCalled();
    });

    it('discards a late workflow read when another Account takes the same Home', async () => {
        const pending = createDeferred<SessionWorkflowRunSnapshotV1 | null>();
        fetchWorkflowRunSnapshot.mockImplementation(() => pending.promise);
        const props = { metadata: metadata([headlineRun({ runId: 'run_late' })]) };
        const hook = await renderActivity(props);
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_late' });
        const { act } = await import('react-test-renderer');
        const { storage } = await import('@/sync/domains/state/storage');
        await act(async () => {
            storage.getState().activateProfileScope({ serverId, accountId: 'bob' });
            (runtimeModule.sync as unknown as { resetServerScopedRuntimeState(): void })
                .resetServerScopedRuntimeState();
            pending.resolve(snapshot('run_late', { title: 'Retired Account private detail' }));
        });
        await hook.rerender(props);
        expect(JSON.stringify([...hook.getCurrent().runDetailById.values()])).not.toContain('Retired Account private detail');
        expect(hook.getCurrent().loadedRunsById.size).toBe(0);
    });

    it('keeps the previous loaded snapshot visible while a newer record revision is refetched', async () => {
        const nextFetch = createDeferred<SessionWorkflowRunSnapshotV1 | null>();
        fetchWorkflowRunSnapshot
            .mockResolvedValueOnce(snapshot('run_a', { title: 'Loaded revision 1', recordRevision: '1' }))
            .mockReturnValueOnce(nextFetch.promise);

        const hook = await renderActivity({
            metadata: metadata([headlineRun({ runId: 'run_a', recordRevision: '1', recordUpdatedAt: 1 })]),
        });
        expect(hook.getCurrent().runDetailById.get('run_a')).toMatchObject({
            state: 'loaded',
            snapshot: expect.objectContaining({ title: 'Loaded revision 1' }),
        });
        const strictRead = network.mock.calls
            .map(([url, init]) => ({ url: new URL(url), headers: new Headers(init?.headers) }))
            .find(({ url }) => url.pathname.endsWith('/system-records/record'));
        expect(strictRead?.url.searchParams.get('owner')).toBe('host');
        expect(strictRead?.headers.get('x-happier-session-system-records-protocol')).toBe('1');
        expect(strictRead?.headers.has('x-happier-plugin-id')).toBe(false);

        await hook.rerender({
            metadata: metadata([headlineRun({ runId: 'run_a', recordRevision: '2', recordUpdatedAt: 2 })]),
        });

        expect(hook.getCurrent().runDetailById.get('run_a')).toMatchObject({
            state: 'loaded',
            snapshot: expect.objectContaining({ title: 'Loaded revision 1' }),
        });
        expect(hook.getCurrent().loadedRunsById.get('run_a')?.title).toBe('Loaded revision 1');

        nextFetch.resolve(snapshot('run_a', { title: 'Loaded revision 2', recordRevision: '2' }));
        await hook.rerender({
            metadata: metadata([headlineRun({ runId: 'run_a', recordRevision: '2', recordUpdatedAt: 2 })]),
        });
        expect(hook.getCurrent().loadedRunsById.get('run_a')?.title).toBe('Loaded revision 2');
    });
});

describe('useWorkflowRunForToolUseId — UIW4 tool-use-id join', () => {
    it('(a) joins by workflowToolUseId even when it differs from runId', async () => {
        const md = metadata([
            headlineRun({ runId: 'run_internal', workflowToolUseId: 'toolu_card' }),
        ]);
        const hook = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_card' });

        expect(hook.getCurrent().runHeadline?.runId).toBe('run_internal');
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_internal' });
        expect(hook.getCurrent().detail).toMatchObject({ state: 'loaded', runId: 'run_internal' });
    });

    it('(b) falls back to runId when no workflowToolUseId matches', async () => {
        const md = metadata([
            headlineRun({ runId: 'toolu_card', workflowToolUseId: 'toolu_other' }),
        ]);
        const hook = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_card' });

        expect(hook.getCurrent().runHeadline?.runId).toBe('toolu_card');
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'toolu_card' });
    });

    it('(c) does NOT resolve the headline primaryRunId when the tool id maps to a non-primary run', async () => {
        const md = metadata(
            [
                headlineRun({ runId: 'run_primary', workflowToolUseId: 'toolu_primary' }),
                headlineRun({ runId: 'run_secondary', workflowToolUseId: 'toolu_secondary' }),
            ],
            { primaryRunId: 'run_primary' },
        );
        const hook = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_secondary' });

        expect(hook.getCurrent().runHeadline?.runId).toBe('run_secondary');
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_secondary' });
        expect(fetchWorkflowRunSnapshot).not.toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_primary' });
    });

    it('(c2) resolves null (not primaryRunId) when no run matches the tool id', async () => {
        const md = metadata(
            [headlineRun({ runId: 'run_primary', workflowToolUseId: 'toolu_primary' })],
            { primaryRunId: 'run_primary' },
        );
        const hook = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_unmatched' });

        expect(hook.getCurrent().runHeadline).toBeNull();
        expect(hook.getCurrent().detail).toBeNull();
        expect(fetchWorkflowRunSnapshot).not.toHaveBeenCalled();
    });

    it('(d) two different tool ids resolve two different runs independently (no cross-pollution)', async () => {
        const md = metadata([
            headlineRun({ runId: 'run_a', workflowToolUseId: 'toolu_a' }),
            headlineRun({ runId: 'run_b', workflowToolUseId: 'toolu_b' }),
        ]);

        const cardA = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_a' });
        const cardB = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_b' });

        expect(cardA.getCurrent().runHeadline?.runId).toBe('run_a');
        expect(cardB.getCurrent().runHeadline?.runId).toBe('run_b');
        expect(cardA.getCurrent().detail).toMatchObject({ state: 'loaded', runId: 'run_a' });
        expect(cardB.getCurrent().detail).toMatchObject({ state: 'loaded', runId: 'run_b' });
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_a' });
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_b' });
    });

    it('(e) matches against a recentRuns (terminal/completed) run, not only activeRuns', async () => {
        const md = metadata(
            [headlineRun({ runId: 'run_active', workflowToolUseId: 'toolu_active' })],
            {
                recentRuns: [
                    headlineRun({ runId: 'run_done', status: 'complete', workflowToolUseId: 'toolu_done' }),
                ],
            },
        );
        const hook = await renderForToolUseId({ metadata: md, toolUseId: 'toolu_done' });

        expect(hook.getCurrent().runHeadline?.runId).toBe('run_done');
        expect(fetchWorkflowRunSnapshot).toHaveBeenCalledWith({ sessionId: 'sess_1', runId: 'run_done' });
        expect(hook.getCurrent().detail).toMatchObject({ state: 'loaded', runId: 'run_done' });
    });
});
