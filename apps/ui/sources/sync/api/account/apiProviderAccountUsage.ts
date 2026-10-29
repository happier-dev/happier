import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    createServerFetchForActiveServer,
    type ExpectedActiveServerFetchBasis,
} from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';
import { backoff } from '@/utils/timing/time';

import { ProviderAccountUsageRecordIdSchema, type ProviderAccountUsageRecordId, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol/connect/account-usage-primitives';
import { QualifiedProviderAccountUsageReadErrorV4Schema, QualifiedProviderAccountUsageRecordResponseV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { z } from 'zod/mini';
import { ConnectedServiceQuotaGetInputV1Schema, QualifiedProviderAccountUsageHistoryRequestV4Schema, QualifiedProviderAccountUsageHistoryResponseV4Schema, openProviderAccountUsageRecordV4, openProviderAccountUsageHistoryPageV4, projectProviderAccountUsageQuotaReadV1, ProviderAccountUsageReadErrorV1, type ConnectedServiceQuotaGetInputV1, type ConnectedServiceQuotaGetResultV1, type ProviderAccountUsageHistoryWitnessV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { QualifiedConnectedServiceUsageSourceResolveV4Schema, QualifiedConnectedServiceUsageSourceResolutionV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { encodeQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { UsagePacingTargetsV1 } from '@happier-dev/protocol/account/settings/usagePacingPreferencesV1';
import type { ServerFetch } from '@/sync/http/client';
import { PendingResetStartsReadInputV1Schema, PendingResetStartsReadResultV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { evaluatePendingResetStartReadinessV1 } from '@happier-dev/protocol/sessions/pending/pendingResetStartReadinessV1';
import type { ProviderAccountUsageWaitingWorkV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { mapCryptoBatchWithYield } from '@/sync/encryption/cryptoBatchYield';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { ProviderAccountUsagePageProjectionReadV1Schema, ProviderAccountUsagePageProjectionWriteV1Schema,
    buildProviderAccountUsagePageProjectionV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING, ProviderAccountUsagePageProjectionSupersededError,
    ProviderAccountUsagePageProjectionPrefixReadV1Schema,
    type ProviderAccountUsagePageProjectionCoverageV1Schema } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { sealProviderAccountUsagePageProjectionV1, openProviderAccountUsagePageProjectionV1,
    openProviderAccountUsagePageProjectionReadV1 } from '@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { getProviderAccountUsageDerivationInterval } from '@happier-dev/protocol/connect/deriveProviderAccountUsagePace';
import { createCapturedServerReadTransport, type CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { createScopedResolutionSingleFlight, type ScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveActiveServerRuntimeOrigin } from '@/sync/runtime/nativeLoopbackTunnels/runtimeOrigin';
import { throwIfAborted } from '@/utils/runtime/abortSignals';

type UsageHttpObservation = Readonly<{
    status: number; ok: boolean; json: unknown; jsonFailure?: Readonly<{ error: unknown }>;
    etag: string | null; documentEtag: string | null;
    complete: string | null; prefix: string | null;
}>;
const usageHttpReads = createScopedResolutionSingleFlight<UsageHttpObservation>();

type AdmittedUsageProjection = {
    accountMode: 'plain' | 'e2ee';
    credentialScope: string;
    materialType?: AccountScopedCryptoMaterial['type'];
    materialBytes?: Uint8Array;
    opened: ReturnType<typeof openProviderAccountUsagePageProjectionV1>;
    view?: {
        record: unknown;
        history: NonNullable<ConnectedServiceQuotaGetResultV1['history']>;
        nowMs: number;
        interval: ReturnType<typeof getProviderAccountUsageDerivationInterval>;
        value: ConnectedServiceQuotaGetResultV1;
    };
};

/** The existing Account Resource retains one admitted B representation per record. */
type HeldUsageProjection = {
    projection: NonNullable<z.infer<typeof ProviderAccountUsagePageProjectionReadV1Schema>['projection']>;
    etag: string;
    admitted?: AdmittedUsageProjection;
};
export type ProviderAccountUsageProjectionDocuments = Map<string, HeldUsageProjection>;
// Only publication shares custody. A held history read must not block another
// range, current facts, or the independent price/Pending facets.
const projectionWrites = new WeakMap<ProviderAccountUsageProjectionDocuments, Map<string, Promise<unknown>>>();

async function publishUsageProjection<T>(documents: ProviderAccountUsageProjectionDocuments | undefined,
    recordId: string, publish: () => Promise<T>): Promise<T> {
    if (!documents) return await publish();
    let writes = projectionWrites.get(documents);
    if (!writes) { writes = new Map(); projectionWrites.set(documents, writes); }
    const previous = writes.get(recordId);
    const write = (async () => { await previous?.catch(() => {}); return await publish(); })();
    writes.set(recordId, write);
    try { return await write; }
    finally { if (writes.get(recordId) === write) writes.delete(recordId); }
}

function hasUsageProjectionCustody(prior: AdmittedUsageProjection | undefined, options: ProviderAccountUsageQuotaReadOptions,
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
    projectionDocuments?: ProviderAccountUsageProjectionDocuments;
    /** Settings are an independent facet, never a prerequisite for current capacity. */
    readPacingTargets?: () => Promise<UsagePacingTargetsV1>;
    readEnteredMonthlyPrice?: () => Promise<import('@happier-dev/protocol/connect/accountSubscription').ProviderAccountSubscriptionMonthlyPriceV1 | undefined>;
    /** Drain the requested range under one captured read; ordinary Action callers still receive one page. */
    readAllHistory?: Readonly<{ onProgress(value: ConnectedServiceQuotaGetResultV1): void }>;
}>;
export async function getProviderAccountUsageQuota(credentials: AuthCredentials, input: ConnectedServiceQuotaGetInputV1,
    inputOptions: Omit<ProviderAccountUsageQuotaReadOptions, 'accountMode'> & Readonly<{
        accountMode: ProviderAccountUsageQuotaReadOptions['accountMode'] | Promise<ProviderAccountUsageQuotaReadOptions['accountMode']>;
    }>): Promise<ConnectedServiceQuotaGetResultV1> {
    const transportOptions = { ...inputOptions, request: inputOptions.request ?? createServerFetchForActiveServer(inputOptions.expectedActiveServer) };
    const request = ConnectedServiceQuotaGetInputV1Schema.parse(input);
    // Address resolution and encrypted-byte acquisition need the captured
    // Account, not its mode. Opening still waits for the authoritative mode.
    const [{ resolution, recordJson }, accountMode] = await Promise.all([(async () => {
        const sourceJson = (await requestProviderAccountUsageRead(credentials, `/v4/connect/qualified/provider-account-usage/sources/resolve?${new URLSearchParams({ source: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedServiceUsageSourceResolveV4Schema, request.source) }).toString()}`, transportOptions))?.json ?? null;
        const resolution = sourceJson === null ? null : QualifiedConnectedServiceUsageSourceResolutionV4Schema.parse(sourceJson);
        const recordJson = resolution ? (await requestProviderAccountUsageRead(credentials, `/v4/connect/qualified/provider-account-usage/record?recordId=${encodeURIComponent(resolution.recordId)}`, transportOptions))?.json ?? null : null;
        return { resolution, recordJson };
    })(), inputOptions.accountMode]);
    let options: ProviderAccountUsageQuotaReadOptions = { ...transportOptions, accountMode };
    throwIfAborted(options.signal); options.assertCurrent?.();
    const material = options.accountMode === 'e2ee' ? options.material ?? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : undefined;
    const progressive = options.readAllHistory && (request.history || request.projection) && resolution;
    if (!request.projection && !progressive && options.readPacingTargets) options = { ...options, targets: await options.readPacingTargets() };
    const enteredMonthlyPrice = recordJson !== null && !progressive ? await options.readEnteredMonthlyPrice?.() : undefined;
    options.assertCurrent?.();
    let current = resolution && recordJson !== null ? openProviderAccountUsageRecordV4({ recordId: resolution.recordId, enteredMonthlyPrice, accountMode: options.accountMode, material, record: recordJson }) : null;
    if (current && resolution && current.recordKey.accountSubjectId !== resolution.providerAccountId) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_identity_mismatch');
    if (request.projection && resolution) return await readProviderAccountUsageProjectedQuota(credentials, request, {
        ...options, material,
    }, resolution.recordId, current, recordJson);
    const historyRequest = request.history;
    if (options.readAllHistory && historyRequest && resolution) {
        let history: ConnectedServiceQuotaGetResultV1['history'];
        let waitingWork: ProviderAccountUsageWaitingWorkV1 | undefined;
        let targets = options.targets;
        const project = (appendHistory?: ConnectedServiceQuotaGetResultV1['history']) => projectProviderAccountUsageQuotaReadV1({ input: request, current, history, appendHistory, waitingWork,
            targets, nowMs: options.nowMs ?? Date.now() });
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
        const price = current && options.readEnteredMonthlyPrice ? options.readEnteredMonthlyPrice().then(enteredMonthlyPrice => {
            if (!active) return;
            throwIfAborted(options.signal); options.assertCurrent?.();
            current = openProviderAccountUsageRecordV4({ recordId: resolution.recordId, enteredMonthlyPrice,
                accountMode: options.accountMode, material, record: recordJson });
            publish();
        }) : Promise.resolve();
        try {
            await Promise.all([(async () => {
                let cursor = historyRequest.cursor;
                let pageSize = historyRequest.pageSize;
                do {
                    const page = await requestProviderAccountUsageHistoryPage(credentials, { recordId: resolution.recordId,
                        history: { range: historyRequest.range, pageSize, ...(cursor ? { cursor } : {}) } }, options);
                    // A parallel read may have failed while this response was
                    // pending. Its settled producer cannot open/publish another
                    // page or acquire the next cursor.
                    if (!active) return;
                    if (!page) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
                    const opened = await openHistoryPageWithYield({ recordId: resolution.recordId, accountMode: options.accountMode, material, page }, options);
                    if (!active) return;
                    // Grow by the volume actually consumed, without a second result limit or truncation.
                    pageSize += opened.entries.length;
                    cursor = opened.nextCursor ?? undefined;
                    publish(opened);
                } while (cursor);
            })(), pending, price, pacing]);
            return project();
        } finally { active = false; }
    }
    const page = request.history && resolution ? await requestProviderAccountUsageHistoryPage(credentials, { recordId: resolution.recordId, history: request.history }, options) : null;
    if (request.history && resolution && !page) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
    const { nowMs, waitingWork } = options.includePendingWork === false
        ? { nowMs: options.nowMs ?? Date.now(), waitingWork: undefined }
        : await readProviderAccountUsageWaitingWork(credentials, request, current, options);
    return projectProviderAccountUsageQuotaReadV1({ input: request, current, ...(request.history ? { history: page && resolution ? await openHistoryPageWithYield({ recordId: resolution.recordId, accountMode: options.accountMode, material, page }, options) : { entries: [], nextCursor: null } } : {}), nowMs, targets: options.targets, waitingWork });
}

/** The B owner materializes exact accepted observations once; Plans never carries raw history trees. */
async function readProviderAccountUsageProjectedQuota(credentials: AuthCredentials, request: ConnectedServiceQuotaGetInputV1,
    options: ProviderAccountUsageQuotaReadOptions, recordId: string, initialCurrent: ProviderAccountUsageSnapshotV1 | null, recordJson: unknown): Promise<ConnectedServiceQuotaGetResultV1> {
    const demand = request.projection!;
    const assertCurrent = () => { throwIfAborted(options.signal); options.assertCurrent?.(); };
    let current = initialCurrent;
    let history: ConnectedServiceQuotaGetResultV1['history'];
    let pageFacts: ConnectedServiceQuotaGetResultV1['pageFacts'];
    let waitingWork: ProviderAccountUsageWaitingWorkV1 | undefined;
    let targets = options.targets;
    let active = true;
    let admitted: AdmittedUsageProjection | undefined;
    const credentialScope = resolveAuthCredentialsScopeKey(credentials);
    const materialBytes = options.material?.type === 'legacy' ? options.material.secret : options.material?.machineKey;
    // One instant per read: price, Pending and pacing revisions of this read keep its derived pace and
    // unused capacity instead of re-deriving them from the whole history at each later wall-clock reading.
    const readNowMs = options.nowMs ?? Date.now();
    const project = () => {
        const nowMs = readNowMs;
        const previous = admitted?.view;
        // The admitted record owns quota facts. Entered price is opened onto
        // current separately and does not change that history/pace basis.
        const sameBasis = previous && history === previous.history && sameStrictJsonValue(recordJson, previous.record);
        if (sameBasis && (previous.nowMs === nowMs || previous.interval
            && nowMs >= previous.interval.fromMs && nowMs < previous.interval.untilMs)) return { ...previous.value, current, source: request.source,
            targets: targets ?? [], waitingWork: waitingWork ?? { status: 'unavailable' as const, reason: 'read_failed' as const } };
        const value = projectProviderAccountUsageQuotaReadV1({ input: request, current, history, pageFacts,
            waitingWork, targets, nowMs });
        // History settles once in this read. Price and Pending revisions change
        // independent facets, so keep its admitted page facts for them.
        pageFacts = value.pageFacts;
        if (admitted && history) admitted.view = { record: recordJson, history, nowMs, value,
            interval: getProviderAccountUsageDerivationInterval({ current, history: history.entries.map(entry => entry.snapshot), nowMs }) };
        return value;
    };
    const publish = () => { assertCurrent(); options.readAllHistory?.onProgress(project()); };
    publish();
    const pacing = options.readPacingTargets ? options.readPacingTargets().then(value => {
        if (!active) return;
        targets = value; publish();
    }) : Promise.resolve();
    const pending = options.includePendingWork === false ? Promise.resolve() : readProviderAccountUsageWaitingWork(credentials, request, current, options).then(value => {
        if (!active) return;
        waitingWork = value.waitingWork; publish();
    });
    const price = current && options.readEnteredMonthlyPrice ? options.readEnteredMonthlyPrice().then(enteredMonthlyPrice => {
        if (!active) return;
        assertCurrent();
        current = openProviderAccountUsageRecordV4({ recordId, enteredMonthlyPrice, accountMode: options.accountMode,
            material: options.material, record: recordJson });
        publish();
    }) : Promise.resolve();
    try {
        await Promise.all([pending, price, pacing, (async () => {
            const query = { recordId, projection: demand };
            // A concurrent backfill or accepted tail can invalidate publication.
            // Reopen canonical coverage before deriving another write.
            while (active) {
                const raw = await requestProviderAccountUsageProjection(credentials, query, options);
                if (!active) return;
                if (!raw) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
                let read = raw;
                if (read.projection && read.projection.demand.range.startAtMs > demand.range.startAtMs) {
                    read = { projection: null, complete: false };
                }
                let opened: ReturnType<typeof openProviderAccountUsagePageProjectionV1> | null = null;
                const held = options.projectionDocuments?.get(recordId);
                const prior = held?.projection === read.projection ? held?.admitted : undefined;
                const sameCustody = hasUsageProjectionCustody(prior, options, credentialScope, materialBytes);
                if (read.projection) {
                    try {
                        opened = sameCustody ? prior!.opened : read.opened ?? openProviderAccountUsagePageProjectionV1({ recordId, accountMode: options.accountMode,
                            material: options.material, content: read.projection.content });
                    } catch (error) {
                        if (!(error instanceof ProviderAccountUsagePageProjectionSupersededError)) throw error;
                        // A marked current body disagreeing with its metadata is
                        // inconsistent, not permission to overwrite opaque data.
                        if (read.projection.encoding) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_identity_mismatch');
                        read = { projection: null, complete: false };
                    }
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
                    let cursor = stored?.frontier ?? undefined;
                    let pageSize = 100; // The incumbent B transport's initial page size, not a projection/retention bound.
                    do {
                        const page = await requestProviderAccountUsageHistoryPage(credentials, { recordId,
                            history: { range, pageSize, ...(cursor ? { cursor } : {}) } }, options);
                        if (!active) return;
                        if (!page) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
                        const next = await openHistoryPageWithYield({ recordId, accountMode: options.accountMode, material: options.material, page }, options);
                        if (!active) return;
                        entries = [...entries, ...next.entries];
                        pageSize += next.entries.length;
                        cursor = next.nextCursor ?? undefined;
                    } while (cursor);
                    const projection = buildProviderAccountUsagePageProjectionV1({ recordId, range, history: { entries, nextCursor: null } });
                    const last = entries.at(-1);
                    const metadata = { recordId, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING,
                        demand: { range, resolution: demand.resolution }, frontier: last ? { id: last.id, observedAtMs: last.observedAtMs } : null,
                        observationCount: entries.length };
                    const materialize = (): z.infer<typeof ProviderAccountUsagePageProjectionWriteV1Schema> => ({ ...metadata,
                        content: sealProviderAccountUsagePageProjectionV1({ projection, accountMode: options.accountMode,
                            material: options.material, randomBytes: getRandomBytes }) });
                    // Rejected/superseded protected content must be repaired;
                    // matching opaque metadata does not prove current encoding.
                    const published = opened ? raw.published : undefined;
                    const alreadyPublished = published && published.contentMode === (options.accountMode === 'plain' ? 'plain' : 'encrypted')
                        && published.demand.range.startAtMs === range.startAtMs
                        && published.observationCount === metadata.observationCount
                        && sameStrictJsonValue(published.frontier, metadata.frontier);
                    if (alreadyPublished) {
                        const body = materialize();
                        // Exact paging may race a backdated/removed witness.
                        // With no PUT to validate our derivation, re-admit that
                        // actual derived prefix before claiming completeness.
                        const confirmed = await requestProviderAccountUsageProjection(credentials, query, options, { projection: body, etag: '' });
                        if (!active) return;
                        if (!confirmed || confirmed.projection !== body || !confirmed.complete) continue;
                        assertCurrent();
                        // This is our derived representation, not the other
                        // writer's ciphertext. Its accepted-prefix proof is used
                        // next time; never borrow the other body's ETag.
                        admitted = { accountMode: options.accountMode, credentialScope,
                            materialType: options.material?.type, materialBytes: materialBytes?.slice(), opened: projection,
                            view: sameCustody ? prior?.view : undefined };
                        options.projectionDocuments?.set(recordId, { projection: body, etag: '', admitted });
                    } else {
                        assertCurrent();
                        const published = await publishUsageProjection(options.projectionDocuments, recordId, async () => {
                            if (!active) return false;
                            assertCurrent();
                            const held = options.projectionDocuments?.get(recordId);
                            // Another local reader can accept this exact derived
                            // document while our independent backfill is in flight.
                            // Compare admitted content, not opaque ciphertext or
                            // metadata alone, before skipping our duplicate PUT.
                            if (held && hasUsageProjectionCustody(held.admitted, options, credentialScope, materialBytes)
                                && sameStrictJsonValue(held.projection.demand, metadata.demand)
                                && sameStrictJsonValue(held.admitted!.opened, projection)) {
                                admitted = held.admitted;
                                return true;
                            }
                            // The incumbent publication owner has admitted the
                            // duplicate check. Only an actual write needs its
                            // complete packed/encrypted representation.
                            const body = materialize();
                            const writeScope = options.readTransport?.scope ?? options.readTransport?.key;
                            if (writeScope) usageHttpReads.invalidate(writeScope);
                            const response = await (options.request ?? createServerFetchForActiveServer(options.expectedActiveServer))('/v4/connect/qualified/provider-account-usage/history', {
                                method: 'PUT', signal: options.signal, headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
                                body: JSON.stringify(body),
                            }, { includeAuth: false, ...(options.expectedActiveServer ? { expectedActiveServer: options.expectedActiveServer } : {}) })
                                .finally(() => { if (writeScope) usageHttpReads.invalidate(writeScope); });
                            if (!active) return false;
                            assertCurrent();
                            if (!response.ok) {
                                if (response.status === 409) {
                                    const failure: unknown = await response.json();
                                    assertCurrent();
                                    if (failure && typeof failure === 'object' && 'error' in failure
                                        && failure.error === 'provider_account_usage_projection_conflict') return false;
                                }
                                const code = response.status === 401 || response.status === 403 ? 'denied'
                                    : response.status === 409 ? 'provider_account_usage_projection_conflict' : 'provider_account_usage_projection_write_failed';
                                throw new HappyError(code, false, { status: response.status, kind: response.status === 401 || response.status === 403 ? 'auth' : 'server', code });
                            }
                            admitted = { accountMode: options.accountMode, credentialScope,
                                materialType: options.material?.type, materialBytes: materialBytes?.slice(), opened: projection,
                                view: sameCustody ? prior?.view : undefined };
                            options.projectionDocuments?.set(recordId, { projection: body, etag: response.headers.get('etag') ?? '', admitted });
                            return true;
                        });
                        if (!active) return;
                        if (!published) continue;
                    }
                } else if (!opened) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_unavailable');
                if (!active) return;
                assertCurrent();
                // Coverage/range may change without a new selected observation.
                // Reuse only exact admitted entry identities, never a cursor/count.
                const view = admitted?.view;
                const selected = entries.filter(entry => entry.observedAtMs >= demand.range.startAtMs && entry.observedAtMs < demand.range.endAtMs);
                history = view && selected.length === view.history.entries.length
                    && selected.every((entry, index) => entry === view.history.entries[index])
                    ? view.history : { entries: selected, nextCursor: null };
                pageFacts = view && history === view.history && sameStrictJsonValue(recordJson, view.record) ? view.value.pageFacts : undefined;
                publish();
                return;
            }
        })()]);
        return project();
    } finally { active = false; }
}

/** HTTP owns the held document; range coverage is revalidated without its body. */
async function requestProviderAccountUsageProjection(credentials: AuthCredentials,
    query: Readonly<{ recordId: string; projection: NonNullable<ConnectedServiceQuotaGetInputV1['projection']> }>,
    options: ProviderAccountUsageQuotaReadOptions,
    heldOverride?: HeldUsageProjection,
): Promise<(z.infer<typeof ProviderAccountUsagePageProjectionReadV1Schema> & {
        published?: z.infer<typeof ProviderAccountUsagePageProjectionCoverageV1Schema>;
        opened?: ReturnType<typeof openProviderAccountUsagePageProjectionV1>;
    }) | null> {
    const path = `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({
        query: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema, query),
    }).toString()}`;
    throwIfAborted(options.signal); options.assertCurrent?.();
    const held = heldOverride ?? options.projectionDocuments?.get(query.recordId);
    const heldCoverage = held ? { demand: held.projection.demand, frontier: held.projection.frontier,
        observationCount: held.projection.observationCount, contentMode: held.projection.content.t } : undefined;
    const headPath = heldCoverage ? `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({
        query: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
            { ...query, heldProjection: heldCoverage }),
    }).toString()}` : path;
    const head = await acquireProviderUsageHttp(credentials, headPath, {
        method: 'HEAD', signal: options.signal, cache: 'no-store', headers: {
            Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json',
            'X-Happier-Request-Purpose': 'connected-accounts:quota-qualification',
            ...(held?.etag ? { 'If-None-Match': held.etag } : {}),
        },
    }, options);
    throwIfAborted(options.signal); options.assertCurrent?.();
    if (head.status === 401 || head.status === 403) throw new HappyError('Provider account usage authority refused', false,
        { status: head.status, kind: 'auth', code: 'denied' });
    if (head.status === 409) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_mode_mismatch');
    if (head.status === 404) return null;
    if (!head.ok && head.status !== 304 && head.status !== 405 && head.status !== 501) throw new HappyError('Provider account usage read failed', false,
        { status: head.status, kind: 'server', code: 'provider_account_usage_read_failed' });
    const complete = head.complete;
    const etag = head.etag;
    const prefixHeader = head.prefix;
    if ((head.ok || head.status === 304) && held && prefixHeader) {
        const prefix = ProviderAccountUsagePageProjectionPrefixReadV1Schema.parse(JSON.parse(decodeURIComponent(prefixHeader)));
        // Coverage belongs to the held body being extended, independently of
        // the changed server body's validator or complete bit (B3-A-01).
        if (sameStrictJsonValue(prefix.held, heldCoverage)) return { projection: held.projection,
            complete: prefix.complete, published: prefix.published };
    }
    if ((head.ok || head.status === 304) && etag && (complete === 'true' || complete === 'false')
        && held?.etag === etag) return { projection: held.projection, complete: complete === 'true' };
    // Incomplete coverage already needs the atomic demand read and backfill;
    // avoid downloading the same protected body twice on ordinary growth.
    if (head.ok && etag && complete === 'true') {
        const document = await requestProviderAccountUsageRead(credentials,
            `/v4/connect/qualified/provider-account-usage/history/document?recordId=${encodeURIComponent(query.recordId)}`, options);
        if (document === null) return null;
        const read = openProviderAccountUsagePageProjectionReadV1({ value: document.json, recordId: query.recordId,
            accountMode: options.accountMode, material: options.material });
        // A concurrent backdated observation may invalidate the prefix after
        // HEAD. A now-missing document must enter the existing backfill path.
        if (read.projection === null) return { projection: null, complete: false };
        if (etag === document.etag) {
            options.projectionDocuments?.set(query.recordId, { projection: read.projection, etag });
            return { ...read, complete: true };
        }
        // Another reader may have replaced the document, or accepted history
        // may have changed its coverage. Read demand and representation together
        // before the existing owner decides whether a backfill is needed.
    }
    // Missing/unexposed validators also use the original atomic demand read.
    const legacy = await requestProviderAccountUsageRead(credentials, path, options);
    if (legacy === null) return null;
    const read = openProviderAccountUsagePageProjectionReadV1({ value: legacy.json, recordId: query.recordId,
        accountMode: options.accountMode, material: options.material });
    if (read.projection && legacy.etag) options.projectionDocuments?.set(query.recordId, { projection: read.projection, etag: legacy.etag });
    else options.projectionDocuments?.delete(query.recordId);
    return read;
}

async function openHistoryPageWithYield(input: Parameters<typeof openProviderAccountUsageHistoryPageV4>[0],
    options: Pick<ProviderAccountUsageQuotaReadOptions, 'signal' | 'assertCurrent'>) {
    const assertCurrent = () => { throwIfAborted(options.signal); options.assertCurrent?.(); };
    const entries = await mapCryptoBatchWithYield(input.page.entries, entry => {
        assertCurrent();
        // Preserve the Protocol opener's record, mode, timestamp and page-entry
        // validation. Schedule it through the incumbent crypto batch owner.
        return openProviderAccountUsageHistoryPageV4({ ...input, page: { entries: [entry], nextCursor: null } }).entries[0]!;
    });
    assertCurrent();
    return { entries, nextCursor: input.page.nextCursor };
}

async function readProviderAccountUsageWaitingWork(credentials: AuthCredentials, input: ConnectedServiceQuotaGetInputV1, current: ProviderAccountUsageSnapshotV1 | null, options: ProviderAccountUsageQuotaReadOptions): Promise<{ nowMs: number; waitingWork: ProviderAccountUsageWaitingWorkV1 }> {
    const finish = (waitingWork: ProviderAccountUsageWaitingWorkV1, nowMs = options.nowMs ?? Date.now()) => ({ nowMs, waitingWork });
    const body = PendingResetStartsReadInputV1Schema.parse({ source: input.source });
    options.assertCurrent?.();
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
    const witnessedEntries = await Promise.all(parsed.data.entries.map(async entry => {
        const witness = entry.authorityCurrent ? await getProviderAccountUsageHistoryWitness(credentials, { recordId: entry.reset.recordId, witness: entry.reset.witness }, options) : null;
        return { entry, witness };
    }));
    options.assertCurrent?.();
    // Freshness is evaluated after the last awaited read, at one shared instant
    // for waiting work and pace. Explicit caller as-of time stays deterministic.
    const nowMs = options.nowMs ?? Date.now();
    const entries = witnessedEntries.map(({ entry, witness }) => ({
        sessionId: entry.sessionId, localId: entry.localId,
        recordId: entry.reset.recordId, meterId: entry.reset.meterId,
        readiness: evaluatePendingResetStartReadinessV1({ reset: entry.reset, witness, current, nowMs, authorityCurrent: entry.authorityCurrent }),
    }));
    return finish({ status: 'available', entries, ...(parsed.data.unboundEntries ? { unboundEntries: parsed.data.unboundEntries } : {}) }, nowMs);
}

type UsageReadTransportOptions = Pick<ProviderAccountUsageQuotaReadOptions,
    'request' | 'readTransport' | 'assertCurrent' | 'signal' | 'expectedActiveServer'>;

async function observeProviderUsageHttp(response: Response, method?: string): Promise<UsageHttpObservation> {
    let json: unknown = null;
    let jsonFailure: UsageHttpObservation['jsonFailure'];
    if (method !== 'HEAD' && response.status !== 404 && response.status !== 401 && response.status !== 403) {
        try { json = await response.json(); } catch (error) { jsonFailure = { error }; }
    }
    return { status: response.status, ok: response.ok, json, ...(jsonFailure ? { jsonFailure } : {}),
        etag: response.headers.get('etag'), documentEtag: response.headers.get('x-happier-usage-projection-document-etag'),
        complete: response.headers.get('x-happier-usage-projection-complete'),
        prefix: response.headers.get('x-happier-usage-projection-prefix') };
}

async function acquireProviderUsageHttp(credentials: AuthCredentials, path: string, init: RequestInit,
    options: UsageReadTransportOptions, fresh = false): Promise<UsageHttpObservation> {
    throwIfAborted(options.signal); options.assertCurrent?.();
    const consume = (response: Response) => observeProviderUsageHttp(response, init.method);
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
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) {
        throw new HappyError('Provider account usage authority refused', false,
            { status: response.status, kind: 'auth', code: 'denied' });
    }
    if (response.jsonFailure) throw response.jsonFailure.error;
    const json = response.json;
    options.assertCurrent?.();
    if (response.status === 409 && QualifiedProviderAccountUsageReadErrorV4Schema.safeParse(json).success) throw new ProviderAccountUsageReadErrorV1('provider_account_usage_content_mode_mismatch');
    if (!response.ok) {
        const code = extractErrorCode(json) ?? 'provider_account_usage_read_failed';
        throw new HappyError(code, false, { status: response.status, kind: 'server', code });
    }
    return { json, etag: response.documentEtag ?? response.etag };
}

async function requestProviderAccountUsageHistoryPage(credentials: AuthCredentials, query: ReturnType<typeof QualifiedProviderAccountUsageHistoryRequestV4Schema.parse>, options: ProviderAccountUsageQuotaReadOptions, fresh = false) {
    const read = await requestProviderAccountUsageRead(credentials, `/v4/connect/qualified/provider-account-usage/history?${new URLSearchParams({ query: encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema, query) }).toString()}`, options, fresh);
    return read === null ? null : QualifiedProviderAccountUsageHistoryResponseV4Schema.parse(read.json);
}

export async function getProviderAccountUsageHistoryWitness(credentials: AuthCredentials, input: Readonly<{ recordId: ProviderAccountUsageRecordId; witness: ProviderAccountUsageHistoryWitnessV1 }>, options: ProviderAccountUsageQuotaReadOptions) {
    const page = await requestProviderAccountUsageHistoryPage(credentials, input, options, true);
    if (!page) return null;
    const opened = await openHistoryPageWithYield({ recordId: input.recordId, accountMode: options.accountMode, material: options.accountMode === 'e2ee' ? options.material ?? resolveAccountScopedCryptoMaterialFromCredentials(credentials) : undefined, page }, options);
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
            await transport.read(path, { ...init, signal }, options, async response => consume(await observeProviderUsageHttp(response, 'GET')))),
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
