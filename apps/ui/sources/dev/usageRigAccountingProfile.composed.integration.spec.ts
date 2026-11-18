import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { db } from '../../../server/sources/storage/db';
import { createGeneratedPrismaClient, onDbClientQuery } from '../../../server/sources/storage/prismaClientConstruction';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../server/sources/app/api/testkit/sqliteFastify';
import { accountUsageRoutePaths } from '../../../server/sources/app/api/routes/account/accountUsageRoutePaths';
import { registerAccountUsageRoutes } from '../../../server/sources/app/api/routes/account/registerAccountUsageRoutes';
import { registerAccountEncryptionRoutes } from '../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { kvRoutes } from '../../../server/sources/app/api/routes/kv/kvRoutes';
import { registerSessionSystemRecordRoutes } from '../../../server/sources/app/api/routes/session/registerSessionSystemRecordRoutes';
import { captureUsageAnalyticsBatchInTx, getUsageAnalyticsPopulationKey, getUsageAnalyticsProjectionKey } from '../../../server/sources/app/usage/query/readUsageAnalyticsBatch';
import { readDatabaseTransactionConfigFromEnv } from '../../../server/sources/config/databaseTransactions';
import { databaseQueryDurationHistogram } from '../../../server/sources/app/monitoring/metrics/databaseDriverMetrics';
import { initializeSessionSystemRecordsProtocolV1Activation, resetSessionSystemRecordsProtocolV1ActivationForTests } from '../../../server/sources/app/session/systemRecords/sessionSystemRecordProtocolContract';
import { getUsageQueryKey, resolveUsageQueryPeriod, usageQueryNeedsContributionRows, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { readUsageContributionProjection, resolveEffectiveUsageCostUsd } from '@happier-dev/protocol/usage/usageCost';
import { getUsageAnalyticsQueryRequestKey, UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryBatchResponseSchema,
    type UsageAnalyticsQueryBatchRequest, type UsageAnalyticsQueryBatchResponse, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { resolveUsageBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
import { summarizeUsageWork } from '../components/settings/usage/widgets/usageWorkPresentation';
import { buildUsageAnalyticsViewModel } from '../sync/api/account/usageAnalytics';
import type { UsageQueryAccountContext } from '../sync/api/account/usageQueryResource';
import type { UsagePeriod } from '../sync/api/account/usagePeriods';
import { upsertServerProfile } from '../sync/domains/server/serverProfiles';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '../sync/api/capabilities/serverFeaturesClient';
import { TokenStorage } from '../auth/storage/tokenStorage';
import { installLocalStorageMock, installWebLockManagerMock } from '../auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from './testkit/fixtures/featureFixtures';
import { seedUsageRigAccountingRows, USAGE_RIG_NOW } from './testkit/fixtures/usageRigAccounting';
import { buildUsageRigPresetPlans } from './testkit/fixtures/usageRigPresets';

type RequestObservation = {
    status: number;
    bytes: number;
    chunks: number;
    headersMs: number;
    bodyAwaitMs: number;
    decodeAndAdmitMs: number;
    server: Record<string, number>;
    driver?: { statements: number; durationMs: number };
    delivery?: { catalogBytes: number; groupedBytes: number; detailBytes: number; groupedResults: number; exactInputs: number; censusMs: number };
    demand: { queries: number; populations: number; coordinates: number; detail: number; sessions: number; compact: boolean; projection: string | null };
};

const periods = ['year', '7days', '30days'] as const satisfies readonly UsagePeriod[];
const costBases = ['auto', 'estimated'] as const satisfies readonly UsageQuery['costBasis'][];
const tokenFields = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total'] as const;

/** Inspect the admitted NDJSON without reopening the stream or retaining row bodies. */
function observeAccountingDelivery(input: UsageAnalyticsQueryBatchRequest, eventTimes: ReadonlyMap<string, number>) {
    const queries = new Set(input.queries.map(getUsageAnalyticsQueryRequestKey));
    const detail = new Set((input.contributionQueries ?? []).map(getUsageAnalyticsQueryRequestKey));
    const delivered = new Set<string>();
    const exactInputs = new Map([...detail].map(key => [key, new Set<string>()]));
    const counts = { catalogBytes: 0, groupedBytes: 0, detailBytes: 0, groupedResults: 0, exactInputs: 0, censusMs: 0 };
    const errors = new Set<string>();
    let opened = false;
    return { counts, errors, record: (wire: unknown, batch: UsageAnalyticsQueryBatchResponse) => {
        const started = performance.now();
        // Fastify writes one minified JSON record plus a newline. Count only records
        // that carry authorized units. The network byte counter observes the full body independently.
        const bytes = Buffer.byteLength(JSON.stringify(wire)) + 1;
        if (batch.results.length) {
            let allowed = opened && !batch.priceCatalog && !batch.contributionPages;
            for (const result of batch.results) {
                const key = getUsageAnalyticsQueryRequestKey(result.query);
                if (!queries.has(key) || delivered.has(key)) allowed = false;
                delivered.add(key);
                if ('value' in result) {
                    const { query, value } = result;
                    if (value.contributions !== undefined || Object.values(value.breakdowns ?? {})
                        .some(groups => groups && groups.length > query.topLimit + 1)) allowed = false;
                    for (const buckets of [value.series, value.modelTimeline, value.engineTimeline]) {
                        if (!buckets) continue;
                        if (new Set(buckets.map(bucket => bucket.bucketStartMs)).size !== buckets.length || buckets.some(bucket => {
                            const canonical = resolveUsageBucketBounds(query.granularity, bucket.bucketStartMs, query.timeZoneOffsetMinutes);
                            return bucket.bucketStartMs !== canonical.bucketStartMs || bucket.bucketEndMs !== canonical.bucketEndMs
                                || bucket.bucketEndMs <= (query.dateRange?.startMs ?? -Infinity)
                                || bucket.bucketStartMs >= (query.dateRange?.endMs ?? Infinity);
                        })) allowed = false;
                    }
                }
            }
            if (allowed) counts.groupedBytes += bytes;
            else errors.add('unexpected grouped result, raw rows, calendar buckets or named/Other ranks');
        } else if (batch.contributionPages) {
            let allowed = opened && !batch.priceCatalog;
            for (const page of batch.contributionPages) {
                const key = getUsageAnalyticsQueryRequestKey(page.query);
                const pageInputs = exactInputs.get(key);
                if (!pageInputs) { allowed = false; continue; }
                for (const row of page.rows) {
                    const observedAt = eventTimes.get(row.id);
                    if (observedAt !== row.observedAtMs || pageInputs.has(row.id)
                        || observedAt < (page.query.dateRange?.startMs ?? -Infinity)
                        || observedAt >= (page.query.dateRange?.endMs ?? Infinity)) { allowed = false; continue; }
                    pageInputs.add(row.id);
                    counts.exactInputs++;
                }
            }
            if (allowed) counts.detailBytes += bytes;
            else errors.add('unexpected or duplicated exact contribution input');
        } else if (!opened && Boolean(batch.priceCatalog) === input.queries.some(query => query.includePriceCatalog === true)) {
            opened = true;
            counts.catalogBytes = bytes;
        } else {
            errors.add('unexpected repeated accounting catalog or empty record');
        }
        counts.groupedResults = delivered.size;
        counts.censusMs += performance.now() - started;
    } };
}

const deliveryScope = new AsyncLocalStorage<ReturnType<typeof observeAccountingDelivery>>();

function observeAccountingBoundary(): () => void {
    const safeParse = UsageAnalyticsQueryBatchResponseSchema.safeParse;
    const observation = vi.spyOn(UsageAnalyticsQueryBatchResponseSchema, 'safeParse').mockImplementation((wire, options) => {
        const admitted = safeParse(wire, options);
        if (admitted.success) deliveryScope.getStore()?.record(wire, admitted.data);
        return admitted;
    });
    return () => observation.mockRestore();
}

function observeAccountingDriverStatements(app: ReturnType<typeof createAuthenticatedTestApp>): () => void {
    const requestTiming = new AsyncLocalStorage<NonNullable<RequestObservation['driver']>>();
    const observe = databaseQueryDurationHistogram.observe;
    const observation = vi.spyOn(databaseQueryDurationHistogram, 'observe').mockImplementation((...args: unknown[]) => {
        const timing = requestTiming.getStore();
        const durationMs = args.at(-1);
        if (timing && typeof durationMs === 'number') {
            timing.statements++;
            timing.durationMs += durationMs;
        }
        // Observe the real adapter timings without replacing the metrics sink.
        Reflect.apply(observe, databaseQueryDurationHistogram, args);
    });
    app.addHook('onRequest', (request, _reply, done) => {
        if (request.routeOptions.url !== accountUsageRoutePaths.analyticsQueryBatch) return done();
        requestTiming.run({ statements: 0, durationMs: 0 }, done);
    });
    app.addHook('onSend', (_request, reply, payload, done) => {
        const timing = requestTiming.getStore();
        if (timing) {
            reply.header('x-usage-rig-driver-statements', String(timing.statements));
            reply.header('x-usage-rig-driver-ms', String(timing.durationMs));
        }
        done(null, payload);
    });
    return () => observation.mockRestore();
}

function verifyAccountingGroups(accounting: UsageAnalyticsQueryResponse, query: UsageQuery): string[] {
    const failures: string[] = [];
    for (const dimension of query.breakdown) {
        if (!accounting.coverage?.ranked.some(rank => rank.dimension === dimension && rank.complete)) continue;
        const groups = accounting.breakdowns?.[dimension] ?? [];
        if (groups.reduce((total, group) => total + group.eventCount, 0) !== accounting.totals.eventCount) {
            failures.push(`${dimension} groups did not partition accounted events`);
        }
        for (const field of tokenFields) {
            if (groups.reduce((total, group) => total + (group.tokens[field] ?? 0), 0) !== (accounting.totals.tokens[field] ?? 0)) {
                failures.push(`${dimension} groups did not conserve ${field} tokens`);
            }
        }
    }
    if (query.metric === 'tokens' && accounting.modelTimeline?.length && accounting.coverage?.ranked.some(rank => rank.dimension === 'model' && rank.complete)) {
        const { modelMix } = buildUsageAnalyticsViewModel(accounting, { period: 'all', metric: 'tokens', focus: null, costMode: query.costBasis }, query.timeZoneOffsetMinutes);
        if (modelMix.keys.reduce((total, key) => total + (key.totalTokens ?? 0), 0) !== accounting.totals.tokens.total
            || modelMix.buckets.some(bucket => bucket.tokens.reduce<number>((total, tokens) => total + (tokens ?? 0), 0) !== (bucket.total ?? 0))) {
            failures.push('model timeline groups and Other did not conserve tokens');
        }
    }
    return failures;
}

function observeAccountingResponse(response: Response, observation: RequestObservation): Response {
    const body = response.body;
    if (!body) return response;
    const acquire = body.getReader.bind(body);
    Object.defineProperty(body, 'getReader', { value: () => {
        const reader = acquire();
        const read = reader.read.bind(reader);
        reader.read = async () => {
            const started = performance.now();
            const result = await read();
            observation.bodyAwaitMs += performance.now() - started;
            if (result.value) {
                observation.bytes += result.value.byteLength;
                observation.chunks++;
            }
            return result;
        };
        return reader;
    } });
    return response;
}

function makeContext(origin: string, credentials: UsageQueryAccountContext['credentials'],
    scope: UsageQueryAccountContext['accountLifetime']['scope'], observations: RequestObservation[], eventTimes?: ReadonlyMap<string, number>) {
    let current = true;
    const settlements: Promise<void>[] = [];
    let batch: UsageAnalyticsQueryBatchRequest | undefined;
    const deliveryErrors = new Set<string>();
    const retireListeners = new Set<() => void>();
    const accountLifetime: UsageQueryAccountContext['accountLifetime'] = {
        scope, isCurrent: () => current,
        onRetire(cancel) {
            retireListeners.add(cancel);
            return { dispose() { retireListeners.delete(cancel); } };
        },
    };
    const request: UsageQueryAccountContext['request'] = async (path, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${credentials.token}`);
        return fetch(new URL(path, origin), { ...init, headers });
    };
    const context: UsageQueryAccountContext = { credentials, accountLifetime, request,
        readTransport: { scope: {}, serverId: scope.serverId, key: `usage-rig-profile:${scope.accountId}`,
            async read(path, init, options, consume) {
                const started = performance.now();
                options?.onIssued?.();
                const response = await request(path, init);
                if (path !== accountUsageRoutePaths.analyticsQueryBatch) return consume(response);
                const input = batch = UsageAnalyticsQueryBatchRequestSchema.parse(JSON.parse(String(init?.body)));
                const driverStatements = response.headers.get('x-usage-rig-driver-statements');
                const driverMs = response.headers.get('x-usage-rig-driver-ms');
                const observation: RequestObservation = {
                    status: response.status, bytes: 0, chunks: 0, headersMs: performance.now() - started,
                    bodyAwaitMs: 0, decodeAndAdmitMs: 0,
                    server: Object.fromEntries((response.headers.get('server-timing') ?? '').split(',').flatMap(header => {
                        const [name, duration] = header.trim().split(';dur=');
                        return name && duration ? [[name, Number(duration)]] : [];
                    })),
                    ...(driverStatements !== null && driverMs !== null
                        ? { driver: { statements: Number(driverStatements), durationMs: Number(driverMs) } } : {}),
                    demand: { queries: input.queries.length,
                        populations: new Set(input.queries.map(getUsageAnalyticsPopulationKey)).size,
                        coordinates: new Set(input.queries.map(getUsageAnalyticsProjectionKey)).size,
                        detail: input.contributionQueries?.length ?? (input.includeContributions ? input.queries.length : 0),
                        sessions: input.sessionQueries?.length ?? 0, compact: input.contributionQueries !== undefined,
                        projection: readUsageContributionProjection(new Headers(init?.headers).get('Accept')) ?? null },
                };
                observations.push(observation);
                const consumeStarted = performance.now();
                const delivery = eventTimes && input.contributionQueries !== undefined ? observeAccountingDelivery(input, eventTimes) : undefined;
                const observed = observeAccountingResponse(response, observation);
                const pending = delivery ? deliveryScope.run(delivery, () => consume(observed)) : consume(observed);
                const observeSettlement = () => {
                    observation.decodeAndAdmitMs = performance.now() - consumeStarted - observation.bodyAwaitMs - (delivery?.counts.censusMs ?? 0);
                    if (!delivery) return;
                    observation.delivery = delivery.counts;
                    for (const error of delivery.errors) deliveryErrors.add(error);
                };
                settlements.push(pending.then(observeSettlement, observeSettlement));
                return pending;
            },
        },
    };
    return { context, deliveryErrors, readBatch: () => batch, settleTransport: () => Promise.all(settlements), retire() {
        current = false;
        for (const cancel of retireListeners) cancel();
        retireListeners.clear();
    } };
}

async function openAccount(origin: string, accountId: string) {
    const locks = installWebLockManagerMock();
    const webStorage = installLocalStorageMock();
    onTestFinished(() => { webStorage.restore(); locks.restore(); });
    const profile = await upsertServerProfile({ serverUrl: origin, name: 'Usage accounting profile', source: 'manual' });
    const scope = { serverId: profile.id, accountId };
    const credentials = { token: await createAccountTokenForTests(accountId, { kind: 'account', authority: 'present_user' }) };
    expect(await TokenStorage.setCredentialsForServerUrl(origin, { serverId: scope.serverId }, credentials)).toBe(true);
    return { scope, credentials };
}

function selectTransport(serverId: string, compact: boolean) {
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready',
        features: createRootLayoutFeaturesResponse({ features: { usage: { compactBatch: { enabled: compact } } } }),
    } });
}

/** Capture the canonical SQLite read on an observed connection outside the timed HTTP measurement. */
async function observeSqliteRead(accountId: string, batch: UsageAnalyticsQueryBatchRequest) {
    const driverStatementMs: number[] = [];
    const { client: sqlite } = await createGeneratedPrismaClient('sqlite', undefined, {
        log: [{ emit: 'event', level: 'query' }], observeStatementDurationMs: duration => { driverStatementMs.push(duration); },
    });
    const statements: Array<{ query: string; params: string }> = [];
    onDbClientQuery(sqlite, event => {
        if (event.query.startsWith('SELECT') && event.query.includes('UsageEvent')) statements.push(event);
    });
    try {
        // This observation owns the seeded test database's idle connection. An
        // isolated observation doesn't add Prisma query logging to timed reads.
        const { timeoutMs } = readDatabaseTransactionConfigFromEnv(process.env, 'sqlite');
        const captureStarted = performance.now();
        const captured = await sqlite.$transaction(tx => captureUsageAnalyticsBatchInTx(tx, accountId, batch.queries, undefined, batch),
            { timeout: timeoutMs });
        const captureMs = performance.now() - captureStarted;
        const driver = { statements: driverStatementMs.length, durationMs: driverStatementMs.reduce((total, duration) => total + duration, 0) };
        const bodyRows = new Set([...captured.snapshots.values()].flatMap(snapshot => snapshot.rows.map(row => row.id))).size;
        const evidenceRows = Math.max(...[...captured.snapshots.values()].map(snapshot => snapshot.evidenceRows?.length ?? 0));
        const shape = (query: string) => /\bid["\x60]\s+IN\s*\(/u.test(query) ? 'body-by-id'
            : query.includes('inputTokens') ? 'body-range' : 'evidence-range';
        const byShape = new Map(statements.map(statement => [shape(statement.query), statement]));
        const plans = await Promise.all([...byShape].map(async ([kind, statement]) => {
            const params: unknown = JSON.parse(statement.params);
            if (!Array.isArray(params)) throw new Error('Expected SQLite statement bind array');
            const plan = await sqlite.$queryRawUnsafe<Array<{ detail: string }>>(`EXPLAIN QUERY PLAN ${statement.query}`, ...params);
            const matching = statements.filter(event => shape(event.query) === kind);
            return { kind, statements: matching.length, detail: plan.map(step => step.detail) };
        }));
        console.info(JSON.stringify({ kind: 'usage-accounting-sqlite-plan', view: 'sources', bodyRows, evidenceRows, captureMs, driver, plans }));
        expect(bodyRows).toBe(45_000);
        expect(evidenceRows).toBe(45_000);
        expect(plans.map(({ kind, statements }) => ({ kind, statements }))).toEqual([
            { kind: 'evidence-range', statements: 1 }, { kind: 'body-range', statements: 1 },
        ]);
    } finally { await sqlite.$disconnect(); }
}

describe('Usage RIG accounting phase census', () => {
    let harness: LightSqliteHarness;
    let accountId: string;
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    let origin: string;
    let stopObservingDriver: (() => void) | undefined;
    let stopObservingDelivery: (() => void) | undefined;
    const seededTotals = new Map<UsagePeriod, { eventCount: number; tokens: number }>();
    const eventTimes = new Map<string, number>();
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-rig-profile-', initAuth: true, env: { METRICS_ENABLED: 'true' } });
        await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        accountId = account.id;
        const sessions = await Promise.all(['claude', 'codex'].map(agent => db.session.create({
            data: { accountId, tag: `usage-rig-profile-${agent}`, encryptionMode: 'plain', metadata: '{}' }, select: { id: true },
        })));
        const rows = seedUsageRigAccountingRows(accountId, sessions[0]!.id, sessions[1]!.id);
        for (const period of periods) {
            const { startMs, endMs } = resolveUsageQueryPeriod({ period: { relative: period }, timeZoneOffsetMinutes: 0 }, USAGE_RIG_NOW + 1);
            let eventCount = 0;
            let tokens = 0;
            for (const row of rows) {
                const at = row.observedAt.getTime();
                if (at < (startMs ?? -Infinity) || at >= (endMs ?? Infinity)) continue;
                eventCount++;
                tokens += row.totalTokens;
            }
            seededTotals.set(period, { eventCount, tokens });
        }
        for (let offset = 0; offset < rows.length; offset += 1_000) await db.usageEvent.createMany({ data: rows.slice(offset, offset + 1_000) });
        for (const row of await db.usageEvent.findMany({ where: { accountId }, select: { id: true, observedAt: true } })) {
            eventTimes.set(row.id, row.observedAt.getTime());
        }
        app = createAuthenticatedTestApp({ authentication: 'real' });
        stopObservingDriver = observeAccountingDriverStatements(app);
        stopObservingDelivery = observeAccountingBoundary();
        registerAccountUsageRoutes(app);
        registerAccountEncryptionRoutes(app);
        kvRoutes(app);
        registerSessionSystemRecordRoutes(app);
        origin = await app.listen({ port: 0, host: '127.0.0.1' });
    }, 120_000);
    afterAll(async () => {
        try {
            if (app) await app.close();
        } finally {
            stopObservingDelivery?.();
            stopObservingDriver?.();
            resetSessionSystemRecordsProtocolV1ActivationForTests();
            if (harness) await harness.close();
        }
    });

    const cases = periods.flatMap(period => costBases.map(costBasis => ({ period, costBasis })));
    it.each(cases)('profiles canonical $period/$costBasis presets over loopback', async ({ period, costBasis }) => {
        const readUiUsageQueryBatch = (await import('../sync/api/account/usageQueryResource')).readUiUsageQueryBatch;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(USAGE_RIG_NOW + 1);
        const failures: Array<{ view: string; compact: boolean; error: string }> = [];
        let sqliteProbe: UsageAnalyticsQueryBatchRequest | undefined;
        const profileLegacy = period === 'year' && costBasis === 'auto';
        try {
            const { scope, credentials } = await openAccount(origin, accountId);
            const selectedViews = process.env.HAPPIER_USAGE_RIG_PROFILE_VIEWS?.split(',');
            const plans = buildUsageRigPresetPlans(scope, period, costBasis).filter(plan => !selectedViews || selectedViews.includes(plan.id));
            if (selectedViews) expect(plans.map(plan => plan.id).sort()).toEqual([...selectedViews].sort());
            const presentationPlans = (['tokens', 'cost'] as const).map(metric => ({ metric,
                plans: new Map(buildUsageRigPresetPlans(scope, period, costBasis, metric).map(view => [view.id, view.plan])) }));
            for (const compact of profileLegacy ? [true, false] : [true]) {
                selectTransport(scope.serverId, compact);
                for (const { id: view, plan, inventory } of plans.filter(plan => compact || plan.id === 'sources')) {
                    const observations: RequestObservation[] = [];
                    const { context, deliveryErrors, readBatch, settleTransport, retire } = makeContext(origin, credentials, scope, observations, eventTimes);
                    const input = plan.input!;
                    const started = performance.now();
                    let projectMs = 0;
                    let projects = 0;
                    let pendingProjection: Promise<void> | undefined;
                    let latestProjection: (() => void) | undefined;
                    const metrics = [...new Set(input.queries.map(query => `${query.metric}/${query.costBasis}`))];
                    const needsContributionRows = input.queries.some(query => query.includeAccounting && usageQueryNeedsContributionRows(query));
                    let slices: unknown;
                    let observedCold = false;
                    try {
                        const result = await readUiUsageQueryBatch(context, input, undefined, undefined, { onProgress(reproject) {
                            // A finite read's consumer may select a projection on progress. Queue only
                            // the latest available closure and account for the actual projection call.
                            latestProjection = () => {
                                const projectionStarted = performance.now();
                                reproject(undefined);
                                projectMs += performance.now() - projectionStarted;
                                projects++;
                            };
                            return pendingProjection ??= Promise.resolve().then(() => {
                                pendingProjection = undefined;
                                latestProjection?.();
                                latestProjection = undefined;
                            });
                        } });
                        const elapsedMs = performance.now() - started;
                        await settleTransport();
                        const byKey = new Map(result.results.map(slice => [slice.key, slice]));
                        const inventoryAccounting = byKey.get(getUsageQueryKey(inventory))?.accounting;
                        const expected = seededTotals.get(period)!;
                        if (inventoryAccounting?.totals.eventCount !== expected.eventCount
                            || inventoryAccounting.totals.tokens.total !== expected.tokens) {
                            failures.push({ view, compact, error: `period inventory did not conserve ${expected.eventCount} events and ${expected.tokens} tokens` });
                        }
                        const shapeCensusStarted = performance.now();
                        const namedProjects = new Set<string>();
                        let workPresentationMs: number | undefined;
                        slices = input.queries.map(query => {
                            const slice = byKey.get(getUsageQueryKey(query));
                            const accountingStatus = slice?.sources.find(source => source.source === 'accounting');
                            if (!slice || slice.pending || query.includeAccounting && (!slice.accounting || accountingStatus?.status === 'error')) {
                                failures.push({ view, compact, error: accountingStatus?.errorCode ?? 'accounting slice did not settle' });
                            }
                            const accounting = slice?.accounting;
                            // These fixtures have no named Projects. Other tabs use their own Work presenters.
                            let work: ReturnType<typeof summarizeUsageWork> | undefined;
                            if (view === 'work' && slice?.work) {
                                const workStarted = performance.now();
                                work = summarizeUsageWork(slice.work, query, namedProjects);
                                workPresentationMs = (workPresentationMs ?? 0) + (performance.now() - workStarted);
                            }
                            const coachFindings = slice?.coach?.findings.map(finding => ({
                                detector: finding.detectorId,
                                observations: finding.evidence.length,
                                seriesPoints: finding.evidenceSeries?.map(series => series.points.length) ?? [],
                            }));
                            if (query.includeCoach) {
                                // The fixture has complete measured input categories for every event.
                                // Each reading is available to Why/Diagnostics and to the wide row's trend.
                                const cache = coachFindings?.find(finding => finding.detector === 'cache_economics');
                                if (cache?.observations !== expected.eventCount || cache.seriesPoints.length !== 3
                                    || cache.seriesPoints.some(points => points !== expected.eventCount)) {
                                    failures.push({ view, compact, error: 'Coach lost exact accounting observations or trend points' });
                                }
                            }
                            return { metric: query.metric, costBasis: query.costBasis, events: accounting?.totals.eventCount,
                                series: accounting?.series?.length,
                                modelBuckets: accounting?.modelTimeline?.length,
                                calendarDays: accounting?.activity?.calendarDays?.length,
                                weekdayHourBuckets: accounting?.activity?.weekdayHourBuckets?.length,
                                sourceCoverageRows: accounting?.coverage?.sources.length,
                                breakdownRows: Object.values(accounting?.breakdowns ?? {}).reduce((count, entries) => count + (entries?.length ?? 0), 0),
                                coachFindings,
                                contributions: accounting?.contributions?.length, sourceErrors: slice?.sources.filter(source => source.status === 'error'),
                                omissions: slice?.incomplete?.omittedSections,
                                ...(work ? { work: { projects: work.projects.length, sessions: work.sessions.length,
                                    branches: work.branches.length, outcomes: work.outcomes.length } } : {}),
                            };
                        });
                        const shapeCensusMs = performance.now() - shapeCensusStarted;
                        for (const query of input.queries) {
                            const accounting = byKey.get(getUsageQueryKey(query))?.accounting;
                            if (accounting) for (const error of verifyAccountingGroups(accounting, query)) failures.push({ view, compact, error });
                        }
                        if (observations.length !== 1 || observations[0]?.demand.compact !== compact) failures.push({ view, compact,
                            error: `unexpected accounting acquisitions ${observations.length}` });
                        if (observations.some(observation => !observation.driver || observation.driver.statements <= 0
                            || !(observation.driver.durationMs > 0))) failures.push({ view, compact,
                            error: 'real accounting response had no request-scoped driver timing' });
                        if (compact && observations.some(observation => (observation.demand.detail > 0) !== needsContributionRows)) {
                            failures.push({ view, compact, error: 'accounting transport raw-row demand differs from rendered queries' });
                        }
                        if (compact) {
                            for (const error of deliveryErrors) failures.push({ view, compact, error });
                            for (const observation of observations) {
                                const delivery = observation.delivery;
                                const expectedInputs = needsContributionRows ? expected.eventCount : 0;
                                if (!delivery || delivery.groupedResults !== observation.demand.queries || delivery.exactInputs !== expectedInputs
                                    || observation.bytes > delivery.catalogBytes + delivery.groupedBytes + delivery.detailBytes) {
                                    failures.push({ view, compact, error: 'accounting wire exceeded the admitted grouped and exact-input byte envelope' });
                                }
                            }
                        }
                        const wireShape = !compact ? 'legacy contributions' : needsContributionRows ? 'exact detail' : 'grouped summary';
                        console.info(JSON.stringify({ kind: 'usage-accounting-phases', view, period, costBasis, compact, metrics,
                            elapsedMs, projectMs, projects, workPresentationMs, shapeCensusMs, observations, slices, wireShape }));
                        observedCold = true;
                        if (compact) {
                            let previous = result;
                            let previousBatchKey = plan.batchKey;
                            for (const { metric, plans: configured } of presentationPlans) {
                                const presentation = configured.get(view);
                                if (!presentation?.input) throw new Error(`Usage ${view} ${metric} presentation has no query plan`);
                                // Keep the same Account Resource and cost basis through the toolbar rebinds.
                                const before = observations.length;
                                const presentationStarted = performance.now();
                                if (presentation.batchKey !== previousBatchKey) {
                                    previous = await readUiUsageQueryBatch(context, presentation.input, undefined, previous);
                                    previousBatchKey = presentation.batchKey;
                                }
                                await settleTransport();
                                const accountingRequests = observations.length - before;
                                const delivered = new Map(previous.results.map(slice => [slice.key, slice]));
                                const keys = new Set([...presentation.widgets.values()].flatMap(row =>
                                    row.key && row.query?.metric === metric && row.query.includeAccounting ? [row.key] : []));
                                const projectedAmounts = [...keys].map(key => {
                                    const slice = delivered.get(key);
                                    if (!slice || slice.pending || slice.requestedQuery.metric !== metric || !slice.accounting) {
                                        failures.push({ view, compact, error: `${metric} widget accounting slice did not settle` });
                                        return null;
                                    }
                                    return metric === 'cost' ? resolveEffectiveUsageCostUsd(slice.accounting.totals.cost, costBasis)
                                        : slice.accounting.totals.tokens.total;
                                });
                                console.info(JSON.stringify({ kind: 'usage-accounting-metric-switch', view, period, costBasis, metric,
                                    elapsedMs: performance.now() - presentationStarted, accountingRequests, projectedAmounts,
                                    observations: observations.slice(before) }));
                                const expectedAmount = metric === 'cost' && inventoryAccounting
                                    ? resolveEffectiveUsageCostUsd(inventoryAccounting.totals.cost, costBasis) : expected.tokens;
                                if (accountingRequests !== 0 || view === 'overview' && !projectedAmounts.length
                                    || projectedAmounts.some(amount => expectedAmount == null || expectedAmount <= 0 || amount !== expectedAmount)) {
                                    failures.push({ view, compact, error: `${metric} presentation failed exact accounting reuse or amount` });
                                }
                            }
                        }
                    } catch (error) {
                        const reason = error instanceof Error ? error.message : String(error);
                        const elapsedMs = performance.now() - started;
                        await settleTransport();
                        failures.push({ view, compact, error: reason });
                        if (!observedCold) console.info(JSON.stringify({ kind: 'usage-accounting-phases', view, period, costBasis, compact, metrics,
                            elapsedMs, projectMs, projects, observations, slices, error: reason }));
                    } finally {
                        if (compact && view === 'sources') sqliteProbe = readBatch();
                        retire();
                    }
                }
            }
            if (profileLegacy && plans.some(plan => plan.id === 'sources')) {
                expect(sqliteProbe).toBeDefined();
                await observeSqliteRead(accountId, sqliteProbe!);
            }
        } finally {
            clock.mockRestore();
            resetServerFeaturesClientForTests();
        }
        console.info(JSON.stringify({ kind: 'usage-accounting-contract-failures', period, costBasis, failures }));
        expect(failures).toEqual([]);
    }, 600_000);

    it('preserves private Work turn identities and selects a covering provider total only once', async () => {
        const { readUiUsageQueryBatch } = await import('../sync/api/account/usageQueryResource');
        const account = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
        const at = USAGE_RIG_NOW - 10_000;
        const session = await db.session.create({ data: { accountId: account.id, tag: 'usage-rig-covered-turns',
            encryptionMode: 'plain', metadata: '{}', createdAt: new Date(at), updatedAt: new Date(at + 5_000) }, select: { id: true } });
        const turns = [{ turnId: 'first', tokens: 20, observedAtMs: at + 1_000 }, { turnId: 'second', tokens: 40, observedAtMs: at + 3_000 }];
        await db.sessionTurn.createMany({ data: turns.map(turn => ({ turnId: turn.turnId, sessionId: session.id,
            status: 'completed', agentId: 'codex', startedAt: BigInt(turn.observedAtMs - 500),
            terminalAt: BigInt(turn.observedAtMs + 500), updatedAt: BigInt(turn.observedAtMs + 500) })) });
        const base = { accountId: account.id, sessionId: session.id, agentId: 'codex', modelId: 'gpt-5-mini',
            projectKey: 'covered-turns-project', source: 'codex_app_server', currency: 'USD',
            outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
            metadata: { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } } };
        await db.usageEvent.createMany({ data: [...turns.map(turn => ({ ...base, observedAt: new Date(turn.observedAtMs),
            turnId: turn.turnId, scope: 'turn_delta', inputTokens: turn.tokens, totalTokens: turn.tokens,
            estimatedCostUsd: turn.tokens / 100, costSource: 'pricing_estimate' })),
        { ...base, observedAt: new Date(at + 5_000), scope: 'session_final', isCumulative: true,
            inputTokens: 60, totalTokens: 60, reportedCostUsd: 30, costSource: 'provider_reported' }] });

        const clock = vi.spyOn(Date, 'now').mockReturnValue(USAGE_RIG_NOW + 1);
        try {
            const { scope, credentials } = await openAccount(origin, account.id);
            selectTransport(scope.serverId, true);
            const input = buildUsageRigPresetPlans(scope, '7days').find(candidate => candidate.id === 'work')?.plan.input;
            if (!input) throw new Error('Work preset has no Usage query plan');
            const observations: RequestObservation[] = [];
            const { context, retire } = makeContext(origin, credentials, scope, observations);
            try {
                const result = await readUiUsageQueryBatch(context, input);
                const slice = result.results.find(candidate => candidate.requestedQuery.includeWorkEvidence && candidate.work);
                expect(slice?.pending).toBe(false);
                expect(slice?.accounting?.totals.tokens.total).toBe(60);
                const cost = slice?.accounting?.totals.cost;
                expect(cost && resolveEffectiveUsageCostUsd(cost, 'auto')).toBe(30);
                const work = slice?.work;
                expect(work?.allocations.filter(row => row.contribution.turnId !== null)
                    .map(row => ({ turn: row.contribution.turnId, tokens: row.contribution.tokens.total, reason: row.reason })))
                    .toEqual(turns.map(turn => ({ turn: turn.turnId, tokens: turn.tokens, reason: 'missing_evidence' })));
                expect(work?.outcomes).toEqual([]);
                expect(observations).toHaveLength(1);
            } finally { retire(); }
        } finally {
            clock.mockRestore();
            resetServerFeaturesClientForTests();
        }
    }, 60_000);
});
