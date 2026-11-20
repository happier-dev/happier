import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { consumeProviderAccountUsageHistoryStream } from './providerAccountUsageHistoryStream';
import {
    createServerFetchForActiveServer,
    type ExpectedActiveServerFetchBasis,
} from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';

import { ProviderAccountUsageRecordIdSchema, type ProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol/connect/account-usage-primitives';
import { QualifiedProviderAccountUsageReadErrorV4Schema, QualifiedProviderAccountUsageRecordResponseV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { z } from 'zod/mini';
import { ConnectedServiceQuotaGetInputV1Schema, QualifiedProviderAccountUsageHistoryRequestV4Schema, QualifiedProviderAccountUsageHistoryResponseV4Schema, openProviderAccountUsageRecordV4, createProviderAccountUsageHistoryEntryOpenerV4, projectProviderAccountUsageEnteredPriceV1, projectProviderAccountUsageQuotaReadV1, ProviderAccountUsageReadErrorV1, type ConnectedServiceQuotaGetInputV1, type ConnectedServiceQuotaGetResultV1, type ProviderAccountUsageHistoryWitnessV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { QualifiedConnectedServiceUsageSourceResolveV4Schema, QualifiedConnectedServiceUsageSourceResolutionV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { encodeQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { UsagePacingTargetsV1 } from '@happier-dev/protocol/account/settings/usagePacingPreferencesV1';
import type { ServerFetch } from '@/sync/http/client';
import { PendingResetStartsReadInputV1Schema, PendingResetStartsReadResultV1Schema,
    type PendingResetStartsReadResultV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { evaluatePendingResetStartReadinessV1 } from '@happier-dev/protocol/sessions/pending/pendingResetStartReadinessV1';
import type { ProviderAccountUsageWaitingWorkV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { mapCryptoBatchWithYield } from '@/sync/encryption/cryptoBatchYield';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { ProviderAccountUsagePageProjectionReadV1Schema, ProviderAccountUsagePageProjectionWriteV1Schema,
    buildProviderAccountUsagePageProjectionV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING,
    packProviderAccountUsagePageProjectionV1, createProviderAccountUsagePageProjectionOpenerV1,
    ProviderAccountUsagePageProjectionPrefixReadV1Schema,
    type ProviderAccountUsagePageProjectionCoverageV1Schema } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { sealProviderAccountUsagePageProjectionV1, openProviderAccountUsagePageProjectionV1,
    openProviderAccountUsagePageProjectionReadV1 } from '@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { getProviderAccountUsageDerivationInterval, resolveProviderAccountUsageRecentHistoryRangesV1,
    type ProviderAccountUsageRecentHistoryRangesV1 } from '@happier-dev/protocol/connect/deriveProviderAccountUsagePace';
import { createCapturedServerReadTransport, type CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { createScopedResolutionSingleFlight, type ScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveActiveServerRuntimeOrigin } from '@/sync/runtime/nativeLoopbackTunnels/runtimeOrigin';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { PROVIDER_ACCOUNT_USAGE_DAY_MS, ProviderAccountUsageDaySummaryReadV1Schema, ProviderAccountUsageDaySummaryResponseV1Schema,
    buildProviderAccountUsageDaySummaryV1, openProviderAccountUsageDaySummaryV1, type ProviderAccountUsageDaySummaryV1,
    type StoredProviderAccountUsageDaySummaryV1 } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import type { ProviderAccountUsageDayChangeV1 } from '@happier-dev/protocol/changes/providerAccountUsage';

type UsageHttpObservation = Readonly<{
    status: number; ok: boolean; json: unknown; jsonFailure?: Readonly<{ error: unknown }>;
    etag: string | null;
    complete: string | null; prefix: string | null;
}>;
const usageHttpReads = createScopedResolutionSingleFlight<UsageHttpObservation>();

type ProjectionCustody = {
    accountMode: 'plain' | 'e2ee';
    credentialScope: string;
    materialType?: AccountScopedCryptoMaterial['type'];
    materialBytes?: Uint8Array;
};

type AdmittedUsageProjection = ProjectionCustody & {
    opened: ReturnType<typeof openProviderAccountUsagePageProjectionV1>;
    settled?: { range: HistoryRange; coverage: DailyHistoryCoverage };
    view?: {
        record: unknown;
        history: NonNullable<ConnectedServiceQuotaGetResultV1['history']>;
        nowMs: number;
        interval: ReturnType<typeof getProviderAccountUsageDerivationInterval>;
        value: ConnectedServiceQuotaGetResultV1;
        daySummaries?: readonly ProviderAccountUsageDaySummaryV1[];
    };
};

/** The existing Account Resource retains one admitted B representation per record. */
type HeldExactUsageProjection = {
    projection: NonNullable<z.infer<typeof ProviderAccountUsagePageProjectionReadV1Schema>['projection']>;
    etag: string;
    admitted?: AdmittedUsageProjection;
};
type HistoryRange = Readonly<{ startAtMs: number; endAtMs: number }>;
type DayHistoryEvidence = Readonly<{
    summary?: ProviderAccountUsageDaySummaryV1;
    coverage?: StoredProviderAccountUsageDaySummaryV1['coverage'];
    observationCursor?: number;
}>;
type DailyHistoryCoverage = ReadonlyMap<number, DayHistoryEvidence>;
function sameDayHistoryEvidence(previous: DayHistoryEvidence | undefined, next: DayHistoryEvidence | undefined): boolean {
    return sameStrictJsonValue(previous?.coverage, next?.coverage) && sameStrictJsonValue(previous?.summary, next?.summary);
}
export type ProviderAccountUsageQuotaViewDemand = Readonly<{ key: string; range?: HistoryRange; exact: boolean }>;
type DailySummaryBasis = Readonly<{
    throughCursor: number | undefined;
    source: ConnectedServiceQuotaGetInputV1['source'];
    current: ProviderAccountUsageSnapshotV1 | null;
    summaries: readonly ProviderAccountUsageDaySummaryV1[];
    missingDays: readonly Readonly<{ dayStartAtMs: number }>[];
    coverage: DailyHistoryCoverage;
}>;
type DailyRecentBasis = Readonly<{
    throughCursor: number | undefined;
    ranges: readonly HistoryRange[];
    history: NonNullable<ConnectedServiceQuotaGetResultV1['history']>;
    coverage: DailyHistoryCoverage;
}>;
type PendingResetStartBasis = ProjectionCustody & Readonly<{
    throughCursor: number;
    entries: readonly Readonly<{ entry: PendingResetStartsReadResultV1['entries'][number]; witness: ProviderAccountUsageSnapshotV1 | null }>[];
    unboundEntries: PendingResetStartsReadResultV1['unboundEntries'];
    coverage?: DailyHistoryCoverage;
}>;
type HeldUsageProjection = {
    exact?: HeldExactUsageProjection;
    daily?: ProjectionCustody & DailySummaryBasis & { recent?: DailyRecentBasis };
    pendingBySource?: ReadonlyMap<string, PendingResetStartBasis>;
};
type AdmittedDayPublication = Readonly<{
    kind: NonNullable<ProviderAccountUsageDayChangeV1['publication']>['kind'];
    prior: NonNullable<HeldUsageProjection['daily']>;
}>;
export type ProviderAccountUsageProjectionDocuments = Map<string, HeldUsageProjection>;
function hasUsageProjectionCustody(prior: ProjectionCustody | undefined, options: ProviderAccountUsageQuotaReadOptions,
    credentialScope: string, materialBytes: Uint8Array | undefined): boolean {
    return prior?.accountMode === options.accountMode && prior.credentialScope === credentialScope
        && prior.materialType === options.material?.type
        && (materialBytes === undefined ? prior.materialBytes === undefined
            : prior.materialBytes?.length === materialBytes.length && materialBytes.every((byte, index) => byte === prior.materialBytes![index]));
}

export type ProviderAccountUsageQuotaReadOptions = Readonly<{
    accountMode: 'plain' | 'e2ee'; request?: ServerFetch; assertCurrent?: () => void;
    readTransport?: CapturedServerReadTransport;
    material?: AccountScopedCryptoMaterial; signal?: AbortSignal; nowMs?: number;
    expectedActiveServer?: ExpectedActiveServerFetchBasis; targets?: UsagePacingTargetsV1;
    includePendingWork?: boolean;
    /** Day facts and current-window operands; exact observations are acquired only when separately demanded. */
    historyView?: 'daily';
    exactHistoryRange?: Readonly<{ startAtMs: number; endAtMs: number }>;
    dayChange?: ProviderAccountUsageDayChangeV1;
    changesCursor?: number;
    projectionDocuments?: ProviderAccountUsageProjectionDocuments;
    /** Settings are an independent facet, never a prerequisite for current capacity. */
    readPacingTargets?: () => Promise<UsagePacingTargetsV1>;
    readEnteredMonthlyPrice?: () => Promise<import('@happier-dev/protocol/connect/accountSubscription').ProviderAccountSubscriptionMonthlyPriceV1 | undefined>;
    /** Drain the requested range under one captured read; ordinary Action callers still receive one page. */
    readAllHistory?: Readonly<{
        /** Host-only projections of the shared operands, including current-only demand. */
        views?: readonly ProviderAccountUsageQuotaViewDemand[];
        onProgress(value: ConnectedServiceQuotaGetResultV1, views?: ReadonlyMap<string, ConnectedServiceQuotaGetResultV1>): void;
        onViewFailure?(source: ConnectedServiceQuotaGetInputV1['source'], queryKeys: readonly string[], error: unknown): void;
    }>;
}>;

function subtractHistoryRange(range: HistoryRange, removed: HistoryRange): HistoryRange[] {
    if (removed.endAtMs <= range.startAtMs || removed.startAtMs >= range.endAtMs) return [range];
    return [
        ...(removed.startAtMs > range.startAtMs ? [{ startAtMs: range.startAtMs, endAtMs: removed.startAtMs }] : []),
        ...(removed.endAtMs < range.endAtMs ? [{ startAtMs: removed.endAtMs, endAtMs: range.endAtMs }] : []),
    ];
}

export async function getProviderAccountUsageQuota(credentials: AuthCredentials, input: ConnectedServiceQuotaGetInputV1,
    inputOptions: Omit<ProviderAccountUsageQuotaReadOptions, 'accountMode'> & Readonly<{
        accountMode: ProviderAccountUsageQuotaReadOptions['accountMode'] | Promise<ProviderAccountUsageQuotaReadOptions['accountMode']>;
    }>): Promise<ConnectedServiceQuotaGetResultV1> {
    const transportOptions = { ...inputOptions, request: inputOptions.request ?? createServerFetchForActiveServer(inputOptions.expectedActiveServer) };
    const request = ConnectedServiceQuotaGetInputV1Schema.parse(input);
    // Address resolution and encrypted-byte acquisition need the captured
    // Account, not its mode. Opening still waits for the authoritative mode.
    const [{ resolution, recordJson, retainedCurrent, publication }, accountMode] = await Promise.all([(async () => {
        const day = inputOptions.dayChange;
        const prior = day && inputOptions.projectionDocuments?.get(day.recordId)?.daily;
        let publication: AdmittedDayPublication | undefined;
        if (request.projection && inputOptions.historyView === 'daily' && !inputOptions.exactHistoryRange
            && prior?.current && day?.publication && (prior.throughCursor ?? -1) >= day.publication.afterCursor
            && sameStrictJsonValue(prior.source, request.source)) {
            const mode = await inputOptions.accountMode;
            const material = mode === 'e2ee' ? inputOptions.material ?? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : undefined;
            const materialBytes = material?.type === 'legacy' ? material.secret : material?.machineKey;
            if (hasUsageProjectionCustody(prior, { ...transportOptions, accountMode: mode, material }, resolveAuthCredentialsScopeKey(credentials), materialBytes)) {
                if (day.publication.kind === 'summary') {
                    return { resolution: null, recordJson: null, retainedCurrent: prior.current, publication: { kind: 'summary' as const, prior } };
                }
                if (day.history && !prior.missingDays.some(missing => missing.dayStartAtMs === day.dayStartAtMs)) publication = { kind: 'observation', prior };
            }
        }
        const sourceJson = (await requestProviderAccountUsageRead(credentials, `/v4/connect/qualified/provider-account-usage/sources/resolve?${new URLSearchParams({ source: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedServiceUsageSourceResolveV4Schema, request.source) }).toString()}`, transportOptions))?.json ?? null;
        const resolution = sourceJson === null ? null : QualifiedConnectedServiceUsageSourceResolutionV4Schema.parse(sourceJson);
        const recordJson = resolution ? (await requestProviderAccountUsageRead(credentials, `/v4/connect/qualified/provider-account-usage/record?recordId=${encodeURIComponent(resolution.recordId)}`, transportOptions))?.json ?? null : null;
        return { resolution, recordJson, retainedCurrent: null, publication: resolution?.recordId === day?.recordId ? publication : undefined };
    })(), inputOptions.accountMode]);
    let options: ProviderAccountUsageQuotaReadOptions = { ...transportOptions, accountMode };
    throwIfAborted(options.signal); options.assertCurrent?.();
    const material = options.accountMode === 'e2ee' ? options.material ?? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : undefined;
    const progressive = options.readAllHistory && (request.history || request.projection) && resolution;
    if (!request.projection && !progressive && options.readPacingTargets) options = { ...options, targets: await options.readPacingTargets() };
    const enteredMonthlyPrice = !request.projection && recordJson !== null && !progressive ? await options.readEnteredMonthlyPrice?.() : undefined;
    options.assertCurrent?.();
    let current = resolution && recordJson !== null ? openProviderAccountUsageRecordV4({ recordId: resolution.recordId, enteredMonthlyPrice, accountMode: options.accountMode, material, record: recordJson }) : retainedCurrent;
    if (current && resolution && current.recordKey.accountSubjectId !== resolution.providerAccountId) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_identity_mismatch');
    const projectedRecordId = resolution?.recordId ?? retainedCurrent?.recordId;
    if (request.projection && projectedRecordId) return await readProviderAccountUsageProjectedQuota(credentials, request, {
        ...options, material,
    }, projectedRecordId, current, recordJson, publication);
    const historyRequest = request.history;
    if (options.readAllHistory && historyRequest && resolution) {
        let history: ConnectedServiceQuotaGetResultV1['history'];
        let waitingWork: ProviderAccountUsageWaitingWorkV1 | undefined;
        let targets = options.targets;
        let daySummaries: ProviderAccountUsageDaySummaryV1[] | undefined;
        const project = (appendHistory?: ConnectedServiceQuotaGetResultV1['history']) => projectProviderAccountUsageQuotaReadV1({ input: request, current, history, appendHistory, waitingWork,
            targets, daySummaries, nowMs: options.nowMs ?? Date.now() });
        const publish = (appendHistory?: ConnectedServiceQuotaGetResultV1['history']) => { throwIfAborted(options.signal); options.assertCurrent?.(); const value = project(appendHistory); history = value.history; options.readAllHistory!.onProgress(value); return value; };
        // Current capacity is useful before either history or unrelated Pending work answers.
        publish();
        let active = true;
        const pacing = options.readPacingTargets ? options.readPacingTargets().then(value => {
            if (!active) return;
            targets = value; publish();
        }) : Promise.resolve();
        const pending = options.includePendingWork === false ? Promise.resolve() :
            readProviderAccountUsageWaitingWork(credentials, request, current, options).then(value => {
                if (!active) return;
                waitingWork = value.waitingWork; publish();
            });
        const initialCurrent = current;
        const price = initialCurrent && options.readEnteredMonthlyPrice ? options.readEnteredMonthlyPrice().then(enteredMonthlyPrice => {
            if (!active) return;
            throwIfAborted(options.signal); options.assertCurrent?.();
            current = projectProviderAccountUsageEnteredPriceV1(initialCurrent, enteredMonthlyPrice);
            publish();
        }) : Promise.resolve();
        const summaries = requestProviderAccountUsageDaySummaries(credentials, { recordId: resolution.recordId, range: historyRequest.range },
            { ...options, material }).then(value => {
            if (!active) return;
            daySummaries = value?.summaries ?? []; publish();
        });
        try {
            await Promise.all([(async () => {
                const openHistoryPage = createHistoryPageOpenerWithYield(resolution.recordId, { ...options, material });
                await drainProviderAccountUsageHistory(credentials, { recordId: resolution.recordId, history: historyRequest }, options, async page => {
                    // A parallel read may have failed while this response was
                    // pending. Its settled producer cannot open/publish another
                    // page or acquire the next cursor.
                    if (!active) throw Object.assign(new Error('Usage history read ended'), { name: 'AbortError' });
                    const opened = await openHistoryPage(page);
                    if (!active) throw Object.assign(new Error('Usage history read ended'), { name: 'AbortError' });
                    publish(opened);
                });
            })(), pending, price, pacing, summaries]);
            return project();
        } finally { active = false; }
    }
    const [page, daySummaries] = request.history && resolution ? await Promise.all([
        requestProviderAccountUsageHistoryPage(credentials, { recordId: resolution.recordId, history: request.history }, options),
        requestProviderAccountUsageDaySummaries(credentials, { recordId: resolution.recordId, range: request.history.range }, { ...options, material }),
    ]) : [null, undefined] as const;
    if (request.history && resolution && !page) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
    const { nowMs, waitingWork } = options.includePendingWork === false
        ? { nowMs: options.nowMs ?? Date.now(), waitingWork: undefined }
        : await readProviderAccountUsageWaitingWork(credentials, request, current, options);
    const history = request.history ? page && resolution
        ? await createHistoryPageOpenerWithYield(resolution.recordId, { ...options, material })(page)
        : { entries: [], nextCursor: null } : undefined;
    const result = projectProviderAccountUsageQuotaReadV1({ input: request, current, daySummaries: daySummaries?.summaries ?? (request.history ? [] : undefined), ...(history ? { history } : {}), nowMs, targets: options.targets, waitingWork });
    const views = options.readAllHistory?.views;
    if (views) options.readAllHistory?.onProgress(result, new Map(views.map(view => [view.key, result])));
    return result;
}

/** The B owner materializes exact accepted observations once; Plans never carries raw history trees. */
async function readProviderAccountUsageProjectedQuota(credentials: AuthCredentials, request: ConnectedServiceQuotaGetInputV1,
    options: ProviderAccountUsageQuotaReadOptions, recordId: string, initialCurrent: ProviderAccountUsageSnapshotV1 | null, recordJson: unknown,
    publication?: AdmittedDayPublication): Promise<ConnectedServiceQuotaGetResultV1> {
    const displayDemand = request.projection!;
    const daily = options.historyView === 'daily';
    const exactDemand = daily ? options.exactHistoryRange ? { ...displayDemand, range: options.exactHistoryRange } : null : displayDemand;
    const assertCurrent = () => { throwIfAborted(options.signal); options.assertCurrent?.(); };
    let current = initialCurrent;
    let history: ConnectedServiceQuotaGetResultV1['history'];
    let pageFacts: ConnectedServiceQuotaGetResultV1['pageFacts'];
    let waitingWork: ProviderAccountUsageWaitingWorkV1 | undefined;
    let targets = options.targets;
    let active = true;
    let admitted: AdmittedUsageProjection | undefined;
    let daySummaries: ProviderAccountUsageDaySummaryV1[] | undefined;
    let recentHistory: ConnectedServiceQuotaGetResultV1['history'];
    let recentHistorySelection: ProviderAccountUsageRecentHistoryRangesV1 | undefined;
    let dailyReady = false;
    let missingDays: readonly Readonly<{ dayStartAtMs: number }>[] | undefined;
    let dayCoverage: DailyHistoryCoverage | undefined;
    const credentialScope = resolveAuthCredentialsScopeKey(credentials);
    const materialBytes = options.material?.type === 'legacy' ? options.material.secret : options.material?.machineKey;
    const heldDaily = publication?.prior ?? options.projectionDocuments?.get(recordId)?.daily;
    const priorDaily = hasUsageProjectionCustody(heldDaily, options, credentialScope, materialBytes) ? heldDaily : undefined;
    const change = options.dayChange?.recordId === recordId ? options.dayChange : undefined;
    const scopeDay = daily && change && (priorDaily?.throughCursor ?? -1) >= change.afterCursor ? change : undefined;
    const changedDate = scopeDay && { startAtMs: scopeDay.dayStartAtMs, endAtMs: scopeDay.dayStartAtMs + PROVIDER_ACCOUNT_USAGE_DAY_MS };
    const throughCursor = change?.throughCursor ?? options.changesCursor;
    let settledRecent: DailyRecentBasis | undefined;
    // One instant per read: price, Pending and pacing revisions of this read keep its derived pace and
    // unused capacity instead of re-deriving them from the whole history at each later wall-clock reading.
    const readNowMs = options.nowMs ?? Date.now();
    const project = () => {
        const nowMs = readNowMs;
        const previous = admitted?.view;
        // The admitted record owns quota facts. Entered price is opened onto
        // current separately and does not change that history/pace basis.
        const sameBasis = !daily && previous && history === previous.history && sameStrictJsonValue(recordJson, previous.record)
            && sameStrictJsonValue(daySummaries ?? null, previous.daySummaries ?? null);
        if (sameBasis && (previous.nowMs === nowMs || previous.interval
            && nowMs >= previous.interval.fromMs && nowMs < previous.interval.untilMs)) return { ...previous.value, current, source: request.source,
            targets: targets ?? [], waitingWork: waitingWork ?? { status: 'unavailable' as const, reason: 'read_failed' as const } };
        const value = projectProviderAccountUsageQuotaReadV1({ input: request, current, history, pageFacts: daily ? undefined : pageFacts,
            waitingWork, targets, daySummaries, nowMs, recentHistory, recentHistorySelection, missingDays,
            ...(daily && exactDemand ? { exactHistoryRange: exactDemand.range } : {}) });
        // History settles once in this read. Price and Pending revisions change
        // independent facets, so keep its admitted page facts for them.
        pageFacts = value.pageFacts;
        if (!daily && admitted && history) admitted.view = { record: recordJson, history, nowMs, value, daySummaries,
            interval: getProviderAccountUsageDerivationInterval({ current, history: history.entries.map(entry => entry.snapshot), nowMs }) };
        return value;
    };
    const viewGroups = new Map<string, { range?: HistoryRange; exact: boolean; keys: string[]; projected?: ConnectedServiceQuotaGetResultV1 }>();
    for (const { key, range, exact } of options.readAllHistory?.views ?? []) {
        const identity = JSON.stringify([range?.startAtMs, range?.endAtMs, exact]);
        const group = viewGroups.get(identity);
        if (group) group.keys.push(key);
        else viewGroups.set(identity, { range, exact, keys: [key] });
    }
    const projectViews = () => {
        const views = new Map<string, ConnectedServiceQuotaGetResultV1>();
        let head: ConnectedServiceQuotaGetResultV1 | undefined;
        for (const group of viewGroups.values()) {
            const { range, exact, keys } = group;
            let value: ConnectedServiceQuotaGetResultV1;
            if (!range || !(exact ? history : dailyReady)) value = head ??= projectProviderAccountUsageQuotaReadV1({ input: { source: request.source },
                current, nowMs: readNowMs, targets, waitingWork });
            else if (exact && !daily && range.startAtMs === displayDemand.range.startAtMs && range.endAtMs === displayDemand.range.endAtMs) value = project();
            else {
                // Select raw accepted observations and day operands before deriving
                // windows, coverage, curves or cursors for this view.
                const overlaps = ({ dayStartAtMs }: { dayStartAtMs: number }) => dayStartAtMs < range.endAtMs
                    && dayStartAtMs + PROVIDER_ACCOUNT_USAGE_DAY_MS > range.startAtMs;
                const facts = group.projected ??= projectProviderAccountUsageQuotaReadV1({
                    input: { source: request.source, projection: { ...displayDemand, range } }, current, nowMs: readNowMs, targets, waitingWork,
                    daySummaries: exact ? daySummaries?.filter(overlaps) : daySummaries, missingDays: missingDays?.filter(overlaps),
                    ...(exact ? { history: { entries: history!.entries.filter(entry => range.startAtMs <= entry.observedAtMs
                        && entry.observedAtMs < range.endAtMs), nextCursor: null }, exactHistoryRange: range }
                        : { recentHistory, recentHistorySelection }),
                });
                value = facts.current === current && (targets === undefined || facts.targets === targets)
                    && (waitingWork === undefined || facts.waitingWork === waitingWork) ? facts : {
                        ...facts, current, targets: targets ?? facts.targets, waitingWork: waitingWork ?? facts.waitingWork,
                    };
                group.projected = value;
            }
            for (const key of keys) views.set(key, value);
        }
        return views;
    };
    const publish = () => {
        assertCurrent();
        const progress = options.readAllHistory;
        if (!progress) return;
        const views = viewGroups.size ? projectViews() : undefined;
        // Usage consumes the keyed views. It has no use for a union history projection.
        progress.onProgress(views?.values().next().value ?? project(), views);
    };
    publish();
    const pacing = options.readPacingTargets ? options.readPacingTargets().then(value => {
        if (!active) return;
        targets = value; publish();
    }) : Promise.resolve();
    const price = initialCurrent && options.readEnteredMonthlyPrice ? options.readEnteredMonthlyPrice().then(enteredMonthlyPrice => {
        if (!active) return;
        assertCurrent();
        current = projectProviderAccountUsageEnteredPriceV1(initialCurrent, enteredMonthlyPrice);
        publish();
    }) : Promise.resolve();
    const openPage = createProviderAccountUsagePageProjectionOpenerV1();
    const openHistoryPage = createHistoryPageOpenerWithYield(recordId, options);
    const readDailyRange = async (range: HistoryRange): Promise<NonNullable<ConnectedServiceQuotaGetResultV1['history']>['entries']> => {
        const entries: NonNullable<ConnectedServiceQuotaGetResultV1['history']>['entries'] = [];
        await drainProviderAccountUsageHistory(credentials, { recordId, history: { range, pageSize: 100 } }, options, async page => {
            if (!active) throw Object.assign(new Error('Usage history read ended'), { name: 'AbortError' });
            const opened = await openHistoryPage(page);
            if (!active) throw Object.assign(new Error('Usage history read ended'), { name: 'AbortError' });
            // Intern the admitted frame. The drain owns continuation and requires the terminal cursor.
            const admittedPage = openPage(packProviderAccountUsagePageProjectionV1(
                buildProviderAccountUsagePageProjectionV1({ recordId, range, history: { entries: opened.entries, nextCursor: null } }))).history;
            for (const entry of admittedPage.entries) entries.push(entry);
        });
        return entries;
    };
    const deltaRange = publication?.kind === 'observation' && changedDate && scopeDay?.history
        ? { startAtMs: scopeDay.history.fromAtMs, endAtMs: changedDate.endAtMs } : undefined;
    let deltaEntries: NonNullable<ConnectedServiceQuotaGetResultV1['history']>['entries'] = [];
    const summaries = (deltaRange && priorDaily && changedDate ? (async () => {
        deltaEntries = await readDailyRange(deltaRange);
        const previous = priorDaily.summaries.find(day => day.dayStartAtMs === changedDate.startAtMs);
        const precedingSnapshot = priorDaily.summaries.findLast(day => day.dayStartAtMs < changedDate.startAtMs)?.lastSnapshot;
        if (!deltaEntries.length) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
        // The stored day did not change. Fold the newly admitted exact suffix over its retained facts for this view.
        return { missingDays: [], coverage: new Map<number, DayHistoryEvidence>(), summaries: [buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs: changedDate.startAtMs,
            previous, precedingSnapshot, snapshots: deltaEntries.map(entry => entry.snapshot) })] };
    })() : requestProviderAccountUsageDaySummaries(credentials, { recordId,
        // Clock evidence covers all admitted days, independently of the display range.
        includeCoverage: true, ...(daily ? changedDate ? { range: changedDate } : {} : { range: displayDemand.range }) }, options))
        .then(value => {
            if (!active) return;
            if (daily && !value) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
            daySummaries = value?.summaries ?? [];
            missingDays = daily ? value?.missingDays : undefined;
            if (value?.coverage) {
                const coverage = new Map(changedDate ? priorDaily?.coverage : undefined);
                if (changedDate) coverage.delete(changedDate.startAtMs);
                for (const [dayStartAtMs, day] of value.coverage) coverage.set(dayStartAtMs, day);
                // The accepted suffix stands in until the producer publishes the settled day proof.
                const suffixSummary = daySummaries[0];
                if (deltaRange && suffixSummary && scopeDay) {
                    const priorCoverage = priorDaily?.coverage.get(suffixSummary.dayStartAtMs)?.coverage;
                    const last = deltaEntries.at(-1);
                    // A disjoint suffix gives an exact count and frontier to
                    // compare with the paired summary, even if that read races a later write.
                    const appended = priorCoverage && last && (priorCoverage.frontier?.observedAtMs ?? -1) < deltaRange.startAtMs
                        ? { observationCount: priorCoverage.observationCount + deltaEntries.length,
                            frontier: { id: last.id, observedAtMs: last.observedAtMs } } : undefined;
                    coverage.set(suffixSummary.dayStartAtMs, { summary: suffixSummary, coverage: appended, observationCursor: scopeDay.throughCursor });
                }
                dayCoverage = coverage;
            }
            if (changedDate && priorDaily) {
                daySummaries = [...priorDaily.summaries.filter(day => day.dayStartAtMs !== changedDate.startAtMs), ...daySummaries]
                    .sort((left, right) => left.dayStartAtMs - right.dayStartAtMs);
                missingDays = [...priorDaily.missingDays.filter(day => day.dayStartAtMs !== changedDate.startAtMs), ...(missingDays ?? [])];
            }
            if (daily) recentHistorySelection = resolveProviderAccountUsageRecentHistoryRangesV1({ current,
                daySummaries, missingDays, nowMs: readNowMs });
        });
    const pendingSourceKey = options.includePendingWork === false ? undefined : createCanonicalJsonSigningInput(request.source);
    let pendingBasis: PendingResetStartBasis | undefined;
    const pending = pendingSourceKey === undefined ? Promise.resolve()
        : readProviderAccountUsageWaitingWork(credentials, request, current, options, {
            recordId, sourceKey: pendingSourceKey, readCoverage: async () => { await summaries; return dayCoverage; },
        }).then(value => {
            if (!active) return;
            pendingBasis = value.basis;
            waitingWork = value.waitingWork; publish();
        });
    try {
        await Promise.all([pending, price, pacing, summaries, (async () => {
            if (daily) {
                await summaries;
                if (!active) return;
                const historyCoverage = dayCoverage;
                if (recentHistorySelection?.status === 'available' && historyCoverage) {
                    const { ranges } = recentHistorySelection;
                    const retained = priorDaily?.recent;
                    const affected = retained ? [...new Set([...retained.coverage.keys(), ...historyCoverage.keys()])].flatMap(dayStartAtMs => {
                        const endAtMs = dayStartAtMs + PROVIDER_ACCOUNT_USAGE_DAY_MS;
                        if (!retained.ranges.some(range => range.startAtMs < endAtMs && dayStartAtMs < range.endAtMs)) return [];
                        const previous = retained.coverage.get(dayStartAtMs);
                        const next = historyCoverage.get(dayStartAtMs);
                        const cursor = retained.throughCursor ?? -1;
                        if (sameDayHistoryEvidence(previous, next)) return [];
                        if (scopeDay?.dayStartAtMs === dayStartAtMs && cursor >= scopeDay.afterCursor && cursor < scopeDay.throughCursor) {
                            const priorObservationCursor = scopeDay.publication?.kind === 'summary'
                                ? scopeDay.publication.afterCursor : scopeDay.throughCursor;
                            if (scopeDay.history && cursor >= scopeDay.history.afterCursor && cursor < priorObservationCursor) {
                                return [{ startAtMs: scopeDay.history.fromAtMs, endAtMs }];
                            }
                            // The paired publication finalizes the exact suffix already read.
                            // A later rewrite has a different predecessor and rechecks its day.
                            if (previous?.observationCursor === priorObservationCursor && previous.coverage
                                && sameStrictJsonValue(previous.coverage, next?.coverage)
                                && scopeDay.publication?.kind === 'summary') return [];
                        }
                        return [{ startAtMs: dayStartAtMs, endAtMs }];
                    }) : [];
                    const covered = retained ? affected.reduce((pending, range) =>
                        pending.flatMap(value => subtractHistoryRange(value, range)), [...retained.ranges]) : [];
                    if (deltaRange) covered.push(deltaRange);
                    const contains = (range: HistoryRange, at: number) => range.startAtMs <= at && at < range.endAtMs;
                    // A later display clock can extend the requested range beyond the admitted stream.
                    // The day frontier is an accepted clock, unlike the provider's observation timestamp.
                    let rawEnd = retained ? 0 : Infinity;
                    if (retained) for (const [day, evidence] of historyCoverage) {
                        rawEnd = Math.max(rawEnd, evidence.coverage
                            ? (evidence.coverage.frontier?.observedAtMs ?? -1) + 1 : day + PROVIDER_ACCOUNT_USAGE_DAY_MS);
                    }
                    const uncovered = covered.reduce((pending, range) => pending.flatMap(value => subtractHistoryRange(value, range)), [...ranges])
                        .map(range => ({ startAtMs: range.startAtMs, endAtMs: Math.min(range.endAtMs, rawEnd) }))
                        .filter(range => range.startAtMs < range.endAtMs);
                    if (retained && !affected.length && !deltaRange && !uncovered.length && retained.ranges.every(old =>
                        ranges.some(range => range.startAtMs <= old.startAtMs && old.endAtMs <= range.endAtMs))) {
                        recentHistory = retained.history;
                    } else {
                        const entries = retained?.history.entries.filter(entry => ranges.some(range => contains(range, entry.observedAtMs))
                            && !affected.some(range => contains(range, entry.observedAtMs))
                            && (!deltaRange || !contains(deltaRange, entry.observedAtMs))) ?? [];
                        for (const entry of deltaEntries) if (ranges.some(range => contains(range, entry.observedAtMs))) entries.push(entry);
                        for (const range of uncovered) {
                            for (const entry of await readDailyRange(range)) entries.push(entry);
                        }
                        if (!active) return;
                        recentHistory = { entries: entries.sort((left, right) => left.observedAtMs - right.observedAtMs || left.id.localeCompare(right.id)), nextCursor: null };
                    }
                    settledRecent = { throughCursor, ranges, history: recentHistory, coverage: historyCoverage };
                }
                dailyReady = true;
                if (viewGroups.size || !exactDemand) publish();
                if (!exactDemand) return;
            }
            const demand = exactDemand!;
            const query = { recordId, projection: demand };
            // Day coverage also changes when retention prunes rows without
            // advancing the Account feed. Revalidate it before local reuse.
            // Read before the body so a concurrent prune cannot pair an older
            // result with newer coverage on the next admission.
            await summaries;
            const readExact = async () => {
                // A concurrent backfill or accepted tail can invalidate publication.
                // Reopen canonical coverage before deriving another write.
                while (active) {
                    const retained = options.projectionDocuments?.get(recordId)?.exact;
                    const admittedPrefix = retained?.admitted;
                    const settled = admittedPrefix?.settled;
                    const overlaps = (day: number) => day < demand.range.endAtMs
                        && day + PROVIDER_ACCOUNT_USAGE_DAY_MS > demand.range.startAtMs;
                    const coverage = dayCoverage;
                    const reuse = retained && admittedPrefix && settled && coverage
                        && hasUsageProjectionCustody(admittedPrefix, options, credentialScope, materialBytes)
                        && settled.range.startAtMs <= demand.range.startAtMs
                        && (demand.range.endAtMs <= settled.range.endAtMs || [...coverage].every(([day, proof]) =>
                            !overlaps(day) || (proof.coverage?.frontier?.observedAtMs ?? -1) < settled.range.endAtMs))
                        && [...settled.coverage].every(([day, proof]) => !overlaps(day) || sameDayHistoryEvidence(proof, coverage.get(day)))
                        && [...coverage.keys()].every(day => !overlaps(day) || settled.coverage.has(day));
                    const raw = reuse ? { projection: retained.projection, complete: true, published: undefined, opened: undefined }
                        : await requestProviderAccountUsageProjection(credentials, query, options);
                    if (!active) return;
                    if (!raw) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
                    let read = raw;
                    if (read.projection && read.projection.demand.range.startAtMs > demand.range.startAtMs) {
                        read = { projection: null, complete: false };
                    }
                    let opened: ReturnType<typeof openProviderAccountUsagePageProjectionV1> | null = null;
                    const held = options.projectionDocuments?.get(recordId)?.exact;
                    const prior = held?.projection === read.projection ? held?.admitted : undefined;
                    const sameCustody = hasUsageProjectionCustody(prior, options, credentialScope, materialBytes);
                    if (read.projection) {
                        opened = sameCustody ? prior!.opened : read.opened ?? openProviderAccountUsagePageProjectionV1({ recordId, accountMode: options.accountMode,
                            material: options.material, content: read.projection.content });
                    }
                    const stored = read.projection;
                    if (stored && opened && (stored.recordId !== recordId || opened.range.startAtMs !== stored.demand.range.startAtMs
                        || opened.range.endAtMs !== stored.demand.range.endAtMs || opened.history.entries.length !== stored.observationCount
                        || opened.range.startAtMs > demand.range.startAtMs
                        || JSON.stringify(opened.history.entries.length ? (({ id, observedAtMs }) => ({ id, observedAtMs }))(opened.history.entries.at(-1)!) : null) !== JSON.stringify(stored.frontier))) {
                        throw new ProviderAccountUsageReadErrorV1('provider_account_usage_identity_mismatch');
                    }
                    if (stored && opened && held?.projection === stored) {
                        admitted = sameCustody ? prior : { accountMode: options.accountMode, credentialScope,
                            materialType: options.material?.type, materialBytes: materialBytes?.slice(), opened };
                        held.admitted = admitted;
                    }
                    let entries = opened?.history.entries ?? [];
                    if (!read.complete) {
                        const range = { startAtMs: opened?.range.startAtMs ?? demand.range.startAtMs,
                            endAtMs: Math.max(opened?.range.endAtMs ?? 0, demand.range.endAtMs, raw.published?.demand.range.endAtMs ?? 0) };
                        const openPage = createProviderAccountUsagePageProjectionOpenerV1();
                        const admit = (values: typeof entries) => openPage(packProviderAccountUsagePageProjectionV1(
                            buildProviderAccountUsagePageProjectionV1({ recordId, range, history: { entries: values, nextCursor: null } }),
                        )).history.entries;
                        let admittedPrefix = false;
                        await drainProviderAccountUsageHistory(credentials, { recordId,
                            history: { range, pageSize: 100, ...(stored?.frontier ? { cursor: stored.frontier } : {}) } }, options, async page => {
                            if (!active) throw Object.assign(new Error('Usage history read ended'), { name: 'AbortError' });
                            const next = await openHistoryPage(page);
                            if (!active) throw Object.assign(new Error('Usage history read ended'), { name: 'AbortError' });
                            // Raw fallback pages carry full copies of unchanged provider
                            // inventory and meter definitions. Admit them into the same
                            // dictionaries as a stored projection before acquiring the
                            // next page; keep every accepted id, clock and numeric reading.
                            if (next.entries.length) {
                                if (!admittedPrefix) {
                                    entries = entries.length ? admit(entries) : [];
                                    admittedPrefix = true;
                                }
                                for (const entry of admit(next.entries)) entries.push(entry);
                            }
                        });
                        if (!active) return;
                        const projection = buildProviderAccountUsagePageProjectionV1({ recordId, range, history: { entries, nextCursor: null } });
                        const last = entries.at(-1);
                        const metadata = { recordId, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING,
                            demand: { range, resolution: demand.resolution }, frontier: last ? { id: last.id, observedAtMs: last.observedAtMs } : null,
                            observationCount: entries.length };
                        const materialize = (): z.infer<typeof ProviderAccountUsagePageProjectionWriteV1Schema> => ({ ...metadata,
                            content: sealProviderAccountUsagePageProjectionV1({ projection, accountMode: options.accountMode,
                                material: options.material, randomBytes: getRandomBytes }) });
                        // The server owns accepted-prefix admission and equivalent
                        // sealed-write deduplication. Independent readers never queue
                        // behind one another or decide another writer's custody.
                        assertCurrent();
                        const body = materialize();
                        const writeScope = options.readTransport?.scope ?? options.readTransport?.key;
                        if (writeScope) usageHttpReads.invalidate(writeScope);
                        const response = await (options.request ?? createServerFetchForActiveServer(options.expectedActiveServer))('/v4/connect/qualified/provider-account-usage/history', {
                            method: 'PUT', signal: options.signal, headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify(body),
                        }, { includeAuth: false, ...(options.expectedActiveServer ? { expectedActiveServer: options.expectedActiveServer } : {}) })
                            .finally(() => { if (writeScope) usageHttpReads.invalidate(writeScope); });
                        if (!active) return;
                        assertCurrent();
                        if (!response.ok) {
                            if (response.status === 409) {
                                const failure: unknown = await response.json();
                                assertCurrent();
                                if (failure && typeof failure === 'object' && 'error' in failure
                                    && failure.error === 'provider_account_usage_projection_conflict') continue;
                            }
                            const code = response.status === 401 || response.status === 403 ? 'denied'
                                : response.status === 409 ? 'provider_account_usage_projection_conflict' : 'provider_account_usage_projection_write_failed';
                            throw new HappyError(code, false, { status: response.status, kind: response.status === 401 || response.status === 403 ? 'auth' : 'server', code });
                        }
                        admitted = { accountMode: options.accountMode, credentialScope,
                            materialType: options.material?.type, materialBytes: materialBytes?.slice(), opened: projection,
                            view: sameCustody ? prior?.view : undefined };
                        // A successful PUT can retain another writer's sealed
                        // bytes. Its prefix acknowledgement is not a validator
                        // for this local body or the demand's complete bit.
                        options.projectionDocuments?.set(recordId, { ...options.projectionDocuments.get(recordId), exact: { projection: body, etag: '', admitted } });
                    } else if (!opened) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
                    if (!active) return;
                    assertCurrent();
                    // Coverage/range may change without a new selected observation.
                    // Reuse only exact admitted entry identities, never a cursor/count.
                    await summaries;
                    if (!active) return;
                    assertCurrent();
                    if (admitted && !reuse && dayCoverage) admitted.settled = { range: demand.range, coverage: dayCoverage };
                    const view = admitted?.view;
                    const selected = entries.filter(entry => entry.observedAtMs >= demand.range.startAtMs && entry.observedAtMs < demand.range.endAtMs);
                    history = view && selected.length === view.history.entries.length
                        && selected.every((entry, index) => entry === view.history.entries[index])
                        ? view.history : { entries: selected, nextCursor: null };
                    pageFacts = view && history === view.history && sameStrictJsonValue(recordJson, view.record)
                        && sameStrictJsonValue(daySummaries ?? null, view.daySummaries ?? null) ? view.value.pageFacts : undefined;
                    return;
                }
            };
            await readExact().catch(error => {
                if (!active) return;
                const onViewFailure = options.readAllHistory?.onViewFailure;
                const groups = [...viewGroups.values()];
                if (!onViewFailure || groups.every(group => group.exact)) throw error;
                onViewFailure(request.source, groups.flatMap(group => group.exact ? group.keys : []), error);
            });
            if (active && history) publish();
        })()]);
        const result = (viewGroups.size ? projectViews().values().next().value : undefined) ?? project();
        assertCurrent();
        const documents = options.projectionDocuments;
        const held = documents?.get(recordId);
        if (daily && daySummaries && dayCoverage && (held?.daily?.throughCursor ?? -1) <= (throughCursor ?? -1)) {
            documents?.set(recordId, { ...held,
                daily: { accountMode: options.accountMode, credentialScope, materialType: options.material?.type,
                    materialBytes: materialBytes?.slice(), throughCursor, source: request.source, current: initialCurrent, summaries: daySummaries, missingDays: missingDays ?? [],
                    coverage: dayCoverage, recent: settledRecent ?? priorDaily?.recent } });
        }
        if (pendingSourceKey !== undefined && pendingBasis && (held?.pendingBySource?.get(pendingSourceKey)?.throughCursor ?? -1) <= pendingBasis.throughCursor) {
            const pendingBySource = new Map(held?.pendingBySource);
            pendingBySource.set(pendingSourceKey, { ...pendingBasis, coverage: dayCoverage });
            documents?.set(recordId, { ...documents.get(recordId), pendingBySource });
        }
        return result;
    } finally { active = false; }
}

/** One qualified demand GET admits both the protected prefix and its coverage. */
async function requestProviderAccountUsageProjection(credentials: AuthCredentials,
    query: Readonly<{ recordId: string; projection: NonNullable<ConnectedServiceQuotaGetInputV1['projection']> }>,
    options: ProviderAccountUsageQuotaReadOptions,
): Promise<(z.infer<typeof ProviderAccountUsagePageProjectionReadV1Schema> & {
        published?: z.infer<typeof ProviderAccountUsagePageProjectionCoverageV1Schema>;
        opened?: ReturnType<typeof openProviderAccountUsagePageProjectionV1>;
    }) | null> {
    throwIfAborted(options.signal); options.assertCurrent?.();
    const documents = options.projectionDocuments;
    const held = documents?.get(query.recordId)?.exact;
    const heldCoverage = held ? { demand: held.projection.demand, frontier: held.projection.frontier,
        observationCount: held.projection.observationCount, contentMode: held.projection.content.t } : undefined;
    const path = `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({
        query: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
            { ...query, ...(heldCoverage ? { heldProjection: heldCoverage } : {}) }),
    }).toString()}`;
    const response = await acquireProviderUsageHttp(credentials, path, {
        method: 'GET', signal: options.signal, headers: {
            Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json',
            'X-Happier-Request-Purpose': 'connected-accounts:quota-qualification',
            ...(held?.etag ? { 'If-None-Match': held.etag } : {}),
        },
    }, options);
    throwIfAborted(options.signal); options.assertCurrent?.();
    if (response.status === 401 || response.status === 403) throw new HappyError('Provider account usage authority refused', false,
        { status: response.status, kind: 'auth', code: 'denied' });
    if (response.status === 409) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_mode_mismatch');
    if (response.status === 404) return null;
    if (!response.ok && response.status !== 304) throw new HappyError('Provider account usage read failed', false,
        { status: response.status, kind: 'server', code: 'provider_account_usage_read_failed' });
    const etag = response.etag;
    if (response.status === 304) {
        if (!held || !etag || held.etag !== etag || !['true', 'false'].includes(response.complete ?? '')) {
            throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
        }
        // Fetch/native/carrier transports need not replay a 304 body. Retain
        // this already-admitted representation at the existing Resource owner.
        return { projection: held.projection, complete: response.complete === 'true' };
    }
    if (response.jsonFailure) throw response.jsonFailure.error;
    const read = openProviderAccountUsagePageProjectionReadV1({ value: response.json, recordId: query.recordId,
        accountMode: options.accountMode, material: options.material });
    if (held && etag && held.etag === etag && read.projection) return { projection: held.projection, complete: read.complete };
    const prefixHeader = response.prefix;
    if (held && prefixHeader) {
        const prefix = ProviderAccountUsagePageProjectionPrefixReadV1Schema.parse(JSON.parse(decodeURIComponent(prefixHeader)));
        // Coverage belongs to the held body being extended, independently of
        // the changed server body's validator or complete bit (B3-A-01).
        if (sameStrictJsonValue(prefix.held, heldCoverage)) {
            if (prefix.complete && read.projection) {
                // Another equivalent seal can replace the wire body without
                // changing the accepted facts admitted by this prefix proof.
                const admitted = held.admitted && read.opened ? { ...held.admitted,
                    opened: { ...held.admitted.opened, range: read.opened.range } } : undefined;
                documents?.set(query.recordId, { ...documents.get(query.recordId), exact: { projection: read.projection, etag: etag ?? '', admitted } });
                return read;
            }
            return { projection: held.projection, complete: prefix.complete, published: prefix.published };
        }
    }
    const { exact: _exact, ...retained } = documents?.get(query.recordId) ?? {};
    if (read.projection) documents?.set(query.recordId, { ...retained, exact: { projection: read.projection, etag: etag ?? '' } });
    else if (retained.daily || retained.pendingBySource) documents?.set(query.recordId, retained);
    else documents?.delete(query.recordId);
    return read;
}

function createHistoryPageOpenerWithYield(recordId: string,
    options: Pick<ProviderAccountUsageQuotaReadOptions, 'accountMode' | 'material' | 'signal' | 'assertCurrent'>) {
    const openEntry = createProviderAccountUsageHistoryEntryOpenerV4({ recordId, accountMode: options.accountMode, material: options.material });
    const assertCurrent = () => { throwIfAborted(options.signal); options.assertCurrent?.(); };
    return async (page: z.infer<typeof QualifiedProviderAccountUsageHistoryResponseV4Schema>) => {
        const entries = await mapCryptoBatchWithYield(page.entries, entry => {
            assertCurrent();
            return openEntry(entry);
        });
        assertCurrent();
        return { entries, nextCursor: page.nextCursor };
    };
}

async function readProviderAccountUsageWaitingWork(credentials: AuthCredentials, input: ConnectedServiceQuotaGetInputV1, current: ProviderAccountUsageSnapshotV1 | null,
    options: ProviderAccountUsageQuotaReadOptions,
    projection?: Readonly<{ recordId: string; sourceKey: string; readCoverage: () => Promise<DailyHistoryCoverage | undefined> }>,
): Promise<{ nowMs: number; waitingWork: ProviderAccountUsageWaitingWorkV1; basis?: PendingResetStartBasis }> {
    const finish = (waitingWork: ProviderAccountUsageWaitingWorkV1, nowMs = options.nowMs ?? Date.now()) => ({ nowMs, waitingWork });
    const project = ({ entries, unboundEntries }: Pick<PendingResetStartBasis, 'entries' | 'unboundEntries'>) => {
        // Readiness remains a projection of the current quota and clock. Only
        // the admitted Pending rows and exact witnesses stand across consumers.
        const nowMs = options.nowMs ?? Date.now();
        return finish({ status: 'available', entries: entries.map(({ entry, witness }) => ({
            sessionId: entry.sessionId, localId: entry.localId,
            recordId: entry.reset.recordId, meterId: entry.reset.meterId,
            readiness: evaluatePendingResetStartReadinessV1({ reset: entry.reset, witness, current, nowMs, authorityCurrent: entry.authorityCurrent }),
        })), ...(unboundEntries ? { unboundEntries } : {}) }, nowMs);
    };
    const throughCursor = options.changesCursor;
    const documents = throughCursor === undefined ? undefined : options.projectionDocuments;
    const held = projection ? documents?.get(projection.recordId)?.pendingBySource?.get(projection.sourceKey) : undefined;
    const credentialScope = resolveAuthCredentialsScopeKey(credentials);
    const materialBytes = options.material?.type === 'legacy' ? options.material.secret : options.material?.machineKey;
    throwIfAborted(options.signal);
    options.assertCurrent?.();
    const readWitness = (entry: PendingResetStartsReadResultV1['entries'][number]) => entry.authorityCurrent
        ? getProviderAccountUsageHistoryWitness(credentials, { recordId: entry.reset.recordId, witness: entry.reset.witness }, options)
        : null;
    if (projection && held && held.throughCursor === throughCursor && hasUsageProjectionCustody(held, options, credentialScope, materialBytes)) {
        const coverage = held.entries.some(({ entry }) => entry.authorityCurrent) ? await projection.readCoverage() : undefined;
        const entries = await Promise.all(held.entries.map(async item => {
            if (!item.entry.authorityCurrent) return item;
            const { recordId, witness } = item.entry.reset;
            const day = Math.floor(witness.observedAtMs / PROVIDER_ACCOUNT_USAGE_DAY_MS) * PROVIDER_ACCOUNT_USAGE_DAY_MS;
            const previous = recordId === projection.recordId ? held.coverage?.get(day)?.coverage : undefined;
            return previous && sameStrictJsonValue(previous, coverage?.get(day)?.coverage) ? item
                : { entry: item.entry, witness: await readWitness(item.entry) };
        }));
        throwIfAborted(options.signal); options.assertCurrent?.();
        const basis = { ...held, entries };
        return { ...project(basis), basis };
    }
    const body = PendingResetStartsReadInputV1Schema.parse({ source: input.source });
    let response: UsageHttpObservation;
    try {
        response = await acquireProviderUsageHttp(credentials, '/v2/pending/reset-starts/read', {
            method: 'POST', signal: options.signal, headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }, options);
    } catch (error) {
        if (options.signal?.aborted) throw error;
        options.assertCurrent?.();
        return finish({ status: 'unavailable', reason: 'read_failed' });
    }
    options.assertCurrent?.();
    if (response.status === 404 || response.status === 405) return finish({ status: 'unavailable', reason: 'unsupported' });
    if (response.status === 401 || response.status === 403) return finish({ status: 'unavailable', reason: 'authority_unavailable' });
    if (!response.ok) return finish({ status: 'unavailable', reason: 'read_failed' });
    const parsed = PendingResetStartsReadResultV1Schema.safeParse(response.json);
    if (!parsed.success) return finish({ status: 'unavailable', reason: 'read_failed' });
    if (documents && projection && parsed.data.entries.some(entry => entry.authorityCurrent)) await projection.readCoverage();
    const witnessedEntries = await Promise.all(parsed.data.entries.map(async entry => ({ entry, witness: await readWitness(entry) })));
    options.assertCurrent?.();
    const operands = { entries: witnessedEntries, unboundEntries: parsed.data.unboundEntries };
    const basis = documents && throughCursor !== undefined ? {
        accountMode: options.accountMode, credentialScope, materialType: options.material?.type,
        materialBytes: materialBytes?.slice(), throughCursor, ...operands,
    } : undefined;
    return { ...project(operands), basis };
}

type UsageReadTransportOptions = Pick<ProviderAccountUsageQuotaReadOptions,
    'request' | 'readTransport' | 'assertCurrent' | 'signal' | 'expectedActiveServer'>;

async function observeProviderUsageHttp(response: Response): Promise<UsageHttpObservation> {
    let json: unknown = null;
    let jsonFailure: UsageHttpObservation['jsonFailure'];
    if (response.status !== 304 && response.status !== 404 && response.status !== 401 && response.status !== 403) {
        try { json = await response.json(); } catch (error) { jsonFailure = { error }; }
    }
    return { status: response.status, ok: response.ok, json, ...(jsonFailure ? { jsonFailure } : {}),
        etag: response.headers.get('etag'),
        complete: response.headers.get('x-happier-usage-projection-complete'),
        prefix: response.headers.get('x-happier-usage-projection-prefix') };
}

async function acquireProviderUsageHttp(credentials: AuthCredentials, path: string, init: RequestInit,
    options: UsageReadTransportOptions, fresh = false): Promise<UsageHttpObservation> {
    throwIfAborted(options.signal); options.assertCurrent?.();
    const consume = (response: Response) => observeProviderUsageHttp(response);
    const fetchOptions = { includeAuth: false, ...(options.expectedActiveServer ? { expectedActiveServer: options.expectedActiveServer } : {}) };
    const transport = options.readTransport;
    const bindingKey = transport?.key;
    const scope = transport?.scope ?? bindingKey;
    const value = transport && scope
        ? await usageHttpReads.run(JSON.stringify([bindingKey, init.method, path,
            new Headers(init.headers).get('If-None-Match'), init.body ?? null]), signal => transport.read(path, { ...init, signal }, fetchOptions, consume),
            { scope, signal: options.signal, fresh })
        : await consume(await (options.request ?? createServerFetchForActiveServer(options.expectedActiveServer))(path, init, fetchOptions));
    throwIfAborted(options.signal); options.assertCurrent?.();
    return value;
}

async function requestProviderAccountUsageRead(credentials: AuthCredentials, path: string,
    options: UsageReadTransportOptions, fresh = false): Promise<Readonly<{ json: unknown; etag: string | null }> | null> {
    options.assertCurrent?.();
    const response = await acquireProviderUsageHttp(credentials, path, { method: 'GET', signal: options.signal,
        headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json',
            'X-Happier-Request-Purpose': 'connected-accounts:quota-qualification' } }, options, fresh);
    options.assertCurrent?.();
    return admitProviderAccountUsageRead(response);
}

function admitProviderAccountUsageRead(response: UsageHttpObservation): Readonly<{ json: unknown; etag: string | null }> | null {
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
        throw new HappyError('Provider account usage authority refused', false,
            { status: response.status, kind: 'auth', code: 'denied' });
    }
    if (response.jsonFailure) throw response.jsonFailure.error;
    const json = response.json;
    if (response.status === 409 && QualifiedProviderAccountUsageReadErrorV4Schema.safeParse(json).success) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_mode_mismatch');
    if (!response.ok) {
        const code = extractErrorCode(json) ?? 'provider_account_usage_read_failed';
        throw new HappyError(code, false, { status: response.status, kind: 'server', code });
    }
    return { json, etag: response.etag };
}

/** One finite response on current Homes; older JSON Homes retain their existing cursor transport. */
async function drainProviderAccountUsageHistory(credentials: AuthCredentials,
    input: Readonly<{ recordId: string; history: NonNullable<ConnectedServiceQuotaGetInputV1['history']> }>,
    options: ProviderAccountUsageQuotaReadOptions,
    onPage: (page: ReturnType<typeof QualifiedProviderAccountUsageHistoryResponseV4Schema.parse>) => Promise<void>) {
    let history = input.history;
    do {
        throwIfAborted(options.signal); options.assertCurrent?.();
        const path = `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({ query:
            encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
                { recordId: input.recordId, history }) }).toString()}`;
        const consume = async (response: Response) => {
            if (response.ok && response.headers.get('content-type')?.includes('application/x-ndjson')) {
                await consumeProviderAccountUsageHistoryStream(response, onPage, options);
                return null;
            }
            const read = admitProviderAccountUsageRead(await observeProviderUsageHttp(response));
            if (!read) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
            const page = QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(read.json);
            throwIfAborted(options.signal); options.assertCurrent?.();
            await onPage(page);
            return page.nextCursor ? { ...history, cursor: page.nextCursor, pageSize: history.pageSize + page.entries.length } : null;
        };
        const init = { method: 'GET', signal: options.signal, headers: { Authorization: `Bearer ${credentials.token}`,
            Accept: 'application/x-ndjson', 'Content-Type': 'application/json',
            'X-Happier-Request-Purpose': 'connected-accounts:quota-qualification' } };
        const fetchOptions = { includeAuth: false, ...(options.expectedActiveServer ? { expectedActiveServer: options.expectedActiveServer } : {}) };
        const next = options.readTransport
            ? await options.readTransport.read(path, init, fetchOptions, consume)
            : await consume(await (options.request ?? createServerFetchForActiveServer(options.expectedActiveServer))(path, init, fetchOptions));
        if (!next) return;
        history = next;
    } while (true);
}

async function requestProviderAccountUsageHistoryPage(credentials: AuthCredentials, query: ReturnType<typeof QualifiedProviderAccountUsageHistoryRequestV4Schema.parse>, options: ProviderAccountUsageQuotaReadOptions, fresh = false) {
    const read = await requestProviderAccountUsageRead(credentials, `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({ query: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema, query) }).toString()}`, options, fresh);
    return read === null ? null : QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(read.json);
}

async function requestProviderAccountUsageDaySummaries(credentials: AuthCredentials,
    query: ReturnType<typeof ProviderAccountUsageDaySummaryReadV1Schema.parse>, options: ProviderAccountUsageQuotaReadOptions) {
    const read = await requestProviderAccountUsageRead(credentials, `/v4/connect/qualified/provider-account-usage/day-summaries?${new URLSearchParams({ query:
        encodeQualifiedConnectedAccountV4StructuredQueryValue(ProviderAccountUsageDaySummaryReadV1Schema, query) }).toString()}`, options);
    if (!read) return null;
    const { summaries, missingDays } = ProviderAccountUsageDaySummaryResponseV1Schema.parse(read.json);
    const assertCurrent = () => { throwIfAborted(options.signal); options.assertCurrent?.(); };
    const opened = await mapCryptoBatchWithYield(summaries, summary => {
        assertCurrent();
        return openProviderAccountUsageDaySummaryV1({ recordId: query.recordId,
            dayStartAtMs: summary.dayStartAtMs, accountMode: options.accountMode, material: options.material, content: summary.payload.content });
    });
    assertCurrent();
    const coverage = query.includeCoverage ? new Map(opened.map((summary, index): [number, DayHistoryEvidence] =>
        [summary.dayStartAtMs, { summary, coverage: summaries[index]!.payload.coverage }])) : undefined;
    if (coverage) for (const day of missingDays) coverage.set(day.dayStartAtMs, {
        summary: coverage.get(day.dayStartAtMs)?.summary, coverage: day.coverage,
    });
    return { summaries: opened, missingDays, coverage };
}

export async function getProviderAccountUsageHistoryWitness(credentials: AuthCredentials, input: Readonly<{ recordId: ProviderAccountUsageRecordId; witness: ProviderAccountUsageHistoryWitnessV1 }>, options: ProviderAccountUsageQuotaReadOptions) {
    const page = await requestProviderAccountUsageHistoryPage(credentials, input, options, true);
    if (!page) return null;
    const material = options.accountMode === 'e2ee' ? options.material ?? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : undefined;
    const opened = await createHistoryPageOpenerWithYield(input.recordId, { ...options, material })(page);
    const entry = opened.entries.find(entry => entry.id === input.witness.id && entry.observedAtMs === input.witness.observedAtMs);
    if (!entry && opened.entries.length) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_identity_mismatch');
    return entry?.snapshot ?? null;
}

function extractErrorCode(json: unknown): string | null {
    if (!json || typeof json !== 'object') return null;
    const obj = json as Record<string, unknown>;
    return typeof obj.error === 'string' ? obj.error : null;
}

type QualifiedProviderAccountUsageRecordResponse = z.infer<
    typeof QualifiedProviderAccountUsageRecordResponseV4Schema
>;
type EncryptedQualifiedProviderAccountUsageRecordResponse =
    QualifiedProviderAccountUsageRecordResponse & Readonly<{
        content: Extract<
            QualifiedProviderAccountUsageRecordResponse['content'],
            Readonly<{ t: 'encrypted' }>
        >;
    }>;

function hasEncryptedProviderAccountUsageContent(
    response: QualifiedProviderAccountUsageRecordResponse,
): response is EncryptedQualifiedProviderAccountUsageRecordResponse {
    return response.content.t === 'encrypted';
}

function parseRecordId(recordId: ProviderAccountUsageRecordId): ProviderAccountUsageRecordId {
    return ProviderAccountUsageRecordIdSchema.parse(recordId);
}

function parseQualifiedProviderAccountUsageRecordResponse(
    json: unknown,
    recordId: ProviderAccountUsageRecordId,
): QualifiedProviderAccountUsageRecordResponse {
    const parsed = QualifiedProviderAccountUsageRecordResponseV4Schema.safeParse(json);
    if (!parsed.success) {
        throw new Error(`Invalid provider account usage response for ${recordId}`);
    }
    return parsed.data;
}

function rejectContentModeMismatch(
    recordId: ProviderAccountUsageRecordId,
    status?: number,
): never {
    throw new HappyError(
        `Provider account usage content does not match the Account encryption mode for ${recordId}`,
        false,
        {
            kind: 'server',
            code: 'provider_account_usage_content_mode_mismatch',
            ...(status === undefined ? {} : { status }),
        },
    );
}

function rejectQualifiedProviderAccountUsageReadFailure(
    response: UsageHttpObservation,
    recordId: ProviderAccountUsageRecordId,
    fallbackMessage: string,
): never {
    const json = response.json;
    if (
        response.status === 409
        && QualifiedProviderAccountUsageReadErrorV4Schema.safeParse(json).success
    ) {
        return rejectContentModeMismatch(recordId, response.status);
    }
    throw new HappyError(
        extractErrorCode(json) ?? fallbackMessage,
        false,
        { status: response.status, kind: 'server' },
    );
}

export type ProviderAccountUsageSnapshotReadOptions = Readonly<{
    signal?: AbortSignal;
    expectedActiveServer?: ExpectedActiveServerFetchBasis;
    readTransport?: CapturedServerReadTransport;
    /** The retained row observer owns its existing failure/recovery cadence. */
    retry?: 'none';
}>;

const plainSnapshotReads = createScopedResolutionSingleFlight<ProviderAccountUsageSnapshotV1 | null>();
const sealedSnapshotReads = createScopedResolutionSingleFlight<EncryptedQualifiedProviderAccountUsageRecordResponse | null>();

async function readProviderSnapshotWithOwner<T>(credentials: AuthCredentials, recordId: ProviderAccountUsageRecordId,
    opts: ProviderAccountUsageSnapshotReadOptions | undefined, pending: ScopedResolutionSingleFlight<T>,
    consume: (response: UsageHttpObservation) => T): Promise<T> {
    throwIfAborted(opts?.signal);
    const snapshot = getActiveServerSnapshot();
    const request = createServerFetchForActiveServer(opts?.expectedActiveServer ?? snapshot);
    const transport = opts?.readTransport ?? createCapturedServerReadTransport({ serverId: snapshot.serverId, credentials,
        prepared: { endpointUrl: snapshot.serverUrl, runtimeOrigin: resolveActiveServerRuntimeOrigin(snapshot),
            homeCarrier: getActiveServerHomeCarrier(), generation: snapshot.generation, request } });
    const bindingKey = transport.key;
    const scope = transport.scope ?? bindingKey;
    const path = `/v4/connect/qualified/provider-account-usage/record?recordId=${encodeURIComponent(recordId)}`;
    const init = { method: 'GET', headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json',
        'X-Happier-Request-Purpose': 'connected-accounts:quota-qualification' } };
    const options = { includeAuth: false, ...(opts?.expectedActiveServer ? { expectedActiveServer: opts.expectedActiveServer } : {}) };
    // Observer-owned demand shares raw record acquisition with quota. Standalone
    // demand keeps its incumbent finite validation/retry lifecycle inside one flight.
    const value = opts?.retry === 'none'
        ? consume(await acquireProviderUsageHttp(credentials, path, { ...init, signal: opts.signal }, { ...opts, request, readTransport: transport }))
        : await pending.run(JSON.stringify([bindingKey, recordId]), signal => backoff(async () =>
            await transport.read(path, { ...init, signal }, options, async response => consume(await observeProviderUsageHttp(response)))),
            { scope, signal: opts?.signal });
    throwIfAborted(opts?.signal);
    return value;
}

function readSnapshotRecord(response: UsageHttpObservation, recordId: ProviderAccountUsageRecordId, sealed = false) {
    if (response.status === 404) return null;
    const message = `Failed to load ${sealed ? 'sealed ' : ''}provider account usage for ${recordId}`;
    if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
            return rejectQualifiedProviderAccountUsageReadFailure(response, recordId, message);
        }
        throw new Error(`${message}: ${response.status}`);
    }
    if (response.jsonFailure) throw response.jsonFailure.error;
    return parseQualifiedProviderAccountUsageRecordResponse(response.json, recordId);
}

export async function getProviderAccountUsageSnapshotPlain(
    credentials: AuthCredentials,
    params: Readonly<{ recordId: ProviderAccountUsageRecordId }>,
    opts?: ProviderAccountUsageSnapshotReadOptions,
): Promise<ProviderAccountUsageSnapshotV1 | null> {
    const recordId = parseRecordId(params.recordId);
    return await readProviderSnapshotWithOwner(credentials, recordId, opts, plainSnapshotReads, response => {
        const parsed = readSnapshotRecord(response, recordId);
        if (!parsed) return null;
        if (parsed.content.t !== 'plain') {
            return rejectContentModeMismatch(recordId);
        }

        return openProviderAccountUsageRecordV4({ recordId, accountMode: 'plain', record: parsed });
    });
}

export async function getProviderAccountUsageSnapshotSealed(
    credentials: AuthCredentials,
    params: Readonly<{ recordId: ProviderAccountUsageRecordId }>,
    opts?: ProviderAccountUsageSnapshotReadOptions,
): Promise<EncryptedQualifiedProviderAccountUsageRecordResponse | null> {
    const recordId = parseRecordId(params.recordId);
    return await readProviderSnapshotWithOwner(credentials, recordId, opts, sealedSnapshotReads, response => {
        const parsed = readSnapshotRecord(response, recordId, true);
        if (!parsed) return null;
        if (!hasEncryptedProviderAccountUsageContent(parsed)) {
            return rejectContentModeMismatch(recordId);
        }
        return parsed;
    });
}

export async function requestProviderAccountUsageSnapshotRefresh(
    credentials: AuthCredentials,
    params: Readonly<{ recordId: ProviderAccountUsageRecordId }>,
    opts?: Readonly<{
        expectedActiveServer?: ExpectedActiveServerFetchBasis;
    }>,
): Promise<boolean> {
    const recordId = parseRecordId(params.recordId);
    const request = createServerFetchForActiveServer(opts?.expectedActiveServer);
    return await backoff(async () => {
        const response = await request(
            '/v4/connect/qualified/provider-account-usage/record/refresh',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ recordId }),
            },
            {
                includeAuth: false,
                ...(opts?.expectedActiveServer
                    ? {
                        expectedActiveServer:
                            opts?.expectedActiveServer,
                    }
                    : {}),
            },
        );

        if (response.status === 404) return false;
        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = `Failed to request provider account usage refresh for ${recordId}`;
                try {
                    const json = await response.json();
                    message = extractErrorCode(json) ?? message;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false, { status: response.status, kind: 'server' });
            }
            throw new Error(`Failed to request provider account usage refresh for ${recordId}: ${response.status}`);
        }

        return true;
    });
}
