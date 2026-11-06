import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import * as strictJson from '@happier-dev/protocol/json/strictJsonValue';
import { afterEach, expect, it, vi } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore } from './usageQueryResource';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { storage } from '@/sync/domains/state/storage';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import * as usageCost from '@happier-dev/protocol/usage/usageCost';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { USAGE_COACH_DETECTOR_IDS } from '@happier-dev/protocol/usage/coach/coachFinding';
import { invalidateUsageQueryResources, readUiUsageQueryBatch } from './usageQueryResource';
import { computePluginUiArtifactSha256Digest } from '@/sync/domains/plugins/ui/artifactIntegrity';
import * as platformDigest from '@/platform/digest';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { describeUsagePagePendingSources, readUsagePageAsOfMs } from '@/components/settings/usage/widgets/usageBodyKit';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => {
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home?.dispose();
    home = undefined;
    vi.restoreAllMocks();
});

it('composes only consumed Resource revisions when eight completed detail results arrive in one stream chunk', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
    let entered = createDeferred<void>();
    let released = createDeferred<void>();
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-progress-burst.test', accountId: 'account-a' }],
        route: async request => {
            if (request.path !== '/v2/usage/query-batch') return undefined;
            const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
            const chunks = [...usageCost.projectUsageAnalyticsBatchDelivery({ v: 1, results: input.queries.map((query, index) => ({
                query, value: { v: 1, totals: { eventCount: index + 1,
                    tokens: { ...tokens, input: 10 * (index + 1), output: 5 * (index + 1), total: 15 * (index + 1) }, cost },
                contributions: Array.from({ length: index + 1 }, (_, row) => ({ id: `${index}-${row}`, observedAtMs: 1500,
                    sessionId: null, turnId: null, agentId: query.filters?.agentIds?.[0] ?? null, modelId: null,
                    machineId: null, projectKey: null, workspaceId: null, source: null, eventCount: 1, tokens, tokenCategories: tokens, cost })) },
            })) }, input, true)];
            const ready = released.promise;
            entered.resolve();
            await ready;
            // One physical stream read contains every summary and completed detail page.
            return new Response(new ReadableStream<Uint8Array>({ start(controller) {
                controller.enqueue(new TextEncoder().encode(chunks.map(chunk => JSON.stringify(chunk) + '\n').join('')));
                controller.close();
            } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
        } });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const captured = captureUiUsageQueryAccountContext((await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!)!;
    // The captured QA Account held 62 Machines. Their real metadata getters expose
    // repeated population traversal during composition, not just notification count.
    let metadataReads = 0;
    const machines = Object.fromEntries(Array.from({ length: 62 }, (_, index) => {
        const machine = createMachineFixture({ id: `burst-machine-${index}` });
        Object.defineProperty(machine.metadata!, 'host', { enumerable: true,
            get: () => { metadataReads++; return `burst-${index}.test`; } });
        return [machine.id, machine];
    }));
    storage.setState({ profileScope: captured.accountLifetime.scope,
        profile: AccountProfileSchema.parse({ id: 'account-a' }), machines });
    // Observe the real platform digest: each call receives complete Resource bytes,
    // regardless of how many native UTF-8 fragments its accounting sections reuse.
    const digest = vi.spyOn(platformDigest, 'digest');
    const store = getUsageQueryResourceStore(captured);
    const readBurst = async (count: number) => {
        entered = createDeferred<void>();
        released = createDeferred<void>();
        const queries = Array.from({ length: count }, (_, index) => normalizeUsageQuery({
            period: { startMs: 1000, endMs: 2000 }, agents: [`burst-${count}-${index}`], includeContributions: true,
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
            includeComparison: false, includeQuotaHistory: false,
        }));
        const entry = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries }) });
        const reading = entry.refresh();
        await entered.promise;
        metadataReads = 0;
        digest.mockClear();
        released.resolve();
        const snapshot = await reading;
        expect(snapshot.error).toBeUndefined();
        const content = snapshot.value!;
        const batch = decodeUsageQueryResource(content);
        expect(batch.results).toHaveLength(count);
        expect(batch.results.map(slice => slice.accounting?.totals.eventCount).sort((left, right) => left! - right!))
            .toEqual(Array.from({ length: count }, (_, index) => index + 1));
        expect(batch.results.every(slice => slice.sources.some(source => source.source === 'accounting' && source.status === 'available'))).toBe(true);
        expect(JSON.parse(new TextDecoder().decode(content.bytes))).toEqual(JSON.parse(JSON.stringify(batch)));
        const resourceTexts = digest.mock.calls.map(([, bytes]) => new TextDecoder().decode(bytes))
            .filter(text => text.startsWith('{"v":1,"results":['));
        expect(resourceTexts.length, 'the complete Resource must cross the digest boundary').toBeGreaterThan(0);
        expect(resourceTexts.filter((text, index) => index > 0 && text === resourceTexts[index - 1]),
            'the final result must reuse a byte-identical already-consumed progress revision').toHaveLength(0);
        return { metadataReads, resourceCompositions: resourceTexts.length, utf8Bytes: content.bytes.byteLength };
    };
    try {
        const single = await readBurst(1);
        const burst = await readBurst(8);
        console.log('[USAGE-PROGRESS-BURST]', JSON.stringify({ single, burst }));
        // At most one extra latest revision can be consumed while the first
        // revision's native digest is in flight; discarded revisions do no compose work.
        expect(burst.metadataReads, 'coalescing must happen before Machine traversal and projection')
            .toBeLessThanOrEqual(single.metadataReads + 2 * Object.keys(machines).length);
        expect(burst.resourceCompositions).toBeLessThanOrEqual(single.resourceCompositions + 1);
        expect(burst.resourceCompositions, 'eight delivered results compose at most the in-flight revision and its latest successor').toBeLessThanOrEqual(2);
    } finally { released.resolve(); }
});

it('reuses contribution references across equal refetches without whole-population equality', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const cost = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' };
    const population = Array.from({ length: 3600 }, (_, index) => ({ id: String(index), observedAtMs: 1500,
        sessionId: null, turnId: null, agentId: null, modelId: null, machineId: null, projectKey: null,
        workspaceId: null, source: null, eventCount: 1, tokens, tokenCategories: tokens, cost }));
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-equal-refetch.test', accountId: 'account-a' }],
        route: request => request.path === '/v2/usage/query' ? Response.json({ v: 1,
            totals: { eventCount: population.length, tokens, cost }, contributions: population }) : undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const captured = captureUiUsageQueryAccountContext((await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!)!;
    storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const query = normalizeUsageQuery({ period: { relative: 'all' }, includeSessionEvidence: false,
        includeWorkEvidence: false, includeActivity: false, includeModelTimeline: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
        input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const stop = entry.subscribe(() => {}, false);
    try {
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        const before = decodeUsageQueryResource(entry.getSnapshot().value!);
        const compare = vi.spyOn(strictJson, 'sameStrictJsonValue'); // Observe real comparisons; no internal logic is replaced.
        const publishedAccounting = new Set<UsageAnalyticsQueryResponse>();
        const stopObserving = entry.subscribe(() => {
            const value = entry.getSnapshot().value;
            if (!value) return;
            const accounting = decodeUsageQueryResource(value).results[0]?.accounting;
            if (accounting) publishedAccounting.add(accounting);
        }, false);
        try {
            for (let index = 0; index < 3; index++) {
                clock.mockReturnValue(1_900_000_000_000 + (index + 1) * 30_000);
                await entry.refresh();
            }
        } finally { stopObserving(); }
        const after = decodeUsageQueryResource(entry.getSnapshot().value!);
        expect(after.results[0]?.accounting).toBe(before.results[0]?.accounting);
        expect(publishedAccounting.has(before.results[0]!.accounting!)).toBe(true);
        expect(publishedAccounting.size, 'a changed admission clock must not replace equal accounting during intermediate publications').toBe(1);
        expect(entry.getSnapshot().pending).toBe('idle');
        const walks = compare.mock.calls.filter(([value]) => Array.isArray(value) && value.length === population.length);
        expect(walks.length, 'fresh rows are reconciled once at producer admission, never as a whole-population member').toBe(0);
        expect(compare.mock.calls.filter(([value]) => value && typeof value === 'object'
            && 'shownQuery' in value && 'sources' in value).length,
            'the existing Resource digest replaces settled-slice deep equality').toBe(0);
    } finally { stop(); }
});

it('keeps completed source dates and a quiet header while the same query rereads in the background', async () => {
    const held = createDeferred<void>();
    let hold = false;
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-header-refresh.test', accountId: 'account-a' }],
        route: async request => {
            if (request.path !== '/v2/usage/query') return undefined;
            if (hold) await held.promise;
            return Response.json({ v: 1, totals: { eventCount: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
        } });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const captured = captureUiUsageQueryAccountContext((await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!)!;
    storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 } });
    const input = { queries: [query] };
    const settled = await readUiUsageQueryBatch(captured, input);
    const asOf = readUsagePageAsOfMs(settled.results);
    expect(asOf).not.toBeNull();
    hold = true;
    invalidateUsageQueryResources(captured.accountLifetime);
    const progress = createDeferred<void>();
    let shown = settled;
    const reading = readUiUsageQueryBatch(captured, input, undefined, settled, { onProgress: project => {
        shown = project();
        progress.resolve();
    } });
    try {
        await progress.promise;
        expect(shown.results[0]?.pending).toBe(true);
        expect.soft(readUsagePageAsOfMs(shown.results)).toBe(asOf);
        expect.soft(describeUsagePagePendingSources(shown.results)).toBeNull();
        expect.soft(shown.results[0]?.sources.find(source => source.source === 'how_you_work')?.asOfMs)
            .toBe(settled.results[0]?.sources.find(source => source.source === 'how_you_work')?.asOfMs);
    } finally { held.resolve(); await reading; }
});

it('preserves exact Resource bytes and digest without scalar UTF-8 calls while independent source phases advance', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
    const sibling = createDeferred<void>();
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-serialization.test', accountId: 'account-a' }],
        route: async request => {
            if (request.path !== '/v2/usage/query') return undefined;
            const slow = UsageAnalyticsQueryRequestSchema.parse(request.body).filters?.agentIds?.includes('slow');
            if (slow) await sibling.promise;
            return Response.json({ v: 1,
            totals: { eventCount: 1, tokens, cost }, contributions: slow ? [] : [{ id: 'serialization-evidence-λ', observedAtMs: 1500,
                sessionId: null, turnId: null, agentId: null, modelId: null, machineId: null, projectKey: null,
                workspaceId: null, source: null, eventCount: 1, tokens, tokenCategories: tokens, cost }] });
        } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const captured = captureUiUsageQueryAccountContext((await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!)!;
    storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    // The UTF-8 boundary measures repeated whole-payload work without replacing
    // any internal query, projection, or serialization behavior.
    const encodeInto = vi.spyOn(TextEncoder.prototype, 'encodeInto');
    // Call through the real schema; a native typed producer's final revision
    // must not clone the entire population after progressive admission.
    const readmission = vi.spyOn(UsageQueryBatchResultSchema, 'safeParse');
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
        queries: ['first', 'slow'].map(agent => normalizeUsageQuery({ period: { relative: 'all' }, agents: [agent],
            includeWorkEvidence: false, includeContributions: true })),
    }) });
    const release = entry.subscribe(() => {}, false);
    try {
        await expect.poll(() => {
            const content = entry.getSnapshot().value;
            return content && decodeUsageQueryResource(content).results[0]?.accounting !== undefined;
        }).toBe(true);
        sibling.resolve();
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        const content = entry.getSnapshot().value!;
        expect(JSON.parse(new TextDecoder().decode(content.bytes))).toEqual(JSON.parse(JSON.stringify(decodeUsageQueryResource(content))));
        expect(content.digest).toBe(await computePluginUiArtifactSha256Digest(content.bytes));
        expect(decodeUsageQueryResource(content).results[0]?.accounting?.contributions?.[0]?.id).toBe('serialization-evidence-λ');
        expect(encodeInto.mock.calls.length, 'Resource encoding must not call UTF-8 per scalar/key').toBe(0);
        expect(readmission.mock.calls.reduce((count, [value]) => count +
            (typeof value === 'object' && value !== null && 'results' in value ? 1 : 0), 0)).toBe(0);
    } finally { sibling.resolve(); release(); }
});

it('keeps admitted accounting available when a finite batch recomposes without a new accounting acquisition', async () => {
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-admitted-progress.test', accountId: 'account-a' }],
        route: request => request.path === '/v2/usage/query' ? Response.json({ v: 1,
            totals: { eventCount: 1, tokens, cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } },
            coverage: { status: 'partial', reasons: [], sources: [{ source: 'native-history', path: 'native',
                status: 'pending', eventCount: 1 }], missingDimensions: [], range: { complete: false }, ranked: [] } }) : undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const captured = captureUiUsageQueryAccountContext((await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!)!;
    let metadataReads = 0;
    const machine = createMachineFixture({ id: 'admitted-progress-machine' });
    Object.defineProperty(machine.metadata!, 'host', { enumerable: true,
        get: () => { metadataReads++; return 'admitted-progress.test'; } });
    storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: 'account-a' }),
        machines: { [machine.id]: machine } });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await flushHookEffects({ cycles: 20 });
    const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 }, includeSessionEvidence: false,
        includeTranscriptEvidence: false, includeWorkEvidence: false, includeComparison: false, includeQuotaHistory: false });
    const sibling = normalizeUsageQuery({ ...query, includeTranscriptEvidence: true });
    const full = await readUiUsageQueryBatch(captured, { queries: [query, sibling] });
    const inventory = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, full);
    const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
    const beforePosts = posts();
    const accountingStates: string[][] = [];
    const reopened = await readUiUsageQueryBatch(captured, { queries: [query, sibling] }, undefined, inventory,
        { onProgress: project => { accountingStates.push(project().results.flatMap(slice => slice.sources
            .filter(source => source.source === 'accounting').map(source => source.status))); } });
    expect(posts()).toBe(beforePosts);
    expect(reopened.results[0]?.accounting).toBe(full.results[0]?.accounting);
    expect(accountingStates.length).toBeGreaterThan(0);
    expect(accountingStates.flat().filter(status => status === 'pending'),
        'a retained Account answer is already admitted; unrelated finite reads must not publish a new accounting acquisition').toHaveLength(0);

    // Pending producer facts deliberately prevent the settled-entry shortcut.
    // A new finite read must still preserve its already-admitted Resource bytes.
    const store = getUsageQueryResourceStore(captured);
    const entryFor = (queries: readonly ReturnType<typeof normalizeUsageQuery>[]) => store.getEntry({ hostRead: 'usage.query',
        input: projectNativeJsonValueForTransport({ queries }) });
    const entry = entryFor([query, sibling]);
    const prime = entry.subscribe(() => {}, true);
    await expect.poll(() => entry.getSnapshot().value !== undefined && entry.getSnapshot().pending === 'idle').toBe(true);
    prime();
    const inventoryEntry = entryFor([query]);
    const stopInventory = inventoryEntry.subscribe(() => {}, true);
    await expect.poll(() => inventoryEntry.getSnapshot().value !== undefined && inventoryEntry.getSnapshot().pending === 'idle').toBe(true);
    const beforeContent = entry.getSnapshot().value;
    const digest = vi.spyOn(platformDigest, 'digest');
    const changedContents = new Set<object>();
    const lifecycle: string[] = [];
    let previousLifecycle = `${entry.getSnapshot().pending}:${entry.getSnapshot().freshness}`;
    metadataReads = 0;
    const stop = entry.subscribe(() => {
        const snapshot = entry.getSnapshot();
        const currentLifecycle = `${snapshot.pending}:${snapshot.freshness}`;
        if (currentLifecycle !== previousLifecycle) lifecycle.push(currentLifecycle);
        previousLifecycle = currentLifecycle;
        const content = snapshot.value;
        if (content && content !== beforeContent) changedContents.add(content);
    }, true);
    try {
        await flushHookEffects({ cycles: 30 });
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        const resourceDigests = digest.mock.calls.filter(([, bytes]) => new TextDecoder().decode(bytes).startsWith('{"v":1,"results":['));
        console.log('[USAGE-ADMITTED-REOPEN]', JSON.stringify({ posts: posts() - beforePosts,
            changedContents: changedContents.size, resourceDigests: resourceDigests.length, metadataReads, lifecycle }));
        expect(lifecycle, 'watch establishment must converge on its admitted digest after the mandatory pending-producer retry')
            .toEqual(['refresh:stale', 'refresh:fresh', 'idle:fresh']);
        // Two queries each traverse the Machine once for pool selection (four
        // host reads). One full source-location projection adds two reads.
        expect(metadataReads, 'pending-source retry keeps selector reads and composes once across unchanged completion and settlement').toBe(6);
        expect(changedContents.size, 'unchanged admitted source facts must emit no replacement Resource content').toBe(0);
        expect(resourceDigests, 'unchanged admitted source facts must not encode and hash the complete Resource').toHaveLength(0);
        expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
            .toContainEqual({ source: 'native-history', status: 'pending' });
    } finally { stop(); stopInventory(); }

    // A real accounting wake replaces that answer and must publish acquisition
    // before admitting its replacement, even if the final numeric facts agree.
    invalidateUsageQueryResources(captured.accountLifetime);
    const replacementStates: string[] = [];
    await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, reopened,
        { onProgress: project => { replacementStates.push(...project().results.flatMap(slice => slice.sources
            .filter(source => source.source === 'accounting').map(source => source.status))); } });
    expect(posts()).toBeGreaterThan(beforePosts);
    expect(replacementStates).toContain('pending');
    expect(replacementStates).toContain('available');
});

it('reprices shared accounting once per tariff across sibling evidence queries and progressive publications', async () => {
    const query = normalizeUsageQuery({ period: { startMs: 1000 }, includeSessionEvidence: false, includeWorkEvidence: false,
        includeActivity: false, includeSeries: false });
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
    let count = 3600;
    let rate = 2;
    // The HTTP producer prices its captured population before summary delivery.
    // Capture it before observing the separate client projection cost contract.
    const projectServerAccounting = usageCost.repriceUsageAnalyticsResponse;
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-pricing-inputs.test', accountId: 'account-a' }],
        route: request => request.path === '/v2/usage/query' ? Response.json(projectServerAccounting({ v: 1,
            totals: { eventCount: count, tokens: { ...tokens, input: 10 * count, output: 5 * count, total: 15 * count }, cost },
            priceCatalog: { ...bundledUsageModelPriceCatalog, models: { model: { inputUsdPerMillion: rate, outputUsdPerMillion: 1 } } },
            contributions: Array.from({ length: count }, (_, index) => ({ id: String(index), observedAtMs: 1500,
                sessionId: null, turnId: null, agentId: null, modelId: 'model', machineId: null, projectKey: null,
                workspaceId: null, source: null, eventCount: 1, tokens, tokenCategories: tokens, cost })) })) : undefined });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const captured = captureUiUsageQueryAccountContext((await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!)!;
    storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    // Bootstrap's coarse Home wake replaces accounting; finish that producer
    // before measuring unchanged navigation against the admitted answer.
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await flushHookEffects({ cycles: 20 });
    const reprice = vi.spyOn(usageCost, 'repriceUsageAnalyticsResponse');
    for (const change of ['initial', 'contribution', 'price', 'override'] as const) {
        if (change === 'contribution') count++;
        if (change === 'price') rate++;
        if (change === 'override') {
            rate++;
            storage.setState(state => ({ settingsScope: captured.accountLifetime.scope,
                settings: { ...state.settings, usageModelPriceOverridesV1: {
                    model: { kind: 'rates', inputUsdPerMillion: rate, outputUsdPerMillion: 1 },
                } } }));
        }
        // The server's changed accounting reaches the Account owner as a wake; without one, the read reuses its answer.
        if (change === 'contribution' || change === 'price') invalidateUsageQueryResources(captured.accountLifetime);
        const beforePosts = home!.requests.filter(request => request.path === '/v2/usage/query').length;
        reprice.mockClear();
        const progress: number[] = [];
        const started = performance.now();
        const result = await readUiUsageQueryBatch(captured, { queries: [query,
            normalizeUsageQuery({ ...query, includeTranscriptEvidence: !query.includeTranscriptEvidence })] }, undefined, undefined,
            { onProgress: project => { const batch = project(); if (batch.results[0]?.accounting) progress.push(batch.results[0].accounting.totals.eventCount); } });
        const elapsedMs = performance.now() - started;
        expect(progress.length).toBeGreaterThan(0);
        expect(result.results[0]!.accounting!.contributions).toBeUndefined();
        expect(result.results[0]!.accounting!.totals.eventCount).toBe(count);
        expect(result.results[0]!.accounting!.totals.cost.apiEquivalentUsd).toBeCloseTo(count * (10 * rate + 5) / 1_000_000);
        expect(result.results[1]!.accounting).toBe(result.results[0]!.accounting);
        console.log('[USAGE-AGG-IDLE]', JSON.stringify({ change, contributions: count, elapsedMs, repricingRuns: reprice.mock.calls.length }));
        expect(reprice, `${change} accounting must be priced once across all publications`).toHaveBeenCalledTimes(1);
        if (change === 'override') expect(home!.requests.filter(request => request.path === '/v2/usage/query')).toHaveLength(beforePosts);
        // Navigation first admits the inventory, then the full registered batch.
        // Each finite read composes again, independently of settled-entry byte
        // reuse, while consuming the same Account answer.
        const posts = home!.requests.filter(request => request.path === '/v2/usage/query').length;
        // Observe the admitted raw pricing facts themselves, rather than relying
        // only on whether a particular reduction helper was entered.
        const raw = reprice.mock.calls[0]![0];
        const summary = raw.summary;
        let pricingFactReads = 0;
        Object.defineProperty(raw, 'summary', { configurable: true, enumerable: true,
            get() { pricingFactReads++; return summary; } });
        reprice.mockClear();
        const inventory = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, result);
        const reopened = await readUiUsageQueryBatch(captured, { queries: [query,
            normalizeUsageQuery({ ...query, includeTranscriptEvidence: !query.includeTranscriptEvidence })] }, undefined, inventory);
        console.log('[USAGE-AGG-REOPEN]', JSON.stringify({ change, postsBefore: posts,
            postsAfter: home!.requests.filter(request => request.path === '/v2/usage/query').length,
            repricingRuns: reprice.mock.calls.length, pricingFactReads }));
        expect(reopened.results[0]?.accounting).toBe(result.results[0]?.accounting);
        expect(home!.requests.filter(request => request.path === '/v2/usage/query')).toHaveLength(posts);
        expect(reprice, 'unchanged admitted accounting must not be repriced across read or batch lifetimes').toHaveBeenCalledTimes(0);
        expect(pricingFactReads, 'an unchanged finite read must not revisit admitted raw pricing facts').toBe(0);
    }
});

it.each(['all_personal_history', 'public_eligible_personal'] as const)('retains delivery preparation for rich accounting without a catalog and stable machine labels across finite reads and later overrides (%s)', async population => {
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const cost = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-rich-preparation.test', accountId: 'account-a' }],
        route: request => {
            if (request.path !== '/v2/usage/query-batch') return undefined;
            const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
            // Older rich Homes can return rows without a summary or tariff catalog.
            return Response.json({ v: 1, results: input.queries.map(query => ({ query, value: { v: 1,
                totals: { eventCount: 100, tokens, cost: { ...cost, reportedUsd: 100 } },
                coverage: { status: 'partial', reasons: [], missingDimensions: [], ranked: [],
                    range: { startMs: 1000, endMs: 2000, complete: true }, sources: [{ source: 'native-history', path: 'native',
                        status: 'available', eventCount: 100, machineId: 'rich-source-machine', captureKind: 'from_logs' }] },
                contributions: Array.from({ length: 100 }, (_, index) => ({ id: String(index), observedAtMs: 1500,
                    sessionId: null, turnId: null, agentId: null, modelId: 'model', machineId: null, projectKey: null,
                    workspaceId: null, source: null, eventCount: 1, tokens, tokenCategories: tokens, cost })),
            } })) });
        } });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const captured = captureUiUsageQueryAccountContext((await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!)!;
    storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await flushHookEffects({ cycles: 20 });
    const machine = createMachineFixture({ id: 'rich-source-machine' });
    storage.setState({ machines: { [machine.id]: { ...machine, metadata: { ...machine.metadata!, displayName: 'Workstation' } } } });
    // Keep this accounting/calendar contract independent of Coach's source-currentness evaluations.
    storage.setState(state => ({ settingsScope: captured.accountLifetime.scope, settings: { ...state.settings,
        usageCoachPreferencesV1: { ...state.settings.usageCoachPreferencesV1, disabledChecks: [...USAGE_COACH_DETECTOR_IDS] } } }));
    const query = normalizeUsageQuery({ population, period: { startMs: 1000, endMs: 2000 }, includeComparison: false,
        includeSessionEvidence: false, includeWorkEvidence: false, includeActivity: true, includeSeries: false });
    const sibling = normalizeUsageQuery({ ...query, includeTranscriptEvidence: !query.includeTranscriptEvidence });
    const summary = vi.spyOn(usageCost, 'projectUsageAnalyticsSummary');
    const initial = await readUiUsageQueryBatch(captured, { queries: [query, sibling] });
    expect(initial.results[0]?.accounting?.coverage?.sources[0]?.displayLocation).toBe('Workstation');
    const raw = summary.mock.calls.find(([value]) => value.contributions?.length === 100)![0];
    let rowReads = 0;
    for (const row of raw.contributions!) for (const key of ['tokens', 'tokenCategories', 'observedAtMs'] as const) {
        const value = row[key];
        Object.defineProperty(row, key, { configurable: true, enumerable: true, get() { rowReads++; return value; } });
    }
    const posts = home.httpRequests.filter(request => request.path === '/v2/usage/query-batch').length;
    let retained = initial;
    for (const override of [false, true]) {
        if (override) storage.setState(state => ({ settingsScope: captured.accountLifetime.scope,
            settings: { ...state.settings, usageModelPriceOverridesV1: {
                model: { kind: 'rates', inputUsdPerMillion: 5, outputUsdPerMillion: 1 },
            } } }));
        const first = override ? await readUiUsageQueryBatch(captured, { queries: [query, sibling] }) : initial;
        if (override) {
            if (population === 'all_personal_history') expect(first.results[0]!.accounting!.totals.cost.apiEquivalentUsd).toBeCloseTo(100 * 55 / 1_000_000);
            else expect(first.results[0]!.accounting).toEqual(initial.results[0]!.accounting);
        }
        rowReads = 0;
        const inventory = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, first);
        const reopened = await readUiUsageQueryBatch(captured, { queries: [query, sibling] }, undefined, inventory);
        expect(rowReads, 'unchanged rich accounting must retain its summary, pricing, calendar and observation range').toBe(0);
        expect(reopened.results[0]?.accounting?.coverage?.sources[0]?.displayLocation).toBe('Workstation');
        expect(reopened.results[0]?.accounting).toBe(first.results[0]?.accounting);
        expect(home.httpRequests.filter(request => request.path === '/v2/usage/query-batch')).toHaveLength(posts);
        retained = reopened;
    }
    // Labels are a real projection input: updates and withdrawal must replace
    // their output, then retain that new output across unchanged navigation.
    for (const label of ['Renamed workstation', undefined]) {
        storage.setState({ machines: { [machine.id]: label ? { ...machine,
            metadata: { ...machine.metadata!, displayName: label } } : { ...machine,
            availability: { kind: 'locked', reason: 'decryption_failed' }, metadata: null } } });
        const updated = await readUiUsageQueryBatch(captured, { queries: [query, sibling] }, undefined, retained);
        expect(updated.results[0]?.accounting?.coverage?.sources[0]?.displayLocation).toBe(label);
        expect(updated.results[0]?.accounting).not.toBe(retained.results[0]?.accounting);
        const inventory = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, updated);
        const reopened = await readUiUsageQueryBatch(captured, { queries: [query, sibling] }, undefined, inventory);
        expect(reopened.results[0]?.accounting).toBe(updated.results[0]?.accounting);
        expect(home.httpRequests.filter(request => request.path === '/v2/usage/query-batch')).toHaveLength(posts);
        retained = reopened;
    }
});

it('seeds the same accounting query from its Account facts when a route mounts a different batch', async () => {
    const pending = createDeferred<void>();
    let hold = false;
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-batch-retention.test', accountId: 'account-a' }],
        route: async request => {
            if (request.path !== '/v2/usage/query') return undefined;
            if (hold) await pending.promise;
            return Response.json({ v: 1, totals: { eventCount: 1,
                tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
                series: [{ bucketStartMs: 1000, bucketEndMs: 2000, eventCount: 1,
                    tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
                    cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }] });
        } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    const captured = captureUiUsageQueryAccountContext(credentials)!;
    storage.setState({ profileScope: captured.accountLifetime.scope,
        profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }) });
    const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 }, includeWorkEvidence: false, includeSessionEvidence: false });
    const store = getUsageQueryResourceStore(captured);
    const initial = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = initial.subscribe(() => {}, false);
    await expect.poll(() => initial.getSnapshot().pending).toBe('idle');
    const before = decodeUsageQueryResource(initial.getSnapshot().value!).results[0]!.accounting;
    release();
    hold = true;
    const returning = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query,
        normalizeUsageQuery({ ...query, agents: ['claude'] })] }) });
    const stop = returning.subscribe(() => {}, false);
    try {
        await expect.poll(() => returning.getSnapshot().value !== undefined).toBe(true);
        const shown = decodeUsageQueryResource(returning.getSnapshot().value!).results.find(slice => slice.key === getUsageQueryKey(query))!;
        expect(shown.accounting).toEqual(before);
        expect(shown.sources.find(source => source.source === 'accounting')?.status).toBe('pending');
        expect(decodeUsageQueryResource(returning.getSnapshot().value!).results.find(slice => slice.key !== getUsageQueryKey(query))?.accounting,
            'a differently filtered query cannot inherit these facts').toBeUndefined();
    } finally { pending.resolve(); stop(); }
});

it('preserves an unchanged batched slice across Resource revisions without sharing it across retired authority', async () => {
    // This is the clock boundary, so unchanged observed source currentness is
    // distinguishable from a real change to one query's accounting facts.
    vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
    let changedCount = 1;
    const accounting = (eventCount: number): UsageAnalyticsQueryResponse => ({ v: 1, totals: {
        eventCount, tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
        cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' },
    } });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-stability.test', accountId: 'account-a' }],
        route: request => {
            if (request.path !== '/v2/usage/query') return undefined;
            const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
            return Response.json(accounting(query.filters?.agentIds?.includes('claude') ? changedCount : 1));
        } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    const queries = ['claude', 'codex'].map(agent => normalizeUsageQuery({
        period: { startMs: 1000, endMs: 2000 }, agents: [agent],
    }));
    const reference = { hostRead: 'usage.query' as const, input: projectNativeJsonValueForTransport({ queries }) };
    const captured = captureUiUsageQueryAccountContext(credentials);
    if (!captured) throw new Error('Expected admitted Account');
    // Match the served Home before subscribing: its asynchronous bootstrap
    // must not turn unknown profile scope into new source state mid-comparison.
    storage.setState({ profileScope: captured.accountLifetime.scope,
        profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }) });
    const entry = getUsageQueryResourceStore(captured).getEntry(reference);
    const release = entry.subscribe(() => {}, false);
    const readReady = async () => {
        await expect.poll(() => {
            const content = entry.getSnapshot().value;
            return content !== undefined && decodeUsageQueryResource(content).results.every(slice =>
                slice.sources.some(source => source.source === 'how_you_work' && source.status !== 'pending'));
        }).toBe(true);
        return decodeUsageQueryResource(entry.getSnapshot().value!);
    };
    try {
        const before = await readReady();
        const firstKey = getUsageQueryKey(queries[0]);
        const siblingKey = getUsageQueryKey(queries[1]);
        const beforeFirst = before.results.find(slice => slice.key === firstKey)!;
        const beforeSibling = before.results.find(slice => slice.key === siblingKey)!;
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        const digest = vi.spyOn(platformDigest, 'digest');
        changedCount = 2;
        await entry.refresh();
        const after = await readReady();
        expect(after.results.find(slice => slice.key === firstKey)?.accounting?.totals.eventCount).toBe(2);
        expect(after.results.find(slice => slice.key === firstKey)).not.toBe(beforeFirst);
        expect(after.results.find(slice => slice.key === siblingKey)).toBe(beforeSibling);
        const digested = digest.mock.calls.map(([, bytes]) => new TextDecoder().decode(bytes))
            .filter(text => text.startsWith('{"v":1,"results":['));
        expect(digested.length).toBeGreaterThan(0);
        expect(digested.filter((text, index) => index > 0 && text === digested[index - 1]).length,
            'an unchanged admitted revision must not encode/hash its whole bytes again').toBe(0);

        retireActiveServerAccountScopeLifetime();
        expect(entry.getSnapshot().value).toBeUndefined();
        const replacement = captureUiUsageQueryAccountContext(credentials);
        if (!replacement) throw new Error('Expected replacement admitted Account');
        expect(replacement.accountLifetime).not.toBe(captured.accountLifetime);
        const replacementEntry = getUsageQueryResourceStore(replacement).getEntry(reference);
        const stopReplacement = replacementEntry.subscribe(() => {}, false);
        try {
            await replacementEntry.refresh();
            const content = replacementEntry.getSnapshot().value;
            expect(content).toBeDefined();
            expect(decodeUsageQueryResource(content!).results.find(slice => slice.key === siblingKey)).not.toBe(beforeSibling);
        } finally { stopReplacement(); }
    } finally { release(); }
});

it('reads each accounting fact once across a cold Usage page mount at fixture scale', async () => {
    // EXPORT-C fixture shape: 20 Sessions/contributions, a page batch that grows from the first
    // widget's query to widget + inventory while Sessions and Settings hydrate behind it, on a moving clock.
    let now = 1_900_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const contributions = Array.from({ length: 20 }, (_, index) => ({ id: `contribution-${index}`, observedAtMs: 1_899_000_000_000 + index,
        sessionId: `session-${index}`, turnId: null, agentId: index % 2 ? 'codex' : 'claude', modelId: null, machineId: `machine-${index % 2}`,
        projectKey: null, workspaceId: null, source: null, eventCount: 1, tokens, tokenCategories: tokens,
        cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } }));
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-cold-mount.test', accountId: 'account-a' }],
        route: request => request.path === '/v2/usage/query' ? Response.json({ v: 1,
            totals: { eventCount: contributions.length, tokens, cost: { reportedUsd: 20, estimatedUsd: 0, currency: 'USD' } },
            contributions }) : undefined });
    const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query');
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const captured = captureUiUsageQueryAccountContext((await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!)!;
    const scope = captured.accountLifetime.scope;
    storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: scope.accountId }) });
    // The Home's bootstrap wake is a real accounting replacement; let it land before the page mounts.
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await flushHookEffects({ cycles: 20 });
    const widget = normalizeUsageQuery({ period: { relative: '30days' }, includeSessionEvidence: false, includeWorkEvidence: false });
    const inventory = normalizeUsageQuery({ ...widget, metric: 'tokens', breakdown: ['agent', 'machine', 'project', 'source'] });
    const store = getUsageQueryResourceStore(captured);
    const entryFor = (queries: readonly ReturnType<typeof normalizeUsageQuery>[]) => store.getEntry({ hostRead: 'usage.query',
        input: projectNativeJsonValueForTransport({ queries }) });
    const settle = async (entry: ReturnType<typeof entryFor>) => {
        await flushHookEffects({ cycles: 20 });
        await expect.poll(() => entry.getSnapshot().value !== undefined && entry.getSnapshot().pending === 'idle').toBe(true);
    };
    const facts = (entry: ReturnType<typeof entryFor>) => decodeUsageQueryResource(entry.getSnapshot().value!).results
        .map(slice => [slice.key, slice.accounting, slice.comparison?.accounting]);
    const first = entryFor([widget]);
    const releaseFirst = first.subscribe(() => {}, true);
    await settle(first);
    const firstMount = posts().length;
    now += 1500;
    const page = entryFor([widget, inventory]);
    const release = page.subscribe(() => {}, true);
    releaseFirst();
    try {
        await settle(page);
        const mounted = facts(page);
        const pageMount = posts().length - firstMount;
        now += 1500;
        const sessions = Object.fromEntries(contributions.map(row => [row.sessionId, createSessionFixture({ id: row.sessionId,
            serverId: scope.serverId, encryptionMode: 'plain' })]));
        storage.getState().applySessions(Object.values(sessions));
        storage.setState({ settingsScope: scope });
        await settle(page);
        const cold = posts().length;
        const hydration = cold - firstMount - pageMount;
        expect(facts(page), 'Usage numbers are unchanged by Session/Settings hydration').toEqual(mounted);
        await page.refresh();
        await settle(page);
        const refresh = posts().length - cold;
        now += 86_400_000;
        storage.getState().deleteSession('session-0', scope.serverId);
        await settle(page);
        // Widget + its previous period, then only the inventory's new request; hydration changes no server
        // accounting answer. An explicit refresh and a new local day ask the server again.
        expect({ firstMount, pageMount, hydration, refresh, nextDay: posts().length - cold - refresh,
            coldDistinct: new Set(posts().slice(0, cold).map(request => JSON.stringify(request.body))).size },
            'a cold mount POSTs each distinct accounting request once').toEqual({
            firstMount: 2, pageMount: 1, hydration: 0, refresh: 3, nextDay: 3, coldDistinct: 3 });
    } finally { release(); }
});
