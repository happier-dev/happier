import { getUsageQueryKey, usageQueryToAnalyticsRequest, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation, resolveUsageQuotaPageAggregation, resolveUsageComparisonQuery, retainUsageQueryResultReferences, retainAccountingReferences, projectUsageAccountingSnapshotPrices,
    projectUsageAccountingSnapshotCalendar, type UsageAccountingSourceSnapshot, type UsageWorkSourceSnapshot,
    type UsageHowYouWorkSourceSnapshot, type UsagePoolSourceSnapshot, type UsageQueryBatchResult,
    type UsageQuerySourceState, type UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { projectUsageAnalyticsSummary } from '@happier-dev/protocol/usage/usageCost';
import { admitUsageCoachRemedies, applyUsageCoachPreferences } from '@happier-dev/protocol/usage/coach/evaluateUsageCoach';
import { readConnectedSubscriptionMonthlyPriceV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { projectProviderAccountUsageEnteredPriceV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { UsageCoachSuppressionStateV1 } from '@happier-dev/protocol/usage/coach/coachActions';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { readAccountSettingsForScope } from '@/sync/domains/state/accountSettingsPersistence';
import { retainIfEqual } from '@/sync/domains/state/structuralSharing';
import { getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { buildUsageCoachRemedies } from '@/sync/domains/usage/buildUsageCoachRemedies';
import { projectUsageQueryWorkEvidence } from '@/sync/domains/usage/usageWorkEvidence';
import type { SessionInputEvidence } from './usageQuerySessionInputs';
import { projectUsageQueryProfileEvidence } from './usageQueryProfileEvidence';

export type HowYouWorkEvidenceSnapshot = Readonly<{
    query: UsageQuery; asOfMs: number;
    sessions: readonly SessionInputEvidence['session'][];
    sessionCoverage: NonNullable<UsageHowYouWorkSourceSnapshot['sessionCoverage']>;
    detail: ReturnType<typeof projectUsageQueryWorkEvidence>;
    errorCode?: string;
    updateRequired?: UsageHowYouWorkSourceSnapshot['updateRequired'];
}>;
export type HowYouWorkReadSnapshot = HowYouWorkEvidenceSnapshot
    | Readonly<{ query: UsageQuery; errorCode: string; detail?: undefined; sessions?: undefined }>;

export type OpenedQuotaRead = NonNullable<Parameters<typeof resolveUsagePageAggregation>[0]['quota']> & Readonly<{
    sources?: readonly UsageQuerySourceState[];
}>;

export type UsageQueryReprojection = (signal?: AbortSignal) => UsageQueryBatchResult;

/** Presentation derived from the same admitted answer; never serialized with its source. */
export type PreparedUsageAccountingSnapshot = UsageAccountingSourceSnapshot & Readonly<{
    delivery?: {
        readonly input: NonNullable<UsageAccountingSourceSnapshot['value']>;
        projectedInput: NonNullable<UsageAccountingSourceSnapshot['value']>;
        value: NonNullable<UsageAccountingSourceSnapshot['value']>;
        readonly observationRange: UsageQueryResultSlice['accountingObservationRange'];
    };
}>;

function observedAccountingRange(value: UsageQueryResultSlice['accounting']): UsageQueryResultSlice['accountingObservationRange'] {
    if (!value?.contributions?.length) return undefined;
    let startMs = Infinity;
    let endMs = 0;
    for (const row of value.contributions) {
        startMs = Math.min(startMs, row.observedAtMs);
        endMs = Math.max(endMs, row.observedAtMs + 1);
    }
    return { startMs, endMs };
}

/** Keep the rich admitted input for private calculations, with its bounded public presentation facts. */
function prepareAccountingDelivery(snapshot: PreparedUsageAccountingSnapshot, nowMs: number): PreparedUsageAccountingSnapshot {
    if (snapshot.query.includeContributions || snapshot.query.population !== 'public_eligible_personal'
        && snapshot.query.includeWorkEvidence && snapshot.query.workProjection === 'detail') return snapshot;
    const projection = snapshot.priceProjection;
    const value = projection?.value ?? snapshot.value;
    if (!value || snapshot.delivery?.input === value) return snapshot;
    const compact = projectUsageAnalyticsSummary(value, usageQueryToAnalyticsRequest(snapshot.query, nowMs));
    const observationRange = projection?.observationRange ?? observedAccountingRange(projection?.input ?? value);
    const prepared = value.summary === compact.summary ? value : { ...value, summary: compact.summary };
    const delivery = { input: prepared, projectedInput: prepared, value: compact, observationRange };
    return projection ? { ...snapshot, delivery, priceProjection: { ...projection, value: prepared, observationRange } }
        : { ...snapshot, delivery, value: prepared };
}

/** Raw accounting is consumed above this boundary; only exports and real Work allocations publish it. */
function projectAccountingDelivery(slice: UsageQueryResultSlice, accounting: ReadonlyMap<string, PreparedUsageAccountingSnapshot>,
    previous: UsageQueryResultSlice | undefined, nowMs: number): UsageQueryResultSlice {
    const compact = (value: UsageQueryResultSlice['accounting'], query: UsageQuery) => {
        if (!value || slice.requestedQuery.includeContributions) return value;
        const delivery = accounting.get(getUsageQueryKey(query))?.delivery;
        if (!delivery) return projectUsageAnalyticsSummary(value, usageQueryToAnalyticsRequest(query, nowMs));
        // The canonical source-label projection can wrap the retained rich
        // input. Keep its compact output on this same admitted preparation.
        if (delivery.projectedInput !== value) {
            delivery.value = retainAccountingReferences(projectUsageAnalyticsSummary(value, usageQueryToAnalyticsRequest(query, nowMs)), delivery.value)!;
            delivery.projectedInput = value;
        }
        return delivery.value;
    };
    const snapshot = accounting.get(slice.key);
    // The accounting owner retained this exact admitted input after a failed read.
    // Keep its presentation witness too, but never carry it into a new answer.
    const retainedRange = snapshot?.value && snapshot.value === previous?.accounting ? previous.accountingObservationRange : undefined;
    const observationRange = slice.work || slice.requestedQuery.includeContributions ? undefined
        : snapshot?.priceProjection?.observationRange ?? (snapshot?.delivery?.input === snapshot?.value
            ? snapshot?.delivery?.observationRange : undefined) ?? observedAccountingRange(slice.accounting) ?? retainedRange;
    return { ...slice,
        ...(observationRange ? { accountingObservationRange: observationRange } : {}),
        ...(slice.accounting && !slice.work ? { accounting: compact(slice.accounting, slice.shownQuery) } : {}),
        ...(slice.comparison?.accounting ? { comparison: { ...slice.comparison,
            accounting: compact(slice.comparison.accounting, slice.comparison.query) } } : {}),
    };
}

type UsageQueryProjectionInput = Readonly<{
    coachSuppressions?: UsageCoachSuppressionStateV1;
    context: Readonly<{ accountLifetime: ServerAccountScopeLifetime }>;
    queries: readonly UsageQuery[];
    accountingNowMs: number;
    accounting: Map<string, PreparedUsageAccountingSnapshot>;
    /** Derived accounting stays with the Account's admitted answer across finite reads. */
    prepareAccounting(snapshot: PreparedUsageAccountingSnapshot,
        prepare: (snapshot: PreparedUsageAccountingSnapshot) => PreparedUsageAccountingSnapshot): PreparedUsageAccountingSnapshot;
    priorAccounting: ReadonlyMap<string, Readonly<{ value: UsageQueryBatchResult['results'][number]['accounting']; asOfMs: number | undefined }>>;
    calendarQueryKeys: ReadonlySet<string>;
    previous: UsageQueryBatchResult | undefined;
    admittedPrevious: UsageQueryBatchResult | undefined;
    work: readonly UsageWorkSourceSnapshot[];
    howYouWork: readonly HowYouWorkReadSnapshot[] | undefined;
    howYouWorkSourcesByQuery: ReadonlyMap<string, readonly UsageQuerySourceState[]>;
    settledHowYouWorkQueries: ReadonlySet<string>;
    evidenceQueries: readonly UsageQuery[];
    quota: OpenedQuotaRead;
    pools: readonly UsagePoolSourceSnapshot[];
    priorSlices: ReadonlyMap<string, UsageQueryBatchResult['results'][number]>;
    mcpCatalog: McpServerCatalogSnapshotV1 | undefined;
    sourceLocations: readonly Readonly<{ machineId: string; displayLocation: string }>[];
}>;

/** Overlay only the current entered-price fact; allowance/history admission is unchanged. */
export function projectUsageEnteredPrices(quota: OpenedQuotaRead, scope: ServerAccountScope): OpenedQuotaRead {
    const presentation = getConnectedMetadataCatalog(scope).presentation;
    if ((presentation.status !== 'ready' && presentation.status !== 'partial') || !quota.value) return quota;
    const value = quota.value.map(read => {
        const current = read.current;
        if (!current || read.source.bindingKind !== 'account') return read;
        const enteredMonthlyPrice = readConnectedSubscriptionMonthlyPriceV1(presentation, read.source.ref) ?? undefined;
        if (sameStrictJsonValue(current.subscription?.enteredMonthlyPrice, enteredMonthlyPrice)) return read;
        return { ...read, current: projectProviderAccountUsageEnteredPriceV1(current, enteredMonthlyPrice) };
    });
    return value.every((read, index) => read === quota.value![index]) ? quota : { ...quota, value };
}

type ProjectionSettings = NonNullable<Parameters<typeof resolveUsagePageAggregation>[0]['accountSettings']>;
type ProjectionInputs = Readonly<Record<string, unknown>>;
type RetainedSliceProjection = Readonly<{ inputs: ProjectionInputs; slice: UsageQueryResultSlice; previous: UsageQueryResultSlice | undefined }>;
type ReadProjection = {
    lifetime: ServerAccountScopeLifetime;
    slices: Map<string, RetainedSliceProjection>;
    settings?: ProjectionSettings;
    locations?: UsageQueryProjectionInput['sourceLocations'];
    batch?: UsageQueryBatchResult;
};
// This is the finite read's existing mutable source collection, also captured by
// its reproject closure. Retention ends with that read, not a new Account cache.
const readProjections = new WeakMap<UsageQueryProjectionInput['accounting'], ReadProjection>();

export function projectUsageQueryBatch(input: UsageQueryProjectionInput): UsageQueryBatchResult {
    const { context, queries, accountingNowMs, accounting, priorAccounting, calendarQueryKeys } = input;
    const retainedState = readProjections.get(accounting);
    const state: ReadProjection = retainedState?.lifetime === context.accountLifetime ? retainedState
        : { lifetime: context.accountLifetime, slices: new Map() };
    if (state !== retainedState) readProjections.set(accounting, state);
    const settingsState = readRegisteredStorageState();
    const openedSettings = readAccountSettingsForScope({ scope: context.accountLifetime.scope,
        focusedScope: settingsState?.settingsScope, focusedSettings: settingsState?.settings ?? settingsDefaults });
    const retainSetting = <T,>(value: T, prior: T): T => sameStrictJsonValue(value, prior) ? prior : value;
    const accountSettings: ProjectionSettings = {
        usageModelPriceOverridesV1: retainSetting(openedSettings.usageModelPriceOverridesV1, state.settings?.usageModelPriceOverridesV1),
        usageNightHoursV1: retainSetting(openedSettings.usageNightHoursV1, state.settings?.usageNightHoursV1),
        usageCoachPreferencesV1: retainSetting({ ...openedSettings.usageCoachPreferencesV1,
            suppressions: input.coachSuppressions?.suppressions ?? [] }, state.settings?.usageCoachPreferencesV1),
    };
    state.settings = accountSettings;
    // Accounting reductions belong to the admitted A response, not each quota/selection publication.
    // The Account answer retains the prepared snapshot across finite reads.
    for (const [key, snapshot] of accounting) {
        // Admit references at the existing producer snapshot, not only in
        // the published slice. Source labels/progress may replace wrappers
        // without changing the already admitted contribution population.
        const prepared = input.prepareAccounting(snapshot, retained => {
            const pricedSnapshot = projectUsageAccountingSnapshotPrices(retained, accountSettings.usageModelPriceOverridesV1,
                accounting.values(), priorAccounting.get(key)?.value);
            const priced = prepareAccountingDelivery(pricedSnapshot, accountingNowMs);
            return calendarQueryKeys.has(key) ? projectUsageAccountingSnapshotCalendar(priced, accounting.values()) : priced;
        });
        accounting.set(key, prepared);
    }
    const locations = sameStrictJsonValue(state.locations, input.sourceLocations) ? state.locations : input.sourceLocations;
    state.locations = locations;
    const work = new Map(input.work.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
    const detail = new Map(input.howYouWork?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
    const pools = new Map(input.pools.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value]));
    const admitted = new Map(input.admittedPrevious?.results.map(slice => [slice.key, slice]));
    const previous = new Map(input.previous?.results.map(slice => [slice.key, slice]));
    const baseDetailStatus = input.settledHowYouWorkQueries.size < input.evidenceQueries.length ? 'pending'
        : input.evidenceQueries.length === 0 ? 'not_loaded' : undefined;
    const inputsFor = (query: UsageQuery, key: string, slice: UsageQueryResultSlice | undefined): ProjectionInputs => {
        const snapshot = accounting.get(key);
        // The comparison owner chooses the actual witnessed window. Observe its
        // last output as well as the current requested comparison, without
        // deciding retention/rolling-window policy again here.
        const requestedComparison = resolveUsageComparisonQuery(query, snapshot?.period);
        const comparison = slice?.comparison;
        const oldComparison = previous.get(key)?.comparison;
        const coach = slice?.coach;
        const retained = state.slices.get(key)?.inputs;
        // Push readers may replace equal envelopes. Retain the complete equal
        // input without rebuilding its nested populations: this witness only
        // decides whether projection is needed, and is not a new data producer.
        return retainIfEqual(retained, { query, accounting: snapshot,
            requestedComparison: requestedComparison ? accounting.get(getUsageQueryKey(requestedComparison)) : undefined,
            comparison: comparison ? accounting.get(getUsageQueryKey(comparison.query)) : undefined,
            oldComparison: oldComparison ? accounting.get(getUsageQueryKey(oldComparison.query)) : undefined,
            priorAccounting: priorAccounting.get(key), calendar: calendarQueryKeys.has(key), previous: previous.get(key), prior: input.priorSlices.get(key),
            accountingNowMs, work: work.get(key), detail: detail.get(key), stages: input.howYouWorkSourcesByQuery.get(key),
            settled: input.settledHowYouWorkQueries.has(key), baseDetailStatus: query.includeSessionEvidence ? baseDetailStatus : undefined,
            quota: input.quota, pools: pools.get(key), mcpCatalog: input.mcpCatalog, locations,
            pricing: accountSettings.usageModelPriceOverridesV1, night: accountSettings.usageNightHoursV1, preferences: accountSettings.usageCoachPreferencesV1,
            suppressions: input.coachSuppressions,
            // Snooze expiry remains owned by the canonical suppression
            // projector. Its unchanged result permits reuse without a timer.
            coach: coach && input.coachSuppressions && applyUsageCoachPreferences(coach, input.coachSuppressions, Date.now()) });

    };
    const dirty = queries.filter(query => {
        const key = getUsageQueryKey(query);
        const retained = state.slices.get(key);
        if (!retained || admitted.get(key) !== retained.previous) return true;
        const inputs = inputsFor(query, key, retained.slice);
        return Object.entries(inputs).some(([name, value]) => value !== retained.inputs[name]);
    });
    const projected = dirty.length ? projectChangedUsageQueryBatch({ ...input, queries: dirty }, accountSettings) : undefined;
    const changed = new Map(projected?.results.map(slice => [slice.key, slice]));
    const results = queries.map(query => {
        const key = getUsageQueryKey(query);
        return changed.get(key) ?? state.slices.get(key)!.slice;
    });
    const batch = retainUsageQueryResultReferences({ v: 1, results }, state.batch);
    for (const [index, query] of queries.entries()) {
        const key = getUsageQueryKey(query);
        const slice = batch.results[index]!;
        state.slices.set(key, { inputs: inputsFor(query, key, slice), slice, previous: admitted.get(key) });
    }
    state.batch = batch;
    return batch;
}

function projectChangedUsageQueryBatch(input: UsageQueryProjectionInput, accountSettings: ProjectionSettings): UsageQueryBatchResult {
    const { context, queries, accountingNowMs, accounting, previous, admittedPrevious,
        work, howYouWork, howYouWorkSourcesByQuery, settledHowYouWorkQueries, evidenceQueries, quota, pools, priorSlices, mcpCatalog } = input;
    if (queries.every(query => !query.includeAccounting)) {
        return resolveUsageQuotaPageAggregation({ queries, previous: admittedPrevious, quota, pools,
            sources: quota.sources, nowMs: accountingNowMs });
    }
    const sourceLocations = input.sourceLocations;
    // A rolling reread requests a new absolute window. Until current
    // accounting answers, the displayed window still owns its exact old
    // comparison; it is being replaced, not definitively absent.
    const witnessedComparison = previous?.results.flatMap(slice => {
        const comparison = slice.comparison;
        if (!comparison?.accounting || accounting.has(getUsageQueryKey(comparison.query))) return [];
        return [{ query: comparison.query, value: comparison.accounting,
            status: accounting.get(slice.key)?.status === 'pending' ? 'pending' as const : 'stale' as const,
            ...(comparison.source.asOfMs === undefined ? {} : { asOfMs: comparison.source.asOfMs }) }];
    }) ?? [];
    // Aggregation retains rich operands; its previous input must be the rich
    // side of the exact delivery pair, including its current source labels.
    const restoreAccountingInput = (query: UsageQuery, value: UsageQueryResultSlice['accounting']) => {
        const delivery = accounting.get(getUsageQueryKey(query))?.delivery;
        return delivery && delivery.value === value ? delivery.projectedInput : value;
    };
    const aggregationPrevious = admittedPrevious && { ...admittedPrevious, results: admittedPrevious.results.map(slice => {
        const value = restoreAccountingInput(slice.shownQuery, slice.accounting);
        const comparison = slice.comparison;
        const compared = comparison && restoreAccountingInput(comparison.query, comparison.accounting);
        return value === slice.accounting && compared === comparison?.accounting ? slice : { ...slice,
            accounting: value, ...(comparison ? { comparison: { ...comparison, accounting: compared } } : {}) };
    }) };
    const batch = resolveUsagePageAggregation({ queries, accounting: [...accounting.values(), ...witnessedComparison], previous: aggregationPrevious,
        sourceLocations,
        accountSettings,
        coachPreferences: input.coachSuppressions ? accountSettings.usageCoachPreferencesV1 : null,
        quota, pools, work, howYouWork, nowMs: accountingNowMs,
        sources: [...(quota.sources ?? []), ...(settledHowYouWorkQueries.size < evidenceQueries.length
            ? [{ source: 'how_you_work', status: 'pending' as const }]
            : evidenceQueries.length === 0 ? [{ source: 'how_you_work', status: 'not_loaded' as const }] : [])] });
    // The base source remains pending until the complete private read
    // settles. Its staged facts and reading phases belong to this query,
    // never a held sibling in the same batch.
    const staged = { ...batch, results: batch.results.map(slice => {
        const sources = howYouWorkSourcesByQuery.get(slice.key);
        if (!sources) return slice;
        const pending = !settledHowYouWorkQueries.has(slice.key);
        const observed = [...slice.sources].reverse().find(source => source.source === 'how_you_work');
        return { ...slice, pending: slice.pending || pending,
            sources: [...slice.sources.filter(source => source.source !== 'how_you_work'),
                { ...observed, source: 'how_you_work', status: pending ? 'pending' as const : observed?.status ?? 'unknown' },
                ...sources] };
    }) };
    const preferredDetails = applyCoachPreferences(staged, howYouWork ?? [], context.accountLifetime.scope, mcpCatalog, input.coachSuppressions, previous);
    const workByQuery = new Map(work.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
    const preferred = { ...preferredDetails, results: preferredDetails.results.map(slice =>
        projectUsageQueryProfileEvidence(slice, workByQuery.get(slice.key))) };
    return { ...preferred, results: preferred.results.map(rawSlice => {
        const slice = projectAccountingDelivery(rawSlice, accounting, priorSlices.get(rawSlice.key), accountingNowMs);
        const priorSources = priorSlices.get(slice.key)?.sources;
        if (!priorSources) return slice;
        return { ...slice, sources: slice.sources.map(source => {
            if (source.status !== 'pending') return source;
            const prior = priorSources.find(candidate => candidate.source === source.source);
            // Keep the admitted observation's date and any settled failure
            // while its replacement is in flight. Slice/Resource pending
            // still reports the actual work; it does not erase that result.
            if (prior?.status === 'error') return prior;
            return source.asOfMs === undefined && prior?.asOfMs !== undefined
                ? { ...source, asOfMs: prior.asOfMs } : source;
        }) };
    }) };
}

function applyCoachPreferences(batch: UsageQueryBatchResult, howYouWork: readonly HowYouWorkReadSnapshot[],
    scope: ServerAccountScope, mcpCatalog: McpServerCatalogSnapshotV1 | undefined,
    suppressions: UsageCoachSuppressionStateV1 | undefined, previous: UsageQueryBatchResult | undefined): UsageQueryBatchResult {
    const openedByQuery = new Map(howYouWork.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
    const nowMs = Date.now();
    const results = batch.results.map(slice => {
        const opened = openedByQuery.get(slice.key);
        if (!slice.coach) return slice;
        // Accounting can publish before the separate dismissal read settles.
        // Retain only the already-suppressed answer for this exact query.
        if (!suppressions) return { ...slice, coach: previous?.results.find(prior => prior.key === slice.key)?.coach };
        const proposals = !opened?.detail || opened.detail.status === 'unknown' ? [] : buildUsageCoachRemedies({ findings: slice.coach.findings.filter(finding => finding.remedy === null),
            composition: opened.detail.coach?.composition ?? [], sessions: opened.sessions,
            mcpUsage: opened.detail.coach?.detail?.mcpUsage ?? [], ...(mcpCatalog ? { mcpCatalog } : {}),
            serverId: scope.serverId, accountId: scope.accountId });
        const coach = proposals.length === 0 ? slice.coach : admitUsageCoachRemedies(slice.coach,
            [...(opened?.detail?.coach?.admittedRemedies ?? []), ...proposals]);
        const preferred = applyUsageCoachPreferences(coach, suppressions, nowMs);
        return preferred === slice.coach ? slice : { ...slice, coach: preferred };
    });
    return results.every((slice, index) => slice === batch.results[index]) ? batch : { ...batch, results };
}
