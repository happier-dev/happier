import { cpus, platform, arch } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectLegacySessionAccessCapabilitiesV1,
    SessionListQueryResponseV1Schema,
    type SessionListQueryResponseV1,
    type SessionListQueryV1,
} from '@happier-dev/protocol';

import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { createSessionListQueryHomeController } from '@/sync/domains/session/listing/sessionListQueryController';
import { buildSessionListQueryKey } from '@/sync/domains/session/listing/sessionListQueryKey';
import { storage } from '@/sync/domains/state/storage';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

import { fetchAndApplySessions } from './sessionSnapshot';

const QUERY: SessionListQueryV1 = {
    v: 1, storage: 'active', includeInactive: true, scope: 'my_work',
    attention: 'any', audiences: [], tagIds: [],
};
const initialState = storage.getState();

afterEach(() => {
    vi.useRealTimers();
    storage.setState(initialState, true);
    syncPerformanceTelemetry.configure({ enabled: false });
    syncPerformanceTelemetry.reset();
});

function createOwnerChoicesPage() {
    const rows = Array.from({ length: 6 }, (_, index) => ({
        id: `choice-${index}`, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        archivedAt: null, encryptionMode: 'plain', metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1, summary: { text: `Session ${index}`, updatedAt: 1 } }),
        metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { path: `/private/${index}`, host: 'home' } }),
        share: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) },
        viewer: { readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
            attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
            follow: { follows: false, notificationLevel: 'none' }, notification: { level: 'none', source: 'preference' } },
        responsibleAccountId: null, responsibleAccount: null,
    }));
    return SessionListQueryResponseV1Schema.parse({ sessions: rows, nextCursor: null, hasNext: false,
        attentionNextCursor: null, attentionHasNext: false });
}

it.each([
    { queryMs: 245, currentnessMs: 9216 },
    // Resume 7 resource totals: 5946.4 ms and 3964.8 ms (rounded up to a timer millisecond).
    { queryMs: 5946.4, currentnessMs: 3965 },
])('publishes owner query choices without serializing independent reads ($queryMs / $currentnessMs ms)', async ({ queryMs, currentnessMs }) => {
    // Recorded HTTP latency is the only substitution. Parsing, Account-mode
    // validation, owner projection, snapshot publication and the store are real.
    vi.useFakeTimers();
    const startedAt = Date.now();
    let publishedAt: number | undefined;
    const requests: Array<{ path: string; at: number }> = [];
    const body = createOwnerChoicesPage();
    const pending = fetchAndApplySessions({
        serverId: 'latency-home', credentials: { token: 'latency' }, encryption: null, sessionDataKeys: new Map(),
        source: { kind: 'query', allowV1Fallback: false, body: { ...QUERY, scope: 'all_accessible', includeAttention: false } },
        request: async (path) => {
            requests.push({ path, at: Date.now() - startedAt });
            await new Promise(resolve => setTimeout(resolve, path === '/v2/sessions/query' ? queryMs : currentnessMs));
            return Response.json(path === '/v2/sessions/query' ? body : createPlainAccountEncryptionCurrentnessFixture());
        },
        getExistingSession: () => null,
        applySessionListRenderables: (renderables) => {
            publishedAt = Date.now() - startedAt;
            storage.getState().applyServerScopedSessionListRows('latency-home', renderables, { source: 'rowOnly', mode: 'replace' });
        },
        applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches('latency-home', patches),
        applySessions() {}, log: { log() {} },
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.current).toBe(true);
    const stored = storage.getState().sessionListRowsByServerId['latency-home'];
    expect(Object.keys(stored ?? {})).toHaveLength(6);
    expect(stored?.['choice-0']?.metadata?.path).toBe('/private/0');
    console.info('SESSION_CHOICES_LATENCY_MEASUREMENT', JSON.stringify({ queryMs, currentnessMs, publishedAt, requests }));
    expect(publishedAt).toBeLessThanOrEqual(Math.max(queryMs, currentnessMs));
});

it.each(['unavailable-authority', 'retired-read', 'empty-query'] as const)(
    'keeps the query publication boundary safe for %s', async scenario => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const body = createOwnerChoicesPage();
        const pending = fetchAndApplySessions({
            serverId: 'guard-home', credentials: { token: 'guard' }, encryption: null, sessionDataKeys: new Map(),
            source: { kind: 'query', allowV1Fallback: false, body: { ...QUERY, scope: 'all_accessible', includeAttention: false } },
            signal: controller.signal,
            request: async (path, init) => {
                expect(init.signal).toBe(controller.signal);
                await new Promise(resolve => setTimeout(resolve, path === '/v2/sessions/query' ? 10 : 100));
                if (path === '/v2/sessions/query') return Response.json(scenario === 'empty-query' ? { ...body, sessions: [] } : body);
                return scenario === 'retired-read' ? Response.json(createPlainAccountEncryptionCurrentnessFixture())
                    : Response.json({}, { status: 503 });
            },
            getExistingSession: () => null,
            applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows('guard-home', rows, { source: 'rowOnly', mode: 'replace' }),
            applySessions() {}, log: { log() {} },
        }).then(result => ({ result }), (error: unknown) => ({ error }));
        if (scenario === 'retired-read') {
            await vi.advanceTimersByTimeAsync(20);
            controller.abort();
        }
        await vi.runAllTimersAsync();
        const outcome = await pending;
        if (scenario === 'unavailable-authority') {
            expect(outcome).toMatchObject({ error: { code: 'account-encryption-currentness-unavailable' } });
        } else {
            expect(outcome).toMatchObject({ result: { current: scenario === 'empty-query', sessionIds: scenario === 'empty-query' ? [] : body.sessions.map(row => row.id) } });
        }
        expect(Object.keys(storage.getState().sessionListRowsByServerId['guard-home'] ?? {})).toHaveLength(0);
    },
);

function measurements() {
    return syncPerformanceTelemetry.snapshot().events
        .filter((event) => /decryptDataKeys|initializeSessions|decryptRows|decryptRow$/.test(event.name))
        .map(({ name, count, totalMs, maxMs }) => ({ name, count, totalMs, maxMs }));
}

it('measures real encrypted hydration and rapid query replacement across three fifty-row Homes', async () => {
    // Only HTTP is substituted. The repository Node adapters execute real libsodium
    // envelope opens and WebCrypto AES; this does not measure a native bridge.
    const homes = await Promise.all(Array.from({ length: 3 }, async (_, homeIndex) => {
        const encryption = await Encryption.create(new Uint8Array(32).fill(homeIndex + 1));
        encryption.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const rows = await Promise.all(Array.from({ length: 50 }, async (_, rowIndex): Promise<SessionListQueryResponseV1['sessions'][number]> => {
            const id = `session-${rowIndex}`;
            const key = new Uint8Array(32).fill(rowIndex + 10);
            const cipher = await encryption.openEncryption(key);
            const encrypted = await cipher.encrypt([
                { path: `/workspace/project-${rowIndex % 10}`, host: `home-${homeIndex}`, summary: { text: `Session ${rowIndex}`, updatedAt: 1 } },
                { requests: {}, completedRequests: {} },
            ]);
            return {
                id, seq: 1, createdAt: 1, updatedAt: 2, active: false, activeAt: 2,
                archivedAt: null, encryptionMode: 'e2ee',
                metadata: encodeBase64(encrypted[0]!, 'base64'), metadataVersion: 1,
                agentState: encodeBase64(encrypted[1]!, 'base64'), agentStateVersion: 1,
                dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(key), 'base64'),
                share: null,
                effectiveAccess: {
                    v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                    capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }),
                },
                viewer: {
                    readState: { state: 'not_started' },
                    relevance: { relevant: true, reasons: ['owned_by_me'] },
                    attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                    follow: { follows: false, notificationLevel: 'none' },
                    notification: { level: 'none', source: 'preference' },
                },
                responsibleAccountId: null,
                responsibleAccount: null,
            };
        }));
        // Validate the complete HTTP fixture before either timed workload. Strict
        // queries require current viewer/access/responsibility and both frontiers.
        const queryBody = JSON.stringify(SessionListQueryResponseV1Schema.parse({
            sessions: rows, nextCursor: null, hasNext: false,
            attentionNextCursor: null, attentionHasNext: false,
        }));
        const ordinaryBody = JSON.stringify({ sessions: rows, nextCursor: null, hasNext: false });
        return {
            encryption, serverId: `home-${homeIndex}`,
            sessionDataKeys: new Map<string, Uint8Array>(), sessionDataKeyEnvelopes: new Map<string, string>(),
            request: async (path: string) => new Response(
                path === '/v2/sessions/query' ? queryBody : ordinaryBody,
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        };
    }));

    syncPerformanceTelemetry.configure({ enabled: true });
    syncPerformanceTelemetry.reset();
    const started = performance.now();
    const hydrated = await Promise.all(homes.map(async (home) => {
        const titles: string[] = [];
        await fetchAndApplySessions({
            serverId: home.serverId,
            credentials: { token: 'benchmark', secret: encodeBase64(new Uint8Array(32).fill(1), 'base64') },
            encryption: home.encryption,
            sessionDataKeys: home.sessionDataKeys,
            sessionDataKeyEnvelopes: home.sessionDataKeyEnvelopes,
            request: home.request,
            sessionListHydrationConcurrencyLimit: 4,
            applySessions: (rows) => titles.push(...rows.map((row) => row.metadata?.summary?.text ?? 'unreadable')),
            log: { log() {} },
        });
        expect(titles).toHaveLength(50);
        expect(titles).not.toContain('unreadable');
        return titles.length;
    }));
    const hydrationMs = performance.now() - started;
    const hydration = measurements();
    expect(hydrated.reduce((sum, count) => sum + count, 0)).toBe(150);

    syncPerformanceTelemetry.reset();
    let requests = 0;
    const controllers = homes.map((home) => createSessionListQueryHomeController({
        serverId: home.serverId,
        fetchPage: async ({ source, signal, membership }) => {
            requests += 1;
            return fetchAndApplySessions({
                serverId: home.serverId, source, signal,
                credentials: { token: 'benchmark', secret: encodeBase64(new Uint8Array(32).fill(1), 'base64') },
                encryption: home.encryption,
                sessionDataKeys: home.sessionDataKeys,
                sessionDataKeyEnvelopes: home.sessionDataKeyEnvelopes,
                request: home.request,
                shouldContinue: () => !signal.aborted,
                getExistingSession: () => null,
                getCurrentSessionListRenderable: (sessionId) => (
                    storage.getState().sessionListRowsByServerId[home.serverId]?.[sessionId] ?? null
                ),
                applySessionListRenderables: (rows) => {
                    if (signal.aborted) return;
                    storage.getState().applyServerScopedSessionListRows(home.serverId, rows, {
                        source: membership, mode: 'replace',
                    });
                },
                applySessionListRenderablePatches: (patches) => {
                    if (signal.aborted) return;
                    storage.getState().applyServerScopedSessionListRowPatches(home.serverId, patches);
                },
                // Production query adapters publish scoped rows and patches, never full Sessions.
                applySessions() {},
                log: { log() {} },
            });
        },
    }));
    const rapidStarted = performance.now();
    const pending: Promise<void>[] = [];
    try {
        for (let change = 0; change < 5; change += 1) {
            for (const controller of controllers) {
                pending.push(controller.update({
                    query: { ...QUERY, tagIds: [`tag-${change}`] },
                    selected: true, online: true, supported: true,
                }));
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await Promise.all(pending);
        const rapidQueryMs = performance.now() - rapidStarted;
        // The controller derives corpus identity itself and refuses a caller's, so the
        // settled key is the canonical one for the last requested query — asserted
        // through its owner rather than a literal the controller can never produce.
        const lastQuery: SessionListQueryV1 = { ...QUERY, tagIds: ['tag-4'] };
        for (const home of homes.map((home, index) => ({ home, controller: controllers[index]! }))) {
            expect(home.controller.getSnapshot()).toMatchObject({ phase: 'ready', failureCode: null });
            expect(home.controller.getSnapshot().appliedQueryKey)
                .toBe(buildSessionListQueryKey(home.home.serverId, lastQuery));
            expect(home.controller.getSnapshot().addresses).toHaveLength(50);
            expect(storage.getState().ordinarySessionListMembershipByServerId[home.home.serverId]).toBeUndefined();
        }
        console.info('SESSION_HYDRATION_MEASUREMENT', JSON.stringify({
            platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length,
            homes: 3, rowsPerHome: 50, metadataAndAgentStateCiphertexts: 300,
            crypto: 'real libsodium + WebCrypto AES; native worker off',
            hydrationMs, hydration, rapidChangesPerHome: 5, requests, rapidQueryMs,
            rapidHydration: measurements(),
        }));
    } finally {
        controllers.forEach((controller) => controller.dispose());
        await Promise.allSettled(pending);
    }
}, 60_000);
