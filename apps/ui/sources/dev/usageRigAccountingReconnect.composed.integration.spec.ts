import 'fake-indexeddb/auto';
import { it, expect, onTestFinished, vi } from 'vitest';
import type { Duplex } from 'node:stream';
import { setImmediate as nextTask } from 'node:timers/promises';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { UsageAnalyticsQueryBatchRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { accountRoutes } from '../../../server/sources/app/api/routes/account/accountRoutes';
import { registerAuthPingRoute } from '../../../server/sources/app/api/routes/auth/registerAuthPingRoute';
import { changesRoutes } from '../../../server/sources/app/api/routes/changes/changesRoutes';
import { featuresRoutes } from '../../../server/sources/app/api/routes/features/featuresRoutes';
import { kvRoutes } from '../../../server/sources/app/api/routes/kv/kvRoutes';
import { sessionPendingRoutes } from '../../../server/sources/app/api/routes/session/pendingRoutes';
import { registerSessionListingRoutes } from '../../../server/sources/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionOrganizationRoutes } from '../../../server/sources/app/api/routes/session/registerSessionOrganizationRoutes';
import { createAuthenticatedTestApp } from '../../../server/sources/app/api/testkit/sqliteFastify';
import { enableMonitoring } from '../../../server/sources/app/api/utils/enableMonitoring';
import { db } from '../../../server/sources/storage/db';
import { createAccountTokenForTests, createLightSqliteHarness } from '../../../server/sources/testkit/lightSqliteHarness';
import { installLocalStorageMock } from '../auth/storage/tokenStorage.web.testHelpers';
import { buildUsageAnalyticsViewModel, USAGE_MODEL_MIX_OTHER_KEY } from '../sync/api/account/usageAnalytics';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore } from '../sync/api/account/usageQueryResource';
import { getServerFeaturesSnapshot } from '../sync/api/capabilities/serverFeaturesClient';
import { subscribeHomeAccountChange } from '../sync/runtime/orchestration/homeAccountChange';
import { buildUsageRigPresetPlans } from './testkit/fixtures/usageRigPresets';
import { USAGE_RIG_DAY, USAGE_RIG_NOW } from './testkit/fixtures/usageRigAccounting';
import { allowRealServerSocketBoundary, restoreServerAccountForTest } from './testkit/harness/serverAccountConnectionHarness';
import { createDeferred } from './testkit/hooks/createDeferred';

vi.mock('react-native', async () => (await import('./testkit/mocks/reactNative')).createReactNativeWebMock());

it('preserves accounted model groups and Other across a real Home reconnection without acquiring accounting again', async () => {
    const webStorage = installLocalStorageMock();
    onTestFinished(webStorage.restore);
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-rig-reconnect-', initAuth: true, initEncrypt: true,
        env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED: 'false' } });
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    let closeSocket: (() => Promise<void>) | undefined;
    try {
        enableMonitoring(app);
        registerAuthPingRoute(app);
        accountRoutes(app);
        sessionPendingRoutes(app);
        registerSessionListingRoutes(app);
        registerSessionOrganizationRoutes(app);
        changesRoutes(app);
        featuresRoutes(app);
        kvRoutes(app);
        const transports = new Set<Duplex>();
        app.server.on('upgrade', (request, socket) => {
            if (!request.url?.startsWith('/v1/updates/')) return;
            transports.add(socket);
            socket.once('close', () => transports.delete(socket));
        });
        const { startSocket } = await import('../../../server/sources/app/api/socket');
        closeSocket = startSocket(app);
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        const allowSocket = allowRealServerSocketBoundary(origin);
        try {
            const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
            const now = USAGE_RIG_NOW;
            const session = await db.session.create({ data: { accountId: account.id, tag: 'usage-rig-reconnect',
                encryptionMode: 'plain', metadata: '{}', createdAt: new Date(now - 3 * USAGE_RIG_DAY) }, select: { id: true } });
            await db.usageEvent.createMany({ data: Array.from({ length: 6 }, (_, index) => {
                const tokens = (index + 1) * 10;
                return { accountId: account.id, sessionId: session.id, observedAt: new Date(now - (1 + index % 2) * USAGE_RIG_DAY),
                    externalKey: `rig-reconnect-${index}`, agentId: 'codex', modelId: `rig-model-${index}`, source: 'codex_app_server',
                    scope: 'turn_delta', inputTokens: tokens, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0,
                    cacheWriteTokens: 0, totalTokens: tokens, estimatedCostUsd: tokens / 100, costSource: 'pricing_estimate', currency: 'USD',
                    metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } } };
            }) });
            const credentials = { token: await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' }) };
            const coldCursor = createDeferred<void>();
            onTestFinished(() => coldCursor.resolve());
            let heldCursor = false;
            const accountingRequests: Array<{ issuedAt: number; queries: number; detail: number;
                ranges: Array<{ startMs?: number; endMs?: number }>; sessions: number; status?: number; aborted?: boolean }> = [];
            const home = await restoreServerAccountForTest({ serverUrl: origin, credentials, requestOwnsReachabilityProbes: true,
                request(input, init) {
                    const path = new URL(String(input)).pathname;
                    if (path === '/v2/cursor' && !heldCursor) {
                        heldCursor = true;
                        return coldCursor.promise.then(() => fetch(input, init));
                    }
                    if (path === '/v2/usage/query-batch' && typeof init?.body === 'string') {
                        const body = UsageAnalyticsQueryBatchRequestSchema.parse(JSON.parse(init.body));
                        const observation: typeof accountingRequests[number] = { issuedAt: Date.now(), queries: body.queries.length, detail: body.contributionQueries?.length ?? 0,
                            ranges: body.queries.map(query => query.dateRange ?? {}),
                            sessions: body.queries.reduce((count, query) => count + (query.filters?.sessionIds?.length ?? 0), 0) };
                        accountingRequests.push(observation);
                        return fetch(input, init).then(response => { observation.status = response.status; return response; }, error => {
                            observation.aborted = init.signal?.aborted;
                            throw error;
                        });
                    }
                    return fetch(input, init);
                } });
            try {
                await expect.poll(() => captureUiUsageQueryAccountContext(credentials)?.accountLifetime.scope.accountId,
                    { timeout: 20_000 }).toBe(account.id);
                const context = captureUiUsageQueryAccountContext(credentials)!;
                const { serverId } = context.accountLifetime.scope;
                await getServerFeaturesSnapshot({ serverId, force: true });
                const preset = buildUsageRigPresetPlans(context.accountLifetime.scope, '7days', 'estimated').find(row => row.id === 'usage');
                expect(preset?.plan.input).toBeDefined();
                const entry = getUsageQueryResourceStore(context).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(preset!.plan.input!) });
                const beforeCold = accountingRequests.length;
                const coldEvents: Array<{ receivedAt: number; source?: string; usageAccountingAffects?: boolean; usageQueryAffects?: boolean; changesCatchUp?: true }> = [];
                const stopColdEvents = subscribeHomeAccountChange(({ source, usageAccountingAffects, usageQueryAffects, changesCatchUp }) => {
                    coldEvents.push({ receivedAt: Date.now(), source, usageAccountingAffects, usageQueryAffects, changesCatchUp });
                }, { serverIds: [serverId], reconnect: 'refresh' });
                const release = entry.subscribe(() => {}, true);
                try {
                    await expect.poll(() => accountingRequests.length, { timeout: 20_000 }).toBeGreaterThan(beforeCold);
                    coldCursor.resolve();
                    await expect.poll(() => coldEvents.some(event => event.source === undefined), { timeout: 20_000 }).toBe(true);
                    await expect.poll(() => ({ pending: entry.getSnapshot().pending, showedValue: !!entry.getSnapshot().value }),
                        { timeout: 20_000 }).toEqual({ pending: 'idle', showedValue: true });
                    stopColdEvents();
                    const retained = entry.getSnapshot().value;
                    expect(retained).toBeDefined();
                    const accounting = decodeUsageQueryResource(retained!).results.find(row => row.accounting?.modelTimeline?.length)?.accounting;
                    expect(accounting?.totals).toMatchObject({ eventCount: 6, tokens: { total: 210 } });
                    const { modelMix } = buildUsageAnalyticsViewModel(accounting!, { period: 'all', metric: 'tokens', focus: null, costMode: 'estimated' }, 0);
                    expect(modelMix.keys.map(({ key, totalTokens }) => ({ key, totalTokens }))).toEqual([
                        { key: 'rig-model-5', totalTokens: 60 }, { key: 'rig-model-4', totalTokens: 50 }, { key: 'rig-model-3', totalTokens: 40 },
                        { key: 'rig-model-2', totalTokens: 30 }, { key: 'rig-model-1', totalTokens: 20 }, { key: USAGE_MODEL_MIX_OTHER_KEY, totalTokens: 10 },
                    ]);
                    for (const bucket of modelMix.buckets) expect(bucket.tokens.reduce<number>((sum, tokens) => sum + (tokens ?? 0), 0)).toBe(bucket.total);
                    expect(modelMix.total).toBe(210);
                    expect.soft(accountingRequests.slice(beforeCold), 'cold accounting acquisitions').toHaveLength(1);
                    const ranges = accountingRequests[beforeCold]!.ranges;
                    const current = ranges.find(range => range.startMs !== undefined && range.endMs !== undefined
                        && ranges.some(candidate => candidate.endMs === range.startMs));
                    const comparison = ranges.find(range => range.endMs === current?.startMs);
                    expect(current).toBeDefined();
                    expect(comparison).toEqual({ startMs: 2 * current!.startMs! - current!.endMs!, endMs: current!.startMs });

                    const { apiSocket } = await import('../sync/api/session/apiSocket');
                    await expect.poll(() => transports.size).toBeGreaterThan(0);
                    const initialSocketId = apiSocket.getSocketId();
                    expect(initialSocketId).toBeTruthy();
                    let reconnectObserved = false;
                    const observe = subscribeHomeAccountChange(event => {
                        if (event.source === 'connected' && event.changesCatchUp) reconnectObserved = true;
                    }, { serverIds: [serverId], reconnect: 'refresh' });
                    const beforeReconnect = accountingRequests.length;
                    try {
                        for (const socket of transports) socket.destroy();
                        await expect.poll(() => reconnectObserved, { timeout: 20_000 }).toBe(true);
                        expect(apiSocket.getSocketId()).toBeTruthy();
                        expect(apiSocket.getSocketId()).not.toBe(initialSocketId);
                        await nextTask();
                        expect(entry.getSnapshot().pending).toBe('idle');
                        expect(entry.getSnapshot().value).toBe(retained);
                        expect(accountingRequests.length - beforeReconnect).toBe(0);
                        console.info(JSON.stringify({ kind: 'usage-accounting-reconnect', startupAccountingRequests: accountingRequests.slice(0, beforeCold),
                            coldAccountingRequests: accountingRequests.slice(beforeCold, beforeReconnect), coldEvents,
                            reconnectAccountingRequests: accountingRequests.length - beforeReconnect, events: 6, tokens: modelMix.total,
                            namedSeries: modelMix.keys.length - 1, otherTokens: modelMix.keys.at(-1)?.totalTokens }));
                    } finally { observe(); }

                    const missingQuery = normalizeUsageQuery({ ...preset!.inventory, session: 'missing-usage-rig-session' });
                    const refused = getUsageQueryResourceStore(context).getEntry({ hostRead: 'usage.query',
                        input: projectNativeJsonValueForTransport({ queries: [missingQuery] }) });
                    const releaseRefusal = refused.subscribe(() => {}, false);
                    try {
                        const beforeRefusal = accountingRequests.length;
                        await refused.refresh();
                        const snapshot = refused.getSnapshot();
                        expect(snapshot.pending).toBe('idle');
                        expect(snapshot.error).toMatchObject({ code: 'denied' });
                        expect(snapshot.value).toBeUndefined();
                        expect(accountingRequests.length - beforeRefusal).toBe(1);
                        console.info(JSON.stringify({ kind: 'usage-accounting-refusal', code: 'denied', accountingRequests: accountingRequests.length - beforeRefusal }));
                    } finally { releaseRefusal(); }
                } finally { coldCursor.resolve(); stopColdEvents(); release(); }
            } finally { await home.dispose(); }
        } finally { allowSocket.dispose(); }
    } finally {
        try { await closeSocket?.(); }
        finally { try { await app.close(); } finally { await harness.close(); } }
    }
}, 120_000);
