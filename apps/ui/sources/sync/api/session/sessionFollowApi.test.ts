import { createSessionListSourceFixture, createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainSessionByIdResponseFixture, createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { SessionAutoFollowPreferencesV1Schema } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetRuntimeFetch();
});

async function setup(secret?: string) {
    vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `follow-${crypto.randomUUID()}`);
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
    const active = await upsertAndActivateServer({ serverUrl: 'https://active.example', name: 'Active' });
    // A selected profile alone is not a published Home lifetime. Apply the
    // real signed-out connection before hydrating its Account projection.
    await switchConnectionToActiveServer();
    const target = await upsertServerProfile({ serverUrl: 'https://target.example', name: 'Target' });
    const { storage } = await import('@/sync/domains/state/storageStore');
    storage.getState().activateProfileScope({ serverId: active.id, accountId: 'active-account' });
    const token = (sub: string) => `e30.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    // Persistent credentials and the network are the only replaced boundaries.
    const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (url) => ({
        token: token(url === 'https://target.example' ? 'target-account' : 'active-account'),
        ...(url === 'https://target.example' && secret ? { secret } : {}),
    }));
    const request = vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => Response.json(
        url.endsWith('/session-follow-rules') ? { rules: [] } : url.endsWith('/session-follows') ? { follows: [] } : { sources: [] },
    ));
    const accountEncryption = { mode: 'plain' as 'plain' | 'e2ee', contentKeyFingerprint: null as string | null };
    const actionSettings = { value: {} as Record<string, unknown> };
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { following: { enabled: true } } } });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    for (const serverId of [active.id, target.id]) primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (url, init) => {
        if (new URL(String(url)).pathname === '/v1/auth/ping') return new Response('{}', { status: 200 });
        if (new URL(String(url)).pathname === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: actionSettings.value } });
        if (new URL(String(url)).pathname === '/v1/account/encryption') return Response.json({ mode: accountEncryption.mode, updatedAt: 1 });
        if (new URL(String(url)).pathname === '/v1/account/encryption/currentness') return Response.json({ mode: accountEncryption.mode, version: 1,
            signingKeyFingerprint: accountEncryption.mode === 'plain' ? null : 'signing-fingerprint',
            contentKeyFingerprint: accountEncryption.contentKeyFingerprint, updatedAt: 1 });
        return request(String(url), init);
    });
    return { target, request, credentials, token, storage, active, TokenStorage, accountEncryption, actionSettings };
}

describe('Follow exact Home Action transport', () => {
    it('admits personal Follow mutations through the shared Action settings', async () => {
        const env = await setup();
        const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
        const features = createRootLayoutFeaturesResponse({ features: { sessions: { following: { enabled: true } } } });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId: env.target.id, snapshot: { status: 'ready', features } });
        env.actionSettings.value = { actionsSettingsV1: { v: 1, actions: { 'follow.set': { enabled: false }, 'follow.remove': { enabled: false } } } };
        env.request.mockImplementation(async (url, init) => {
            if (url.endsWith('/v2/account/settings')) return Response.json({ version: 1, content: { t: 'plain', v: {
                actionsSettingsV1: { v: 1, actions: { 'follow.set': { enabled: false }, 'follow.remove': { enabled: false } } },
            } } });
            return Response.json(init?.method === 'DELETE' ? { changed: true } : { changed: true, follow: { sessionId: 'source', following: true,
                notificationLevel: 'all', includeInVoice: false }, voiceInitialSnapshotPending: false });
        });
        const api = await import('./sessionFollowApi');
        const address = { serverId: env.target.id, sessionId: 'source' };
        expect(await api.sessionFollowSet(address, { policy: { preset: 'quiet' } })).toMatchObject({ kind: 'failed' });
        expect(await api.sessionFollowRemove(address)).toMatchObject({ kind: 'failed' });
        expect(env.request.mock.calls.filter(([url, init]) => url.includes('/follow') && init?.method !== 'GET')).toHaveLength(0);
    });
    it('admits Session Follow authoring and rule edits through the shared Action settings', async () => {
        const env = await setup();
        env.actionSettings.value = { actionsSettingsV1: { v: 1, actions: {
            'follow.set': { enabled: false }, 'follow.remove': { enabled: false },
        } } };
        env.request.mockImplementation(async (_url, init) => Response.json(init?.method === 'DELETE' ? { changed: true }
            : { changed: true, source: { sourceSessionId: 'source', destinationSessionId: 'destination',
                policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false } }));
        const api = await import('./sessionFollowSourcesApi');
        const { writeSessionFollowRuleDefinition } = await import('./sessionFollowRuleEdits');
        const pair = { serverId: env.target.id, sourceSessionId: 'source', destinationSessionId: 'destination' };
        expect(await api.setSessionFollowSource({ ...pair, policy: { preset: 'quiet' } }))
            .toMatchObject({ kind: 'failed', actionFailure: { errorCode: 'action_disabled' } });
        expect(await api.removeSessionFollowSource(pair))
            .toMatchObject({ kind: 'failed', actionFailure: { errorCode: 'action_disabled' } });
        expect(await writeSessionFollowRuleDefinition(env.target.id, { ruleId: 'rule',
            receiver: { kind: 'session', sessionId: 'destination' }, version: 1,
            definition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: [env.target.id] }),
                policy: { preset: 'quiet' } },
        }, 1)).toMatchObject({ kind: 'failed', actionFailure: { errorCode: 'action_disabled' } });
        expect(env.request.mock.calls.filter(([url, init]) => url.includes('/follow') && init?.method !== 'GET')).toHaveLength(0);
    });
    it('evaluates one source through fresh exact-Home reads without a Session corpus query', async () => {
        const homes = createHomeGovernanceHarness();
        await homes.reset();
        installHomeGovernanceBoundaries(homes);
        const serverUrl = 'https://follow-source.test';
        const credentials = { token: createAccountTokenForTests('source-account', { currentAccount: true }) };
        const serverId = await homes.addHome({ name: 'Source', serverUrl, accountId: 'source-account', currentAccount: true, credentials });
        await restoreServerAccountForTest({ serverUrl, accountId: 'source-account', credentials,
            request: homes.request, configureSocket: configureConnectedServerSocketBoundary });
        const { sync } = await import('@/sync/sync');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const { executeSessionFollowAction } = await import('./sessionFollowApi');
        const { readSessionFollowRuleInputs } = await import('./sessionFollowRulesApi');
        const source = createSessionFixture({ id: 'source', serverId, metadata: { path: '/repo', host: 'test' } });
        homes.answer(serverId, '/v2/sessions', { body: { sessions: [], nextCursor: null, hasNext: false } });
        homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
        homes.answer(serverId, '/v2/account/session-follow-preferences', { status: 503, body: { error: 'unavailable' } });
        homes.answer(serverId, '/v2/sessions/source', { body: createPlainSessionByIdResponseFixture(source) });
        try {
            await sync.awaitBootstrapForegroundAcquisition();
            await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
            const beforeQueries = homes.requests.filter(request => request.path === '/v2/sessions/query').length;
            const beforeRules = homes.requests.filter(request => request.path === '/v2/account/session-follow-rules').length;
            const acquired = await readSessionFollowRuleInputs(serverId);
            expect(acquired.status).toBe('ready');
            const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], show: 'sessions',
                scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'] });
            const read = (value: typeof filter) => executeSessionFollowAction('follow.preview', {
                receiver: { kind: 'session', sessionId: 'receiver' }, filter: value,
            }, serverId, undefined, undefined, 'source', { rules: acquired });
            expect(await read(filter)).toMatchObject({ kind: 'ok', value: { coverage: 'complete',
                matches: [{ source: { kind: 'session', sessionId: 'source' } }] } });
            expect(await read({ ...filter, homeServerIds: ['other-home'] })).toMatchObject({ kind: 'ok',
                value: { coverage: 'complete', matches: [] } });
            expect(await read({ ...filter, underSessionId: 'unknown-manager' })).toMatchObject({ kind: 'ok',
                value: { coverage: 'partial', matches: [], unavailable: [{ source: { sessionId: 'source' } }] } });
            expect(homes.requests.filter(request => request.path === '/v2/sessions/query')).toHaveLength(beforeQueries);
            expect(homes.requests.filter(request => request.path === '/v2/account/session-follow-rules')).toHaveLength(beforeRules + 1);
            expect(homes.requests.filter(request => request.path === '/v2/account/session-follow-preferences')).toHaveLength(0);
        } finally {
            apiSocket.disconnect();
            installDisconnectedServerSocketBoundary();
        }
    });

    it.each([
        { changeBeforeDisclosure: false, supplied: false }, { changeBeforeDisclosure: true, supplied: false },
        { changeBeforeDisclosure: false, supplied: true }, { changeBeforeDisclosure: true, supplied: true },
    ])('borrows preview authority after the held Session query; an undelivered change applies at the next boundary ($changeBeforeDisclosure, supplied census: $supplied)', async ({ changeBeforeDisclosure, supplied }) => {
        const homes = createHomeGovernanceHarness();
        await homes.reset();
        installHomeGovernanceBoundaries(homes);
        const serverUrl = 'https://follow-preview-authority.test';
        const credentials = { token: createAccountTokenForTests('preview-account', { currentAccount: true }) };
        const serverId = await homes.addHome({ name: 'Preview authority', serverUrl, accountId: 'preview-account',
            currentAccount: true, credentials });
        const restored = await restoreServerAccountForTest({ serverUrl, accountId: 'preview-account', credentials,
            request: homes.request, configureSocket: configureConnectedServerSocketBoundary });
        const { sync } = await import('@/sync/sync');
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const { executeSessionFollowAction } = await import('./sessionFollowApi');
        const { readSessionFollowRules } = await import('./sessionFollowRulesApi');
        const releaseQuery = createDeferred<void>();
        let pending: Promise<unknown> | undefined;
        try {
            await sync.awaitBootstrapForegroundAcquisition();
            await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
            const binding = apiSocket.getAccountEncryptionObservationBinding(credentials);
            if (!binding) throw new Error('Missing preview fixture socket observation');
            await binding.read();
            const filter = normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId], scope: 'all_accessible',
                startedBy: ['you', 'agents', 'triggers'] });
            const session = createSessionFixture({ id: 'preview-member', serverId, metadata: { path: '/repo', host: 'test' } });
            homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [{ ruleId: 'private-other-rule',
                receiver: { kind: 'session', sessionId: 'other-receiver' }, version: 1,
                content: { t: 'plain', v: { v: 1, enabled: true, filter, policy: { preset: 'quiet' } } } }] } });
            homes.answer(serverId, '/v2/account/session-follow-preferences', { body: { assigned: true, direct: false, team: false, group: false } });
            homes.answer(serverId, '/v2/sessions/query', { respondAfter: releaseQuery.promise,
                body: createSessionListSourceFixture({ sessions: [{ ...createPlainSessionByIdResponseFixture(session).session,
                    viewer: createSessionOwnerViewerFixture(session) }], hasNext: false, nextCursor: null,
                    attentionHasNext: false, attentionNextCursor: null }) });
            let authorityReads = 0;
            let committedChange = false;
            setRuntimeFetch(async (url, init) => {
                if (new URL(String(url)).pathname === '/v1/account/encryption/currentness') {
                    authorityReads++;
                    return Response.json(committedChange ? { ...createPlainAccountEncryptionCurrentnessFixture(), mode: 'e2ee',
                        version: 2, updatedAt: 2, signingKeyFingerprint: 'changed-signing', contentKeyFingerprint: 'changed-content',
                        recipientEnvelopeReadiness: { status: 'available' } } : createPlainAccountEncryptionCurrentnessFixture());
                }
                return homes.request(url, init);
            });
            const acquired = supplied ? await readSessionFollowRules(serverId) : undefined;
            if (supplied) expect(acquired?.status).toBe('ready');
            const beforeQueries = homes.requests.filter(request => request.path === '/v2/sessions/query').length;
            const reading = executeSessionFollowAction('follow.preview', { receiver: { kind: 'account' }, filter }, serverId,
                undefined, undefined, undefined, acquired ? { rules: acquired } : undefined);
            pending = reading;
            await vi.waitFor(() => expect(homes.requests.filter(request => request.path === '/v2/sessions/query').length).toBe(beforeQueries + 1));
            // The Account socket remains connected and receives no mode-change delivery while the query is held.
            const readsBeforeQueryRelease = authorityReads;
            committedChange = changeBeforeDisclosure;
            releaseQuery.resolve(undefined);
            // P03 R3 amendment (b): preview disclosure to the same Account borrows the
            // held observation; a committed change not yet delivered applies at the
            // next boundary (socket delivery, reconnect or next read), as catalog reads do.
            await expect(reading).resolves.toMatchObject({ kind: 'ok', value: { matchCount: 1,
                overlaps: [{ ruleId: 'private-other-rule', matches: [{ serverId, source: { kind: 'session', sessionId: session.id } }] }] } });
            expect(authorityReads - readsBeforeQueryRelease).toBe(0);
            expect(authorityReads).toBe(0);
        } finally {
            releaseQuery.resolve(undefined);
            await pending;
            await restored.dispose();
            await homes.reset();
            installDisconnectedServerSocketBoundary();
        }
    });
    it('reuses captured identity for the private census and list disclosure but refreshes before rule sealing', async () => {
        const env = await setup();
        const { executeSessionFollowAction } = await import('./sessionFollowApi');
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const { createServerFetchAtEndpoint } = await import('@/sync/http/client');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Missing Follow fixture Account lifetime');
        const credentials = await env.TokenStorage.getCredentialsForServerUrl('https://target.example', { serverId: env.target.id });
        if (!credentials) throw new Error('Missing Follow fixture credentials');
        let socket: import('socket.io-client').Socket | undefined;
        installDisconnectedServerSocketBoundary(current => { socket = current; configureConnectedServerSocketBoundary(current); });
        let authorityReads = 0;
        let committedChange = false;
        let requested = createDeferred<void>();
        let bodyReady = createDeferred<void>();
        const receiver = { kind: 'account' as const };
        const ruleDefinition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1() };
        const policy = { preset: 'quiet' as const };
        const definition = { ...ruleDefinition, policy };
        const rule = { ruleId: 'rule', receiver, version: 0, content: { t: 'plain' as const, v: definition } };
        let writerStartedAt = 0;
        setRuntimeFetch(async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/account/encryption/currentness') {
                authorityReads++;
                return Response.json(committedChange ? { ...createPlainAccountEncryptionCurrentnessFixture(), mode: 'e2ee',
                    version: 2, updatedAt: 2, signingKeyFingerprint: 'changed-signing', contentKeyFingerprint: 'changed-content',
                    recipientEnvelopeReadiness: { status: 'available' } } : createPlainAccountEncryptionCurrentnessFixture());
            }
            if (path === '/v2/account/session-follow-rules') return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                requested.resolve(undefined);
                void bodyReady.promise.then(() => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ rules: [rule] }))); controller.close(); });
            } }), { headers: { 'Content-Type': 'application/json' } });
            if (path === '/v2/account/session-follow-rules/rule' && init?.method === 'PUT') {
                expect(authorityReads - writerStartedAt).toBe(1);
                expect(JSON.parse(String(init.body))).toMatchObject({ content: rule.content });
                return Response.json({ rule });
            }
            return env.request(String(url), init);
        });
        let pending: Promise<unknown> | undefined;
        try {
            apiSocket.initialize({ endpoint: 'https://target.example', token: credentials.token, credentials, serverId: env.target.id,
                request: createServerFetchAtEndpoint({ endpointUrl: 'https://target.example', serverId: env.target.id, credentials }),
                isCurrent: lifetime.isCurrent }, null);
            await vi.waitFor(() => expect(socket?.connected).toBe(true));
            const binding = apiSocket.getAccountEncryptionObservationBinding(credentials);
            if (!binding) throw new Error('Missing Follow fixture socket observation');
            await binding.read();
            // The real Follow context producer captures the socket binding; no request is manually branded here.
            for (const changeBeforeDisclosure of [false, true]) {
                requested = createDeferred<void>();
                bodyReady = createDeferred<void>();
                const before = authorityReads;
                const reading = executeSessionFollowAction('follow.list', { direction: 'following', receiver }, env.target.id);
                pending = reading;
                await Promise.race([requested.promise, reading.then(() => { throw new Error('Follow settled before the held census'); })]);
                expect(authorityReads - before).toBe(0);
                committedChange = changeBeforeDisclosure;
                bodyReady.resolve(undefined);
                // P03 R3 amendment (b): list disclosure borrows the held observation.
                await expect(reading).resolves.toMatchObject({ kind: 'ok', value: { rules: [{ ruleId: 'rule', definition }] } });
                expect(authorityReads - before).toBe(0);
                if (!changeBeforeDisclosure) {
                    writerStartedAt = authorityReads;
                    await expect(executeSessionFollowAction('follow.set', { receiver, source: { kind: 'rule', ruleId: 'rule' },
                        ruleDefinition, policy, expectedVersion: -1 }, env.target.id)).resolves.toMatchObject({ kind: 'ok' });
                    expect(authorityReads - writerStartedAt).toBe(2);
                }
            }
        } finally {
            bodyReady.resolve(undefined);
            await pending;
            apiSocket.disconnect();
            installDisconnectedServerSocketBoundary();
        }
    });
    it('preserves source continuation and emits private rules once across following pages', async () => {
        const env = await setup();
        const { executeSessionFollowAction } = await import('./sessionFollowApi');
        const receiver = { kind: 'account' as const };
        const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'quiet' as const } };
        const rule = { ruleId: 'rule', receiver, version: 0, content: { t: 'plain' as const, v: definition } };
        env.request.mockImplementation(async url => {
            const parsed = new URL(url);
            if (parsed.pathname.endsWith('/session-follow-rules')) return Response.json({ rules: [rule] });
            expect(parsed.pathname).toBe('/v2/account/session-follows');
            expect(parsed.searchParams.get('limit')).toBe('1');
            return Response.json(parsed.searchParams.has('cursor') ? { follows: [] } : { follows: [], continuation: 'next-source-page' });
        });
        expect(await executeSessionFollowAction('follow.list', { direction: 'following', receiver, limit: 1 }, env.target.id))
            .toMatchObject({ kind: 'ok', value: { rules: [{ ruleId: 'rule', definition }], coverage: 'partial', continuation: 'next-source-page' } });
        expect(await executeSessionFollowAction('follow.list', { direction: 'following', receiver, limit: 1, cursor: 'next-source-page' }, env.target.id))
            .toEqual({ kind: 'ok', value: { follows: [], sources: [], rules: [], coverage: 'complete' } });
    });
    it('reads source followers on the captured Home without opening private rule census', async () => {
        const env = await setup();
        const { executeSessionFollowAction } = await import('./sessionFollowApi');
        const payload = { follows: [], sources: [{ sourceSessionId: 'source', destinationSessionId: 'receiver', relation: 'follower',
            policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false }], rules: [], coverage: 'complete', peopleCount: 3 };
        env.request.mockImplementation(async url => {
            expect(url).toBe('https://target.example/v2/sessions/source/follows/followers');
            return Response.json(payload);
        });
        const input = { direction: 'followers' as const, source: { kind: 'session' as const, sessionId: 'source' } };
        expect(await executeSessionFollowAction('follow.list', input, env.target.id)).toEqual({ kind: 'ok', value: payload });
        env.request.mockResolvedValue(Response.json({ error: 'session_not_found' }, { status: 404 }));
        expect(await executeSessionFollowAction('follow.list', input, env.target.id)).toEqual({ kind: 'failed', error: 'session_not_found' });
    });

    it('reads actual Account Following relations with continuation without opening private rule census', async () => {
        const env = await setup();
        const { readAccountSessionFollowRelations } = await import('./sessionFollowApi');
        env.request.mockImplementation(async url => {
            const parsed = new URL(url);
            expect(parsed.origin).toBe('https://target.example');
            expect(parsed.searchParams.get('limit')).toBe('1');
            expect(parsed.searchParams.get('cursor')).toBe('relations-page');
            expect(parsed.pathname).toBe('/v2/account/session-follows');
            return Response.json({ follows: [], continuation: 'account-next' });
        });
        expect(await readAccountSessionFollowRelations({ serverId: env.target.id, accountId: 'target-account' },
            { cursor: 'relations-page', limit: 1 })).toEqual({ kind: 'ok', value: { follows: [], continuation: 'account-next' } });
        expect(env.request.mock.calls).toHaveLength(1);
        expect(await readAccountSessionFollowRelations({ serverId: env.target.id, accountId: 'different-account' }))
            .toEqual({ kind: 'failed', error: 'unavailable' });
        expect(env.request.mock.calls).toHaveLength(1);
    });

    it('binds People follower data to its exact Account lifetime and withdraws it on source denial', async () => {
        const env = await setup();
        const { useSessionFollowers } = await import('@/components/sessions/follow/useSessionFollowers');
        const payload = { follows: [], sources: [{ sourceSessionId: 'source', destinationSessionId: 'receiver', relation: 'follower',
            policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false }], rules: [], coverage: 'complete', peopleCount: 3 };
        env.request.mockResolvedValue(Response.json(payload));
        const address = { serverId: env.target.id, sessionId: 'source' };
        const hook = await renderHook(() => useSessionFollowers(address, true));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().projection?.peopleCount).toBe(3));
            env.request.mockResolvedValue(Response.json({ error: 'service_unavailable' }, { status: 503 }));
            await act(async () => { hook.getCurrent().refresh(); });
            await vi.waitFor(() => expect(hook.getCurrent().error).toBe('unavailable'));
            expect(hook.getCurrent().projection?.peopleCount).toBe(3);
            env.request.mockResolvedValue(Response.json({ error: 'session_not_found' }, { status: 404 }));
            await act(async () => { hook.getCurrent().refresh(); });
            await vi.waitFor(() => expect(hook.getCurrent().error).toBe('session_not_found'));
            expect(hook.getCurrent().projection).toBeNull();
        } finally { await hook.unmount(); }
    });
    it('reads Account delivery mutes only for the captured Home and Account, with no unavailable fallback', async () => {
        const env = await setup();
        const { readAccountSessionDeliveryMutedScopes } = await import('./sessionFollowApi');
        const scope = { serverId: env.target.id, accountId: 'target-account' };
        const scopes = [{ kind: 'source', source: { kind: 'session', sessionId: 'same' } }];
        env.request.mockImplementation(async (url, init) => {
            expect(new URL(url).origin).toBe('https://target.example');
            expect(new URL(url).pathname).toBe('/v2/account/session-delivery-mutes');
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${env.token('target-account')}`);
            return Response.json({ scopes });
        });
        expect(await readAccountSessionDeliveryMutedScopes(scope)).toEqual(scopes);
        env.request.mockClear();
        expect(await readAccountSessionDeliveryMutedScopes({ ...scope, accountId: 'active-account' })).toBeNull();
        expect(await readAccountSessionDeliveryMutedScopes({ ...scope, serverId: '' })).toBeNull();
        expect(await readAccountSessionDeliveryMutedScopes({ serverId: 'unknown-home', accountId: 'active-account' })).toBeNull();
        expect(env.request).not.toHaveBeenCalled();
        env.request.mockResolvedValue(Response.json({ scopes: null }));
        expect(await readAccountSessionDeliveryMutedScopes(scope)).toBeNull();
        env.request.mockResolvedValue(Response.json({ error: 'mute_state_unavailable' }, { status: 503 }));
        expect(await readAccountSessionDeliveryMutedScopes(scope)).toBeNull();
        env.credentials.mockResolvedValue(null);
        expect(await readAccountSessionDeliveryMutedScopes(scope)).toBeNull();
        env.credentials.mockResolvedValue({ token: env.token('target-account') });
        env.request.mockImplementation(async () => {
            await env.TokenStorage.setCredentialsForServerUrl('https://target.example', { serverId: env.target.id },
                { token: env.token('replacement-account') });
            return Response.json({ scopes });
        });
        expect(await readAccountSessionDeliveryMutedScopes(scope)).toBeNull();
    });

    it('seals a private rule on its captured Home, opens Action results, and refuses a different receiver', async () => {
        const env = await setup();
        const { executeSessionFollowAction } = await import('./sessionFollowApi');
        const receiver = { kind: 'account' as const };
        const ruleDefinition = { v: 1 as const, enabled: true,
            filter: normalizeSessionListFilterV1({ scope: 'all_accessible', homeServerIds: [env.target.id] }) };
        const policy = { preset: 'important' as const };
        const rule = { ruleId: 'rule-a', receiver, version: 0, content: { t: 'plain' as const, v: { ...ruleDefinition, policy } } };
        env.request.mockImplementation(async (url, init) => {
            expect(new URL(url).origin).toBe('https://target.example');
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            expect(path).toBe('/v2/account/session-follow-rules/rule-a');
            if (init?.method === 'PUT') {
                const body = JSON.parse(String(init.body));
                expect(body).toEqual({ receiver, expectedVersion: -1, content: rule.content });
            }
            return Response.json({ rule });
        });
        expect(await executeSessionFollowAction('follow.set', { receiver, source: { kind: 'rule', ruleId: 'rule-a' },
            ruleDefinition, policy, expectedVersion: -1 }, env.target.id)).toMatchObject({ kind: 'ok', value: { rule: {
                ruleId: 'rule-a', receiver, version: 0, definition: { ...ruleDefinition, policy },
            } } });
        const mismatch = await executeSessionFollowAction('follow.get', {
            receiver: { kind: 'session', sessionId: 'other' }, source: { kind: 'rule', ruleId: 'rule-a' },
        }, env.target.id);
        expect(mismatch.kind).toBe('failed');
    });

    it.each(['plain', 'e2ee'] as const)('opens one %s private census for many screen-owned Following projections', async mode => {
        const secret = mode === 'e2ee' ? Buffer.alloc(32, 11).toString('base64url') : undefined;
        const env = await setup(secret);
        const { readSessionFollowRules } = await import('./sessionFollowRulesApi');
        const { executeSessionFollowAction } = await import('./sessionFollowApi');
        const { sealSessionFollowRuleContentV1 } = await import('@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1');
        const { resolveAccountScopedCryptoMaterialFromCredentials } = await import('@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials');
        const { createAccountScopedCryptoMaterialSnapshotV1 } = await import('@happier-dev/protocol/crypto/accountScopedCipher');
        const { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } = await import('@happier-dev/protocol/account/encryptionKeyFingerprintV1');
        const material = secret ? resolveAccountScopedCryptoMaterialFromCredentials({ token: env.token('target-account'), secret }) : null;
        env.accountEncryption.mode = mode;
        if (material) env.accountEncryption.contentKeyFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint);
        const definition = { v: 1 as const, enabled: true, policy: { preset: 'quiet' as const }, filter: normalizeSessionListFilterV1() };
        const rules = Array.from({ length: 20 }, (_, index) => {
            const rule = { ruleId: `rule-${index}`, receiver: { kind: 'session' as const, sessionId: `receiver-${index}` }, version: 0 };
            return { ...rule, content: sealSessionFollowRuleContentV1({ ...rule, definition, mode, material }) };
        });
        env.request.mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path.endsWith('/session-follow-preferences')) return Response.json({ assigned: true, direct: false, team: false, group: false });
            if (path.endsWith('/session-follow-rules')) return Response.json({ rules });
            return Response.json({ sources: [] });
        });
        const acquired = await readSessionFollowRules(env.target.id);
        expect(acquired.status).toBe('ready');
        expect(await readSessionFollowRules(env.target.id, undefined, { expectedAccountId: 'target-account', rules: acquired })).toBe(acquired);
        for (const rule of rules) {
            const result = await executeSessionFollowAction('follow.list', { direction: 'following', receiver: rule.receiver },
                env.target.id, undefined, 'target-account', undefined, { rules: acquired });
            expect(result).toMatchObject({ kind: 'ok', value: { rules: [{ ruleId: rule.ruleId, definition }] } });
        }
        expect(env.request.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/session-follow-rules'))).toHaveLength(1);
        expect(env.request.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/session-follow-preferences'))).toHaveLength(1);
    });

    it('loads personal defaults with the same captured Account rule census', async () => {
        const env = await setup();
        const { readSessionFollowRules } = await import('./sessionFollowRulesApi');
        const preferences = { assigned: false, direct: false, team: true, group: false };
        env.request.mockImplementation(async url => {
            expect(new URL(url).origin).toBe('https://target.example');
            if (new URL(url).pathname === '/v2/account/session-follow-preferences') return Response.json(preferences);
            expect(new URL(url).pathname).toBe('/v2/account/session-follow-rules');
            return Response.json({ rules: [] });
        });
        expect(await readSessionFollowRules(env.target.id)).toMatchObject({ status: 'ready', accountId: 'target-account',
            rules: [], defaultPreferences: preferences });
    });

    it('acquires private rule inputs without preferences while the Activity combined read fails closed', async () => {
        const env = await setup();
        const { readSessionFollowRuleInputs, readSessionFollowRules } = await import('./sessionFollowRulesApi');
        const { executeSessionFollowAction } = await import('./sessionFollowApi');
        env.request.mockImplementation(async url => new URL(url).pathname.endsWith('/session-follow-rules')
            ? Response.json({ rules: [] }) : Response.json({ error: 'unavailable' }, { status: 503 }));
        const rules = await readSessionFollowRuleInputs(env.target.id, undefined, { expectedAccountId: 'target-account' });
        expect(rules).toMatchObject({ status: 'ready', accountId: 'target-account', rules: [] });
        expect(env.request.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/session-follow-preferences'))).toHaveLength(0);
        expect(await executeSessionFollowAction('follow.preview', { receiver: { kind: 'account' }, filter: normalizeSessionListFilterV1() },
            env.target.id, undefined, 'target-account', undefined, { rules })).toMatchObject({ kind: 'ok' });
        expect(await readSessionFollowRules(env.target.id)).toMatchObject({ status: 'unavailable' });
    });

    it('withdraws supplied census on wrong scope, replacement credentials, cancellation and mode changes without fetching another census', async () => {
        const env = await setup();
        const { readSessionFollowRules } = await import('./sessionFollowRulesApi');
        const { executeSessionFollowAction } = await import('./sessionFollowApi');
        env.request.mockImplementation(async url => Response.json(new URL(url).pathname.endsWith('/session-follow-preferences')
            ? { assigned: true, direct: false, team: false, group: false } : { rules: [] }));
        const acquired = await readSessionFollowRules(env.target.id);
        if (acquired.status !== 'ready') throw new Error('Missing acquired Follow fixture');
        expect(await readSessionFollowRules(env.target.id, undefined, { expectedAccountId: 'other-account', rules: acquired }))
            .toMatchObject({ status: 'unavailable' });
        expect(await readSessionFollowRules(env.target.id, undefined, { rules: { ...acquired, serverId: env.active.id } }))
            .toMatchObject({ status: 'unavailable' });
        const controller = new AbortController();
        controller.abort();
        expect(await readSessionFollowRules(env.target.id, controller.signal, { rules: acquired }))
            .toMatchObject({ status: 'unavailable' });
        env.credentials.mockResolvedValue({ token: env.token('target-account'), secret: Buffer.alloc(32, 4).toString('base64url') });
        expect(await readSessionFollowRules(env.target.id, undefined, { rules: acquired }))
            .toMatchObject({ status: 'unavailable' });
        env.credentials.mockResolvedValue({ token: env.token('target-account') });
        env.accountEncryption.mode = 'e2ee';
        expect(await readSessionFollowRules(env.target.id, undefined, { rules: acquired }))
            .toMatchObject({ status: 'unavailable' });
        expect(await executeSessionFollowAction('follow.preview', { receiver: { kind: 'account' }, filter: normalizeSessionListFilterV1() },
            env.target.id, undefined, 'target-account', undefined, { rules: { status: 'unavailable', reason: 'forbidden' } }))
            .toMatchObject({ kind: 'ok', value: { coverage: 'unavailable' } });
        expect(env.request.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/session-follow-rules'))).toHaveLength(1);
    });

    it('joins only the requested receiver rules to Following and refuses an unreadable private census', async () => {
        const env = await setup();
        const { executeSessionFollowAction } = await import('./sessionFollowApi');
        const definition = { v: 1 as const, enabled: true, policy: { preset: 'important' as const },
            filter: normalizeSessionListFilterV1({ homeServerIds: [env.target.id], scope: 'all_accessible' }) };
        const rule = { ruleId: 'own', receiver: { kind: 'account' as const }, version: 4,
            content: { t: 'plain' as const, v: definition } };
        let unreadable = false;
        env.request.mockImplementation(async url => {
            expect(new URL(url).origin).toBe('https://target.example');
            if (new URL(url).pathname === '/v2/account/session-follows') return Response.json({ follows: [] });
            expect(new URL(url).pathname).toBe('/v2/account/session-follow-rules');
            return Response.json({ rules: [rule, { ...rule, ruleId: 'other', receiver: { kind: 'session', sessionId: 'other' },
                ...(unreadable ? { content: { t: 'encrypted', c: 'wrong-mode' } } : {}) }] });
        });
        expect(await executeSessionFollowAction('follow.list', { direction: 'following', receiver: { kind: 'account' } }, env.target.id))
            .toEqual({ kind: 'ok', value: { follows: [], sources: [], rules: [{
                ruleId: rule.ruleId, receiver: rule.receiver, version: rule.version, definition,
            }], coverage: 'complete' } });
        unreadable = true;
        expect(await executeSessionFollowAction('follow.list', { direction: 'following', receiver: { kind: 'account' } }, env.target.id))
            .toEqual({ kind: 'failed', error: 'unavailable' });
    });

    it('seals and opens E2EE rule Actions with the captured Account material and rejects a mode change', async () => {
        const secret = Buffer.alloc(32, 11).toString('base64url');
        const env = await setup(secret);
        const { executeSessionFollowAction } = await import('./sessionFollowApi');
        const { createAccountScopedCryptoMaterialSnapshotV1 } = await import('@happier-dev/protocol/crypto/accountScopedCipher');
        const { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } = await import('@happier-dev/protocol/account/encryptionKeyFingerprintV1');
        const { resolveAccountScopedCryptoMaterialFromCredentials } = await import('@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials');
        const { openSessionFollowRuleContentV1 } = await import('@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1');
        const material = resolveAccountScopedCryptoMaterialFromCredentials({ token: env.token('target-account'), secret });
        env.accountEncryption.mode = 'e2ee';
        env.accountEncryption.contentKeyFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint,
        );
        const input = { receiver: { kind: 'account' as const }, source: { kind: 'rule' as const, ruleId: 'encrypted' },
            expectedVersion: -1, policy: { preset: 'important' as const }, ruleDefinition: { v: 1 as const, enabled: true,
                filter: normalizeSessionListFilterV1({ homeServerIds: [env.target.id], scope: 'all_accessible' }) } };
        let changeMode = false;
        env.request.mockImplementation(async (url, init) => {
            expect(new URL(url).origin).toBe('https://target.example');
            const body = JSON.parse(String(init?.body));
            expect(body.content.t).toBe('encrypted');
            expect(openSessionFollowRuleContentV1({ ruleId: input.source.ruleId, receiver: input.receiver,
                content: body.content, mode: 'e2ee', material })).toEqual({ status: 'opened',
                definition: { ...input.ruleDefinition, policy: input.policy } });
            if (changeMode) { env.accountEncryption.mode = 'plain'; env.accountEncryption.contentKeyFingerprint = null; }
            return Response.json({ rule: { ruleId: input.source.ruleId, receiver: input.receiver, version: 0, content: body.content } });
        });
        expect(await executeSessionFollowAction('follow.set', input, env.target.id)).toMatchObject({ kind: 'ok', value: { rule: {
            definition: { ...input.ruleDefinition, policy: input.policy },
        } } });
        changeMode = true;
        expect(await executeSessionFollowAction('follow.set', input, env.target.id)).toEqual({ kind: 'failed', error: 'unavailable' });
    });
    it.each([
        { actionId: 'follow.get', input: { receiver: { kind: 'account' }, source: { kind: 'session', sessionId: 'same' } } },
        { actionId: 'follow.list', input: { direction: 'following', receiver: { kind: 'session', sessionId: 'same' } } },
    ] as const)('classifies the strict scope refusal for $actionId', async ({ actionId, input }) => {
        const env = await setup();
        const { sessionFollowAction } = await import('./sessionFollowApi');
        env.request.mockResolvedValue(Response.json({ error: 'credential_scope_denied' }, { status: 403 }));
        await expect(sessionFollowAction({ actionId, input, serverId: env.target.id, context: {} }))
            .resolves.toEqual({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' });
        env.request.mockResolvedValue(Response.json({ error: 'credential_scope_denied', details: {} }, { status: 403 }));
        await expect(sessionFollowAction({ actionId, input, serverId: env.target.id, context: {} }))
            .resolves.toEqual({ ok: false, errorCode: 'network_error', error: 'unavailable' });
    });

    it('edits declared auto-follow defaults on the captured Home without Account or device writes', async () => {
        const env = await setup();
        const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
        const { createSettingsDeclarationAction } = await import('@/sync/ops/actions/settingsDeclarationAction');
        const { createSettingsOwnerActionExecutor } = await import('@/sync/ops/actions/settingsOwnerActionExecutor');
        const { sessionFollowAction } = await import('./sessionFollowApi');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
        let current = true;
        let requireApproval = false;
        let executor: ReturnType<typeof createActionExecutor>;
        const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: env.target.id };
        const unused = async () => { throw new Error('unexpected unrelated transport or preference write'); };
        const settingsDeclarationAction = createSettingsDeclarationAction({
            host: { os: 'ios', desktop: false }, tauriDesktop: false, readPageGate: () => undefined,
            isFeatureEnabled: async () => true, isCurrent: () => current,
            readAccountSettings: async () => settingsDefaults, readLocalSettings: () => localSettingsDefaults,
            writeAccountSettings: unused, mutateAccountSettings: unused, writeLocalSettings: () => { throw new Error('unexpected local preference write'); },
            mutationServices: { executeSettingsOwnerAction: createSettingsOwnerActionExecutor(
                request => executor.execute(request.actionId, request.input, request.context),
                { serverId: env.target.id, accountId: 'target-account',
                    assertCurrent: () => { if (!current) throw new Error('Account retired'); } },
            ) },
        });
        executor = createActionExecutor({ settingsDeclarationAction, sessionFollowAction,
            isActionApprovalRequired: id => requireApproval && id === 'follow.preferences.set',
            executionRunStart: unused, executionRunList: unused, executionRunGet: unused, detachedExecutionRunSend: unused,
            executionRunStop: unused, executionRunAction: unused, executionRunWait: unused, sessionOpen: unused,
            sessionFork: unused, sessionRollback: unused, sessionSpawnNew: unused, pathsListRecent: unused,
            machinesList: unused, serversList: unused, reviewEnginesList: unused, agentsBackendsList: unused,
            agentsModelsList: unused, sessionSendMessage: unused, sessionModeSet: unused, sessionModesList: unused,
            sessionList: unused, sessionActivityGet: unused, sessionRecentMessagesGet: unused, resetGlobalVoiceAgent: unused,
            daemonMemorySearch: unused, daemonMemoryGetWindow: unused, daemonMemoryEnsureUpToDate: unused,
        });
        let preferences = { assigned: false, direct: true, team: false, group: true };
        env.request.mockImplementation(async (url, init) => {
            expect(new URL(url).origin).toBe('https://target.example');
            expect(new URL(url).pathname).toBe('/v2/account/session-follow-preferences');
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${env.token('target-account')}`);
            // The real Home admits both wire forms before persisting its four Account columns.
            if (init?.method === 'PUT') preferences = SessionAutoFollowPreferencesV1Schema.parse(JSON.parse(String(init.body)));
            return Response.json(preferences);
        });
        const listing = await executor.execute('settings.list', { pageId: 'coordination' }, context);
        expect(listing).toMatchObject({ ok: true, result: { items: expect.arrayContaining(
            ['Assigned', 'Direct', 'Team', 'Group'].map(field => expect.objectContaining({ anchor: `coordination.autoFollow${field}`, readable: true, writable: true })),
        ) } });
        // The focused Home and caller-supplied scope cannot redirect the captured owner.
        expect(await executor.execute('settings.get', { anchor: 'coordination.autoFollowAssigned' }, {
            ...context, serverId: env.active.id, runtimeAccountId: 'active-account', expectedAccountId: 'active-account',
        }))
            .toEqual({ ok: true, result: { anchor: 'coordination.autoFollowAssigned', value: false } });
        expect(await executor.execute('settings.set', { anchor: 'coordination.autoFollowAssigned', value: true }, context))
            .toEqual({ ok: true, result: { anchor: 'coordination.autoFollowAssigned', value: true } });
        expect(preferences).toEqual({ assigned: true, direct: true, team: false, group: true });
        requireApproval = true;
        expect(await executor.execute('settings.set', { anchor: 'coordination.autoFollowTeam', value: true }, { ...context, bypassApprovals: true }))
            .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(preferences.team).toBe(false);
        current = false;
        expect(await executor.execute('settings.get', { anchor: 'coordination.autoFollowGroup' }, context)).toMatchObject({ ok: false, errorCode: 'setting_not_bound' });
    });

    it('lists sources on the requested Home with its credential even while another Home is focused', async () => {
        const env = await setup();
        const { listSessionFollowSources } = await import('./sessionFollowSourcesApi');
        const result = await listSessionFollowSources({ serverId: env.target.id, sessionId: 'same/id' });
        expect(result).toEqual({ kind: 'ok', value: { sources: [], rules: [], coverage: 'complete' } });
        const call = env.request.mock.calls.find(([url]) => url.includes('/follows/sessions'));
        expect(call?.[0]).toBe('https://target.example/v2/sessions/same%2Fid/follows/sessions');
        expect(new Headers(call?.[1]?.headers).get('Authorization')).toBe(`Bearer ${env.token('target-account')}`);
    });

    it.each([false, true])('shares one demanded rule census across Following and rule consumers (active Home: %s)', async (activeHome) => {
        const env = await setup();
        const serverId = activeHome ? env.active.id : env.target.id;
        const { useSessionFollowing } = await import('@/components/sessions/follow/useSessionFollowing');
        const { useSessionFollowRules } = await import('@/components/sessions/follow/useSessionFollowRules');
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } = await import('@happier-dev/protocol/sessions/follow/changes');
        const rule = { ruleId: 'payments', receiver: { kind: 'session', sessionId: 'coordinator' }, version: 4,
            content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' } } } };
        env.request.mockImplementation(async url => Response.json(url.endsWith('/session-follow-rules') ? { rules: [rule] } : { sources: [] }));
        const censusReads = () => env.request.mock.calls.filter(([url]) => url.endsWith('/session-follow-rules')).length;
        const hidden = await renderHook(() => useSessionFollowRules(serverId, false));
        expect(censusReads()).toBe(0);
        await hidden.unmount();
        const hook = await renderHook(() => ({
            following: useSessionFollowing({ serverId, sessionId: 'coordinator' }, true),
            rules: useSessionFollowRules(serverId, true),
        }));
        try {
            await vi.waitFor(() => {
                expect(hook.getCurrent().following.projection?.rules).toHaveLength(1);
                expect(hook.getCurrent().rules.snapshot?.status).toBe('ready');
            });
            expect(censusReads()).toBe(1);
            expect(hook.getCurrent().following.ruleInputs.snapshot).toBe(hook.getCurrent().rules.snapshot);
            for (let i = 0; i < 20; i++) await act(async () => publishHomeAccountChange(serverId,
                [`unrelated-${i}`], { changeKinds: ['artifact'] }));
            expect(censusReads()).toBe(1);
            rule.version = 5;
            await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
            await vi.waitFor(() => expect(hook.getCurrent().following.projection?.rules[0]?.version).toBe(5));
            expect(censusReads()).toBe(2);
            expect(hook.getCurrent().following.ruleInputs.snapshot).toBe(hook.getCurrent().rules.snapshot);
        } finally { await hook.unmount(); }
        const readsAfterUnmount = censusReads();
        await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
        expect(censusReads()).toBe(readsAfterUnmount);
    });

    it('shares one demanded rule census after active Home restoration', async () => {
        const env = await setup();
        const { useSessionFollowing } = await import('@/components/sessions/follow/useSessionFollowing');
        const { publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const profile = env.storage.getState().profileScope;
        publishAppliedActiveServerRuntimeAvailability(false);
        const hook = await renderHook(() => useSessionFollowing({ serverId: env.active.id, sessionId: 'coordinator' }, true));
        try {
            expect(hook.getCurrent().projection).toBeNull();
            await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });
            expect(env.storage.getState().profileScope).toBe(profile);
            await vi.waitFor(() => expect(hook.getCurrent().projection).toMatchObject({ rules: [], coverage: 'complete' }));
            expect(hook.getCurrent().ruleInputs.lifetime?.isCurrent()).toBe(true);
        } finally { await hook.unmount(); publishAppliedActiveServerRuntimeAvailability(true); }
    });

    it('retains a rule-only census in the reusable Following projection', async () => {
        const env = await setup();
        const { useSessionFollowing } = await import('@/components/sessions/follow/useSessionFollowing');
        const receiver = { kind: 'session' as const, sessionId: 'coordinator' };
        const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' as const } };
        const rule = { ruleId: 'payments', receiver, version: 4, content: { t: 'plain' as const, v: definition } };
        env.request.mockImplementation(async url => Response.json(url.endsWith('/session-follow-rules')
            ? { rules: [rule, { ...rule, ruleId: 'other', receiver: { kind: 'session', sessionId: 'other' } }] }
            : { sources: [] }));
        const address = { serverId: env.target.id, sessionId: receiver.sessionId };
        const hook = await renderHook(() => useSessionFollowing(address, true));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().projection).not.toBeNull());
            expect(hook.getCurrent().projection).toEqual({ sources: [], coverage: 'complete', rules: [{
                ruleId: rule.ruleId, receiver, version: rule.version, definition,
            }] });
            expect(hook.getCurrent().loading).toBe(false);
            expect(hook.getCurrent().error).toBeNull();
            const committed = hook.getCurrent().projection;
            const sourceReads = () => env.request.mock.calls.filter(([url]) => url.endsWith('/follows/sessions')).length;
            const beforeRefresh = sourceReads();
            env.request.mockImplementation(async () => Response.json({ error: 'service_unavailable' }, { status: 503 }));
            await act(async () => { await hook.getCurrent().refresh(); });
            expect(hook.getCurrent().projection).toBe(committed);
            expect(hook.getCurrent().error).toBe('unavailable');
            expect(sourceReads()).toBe(beforeRefresh + 1);
            env.request.mockImplementation(async () => Response.json({ error: 'session_not_found' }, { status: 404 }));
            await act(async () => { await hook.getCurrent().refresh(); });
            expect(hook.getCurrent().projection).toBeNull();
            expect(hook.getCurrent().error).toBe('session_not_found');
            expect(sourceReads()).toBe(beforeRefresh + 2);
        } finally { await hook.unmount(); }
    });

    it.each([false, true])('refreshes Following to the written rule with an in-flight census (active Home: %s)', async (activeHome) => {
        const env = await setup();
        const serverId = activeHome ? env.active.id : env.target.id;
        const { useSessionFollowing } = await import('@/components/sessions/follow/useSessionFollowing');
        const { writeSessionFollowRuleDefinition } = await import('./sessionFollowRuleEdits');
        const { SetSessionFollowRuleRequestV1Schema } = await import('@happier-dev/protocol/sessions/follow/sessionFollowRuleV1');
        const { createDeferred } = await import('@/dev/testkit');
        const receiver = { kind: 'session' as const, sessionId: 'coordinator' };
        const definition = { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' as const } };
        let rule: import('@happier-dev/protocol/sessions/follow/sessionFollowRuleV1').SessionFollowRuleV1 = {
            ruleId: 'payments', receiver, version: 4, content: { t: 'plain', v: definition },
        };
        const censusStarted = createDeferred<void>();
        const releaseCensus = createDeferred<void>();
        let holdCensus = false;
        env.request.mockImplementation(async (url, init) => {
            if (new URL(url).pathname === '/v2/sessions/coordinator') return Response.json(createPlainSessionByIdResponseFixture(
                createSessionFixture({ id: receiver.sessionId, serverId, encryptionMode: 'plain' }),
            ));
            if (url.endsWith('/session-follow-rules/payments')) {
                const body = SetSessionFollowRuleRequestV1Schema.parse(JSON.parse(String(init?.body)));
                if (body.content.t !== 'plain') throw new Error('Expected keyless plain rule fixture');
                rule = { ...rule, version: body.expectedVersion + 1, content: body.content };
                return Response.json({ rule });
            }
            if (!url.endsWith('/session-follow-rules')) return Response.json({ sources: [] });
            const response = Response.json({ rules: [rule] });
            if (holdCensus) {
                holdCensus = false;
                censusStarted.resolve();
                await releaseCensus.promise;
            }
            return response;
        });
        const hook = await renderHook(() => useSessionFollowing({ serverId, sessionId: receiver.sessionId }, true));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().projection?.rules[0]?.version).toBe(4));
            const previous = hook.getCurrent().projection!.rules[0]!;
            const edited = { ...previous, definition: { ...previous.definition,
                filter: normalizeSessionListFilterV1({ statuses: ['failed'] }) } };
            holdCensus = true;
            let reading: Promise<void>;
            await act(async () => { reading = hook.getCurrent().refresh(); await censusStarted.promise; });
            expect(await writeSessionFollowRuleDefinition(serverId, edited, previous.version)).toMatchObject({ kind: 'ok', value: { version: 5 } });
            await act(async () => {
                const refresh = hook.getCurrent().refresh();
                releaseCensus.resolve();
                await Promise.all([reading!, refresh]);
            });
            await vi.waitFor(() => expect(hook.getCurrent().projection?.rules[0])
                .toMatchObject({ version: 5, definition: edited.definition }));
            expect(hook.getCurrent().loading).toBe(false);
            expect(hook.getCurrent().error).toBeNull();
        } finally { releaseCensus.resolve(); await hook.unmount(); }
    });

    it('executes Account preferences and plain source mutations through their strict domain resources', async () => {
        const env = await setup();
        const api = await import('./sessionFollowApi');
        const sources = await import('./sessionFollowSourcesApi');
        const address = { serverId: env.target.id, sessionId: 'same/id' } satisfies SessionAddress;
        const preferences = { assigned: false, direct: true, team: false, group: true };
        const follow = { sessionId: address.sessionId, following: true, notificationLevel: 'none', includeInVoice: true };
        const source = { sourceSessionId: 'source/id', destinationSessionId: address.sessionId, policy: { preset: 'important' }, deliveryState: 'eligible', hasPendingUpdates: false };
        // Preparation must read the plain source through the current batch wire before deciding no DEK is needed.
        env.request.mockImplementation(createSessionReadBatchFetchBoundary(async (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            const sessionId = decodeURIComponent(new URL(url).pathname.replace('/v2/sessions/', ''));
            if (sessionId === 'source/id' || sessionId === address.sessionId) return Response.json(createPlainSessionByIdResponseFixture(
                createSessionFixture({ id: sessionId, serverId: env.target.id, encryptionMode: 'plain' }),
            ));
            const value = url.endsWith('session-follow-preferences') ? preferences
                : init?.method === 'DELETE' ? { changed: false }
                    : url.includes('/follows/sessions/') ? { changed: true, source }
                        : init?.method === 'PUT' ? { changed: true, follow, voiceInitialSnapshotPending: true }
                            : { follow: null, isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false };
            return new Response(JSON.stringify(value), { status: 200 });
        }));
        await expect(api.sessionFollowGet(address)).resolves.toEqual({ kind: 'ok', value: { follow: null, isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false } });
        await expect(api.sessionFollowSet(address, { policy: { preset: 'quiet', voice: true } })).resolves.toEqual({ kind: 'ok', value: { changed: true, follow, voiceInitialSnapshotPending: true } });
        await expect(api.sessionFollowRemove(address)).resolves.toEqual({ kind: 'ok', value: { changed: false } });
        await expect(api.sessionAutoFollowPreferencesGet(env.target.id)).resolves.toEqual({ kind: 'ok', value: preferences });
        await expect(api.sessionAutoFollowPreferencesSet(env.target.id, preferences)).resolves.toEqual({ kind: 'ok', value: preferences });
        const pair = { serverId: env.target.id, destinationSessionId: address.sessionId, sourceSessionId: 'source/id' };
        await expect(sources.setSessionFollowSource({ ...pair, policy: { preset: 'important' } })).resolves.toEqual({
            kind: 'ok', value: { changed: true, source },
        });
        await expect(sources.removeSessionFollowSource(pair)).resolves.toEqual({ kind: 'ok', value: { changed: false } });
        const requests = env.request.mock.calls.filter(([url]) => url.includes('follow'));
        expect(requests.map(([url, init]) => [new URL(url).origin, init?.method, init?.body ? JSON.parse(String(init.body)) : null])).toEqual([
            ['https://target.example', 'GET', null],
            ['https://target.example', 'PUT', { policy: { preset: 'quiet', voice: true } }],
            ['https://target.example', 'DELETE', null],
            ['https://target.example', 'GET', null],
            ['https://target.example', 'PUT', { defaultRules: preferences }],
            ['https://target.example', 'PUT', { policy: { preset: 'important' } }],
            ['https://target.example', 'DELETE', null],
        ]);
    });

    it('rejects a response after the UI Account retires and never redirects the write to the new Home', async () => {
        const env = await setup();
        const api = await import('./sessionFollowApi');
        const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        env.request.mockImplementation(async () => {
            retireActiveServerAccountScopeLifetime();
            return new Response(JSON.stringify({ changed: true }), { status: 200 });
        });
        await expect(api.sessionFollowRemove({ serverId: env.target.id, sessionId: 'same' })).resolves.toMatchObject({ kind: 'failed', error: 'unavailable' });
        expect(env.request.mock.calls.filter(([url]) => url.includes('/follow')).map(([url]) => new URL(url).origin)).toEqual(['https://target.example']);
    });

    it('preserves domain failures but rejects malformed projections and unsupported Account error codes', async () => {
        const env = await setup();
        const api = await import('./sessionFollowApi');
        const address = { serverId: env.target.id, sessionId: 'same' };
        env.request.mockImplementation(async () => new Response(JSON.stringify({ error: 'session_archived' }), { status: 409 }));
        await expect(api.sessionFollowSet(address, { policy: { preset: 'important', voice: false } })).resolves.toEqual({ kind: 'failed', error: 'session_archived' });
        env.request.mockImplementation(async () => new Response(JSON.stringify({ changed: true, frontier: 'private' }), { status: 200 }));
        await expect(api.sessionFollowRemove(address)).resolves.toMatchObject({ kind: 'failed', error: 'unavailable' });
        env.request.mockImplementation(async () => new Response(JSON.stringify({ error: 'session_follow_source_forbidden' }), { status: 403 }));
        await expect(api.sessionFollowGet(address)).resolves.toMatchObject({ kind: 'failed', error: 'unavailable' });
    });

    it('cancels on a credential change at an inactive target Home', async () => {
        const env = await setup();
        const api = await import('./sessionFollowApi');
        env.request.mockImplementation(async () => {
            await env.TokenStorage.setCredentialsForServerUrl('https://target.example', { serverId: env.target.id }, { token: env.token('new-target-account') });
            return new Response(JSON.stringify({ changed: true }), { status: 200 });
        });
        await expect(api.sessionFollowRemove({ serverId: env.target.id, sessionId: 'same' })).resolves.toMatchObject({ kind: 'failed', error: 'unavailable' });
    });

    it('cancels a delayed Voice inclusion replacement when the target Home credential changes', async () => {
        const env = await setup();
        const api = await import('./sessionFollowApi');
        let releaseResponse!: (response: Response) => void;
        const responseReady = new Promise<Response>((resolve) => { releaseResponse = resolve; });
        env.request.mockImplementation(async () => responseReady);

        const operation = api.replaceSessionVoiceInclusions(env.target.id, ['same']);
        await Promise.resolve();
        await env.TokenStorage.setCredentialsForServerUrl(
            'https://target.example',
            { serverId: env.target.id },
            { token: env.token('new-target-account') },
        );
        releaseResponse(new Response(JSON.stringify({ changed: true, sessionIds: ['same'] }), { status: 200 }));

        await expect(operation).resolves.toEqual({ kind: 'failed', error: 'unavailable' });
    });

    it('rejects a saved projection for a different Session', async () => {
        const env = await setup();
        const api = await import('./sessionFollowApi');
        env.request.mockImplementation(async () => new Response(JSON.stringify({ changed: true, follow: {
            sessionId: 'other', following: true, notificationLevel: 'none', includeInVoice: true,
        } }), { status: 200 }));
        await expect(api.sessionFollowSet({ serverId: env.target.id, sessionId: 'same' }, {
            policy: { preset: 'quiet', voice: true },
        })).resolves.toMatchObject({ kind: 'failed', error: 'unavailable' });
    });

    it('edits the other rule with a visible Project exclusion and CAS Undo without overwriting a later edit', async () => {
        const env = await setup();
        const { normalizeSessionListFilterV1 } = await import('@happier-dev/protocol/sessions/listFilter/sessionListFilterV1');
        const { SessionFollowRuleDefinitionV1Schema } = await import('@happier-dev/protocol/sessions/follow/sessionFollowRuleV1');
        const { leaveProjectToFollowRule, undoFollowRuleProjectEdit } = await import('./sessionFollowRuleEdits');
        const original = { ruleId: 'daily', receiver: { kind: 'session' as const, sessionId: 'daily-coordinator' }, version: 0,
            definition: { v: 1 as const, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: [env.target.id] }), policy: { preset: 'important' as const } } };
        let version = 0;
        let definition = SessionFollowRuleDefinitionV1Schema.parse(original.definition);
        env.request.mockImplementation(async (url, init) => {
            const path = new URL(url).pathname;
            if (path === '/v2/sessions/daily-coordinator') return Response.json(createPlainSessionByIdResponseFixture(
                createSessionFixture({ id: original.receiver.sessionId, serverId: env.target.id, encryptionMode: 'plain' }),
            ));
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
            expect(path).toBe('/v2/account/session-follow-rules/daily');
            const body = JSON.parse(String(init?.body));
            if (body.expectedVersion !== version) return Response.json({ error: 'version_conflict' }, { status: 409 });
            expect(body.receiver).toEqual(original.receiver);
            expect(body.content.t).toBe('plain');
            definition = SessionFollowRuleDefinitionV1Schema.parse(body.content.v);
            version += 1;
            return Response.json({ rule: { ruleId: original.ruleId, receiver: original.receiver, version, content: { t: 'plain', v: definition } } });
        });
        const project = { serverId: env.target.id, projectKey: 'payments' };
        const edit = await leaveProjectToFollowRule({ serverId: env.target.id, rule: original, project });
        expect(edit.kind).toBe('ok');
        expect(original.definition.filter.projects).toBeUndefined();
        expect(definition.filter.projects?.exclude).toEqual([project]);
        if (edit.kind !== 'ok') throw new Error('Expected exclusion receipt');
        expect((await undoFollowRuleProjectEdit(edit.value.undo)).kind).toBe('ok');
        expect(definition).toEqual(original.definition);
        const second = await leaveProjectToFollowRule({ serverId: env.target.id, rule: { ...original, version }, project });
        if (second.kind !== 'ok') throw new Error('Expected second exclusion receipt');
        version += 1; // A different device committed a newer edit before Undo.
        expect(await undoFollowRuleProjectEdit(second.value.undo)).toEqual({ kind: 'failed', error: 'version_conflict' });
        expect(definition.filter.projects?.exclude).toEqual([project]);
    });

    it('executes the public Account Action through the real family adapter and preserves its result envelope', async () => {
        const env = await setup();
        const { sessionFollowAction } = await import('./sessionFollowApi');
        const { createActionExecutor} = await import('@happier-dev/protocol/actions/actionExecutor');
        const preferences = { assigned: true, direct: false, team: false, group: false };
        env.request.mockImplementation(async () => new Response(JSON.stringify(preferences), { status: 200 }));
        // Unrelated required ports are never reached by this Account Action.
        const executor = createActionExecutor({ sessionFollowAction } as unknown as import('@happier-dev/protocol/actions/executor/types').ActionExecutorDeps);
        await expect(executor.execute('follow.preferences.get', {}, {
            surface: 'ui', authority: 'present_user', serverId: env.target.id, actionCaller: { kind: 'host' },
        })).resolves.toEqual({ ok: true, result: preferences });
    });
});
