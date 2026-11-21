import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pipeline, Readable, Transform, type Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { Fastify } from '../../../server/sources/app/api/types';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { CHANGES_AFTER_CURSOR_HTTP_HEADER, ChangesResponseSchema, CurrentCursorResponseSchema } from '@happier-dev/protocol/changes';
import { readProviderAccountUsageChangedRecordIdsV1 } from '@happier-dev/protocol/changes/providerAccountUsage';
import { CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, CONNECTED_PRESENTATION_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { PROVIDER_ACCOUNT_USAGE_DAY_MS, PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING, ProviderAccountUsageDaySummaryResponseV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import { resolveProviderAccountUsageRecentHistoryRangesV1 } from '@happier-dev/protocol/connect/deriveProviderAccountUsagePace';
import type { QualifiedProviderAccountUsageHistoryResponseV4Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistorySchemasV1';
import { QualifiedConnectedServiceUsageSourceResolutionV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { getUsageQueryKey } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageEventIngestRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from '../../../server/sources/app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4';
import { createUsageSnapshot } from '../../../server/sources/app/api/routes/connect/providerAccountUsageTestkit';
import { accountRoutes } from '../../../server/sources/app/api/routes/account/accountRoutes';
import { registerAuthPingRoute } from '../../../server/sources/app/api/routes/auth/registerAuthPingRoute';
import { changesRoutes } from '../../../server/sources/app/api/routes/changes/changesRoutes';
import { featuresRoutes } from '../../../server/sources/app/api/routes/features/featuresRoutes';
import { sessionPendingRoutes } from '../../../server/sources/app/api/routes/session/pendingRoutes';
import { registerSessionListingRoutes } from '../../../server/sources/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionOrganizationRoutes } from '../../../server/sources/app/api/routes/session/registerSessionOrganizationRoutes';
import { registerSessionReadBatchRoute } from '../../../server/sources/app/api/routes/session/registerSessionReadBatchRoute';
import { kvRoutes } from '../../../server/sources/app/api/routes/kv/kvRoutes';
import { machinesRoutes } from '../../../server/sources/app/api/routes/machines/machinesRoutes';
import { markAccountProjectionChanges, markSessionAccountsChanged } from '../../../server/sources/app/changes/markAccountChanged';
import { createAuthenticatedTestApp } from '../../../server/sources/app/api/testkit/sqliteFastify';
import { enableMonitoring } from '../../../server/sources/app/api/utils/enableMonitoring';
import { db } from '../../../server/sources/storage/db';
import { inTx } from '../../../server/sources/storage/inTx';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '../../../server/sources/testkit/lightSqliteHarness';
import { seedSqliteUsageHistory } from '../../../server/sources/testkit/seedSqliteUsageHistory';
import { installLocalStorageMock, installWebLockManagerMock } from '../auth/storage/tokenStorage.web.testHelpers';
import {
    projectUsagePlans, resolveUsageResetStartBinding, selectUsagePacedWindows, summarizeUsagePlanFit,
} from '../components/settings/usage/widgets/plans/usagePlansModel';
import { projectUsageDailyQuotaHistory } from '../components/settings/usage/widgets/plans/usageDailyQuotaHistoryModel';
import { resolveUsageWidgetQuery } from '../components/settings/usage/widgets/usageWidgetBatch';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore } from '../sync/api/account/usageQueryResource';
import { getServerFeaturesSnapshot } from '../sync/api/capabilities/serverFeaturesClient';
import { installConnectedAccountDescriptorProjection, retireConnectedAccountDescriptorProjection } from '../sync/domains/connectedServices/connectedServiceRegistry';
import { readRegisteredStorageState } from '../sync/domains/state/storageStateReaderBridge';
import { publishHomeAccountChange, subscribeHomeAccountChange, type HomeAccountChangeEvent } from '../sync/runtime/orchestration/homeAccountChange';
import { loadSyncTuning } from '../sync/runtime/syncTuning';
import { restoreServerAccountForTest } from './testkit/harness/serverAccountConnectionHarness';
import { createDeferred } from './testkit/hooks/createDeferred';

vi.mock('react-native', async () => (await import('./testkit/mocks/reactNative')).createReactNativeWebMock());

const DAY = PROVIDER_ACCOUNT_USAGE_DAY_MS;
const WEEK = DAY * 7;
const HOUR = 3_600_000;
const RIG_TIMEOUT_MS = 300_000;
const WAKE_COUNT = 3;

// Retained QA shape. Claude's 25,611 accepted samples cover 8,537 distinct
// reset seconds, with three provider timestamp variants within each second.
const PROVIDERS = [
    { id: 'claude', accountId: 'claude-pro', days: 13, count: 25_611 },
    { id: 'codex', accountId: 'codex-pro', days: 22, count: 9_500, splitRecentRange: true },
    { id: 'codex', accountId: 'codex-work', days: 19, count: 3_088, splitRecentRange: true },
    { id: 'gemini', accountId: 'gemini-work', days: 20, count: 2_000 },
    { id: 'copilot', accountId: 'copilot-work', days: 17, count: 2_000, splitRecentRange: true },
    { id: 'cursor', accountId: 'cursor-work', days: 16, count: 1_500 },
    { id: 'codex', accountId: 'codex-reauth', days: 15, count: 1_001, needsReauth: true },
    { id: 'muse', accountId: 'muse-no-summary', days: 14, count: 300, missingSummary: true },
] as const;

type Provider = typeof PROVIDERS[number];
type SummaryResponse = ReturnType<typeof ProviderAccountUsageDaySummaryResponseV1Schema.parse>;
type HistoryResponse = ReturnType<typeof QualifiedProviderAccountUsageHistoryResponseV4Schema.parse>;
type HistoryTransmission = { observations: number; outsideRange: number; terminalFrames: number };
const RESET_START_READ_PATH = '/v2/pending/reset-starts/read';
type Traffic = Readonly<{
    method: string; path: string; recordId?: string; range?: { startAtMs: number; endAtMs: number };
    afterAtMs?: number; purpose?: string;
    status: number; bytes: number; elapsedMs: number; kind: 'summary' | 'projection' | 'exact' | 'other';
    error?: string;
    days?: readonly { dayStartAtMs: number; packed: boolean; windows: number }[];
    missingDays?: SummaryResponse['missingDays'];
    history?: HistoryTransmission;
}>;

function makeSource(provider: Provider) {
    return { ref: { service: { pluginId: `happier.agent.${provider.id}`, localId: provider.id }, accountId: provider.accountId },
        bindingKind: 'account' as const };
}

function quotaSnapshot(provider: Provider, observedAtMs: number, resetAt: number, used: number) {
    const base = createUsageSnapshot({ fetchedAt: observedAtMs, recordKey: {
        providerId: provider.id, accountSubjectId: provider.accountId, subjectKind: 'account', quotaScope: 'account',
    }, accountLabel: provider.accountId, planLabel: 'Pro', diagnostics: [{ kind: 'provider_http', observedAtMs,
        status: 200, headers: { 'x-request-id': `fixture-${observedAtMs}` } }] });
    return { ...base, state: 'loaded_data' as const, meters: base.meters.map(meter => ({ ...meter, used,
        remaining: 100 - used, utilizationPct: used, usedPct: used, remainingPct: 100 - used, resetsAt: resetAt, windowDurationMs: WEEK })),
    };
}

function retainedHistory(provider: Provider, accountId: string, today: number) {
    return Array.from({ length: provider.count }, (_, index) => {
        const groupSize = provider.id === 'claude' ? 3 : 'missingSummary' in provider ? 15 : 30;
        const ordinal = Math.floor(index / groupSize);
        const groupCount = Math.ceil(provider.count / groupSize);
        const day = today - (provider.days - Math.floor(ordinal * provider.days / groupCount)) * DAY;
        const observedAtMs = day + 12 * HOUR + (index % 2_400) * 15_000;
        const resetAt = provider.id === 'claude' ? day + DAY + ordinal * 1_000 + index % 3 : day + DAY + ordinal * 1_000;
        const accepted = quotaSnapshot(provider, observedAtMs, resetAt, 10 + index % 79);
        // A skewed provider clock can make an older accepted day part of the
        // recent demand, giving this record two disjoint history requests.
        const snapshot = index === 0 && 'splitRecentRange' in provider ? { ...accepted, observedAtMs: today - DAY } : accepted;
        return { accountId, recordId: snapshot.recordId, observedAt: new Date(observedAtMs),
            payload: { accountId, recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1',
                status: 'ok', fetchedAt: observedAtMs, staleAfterMs: snapshot.staleAfterMs, snapshot } };
    });
}

function summarizeTraffic(traffic: readonly Traffic[]) {
    const reads = traffic.filter(row => row.method === 'GET');
    const summarize = (matching: readonly Traffic[]) => {
        return { requests: matching.length, bodies: matching.filter(row => row.bytes > 0).length,
            bytes: matching.reduce((total, row) => total + row.bytes, 0) };
    };
    const byKind = (kind: Traffic['kind']) => summarize(reads.filter(row => row.kind === kind));
    return { httpReads: reads.length, summary: byKind('summary'), projection: byKind('projection'),
        exact: { ...byKind('exact'), observations: reads.reduce((total, row) => total + (row.history?.observations ?? 0), 0) },
        resetStarts: traffic.filter(row => row.method === 'POST' && row.path === RESET_START_READ_PATH).length,
        sourceResolution: summarize(reads.filter(row => row.path.endsWith('/sources/resolve'))),
        currentRecords: summarize(reads.filter(row => row.path.endsWith('/record'))),
        other: byKind('other') };
}

function countSettledQuotaReads(traffic: readonly Traffic[]) {
    return {
        history: traffic.filter(row => row.method === 'GET' && row.path.endsWith('/provider-account-usage/history')).length,
        resetStarts: traffic.filter(row => row.method === 'POST' && row.path === RESET_START_READ_PATH).length,
    };
}

function assertQuotaViewAcquisition(plans: ReturnType<typeof projectUsagePlans>, traffic: readonly Traffic[], nowMs: number, history: boolean) {
    const reads = traffic.filter(row => row.method === 'GET');
    const current = plans.accounts.flatMap(account => account.read?.current ? [account.read] : []);
    const expectedRecordIds = current.map(read => read.current!.recordId).sort();
    const acquired = (rows: readonly Traffic[]) => rows.map(row => row.recordId).sort();
    expect(acquired(reads.filter(row => row.path.endsWith('/sources/resolve')))).toEqual(expectedRecordIds);
    expect(acquired(reads.filter(row => row.path.endsWith('/record')))).toEqual(expectedRecordIds);
    expect(reads.filter(row => row.kind === 'projection')).toEqual([]);
    const summaries = reads.filter(row => row.kind === 'summary');
    const recent = reads.filter(row => row.kind === 'exact');
    expect(acquired(summaries)).toEqual(history ? expectedRecordIds : []);
    const series = history ? projectUsageDailyQuotaHistory(plans.accounts) : [];
    const expectedRecent: { recordId: string; range: NonNullable<Traffic['range']> }[] = [];
    for (const summary of summaries) {
        const read = current.find(candidate => candidate.current?.recordId === summary.recordId)!;
        const facts = read.pageFacts?.dayQuotaHistory ?? [];
        const windows = new Map<number, number>();
        for (const row of series) if (row.account.read?.current?.recordId === summary.recordId) {
            for (const day of row.days) windows.set(day.dayStartAtMs, (windows.get(day.dayStartAtMs) ?? 0) + day.windows.length);
        }
        expect(summary.days?.toSorted((left, right) => left.dayStartAtMs - right.dayStartAtMs), `${summary.recordId} transferred days and windows`).toEqual([...windows].sort(([left], [right]) => left - right)
            .map(([dayStartAtMs, windows]) => ({ dayStartAtMs, packed: true, windows })));
        const expandedBytes = Buffer.byteLength(JSON.stringify({ summaries: facts, missingDays: summary.missingDays ?? [] }));
        expect(summary.bytes, `${summary.recordId} wire bytes versus rendered day facts`).toBeLessThanOrEqual(expandedBytes);
        const selection = resolveProviderAccountUsageRecentHistoryRangesV1({ current: read.current, daySummaries: facts,
            missingDays: summary.missingDays, nowMs });
        if (selection.status === 'available') for (const range of selection.ranges) expectedRecent.push({ recordId: summary.recordId!, range });
    }
    const rangeKey = (row: Pick<Traffic, 'recordId' | 'range'>) => JSON.stringify([row.recordId, row.range?.startAtMs, row.range?.endAtMs]);
    expect(recent.map(rangeKey).sort()).toEqual(expectedRecent.map(rangeKey).sort());
    for (const row of recent) expect(row.history).toMatchObject({ outsideRange: 0, terminalFrames: 1 });
    return series;
}

function measureHistoryFrame(payload: string, range: NonNullable<Traffic['range']>, transmission: HistoryTransmission) {
    const { entries, nextCursor }: HistoryResponse = JSON.parse(payload);
    transmission.observations += entries.length;
    transmission.outsideRange += entries.filter(({ observedAtMs }) => observedAtMs < range.startAtMs || observedAtMs >= range.endAtMs).length;
    if (nextCursor === null) transmission.terminalFrames++;
}

function makeRigHttp(origin: string, token: string) {
    const request = (path: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}) =>
        fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}) });
    return { request, async send<T>(path: string, method: string, body: unknown): Promise<T> {
        const response = await request(path, { method, body });
        const text = await response.text();
        expect(response.ok, `${method} ${path} returned ${response.status}: ${text.slice(0, 400)}`).toBe(true);
        return JSON.parse(text);
    } };
}

function installUsageDescriptors(lifetime: Parameters<typeof installConnectedAccountDescriptorProjection>[1], providers: readonly Provider[]) {
    const descriptors = [...new Map(providers.map(provider => [provider.id, makeSource(provider).ref.service])).values()]
        .map(service => ConnectedAccountUiProjectionEntryV1Schema.parse({ id: service.localId, serviceId: service.localId,
            pluginId: service.pluginId, title: service.localId, provenance: 'external', sourceKind: 'installed', diagnostics: [],
            authentication: { defaultModeId: 'api-key', modes: [{ id: 'api-key', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] },
            capabilities: ['usage'], availability: { state: 'available', reason: 'resolved' } }));
    installConnectedAccountDescriptorProjection({ scopeKey: 'usage-rig-quota', status: 'ready', conflicts: [], errorReason: null, descriptors }, lifetime);
}

async function restoreRigAccount(origin: string, accountId: string, credentials: { token: string },
    request: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['request']> = (input, init) => fetch(input, init)) {
    const home = await restoreServerAccountForTest({ serverUrl: origin, credentials, requestOwnsReachabilityProbes: true,
        request });
    onTestFinished(home.dispose);
    await expect.poll(() => captureUiUsageQueryAccountContext(credentials)?.accountLifetime.scope.accountId,
        { timeout: 20_000 }).toBe(accountId);
    // Scope is admitted before Sync applies the real Home Profile.
    if (readRegisteredStorageState()?.profile.id !== accountId) {
        const { sync } = await import('../sync/sync');
        await sync.refreshProfile();
    }
    expect(readRegisteredStorageState()?.profile.id).toBe(accountId);
    return captureUiUsageQueryAccountContext(credentials)!;
}

describe('Usage RIG: mixed Provider quota at retained-history scale', () => {
    let harness: LightSqliteHarness;
    let app: Fastify;
    let origin: string;
    let closeSocket: (() => Promise<void>) | undefined;
    const socketTransports = new Set<Duplex>();
    const traffic: Traffic[] = [];
    const metadataTraffic: { path: string; bytes: number }[] = [];
    const changesPages: Array<{ after: number; count: number; full: boolean | undefined; recordIds?: readonly string[] }> = [];
    let heldChangesRead: Promise<void> | undefined;
    let onChangesRequest: (() => void) | undefined;
    let beforeSummaryWrite: (() => Promise<void>) | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-rig-quota-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
                HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1', HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED: 'false' } });
        app = createAuthenticatedTestApp({ authentication: 'real', bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 });
        const began = new WeakMap<object, number>();
        app.addHook('onRequest', async request => {
            began.set(request, performance.now());
            if (request.url === '/v2/changes' || request.url.startsWith('/v2/changes?')) {
                onChangesRequest?.();
                await heldChangesRead;
            }
            if (request.method === 'PUT' && request.url === '/v4/connect/qualified/provider-account-usage/day-summaries') {
                await beforeSummaryWrite?.();
            }
        });
        app.addHook('onSend', (request, reply, payload, done) => {
            const url = new URL(request.url, 'http://usage-rig.test');
            if (request.method === 'GET' && typeof payload === 'string' && (url.pathname === '/v1/features'
                || url.pathname === '/v1/account/profile' || url.pathname === CONNECTED_PRESENTATION_ROWS_ROUTE_V1
                || url.pathname === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1)) {
                metadataTraffic.push({ path: url.pathname, bytes: Buffer.byteLength(payload) });
            }
            if (url.pathname === '/v2/changes' && reply.statusCode === 200 && typeof payload === 'string') {
                const page = ChangesResponseSchema.parse(JSON.parse(payload));
                changesPages.push({ after: Number(url.searchParams.get('after') ?? request.headers[CHANGES_AFTER_CURSOR_HTTP_HEADER] ?? 0),
                    count: page.changes.length, full: page.full, recordIds: readProviderAccountUsageChangedRecordIdsV1(page.changes) });
            }
            if (url.pathname.startsWith('/v4/connect/qualified/provider-account-usage') || url.pathname.startsWith('/v2/usage/')
                || url.pathname === RESET_START_READ_PATH) {
                const raw = url.searchParams.get('query');
                const query = raw ? JSON.parse(raw) : null;
                const kind = url.pathname.endsWith('/day-summaries') ? 'summary'
                    : query?.projection ? 'projection' : query?.history ? 'exact' : 'other';
                const successfulBody = request.method === 'GET' && reply.statusCode === 200 && typeof payload === 'string' ? payload : undefined;
                const body: SummaryResponse | null = kind === 'summary' && successfulBody ? JSON.parse(successfulBody) : null;
                const sourceRecordId = url.pathname.endsWith('/sources/resolve') && successfulBody
                    ? QualifiedConnectedServiceUsageSourceResolutionV4Schema.parse(JSON.parse(successfulBody)).recordId : undefined;
                const history: HistoryTransmission | undefined = kind === 'exact' && reply.statusCode === 200
                    && request.headers['x-happier-request-purpose'] !== 'connected-accounts:usage-persistence'
                    ? { observations: 0, outsideRange: 0, terminalFrames: 0 } : undefined;
                const row = { method: request.method, path: url.pathname, recordId: sourceRecordId ?? query?.recordId ?? url.searchParams.get('recordId') ?? undefined,
                    range: query?.history?.range ?? query?.projection?.range ?? query?.range, status: reply.statusCode,
                    afterAtMs: query?.history?.cursor?.observedAtMs, purpose: request.headers['x-happier-request-purpose']?.toString(),
                    bytes: typeof payload === 'string' ? Buffer.byteLength(payload) : Buffer.isBuffer(payload) ? payload.length : 0,
                    elapsedMs: performance.now() - (began.get(request) ?? performance.now()), kind, history,
                    ...(body ? { days: body.summaries.map(({ dayStartAtMs, payload }) => ({ dayStartAtMs,
                        packed: payload.encoding === PROVIDER_ACCOUNT_USAGE_DAY_SUMMARY_ENCODING,
                        windows: payload.content.t === 'plain' ? payload.content.v.windows.length : 0 })),
                        ...(request.headers['x-happier-request-purpose'] !== 'connected-accounts:usage-persistence'
                            ? { missingDays: body.missingDays } : {}) } : {}),
                    ...(reply.statusCode >= 400 && typeof payload === 'string' ? { error: payload.slice(0, 160) } : {}) } satisfies Traffic;
                traffic.push(row);
                if (payload instanceof Readable) {
                    const decoder = history && new StringDecoder('utf8');
                    let partial = '';
                    const measured = new Transform({
                        transform(chunk, _encoding, callback) {
                            row.bytes += Buffer.byteLength(chunk);
                            if (decoder && history) {
                                const lines = (partial + decoder.write(chunk)).split('\n');
                                partial = lines.pop()!;
                                for (const line of lines) if (line) measureHistoryFrame(line, row.range, history);
                            }
                            callback(null, chunk);
                        },
                        flush(callback) {
                            if (decoder && history) {
                                const tail = partial + decoder.end();
                                if (tail) measureHistoryFrame(tail, row.range, history);
                            }
                            callback();
                        },
                    });
                    pipeline(payload, measured, () => {});
                    done(null, measured);
                    return;
                }
                if (history && successfulBody) measureHistoryFrame(successfulBody, row.range, history);
            }
            done(null, payload);
        });
        enableMonitoring(app);
        registerAuthPingRoute(app);
        registerQualifiedConnectedAccountCredentialRoutesV4(app);
        accountRoutes(app);
        sessionPendingRoutes(app);
        registerSessionListingRoutes(app);
        registerSessionOrganizationRoutes(app);
        registerSessionReadBatchRoute(app);
        changesRoutes(app);
        featuresRoutes(app);
        kvRoutes(app);
        machinesRoutes(app);
        const { startSocket } = await import('../../../server/sources/app/api/socket');
        // Only disconnect realtime transports owned by this local Fastify app.
        app.server.on('upgrade', (request, socket) => {
            if (!request.url?.startsWith('/v1/updates/')) return;
            socketTransports.add(socket);
            socket.once('close', () => socketTransports.delete(socket));
        });
        closeSocket = startSocket(app);
        origin = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 120_000);
    afterAll(async () => {
        try { await closeSocket?.(); }
        finally { try { await app?.close(); } finally { await harness?.close(); } }
    });

    it('settles Plans, Capacity, Projections, Resets and Plan Fit and reuses settled quota on provider wakes and reconnect', async () => {
        const { runWithServerHttpBaseUrl } = await import('../../../cli/src/api/client/serverHttpBaseUrl');
        const { maintainProviderAccountUsageDaySummariesForRecord, persistProviderAccountUsageWithDaySummaries } =
            await import('../../../cli/src/daemon/connectedServices/accountUsage/persistence');
        const { writeQualifiedProviderAccountUsageV4 } = await import('../../../cli/src/api/client/qualifiedConnectedAccountApi');
        const locks = installWebLockManagerMock();
        const webStorage = installLocalStorageMock();
        const clockAtStart = Date.now();
        const today = Math.floor(clockAtStart / DAY) * DAY;
        let now = today + 13 * HOUR;
        const lastReset = today + 3 * DAY;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        onTestFinished(() => { clock.mockRestore(); webStorage.restore(); locks.restore(); });
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const accountingSession = await db.session.create({ data: { accountId: account.id, tag: 'quota-rig-accounting',
            encryptionMode: 'plain', metadata: '{}' }, select: { id: true } });
        const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
        const credentials = { token };
        const { request, send } = makeRigHttp(origin, token);
        const ingestAccounting = async (externalKey: string) => {
            const response = await request('/v2/usage-events', {
                method: 'POST',
                body: UsageEventIngestRequestSchema.parse({ sessionId: accountingSession.id,
                    observedAt: now, agentId: 'codex', modelId: 'rig-model-0', source: 'codex_app_server',
                    scope: 'turn_delta', isCumulative: false, externalKey,
                    tokens: { input: 5, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 5 },
                    cost: { reportedUsd: null, estimatedUsd: 0.05, currency: 'USD', costSource: 'pricing_estimate' },
                }),
            });
            expect(response.status).toBe(200);
            await response.json();
            // The HTTP ingest owns ledger rows. The Session publisher supplies
            // their durable accounting wake, just as it does on a real turn.
            await inTx(tx => markSessionAccountsChanged(tx, new Map([[accountingSession.id, [account.id]]])));
        };
        const initial = performance.now();
        const records = [];
        for (const provider of PROVIDERS) {
            const source = makeSource(provider);
            // Include both a proven live pace and providers with incompatible
            // earlier window clocks inside their current window's read range.
            const resetAt = provider.accountId === 'gemini-work' ? today + WEEK : lastReset;
            const current = quotaSnapshot(provider, now, resetAt, 30);
            const { credentialRevision } = await send<{ credentialRevision: string }>('/v4/connect/qualified/credential', 'POST', {
                ref: source.ref, authenticationModeId: 'api-key', expectedCredentialRevision: null, content: { t: 'plain', v: { token: 'test' } },
                metadata: { scopes: [], providerIdentity: { accountId: current.recordKey.accountSubjectId } },
            });
            const write = { source, expectedCredentialRevision: credentialRevision, expectedConfigurationRevision: null, recordId: current.recordId,
                recordKey: current.recordKey, payloadMode: 'plain_json_v1' as const, status: 'ok' as const, snapshot: current,
                fetchedAt: now, staleAfterMs: current.staleAfterMs };
            await runWithServerHttpBaseUrl(origin, async () => {
                const earlier = quotaSnapshot(provider, now - HOUR, resetAt, 20);
                await writeQualifiedProviderAccountUsageV4({ token, write: { ...write, snapshot: earlier, fetchedAt: earlier.fetchedAtMs } });
                await writeQualifiedProviderAccountUsageV4({ token, write });
            });
            // History belongs to the real current record. Seed only its settled
            // predecessor observations without the newer pending-day metadata.
            expect(await seedSqliteUsageHistory(db, retainedHistory(provider, account.id, today))).toBe(provider.count);
            await db.$executeRaw`UPDATE "ProviderAccountUsageRecord" SET "metadata" = json_remove("metadata", '$.daySummaryPendingDays')
                WHERE "accountId" = ${account.id} AND "recordId" = ${current.recordId}`;
            if (!('missingSummary' in provider)) {
                const result = await runWithServerHttpBaseUrl(origin, () => maintainProviderAccountUsageDaySummariesForRecord({
                    token, recordId: current.recordId, accountMode: 'plain', nowMs: now,
                }));
                expect(result, `${provider.accountId}: ${JSON.stringify(traffic.slice(-4))}`).toEqual({ status: 'written', days: provider.days + 1 });
            }
            if ('needsReauth' in provider) await send('/v4/connect/qualified/credential/health', 'PATCH', {
                ref: source.ref, expectedCredentialRevision: credentialRevision, expectedConfigurationRevision: null,
                health: { v: 1, status: 'needs_reauth', reconnectRequired: true, providerErrorCode: 'invalid_grant' },
            });
            records.push({ provider, write });
        }
        console.info('quota-rig producer', JSON.stringify({ records: records.length, seeded: 45_000, elapsedMs: performance.now() - initial,
            traffic: summarizeTraffic(traffic) }));
        const profileResponse = await request('/v1/account/profile');
        expect(profileResponse.status).toBe(200);
        const userProfile = AccountProfileSchema.parse(await profileResponse.json());
        expect(userProfile.connectedAccountsV4).toHaveLength(PROVIDERS.length);
        expect(userProfile.connectedAccountsV4.filter(account => account.status === 'needs_reauth')).toHaveLength(1);
        const context = await restoreRigAccount(origin, account.id, credentials);
        const { accountLifetime } = context;
        const serverId = accountLifetime.scope.serverId;
        installUsageDescriptors(accountLifetime, PROVIDERS);
        await getServerFeaturesSnapshot({ serverId, force: true });
        const store = getUsageQueryResourceStore(context);
        const year = { period: { relative: 'year' as const } };
        const capacity = resolveUsageWidgetQuery(year, {}, 'usage_capacity', false)!.query;
        const projections = resolveUsageWidgetQuery(year, {}, 'usage_projections', false)!.query;
        const resets = resolveUsageWidgetQuery(year, {}, 'usage_resets', false)!.query;
        const planFit = resolveUsageWidgetQuery(year, {}, 'usage_plan_fit', false)!.query;
        const subscriptions: Array<() => void> = [];
        const quotaChanges: Array<{ source: HomeAccountChangeEvent['source']; recordIds?: readonly string[]; day?: number;
            through?: number; historyAfter?: number; accounting?: boolean }> = [];
        const observeChanges = subscribeHomeAccountChange(event => {
            if (event.usageQueryAffects !== false) quotaChanges.push({ source: event.source,
                recordIds: event.providerAccountUsageRecordIds, day: event.providerAccountUsageDayChange?.dayStartAtMs,
                through: event.providerAccountUsageDayChange?.throughCursor,
                historyAfter: event.providerAccountUsageDayChange?.history?.afterCursor, accounting: event.usageAccountingAffects });
        }, { serverIds: [serverId], reconnect: 'refresh' });
        const mount = (queries: readonly typeof capacity[]) => {
            const entry = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries }) });
            subscriptions.push(entry.subscribe(() => {}, true));
            return entry;
        };
        const failures: string[] = [];
        const cell = async (name: string, run: () => void | Promise<void>) => {
            const begin = performance.now();
            const mark = traffic.length;
            const metadataMark = metadataTraffic.length;
            const initialChange = quotaChanges.length;
            try { await run(); }
            catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
            finally {
                const rows = traffic.slice(mark);
                const isDaemon = (row: Traffic) => row.purpose === 'connected-accounts:usage-persistence';
                console.info('quota-rig cell', JSON.stringify({ name, elapsedMs: performance.now() - begin,
                    client: summarizeTraffic(rows.filter(row => !isDaemon(row))), daemon: summarizeTraffic(rows.filter(isDaemon)),
                    metadata: metadataTraffic.slice(metadataMark),
                    changes: quotaChanges.slice(initialChange),
                    failure: failures.find(failure => failure.startsWith(`${name}:`)) }));
            }
        };
        const read = async (entry: ReturnType<typeof mount>, query: typeof capacity) => {
            await expect.poll(() => entry.getSnapshot().pending, { timeout: 120_000 }).toBe('idle');
            const snapshot = entry.getSnapshot();
            expect(snapshot.pending).toBe('idle');
            expect(snapshot.error, snapshot.error && JSON.stringify({ code: snapshot.error.code, message: snapshot.error.message })).toBeUndefined();
            if (!snapshot.value) throw new Error('Usage Resource emitted no payload');
            const slice = decodeUsageQueryResource(snapshot.value).results.find(row => row.key === getUsageQueryKey(query));
            if (!slice) throw new Error('Usage Resource emitted no matching query slice');
            expect(slice.pending).toBe(false);
            expect(slice.sources.filter(state => state.source.startsWith('quota:')).some(state => state.status === 'pending')).toBe(false);
            return slice;
        };
        try {
            const check = async (name: string, query: typeof capacity, verify: (slice: Awaited<ReturnType<typeof read>>, reads: readonly Traffic[]) => void) =>
                cell(name, async () => {
                    const begin = traffic.length;
                    try {
                        const slice = await read(mount([query]), query);
                        verify(slice, traffic.slice(begin));
                    } finally { subscriptions.pop()?.(); }
                });
            await check('Capacity', capacity, (slice, reads) => {
                const plans = projectUsagePlans(slice.quota, now, slice.pools, slice.sources);
                expect(plans.accounts.filter(row => row.windows.length > 0)).toHaveLength(7);
                assertQuotaViewAcquisition(plans, reads, now, false);
            });
            await check('Projections', projections, (slice, reads) => {
                const plans = projectUsagePlans(slice.quota, now, slice.pools, slice.sources);
                const series = assertQuotaViewAcquisition(plans, reads, now, true);
                expect(series).toHaveLength(6);
                const historyUrls = reads.filter(row => row.kind === 'exact' && row.method === 'GET')
                    .map(({ path, recordId, range }) => JSON.stringify([path, recordId, range]));
                expect(historyUrls).toHaveLength(9);
                expect(new Set(historyUrls).size).toBe(9);
                const missing = plans.accounts.find(row => row.accountId === 'muse-no-summary');
                expect(missing?.read?.pageFacts?.historyStatus).not.toBe('complete');
                const claude = plans.accounts.find(row => row.accountId === 'claude-pro')!;
                expect(claude.read?.history).toBeUndefined();
                expect(claude.read?.pageFacts?.historyStatus).toBe('complete');
                expect(selectUsagePacedWindows(plans.accounts).map(row => row.account.accountId)).toContain('gemini-work');
                const claudeSeries = series.find(row => row.account === claude)!;
                const renderedWindows = claudeSeries.days.reduce((count, day) => count + day.windows.length, 0);
                expect(renderedWindows).toBe(8_538);
                const claudeBodies = reads.filter(row => row.kind === 'summary' && row.method === 'GET' && row.recordId === claude.read?.current?.recordId);
                const transferredDays = claudeBodies.flatMap(row => row.days ?? []);
                expect(transferredDays.every(day => day.packed), 'Claude retained days use the compact transport').toBe(true);
                expect(transferredDays.reduce((count, day) => count + day.windows, 0)).toBe(renderedWindows);
                const expandedBytes = Buffer.byteLength(JSON.stringify(claude.read?.pageFacts?.dayQuotaHistory));
                const packedBytes = claudeBodies.reduce((bytes, row) => bytes + row.bytes, 0);
                expect(packedBytes).toBeLessThan(expandedBytes);
                console.info('quota-rig rendered', JSON.stringify({ renderedWindows, packedBytes, expandedBytes }));
            });
            const assertSettledRecentHistory = (slice: Awaited<ReturnType<typeof read>>, reads: readonly Traffic[]) => {
                expect(slice.quota?.filter(row => row.pageFacts?.historyStatus === 'complete')).toHaveLength(6);
                expect(summarizeTraffic(reads).exact).toEqual({ requests: 0, bodies: 0, bytes: 0, observations: 0 });
            };
            await check('Source switch', { ...projections, sources: ['codex'] }, assertSettledRecentHistory);
            await check('Period switch', { ...projections, period: { relative: 'all' } }, assertSettledRecentHistory);
            await check('Resets', resets, (slice, reads) => {
                const plan = projectUsagePlans(slice.quota, now, slice.pools, slice.sources).accounts.find(row => row.accountId === 'claude-pro')!;
                expect(plan.windows[0]?.resetAtMs).toBe(lastReset);
                expect(resolveUsageResetStartBinding(plan, 'weekly', now).status).toBe('available');
                expect(summarizeTraffic(reads).httpReads).toBe(0);
            });
            await check('Plan Fit', planFit, (slice, reads) => {
                const plans = projectUsagePlans(slice.quota, now, slice.pools, slice.sources);
                expect(plans.accounts).not.toHaveLength(0);
                expect(summarizeUsagePlanFit(plans.accounts[0]!, null)).toBeDefined();
                expect(slice.planInsights?.accounts).toHaveLength(7);
                assertSettledRecentHistory(slice, reads);
            });
            let plansEntry: ReturnType<typeof mount> | undefined;
            await cell('Plans', async () => {
                const begin = traffic.length;
                const entry = mount([capacity, projections, resets, planFit]);
                const slice = await read(entry, projections);
                plansEntry = entry;
                expect(slice.quota).toHaveLength(7);
                assertSettledRecentHistory(slice, traffic.slice(begin));
                console.info('quota-rig payload', JSON.stringify({ bytes: plansEntry.getSnapshot().value?.bytes.length,
                    accounts: slice.quota?.map(row => ({ id: row.source.ref.accountId,
                        days: row.pageFacts?.dayQuotaHistory?.length,
                        windows: row.pageFacts?.dayQuotaHistory?.reduce((total, day) => total + day.windows.length, 0) })) }));
            });
            for (let tick = 1; tick <= WAKE_COUNT; tick++) {
                await cell(`Provider wake ${tick}`, async () => {
                    if (!plansEntry) throw new Error('Plans entry is missing');
                    const begin = traffic.length;
                    const changed = records[0]!;
                    const changesBeforeWake = quotaChanges.length;
                    const { sync } = await import('../sync/sync');
                    const pageLimit = loadSyncTuning().changesPageLimit;
                    const changePageStart = changesPages.length;
                    const cursor = async () => CurrentCursorResponseSchema.parse(await (await request('/v2/cursor')).json()).cursor;
                    const before = await cursor();
                    await expect.poll(() => sync.readAppliedAccountChangesCursor(serverId, account.id)).toBe(before);
                    const previousAtMs = now;
                    now += 1_000;
                    const current = quotaSnapshot(changed.provider, now, lastReset, 30 + tick);
                    const persist = () => runWithServerHttpBaseUrl(origin, () => persistProviderAccountUsageWithDaySummaries({ token,
                        write: { ...changed.write, snapshot: current, fetchedAt: now }, nowMs: now }));
                    const seen = () => {
                        const snapshot = plansEntry!.getSnapshot();
                        if (snapshot.pending !== 'idle' || !snapshot.value) return undefined;
                        const record = decodeUsageQueryResource(snapshot.value).results.find(row => row.key === getUsageQueryKey(projections))
                            ?.quota?.find(row => row.current?.recordId === changed.write.recordId);
                        return record?.pageFacts?.historyStatus === 'complete' ? {
                            current: record.current?.meters[0]?.used,
                            day: record.pageFacts.dayQuotaHistory?.find(day => day.dayStartAtMs === today)?.lastSnapshot.meters[0]?.used,
                        } : undefined;
                    };
                    const expected = { current: 30 + tick, day: 30 + tick };
                    const result = tick <= 2 ? await (async () => {
                        const allowSummaryWrite = createDeferred<void>();
                        const allowChanges = createDeferred<void>();
                        if (tick === 2) heldChangesRead = allowChanges.promise;
                        let summaryStarted = false;
                        beforeSummaryWrite = () => {
                            summaryStarted = true;
                            return allowSummaryWrite.promise;
                        };
                        const running = persist();
                        let completed: Awaited<typeof running>;
                        try {
                            await expect.poll(() => summaryStarted, { timeout: 20_000 }).toBe(true);
                            if (tick === 2) {
                                await ingestAccounting('mixed-quota-wake');
                                now += 1;
                                heldChangesRead = undefined;
                                allowChanges.resolve();
                                await expect.poll(() => quotaChanges.slice(changesBeforeWake).some(change => change.accounting === true
                                    && change.day === today && change.recordIds?.length === 1 && change.recordIds[0] === changed.write.recordId)).toBe(true);
                            }
                            await expect.poll(seen, { timeout: 60_000 }).toEqual(expected);
                            expect(traffic.slice(begin).filter(row => row.method === 'GET' && row.kind === 'summary'
                                && row.purpose !== 'connected-accounts:usage-persistence')).toEqual([]);
                        } finally {
                            heldChangesRead = undefined;
                            allowChanges.resolve();
                            beforeSummaryWrite = undefined;
                            allowSummaryWrite.resolve();
                            completed = await running;
                        }
                        return completed;
                    })() : tick === WAKE_COUNT ? await (async () => {
                        // Let actual publications coalesce before the mounted
                        // client's socket-triggered HTTP read reaches the feed.
                        const allowChanges = createDeferred<void>();
                        heldChangesRead = allowChanges.promise;
                        try {
                            await inTx(async tx => {
                                await markAccountProjectionChanges(tx, 'machine', new Map(Array.from({ length: pageLimit - 1 },
                                    (_, index) => [`rig-defunct-machine-${index}`, [account.id]])));
                            });
                            return await persist();
                        } finally {
                            heldChangesRead = undefined;
                            allowChanges.resolve();
                        }
                    })() : await persist();
                    expect(result.dailySummary).toEqual({ status: 'written', days: 1 });
                    const through = await cursor();
                    await expect.poll(() => quotaChanges.slice(changesBeforeWake).some(change => change.through === through),
                        { timeout: 20_000 }).toBe(true);
                    await expect.poll(seen, { timeout: 60_000 }).toEqual(expected);
                    await expect.poll(() => ({
                        pending: plansEntry!.isAllowanceReadPending(),
                        currentDayBodies: traffic.slice(begin).filter(row => row.method === 'GET' && row.kind === 'summary'
                            && row.purpose !== 'connected-accounts:usage-persistence' && row.days?.some(day => day.dayStartAtMs === today)).length,
                    }), { timeout: 20_000 }).toEqual({ pending: false, currentDayBodies: 1 });
                    const clientHistoryReads = traffic.slice(begin).filter(row => row.method === 'GET' && row.status === 200
                        && row.purpose !== 'connected-accounts:usage-persistence' && row.kind !== 'other');
                    const siblingReads = clientHistoryReads.filter(row => row.recordId !== changed.write.recordId);
                    const settledReads = clientHistoryReads.filter(row => row.kind === 'summary'
                        ? row.days?.some(day => day.dayStartAtMs < today)
                        : Math.max(row.afterAtMs ?? 0, row.range?.startAtMs ?? 0) < previousAtMs);
                    const reads = (rows: readonly Traffic[]) => rows.map(({ recordId, kind, bytes, range, afterAtMs }) =>
                        ({ recordId, kind, bytes, range, afterAtMs }));
                    console.info('quota-rig settled history', JSON.stringify({ tick, traffic: summarizeTraffic(clientHistoryReads),
                        siblings: reads(siblingReads), settled: reads(settledReads) }));
                    expect({ siblings: reads(siblingReads), settled: reads(settledReads) }).toEqual({ siblings: [], settled: [] });
                    expect({
                        currentDayBodies: clientHistoryReads.filter(row => row.kind === 'summary' && row.days?.some(day => day.dayStartAtMs === today)).length,
                        sourceResolutions: traffic.slice(begin).filter(row => row.method === 'GET' && row.path.endsWith('/sources/resolve')).length,
                        suffixBodies: clientHistoryReads.filter(row => row.kind === 'exact' && row.history?.terminalFrames === 1).length,
                    }).toEqual({ currentDayBodies: 1, sourceResolutions: 1, suffixBodies: 1 });
                    if (tick === WAKE_COUNT) {
                        expect(changesPages.slice(changePageStart)).toEqual(expect.arrayContaining([
                            { after: before, count: pageLimit - 1, full: true, recordIds: undefined },
                            { after: before + pageLimit - 1, count: 2, full: false, recordIds: [changed.write.recordId] },
                        ]));
                    }
                });
            }
            await cell('Accounting-only wake and idle quota traffic', async () => {
                const begin = traffic.length;
                const changesBeforeWake = quotaChanges.length;
                await ingestAccounting('accounting-only-wake');
                await expect.poll(() => quotaChanges.slice(changesBeforeWake).some(change => change.accounting === true
                    && change.recordIds === undefined)).toBe(true);
                expect(plansEntry?.isAllowanceReadPending()).toBe(false);
                expect(summarizeTraffic(traffic.slice(begin).filter(row => row.path.startsWith('/v4/connect/qualified/provider-account-usage'))).httpReads).toBe(0);
            });
            await cell('Daemon repairs missing summaries', async () => {
                if (!plansEntry) throw new Error('Plans entry is missing');
                const recordsWithoutSummaries = records.filter(record => 'missingSummary' in record.provider);
                for (const record of recordsWithoutSummaries) {
                    const retainedDays = new Set(retainedHistory(record.provider, account.id, today)
                        .map(row => Math.floor(row.observedAt.getTime() / DAY) * DAY));
                    const result = await runWithServerHttpBaseUrl(origin, () => maintainProviderAccountUsageDaySummariesForRecord({
                        token, recordId: record.write.recordId, accountMode: 'plain', nowMs: now,
                    }));
                    expect(result, record.provider.accountId).toEqual({ status: 'written', days: retainedDays.size + 1 });
                    await expect.poll(() => {
                        const snapshot = plansEntry!.getSnapshot();
                        if (!snapshot.value || snapshot.pending !== 'idle') return undefined;
                        return decodeUsageQueryResource(snapshot.value).results.find(row => row.key === getUsageQueryKey(projections))
                            ?.quota?.find(row => row.current?.recordId === record.write.recordId)?.pageFacts?.historyStatus;
                    }, { timeout: 60_000 }).toBe('complete');
                }
            });
            await cell('Reconnect', async () => {
                if (!plansEntry) throw new Error('Plans entry is missing');
                const retained = plansEntry.getSnapshot().value;
                const begin = traffic.length;
                const changePageStart = changesPages.length;
                const { apiSocket } = await import('../sync/api/session/apiSocket');
                const { sync } = await import('../sync/sync');
                await expect.poll(() => socketTransports.size).toBeGreaterThan(0);
                const firstSocketId = apiSocket.getSocketId();
                expect(firstSocketId).toBeTruthy();
                const allowCatchUp = createDeferred<void>();
                let catchUpStarted = false;
                heldChangesRead = allowCatchUp.promise;
                onChangesRequest = () => { catchUpStarted = true; };
                // Observe the real socket callback's promise without starting another resume.
                const resumed = vi.spyOn(sync, 'resumeSync');
                let reconnectObserved = false;
                const release = subscribeHomeAccountChange(event => {
                    if (event.source === 'connected' && event.changesCatchUp) reconnectObserved = true;
                }, { serverIds: [serverId], reconnect: 'refresh' });
                try {
                    for (const socket of socketTransports) socket.destroy();
                    await expect.poll(() => reconnectObserved, { timeout: 20_000 }).toBe(true);
                    expect(apiSocket.getSocketId()).toBeTruthy();
                    expect(apiSocket.getSocketId()).not.toBe(firstSocketId);
                    await expect.poll(() => catchUpStarted, { timeout: 20_000 }).toBe(true);
                    expect(changesPages).toHaveLength(changePageStart);
                    const reconnectRun = resumed.mock.calls.findIndex(([reason]) => reason === 'socket-reconnect');
                    expect(reconnectRun).toBeGreaterThanOrEqual(0);
                    allowCatchUp.resolve();
                    await resumed.mock.results[reconnectRun]!.value;
                    expect(changesPages.slice(changePageStart)).toContainEqual(expect.objectContaining({ count: 0, full: false }));
                    await expect.poll(() => plansEntry!.getSnapshot().pending).toBe('idle');
                    expect(plansEntry.getSnapshot().pending).toBe('idle');
                    expect(plansEntry.getSnapshot().value === retained).toBe(true);
                    expect(summarizeTraffic(traffic.slice(begin)).httpReads).toBe(0);
                } finally {
                    heldChangesRead = undefined;
                    onChangesRequest = undefined;
                    allowCatchUp.resolve();
                    resumed.mockRestore();
                    release();
                }
            });
            const week = { period: { relative: '7days' as const } };
            const weekProjections = resolveUsageWidgetQuery(week, {}, 'usage_projections', false)!.query;
            const weekPlanFit = resolveUsageWidgetQuery(week, {}, 'usage_plan_fit', false)!.query;
            const weekCapacity = resolveUsageWidgetQuery(week, {}, 'usage_capacity', false)!.query;
            const noSettledReads = { history: 0, resetStarts: 0 };
            await cell('Seven-day Account feed settled', async () => {
                const { sync } = await import('../sync/sync');
                const { cursor } = CurrentCursorResponseSchema.parse(await (await request('/v2/cursor')).json());
                await expect.poll(() => sync.readAppliedAccountChangesCursor(serverId, account.id)).toBe(cursor);
            });
            await check('Seven-day cold quota view', weekProjections, (slice, reads) => {
                expect(slice.quota?.some(row => row.pageFacts?.historyStatus === 'complete')).toBe(true);
                const counts = countSettledQuotaReads(reads);
                expect(counts.history).toBeGreaterThan(0);
                expect(counts.resetStarts).toBeGreaterThan(0);
            });
            await check('Seven-day warm quota view switch', weekPlanFit, (slice, reads) => {
                expect(slice.quota?.some(row => row.pageFacts?.historyStatus === 'complete')).toBe(true);
                expect(countSettledQuotaReads(reads)).toEqual(noSettledReads);
            });
            await cell('Seven-day second quota consumer', async () => {
                const first = mount([weekProjections]);
                await read(first, weekProjections);
                const mark = traffic.length;
                const second = mount([weekProjections, weekCapacity]);
                const slice = await read(second, weekProjections);
                expect(slice.quota?.some(row => row.pageFacts?.historyStatus === 'complete')).toBe(true);
                expect(countSettledQuotaReads(traffic.slice(mark))).toEqual(noSettledReads);
            });
            await cell('Seven-day mixed accounting and named quota wake', async () => {
                subscriptions.splice(0).reverse().forEach(dispose => dispose());
                const entry = mount([weekProjections, weekCapacity]);
                await read(entry, weekProjections);
                const { sync } = await import('../sync/sync');
                const before = CurrentCursorResponseSchema.parse(await (await request('/v2/cursor')).json()).cursor;
                await expect.poll(() => sync.readAppliedAccountChangesCursor(serverId, account.id)).toBe(before);
                const begin = traffic.length;
                const changesBeforeWake = quotaChanges.length;
                const changed = records.find(({ provider }) => provider.id === 'muse')!;
                now += 1_000;
                const acceptedAt = now;
                const current = quotaSnapshot(changed.provider, acceptedAt, lastReset, 42);
                const allowChanges = createDeferred<void>();
                heldChangesRead = allowChanges.promise;
                try {
                    await ingestAccounting('seven-day-mixed-wake');
                    await runWithServerHttpBaseUrl(origin, () => persistProviderAccountUsageWithDaySummaries({ token,
                        write: { ...changed.write, snapshot: current, fetchedAt: acceptedAt }, nowMs: acceptedAt }));
                    now += 1;
                } finally {
                    heldChangesRead = undefined;
                    allowChanges.resolve();
                }
                await expect.poll(() => quotaChanges.slice(changesBeforeWake).some(change => change.accounting === true
                    && change.day === today && change.recordIds?.length === 1 && change.recordIds[0] === changed.write.recordId)).toBe(true);
                await expect.poll(() => {
                    const snapshot = entry.getSnapshot();
                    if (snapshot.pending !== 'idle' || !snapshot.value) return undefined;
                    return decodeUsageQueryResource(snapshot.value).results.find(row => row.key === getUsageQueryKey(weekProjections))
                        ?.quota?.find(row => row.current?.recordId === changed.write.recordId)?.current?.meters[0]?.used;
                }, { timeout: 60_000 }).toBe(42);
                const clientReads = traffic.slice(begin).filter(row => row.path.startsWith('/v4/connect/qualified/provider-account-usage')
                    && row.method === 'GET' && row.purpose !== 'connected-accounts:usage-persistence');
                const namedReads = summarizeTraffic(clientReads.filter(row => row.recordId === changed.write.recordId));
                const otherHistory = clientReads.filter(row => row.recordId !== changed.write.recordId && row.kind !== 'other');
                const precedingHistory = clientReads.filter(row => row.kind === 'summary' ? row.days?.some(day => day.dayStartAtMs < today)
                    : // The retained range can end just before the newly accepted sample. Reopen that
                    // gap inside the named day to cover any accepted rows in between.
                    row.kind === 'exact' && Math.max(row.afterAtMs ?? 0, row.range?.startAtMs ?? 0) < today);
                // At retained-history scale the mixed wake went from 5 GETs / 35,695 decoded bytes
                // to 4 GETs / 4,485 bytes. Scope and admitted observations set the assertions below.
                console.info('quota-rig mixed seven-day traffic', JSON.stringify({ namedReads,
                    unnamed: summarizeTraffic(otherHistory), preceding: summarizeTraffic(precedingHistory) }));
                expect({ projection: namedReads.projection, unnamedReads: otherHistory.length, precedingReads: precedingHistory.length }).toEqual({
                    projection: { requests: 0, bodies: 0, bytes: 0 }, unnamedReads: 0, precedingReads: 0,
                });
                expect(namedReads.exact.requests).toBe(1);
                expect(namedReads.exact.observations).toBe(1);
            });
            await cell('Seven-day clock-only quota publication reads only its named current day', async () => {
                subscriptions.splice(0).reverse().forEach(dispose => dispose());
                const entry = mount([weekProjections, weekCapacity]);
                const changed = records.find(({ provider }) => provider.id === 'gemini')!;
                const recordId = changed.write.recordId;
                const currentRow = (slice: Awaited<ReturnType<typeof read>>) => slice.quota?.find(row => row.current?.recordId === recordId);
                const { sync } = await import('../sync/sync');
                const cursor = async () => CurrentCursorResponseSchema.parse(await (await request('/v2/cursor')).json()).cursor;
                const begin = await cursor();
                await expect.poll(() => sync.readAppliedAccountChangesCursor(serverId, account.id)).toBe(begin);
                const previous = currentRow(await read(entry, weekProjections));
                expect(previous?.pageFacts?.historyStatus).toBe('complete');
                expect(previous?.current).toBeDefined();
                const clientQuotaReads = (mark: number) => traffic.slice(mark).filter(row =>
                    row.method === 'GET' && row.path.startsWith('/v4/connect/qualified/provider-account-usage')
                    && row.purpose !== 'connected-accounts:usage-persistence');
                const seen = async () => {
                    const record = currentRow(await read(entry, weekProjections));
                    return { pending: entry.isAllowanceReadPending(), current: record?.current?.observedAtMs,
                        history: record?.pageFacts?.dayQuotaHistory?.find(day => day.dayStartAtMs === today)?.lastSnapshot.observedAtMs };
                };
                const persistQuota = async (used: number) => {
                    const acceptedAt = now += 1_000;
                    const snapshot = quotaSnapshot(changed.provider, acceptedAt, today + WEEK, used);
                    const written = await runWithServerHttpBaseUrl(origin, () => persistProviderAccountUsageWithDaySummaries({
                        token, write: { ...changed.write, snapshot, fetchedAt: acceptedAt }, nowMs: acceptedAt,
                    }));
                    expect(written.dailySummary).toEqual({ status: 'written', days: 1 });
                    return acceptedAt;
                };
                expect(quotaSnapshot(changed.provider, now, today + WEEK, 30).meters).toEqual(previous?.current?.meters);
                const persistClock = () => persistQuota(30);
                const coalesceChanges = async (persist: () => Promise<number>) => {
                    const allowChanges = createDeferred<void>();
                    heldChangesRead = allowChanges.promise;
                    try {
                        return await persist();
                    } finally {
                        heldChangesRead = undefined;
                        allowChanges.resolve();
                    }
                };
                const waitForPage = async (initialChange: number) => {
                    const through = await cursor();
                    await expect.poll(() => quotaChanges.slice(initialChange).some(change => change.through === through
                        && change.day === today && change.recordIds?.length === 1 && change.recordIds[0] === recordId),
                    { timeout: 20_000, message: 'Home delivered the named day' }).toBe(true);
                    await expect.poll(() => sync.readAppliedAccountChangesCursor(serverId, account.id),
                        { timeout: 20_000, message: 'Sync admitted the named change page' }).toBe(through);
                    return quotaChanges.slice(initialChange).filter(change => change.recordIds?.includes(recordId));
                };

                const readCosts = [];
                for (const delivery of ['paired', 'split'] as const) {
                    const mark = traffic.length;
                    const initialChange = quotaChanges.length;
                    let acceptedAt: number;
                    if (delivery === 'paired') {
                        acceptedAt = await coalesceChanges(persistClock);
                    } else {
                        const summaryStarted = createDeferred<void>();
                        const allowSummary = createDeferred<void>();
                        beforeSummaryWrite = () => {
                            summaryStarted.resolve();
                            return allowSummary.promise;
                        };
                        const running = persistClock();
                        try {
                            await Promise.race([summaryStarted.promise, running]);
                            expect(await waitForPage(initialChange)).toHaveLength(1);
                            // The current record can advance before the persisted day summary does.
                            await expect.poll(async () => {
                                const { pending, current } = await seen();
                                return { pending, current };
                            }, { timeout: 20_000, message: 'The observation settles while its summary write is held' })
                                .toEqual({ pending: false, current: now });
                        } finally {
                            beforeSummaryWrite = undefined;
                            allowSummary.resolve();
                            acceptedAt = await running;
                        }
                    }
                    expect(await waitForPage(initialChange)).toHaveLength(delivery === 'paired' ? 1 : 2);
                    await expect.poll(seen, { timeout: 20_000, message: `${delivery} current and history agree` })
                        .toEqual({ pending: false, current: acceptedAt, history: acceptedAt });
                    const reads = clientQuotaReads(mark);
                    const named = summarizeTraffic(reads.filter(row => row.recordId === recordId));
                    const unnamed = summarizeTraffic(reads.filter(row => row.recordId !== recordId));
                    const otherDays = reads.filter(row => {
                        if (row.kind !== 'summary' && row.kind !== 'exact') return false;
                        const start = Math.max(row.afterAtMs ?? 0, row.range?.startAtMs ?? 0);
                        return start < today || (row.range?.endAtMs ?? Infinity) > today + DAY
                            || row.days?.some(day => day.dayStartAtMs !== today)
                            || row.missingDays?.some(day => day.dayStartAtMs !== today);
                    });
                    console.info('quota-rig clock-only traffic', JSON.stringify({
                        delivery, account: changed.provider.accountId, recordId, dayStartAtMs: today, named, unnamed, otherDays,
                    }));
                    readCosts.push({ delivery, named, unnamed, otherDays });
                }

                const beforeGap = await cursor();
                const gapMark = traffic.length;
                const beforeGapChanges = quotaChanges.length;
                let skippedAt = 0;
                let skippedThrough = 0;
                const afterGap = await coalesceChanges(async () => {
                    skippedAt = await persistQuota(31);
                    skippedThrough = await cursor();
                    return persistClock();
                });
                const gapPages = await waitForPage(beforeGapChanges);
                expect(gapPages).toHaveLength(1);
                expect(gapPages[0]?.historyAfter).toBe(skippedThrough);
                expect(skippedThrough).toBeGreaterThan(beforeGap);
                await expect.poll(seen, { timeout: 20_000, message: 'Current and history agree after the missed record update' })
                    .toEqual({ pending: false, current: afterGap, history: afterGap });
                const recoveryReads = clientQuotaReads(gapMark).filter(row => row.recordId === recordId && row.kind === 'exact');
                console.info('quota-rig missed-record recovery', JSON.stringify({ account: changed.provider.accountId,
                    skippedAt, skippedThrough, beforeGap, reads: recoveryReads.map(row => ({ range: row.range, history: row.history })) }));
                expect(recoveryReads.some(row => (row.history?.observations ?? 0) >= 1
                    && Math.max(row.afterAtMs ?? 0, row.range?.startAtMs ?? 0) <= skippedAt
                    && (row.range?.endAtMs ?? Infinity) > skippedAt)).toBe(true);

                subscriptions.splice(0).reverse().forEach(dispose => dispose());
                const unmountedMark = traffic.length;
                const beforeUnmountedChanges = quotaChanges.length;
                await coalesceChanges(persistClock);
                expect(await waitForPage(beforeUnmountedChanges)).toHaveLength(1);
                const unmounted = traffic.slice(unmountedMark).filter(row => row.purpose !== 'connected-accounts:usage-persistence'
                    && (row.method === 'GET' || row.path.startsWith('/v2/usage/') || row.path === RESET_START_READ_PATH));
                const closedCost = { requests: unmounted.length, bytes: unmounted.reduce((total, row) => total + row.bytes, 0) };
                console.info('quota-rig clock-only unmounted traffic', JSON.stringify({
                    account: changed.provider.accountId, dayStartAtMs: today, ...closedCost,
                }));
                for (const { delivery, named, unnamed, otherDays } of readCosts) {
                    expect(named.summary.requests, delivery).toBeLessThanOrEqual(2);
                    // The split observation also sees the pending-day evidence (80 bytes).
                    expect(named.summary.bytes, delivery).toBeLessThanOrEqual(delivery === 'split' ? 3_608 : 3_528);
                    expect(named.exact.requests, delivery).toBeLessThanOrEqual(1);
                    expect(named.exact.bytes, delivery).toBeLessThanOrEqual(delivery === 'split' ? 1_259 : 33);
                    expect(named.projection, delivery).toEqual({ requests: 0, bodies: 0, bytes: 0 });
                    expect(unnamed.httpReads, delivery).toBe(0);
                    expect(otherDays, delivery).toEqual([]);
                }
                expect(closedCost).toEqual({ requests: 0, bytes: 0 });
            });
        } finally {
            observeChanges();
            subscriptions.reverse().forEach(dispose => dispose());
            retireConnectedAccountDescriptorProjection(accountLifetime);
        }
        expect(failures, 'Every quota cell was attempted').toEqual([]);
    }, RIG_TIMEOUT_MS);

    it('retains a settled recent body on fresh demand and rereads a rewritten day through HTTP', async () => {
        const { getProviderAccountUsageQuota } = await import('../sync/api/account/apiProviderAccountUsage');
        const { runWithServerHttpBaseUrl } = await import('../../../cli/src/api/client/serverHttpBaseUrl');
        const { writeQualifiedProviderAccountUsageV4 } = await import('../../../cli/src/api/client/qualifiedConnectedAccountApi');
        const { persistProviderAccountUsageWithDaySummaries } = await import('../../../cli/src/daemon/connectedServices/accountUsage/persistence');
        const account = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
        const { request, send } = makeRigHttp(origin, token);
        const today = Math.floor(Date.now() / DAY) * DAY;
        const yesterday = today - DAY;
        const now = today + 13 * HOUR;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 1_000);
        onTestFinished(() => clock.mockRestore());
        const provider = PROVIDERS[0];
        const source = makeSource(provider);
        const previous = quotaSnapshot(provider, yesterday + 13 * HOUR, today + 3 * DAY, 20);
        const current = quotaSnapshot(provider, now, today + 3 * DAY, 30);
        const { credentialRevision } = await send<{ credentialRevision: string }>('/v4/connect/qualified/credential', 'POST', {
            ref: source.ref, authenticationModeId: 'api-key', expectedCredentialRevision: null,
            content: { t: 'plain', v: { token: 'test' } }, metadata: { scopes: [], providerIdentity: { accountId: current.recordKey.accountSubjectId } },
        });
        const persist = async (snapshot: typeof current) => {
            const persisted = await runWithServerHttpBaseUrl(origin, () => persistProviderAccountUsageWithDaySummaries({ token, nowMs: snapshot.fetchedAtMs,
                write: { source, expectedCredentialRevision: credentialRevision, expectedConfigurationRevision: null, recordId: snapshot.recordId,
                    recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1', status: 'ok', snapshot,
                    fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs } }));
            expect(persisted.dailySummary).toEqual({ status: 'written', days: 1 });
        };
        await persist(previous);
        await persist(current);
        const alias = { ...source, ref: { ...source.ref, accountId: `${source.ref.accountId}-alias` } };
        const aliasCredential = await send<{ credentialRevision: string }>('/v4/connect/qualified/credential', 'POST', {
            ref: alias.ref, authenticationModeId: 'api-key', expectedCredentialRevision: null,
            content: { t: 'plain', v: { token: 'alias' } }, metadata: { scopes: [], providerIdentity: { accountId: current.recordKey.accountSubjectId } },
        });
        await runWithServerHttpBaseUrl(origin, () => writeQualifiedProviderAccountUsageV4({ token, write: {
            source: alias, expectedCredentialRevision: aliasCredential.credentialRevision, expectedConfigurationRevision: null,
            recordId: current.recordId, recordKey: current.recordKey, payloadMode: 'plain_json_v1', status: 'ok', snapshot: current,
            fetchedAt: current.fetchedAtMs, staleAfterMs: current.staleAfterMs,
        } }));
        const documents: import('../sync/api/account/apiProviderAccountUsage').ProviderAccountUsageProjectionDocuments = new Map();
        const read = async (nowMs: number) => {
            const { cursor } = CurrentCursorResponseSchema.parse(await (await request('/v2/cursor')).json());
            const mark = traffic.length;
            const quota = await getProviderAccountUsageQuota({ token }, { source, projection: {
                range: { startAtMs: today - WEEK, endAtMs: nowMs }, resolution: 'accepted_observations',
            } }, { accountMode: 'plain', historyView: 'daily', includePendingWork: false, nowMs, changesCursor: cursor,
                request: (path, init) => fetch(origin + path, init), projectionDocuments: documents });
            expect(quota.pageFacts?.historyStatus).toBe('complete');
            return traffic.slice(mark).filter(row => row.kind === 'exact' && row.method === 'GET');
        };
        const cold = await read(now);
        expect(cold).toHaveLength(1);
        expect(cold[0]?.history).toMatchObject({ observations: 2, terminalFrames: 1 });
        const same = await read(now);
        const later = await read(now + 1_000);
        const { createPresentUserSessionAccessAuthentication } = await import('../../../server/sources/app/session/access/sessionAccessAuthentication.testkit');
        const { createSessionMachineAccessKeyInTx } = await import('../../../server/sources/app/accessKeys/sessionMachineAccessKeyMutations');
        const { enqueuePendingMessage, updatePendingRequestedAction } = await import('../../../server/sources/app/session/pending/pendingMessageService');
        // This case gives the pending machine target a portable Home identity.
        // The composed Account restore cases keep their original anonymous Home.
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', 'srv_01234567890123456789012345678901');
        onTestFinished(() => { vi.unstubAllEnvs(); });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: false } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] }, sessionPendingResetStart: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: account.id, sessionId: session.id, machineId: machine.id, data: 'key' }))).toMatchObject({ ok: true });
        const pending = { actorUserId: account.id, authentication: createPresentUserSessionAccessAuthentication(), sessionId: session.id, localId: randomUUID() };
        const enqueued = await enqueuePendingMessage({ ...pending, targetMachineId: machine.id, requestedAction: { v: 1, kind: 'enqueue' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Usage rig input' } } } });
        expect(enqueued.ok, enqueued.ok ? undefined : JSON.stringify(enqueued)).toBe(true);
        const witness = await db.providerAccountUsageHistory.findFirstOrThrow({ where: { accountId: account.id, recordId: current.recordId,
            observedAt: new Date(previous.fetchedAtMs) }, select: { id: true } });
        expect(await updatePendingRequestedAction({ ...pending, requestedAction: { v: 1, kind: 'reset_start', reset: {
            source, recordId: current.recordId, meterId: current.meters[0]!.meterId, witness: { ...witness, observedAtMs: previous.fetchedAtMs },
        } } })).toMatchObject({ ok: true });
        const readExact = async (nowMs: number, qualifiedSource = source) => {
            const { cursor } = CurrentCursorResponseSchema.parse(await (await request('/v2/cursor')).json());
            const mark = traffic.length;
            const quota = await getProviderAccountUsageQuota({ token }, { source: qualifiedSource, projection: {
                range: { startAtMs: today - WEEK, endAtMs: nowMs }, resolution: 'accepted_observations',
            } }, { accountMode: 'plain', nowMs, changesCursor: cursor,
                request: (path, init) => fetch(origin + path, init), projectionDocuments: documents });
            expect(quota.current?.recordId).toBe(current.recordId);
            expect(quota.pageFacts?.historyStatus).toBe('complete');
            if (quota.waitingWork?.status !== 'available') throw new Error('Pending reset-start reads did not settle');
            expect(quota.waitingWork.entries).toHaveLength(qualifiedSource === alias ? 0 : 1);
            return { counts: countSettledQuotaReads(traffic.slice(mark)), readiness: quota.waitingWork.entries[0]?.readiness };
        };
        const coldExact = await readExact(now + 1);
        expect(coldExact.counts.history).toBeGreaterThan(0);
        expect(coldExact.counts.resetStarts).toBe(1);
        expect(coldExact.readiness).toMatchObject({ status: 'waiting', reason: 'before_reset' });
        const coldAlias = await readExact(now + 1, alias);
        const warmExact = await readExact(now + 1_000);
        const warmAlias = await readExact(now + 1_000, alias);

        const summaryPath = '/v4/connect/qualified/provider-account-usage/day-summaries';
        const query = new URLSearchParams({ query: JSON.stringify({ recordId: current.recordId, range: { startAtMs: yesterday, endAtMs: today } }) });
        const { summaries: [stored] } = ProviderAccountUsageDaySummaryResponseV1Schema.parse(await send(`${summaryPath}?${query}`, 'GET', undefined));
        const payload = stored?.payload;
        if (payload?.content.t !== 'plain' || !payload.content.v.observedAtRange) throw new Error('Expected a settled plain day with clock bounds');
        const { v } = payload.content;
        const observedAtRange = payload.content.v.observedAtRange;
        await send(summaryPath, 'PUT', { recordId: current.recordId, dayStartAtMs: yesterday,
            payload: { ...payload, content: { t: 'plain', v: { ...v, observedAtRange: { ...observedAtRange, startAtMs: observedAtRange.startAtMs - 1 } } } } });
        const rewritten = await read(now + 1_000);
        await persist(quotaSnapshot(provider, now + 250, today + 3 * DAY, 33));
        const late = await read(now + 1_000);
        const changedExact = await readExact(now + 1_000);
        const { pruneProviderAccountUsageSummaryDetail } = await import('../../../server/sources/app/api/routes/connect/providerAccountUsage/daySummaryStorage');
        const beforePrune = CurrentCursorResponseSchema.parse(await (await request('/v2/cursor')).json()).cursor;
        const compacted = await inTx(tx => pruneProviderAccountUsageSummaryDetail({ accountId: account.id, recordId: current.recordId,
            dayStartAtMs: yesterday, cutoff: new Date(today), dryRun: false, limit: 1 }, tx));
        expect(compacted.deleted).toBe(1);
        expect(CurrentCursorResponseSchema.parse(await (await request('/v2/cursor')).json()).cursor).toBe(beforePrune);
        const prunedExact = await readExact(now + 1_000);
        console.info('quota-rig seven-day', JSON.stringify({ coldExact, warmExact, coldAlias, warmAlias, changedExact, prunedExact }));
        const summarize = (rows: readonly Traffic[]) => summarizeTraffic(rows).exact;
        console.info('quota-rig fresh demand', JSON.stringify({ cold: summarize(cold), same: summarize(same), later: summarize(later), rewritten: summarize(rewritten), late: summarize(late) }));
        const selected = (rows: readonly Traffic[]) => rows.map(row => ({ recordId: row.recordId, range: row.range, observations: row.history?.observations }));
        expect({ same: summarize(same), later: summarize(later), rewritten: selected(rewritten), late: selected(late), warmExact: warmExact.counts }).toEqual({
            same: summarize([]), later: summarize([]), rewritten: [{ recordId: current.recordId, range: { startAtMs: yesterday, endAtMs: today }, observations: 1 }],
            late: [{ recordId: current.recordId, range: { startAtMs: today, endAtMs: now + 251 }, observations: 2 }],
            warmExact: { history: 0, resetStarts: 0 },
        });
        expect(coldAlias.counts).toEqual({ history: 0, resetStarts: 1 });
        expect(warmAlias.counts).toEqual({ history: 0, resetStarts: 0 });
        expect(warmExact.readiness).toEqual(coldExact.readiness);
        expect(changedExact.counts.history).toBeGreaterThan(0);
        expect(changedExact.counts.resetStarts).toBe(1);
        expect(prunedExact.counts.history).toBeGreaterThan(0);
        expect(prunedExact.readiness).toMatchObject({ status: 'waiting', reason: 'witness_unavailable' });
    }, 30_000);

    it('reuses the cold Projections admission across actual initial-cursor capture', async () => {
        const webStorage = installLocalStorageMock();
        const releaseCursor = createDeferred<void>();
        onTestFinished(() => { releaseCursor.resolve(); webStorage.restore(); });
        const { runWithServerHttpBaseUrl } = await import('../../../cli/src/api/client/serverHttpBaseUrl');
        const { persistProviderAccountUsageWithDaySummaries } = await import('../../../cli/src/daemon/connectedServices/accountUsage/persistence');
        const account = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
        const { send } = makeRigHttp(origin, token);
        const now = Date.now();
        const source = makeSource(PROVIDERS[0]);
        const snapshot = quotaSnapshot(PROVIDERS[0], now, now + DAY, 30);
        const { credentialRevision } = await send<{ credentialRevision: string }>('/v4/connect/qualified/credential', 'POST', {
            ref: source.ref, authenticationModeId: 'api-key', expectedCredentialRevision: null, content: { t: 'plain', v: { token: 'test' } },
            metadata: { scopes: [], providerIdentity: { accountId: snapshot.recordKey.accountSubjectId } },
        });
        const persisted = await runWithServerHttpBaseUrl(origin, () => persistProviderAccountUsageWithDaySummaries({ token, nowMs: now,
            write: { source, expectedCredentialRevision: credentialRevision, expectedConfigurationRevision: null,
                recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1', status: 'ok', snapshot,
                fetchedAt: now, staleAfterMs: snapshot.staleAfterMs } }));
        expect(persisted.dailySummary).toEqual({ status: 'written', days: 1 });
        let cursorHeld = false;
        let heldHistory: { started: boolean; release: ReturnType<typeof createDeferred<void>> } | undefined;
        const context = await restoreRigAccount(origin, account.id, { token }, (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v2/cursor' && !cursorHeld) {
                cursorHeld = true;
                return releaseCursor.promise.then(() => fetch(input, init));
            }
            const history = heldHistory;
            if (path.endsWith('/day-summaries') && history && !history.started) {
                history.started = true;
                return history.release.promise.then(() => fetch(input, init));
            }
            return fetch(input, init);
        });
        const { accountLifetime } = context;
        const { serverId } = accountLifetime.scope;
        installUsageDescriptors(accountLifetime, [PROVIDERS[0]]);
        await getServerFeaturesSnapshot({ serverId, force: true });
        const homeEvents: Array<Pick<HomeAccountChangeEvent, 'source' | 'entityIds' | 'usageQueryAffects'>> = [];
        const stopObserving = subscribeHomeAccountChange(({ source, entityIds, usageQueryAffects }) => {
            homeEvents.push({ source, entityIds, usageQueryAffects });
        }, { serverIds: [serverId], reconnect: 'refresh' });
        const store = getUsageQueryResourceStore(context);
        try {
            const measure = async (period: 'year' | '30days', trigger: () => void, usageQueryAffects?: false) => {
                const begin = traffic.length;
                const firstEvent = homeEvents.length;
                const hold = { started: false, release: createDeferred<void>() };
                heldHistory = hold;
                const query = resolveUsageWidgetQuery({ period: { relative: period } }, {}, 'usage_projections', false)!.query;
                const entry = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
                const release = entry.subscribe(() => {}, true);
                try {
                    await expect.poll(() => hold.started, { timeout: 20_000 }).toBe(true);
                    expect(cursorHeld).toBe(true);
                    trigger();
                    await expect.poll(() => homeEvents.slice(firstEvent).some(event => event.source === undefined
                        && event.entityIds === undefined && event.usageQueryAffects === usageQueryAffects), { timeout: 20_000 }).toBe(true);
                    hold.release.resolve();
                    await expect.poll(() => entry.getSnapshot().pending, { timeout: 20_000 }).toBe('idle');
                    const value = decodeUsageQueryResource(entry.getSnapshot().value!);
                    expect(value.results[0]?.quota?.[0]?.pageFacts?.historyStatus).toBe('complete');
                    const reads = traffic.slice(begin).filter(row => row.method === 'GET' && row.kind === 'summary');
                    console.info('quota-rig cold cursor', JSON.stringify({ period, summaryReads: reads.length, events: homeEvents.slice(firstEvent) }));
                    return reads.length;
                } finally { hold.release.resolve(); heldHistory = undefined; release(); }
            };
            expect(await measure('year', releaseCursor.resolve, false)).toBe(1);
            // The previous bootstrap producer emitted the same unqualified wake.
            expect(await measure('30days', () => publishHomeAccountChange(serverId))).toBe(2);
        } finally { stopObserving(); retireConnectedAccountDescriptorProjection(accountLifetime); }
    }, 90_000);

    it('settles a connected account that requires reauthentication without requesting history', async () => {
        const webStorage = installLocalStorageMock();
        onTestFinished(webStorage.restore);
        const account = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
        const { send } = makeRigHttp(origin, token);
        const ref = makeSource(PROVIDERS[6]).ref;
        const { credentialRevision } = await send<{ credentialRevision: string }>('/v4/connect/qualified/credential', 'POST', {
            ref, authenticationModeId: 'api-key', expectedCredentialRevision: null, content: { t: 'plain', v: { token: 'test' } },
            metadata: { scopes: [], providerIdentity: { accountId: ref.accountId } },
        });
        await send('/v4/connect/qualified/credential/health', 'PATCH', {
            ref, expectedCredentialRevision: credentialRevision, expectedConfigurationRevision: null,
            health: { v: 1, status: 'needs_reauth', reconnectRequired: true, providerErrorCode: 'invalid_grant' },
        });
        const context = await restoreRigAccount(origin, account.id, { token });
        await getServerFeaturesSnapshot({ serverId: context.accountLifetime.scope.serverId, force: true });
        const query = resolveUsageWidgetQuery({ period: { relative: 'year' } }, {}, 'usage_projections', false)!.query;
        const entry = getUsageQueryResourceStore(context).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
        const begin = traffic.length;
        const release = entry.subscribe(() => {}, true);
        try {
            await expect.poll(() => entry.getSnapshot().value, { timeout: 20_000 }).toBeDefined();
            await expect.poll(() => entry.getSnapshot().pending, { timeout: 20_000 }).toBe('idle');
            const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
            expect(slice.sources).toContainEqual(expect.objectContaining({
                source: 'quota', status: 'error', errorCode: 'connected_account_needs_reauth',
            }));
            expect(traffic.slice(begin).filter(row => row.path.startsWith('/v4/connect/qualified/provider-account-usage'))).toEqual([]);
        } finally { release(); }
    }, 30_000);
});
