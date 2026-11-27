import { projectUsageAnalyticsResponseDemand } from '@happier-dev/protocol/usage/usageLeaderProjection';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionCredentialScopeDeniedHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { createFrontDoorActionExecute, createFrontDoorUiActionExecutor, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { readUsageAppCallsEnvironmentIds } from '@/sync/domains/usage/usageAppCallsSource';
import { readUsageAppCallsAccounting, readUsageAppCallsPriceOverrides } from './usageAppCallsAccounting';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { USAGE_PRICE_ACTION_IDS } from '@happier-dev/protocol/usage/usageActionIdsV1';
import { getUsageAnalyticsQueryRequestKey, type UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { createPluginUiResourceStore, pluginUiResourceReferenceKey, type PluginUiResourceStore, type PluginUiResourceEntry } from '@happier-dev/plugin-ui/advanced';
import type { ResourceContent, ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import { getUsageQueryBatchKey, getUsageQueryKey, normalizeUsageQuery, normalizeUsageQueryBatchInput, resolveUsageQueryPeriod, usageAnalyticsRequestToQuery, usageQueryToAnalyticsRequest, usageQueryNeedsContributionRows, type UsageQuery, type UsageQueryBatchInput } from '@happier-dev/protocol/inputs/usageQuery';
import { collectUsageWorkSources, readUsageWorkSessionTurns, resolveUsageWorkSessionTarget } from '@happier-dev/protocol/usage/usageWorkSources';
import { hasSameUsageQueryWorkEvidenceMembership } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { USAGE_COACH_PREFERENCES_READ_SOURCE, readUsageAccountingReadAtMs, resolveUsagePageAccountingReads, resolveUsageAccountingAsOfMs, resolveUsageComparisonQuery, resolveUsageQuotaSourceSnapshot, projectUsageQuotaCoverage, projectUsageQuotaSourceCoverage, retainAccountingOnReadFailure, retainUsageQueryResultReferences, canRetainUsageReadFailure, isUsageQuerySourceOutstanding, withdrawUsageQueryWork, UsageQueryBatchResultSchema, type UsageAccountingSourceSnapshot, type UsagePoolSourceSnapshot, type UsageQueryPoolSnapshot, type UsageQueryBatchResult, type UsageWorkSourceSnapshot, type UsageQuerySourceState, type UsageQueryResultSlice, type UsageQuotaCoverageRead, type UsageQuotaSourceSnapshot } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { ConnectedServicePoolSelectionGetRequestV1Schema, type ConnectedServicePoolSelectionGetRequestV1, type ConnectedServicePoolSelectionGetResponseV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { isMachineRpcTimeoutError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { isMachineRequestReachabilityFailureV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { readMachineRows } from '@/sync/api/machines/machineRowsApi';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { computePluginUiArtifactSha256Digest } from '@/sync/domains/plugins/ui/artifactIntegrity';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureServerCredentialAccountScopeLifetime } from '@/sync/domains/scope/serverCredentialAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById, areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveSessionProjectScopeV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { readProjectAccountWorkspaceRefs } from '@/sync/domains/workspaces/projectAccountRows';
import { getStorage } from '@/sync/domains/state/storage';
import { createServerFetchAtEndpoint, type ServerFetch } from '@/sync/http/client';
import { resolveServerScopedTransport } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport';
import { subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { parseToken } from '@/utils/auth/parseToken';
import { queryUsageAnalytics } from './apiUsage';
import { createUsageAccountingReader, getUsageAccountingReadKey, UsageAccountingSliceRefusal } from './usageAccountingReader';
import { captureAccountEncryptionCurrentness, getAccountEncryptionModeCacheRevision } from './apiAccountEncryptionMode';
import { classifyAccountStorageReadFailure } from '@/sync/encryption/accountStorageContext';
import { machineScmWorkEvidenceRead } from '@/sync/ops/scm/machineScm';
import { readSessionSnapshotsForAuthority } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { projectUsageQueryWorkEvidence, selectUsageQueryWorkEvidenceSessionIds, projectUsageSessionInput } from '@/sync/domains/usage/usageWorkEvidence';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readAccountSettingsForScope } from '@/sync/domains/state/accountSettingsPersistence';
import { getConnectedMetadataCatalog, subscribeConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { observeConnectedMetadataCatalog } from '@/sync/engine/settings/connectedMetadataCatalogEngine';
import { readConnectedSubscriptionMonthlyPriceV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { isConnectedPresentationCatalogUsableV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationSchemasV1';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { projectUsageAccountingSessionMembership, readUsageAccountingSessionMembership, usageQueryNeedsSessionCandidates, projectSessionUsageWorkEvidence,
    createSessionUsageWorkEvidenceProjector,
    type UsageSessionMessageEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, UsageSessionEvidenceResponseSchema,
    createUsageSessionEvidenceStreamDecoder,
    type UsageSessionEvidenceResponse } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { getUsageSessionFactKinds } from '@happier-dev/protocol/usage/usageSessionFactKinds';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { ConnectedServiceQuotaGetInputV1Schema, projectProviderAccountUsageQuotaReadV1, type ConnectedServiceQuotaGetInputV1, type ConnectedServiceQuotaGetResultV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { buildProviderAccountUsageScopeKey } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageLoadRoute';
import { getProviderAccountUsageCacheState, subscribeProviderAccountUsageCache, type ProviderAccountUsageCacheEntry } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageCache';
import { buildQualifiedQuotaSnapshotScopeKey, getQualifiedQuotaSnapshotEntry, subscribeQualifiedQuotaSnapshotEntry, type QualifiedQuotaSnapshotStoreEntry } from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { compareConnectedServiceQuotaObservationRecency, wasConnectedServiceQuotaObserved } from '@happier-dev/protocol/connect/quotaObservationTime';
import { getProviderAccountUsageDerivationInterval } from '@happier-dev/protocol/connect/deriveProviderAccountUsagePace';
import { getCachedServerFeaturesSnapshot, subscribeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveRuntimeFeatureDecisionFromSnapshot, type ServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { isTransientConnectivityError, RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { UsageModelPriceCatalogSchema, type UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { HappyError } from '@/utils/errors/errors';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { getUsageQueryMachineInvalidationKey, getUsageQueryPoolMachineSelection, isUsagePresentationHomeAccountChange, isUsageQuotaHomeAccountChange, isUsageProjectionHomeAccountChange, readUsageAccountingChangeScope, readUsageQuotaAccounts, readUsageQuotaBindingServiceKeys, readUsageQuotaChangedRecordIds, usageQuotaRecordChangeAffects, subscribeUsageQueryStateInvalidation, usageAccountingChangeAffectsQueries, type UsageQueryStateInvalidation } from './usageQueryInvalidation';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ProviderAccountUsageProjectionDocuments, ProviderAccountUsageQuotaViewDemand } from './apiProviderAccountUsage';
import type { ProviderAccountUsageDayChangeV1 } from '@happier-dev/protocol/changes/providerAccountUsage';
import type { ProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { createUsageQueryResourceContent } from './usageQueryResourceEncoding';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { createCapturedServerReadTransport, type CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
import { createUsageQuerySessionInputs, getUsageQuerySessionInputDemand, usageSessionInputDemandCovers, type SessionInputDemand, type SessionInputEvidence, type UsageSessionEvidenceKind, type OpenedUsageSessionSelection, type SessionInputReader, type SessionInputSelectionReader, type SessionInputSelectionProjector } from './usageQuerySessionInputs';
import { UsageQueryEvidencePhase } from './usageQueryEvidencePhase';
import { SessionPartsHttpError, SessionPartsInvalidResponseError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority';
import { OperationUpdateRequiredV1Schema } from '@happier-dev/protocol/compat/operationUpdateRequiredV1';
import { UsageCoachSuppressionInvalidResponse } from '@happier-dev/protocol/usage/coach/coachActions';
import { createUiCoachSuppressionPort } from './usageCoachSuppressions';
import type { UsageHistoryReadState } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { UsageHistoryEntry, readUsageHistoryFailure } from './usageHistoryReadState';
import { canRetryUsageCoverageFailure, isUsageQuotaOwnershipUnproven } from './usageReadFailure';
import type { UsageCoachSuppressionStateV1 } from '@happier-dev/protocol/usage/coach/coachActions';
import { openUsageCompactInput, persistUsageCompactInput } from './usageCompactInput';

import { projectRetainedUsageActivity, projectUsageQueryBatch, settleUsageQueryProjection, projectUsageEnteredPrices, type HowYouWorkEvidenceSnapshot, type HowYouWorkReadSnapshot,
    type OpenedQuotaRead, type UsageQueryReprojection, type PreparedUsageAccountingSnapshot } from './usageQueryProjection';
function readOpenedQuotaScope(context: UsageQueryAccountContext) {
    const state = readRegisteredStorageState();
    const scope = context.accountLifetime.scope;
    const serverBasis = getActiveServerSnapshot();
    if (!state || !context.accountLifetime.isCurrent() || !areServerAccountScopesEqual(state.profileScope, scope)
        || state.profile.id !== scope.accountId || !areServerProfileIdentifiersEquivalent(serverBasis.serverId, scope.serverId)) return null;
    const credentialsKey = resolveAuthCredentialsScopeKey(context.credentials);
    const credentialScope = [scope.serverId, String(serverBasis.generation), credentialsKey].join('\u0000');
    return { state, providerScope: buildProviderAccountUsageScopeKey({ serverId: scope.serverId,
        generation: serverBasis.generation, credentialScope: credentialsKey }),
        sources: readUsageQuotaAccounts(state.profile.connectedAccountsV4).map(account => ({
            source: { bindingKind: 'account' as const, ref: account.ref },
            key: buildQualifiedQuotaSnapshotScopeKey({ credentialScope, ref: account.ref,
                serverBasis: { serverId: scope.serverId, generation: serverBasis.generation } }),
        })) };
}

/** Unknown admission can retain facts; a refusal or known replacement cannot. */
function canRetainQuotaRead(admitted: Pick<QualifiedQuotaSnapshotStoreEntry, 'supported' | 'usageRecordId'>,
    read: ConnectedServiceQuotaGetResultV1): boolean {
    return admitted.supported !== false
        && (admitted.usageRecordId === null || admitted.usageRecordId === read.current?.recordId);
}

type UsageAllowanceProjection = Readonly<{
    quota?: readonly ConnectedServiceQuotaGetResultV1[];
    sources: readonly UsageQuerySourceState[];
}>;

/** A partial allowance revision updates settled rows without withdrawing the rest of the slice. */
export function mergeRetainedUsageAllowance(
    previous: UsageAllowanceProjection,
    replacement: UsageAllowanceProjection,
): Readonly<{ quota: ConnectedServiceQuotaGetResultV1[]; sources: UsageQuerySourceState[] }> {
    const quotaBySource = new Map<string, ConnectedServiceQuotaGetResultV1>();
    for (const read of previous.quota ?? []) quotaBySource.set(createCanonicalJsonSigningInput(read.source), read);
    for (const read of replacement.quota ?? []) {
        const key = createCanonicalJsonSigningInput(read.source);
        const prior = quotaBySource.get(key);
        // A replacement without a current observation is still in flight or unavailable;
        // it cannot erase the last accepted provider reading.
        if (!prior || read.current || !prior.current) quotaBySource.set(key, read);
    }
    const sourceByKey = new Map<string, UsageQuerySourceState>();
    for (const state of previous.sources.filter(state => state.source === 'quota' || state.source.startsWith('quota:'))) {
        sourceByKey.set(state.source, state);
    }
    for (const state of replacement.sources.filter(state => state.source === 'quota' || state.source.startsWith('quota:'))) {
        const prior = sourceByKey.get(state.source);
        const pending = state.status === 'pending' || state.status === 'not_loaded';
        const priorSettled = prior && prior.status !== 'pending' && prior.status !== 'not_loaded';
        if (!prior || !pending || !priorSettled) sourceByKey.set(state.source, state);
    }
    return { quota: [...quotaBySource.values()], sources: [...sourceByKey.values()] };
}

/** Reconcile B once, whether its revision came from cache, read progress or a sibling. */
function reconcileQuotaRead(input: Readonly<{
    admitted: Pick<QualifiedQuotaSnapshotStoreEntry, 'supported' | 'usageRecordId' | 'loading' | 'error'>;
    source: ConnectedServiceQuotaGetInputV1['source'];
    previous?: ConnectedServiceQuotaGetResultV1;
    previousState?: UsageQuerySourceState;
    revision: Readonly<{ kind: 'cache'; row: ProviderAccountUsageCacheEntry | undefined; nowMs: number;
        targets: Parameters<typeof projectProviderAccountUsageQuotaReadV1>[0]['targets'] }>
        | Readonly<{ kind: 'progress'; value: ConnectedServiceQuotaGetResultV1 | null; settled: boolean; historyRequested: boolean; errorCode?: string }>
        | Readonly<{ kind: 'sibling'; state: UsageQuerySourceState }>;
}>): UsageQuotaCoverageRead {
    const { admitted, source: quotaSource, previousState, revision } = input;
    const source = `quota:${createCanonicalJsonSigningInput(quotaSource)}`;
    // Progress already carries the admission made at this finite read's entry.
    // Cache and sibling observations must still match that admitted record.
    const retained = input.previous && (revision.kind === 'progress' || canRetainQuotaRead(admitted, input.previous))
        ? input.previous : undefined;
    const settledState = previousState && previousState.status !== 'pending' && previousState.status !== 'not_loaded'
        ? previousState : undefined;
    if (revision.kind === 'sibling') {
        return ['pending', 'not_loaded'].includes(revision.state.status) && settledState && retained
            ? { value: retained, state: settledState } : { value: null, state: revision.state };
    }
    if (revision.kind === 'cache') {
        const { row, nowMs, targets } = revision;
        // A current-only cache observation cannot replace settled history.
        if (retained?.current && settledState && admitted.error === null && !row?.hadError
            && (!row?.snapshot || row.snapshot.recordId === retained.current.recordId)) {
            const stale = (settledState.status === 'available' || settledState.status === 'partial')
                && projectUsageQuotaSourceCoverage(source, retained, nowMs, false).status === 'stale';
            const state = stale ? { ...settledState, status: 'stale' as const } : settledState;
            return { value: retained, state };
        }
        const pending = (admitted.loading || row?.loading === true)
            && (!row?.snapshot || !wasConnectedServiceQuotaObserved(row.snapshot));
        if (!row?.snapshot || row.snapshot.recordId !== admitted.usageRecordId) {
            return { value: retained ?? null, ...(retained && previousState ? { state: previousState } : {}),
                pending, unavailable: true };
        }
        const value = projectProviderAccountUsageQuotaReadV1({ input: { source: quotaSource }, current: row.snapshot, nowMs,
            targets, waitingWork: { status: 'unavailable', reason: 'read_failed' } });
        const coverage = projectUsageQuotaSourceCoverage(source, value, nowMs, false);
        // The current body can advance while the already admitted history read is still outstanding.
        const historyPending = retained !== undefined && previousState?.status === 'pending';
        return { value,
            state: wasConnectedServiceQuotaObserved(row.snapshot)
                ? { ...coverage, status: admitted.error !== null || row.hadError ? 'stale'
                    : historyPending && coverage.status === 'available' ? 'pending' : coverage.status }
                : previousState ?? { source, status: 'not_loaded' }, pending: pending || historyPending };
    }
    let { value } = revision;
    const { settled, historyRequested, errorCode } = revision;
    if (!settled && !errorCode && retained && settledState) return { value: retained, state: settledState };
    if (errorCode) {
        if (!canRetainUsageReadFailure(errorCode)) value = null;
        else if ((retained?.history || retained?.pageProjection || retained?.pageFacts) && settledState
            && (!value?.current || value.current.recordId === retained.current?.recordId)) value = retained;
        else {
            const accepted = value;
            const projected = accepted?.pageFacts ? accepted : accepted ? projectProviderAccountUsageQuotaReadV1({ input: { source: accepted.source },
                current: accepted.current, history: accepted.history, pageProjection: accepted.pageProjection, pageFacts: accepted.pageFacts,
                targets: accepted.targets, waitingWork: accepted.waitingWork, nowMs: Date.now() }) : retained;
            value = projected ? accepted?.history || accepted?.pageProjection || accepted?.pageFacts ? projected
                : { ...projected, unusedCapacity: { historyStatus: 'unavailable', windows: [] } } : null;
        }
    }
    const unobservedReplacement = value?.current && !wasConnectedServiceQuotaObserved(value.current)
        && retained?.current && wasConnectedServiceQuotaObserved(retained.current)
        && retained.current.recordId === value.current.recordId && canRetainQuotaRead(admitted, retained);
    if (unobservedReplacement) value = retained;
    let retainedPace = false;
    if (value?.current && retained?.current && sameStrictJsonValue(value.current, retained.current) && canRetainQuotaRead(admitted, retained)) {
        const previousPaces = new Map(retained.pace.map(row => [row.meterId, row.value]));
        const pace = value.pace.map(row => {
            const prior = previousPaces.get(row.meterId);
            if (row.value.status !== 'unavailable' || row.value.reason !== 'stale' || prior?.status !== 'available'
                || prior.window.resetAtMs <= Date.now()) return row;
            retainedPace = true;
            return { ...row, value: prior };
        });
        if (retainedPace) value = { ...value, pace };
    }
    const observation = projectUsageQuotaSourceCoverage(source, value, Date.now(), historyRequested);
    return { value, state: { ...observation,
        status: errorCode ? value ? 'stale' : 'error' : unobservedReplacement || retainedPace ? 'stale'
            : settled || value?.pageFacts?.historyStatus === 'complete' || value?.pageProjection || value?.history?.nextCursor === null
                ? observation.status
                : 'pending',
        ...(errorCode ? { errorCode } : {}),
    } };
}

/** Observe already-admitted B; this path never probes, decrypts or refreshes a provider. */
function readOpenedQuota(context: UsageQueryAccountContext, queries: readonly UsageQuery[], previous?: UsageQueryBatchResult): OpenedQuotaRead {
    const scope = readOpenedQuotaScope(context);
    if (!scope) return { status: 'unknown', errorCode: 'account_profile_unavailable' };
    if (scope.sources.length === 0) return scope.state.profile.connectedAccountsV4.length === 0
        ? { status: 'unsupported', errorCode: 'no_connected_accounts' }
        : { status: 'error', errorCode: 'connected_account_needs_reauth' };
    const decision = readQuotaFeatureDecision(context, scope);
    if (decision?.state !== 'enabled') return { status: decision?.state === 'unknown' || !decision ? 'unknown' : 'unsupported' };
    const rows = getProviderAccountUsageCacheState().entriesByCredentialScope[scope.providerScope] ?? {};
    const nowMs = Date.now();
    const targets = areServerAccountScopesEqual(scope.state.settingsScope, context.accountLifetime.scope)
        ? scope.state.settings.usagePacingTargetsV1 : undefined;
    const admissions = scope.sources.map(({ key, source }) => ({ source, sourceKey: createCanonicalJsonSigningInput(source),
        admitted: getQualifiedQuotaSnapshotEntry(key) }));
    const project = (prior?: UsageQueryResultSlice): UsageQuotaSourceSnapshot => {
        const retainedBySource = new Map(prior?.quota?.map(value => [createCanonicalJsonSigningInput(value.source), value]));
        const previousBySource = new Map(prior?.sources.map(state => [state.source, state]));
        const reads = admissions.map(({ source, sourceKey, admitted }) => {
            const row = admitted.supported === true && admitted.usageRecordId ? rows[admitted.usageRecordId] : undefined;
            return reconcileQuotaRead({ admitted, source, previous: retainedBySource.get(sourceKey),
                previousState: previousBySource.get(`quota:${sourceKey}`), revision: { kind: 'cache', row, nowMs, targets } });
        });
        return projectUsageQuotaCoverage(reads,
            admissions.every(({ admitted }) => admitted.supported === false) ? 'unsupported' : 'not_loaded');
    };
    const head = project();
    const previousByQuery = new Map(previous?.results.map(slice => [slice.key, slice]));
    const quotaByQuery = new Map(queries.map(query => {
        const key = getUsageQueryKey(query);
        const prior = previousByQuery.get(key);
        return [key, prior ? project(prior) : head] as const;
    }));
    return { ...head, quotaByQuery };
}

function readQuotaFeatureDecision(context: UsageQueryAccountContext, scope: NonNullable<ReturnType<typeof readOpenedQuotaScope>>,
    snapshot: ServerFeaturesRuntimeSnapshot = getCachedServerFeaturesSnapshot({ serverId: context.accountLifetime.scope.serverId })
        ?? { status: 'loading' }) {
    return resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'connectedServices.quotas',
        settings: scope.state.settings, snapshot, scope: { scopeKind: 'runtime' } });
}

export type UsageQueryAccountContext = Readonly<{
    credentials: AuthCredentials;
    accountLifetime: ServerAccountScopeLifetime;
    request: ServerFetch;
    readTransport?: CapturedServerReadTransport;
    /** The finite acquisition's admitted caller, captured before any asynchronous work. */
    callerContext?: ActionExecutorContext;
}>;

function requireCurrent(context: UsageQueryAccountContext, signal?: AbortSignal): void {
    throwIfAborted(signal);
    if (!context.accountLifetime.isCurrent()) {
        throw Object.assign(new Error('Usage Account authority retired'), { code: 'stale_surface' });
    }
}

/** Public tariff transport is separate from private Account settings and never carries overrides. */
const modelPriceReads = createScopedResolutionSingleFlight<UsageModelPriceCatalog>();
export async function readUiUsageModelPrices(context: UsageQueryAccountContext, refresh = false,
    signal?: AbortSignal): Promise<UsageModelPriceCatalog> {
    requireCurrent(context, signal);
    const transport = context.readTransport;
    const bindingKey = transport?.key;
    const scope = transport?.scope ?? bindingKey;
    const abort = new AbortController();
    const retirement = context.accountLifetime.onRetire(() => abort.abort());
    const cancellation = mergeAbortSignals([signal, abort.signal]);
    const consume = async (response: Response) => {
        if (!response.ok) {
            if (response.status === 403) {
                const refusal = readActionCredentialScopeDeniedHttpFailureV1(response.status, await response.json().catch(() => null));
                if (refusal) throw createActionExecuteFailureError(refusal);
            }
            throw new HappyError('Model price catalog unavailable', false, {
                status: response.status, kind: response.status === 401 || response.status === 403 ? 'auth' : 'config',
                code: response.status === 401 || response.status === 403 ? 'denied'
                    : [404, 405, 501].includes(response.status) ? 'unsupported' : 'usage_prices_read_failed',
            });
        }
        return UsageModelPriceCatalogSchema.parse(await response.json());
    };
    if (refresh && scope) modelPriceReads.invalidate(scope);
    try {
        const spec = getActionSpec(refresh ? USAGE_PRICE_ACTION_IDS.refresh : USAGE_PRICE_ACTION_IDS.get);
        const { path, method, body } = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport!, inputSchema: spec.inputSchema, input: {} });
        const init = { method,
            headers: { Authorization: `Bearer ${context.credentials.token}`, ...(refresh ? { 'Content-Type': 'application/json' } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
        const value = !refresh && transport && scope
            ? await modelPriceReads.run(JSON.stringify([bindingKey, path]), sharedSignal => transport.read(path, { ...init, signal: sharedSignal }, undefined, consume),
                { scope, signal: cancellation.signal })
            : await consume(await context.request(path, { ...init, signal: cancellation.signal }));
        requireCurrent(context, cancellation.signal);
        if (refresh) invalidateUsageQueryResources(context.accountLifetime);
        return value;
    } finally {
        if (refresh && scope) modelPriceReads.invalidate(scope);
        cancellation.dispose(); retirement.dispose();
    }
}

/** The quota host read and Usage batch share the same admitted Action port. */
async function withUiConnectedServiceReader<T>(context: UsageQueryAccountContext, signal: AbortSignal | undefined,
    consume: (read: (input: ConnectedServiceQuotaGetInputV1) => Promise<ConnectedServiceQuotaGetResultV1>,
        readSelection: (input: ConnectedServicePoolSelectionGetRequestV1) => Promise<ConnectedServicePoolSelectionGetResponseV1>) => Promise<T>,
    quotaReadOptions?: Pick<import('./apiProviderAccountUsage').ProviderAccountUsageQuotaReadOptions, 'readAllHistory' | 'includePendingWork' | 'historyView' | 'exactHistoryRange' | 'dayChange' | 'changesCursor' | 'addressedReads'>) {
    const [{ captureLazyActionAccountContext }, { createUiConnectedServiceAction }] = await Promise.all([
        import('@/sync/ops/actions/actionAccountContext'), import('@/sync/ops/actions/connectedServiceActionDeps'),
    ]);
    const account = await captureLazyActionAccountContext(context.accountLifetime.scope.serverId, signal);
    try {
        requireCurrent(context, signal); account.assertCurrent();
        if (!areServerAccountScopesEqual(account.accountLifetime.scope, context.accountLifetime.scope)) {
            throw Object.assign(new Error('Quota Account authority retired'), { code: 'stale_surface' });
        }
        const readOptions = { ...quotaReadOptions,
            projectionDocuments: accountStores.get(resolveUsageOwnerLifetime(context))?.projectionDocuments };
        const action = createUiConnectedServiceAction(account, readOptions);
        const execute = context.callerContext
            ? createFrontDoorActionExecute(undefined, { connectedServiceQuotaReadOptions: readOptions }) : undefined;
        const invoke = async (actionId: 'connectedServices.quota.get' | 'connectedServices.pools.selection.get',
            input: ConnectedServiceQuotaGetInputV1 | ConnectedServicePoolSelectionGetRequestV1) => {
            requireCurrent(context, signal); account.assertCurrent();
            const result = execute ? await (async () => {
                const outcome = await execute(actionId, input, { ...context.callerContext,
                    serverId: context.accountLifetime.scope.serverId, expectedAccountId: context.accountLifetime.scope.accountId, signal });
                requireActionSuccess(outcome);
                return outcome.result;
            })() : await action({ actionId, input,
                context: { surface: 'ui', authority: 'present_user' }, signal });
            requireCurrent(context, signal); account.assertCurrent();
            if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
                throw Object.assign(new Error('error' in result ? String(result.error) : 'Quota read failed'),
                    { code: 'errorCode' in result ? result.errorCode : 'quota_read_failed' });
            }
            return result;
        };
        // The configuration executor validates its action-specific output and
        // exact source/group before returning. Recover that type at its erased
        // Action port; parsing again would clone the same admitted history.
        return await consume(async input => await invoke('connectedServices.quota.get', input) as ConnectedServiceQuotaGetResultV1,
            async input => await invoke('connectedServices.pools.selection.get', input) as ConnectedServicePoolSelectionGetResponseV1);
    } finally { account.dispose(); }
}

export async function readUiQuota(context: UsageQueryAccountContext, input: ConnectedServiceQuotaGetInputV1,
    signal?: AbortSignal): Promise<ConnectedServiceQuotaGetResultV1> {
    return await withUiConnectedServiceReader(context, signal, read => read(input));
}

function readOpenedUsagePools(context: UsageQueryAccountContext, queries: readonly UsageQuery[]): UsagePoolSourceSnapshot[] {
    const scope = readOpenedQuotaScope(context);
    return queries.map(query => {
        const selection = getUsageQueryPoolMachineSelection(scope?.state.machines ?? {}, query.machines, context.accountLifetime.scope);
        return { query, value: (scope?.state.profile.connectedAccountGroupsV4 ?? []).map(group => ({
            group: group.ref, memberAccountIds: group.members.map(member => member.connectedAccountId),
            activeAccountId: group.activeConnectedAccountId,
            selection,
        })) };
    });
}

async function readUiUsagePools(context: UsageQueryAccountContext, opened: readonly UsagePoolSourceSnapshot[], signal: AbortSignal | undefined,
    onProgress: (pools: UsagePoolSourceSnapshot[]) => void): Promise<readonly UsagePoolSourceSnapshot[]> {
    if (!opened.some(snapshot => snapshot.value.some(pool => pool.selection.status === 'pending'))) return opened;
    const reads = new Map<string, Promise<UsageQueryPoolSnapshot['selection']>>();
    let values = [...opened];
    try {
        await withUiConnectedServiceReader(context, signal, async (_quota, readSelection) => {
            await Promise.all(opened.flatMap((snapshot, queryIndex) => snapshot.value.map(async (pool, poolIndex) => {
                const machineId = pool.selection.machineId;
                if (!machineId || pool.selection.status !== 'pending') return;
                const key = JSON.stringify([machineId, pool.group]);
                let read = reads.get(key);
                if (!read) {
                    read = (async (): Promise<UsageQueryPoolSnapshot['selection']> => {
                        try {
                            const value = await readSelection({ machineId, group: pool.group });
                            requireCurrent(context, signal);
                            return 'status' in value ? { status: value.code === 'unsupported' ? 'unsupported' : 'error', machineId, errorCode: value.code }
                                : { status: 'available', machineId, asOfMs: value.observedAtMs, value };
                        } catch (error) {
                            requireCurrent(context, signal);
                            return { status: 'error', machineId, errorCode: readRpcErrorCode(error) ?? (error && typeof error === 'object' && 'code' in error
                                && typeof error.code === 'string' ? error.code : 'connected_service_request_failed') };
                        }
                    })();
                    reads.set(key, read);
                }
                const selection = await read;
                requireCurrent(context, signal);
                // The projection retains each query's published pool list as an input.
                const next = [...values];
                const value = [...next[queryIndex]!.value];
                value[poolIndex] = { ...pool, selection };
                next[queryIndex] = { query: snapshot.query, value };
                values = next;
                onProgress(values);
            })));
        });
    } catch (error) {
        requireCurrent(context, signal);
        const errorCode = readRpcErrorCode(error) ?? (error && typeof error === 'object' && 'code' in error
            && typeof error.code === 'string' ? error.code : 'connected_service_request_failed');
        values = values.map(snapshot => ({ ...snapshot, value: snapshot.value.map(pool =>
            pool.selection.status === 'pending' && pool.selection.machineId
                ? { ...pool, selection: { status: 'error', machineId: pool.selection.machineId, errorCode } } : pool) }));
        onProgress(values);
    }
    return values;
}


/** The opened quota sources an allowance history read acquires, or null when it reads nothing. */
function readOpenedQuotaHistoryScope(context: UsageQueryAccountContext) {
    const scope = readOpenedQuotaScope(context);
    return scope?.sources.length && readQuotaFeatureDecision(context, scope)?.state === 'enabled' ? scope : null;
}

function getQuotaHistoryMode(query: UsageQuery): 'head' | 'daily' | 'exact' {
    if (!query.includeQuotaHistory) return 'head';
    return query.includeQuotaExactHistory === false && 'relative' in query.period
        && (query.period.relative === 'year' || query.period.relative === 'all') ? 'daily' : 'exact';
}

/** Latest-batch siblings may share history only when they ask for the same history. */
export function getRetainedQuotaPeriodKey(query: UsageQuery): string {
    const mode = getQuotaHistoryMode(query);
    return mode === 'head' ? mode : createCanonicalJsonSigningInput([
        mode, projectNativeJsonValueForTransport(query.period), query.timeZoneOffsetMinutes ?? 0,
    ]);
}

type RetainedUsageAllowance = Readonly<{
    slices: ReadonlyMap<string, UsageQueryResultSlice>;
    heads: ReadonlyMap<string, Readonly<{ read: ConnectedServiceQuotaGetResultV1; state: UsageQuerySourceState }>>;
}>;

function retainUsageAllowance(batch: UsageQueryBatchResult, previous: RetainedUsageAllowance | undefined): RetainedUsageAllowance | undefined {
    const slices = new Map<string, UsageQueryResultSlice>();
    const heads = new Map<string, { read: ConnectedServiceQuotaGetResultV1; state: UsageQuerySourceState }>();
    const nowMs = Date.now();
    for (const slice of batch.results) {
        if (slice.requestedQuery.includeQuota === false) continue;
        slices.set(getRetainedQuotaPeriodKey(slice.requestedQuery), slice);
        const sources = new Map(slice.sources.map(source => [source.source, source]));
        for (const read of slice.quota ?? []) {
            const { current } = read;
            if (!current) continue;
            const key = createCanonicalJsonSigningInput(read.source);
            const existing = heads.get(key);
            if (existing?.read.current && ['incoming_older', 'incoming_future'].includes(compareConnectedServiceQuotaObservationRecency({
                existingObservedAtMs: existing.read.current.observedAtMs, incomingObservedAtMs: current.observedAtMs, nowMs,
            }))) continue;
            const source = `quota:${key}`;
            const sourceState = sources.get(source);
            // A settled unobserved record has already answered the first read.
            // Keep that answer when another history mode takes over its head.
            const observed = wasConnectedServiceQuotaObserved(current);
            if (!observed && (!sourceState || sourceState.status === 'pending' || sourceState.status === 'not_loaded')) continue;
            const prior = (existing ?? previous?.heads.get(key))?.read;
            const head = prior?.current === current && prior.targets === read.targets && prior.waitingWork === read.waitingWork ? prior
                : projectProviderAccountUsageQuotaReadV1({ input: { source: read.source }, current, nowMs, targets: read.targets, waitingWork: read.waitingWork });
            // A head loan carries no history, so partial history does not age the head.
            const state: UsageQuerySourceState = !observed && sourceState ? sourceState
                : sourceState?.status === 'available' || sourceState?.status === 'partial'
                    ? projectUsageQuotaSourceCoverage(source, head, nowMs, false)
                    : { source, status: 'stale', asOfMs: current.fetchedAtMs };
            if (existing?.state.status === 'available' && state.status === 'stale' && existing.read.current === current) continue;
            heads.set(key, { read: head, state });
        }
    }
    return slices.size ? { slices, heads } : previous;
}

type UsageAllowanceReadTargets = Readonly<{ recordIds: readonly string[]; sourceKeys: readonly string[]; bindingServiceKeys?: readonly string[] }>;

function joinAllowanceReadTargets(left: UsageAllowanceReadTargets | undefined, right: UsageAllowanceReadTargets | undefined) {
    if (!left || !right) return undefined;
    return { recordIds: [...new Set([...left.recordIds, ...right.recordIds])],
        sourceKeys: [...new Set([...left.sourceKeys, ...right.sourceKeys])],
        bindingServiceKeys: [...new Set([...(left.bindingServiceKeys ?? []), ...(right.bindingServiceKeys ?? [])])] };
}

async function readOpenedQuotaHistory(context: UsageQueryAccountContext,
    demands: readonly Readonly<{ query: UsageQuery; period: NonNullable<UsageAccountingSourceSnapshot['period']> }>[], nowMs: number, signal?: AbortSignal,
    onProgress?: (quota: OpenedQuotaRead) => void, previous?: UsageQueryBatchResult,
    opened: OpenedQuotaRead = readOpenedQuota(context, demands.map(({ query }) => query), previous), targets?: UsageAllowanceReadTargets, dayChange?: ProviderAccountUsageDayChangeV1,
    recoverySources?: ReadonlySet<string>): Promise<OpenedQuotaRead> {
    const scope = readOpenedQuotaHistoryScope(context);
    if (!scope) return opened;
    // Start at the existing transport batch size; the admitted B reader grows
    // subsequent pages and publishes their accepted change points progressively.
    const quotaByQuery = new Map<string, UsageQuotaSourceSnapshot>(opened.quotaByQuery);
    const views: ProviderAccountUsageQuotaViewDemand[] = [];
    for (const { query, period } of demands) {
        const key = getUsageQueryKey(query);
        const mode = getQuotaHistoryMode(query);
        const range = mode === 'head' ? undefined : { startAtMs: period.startMs ?? 0, endAtMs: period.endMs ?? nowMs };
        if (range && range.endAtMs <= range.startAtMs) quotaByQuery.set(key, { status: 'unknown', errorCode: 'quota_query_range_empty' });
        else views.push({ key, range, exact: mode === 'exact' });
    }
    if (!views.length) return { ...opened, quotaByQuery };
    const union = (ranges: readonly NonNullable<ProviderAccountUsageQuotaViewDemand['range']>[]) => ranges.length
        ? { startAtMs: Math.min(...ranges.map(range => range.startAtMs)), endAtMs: Math.max(...ranges.map(range => range.endAtMs)) } : undefined;
    const range = union(views.flatMap(view => view.range ? [view.range] : []));
    const daily = views.some(view => view.range && !view.exact);
    const exactHistoryRange = union(views.flatMap(view => view.exact && view.range ? [view.range] : []));
    const admissions = scope.sources.map(({ source, key }) => ({ source, sourceKey: createCanonicalJsonSigningInput(source),
        admitted: getQualifiedQuotaSnapshotEntry(key) }));
    const priorByQuery = new Map(previous?.results.map(slice => [slice.key, slice]));
    // Account reads settle independently. Keep their qualified identity even
    // when a failed read has no current facts to disclose.
    const progress = views.map(view => {
        const seed = quotaByQuery.get(view.key) ?? opened;
        const priorSlice = priorByQuery.get(view.key);
        const retained = new Map(seed.value?.map(value => [createCanonicalJsonSigningInput(value.source), value]));
        const previousStates = new Map(seed.sources?.map(state => [state.source, state]));
        const priorValues = new Map(priorSlice?.quota?.map(value => [createCanonicalJsonSigningInput(value.source), value]));
        const priorStates = new Map(priorSlice?.sources.map(state => [state.source, state]));
        const sources = admissions.map(({ sourceKey, admitted }) => {
            const prior = priorValues.get(sourceKey);
            const observed = retained.get(sourceKey);
            const previous = prior && canRetainQuotaRead(admitted, prior)
                && (!observed?.current || observed.current.recordId === prior.current?.recordId) ? prior : observed;
            const source = `quota:${sourceKey}`;
            const state = recoverySources && !recoverySources.has(source)
                ? priorStates.get(source) ?? { source, status: 'not_loaded' as const }
                : previous && previousStates.get(source) || priorStates.get(source) || { source, status: 'pending' as const };
            return { previous, previousState: state, value: previous ?? null, state,
                accepted: undefined as ConnectedServiceQuotaGetResultV1 | undefined, settled: false,
                errorCode: undefined as string | undefined };
        });
        return { ...view, sources };
    });
    const addressedReads = new Map<string, ProviderAccountUsageRecordId>();
    const recordIds = admissions.map(({ admitted }, index) => admitted.usageRecordId
        ?? progress.find(view => view.sources[index]?.value?.current)?.sources[index]?.value?.current?.recordId);
    // A publication for an as-yet unknown record can be the first reading
    // for an unresolved source. A known record only wakes its own sources.
    const findUnknownRecord = targets?.recordIds.some(id => !recordIds.includes(id));
    const requestedIndices = admissions.flatMap(({ admitted, source, sourceKey }, index) => {
        if (recoverySources && !recoverySources.has(`quota:${sourceKey}`)) return [];
        if (!targets || targets.sourceKeys.includes(sourceKey)) return [index];
        // Resolve a changed service's bindings before using any named record address.
        // Its old record can remain accessible through another source.
        if (targets.bindingServiceKeys?.includes(buildQualifiedPluginContributionKey(source.ref.service))) return [index];
        const recordId = recordIds[index];
        if (!recordId) return findUnknownRecord ? [index] : [];
        if (!targets.recordIds.includes(recordId)) return [];
        if (admitted.supported !== false) addressedReads.set(sourceKey, recordId);
        return [index];
    });
    const project = () => ({ ...opened, quotaByQuery: new Map(quotaByQuery) });
    const projectProgressQuota = (rows: typeof progress[number]['sources']) => projectUsageQuotaCoverage(
        rows, 'partial', requestedIndices.some(index => !rows[index]!.settled && !rows[index]!.errorCode));
    if (!requestedIndices.length) {
        for (const view of progress) quotaByQuery.set(view.key, projectUsageQuotaCoverage(view.sources, 'available'));
        return project();
    }
    const publishProgress = (index: number, values?: ReadonlyMap<string, ConnectedServiceQuotaGetResultV1>, settled = false,
        failure?: Readonly<{ code: string; queryKeys?: readonly string[] }>): void => {
        requireCurrent(context, signal);
        const { source, admitted } = admissions[index]!;
        let changed = false;
        for (const view of progress) {
            if (failure?.queryKeys && !failure.queryKeys.includes(view.key)) continue;
            const row = view.sources[index]!;
            const value = values?.get(view.key) ?? row.accepted;
            const errorCode = failure?.code ?? row.errorCode;
            const viewSettled = settled || !view.range || !!value?.pageFacts;
            if (errorCode === row.errorCode && value === row.accepted && viewSettled === row.settled) continue;
            const reconciled = reconcileQuotaRead({ admitted, source, previous: row.previous, previousState: row.previousState,
                revision: { kind: 'progress', value: value ?? null, settled: viewSettled, historyRequested: view.range !== undefined, errorCode } });
            Object.assign(row, { accepted: value, settled: viewSettled, errorCode, value: reconciled.value, state: reconciled.state! });
            quotaByQuery.set(view.key, projectProgressQuota(view.sources));
            changed = true;
        }
        if (changed) onProgress?.(project());
    };
    // A cold admitted read is pending, not an unissued cache observation. Every
    // skipped read above has already returned a terminal reason.
    for (const view of progress) if (!quotaByQuery.get(view.key)?.value?.length) quotaByQuery.set(view.key, projectProgressQuota(view.sources));
    onProgress?.(project());
    const sourceIndices = new Map(admissions.map(({ sourceKey }, index) => [sourceKey, index]));
    const indexForSource = (source: ConnectedServiceQuotaGetInputV1['source']): number => {
        const index = sourceIndices.get(createCanonicalJsonSigningInput(source));
        if (index === undefined) throw new Error('Quota reader returned an unrequested source');
        return index;
    };
    const failSource = (index: number, error: unknown, queryKeys?: readonly string[]) => {
        requireCurrent(context, signal);
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code : 'quota_read_failed';
        if (queryKeys && !canRetainUsageReadFailure(code)) throw error;
        publishProgress(index, undefined, false, { code, queryKeys });
    };
    // The batch has one captured Home/Account lifetime. Share its existing
    // mode promise and live catalog reads instead of recapturing per source.
    try {
        const { sync } = await import('@/sync/sync');
        const { serverId, accountId } = context.accountLifetime.scope;
        const changesCursor = sync?.readAppliedAccountChangesCursor?.(serverId, accountId);
        await withUiConnectedServiceReader(context, signal, async read => Promise.all(requestedIndices.map(async index => {
            const { source } = scope.sources[index]!;
            try {
                await read({ source, ...(range ? { projection: { range, resolution: 'accepted_observations' as const } } : {}) });
                publishProgress(index, undefined, true);
            } catch (error) { failSource(index, error); }
        })), { includePendingWork: !!range, changesCursor, dayChange, addressedReads, ...(daily ? { historyView: 'daily', exactHistoryRange } : {}), readAllHistory: {
            views,
            onProgress: (value, projectedViews) => publishProgress(indexForSource(value.source), projectedViews),
            onViewFailure: (source, queryKeys, error) => failSource(indexForSource(source), error, queryKeys),
        } });
    } catch (error) {
        // A failure capturing the common Account applies to every source;
        // an individual provider refusal above still settles independently.
        requestedIndices.forEach(index => failSource(index, error));
    }
    requireCurrent(context, signal);
    for (const view of progress) quotaByQuery.set(view.key, projectUsageQuotaCoverage(view.sources, 'available'));
    return project();
}

type SessionAccountCurrentnessSource = ReturnType<typeof import('@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope').createOperationAccountCurrentnessSource>;

type SessionInputLoadRequest = Readonly<{
    sessionId: string;
    assertCurrent: () => void;
    signal: AbortSignal;
    retained: SessionInputEvidence | undefined;
    publish: (value: SessionInputEvidence) => void;
    resolve: (value: SessionInputEvidence | null) => void;
    reject: (error: unknown) => void;
}>;

/** Collect only this finite phase's cache misses; the existing reader owns reuse and retirement. */
async function readSessionInputPhase(ids: readonly string[], readTranscript: boolean, readSession: SessionInputReader,
    onFailure: (sessionId: string, error: unknown) => boolean,
    loadBatch: (requests: readonly SessionInputLoadRequest[], signal: AbortSignal) => Promise<void>,
    onValue: (id: string, value: SessionInputEvidence | null) => void,
    onProgress?: (id: string, value: SessionInputEvidence) => void,
    admitted?: ReadonlyMap<string, SessionInputEvidence | null>, demandKey?: SessionInputDemand, sourceReferenceKey?: string,
    demandSignal?: AbortSignal) {
    const requests: SessionInputLoadRequest[] = [];
    const values = new Map<string, SessionInputEvidence | null>();
    const pending: Promise<void>[] = [];
    for (const sessionId of ids) {
        values.set(sessionId, null);
        const accept = (value: SessionInputEvidence | null) => {
            values.set(sessionId, value);
            onValue(sessionId, value);
        };
        const read = readSession(sessionId, readTranscript,
        (assertCurrent, signal, retained, publish) => new Promise((resolve, reject) => {
            requests.push({ sessionId, assertCurrent, signal, retained, publish, resolve, reject });
        }), onProgress ? value => onProgress(sessionId, value) : undefined, admitted?.get(sessionId) ?? undefined, demandKey, sourceReferenceKey,
        demandSignal,
        );
        if (read instanceof Promise) pending.push(read.catch(error => {
            const settled = !demandSignal?.aborted && onFailure(sessionId, error);
            if (!settled && !(error instanceof SessionPartsHttpError) && readUsageHistoryFailure(error).retryable) throw error;
            return null;
        }).then(accept));
        else accept(read);
    }
    // One physical batch serves every collected Session read. It ends only when
    // each of those reads has lost all of its borrowers (or the Account retired).
    if (requests.length) {
        const batchAbort = new AbortController();
        let borrowed = requests.length;
        const leave = () => { if (--borrowed === 0) batchAbort.abort(); };
        for (const request of requests) {
            if (request.signal.aborted) leave();
            else request.signal.addEventListener('abort', leave, { once: true });
        }
        pending.push(loadBatch(requests, batchAbort.signal).catch(error => {
            for (const request of requests) request.reject(error);
        }).finally(() => { for (const request of requests) request.signal.removeEventListener('abort', leave); }));
    }
    if (pending.length) await Promise.all(pending);
    return values;
}

function canReuseSessionMessageEvidence(retained: SessionInputEvidence | undefined, admitted: SessionInputEvidence) {
    return retained?.completeMessageCoverage === true && retained.messageEvidence && retained.session.seq === admitted.session.seq
        && retained.session.encryptionMode === admitted.session.encryptionMode
        && retained.callerDataKeyEnvelope === admitted.callerDataKeyEnvelope;
}

function canReuseSessionContext(retained: SessionInputEvidence | undefined, admitted: SessionInputEvidence) {
    return retained && retained.sessionContextComplete !== false
        && retained.session.metadataVersion === admitted.session.metadataVersion
        && retained.session.agentStateVersion === admitted.session.agentStateVersion
        && retained.session.metadataLayoutVersion === admitted.session.metadataLayoutVersion;
}

class SessionEvidenceBatchReadError extends RetryableServerResponseError {
    readonly errorCode: string;

    constructor(httpStatus: number, errorCode: string) {
        super(httpStatus, 'Session input evidence unavailable');
        this.errorCode = errorCode;
    }
}

function sessionEvidenceBatchReadError(error: unknown): unknown {
    return error instanceof Error && 'httpStatus' in error && typeof error.httpStatus === 'number' && error.httpStatus >= 500
        ? new SessionEvidenceBatchReadError(error.httpStatus, readUsageHistoryFailure(error).errorCode) : error;
}

type SelectionInputs = Readonly<{ inputs: ReadonlyMap<string, { value: SessionInputEvidence } | { error: unknown }>;
    demand: ReturnType<typeof getUsageQuerySessionInputDemand>; isInputCurrent(sessionId: string): boolean }>;

/** One window rule for How-you-work and Coach (owner ruling 2026-11-06 12:52Z). */
function readsUnconvertedTranscriptsOnOpen(query: UsageQuery): boolean {
    const relative = query.period.relative;
    return relative !== '90days' && relative !== 'all';
}

/** Explicit history reads convert finalized, readable Sessions; live gaps stay unchecked. */
function canReadUnconvertedSessionHistory(value: SessionInputEvidence): boolean {
    return value.session.active !== true
        && value.session.access?.capabilities.readTranscript !== false
        && isSessionContentReadable(readSessionContentAvailability(value.session))
        && (!value.completeMessageCoverage || value.workFactsPersisted === false);
}

type UsageActivityAdmission = Readonly<{ subjects: readonly string[]; opened: OpenedUsageSessionSelection; asOfMs: number | undefined }>;
type OpenedHowYouWorkSnapshot = HowYouWorkReadSnapshot & Readonly<{ opened?: OpenedUsageSessionSelection }>;

async function readHowYouWorkEvidence(context: UsageQueryAccountContext, query: UsageQuery,
    accounting: readonly UsageAccountingSourceSnapshot[], readSession: SessionInputReader, readSelection: SessionInputSelectionReader,
    projectSelection: SessionInputSelectionProjector,
    readAccountCurrentnessSource: () => Promise<SessionAccountCurrentnessSource>,
    nowMs: number,
    signal?: AbortSignal,
    onProgress?: (snapshots: readonly OpenedHowYouWorkSnapshot[], sources: readonly UsageQuerySourceState[], settled: boolean) => void,
    history?: Readonly<{ readUnconverted?: boolean; coverage(selected: ReadonlySet<string>, notRead: number): void;
        converted(sessionId: string): void; succeeded(sessionId: string): void;
        failed(code: string, sessionId?: string, retryable?: boolean): void }>,
    previous?: UsageQueryResultSlice,
    origin?: string): Promise<OpenedHowYouWorkSnapshot[]> {
    const sessionInputs = accountStores.get(resolveUsageOwnerLifetime(context))!.sessionInputs;
    const queries = [query];
    const active = captureActiveServerAccountScopeLifetime();
    const byQuery = new Map(accounting.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value]));
    const idsByQuery = new Map(queries.filter(query => !usageQueryNeedsSessionCandidates(query)).map(query => [getUsageQueryKey(query), selectUsageQueryWorkEvidenceSessionIds({ query,
        sessions: [],
        contributions: byQuery.get(getUsageQueryKey(query))?.contributions,
        sessionMembership: readUsageAccountingSessionMembership(byQuery.get(getUsageQueryKey(query))) })]));
    const readProjected = async (query: UsageQuery, sessionIds: readonly string[] | undefined,
        phaseSignal = signal,
        consumeResult?: (row: UsageSessionEvidenceResponse['results'][number]) => Promise<void>,
        candidateSessionIds?: readonly string[], readWorkFacts = false): Promise<UsageSessionEvidenceResponse> => {
        const currentness = await readAccountCurrentnessSource();
        const input = UsageSessionEvidenceRequestSchema.parse({ nowMs, ...(readWorkFacts ? {
            readWorkFacts: true, workFactKinds: getUsageSessionFactKinds(query),
        } : {}), requests: [{ query, ...(sessionIds ? { sessionIds } : {}),
            ...(candidateSessionIds ? { candidateSessionIds } : {}) }] });
        const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
            body: JSON.stringify(input), signal: phaseSignal };
        const observeAdmission = sessionInputs.beginDetailAdmission(origin);
        const consume = async (response: Response) => {
            requireCurrent(context, phaseSignal);
            currentness.assertCurrent();
            if (!response.ok) {
                const payload: unknown = await response.json().catch(() => null);
                const requirement = OperationUpdateRequiredV1Schema.safeParse(payload);
                throw new SessionPartsHttpError(response.status, payload, requirement.success ? requirement.data
                    : response.status === 404 ? { kind: 'update_required', operation: 'usage.query', component: 'server',
                        reason: 'usage_session_evidence_unsupported' } : undefined);
            }
            let body: UsageSessionEvidenceResponse = { requests: [], results: [] };
            let expected: Set<string> | undefined;
            const admitSelection = (requests: UsageSessionEvidenceResponse['requests']) => {
                const selection = requests[0];
                const ids = new Set(selection?.sessionIds);
                if (requests.length !== 1 || !selection || getUsageQueryKey(selection.query) !== getUsageQueryKey(input.requests[0]!.query)
                    || ids.size !== selection.sessionIds.length
                    || sessionIds && (sessionIds.length !== selection.sessionIds.length || sessionIds.some(id => !ids.has(id)))) {
                    throw new SessionPartsInvalidResponseError();
                }
                body.requests = requests;
                expected = ids;
            };
            const admitRow = (row: UsageSessionEvidenceResponse['results'][number]) => {
                if (!expected?.delete(row.sessionId) || !row.detail && !row.workFacts
                    || row.workFacts && row.workFacts.session.id !== row.sessionId
                    || row.detail?.status === 200 && (row.detail.body.session.id !== row.sessionId || !row.turns)
                    || row.turns?.status === 200 && row.turns.body.sessionId !== row.sessionId) throw new SessionPartsInvalidResponseError();
                if (row.detail?.status === 403 || row.detail?.status === 404) {
                    observeAdmission(row.sessionId, new SessionPartsHttpError(row.detail.status, row.detail.body));
                } else if (row.detail?.status === 200 || row.workFacts) observeAdmission(row.sessionId, true);
            };
            if (response.headers.get('content-type')?.includes('application/x-ndjson')) {
                const pending: UsageSessionEvidenceResponse['results'] = [];
                const decoder = createUsageSessionEvidenceStreamDecoder({
                    onRequests: admitSelection,
                    onResult: result => { admitRow(result); (consumeResult ? pending : body.results).push(result); },
                });
                const write = (text: string) => {
                    try { decoder.write(text); } catch { throw new SessionPartsInvalidResponseError(); }
                };
                const consumePending = async () => {
                    for (const row of pending) await consumeResult!(row);
                    pending.length = 0;
                };
                const consumeChunk = async (text: string) => {
                    // A later invalid record can share a network chunk with
                    // already-admitted rows. Save those subjects before failing
                    // the unfinished remainder of this physical stream.
                    try { write(text); }
                    catch (error) { await consumePending(); throw error; }
                    await consumePending();
                };
                const reader = typeof response.body?.getReader === 'function' ? response.body.getReader() : undefined;
                if (!reader) await consumeChunk(await response.text());
                else {
                    const text = new TextDecoder();
                    const startedAt = Date.now();
                    let receivedBytes = 0;
                    let reachedEof = false;
                    let failure: ReturnType<typeof readUsageHistoryFailure> | undefined;
                    try {
                        while (true) {
                            const chunk = await reader.read();
                            receivedBytes += chunk.value?.byteLength ?? 0;
                            reachedEof = chunk.done;
                            requireCurrent(context, phaseSignal);
                            await consumeChunk(text.decode(chunk.value, { stream: !chunk.done }));
                            if (chunk.done) break;
                        }
                    } catch (error) {
                        failure = readUsageHistoryFailure(error);
                        throw error;
                    } finally {
                        // This is the domain reader's own cancel boundary, including
                        // transports that do not enter withServerReadLifetime.
                        console.info('[usageHistory] evidence termination', { source: 'reader-finally', startedAt,
                            receivedBytes, reachedEof, upstreamAborted: phaseSignal?.aborted === true,
                            accountCurrent: context.accountLifetime.isCurrent(), capturedTransport: !!context.readTransport,
                            ...(failure ? { failure } : {}) });
                        if (!reachedEof) await reader.cancel().catch(() => {});
                        reader.releaseLock();
                    }
                }
                try { decoder.finish(); } catch { throw new SessionPartsInvalidResponseError(); }
                await consumePending();
            } else {
                const payload: unknown = await response.json().catch(() => null);
                const parsed = UsageSessionEvidenceResponseSchema.safeParse(payload);
                if (!parsed.success) throw new SessionPartsInvalidResponseError();
                admitSelection(parsed.data.requests);
                for (const row of parsed.data.results) {
                    admitRow(row);
                    if (consumeResult) await consumeResult(row);
                    else body.results.push(row);
                }
            }
            if (!expected || expected.size) throw new SessionPartsInvalidResponseError();
            requireCurrent(context, phaseSignal);
            currentness.assertCurrent();
            return body;
        };
        // The Resource already captured this Home authority at admission.
        // Projected phases borrow its transport and finite identity source.
        return context.readTransport ? await context.readTransport.read(USAGE_SESSION_EVIDENCE_PATH, init, undefined, consume)
            : await consume(await context.request(USAGE_SESSION_EVIDENCE_PATH, init));
    };
    const readSummary = async (query: UsageQuery, sessionIds: readonly string[] | undefined, ownerSignal?: AbortSignal,
        candidateSessionIds?: readonly string[]) => {
        const [{ captureServerRequestAuthorityForServerAccountScope }, { readSessionSnapshotsForAuthority },
            { readSessionDetailAccessProjectionVersion }, accountCurrentnessSource] = await Promise.all([
            import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope'),
            import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority'),
            import('@/sync/api/session/sessionDetailAccessProjection'), readAccountCurrentnessSource(),
        ]);
        const inputs = new Map<string, { value: SessionInputEvidence } | { error: unknown }>();
        const summaryIds: string[] = [];
        let authority: Awaited<ReturnType<typeof captureServerRequestAuthorityForServerAccountScope>> | undefined;
        try {
            const openRow = async (row: UsageSessionEvidenceResponse['results'][number]) => {
                // An empty discovered cohort has no Session content to open.
                // Capture the finite opening authority once, only for actual rows.
                authority ??= await captureServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope,
                    activeRequest: context.request, signal: ownerSignal });
                if (row.workFacts) {
                    try {
                        const value = await openUsageCompactInput({ context, opening: authority.context, row,
                            recordKinds: getUsageSessionFactKinds(query),
                            isCurrent: () => context.accountLifetime.isCurrent() && accountCurrentnessSource.isCurrent(),
                            readAccountCurrentness: accountCurrentnessSource.read });
                        if (value) inputs.set(row.sessionId, { value });
                        else summaryIds.push(row.sessionId);
                    } catch (error) { inputs.set(row.sessionId, { error }); }
                    return;
                }
                const snapshots = await readSessionSnapshotsForAuthority({ authority, sessionIds: [row.sessionId],
                    prefetched: new Map([[row.sessionId, { detail: row.detail!, turns: row.turns,
                        accessProjectionVersion: readSessionDetailAccessProjectionVersion(authority.scope.serverId) }]]),
                    requireTurns: true, includeMetadataTupleMutationSnapshot: false,
                    accountCurrentnessSource, isCurrent: context.accountLifetime.isCurrent, signal: ownerSignal });
                const result = snapshots.get(row.sessionId)!;
                if (!result.ok) { inputs.set(row.sessionId, { error: result.error }); return; }
                try {
                    const session = projectUsageSessionInput(result.snapshot.session.encryptionMode === 'plain'
                        ? { ...result.snapshot.session, stateEvidence: row.stateEvidence } : result.snapshot.session);
                    inputs.set(row.sessionId, { value: { session, callerDataKeyEnvelope: result.snapshot.callerDataKeyEnvelope,
                        detail: projectSessionUsageWorkEvidence(session), completeMessageCoverage: false } });
                } catch (error) { inputs.set(row.sessionId, { error }); }
            };
            const body = await readProjected(query, sessionIds, ownerSignal, openRow, candidateSessionIds, true);
            // Only the client can establish encrypted fact currentness. Reuse the
            // ordinary summary projection for stale or malformed saved records.
            if (summaryIds.length) await readProjected(query, summaryIds, ownerSignal, openRow);
            return { body, inputs };
        } finally { await authority?.release(); }
    };
    const discovered = new Map<string, SelectionInputs>();
    for (const query of queries) {
        const key = getUsageQueryKey(query);
        if (idsByQuery.has(key)) continue;
        try {
            const summaryQuery = normalizeUsageQuery({ ...query, includeTranscriptEvidence: false });
            const demand = getUsageQuerySessionInputDemand(summaryQuery, nowMs);
            const selection = await readSelection(demand.key, async (isInputCurrent, ownerSignal, candidates) => {
                const summary = await readSummary(summaryQuery, undefined, ownerSignal, candidates);
                return { ids: summary.body.requests[0]!.sessionIds, rows: { inputs: summary.inputs, demand, isInputCurrent } satisfies SelectionInputs };
            }, signal);
            // Every borrower of one selection read shares the rows it opened, not only
            // the batch that started it (that batch may have left before it settled).
            // This loader is the only writer of rows for Usage evidence demand keys.
            if (selection.rows) discovered.set(key, selection.rows as SelectionInputs);
            const discoveredIds = selection.ids;
            const selectedIds = selectUsageQueryWorkEvidenceSessionIds({ query,
                sessions: discoveredIds.map(id => ({ id })),
                contributions: byQuery.get(key)?.contributions,
                sessionMembership: readUsageAccountingSessionMembership(byQuery.get(key)) });
            idsByQuery.set(key, selectedIds);
        } catch (error) {
            if (!(error instanceof SessionPartsHttpError)) throw error;
            const errorCode = error.updateRequired ? 'update_required' : 'usage_session_evidence_read_failed';
            if (previous && error.httpStatus >= 500 && !error.updateRequired) {
                throw new SessionEvidenceBatchReadError(error.httpStatus, errorCode);
            }
            history?.failed(errorCode);
            const snapshot = { query, asOfMs: nowMs,
                errorCode, ...(error.updateRequired ? { updateRequired: error.updateRequired } : {}) };
            onProgress?.([snapshot], [{ source: 'how_you_work:sessions', status: 'error', errorCode,
                ...(error.updateRequired ? { updateRequired: error.updateRequired } : {}) },
            { source: 'how_you_work:transcripts', status: query.includeTranscriptEvidence ? 'error' : 'not_loaded' }], true);
            return [snapshot];
        }
    }
    const selectedIdSet = new Set([...idsByQuery.values()].flat());
    const selectedIds = [...selectedIdSet];
    const summaryQuery = normalizeUsageQuery({ ...query, includeTranscriptEvidence: false });
    // The input owner already keys each entry by Session and transcript phase.
    // The remaining demand is identical for the entire selected range.
    const summaryDemandKey = getUsageQuerySessionInputDemand(summaryQuery, nowMs);
    // Widget output flags do not override the shared window/history read policy.
    const transcriptQuery = normalizeUsageQuery({ ...query, includeTranscriptEvidence: true });
    // One transcript conversion produces both work and Coach records, regardless of saved-fact read scope.
    const transcriptDemandKey = getUsageQuerySessionInputDemand({ ...transcriptQuery, includeCoach: true }, nowMs);
    const readTranscript = history?.readUnconverted || readsUnconvertedTranscriptsOnOpen(query);
    let updateRequired: UsageQuerySourceState['updateRequired'];
    let projectedReadFailure: SessionPartsHttpError | undefined;
    let sessionReadFailure: ReturnType<typeof readUsageHistoryFailure> | undefined;
    const recordReadFailure = (sessionId: string, error: unknown) => {
        const failure = readUsageHistoryFailure(error);
        if (!sessionReadFailure || failure.retryable) sessionReadFailure = failure;
        history?.failed(failure.errorCode, error instanceof SessionEvidenceBatchReadError ? undefined : sessionId, failure.retryable);
        if ((typeof __DEV__ !== 'undefined' && __DEV__)
            || ['1', 'true'].includes(String(process.env.EXPO_PUBLIC_DEBUG ?? '').trim().toLowerCase())) {
            // The diagnostic contains typed failure facts only, never Session identity or content.
            console.info('[usageHistory] Session evidence failure', failure);
        }
        if (error instanceof SessionPartsHttpError) updateRequired ??= error.updateRequired;
        return failure;
    };
    const recordPhaseReadFailure = (sessionId: string, error: unknown) => {
        const failure = recordReadFailure(sessionId, error);
        // Session inputs are shared across output queries. Only this exact
        // aggregate can retain its complete admitted population on replacement.
        if (previous && error instanceof SessionPartsHttpError && failure.retryable && error.httpStatus >= 500) {
            throw new RetryableServerResponseError(error.httpStatus, 'Session input replacement unavailable');
        }
        return false;
    };
    const loadTranscript = async (sessionId: string, assertCurrent: () => void, signal: AbortSignal,
        retained: SessionInputEvidence | undefined, publish: (value: SessionInputEvidence) => void,
        admitted: SessionInputEvidence,
        readMessagePage: () => Promise<UsageSessionEvidenceResponse['results'][number] | undefined>): Promise<SessionInputEvidence | null> => {
        try {
            const [{ runWithServerRequestAuthorityForServerAccountScope }, { fetchSessionMessagesPage }, { readStoredSessionMessage }, accountCurrentnessSource] = await Promise.all([
                import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope'),
                import('@happier-dev/sync-client'), import('@/sync/runtime/readStoredSessionContent'),
                readAccountCurrentnessSource(),
            ]);
            return await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
                assertCurrent();
                requireCurrent(context, signal);
                let { session, callerDataKeyEnvelope } = admitted;
                let sessionContextComplete = admitted.sessionContextComplete !== false;
                requireCurrent(context, signal);
                // Admitted interval facts remain available while private pages read.
                const summary = admitted;
                publish(summary);
                let messageEvidence: UsageSessionMessageEvidence | undefined;
                let detail = summary.detail;
                let completeMessageCoverage = false;
                if (session.access?.capabilities.readTranscript !== false && isSessionContentReadable(readSessionContentAvailability(session))) {
                    const projected = await readMessagePage();
                    if (projected?.detail?.status === 200) {
                        const [{ readSessionSnapshotsForAuthority }, { readSessionDetailAccessProjectionVersion }] = await Promise.all([
                            import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority'),
                            import('@/sync/api/session/sessionDetailAccessProjection'),
                        ]);
                        const snapshots = await readSessionSnapshotsForAuthority({ authority, sessionIds: [sessionId],
                            prefetched: new Map([[sessionId, { detail: projected.detail, turns: projected.turns,
                                accessProjectionVersion: readSessionDetailAccessProjectionVersion(authority.scope.serverId) }]]),
                            requireTurns: true, includeMetadataTupleMutationSnapshot: false,
                            accountCurrentnessSource, isCurrent: context.accountLifetime.isCurrent, signal });
                        const opened = snapshots.get(sessionId);
                        if (!opened?.ok) throw opened?.error ?? new SessionPartsInvalidResponseError();
                        session = projectUsageSessionInput(opened.snapshot.session.encryptionMode === 'plain'
                            ? { ...opened.snapshot.session, stateEvidence: projected.stateEvidence } : opened.snapshot.session);
                        callerDataKeyEnvelope = opened.snapshot.callerDataKeyEnvelope;
                        sessionContextComplete = true;
                    }
                    if (projected?.detail && projected.detail.status !== 200) {
                        const requirement = OperationUpdateRequiredV1Schema.safeParse(projected.detail.body);
                        throw new SessionPartsHttpError(projected.detail.status, projected.detail.body, requirement.success ? requirement.data : undefined);
                    }
                  if (canReuseSessionMessageEvidence(retained, admitted)) {
                    if (!sessionContextComplete && canReuseSessionContext(retained, admitted)) {
                        const { metadata, ownerMetadata, agentTarget, origin, manager, agentState, stateEvidence } = retained!.session;
                        session = { ...session, metadata, ownerMetadata, agentTarget, origin, manager, agentState, stateEvidence };
                        sessionContextComplete = true;
                    }
                    messageEvidence = retained!.messageEvidence;
                    completeMessageCoverage = retained!.completeMessageCoverage;
                    detail = projectSessionUsageWorkEvidence(session, undefined, { messagesComplete: completeMessageCoverage, messageEvidence });
                  } else {
                    if (session.encryptionMode === 'plain' && projected?.messageEvidence !== undefined) {
                        messageEvidence = projected.messageEvidence;
                        completeMessageCoverage = projected.messagesComplete === true;
                        detail = projectSessionUsageWorkEvidence(session, undefined, { messageEvidence, messagesComplete: completeMessageCoverage });
                    } else if (projected?.messages && (session.encryptionMode === 'e2ee' || projected.messages.status !== 200)) {
                    let page: Awaited<ReturnType<typeof fetchSessionMessagesPage>> | null = null;
                    try {
                        page = await fetchSessionMessagesPage({ sessionId, scope: 'all', roles: ['user', 'agent', 'event'], signal,
                            requestJson: async (_path, pageSignal) => {
                                requireCurrent(context, pageSignal);
                                const response = projected?.messages;
                                if (!response || response.status !== 200) {
                                    if (response && 'kind' in response.body && response.body.kind === 'update_required') {
                                        throw new SessionPartsHttpError(response.status, response.body, response.body);
                                    }
                                    if (response && response.status >= 500) throw new RetryableServerResponseError(response.status, 'Session input evidence unavailable');
                                    if (response) throw new SessionPartsHttpError(response.status, response.body);
                                    throw new Error('Session input evidence unavailable');
                                }
                                requireCurrent(context, pageSignal);
                                return response.body;
                            } });
                    } catch (error) {
                        requireCurrent(context, signal);
                        // Only an ordinary transport failure can retain the
                        // freshly admitted Session facts. Access/format failures
                        // quarantine them; no previously loaded content is revived.
                        if (!isTransientConnectivityError(error)) throw error;
                        recordReadFailure(sessionId, error);
                    }
                    if (page !== null && session.encryptionMode === 'e2ee') {
                        // Summary admission and transcript demand can use different
                        // scoped Account owners. Hydrate this operation's reader
                        // from the admitted envelope, without reacquiring the Session.
                        const encryption = await (await import('@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey'))
                            .resolveScopedSessionEncryption({ context: authority.context, sessionId, admittedSession: {
                                id: session.id, encryptionMode: 'e2ee', dataEncryptionKey: callerDataKeyEnvelope,
                                viewerRole: session.access?.role ?? 'recipient',
                                isCurrent: () => { assertCurrent(); return accountCurrentnessSource.isCurrent(); },
                            }, readAccountCurrentness: accountCurrentnessSource.read });
                        let allPagesOpened = true;
                        let beforeSeq: number | undefined;
                        let projector: ReturnType<typeof createSessionUsageWorkEvidenceProjector> | undefined;
                        while (true) {
                            const decryptedMessages = encryption ? await encryption.decryptMessages(page.messages, { signal }) : null;
                            const messages = await Promise.all(page.messages.map((message, index) => readStoredSessionMessage({ message,
                                sessionEncryptionMode: 'e2ee',
                                ...(encryption ? { decryptMessage: async () => decryptedMessages?.[index] ?? null } : {}),
                            })));
                            const readableMessages = messages.filter((message): message is NonNullable<typeof message> => message !== null && message.content !== null);
                            allPagesOpened &&= readableMessages.length === page.messages.length;
                            completeMessageCoverage = page.hasMore === false && allPagesOpened;
                            // Fold only small witnesses across pages. Decrypted
                            // prose/tool bodies do not become the accumulated input.
                            if (page.messages.length === 0 || readableMessages.length > 0) {
                                projector ??= createSessionUsageWorkEvidenceProjector(session);
                                projector.appendPage(readableMessages);
                            }
                            if (page.hasMore !== true) break;
                            const nextBeforeSeq = page.nextBeforeSeq;
                            if (nextBeforeSeq == null || page.messages.length === 0
                                || beforeSeq !== undefined && nextBeforeSeq >= beforeSeq) throw new SessionPartsInvalidResponseError();
                            beforeSeq = nextBeforeSeq;
                            page = await fetchSessionMessagesPage({ sessionId, scope: 'all', roles: ['user', 'agent', 'event'], beforeSeq, signal,
                                requestJson: async (path, pageSignal) => {
                                    requireCurrent(context, pageSignal);
                                    const response = await authority.request(path, { signal: pageSignal });
                                    const body: unknown = await response.json();
                                    if (!response.ok) {
                                        const requirement = OperationUpdateRequiredV1Schema.safeParse(body);
                                        throw new SessionPartsHttpError(response.status, body, requirement.success ? requirement.data : undefined);
                                    }
                                    return body;
                                } });
                        }
                        if (projector) {
                            detail = projector.finish(completeMessageCoverage);
                            messageEvidence = { acceptedInputs: detail.acceptedInputs, phaseEvents: detail.phaseEvents, coach: detail.coach,
                                collaboration: detail.collaboration };
                        }
                    }
                    }
                  }
                }
                await accountCurrentnessSource.ensureCurrent();
                requireCurrent(context, signal);
                assertCurrent();
                const value = { session, callerDataKeyEnvelope, detail, messageEvidence, completeMessageCoverage, sessionContextComplete };
                if (!completeMessageCoverage) return value;
                try {
                    const workFactsPersisted = await persistUsageCompactInput({ context, opening: authority.context, value, signal,
                        isCurrent: () => context.accountLifetime.isCurrent() && accountCurrentnessSource.isCurrent(),
                        readAccountCurrentness: accountCurrentnessSource.read });
                    if (workFactsPersisted) history?.converted(sessionId);
                    return { ...value, workFactsPersisted };
                } catch (error) {
                    requireCurrent(context, signal);
                    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                        ? error.code : 'usage_work_facts_write_failed';
                    recordReadFailure(sessionId, error);
                    return { ...value, workFactsPersisted: false, workFactsWriteErrorCode: code };
                }
            });
        } catch (error) {
            requireCurrent(context, signal);
            assertCurrent();
            throw error;
        }
    };
    const evidencePhase = new UsageQueryEvidencePhase(selectedIds.length, query.includeTranscriptEvidence);
    const selected = evidencePhase.selected;
    const project = (admitted: boolean): (HowYouWorkEvidenceSnapshot & { opened: OpenedUsageSessionSelection })[] => queries.map(query => {
        // Loaded Sessions supply demand, never an access/content fallback after
        // a fresh exact-Account admission fails or denies transcript access.
        const { sessions, detail, opened } = projectSelection({ query, nowMs, admitted, selected,
            selectedIds: idsByQuery.get(getUsageQueryKey(query)) ?? [], scope: context.accountLifetime.scope,
            currentScope: query.session === null ? active?.scope ?? null : context.accountLifetime.scope,
            isCurrent: context.accountLifetime.isCurrent() && (query.session !== null || active?.isCurrent() === true),
            contributions: byQuery.get(getUsageQueryKey(query))?.contributions,
            sessionMembership: readUsageAccountingSessionMembership(byQuery.get(getUsageQueryKey(query))) });
        // The projection admits only readable Sessions and marks their observed
        // subset partial. A failed sibling must not erase those witnessed facts;
        // sessionCoverage and the source status keep the missing population explicit.
        const sessionCoverage = { selected: (idsByQuery.get(getUsageQueryKey(query)) ?? []).length,
            admitted: sessions.filter(session => session.access?.capabilities.readTranscript !== false
                && isSessionContentReadable(readSessionContentAvailability(session))).length,
            notRead: sessions.filter(session => {
                const value = selected.get(session.id);
                return value && (!value.completeMessageCoverage || value.workFactsPersisted === false);
            }).length };
        history?.coverage(selectedIdSet,
            [...selected.values()].filter(value => value && canReadUnconvertedSessionHistory(value)).length);
        return { query, asOfMs: Date.now(), sessions, sessionCoverage, detail, opened,
            ...(updateRequired ? { errorCode: 'update_required', updateRequired }
                : projectedReadFailure ? { errorCode: 'usage_session_evidence_read_failed' } : {}) };
    });
    const publish = () => {
        if (signal?.aborted || !context.accountLifetime.isCurrent()) return;
        // Publish the admitted interval phase before held transcript I/O, then
        // the completed input phase. Individual unfinished Session completions
        // do not change those phases: projecting and serializing the complete
        // Account for each one makes a cold pass quadratic. A refusal still
        // withdraws private facts immediately, independently of completion.
        const phase = evidencePhase.read();
        if (!phase) return;
        const { admitted, refused, sources } = phase;
        // Summary output settles at admission while this finite read continues conversion.
        const sessionReadErrorCode = sessionReadFailure?.errorCode;
        onProgress?.(admitted || refused ? project(admitted) : [], sessionReadErrorCode ? sources.map(source => source.status === 'partial'
            ? { ...source, errorCode: sessionReadErrorCode } : source) : sources, admitted && !query.includeTranscriptEvidence);
    };
    publish();
    const onValue = (sessionId: string, value: SessionInputEvidence | null, complete: boolean) => {
        requireCurrent(context, signal);
        // A null completion already reported its failure through recordReadFailure.
        if (value) {
            if (value.session.access?.capabilities.readTranscript === false) recordReadFailure(sessionId, { errorCode: 'forbidden' });
            else if (!isSessionContentReadable(readSessionContentAvailability(value.session))) {
                const availability = readSessionContentAvailability(value.session);
                if (availability !== null) recordReadFailure(sessionId, { errorCode: availability });
            }
            else if (complete && value.completeMessageCoverage && value.workFactsPersisted !== false) history?.succeeded(sessionId);
        }
        const changed = evidencePhase.select(sessionId, value, complete);
        // Cached progress already supplied these exact facts. Only the last
        // completion changes the aggregate's pending state; reprojecting every
        // identical completion turns one refresh into N full-corpus passes.
        if (changed || evidencePhase.complete) publish();
    };
    const needsTranscript = (value: SessionInputEvidence | null | undefined) => readTranscript && value && !value.completeMessageCoverage
        && (history?.readUnconverted !== true || canReadUnconvertedSessionHistory(value));
    const summaries = await readSessionInputPhase(selectedIds, false, readSession, recordPhaseReadFailure, async (requests, ownerSignal) => {
        try {
            const discovery = discovered.get(getUsageQueryKey(query));
            const inputs = new Map(discovery && usageSessionInputDemandCovers(discovery.demand, summaryDemandKey)
                ? [...discovery.inputs].filter(([id]) => discovery.isInputCurrent(id)) : []);
            // Accounting can witness historical Sessions absent from current discovery.
            // Hydrate them only when their existing private input needs admission.
            const missingIds = requests.map(request => request.sessionId).filter(id => !inputs.has(id));
            if (missingIds.length) {
                try {
                    const acquired = await readSummary(summaryQuery, missingIds, ownerSignal);
                    for (const [id, result] of acquired.inputs) inputs.set(id, result);
                }
                catch (error) {
                    if (error instanceof SessionPartsHttpError) projectedReadFailure = error;
                    throw error;
                }
            }
            for (const request of requests) {
                try {
                    request.assertCurrent();
                    const result = inputs.get(request.sessionId);
                    if (result && 'error' in result) {
                        request.reject(result.error);
                        continue;
                    }
                    if (result && 'value' in result) request.resolve(result.value);
                    else request.reject(new SessionPartsInvalidResponseError());
                } catch (error) { request.reject(error); }
            }
        } catch (error) {
            requireCurrent(context, ownerSignal);
            const failure = sessionEvidenceBatchReadError(error);
            for (const request of requests) request.reject(failure);
        }
    }, (id, value) => onValue(id, value, !needsTranscript(value)), undefined, undefined, summaryDemandKey, getUsageQueryKey(query), signal);
    // Private facts follow the same Usage window and admitted population.
    // Held private evidence never holds interval publication.
    if (readTranscript) await readSessionInputPhase(selectedIds.filter(id => needsTranscript(summaries.get(id))), true, readSession, recordPhaseReadFailure, async (requests, ownerSignal) => {
        const messageIds = requests.filter(request => {
                const admitted = summaries.get(request.sessionId)!;
                return admitted.session.access?.capabilities.readTranscript !== false
                    && isSessionContentReadable(readSessionContentAvailability(admitted.session))
                    && !canReuseSessionMessageEvidence(request.retained, admitted);
        }).map(request => request.sessionId);
        const contextIds = requests.filter(request => {
            const admitted = summaries.get(request.sessionId)!;
            return canReuseSessionMessageEvidence(request.retained, admitted)
                && admitted.sessionContextComplete === false && !canReuseSessionContext(request.retained, admitted);
        }).map(request => request.sessionId);
        const byId = new Map(requests.map(request => [request.sessionId, request]));
        const completed = new Map<string, { value: SessionInputEvidence | null } | { error: unknown }>();
        const open = async (request: SessionInputLoadRequest, row?: UsageSessionEvidenceResponse['results'][number]) => {
            try {
                completed.set(request.sessionId, { value: await loadTranscript(request.sessionId, request.assertCurrent,
                    request.signal, request.retained, request.publish, summaries.get(request.sessionId)!, async () => row) });
            } catch (error) { completed.set(request.sessionId, { error }); }
        };
        try {
            // Each opaque row is opened and projected before reading the next
            // chunk. Only its facts survive, and each Session settles independently
            // if the remaining stream fails.
            if (messageIds.length) await readProjected(transcriptQuery, messageIds, ownerSignal, async row => {
                await open(byId.get(row.sessionId)!, row);
            });
            if (contextIds.length) await readProjected(summaryQuery, contextIds, ownerSignal, async row => {
                await open(byId.get(row.sessionId)!, row);
            });
            await Promise.all(requests.filter(request => !completed.has(request.sessionId)).map(request => open(request)));
            for (const request of requests) {
                const result = completed.get(request.sessionId)!;
                if ('error' in result) request.reject(result.error);
                else request.resolve(result.value);
            }
        } catch (error) {
            requireCurrent(context, ownerSignal);
            for (const request of requests) {
                // Each opened row already crossed its Session boundary. A later
                // stream failure cannot discard facts that were converted and saved.
                const result = completed.get(request.sessionId);
                if (result && 'value' in result) request.resolve(result.value);
                else {
                    const failure = result && 'error' in result ? result.error : sessionEvidenceBatchReadError(error);
                    request.reject(readUsageHistoryFailure(failure).retryable
                        ? sessionInputs.detailRefusal(request.sessionId) ?? failure : failure);
                }
            }
        }
    }, (id, value) => onValue(id, value, true), (id, value) => { evidencePhase.select(id, value); publish(); }, summaries, transcriptDemandKey, getUsageQueryKey(query), signal);
    requireCurrent(context, signal);
    return project(true);
}

type SessionWorkSourceResult = import('@happier-dev/protocol/usage/usageWorkSources').SessionWorkSourceResult;

/** Each batch keeps its Session admission. A failed route stops later batches in this read. */
function createUsageWorkMachineReader(context: UsageQueryAccountContext, signal?: AbortSignal) {
    const routes = new Map<string, { initial?: Promise<void>; failure?: unknown }>();
    const scope = context.accountLifetime.scope;
    return async (machineId: string, request: Parameters<typeof machineScmWorkEvidenceRead>[1]) => {
        const incumbent = routes.get(machineId);
        if (incumbent) {
            // Once the first read succeeds, later selectors remain independent.
            await incumbent.initial;
            requireCurrent(context, signal);
            if (incumbent.failure !== undefined) throw incumbent.failure;
        }
        const route = incumbent ?? {};
        const reading = machineScmWorkEvidenceRead(machineId, request, {
            ...scope,
            signal,
            exactHomeMachineAdmission: incumbent ? undefined : {
                credentials: context.credentials,
                readRow: async setupSignal => {
                    const rows = await readMachineRows({
                        readTransport: context.readTransport, request: context.request, machineIds: [machineId], signal: setupSignal,
                    });
                    requireCurrent(context, setupSignal);
                    return rows.get(machineId);
                },
                onRejected: error => { route.failure = error; },
            },
        });
        const verdict = reading.then(() => {}, (error: unknown) => {
            // An unsent deadline exhausted route setup. A reply deadline or
            // Session-specific refusal says nothing about the next selector.
            if (isMachineRequestReachabilityFailureV1(error)
                || (isMachineRpcTimeoutError(error) && readRpcRequestDisposition(error) === 'notSent')) {
                route.failure ??= error;
            }
        });
        if (!incumbent) {
            route.initial = verdict;
            routes.set(machineId, route);
        }
        return reading;
    };
}

type UsageWorkTurns = ReturnType<typeof readUsageWorkSessionTurns>;

type UsageWorkSessionTarget = ReturnType<typeof resolveUsageWorkSessionTarget> & Readonly<{
    metadataVersion?: number;
    observedMetadataVersion?: number;
}>;
type UsageWorkSessionTargets = ReadonlyMap<string, UsageWorkSessionTarget>;
function readUsageWorkWitnessSessions(source: UsageWorkSourceSnapshot): Set<string> {
    const sessions = new Set(source.pullRequestReadSessions);
    for (const witness of source.evidence ?? []) sessions.add(witness.sessionId);
    for (const witness of source.branchEvidence ?? []) sessions.add(witness.sessionId);
    return sessions;
}

type UsageWorkMachineInput = Readonly<{
    queryKey: string; sessionIds: readonly string[]; targets: UsageWorkSessionTargets; targetKey: string; machineKey: string;
    turns?: UsageWorkTurns;
    source?: UsageWorkSourceSnapshot;
    basis?: Readonly<{ startMs?: number; fixedEndMs?: number; accountModeRevision: number; sessionEvidence: object }>;
}>;

function withdrawRetainedWorkAdmission(slice: UsageQueryResultSlice, input: UsageWorkMachineInput, refused: ReadonlySet<string>) {
    const replacement = withdrawUsageQueryWork(slice, input, refused);
    // Keep the stripped Work for display. Only this entry's read can witness
    // the admitted turns for reuse.
    return { slice: replacement.slice, workInput: replacement.slice === slice ? input
        : { ...input, turns: undefined, source: replacement.source } };
}

/** Local revisions can invalidate a Home answer. They never supply a Work target. */
function readObservedWorkMetadataVersion(scope: UsageQueryAccountContext['accountLifetime']['scope'], sessionId: string) {
    const state = readRegisteredStorageState();
    if (!state || !areServerAccountScopesEqual(state.profileScope, scope)) return undefined;
    const session = state.sessions[sessionId];
    if (session && areServerProfileIdentifiersEquivalent(session.serverId, scope.serverId)) return session.metadataVersion;
    return readSessionListRowForServerId(state.sessionListRowsByServerId, scope.serverId, sessionId)?.metadataVersion;
}

function readWorkTargetMachineIds(targets: UsageWorkSessionTargets) {
    return [...new Set([...targets.values()].flatMap(target => 'machineId' in target ? [target.machineId] : []))];
}

function createUsageWorkTargetReader(context: UsageQueryAccountContext, signal?: AbortSignal) {
    const scope = context.accountLifetime.scope;
    const resolved = new Map<string, Promise<UsageWorkSessionTarget>>();
    const failureTarget = (error: unknown) => {
        requireCurrent(context, signal);
        const { errorCode, httpStatus } = readUsageHistoryFailure(error);
        return { errorCode, httpStatus,
            ...(error instanceof SessionPartsHttpError && error.updateRequired ? { updateRequired: error.updateRequired } : {}) };
    };
    return async (sessionIds: readonly string[]): Promise<UsageWorkSessionTargets> => {
        const missing = sessionIds.filter(id => !resolved.has(id));
        if (missing.length) {
            const batch = (async () => {
                const { captureServerRequestAuthorityForServerAccountScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope');
                const authority = await captureServerRequestAuthorityForServerAccountScope({ scope, activeRequest: context.request, signal });
                try {
                    return await readSessionSnapshotsForAuthority({
                        authority, sessionIds: missing, includeTurns: false, includeMetadataTupleMutationSnapshot: false,
                        signal, isCurrent: context.accountLifetime.isCurrent,
                    });
                } finally { await authority.release(); }
            })();
            for (const id of missing) {
                const observedMetadataVersion = readObservedWorkMetadataVersion(scope, id);
                resolved.set(id, batch.then(rows => {
                    const row = rows.get(id)!;
                    if (!row.ok) return { ...failureTarget(row.error), observedMetadataVersion };
                    const { session } = row.snapshot;
                    return { metadataVersion: session.metadataVersion, observedMetadataVersion,
                        ...resolveUsageWorkSessionTarget(readSessionOwnerMetadataView(session)) };
                }, error => ({ ...failureTarget(error), observedMetadataVersion })));
            }
        }
        const targets = await Promise.all(sessionIds.map(async id => [id, await resolved.get(id)!] as const));
        requireCurrent(context, signal);
        return new Map(targets);
    };
}

/** A failed replacement can only subtract from the Activity admission it retained. */
function readRetainedActivityAfterRefusal(context: UsageQueryAccountContext, slice: UsageQueryResultSlice,
    admission: UsageActivityAdmission, sessionInputs: ReturnType<typeof createUsageQuerySessionInputs>) {
    const { subjects, opened, asOfMs } = admission;
    const refusal = subjects.map(id => sessionInputs.detailRefusal(id)).find(error => error !== undefined);
    if (!refusal) return undefined;
    const errorCode = readUsageHistoryFailure(refusal).errorCode;
    const query = slice.requestedQuery;
    const phase = new UsageQueryEvidencePhase(subjects.length, query.includeTranscriptEvidence);
    for (const id of subjects) phase.select(id, sessionInputs.detailRefusal(id) ? null : opened.selected.get(id) ?? null, true);
    const { sessions, detail, opened: remaining } = sessionInputs.projectSelection({
        query, nowMs: opened.nowMs, admitted: true, selected: phase.selected, selectedIds: subjects,
        scope: context.accountLifetime.scope, currentScope: context.accountLifetime.scope, isCurrent: true,
        contributions: slice.accounting?.contributions, sessionMembership: readUsageAccountingSessionMembership(slice.accounting),
    });
    const admitted = sessions.filter(session => session.access?.capabilities.readTranscript !== false
        && isSessionContentReadable(readSessionContentAvailability(session))).length;
    const snapshot: HowYouWorkReadSnapshot = admitted ? { query, sessions, detail, asOfMs,
        sessionCoverage: { selected: subjects.length, admitted, notRead: sessions.filter(session => {
            const value = phase.selected.get(session.id);
            return value && (!value.completeMessageCoverage || value.workFactsPersisted === false);
        }).length } } : { query, errorCode };
    const phases = phase.read()!.sources.map(source => source.source === 'how_you_work:sessions'
        ? { ...source, status: admitted ? 'partial' as const : 'error' as const, errorCode } : source);
    return { snapshot, phases, admission: { opened: remaining, asOfMs, subjects: sessions.map(session => session.id) } };
}

/** Capture the Home carrier and real Account lifetime; neither is a query input. */
export function captureUiUsageQueryAccountContext(credentials: AuthCredentials): UsageQueryAccountContext | null {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime?.isCurrent() || parseToken(credentials.token) !== accountLifetime.scope.accountId) return null;
    return createUsageQueryAccountContext(credentials, accountLifetime);
}

function createUsageQueryAccountContext(credentials: AuthCredentials, accountLifetime: ServerAccountScopeLifetime): UsageQueryAccountContext | null {
    const profile = getServerProfileById(accountLifetime.scope.serverId);
    if (!profile) return null;
    const request: ServerFetch = async (path, init, options) => {
        if (!accountLifetime.isCurrent()) throw Object.assign(new Error('Usage Account authority retired'), { code: 'stale_surface' });
        const transport = await resolveServerScopedTransport({ profile, credentials });
        try {
            const response = await createServerFetchAtEndpoint({
                endpointUrl: transport.canonicalServerUrl, runtimeOrigin: transport.runtimeOrigin,
                serverId: accountLifetime.scope.serverId, credentials,
                isCurrent: accountLifetime.isCurrent,
                ...(transport.homeCarrier ? { homeCarrier: transport.homeCarrier } : {}),
            })(path, init, options);
            if (!accountLifetime.isCurrent()) throw Object.assign(new Error('Usage Account authority retired'), { code: 'stale_surface' });
            return response;
        } finally { await transport.release(); }
    };
    return { credentials, accountLifetime, request,
        readTransport: createCapturedServerReadTransport({ serverId: accountLifetime.scope.serverId, profile, credentials }) };
}

/** One Action port batches resolved A requests; B/backfill never delays available A. */
/**
 * A selected Project asks for every key its usage may carry (owner 11-08): the census's scope for each Project, read
 * when the request is built. The request sent and the changed-request key both come from here.
 */
function usageProjectScopeKeys(serverId: string): (projectKey: string) => Iterable<string> {
    const refs = readProjectAccountWorkspaceRefs(getStorage().getState());
    return projectKey => resolveSessionProjectScopeV1({ serverId, projectKey }, refs, resolveServerProfileScopeIdForIdentifier).projectKeys;
}

function resolveUsageAccountingDemand(context: UsageQueryAccountContext, query: UsageQuery,
    period: ReturnType<typeof resolveUsageQueryPeriod>) {
    const includeContributions = usageQueryNeedsContributionRows(query);
    const includeSessionIds = !includeContributions && (query.includeSessionEvidence || query.includeWorkEvidence);
    const workOnly = includeContributions && query.includeWorkEvidence && !query.includeContributions
        && !query.includeTranscriptEvidence && !query.includeSessionEvidence;
    const request = usageQueryToAnalyticsRequest({ ...query, period }, undefined,
        usageProjectScopeKeys(context.accountLifetime.scope.serverId));
    return { request, includeContributions, includeSessionIds, workOnly };
}

export async function readUiUsageQueryBatch(
    context: UsageQueryAccountContext,
    input: UsageQueryBatchInput,
    signal?: AbortSignal,
    previous?: UsageQueryBatchResult,
    options?: Readonly<{
        /** Async consumers return their existing progress drain so settlement can reuse its projection. */
        onProgress?: (reproject: UsageQueryReprojection) => void | Promise<void>;
        referenceKey?: string;
        activityRead?: (query: UsageQuery, snapshot: OpenedHowYouWorkSnapshot | undefined) => void;
        previousActivity?: (queryKey: string) => UsageActivityAdmission | undefined;
        retainActivity?: (queryKey: string, admission: UsageActivityAdmission) => void;
        onAccountingSettled?: (value: UsageQueryBatchResult, failure?: Readonly<{ error: unknown }>) => void | Promise<void>;
        /** A mounted Resource can reuse the Work answer on its exact admitted inputs. */
        admitWork?: (query: UsageQuery, turns: UsageWorkTurns, period: ReturnType<typeof resolveUsageQueryPeriod>,
            readTargets: () => Promise<UsageWorkSessionTargets>) => Promise<Readonly<{
            targets: UsageWorkSessionTargets;
            retained?: UsageWorkSourceSnapshot;
            settle(source: UsageWorkSourceSnapshot, detailRefusedDuringRead?: (sessionId: string) => boolean): void;
        }>>;
        /** Only the shared explicit Read now Action may open unconverted wide-window Sessions. */
        readUnconvertedHistory?: boolean;
        /** Explicit Retry preserves accounting refusals in the same batch, even after its data ages. */
        retryAccountingFailuresOnly?: boolean;
        /** Quota recovery consumes only the failures of a current admission. */
        retryQuotaFailuresOnly?: boolean;
        /** A wake of another Usage input does not demand replacement allowance acquisition. */
        retainAllowance?: boolean;
        /** Undefined retains full acquisition for legacy and recovery demand. */
        allowanceTargets?: UsageAllowanceReadTargets;
        allowanceDayChange?: ProviderAccountUsageDayChangeV1;
        /** An allowance-only wake keeps this entry's admitted independent sources. */
        retainedProjection?: UsageQueryReprojection;
    }>,
): Promise<UsageQueryBatchResult> {
    // Keep the caller's object untouched. Hermes can retain Babel's optional-
    // chain temporaries beside a cached projection, so retire the observer by
    // clearing this private cell rather than only the parameter binding.
    const readOptions = options ? { ...options } : undefined;
    options = undefined;
    requireCurrent(context, signal);
    const { queries } = normalizeUsageQueryBatchInput(input);
    if (queries.some(query => query.includeAccounting)) {
        const { sync } = await import('@/sync/sync');
        await sync?.awaitInitialAccountRead(context.accountLifetime.scope, signal);
        requireCurrent(context, signal);
    }
    const calendarQueryKeys = new Set(queries.filter(query => query.includeAccounting && (query.includeActivity || query.includeModelTimeline))
        .map(query => getUsageQueryKey(query)));
    getUsageQueryResourceStore(context);
    const accountOwner = accountStores.get(resolveUsageOwnerLifetime(context))!;
    const accountingInstants = new Map(queries.map(query => [getUsageQueryKey(query), accountOwner.readAccountingInstant(query)]));
    const accountingNowMs = Math.max(...accountingInstants.values());
    const reads = [...new Map(queries.flatMap(query => resolveUsagePageAccountingReads([query], accountingInstants.get(getUsageQueryKey(query))!)
        .map(read => [getUsageQueryKey(read.query), read] as const))).values()];
    const requests = reads.map(read => read.query);
    const periods = new Map([...queries.map(query => [getUsageQueryKey(query), resolveUsageQueryPeriod(query, accountingInstants.get(getUsageQueryKey(query))!)] as const),
        ...reads.map(read => [getUsageQueryKey(read.query), read.period] as const)]);
    const quotaQueries = queries.filter(query => query.includeQuota !== false);
    const quotaDemands = quotaQueries.map(query => ({ query, period: periods.get(getUsageQueryKey(query))! }));
    if (readOptions?.retainedProjection) {
        const retainedProjection = readOptions.retainedProjection;
        let quota = readOpenedQuota(context, quotaQueries, previous);
        const reproject: UsageQueryReprojection = projectionSignal => retainedProjection(projectionSignal, { quota, nowMs: accountingNowMs });
        let progress: void | Promise<void> = undefined;
        try {
            if (readOptions.onAccountingSettled) {
                await readOptions.onAccountingSettled(reproject(signal));
                readOptions.onAccountingSettled = undefined;
            }
            quota = await readOpenedQuotaHistory(context, quotaDemands, accountingNowMs, signal, value => {
                    quota = value;
                    progress = readOptions.onProgress?.(reproject);
                }, previous, quota, readOptions.allowanceTargets, readOptions.allowanceDayChange);
            await progress;
            return reproject(signal);
        } finally {
            readOptions.onProgress = undefined;
            readOptions.activityRead = undefined;
            readOptions.previousActivity = undefined;
            readOptions.retainActivity = undefined;
            readOptions.admitWork = undefined;
            readOptions.onAccountingSettled = undefined;
        }
    }
    const priorAccounting = new Map(previous?.results.flatMap(slice => [
        [slice.key, { value: slice.accounting, asOfMs: slice.sources.find(source => source.source === 'accounting')?.asOfMs,
            readAtMs: readUsageAccountingReadAtMs(slice) }] as const,
        ...(slice.comparison ? [[getUsageQueryKey(slice.comparison.query), { value: slice.comparison.accounting,
            asOfMs: slice.comparison.source.asOfMs, readAtMs: undefined }] as const] : []),
    ]));
    const retryStates = new Map(readOptions?.retryAccountingFailuresOnly ? previous?.results.flatMap(slice => [
        [slice.key, slice.sources.find(source => source.source === 'accounting')] as const,
        ...(slice.comparison ? [[getUsageQueryKey(slice.comparison.query), slice.comparison.source] as const] : []),
    ]) : undefined);
    const skippedAccounting = new Set<string>();
    const quotaFailures = readOptions?.retryQuotaFailuresOnly ? previous?.results.flatMap(slice => slice.sources.filter(source =>
        (source.source === 'quota' || source.source.startsWith('quota:'))
        && (canRetryUsageCoverageFailure(source) || isUsageQuotaOwnershipUnproven(source)))) ?? [] : undefined;
    // An aggregate failure without qualified causes needs the existing quota
    // acquisition. Otherwise recover just the qualified providers that failed.
    const recoveryQuotaSources = quotaFailures && !quotaFailures.some(source => source.source === 'quota'
        && !quotaFailures.some(qualified => qualified.source.startsWith('quota:')))
        ? new Set(quotaFailures.map(source => source.source)) : undefined;
    const accountingAnswers = new Map<string, UsageAccountingAnswer>();
    const accountingReads = new Map<string, UsageAccountingAnswer | Promise<UsageAccountingAnswer>>();
    const accountingAdmissions: Promise<void>[] = [];
    const snapshotForAnswer = (query: UsageQuery, answer: UsageAccountingAnswer): UsageAccountingSourceSnapshot => {
        const asOfMs = resolveUsageAccountingAsOfMs(answer.value);
        return { query, period: periods.get(getUsageQueryKey(query)), value: answer.value, status: 'available',
            readAtMs: answer.readAtMs, ...(asOfMs === undefined ? {} : { asOfMs }) };
    };
    const accounting = new Map<string, UsageAccountingSourceSnapshot>(requests.map(query => {
        const key = getUsageQueryKey(query);
        const disposition = retryStates.get(key);
        if (disposition?.status === 'error' && !canRetryUsageCoverageFailure(disposition)) {
            skippedAccounting.add(key);
            const { source: _source, ...state } = disposition;
            return [key, { ...state, query, period: periods.get(key) }] as const;
        }
        const { request, includeContributions: needsRows, includeSessionIds: needsMembership, workOnly }
            = resolveUsageAccountingDemand(context, query, periods.get(key)!);
        let issued!: () => void;
        const admission = new Promise<void>(resolve => { issued = resolve; });
        const read = accountOwner.readAccounting(request, query, signal, needsRows, needsMembership, workOnly, issued);
        if (read instanceof Promise) {
            accountingAdmissions.push(admission);
            // A pre-dispatch refusal also settles acquisition; its typed failure
            // follows the ordinary accounting task below, never a new timeout.
            void read.then(issued, issued);
        }
        accountingReads.set(key, read);
        // The Account owner already admitted this exact answer. Only actual
        // acquisition starts pending when unrelated sources need another read.
        if (!(read instanceof Promise)) {
            accountingAnswers.set(key, read);
            return [key, snapshotForAnswer(query, read)] as const;
        }
        const retained = priorAccounting.get(key);
        return [key, { query, period: periods.get(key), status: 'pending' as const,
            ...(retained?.value ? { value: retained.value, readAtMs: retained.readAtMs } : {}),
            ...(retained?.asOfMs === undefined ? {} : { asOfMs: retained.asOfMs }) } satisfies UsageAccountingSourceSnapshot] as const;
    }));
    const evidenceQueries = queries.filter(query => query.includeAccounting && query.includeSessionEvidence);
    let work: readonly UsageWorkSourceSnapshot[] = queries.map(query => ({ query, status: query.includeAccounting && query.includeWorkEvidence ? 'pending' : 'not_loaded' }));
    const sessionWorkReads = new Map<string, Promise<SessionWorkSourceResult>>();
    const readWorkTargets = createUsageWorkTargetReader(context, signal);
    const readWorkMachine = createUsageWorkMachineReader(context, signal);
    const sessionInputReader = accountOwner.readSessionInput;
    // KV disclosure and Session evidence share this finite Account batch's identity.
    // It stays lazy: unchanged retained Session inputs need no currentness GET.
    let sessionCurrentness: Promise<SessionAccountCurrentnessSource> | undefined;
    let sessionCurrentnessClosed = false;
    const readSessionCurrentness = () => {
        if (sessionCurrentnessClosed) throw Object.assign(new Error('Usage Session evidence read completed'), {
            code: 'account_encryption_currentness_changed',
        });
        return sessionCurrentness ??= import('@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope')
            .then(({ createOperationAccountCurrentnessSource }) => {
                const source = createOperationAccountCurrentnessSource({
                    credentials: context.credentials, request: context.request,
                    serverId: context.accountLifetime.scope.serverId,
                });
                if (sessionCurrentnessClosed) source.dispose();
                return source;
            });
    };
    let howYouWork: readonly HowYouWorkReadSnapshot[] | undefined;
    const howYouWorkByQuery = new Map<string, HowYouWorkReadSnapshot>();
    const howYouWorkSourcesByQuery = new Map<string, readonly UsageQuerySourceState[]>();
    const settledHowYouWorkQueries = new Set<string>();
    let failedActivity: Map<string, Readonly<{ prior: UsageQueryResultSlice; errorCode: string;
        retained?: ReturnType<typeof readRetainedActivityAfterRefusal>; nowMs?: number }>> | undefined;
    let mcpCatalog: McpServerCatalogSnapshotV1 | undefined;
    let mcpCatalogRead: Promise<McpServerCatalogSnapshotV1> | undefined;
    let quota: OpenedQuotaRead = quotaQueries.length ? readOpenedQuota(context, quotaQueries, previous) : { status: 'not_loaded' };
    let pools: readonly UsagePoolSourceSnapshot[] = quotaQueries.length ? readOpenedUsagePools(context, quotaQueries) : [];
    const priorSlices = new Map(previous?.results.map(slice => [slice.key, slice]));
    const coachQueries = evidenceQueries.filter(query => query.includeCoach !== false)
        .map(query => ({ query, key: getUsageQueryKey(query) }));
    const priorCoachPhases = new Map(coachQueries.flatMap(({ key }) => {
        const prior = priorSlices.get(key)?.sources.find(source => source.source === USAGE_COACH_PREFERENCES_READ_SOURCE);
        return prior ? [[key, prior] as const] : [];
    }));
    let coachSuppression: UsageQuerySourceState | null | undefined;
    const needsCoachCatalog = (query: UsageQuery, snapshot: HowYouWorkReadSnapshot | undefined) =>
        query.includeCoach !== false && !!snapshot?.detail?.coach?.detail?.mcpUsage?.length;
    const projectCurrentDetailPhases = () => {
        if (!coachQueries.length) return howYouWorkSourcesByQuery;
        const phases = new Map(howYouWorkSourcesByQuery);
        for (const { query, key } of coachQueries) {
            // Coach settles on the Activity, optional catalog and preferences
            // this evaluation used. Both readers consume this one source.
            const pending = !settledHowYouWorkQueries.has(key) || coachSuppression === undefined
                || (!mcpCatalog && needsCoachCatalog(query, howYouWorkByQuery.get(key)));
            const failure = coachSuppression === undefined ? priorCoachPhases.get(key) : coachSuppression;
            const coach: UsageQuerySourceState = { source: USAGE_COACH_PREFERENCES_READ_SOURCE,
                status: pending ? 'pending' : failure?.errorCode ? 'error' : 'available',
                ...(failure?.errorCode === undefined ? {} : { errorCode: failure.errorCode }) };
            phases.set(key, [...(phases.get(key) ?? []), coach]);
        }
        return phases;
    };
    let admittedPrevious = previous;
    let projectionNowMs = accountingNowMs;
    // All effects share this read's lifetime; snapshots are published directly
    // into its entry, never cached or rerun just to advance independent sources.
    const compose = (projectionSignal: AbortSignal | undefined): UsageQueryBatchResult => {
        requireCurrent(context, projectionSignal);
        if (quotaQueries.length) quota = projectUsageEnteredPrices(quota, context.accountLifetime.scope, quotaQueries);
        const batch = projectUsageQueryBatch({ context, queries, accountingNowMs: projectionNowMs, accounting, priorAccounting, calendarQueryKeys, previous, admittedPrevious,
            prepareAccounting(snapshot, prepare) {
                const answer = accountingAnswers.get(getUsageQueryKey(snapshot.query));
                const retained = answer?.prepared;
                const prepared = prepare(retained ? { ...snapshot, value: retained.value, priceProjection: retained.priceProjection,
                    agentCalendarAccounting: retained.agentCalendarAccounting, delivery: retained.delivery } : snapshot);
                if (answer) answer.prepared = prepared;
                return prepared;
            },
            work, howYouWork, howYouWorkSourcesByQuery: projectCurrentDetailPhases(), settledHowYouWorkQueries, evidenceQueries, quota, pools, priorSlices, mcpCatalog,
            coachSuppressions: accountOwner.coachSuppressions,
            sourceLocations: Object.values(readOpenedQuotaScope(context)?.state.machines ?? {}).flatMap(machine => {
                const displayLocation = readMachineName(machine);
                return displayLocation ? [{ machineId: machine.id, displayLocation }] : [];
            }) });
        if (!failedActivity) return batch;
        return { ...batch, results: batch.results.map(slice => {
            const failure = failedActivity!.get(slice.key);
            if (!failure) return slice;
            const replacement = failure.retained && failure.nowMs !== undefined
                ? { ...failure.retained, nowMs: failure.nowMs, suppressions: accountOwner.coachSuppressions,
                    work: work.find(snapshot => getUsageQueryKey(snapshot.query) === slice.key) } : undefined;
            return projectRetainedUsageActivity(context, slice, failure.prior, failure.errorCode, replacement);
        }) };
    };
    let projectionPending = true;
    let progress: void | Promise<void> = undefined;
    const reproject: UsageQueryReprojection = (projectionSignal, allowance) => {
        if (allowance) { quota = allowance.quota; projectionNowMs = allowance.nowMs; }
        const batch = compose(projectionSignal);
        admittedPrevious = batch;
        projectionPending = false;
        return batch;
    };
    const projectCurrent = () => projectionPending || !admittedPrevious ? reproject(signal) : admittedPrevious;
    const publish = (): void => {
        projectionPending = true;
        if (!readOptions?.onProgress) return;
        // The Resource coalesces source progress. Compose only the revisions
        // that its existing drain consumes.
        progress = readOptions.onProgress(reproject);
    };
    // Available preference-backed facts can progress while another source's
    // read remains pending. The Account settings owner remains the authority.
    const readNightHours = () => {
        const state = readRegisteredStorageState();
        return readAccountSettingsForScope({ scope: context.accountLifetime.scope,
            focusedScope: state?.settingsScope, focusedSettings: state?.settings ?? settingsDefaults }).usageNightHoursV1;
    };
    let observedNightHours = readNightHours();
    const unwatchNightHours = readOptions?.onProgress ? subscribeRegisteredStorageState(() => {
        if (!context.accountLifetime.isCurrent() || signal?.aborted) return;
        const next = readNightHours();
        if (sameStrictJsonValue(observedNightHours, next)) return;
        observedNightHours = next;
        publish();
    }, { settingsScope: true, settings: ['usageNightHoursV1'] }) : undefined;
    try {
        // Admit new accounting before retained sibling evidence and progress
        // projection can occupy this turn. The HTTP owner supplies issuance;
        // responses still progress independently while that work runs.
        if (accountingAdmissions.length) await Promise.all(accountingAdmissions);
        publish();
        const settleDependentEvidence = (query: UsageQuery, key: string, errorCode: string | undefined) => {
            if (query.includeWorkEvidence) work = work.map(source => getUsageQueryKey(source.query) === key
                ? { query, status: 'error', errorCode } : source);
            if (errorCode === 'denied' && canReadActivityWithoutRefusedAccounting(query)) return 'activity-only' as const;
            if (query.includeSessionEvidence) {
                howYouWorkByQuery.set(key, { query, errorCode });
                howYouWork = [...howYouWorkByQuery.values()];
                settledHowYouWorkQueries.add(key);
            }
            return false;
        };
        const accountingTasks = new Map(requests.map(query => {
        const key = getUsageQueryKey(query);
        return [key, (async () => {
        if (skippedAccounting.has(key)) {
            const refusal = accounting.get(key)!;
            const outcome = settleDependentEvidence(query, key, refusal.errorCode);
            publish();
            return outcome;
        }
        let snapshot: UsageAccountingSourceSnapshot;
        try {
            const read = accountingReads.get(key)!;
            if (!(read instanceof Promise)) return;
            const answer = await read;
            accountingAnswers.set(key, answer);
            snapshot = snapshotForAnswer(query, answer);
        } catch (error) {
            requireCurrent(context, signal);
            if (error instanceof UsageAccountingSliceRefusal) {
                accountOwner.withdrawSessionAccess(query, error, readOptions?.referenceKey);
                // Withdraw this slice's facts while keeping the mounted Account
                // watch alive for the Session's existing access/key wake.
                const refused = { status: 'error' as const, errorCode: error.code };
                accounting.set(key, { query, period: periods.get(key), ...refused });
                const comparison = resolveUsageComparisonQuery(query, periods.get(key));
                if (comparison) {
                    const comparisonKey = getUsageQueryKey(comparison);
                    const pending = accounting.get(comparisonKey);
                    if (pending?.status === 'pending') accounting.set(comparisonKey, { query: comparison, period: pending.period, status: 'pending' });
                }
                const outcome = settleDependentEvidence(query, key, error.code);
                const stripAccounting = (slice: UsageQueryResultSlice) => slice.key !== key ? [slice]
                    : outcome === 'activity-only' ? [withdrawUsageQuerySlice(slice, error.code)] : [];
                if (previous) previous = { ...previous, results: previous.results.flatMap(stripAccounting) };
                if (admittedPrevious) admittedPrevious = { ...admittedPrevious, results: admittedPrevious.results.flatMap(stripAccounting) };
                priorAccounting.delete(key);
                const prior = priorSlices.get(key);
                if (prior && outcome === 'activity-only') priorSlices.set(key, withdrawUsageQuerySlice(prior, error.code));
                else priorSlices.delete(key);
                publish();
                return outcome;
            }
            const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'usage_query_failed';
            // Malformed wire is a typed admission failure, not a usable partial
            // source. The Resource still owns retaining its last valid bytes.
            if (errorCode === 'usage_query_result_invalid') {
                const retained = priorAccounting.get(key);
                accounting.set(key, retainAccountingOnReadFailure({ query, period: periods.get(key), status: 'error', errorCode },
                    retained?.value, retained?.asOfMs, retained?.readAtMs)!);
                settleDependentEvidence(query, key, errorCode);
                projectionPending = true;
                return { error };
            }
            if (!canRetainUsageReadFailure(errorCode)) throw error;
            const retained = priorAccounting.get(key);
            // Detail/Work membership must see the same retained accounting as
            // aggregation, rather than shrinking to the currently hydrated Sessions.
            snapshot = retainAccountingOnReadFailure({ query, period: periods.get(key), status: 'error', errorCode },
                retained?.value, retained?.asOfMs, retained?.readAtMs)!;
        }
        requireCurrent(context, signal);
        accounting.set(key, snapshot);
        publish();
        })()] as const;
        }));
        const settleAccounting = async () => {
            const settled = await Promise.all(accountingTasks.values());
            requireCurrent(context, signal);
            const failure = settled.find(result => typeof result === 'object');
            if (readOptions?.onAccountingSettled) {
                await progress;
                requireCurrent(context, signal);
                await readOptions.onAccountingSettled(projectCurrent(), failure);
                readOptions.onAccountingSettled = undefined;
            }
            if (failure) throw failure.error;
        };
        await Promise.all([
        settleAccounting(),
        (async () => {
            if (coachQueries.length === 0) return;
            const priorSuppressions = accountOwner.coachSuppressions;
            let errorCode: string | undefined;
            try {
                await accountOwner.readCoachSuppressions(async () => {
                    const state = await createUiCoachSuppressionPort(context, signal,
                        async () => (await readSessionCurrentness()).read()).read();
                    requireCurrent(context, signal);
                    return state;
                });
            } catch (error) {
                requireCurrent(context, signal);
                const failure = readUsageHistoryFailure(error);
                if (failure.errorCode !== 'account_kv_content_unreadable'
                    && !(error instanceof UsageCoachSuppressionInvalidResponse) && !isTransientConnectivityError(error)) throw error;
                errorCode = failure.errorCode;
            }
            coachSuppression = errorCode === undefined ? null
                : { source: USAGE_COACH_PREFERENCES_READ_SOURCE, status: 'error', errorCode };
            if (coachQueries.some(({ key }) => settledHowYouWorkQueries.has(key) || priorCoachPhases.get(key)?.errorCode !== errorCode)
                || !sameStrictJsonValue(priorSuppressions, accountOwner.coachSuppressions)) publish();
        })(),
        ...queries.map(async (query, index) => {
            if (!query.includeAccounting || !query.includeWorkEvidence) return;
            // Each slice needs only its own contributions. Native Session reads
            // are still shared across slices within this one Action admission.
            if (await accountingTasks.get(getUsageQueryKey(query)) !== undefined) return;
            requireCurrent(context, signal);
            const queryKey = getUsageQueryKey(query);
            const turns = readUsageWorkSessionTurns(accounting.get(queryKey)?.value);
            const sessionIds = [...new Set(turns?.map(turn => turn.sessionId) ?? [])].sort();
            const acquisition = accountOwner.sessionInputs.beginWorkAdmission(readOptions?.referenceKey);
            const readTargets = () => readWorkTargets(sessionIds);
            const admission = await readOptions?.admitWork?.(query, turns, periods.get(queryKey)!, readTargets);
            const publishWork = (source: UsageWorkSourceSnapshot) => {
                work = work.map((previous, sourceIndex) => sourceIndex === index ? source : previous);
                publish();
            };
            const source = admission?.retained ?? await (async () => {
                const targets = admission?.targets ?? await readTargets();
                const priorRefusals = new Set(sessionIds.filter(id => accountOwner.sessionInputs.workRefused(id)
                    || accountOwner.sessionInputs.detailRefusal(id)));
                const [read] = await collectUsageWorkSources({
                    queries: [query], accounting: [...accounting.values()], sessionReads: sessionWorkReads,
                    assertCurrent: () => requireCurrent(context, signal), now: Date.now,
                    resolveSession: async sessionId => targets.get(sessionId) ?? null,
                    readMachine: readWorkMachine,
                    onSessionAdmission: acquisition.observe,
                    previouslyRefused: id => priorRefusals.has(id),
                    ...(readOptions?.onProgress ? { onProgress: ([snapshot]) => publishWork(snapshot!) } : {}),
                });
                return read!;
            })();
            admission?.settle(source, acquisition.detailRefusedDuringRead);
            publishWork(source);
        }),
        ...evidenceQueries.map(async query => {
            // Current accounting owns historical dimension membership. A held
            // comparison or sibling query must not delay this slice's detail.
            const accountingOutcome = await accountingTasks.get(getUsageQueryKey(query));
            if (accountingOutcome !== undefined && accountingOutcome !== 'activity-only') return;
            requireCurrent(context, signal);
            const history = readUsageHistoryEntry(accountOwner, query);
            history.beginRead();
            let snapshots: Awaited<ReturnType<typeof readHowYouWorkEvidence>>;
            try {
                snapshots = await readHowYouWorkEvidence(context, query, [...accounting.values()], sessionInputReader, accountOwner.readSessionSelection, accountOwner.projectSessionSelection, readSessionCurrentness,
                    accountingInstants.get(getUsageQueryKey(query))!, signal,
                    (snapshots, sources, settled) => {
                        requireCurrent(context, signal);
                        const key = getUsageQueryKey(query);
                        if (settled) settledHowYouWorkQueries.add(key);
                        if (!snapshots[0] && sameStrictJsonValue(howYouWorkSourcesByQuery.get(key), sources)) return;
                        howYouWorkSourcesByQuery.set(key, sources);
                        if (snapshots[0]) {
                            readOptions?.activityRead?.(query, snapshots[0]);
                            howYouWorkByQuery.set(key, snapshots[0]);
                            howYouWork = [...howYouWorkByQuery.values()];
                        }
                        publish();
                    }, { readUnconverted: readOptions?.readUnconvertedHistory,
                        coverage: (selected, notRead) => history.coverage(selected,
                            readsUnconvertedTranscriptsOnOpen(query) ? 0 : notRead),
                        converted: id => history.converted(id),
                        succeeded: id => history.succeeded(id),
                        failed: (code, id, retryable) => history.failed(code, id, retryable) }, priorSlices.get(getUsageQueryKey(query)),
                    readOptions?.referenceKey);
            } catch (error) {
                requireCurrent(context, signal);
                if (!isTransientConnectivityError(error)) throw error;
                const key = getUsageQueryKey(query);
                const errorCode = readUsageHistoryFailure(error).errorCode;
                history.failed(errorCode);
                const prior = priorSlices.get(key);
                const admission = readOptions?.previousActivity?.(key);
                if (prior?.howYouWork && admission) {
                    readOptions?.activityRead?.(query, undefined);
                    const retained = readRetainedActivityAfterRefusal(context, prior, admission, accountOwner.sessionInputs);
                    if (retained) readOptions?.retainActivity?.(key, retained.admission);
                    failedActivity ??= new Map();
                    failedActivity.set(key, { prior, errorCode, nowMs: admission.opened.nowMs, retained });
                }
                howYouWorkByQuery.set(key, { ...(howYouWorkByQuery.get(key) ?? { query }), errorCode });
                howYouWorkSourcesByQuery.set(key, (howYouWorkSourcesByQuery.get(key) ?? []).map(source =>
                    source.status === 'pending' ? { ...source, status: 'error', errorCode } : source));
                howYouWork = [...howYouWorkByQuery.values()];
                settledHowYouWorkQueries.add(key);
                publish();
                return;
            }
            // Binding advice and its catalog admission are one private-evidence
            // result. Unrelated quota/history reads must not hold them back.
            const admittedSnapshot = snapshots[0]!;
            if (needsCoachCatalog(query, admittedSnapshot)) {
                mcpCatalogRead ??= import('./apiMcpServerCatalog').then(({ readMcpServerCatalog }) =>
                    readMcpServerCatalog(context.accountLifetime.scope, signal, () => requireCurrent(context, signal)));
                mcpCatalog = await mcpCatalogRead;
                requireCurrent(context, signal);
            }
            readOptions?.activityRead?.(query, admittedSnapshot);
            howYouWorkByQuery.set(getUsageQueryKey(query), admittedSnapshot);
            howYouWork = [...howYouWorkByQuery.values()];
            settledHowYouWorkQueries.add(getUsageQueryKey(query));
            publish();
        }),
        (async () => {
            // Acquisition follows the changed input, independently of whether
            // its retained observation is complete, stale, unavailable or failed.
            if (quotaQueries.length && !readOptions?.retainAllowance) {
                const settled = await readOpenedQuotaHistory(context, quotaDemands, accountingNowMs, signal,
                    value => { quota = value; publish(); }, previous, quota, readOptions?.allowanceTargets, readOptions?.allowanceDayChange, recoveryQuotaSources);
                if (settled !== quota) { quota = settled; publish(); }
            }
        })(),
        (async () => {
            const settled = await readUiUsagePools(context, pools, signal, value => { pools = value; publish(); });
            if (settled !== pools) { pools = settled; publish(); }
        })(),
        ]);
        await progress;
        requireCurrent(context, signal);
        // Settlement reuses this finite read's last consumed projection. The
        // retained reproject closure still evaluates future presentation wakes.
        return projectCurrent();
    } finally {
        // A read can end after publishing private facts but before settlement.
        // Its retained presentation closure needs the latest consumed admission,
        // never the replaced read's fallback population or period witnesses.
        previous = admittedPrevious;
        priorAccounting.clear();
        priorSlices.clear();
        if (admittedPrevious) settleUsageQueryProjection(accounting, admittedPrevious);
        // Native optional-chain lowering can retain aliases of readOptions.
        // Clear the observer on its private cell, including on cancellation.
        if (readOptions) {
            readOptions.onProgress = undefined;
            readOptions.activityRead = undefined;
            readOptions.previousActivity = undefined;
            readOptions.retainActivity = undefined;
            readOptions.onAccountingSettled = undefined;
            readOptions.admitWork = undefined;
        }
        sessionCurrentnessClosed = true;
        unwatchNightHours?.();
        // Construction is only a module import and local observation capture;
        // never await a pending private network read during teardown.
        await sessionCurrentness?.then(source => source.dispose(), () => undefined);
    }

}

type UsageQueryInvalidation = HomeAccountChangeEvent | 'session-evidence' | UsageQueryStateInvalidation;

function isAllowanceOnlyUsageInvalidation(change: UsageQueryInvalidation | undefined): boolean {
    return change === 'quota-inputs' || change === 'quota-pool-inputs' || change === 'quota-projection-inputs'
        || typeof change === 'object' && isUsageQuotaHomeAccountChange(change);
}

function usageQueriesReadAllowance(queries: readonly UsageQuery[]): boolean {
    return queries.some(query => query.includeQuota !== false);
}
type UsageQueryReadDemand = Readonly<{
    allowance: boolean | undefined;
    allowanceTargets?: UsageAllowanceReadTargets;
    allowanceDayChange?: ProviderAccountUsageDayChangeV1;
    projectionOnly: boolean;
    allowanceOnly: boolean;
    authorityChanged: boolean;
    retryFailuresOnly: boolean;
    reuseWorkOnWake?: boolean;
    /** Nothing reached this watch since its previous read, whose bytes are therefore still current. */
    unchanged: boolean;
    hasPendingChanges(): boolean;
    isCurrent(): boolean;
    finish(): void;
}>;

function joinAllowanceDayChanges(left: ProviderAccountUsageDayChangeV1 | undefined, right: ProviderAccountUsageDayChangeV1 | undefined) {
    if (!left || !right || left.recordId !== right.recordId || left.dayStartAtMs !== right.dayStartAtMs) return undefined;
    return left.throughCursor >= right.throughCursor ? left : right;
}

type UsageEntryAccountingOutcome =
    | Readonly<{ ok: true; value: ResourceContent }>
    | Readonly<{ ok: false; error: unknown; fallback?: ResourceContent }>;
type UsageEntryRead = {
    accounting: Promise<UsageEntryAccountingOutcome>;
    readonly completion: Promise<ResourceContent>;
    readonly signal: AbortSignal | undefined;
    replaceRetained(replace: (value: ResourceContent) => ResourceContent): void;
    projected?: ResourceContent;
};
type UsageEntryAcquisition = Readonly<{
    accounting: Promise<UsageEntryAccountingOutcome>;
    evidenceCompletion?: Promise<ResourceContent>;
    signal?: AbortSignal;
    workAwaitingOwnRead?: boolean;
    needsCoachEvidence?: boolean;
    getEvidenceContent(): ResourceContent | undefined;
}>;

/** Activity comes from this watch's admitted demand, independently of retained allowance facts. */
export type UsageQueryResourceEntry = Omit<PluginUiResourceEntry, 'refresh'> & Readonly<{
    refresh(options?: Readonly<{ supersede?: boolean; callerContext?: ActionExecutorContext; failedOnly?: boolean }>): ReturnType<PluginUiResourceEntry['refresh']>;
    /** Only the canonical Usage Action port calls this after admission. */
    acquire(callerContext: ActionExecutorContext): UsageEntryAcquisition;
    isAllowanceReadPending(): boolean;
    /** Cold presentations wait for admission; revisits immediately retain their last-known facts. */
    isPresentationReady(): boolean;
}>;
type UsageQueryResourceStore = Omit<ReturnType<typeof createPluginUiResourceStore>, 'getEntry'> & Readonly<{
    getEntry(reference: Parameters<PluginUiResourceStore['getEntry']>[0], callerContext?: ActionExecutorContext): UsageQueryResourceEntry;
}>;

const usagePresentationReady = () => true;

type UsageQueryAcquisitionKind = 'presentation' | 'action' | 'refresh' | 'retry';

/** Explicit recovery replaces this entry's read; ordinary push wakes stay coalesced. */
function withExplicitAllowanceRefresh(store: ReturnType<typeof createPluginUiResourceStore>,
    withCaller: <T>(callerContext: ActionExecutorContext | undefined, kind: UsageQueryAcquisitionKind, acquire: () => T) => T,
    requestFresh: (reference: Parameters<PluginUiResourceStore['getEntry']>[0], failedOnly: boolean) => void,
    isAllowanceReadPending: (reference: Parameters<PluginUiResourceStore['getEntry']>[0]) => boolean,
    readAdmission: (reference: Parameters<PluginUiResourceStore['getEntry']>[0], projected?: ResourceContent) => Readonly<{
        reusable: boolean; currentSnapshot: ReturnType<PluginUiResourceEntry['getSnapshot']> | undefined;
        currentContent?: ResourceContent;
        workAwaitingOwnRead?: boolean;
    }>,
    createPresentationReadiness: (reference: Parameters<PluginUiResourceStore['getEntry']>[0],
        entry: PluginUiResourceEntry) => () => boolean,
    getRead: (reference: Parameters<PluginUiResourceStore['getEntry']>[0]) => UsageEntryRead | undefined): UsageQueryResourceStore {
    return Object.freeze<UsageQueryResourceStore>({
        ...store,
        getEntry(reference, callerContext) {
            const entry = store.getEntry(reference);
            let initialCaller = callerContext;
            let presentationReady: (() => boolean) | undefined;
            const subscribe: UsageQueryResourceEntry['subscribe'] = (listener, live) => {
                const caller = initialCaller;
                initialCaller = undefined;
                return withCaller(caller, 'presentation', () => entry.subscribe(listener, live));
            };
            const refresh: UsageQueryResourceEntry['refresh'] = options => {
                initialCaller = undefined;
                // Ordinary acquisition joins admitted facts and still settles on
                // failure or retirement. Manual Refresh asks for a new answer.
                if (options?.supersede === false) {
                    return withCaller(options.callerContext, 'presentation', () => entry.refresh(options));
                }
                return withCaller(options?.callerContext, options?.failedOnly ? 'retry' : 'refresh', () => {
                    requestFresh(reference, options?.failedOnly === true);
                    return entry.refresh({ supersede: true });
                });
            };
            return Object.freeze<UsageQueryResourceEntry>({
                ...entry,
                subscribe,
                refresh,
                acquire(context) {
                    initialCaller = undefined;
                    const admitted = readAdmission(reference);
                    const snapshot = admitted.currentSnapshot;
                    let read = getRead(reference);
                    if (!read && admitted.reusable && snapshot?.freshness === 'fresh' && snapshot.value) {
                        const value = snapshot.value;
                        return { accounting: Promise.resolve({ ok: true, value }),
                            evidenceCompletion: Promise.resolve(value), getEvidenceContent: () => value };
                    }
                    if (!read) {
                        const completion = withCaller(context, 'action', () => entry.refresh({ supersede: false }));
                        read = getRead(reference);
                        if (!read) {
                            // A retired Resource has no admitted read to join.
                            return { accounting: completion.then(({ error }) => ({ ok: false, error: new HappyError(
                                error?.message ?? 'Usage Resource unavailable', false, { code: error?.code ?? 'plugin_surface_retired',
                                    details: error?.details }) })), getEvidenceContent: () => undefined };
                        }
                    }
                    const joined = read;
                    const coachKeys = typeof reference !== 'string' && 'hostRead' in reference
                        ? normalizeUsageQueryBatchInput(reference.input).queries.filter(query =>
                            query.includeAccounting && query.includeSessionEvidence
                                && (query.includeCoach !== false || context.usageQueryReadiness === 'coach_evidence')).map(getUsageQueryKey)
                        : [];
                    return { accounting: joined.accounting, evidenceCompletion: joined.completion,
                        signal: joined.signal, workAwaitingOwnRead: admitted.workAwaitingOwnRead,
                        needsCoachEvidence: coachKeys.length > 0,
                        getEvidenceContent() {
                            if (!joined.projected) return undefined;
                            if (coachKeys.length && decodeUsageQueryResource(joined.projected).results.some(slice =>
                                coachKeys.includes(slice.key) && (slice.requestedQuery.includeCoach !== false
                                    ? hasPendingCoachEvidence(slice)
                                    : slice.sources.some(source => source.source === 'how_you_work'
                                        && (source.status === 'pending' || source.status === 'not_loaded')))))
                                return undefined;
                            return readAdmission(reference, joined.projected).currentContent;
                        } };
                },
                isAllowanceReadPending: () => entry.getSnapshot().pending !== 'idle' && isAllowanceReadPending(reference),
                isPresentationReady: () => (presentationReady ??= createPresentationReadiness(reference, entry))(),
                select(projection, selector) {
                    const selection = entry.select(projection, selector);
                    return Object.freeze({ ...selection,
                        subscribe(listener: () => void, live: boolean) {
                            const caller = initialCaller;
                            initialCaller = undefined;
                            return withCaller(caller, 'presentation', () => selection.subscribe(listener, live));
                        },
                        refresh: async () => { await refresh(); } });
                },
            });
        },
    });
}
type UsageAccountingAnswer = {
    readonly value: Awaited<ReturnType<typeof queryUsageAnalytics>>;
    readonly readAtMs: number;
    /** Protocol validates the prepared operand, cost basis and overrides before reuse. */
    prepared?: PreparedUsageAccountingSnapshot;
};
type AccountResourceOwner = Readonly<{ store: UsageQueryResourceStore; invalidate(event?: UsageQueryInvalidation, quotaRecordIds?: readonly string[], quotaSourceKeys?: readonly string[]): void; readSessionInput: SessionInputReader;
    withdrawSessionAccess(query: UsageQuery, refusal: UsageAccountingSliceRefusal, origin?: string): void;
    sessionInputs: ReturnType<typeof createUsageQuerySessionInputs>;
    withdrawSessionWork(sessionIds: ReadonlySet<string>): (content: ResourceContent) => ResourceContent;
    coachSuppressions: UsageCoachSuppressionStateV1 | undefined;
    readCoachSuppressions(read: () => Promise<UsageCoachSuppressionStateV1>): Promise<void>;
    publishCoachSuppressions(state: UsageCoachSuppressionStateV1): void;
    readSessionSelection: SessionInputSelectionReader;
    projectSessionSelection: SessionInputSelectionProjector;
    retrySessionInputFailures: ReturnType<typeof createUsageQuerySessionInputs>['retryFailures'];
    history: Map<string, UsageHistoryEntry>;
    /** The instant this read resolves its accounting windows at. */
    readAccountingInstant(query: UsageQuery): number;
    readAccounting(request: Parameters<typeof queryUsageAnalytics>[1], query: UsageQuery, signal?: AbortSignal,
        includeContributions?: boolean, includeSessionIds?: boolean, workOnly?: boolean, onIssued?: () => void): UsageAccountingAnswer | Promise<UsageAccountingAnswer>;
    projectionDocuments: ProviderAccountUsageProjectionDocuments }>;

type WithdrawUsageQuery = (query: UsageQuery) => boolean;
function readUsageSessionScope(selection: UsageQuery['session'] | undefined): readonly string[] {
    return typeof selection === 'string' ? [selection] : selection ?? [];
}

function canReadActivityWithoutRefusedAccounting(query: UsageQuery): boolean {
    // An exact multi-Session Accounting denial names no member. Activity can
    // still ask Home for each explicit subject unless its selection needs Accounting.
    return query.includeSessionEvidence && readUsageSessionScope(query.session).length > 1
        && selectUsageQueryWorkEvidenceSessionIds({ query, sessions: [] }).length > 0;
}

function hasPendingCoachEvidence(slice: UsageQueryResultSlice) {
    return slice.sources.some(source => source.source === USAGE_COACH_PREFERENCES_READ_SOURCE && source.status === 'pending');
}

function withdrawUsageQuerySlice(slice: UsageQueryResultSlice, errorCode: UsageAccountingSliceRefusal['code']): UsageQueryResultSlice {
    // Quota belongs to the viewer. Independent Activity has its own per-Session admission.
    const preserveActivity = canReadActivityWithoutRefusedAccounting(slice.requestedQuery);
    const sources = slice.sources.filter(({ source }) => source === 'quota' || source.startsWith('quota:')
        || preserveActivity && (source === 'how_you_work' || source.startsWith('how_you_work:')));
    return { key: slice.key, requestedQuery: slice.requestedQuery, shownQuery: slice.requestedQuery,
        ...(slice.quota === undefined ? {} : { quota: slice.quota }),
        ...(preserveActivity && slice.howYouWork !== undefined ? { howYouWork: slice.howYouWork } : {}),
        sources: [{ source: 'accounting', status: 'error', errorCode }, ...sources],
        pending: sources.some(source => isUsageQuerySourceOutstanding(slice.requestedQuery, source)) };
}
// This is the existing Resource store's Account ownership, not a response cache.
const accountStores = new WeakMap<ServerAccountScopeLifetime, AccountResourceOwner>();
function readUsageHistoryEntry(owner: AccountResourceOwner, query: UsageQuery): UsageHistoryEntry {
    const key = getUsageQueryKey(query);
    let entry = owner.history.get(key);
    if (!entry) {
        entry = new UsageHistoryEntry();
        owner.history.set(key, entry);
    }
    return entry;
}
function usageHistoryOwner(context: UsageQueryAccountContext): AccountResourceOwner {
    getUsageQueryResourceStore(context);
    return accountStores.get(resolveUsageOwnerLifetime(context))!;
}
export function getUiUsageHistoryState(context: UsageQueryAccountContext, query: UsageQuery): UsageHistoryReadState {
    requireCurrent(context);
    return readUsageHistoryEntry(usageHistoryOwner(context), query).state;
}
export function subscribeUiUsageHistory(context: UsageQueryAccountContext, query: UsageQuery, listener: () => void): () => void {
    requireCurrent(context);
    const entry = readUsageHistoryEntry(usageHistoryOwner(context), query);
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
}
export function cancelUiUsageHistory(context: UsageQueryAccountContext, query: UsageQuery): void {
    requireCurrent(context);
    readUsageHistoryEntry(usageHistoryOwner(context), query).controller?.abort();
}
export async function readUiUsageHistory(context: UsageQueryAccountContext, input: Readonly<{ query: UsageQuery }>,
    options?: Readonly<{ signal?: AbortSignal; onProgress?: (state: UsageHistoryReadState) => void }>): Promise<UsageHistoryReadState> {
    requireCurrent(context);
    const owner = usageHistoryOwner(context);
    const entry = readUsageHistoryEntry(owner, input.query);
    const notify = () => options?.onProgress?.(entry.state);
    entry.listeners.add(notify);
    let removeCancellation: (() => void) | undefined;
    try {
        if (!entry.pending) {
            owner.retrySessionInputFailures(new Set([getUsageQueryKey(input.query)]));
            const controller = new AbortController();
            entry.controller = controller;
            const retirement = context.accountLifetime.onRetire(() => controller.abort());
            if (options?.signal?.aborted) controller.abort();
            entry.publish({ status: 'reading', progress: {
                ...entry.state.progress, completed: 0 } });
            entry.pending = (async () => {
                try {
                    await readUiUsageQueryBatch(context, { queries: [input.query] }, controller.signal, undefined,
                        { readUnconvertedHistory: true, retainAllowance: true });
                    entry.publish({ ...entry.state,
                        status: controller.signal.aborted ? 'cancelled'
                            : entry.state.errorCode || entry.state.progress.notRead || entry.state.progress.failed ? 'partial' : 'complete' });
                    invalidateUsageQueryResources(resolveUsageOwnerLifetime(context));
                } catch (error) {
                    if (!controller.signal.aborted) entry.failed(readUsageHistoryFailure(error).errorCode);
                    entry.publish({ ...entry.state, status: controller.signal.aborted ? 'cancelled' : 'partial' });
                } finally {
                    retirement.dispose();
                    entry.controller = undefined;
                    entry.pending = undefined;
                }
                return entry.state;
            })();
        } else notify();
        // Every joined caller reaches the same admitted operation's local cancel signal.
        const controller = entry.controller;
        const abort = () => controller?.abort();
        if (options?.signal?.aborted) abort();
        else if (options?.signal) {
            options.signal.addEventListener('abort', abort, { once: true });
            removeCancellation = () => options.signal?.removeEventListener('abort', abort);
        }
        return await entry.pending;
    } finally { removeCancellation?.(); entry.listeners.delete(notify); }
}
const INVALIDATION_DIGEST = computePluginUiArtifactSha256DigestV1(new TextEncoder().encode('usage-owner-invalidation'));

function resolveUsageOwnerLifetime(context: UsageQueryAccountContext): ServerAccountScopeLifetime {
    // A restricted invocation owns its exact request proof as well as its lifetime.
    // Rebinding it to the focused Account would replace that admitted transport.
    if (!context.readTransport || context.readTransport.scope) return context.accountLifetime;
    const active = captureActiveServerAccountScopeLifetime();
    if (active && areServerAccountScopesEqual(active.scope, context.accountLifetime.scope)) return active;
    // Neutral background reads belong to the admitted credential, not one finite Action.
    // Opaque/restricted transports retain their invocation's exact custody.
    return captureServerCredentialAccountScopeLifetime({ kind: 'bound', scope: context.accountLifetime.scope,
        credentialKey: resolveAuthCredentialsScopeKey(context.credentials) });
}

export function invalidateUsageQueryResources(lifetime = captureActiveServerAccountScopeLifetime()): void {
    if (!lifetime?.isCurrent()) return;
    // Actions wrap the captured lifetime; mounted Resources use the active
    // same-Account lifetime. Match the existing store admission normalization.
    const active = captureActiveServerAccountScopeLifetime();
    const ownerLifetime = active && areServerAccountScopesEqual(active.scope, lifetime.scope) ? active : lifetime;
    accountStores.get(ownerLifetime)?.invalidate();
}

/** The acknowledged Coach write is a source operand of this same Account Resource. */
export function publishUiUsageCoachSuppressions(context: UsageQueryAccountContext, state: UsageCoachSuppressionStateV1): void {
    // An admitted mutation keeps its acknowledgement after retirement, but cannot publish into a replacement Account.
    if (!context.accountLifetime.isCurrent()) return;
    getUsageQueryResourceStore(context);
    accountStores.get(resolveUsageOwnerLifetime(context))!.publishCoachSuppressions(state);
}

/** Mounted host widgets and admitted plugin host reads acquire this exact store. */
export function getUsageQueryResourceStore(context: UsageQueryAccountContext): UsageQueryResourceStore {
    requireCurrent(context);
    const lifetime = resolveUsageOwnerLifetime(context);
    // Retained Account work never borrows a finished Action's request/signal closure.
    const ownerContext = lifetime === context.accountLifetime ? context : createUsageQueryAccountContext(context.credentials, lifetime);
    if (!ownerContext) throw Object.assign(new Error('Usage Account authority retired'), { code: 'stale_surface' });
    const { callerContext: _callerContext, ...sharedContext } = ownerContext;
    const existing = accountStores.get(lifetime);
    if (existing) return existing.store;
    const evidenceAbort = new AbortController();
    const accountingReads = createUsageAccountingReader(sharedContext, evidenceAbort.signal);
    // Server accounting answers, by exact request, share their first read instant.
    // A scoped change advances only its queries. Other reads keep their instant so
    // a growing page batch, a watch resync and
    // Session/Settings/quota-input wakes repeat no request. Accounting or
    // unknown Home wakes, mode changes and explicit refresh replace them;
    // so does a new local day. Allowance acquisition does not
    // change an already-admitted accounting answer.
    let admittedAccounting: { nowMs: number; answers: Map<string, UsageAccountingAnswer> } | undefined;
    // Retain admissions across closed views; observation follows live demand.
    let resourceInputs = {};
    let quotaFreeResourceInputs = {};
    let coachSuppressions: UsageCoachSuppressionStateV1 | undefined;
    // Closed accounting views do not consume Session/private input changes.
    // Private views retain their own input identity and refresh when reopened.
    let sessionEvidenceInputs = resourceInputs;
    // Metric selects a presentation of the same accounting operands. Its
    // first mount must keep the retained input's instant after a scoped wake.
    const accountingInputKey = (query: UsageQuery) => getUsageQueryKey({ ...query, metric: 'tokens' });
    const accountingInputs = new Map<string, { query: UsageQuery; identity: object; nowMs?: number }>();
    const readingAccess = new Set<Readonly<{
        accounting(matches: WithdrawUsageQuery, errorCode: UsageAccountingSliceRefusal['code'], refusedQueryKey: string): void;
    }>>();
    let retainedCurrentness = captureAccountEncryptionCurrentness(lifetime.scope.serverId);
    const replaceAccounting = () => {
        admittedAccounting = undefined;
        accountingInputs.clear();
        accountingReads.invalidate();
    };
    const retireAccountingReads = (affected: (request: UsageAnalyticsQueryRequest) => boolean, nowMs?: number) => {
        if (admittedAccounting) {
            const { answers } = admittedAccounting;
            for (const key of answers.keys()) {
                const [queryKey] = JSON.parse(key) as [string];
                if (affected(JSON.parse(queryKey) as UsageAnalyticsQueryRequest)) answers.delete(key);
            }
            if (nowMs !== undefined) admittedAccounting = { nowMs, answers };
        }
        accountingReads.invalidate(affected);
    };
    const replaceAccountInputs = () => {
        resourceInputs = {};
        quotaFreeResourceInputs = {};
        sessionEvidenceInputs = resourceInputs;
        retainedCurrentness.dispose();
        retainedCurrentness = captureAccountEncryptionCurrentness(lifetime.scope.serverId);
        replaceAccounting();
    };
    // The quota derivation owner supplies the interval where unchanged facts
    // have unchanged time-derived meaning. Calculate it only when a Resource
    // settles, including history; reopening never traverses that history again.
    const readQuotaInterval = (read: ConnectedServiceQuotaGetResultV1, nowMs: number) => {
        const interval = getProviderAccountUsageDerivationInterval({ current: read.current,
            history: read.history?.entries.map(entry => entry.snapshot) ?? [], nowMs });
        if (!interval) return null;
        // Source freshness belongs to readOpenedQuota above and uses fetchedAt,
        // while pace uses the provider observation's timestamp.
        const staleAtMs = read.current ? read.current.fetchedAtMs + read.current.staleAfterMs : Infinity;
        const value = { fromMs: Math.max(interval.fromMs, nowMs >= staleAtMs ? staleAtMs : 0),
            untilMs: Math.min(interval.untilMs, nowMs < staleAtMs ? staleAtMs : Infinity) };
        // Crossing only a freshness boundary changes no fact a reread returns: the same record
        // reconciles to `stale` with its prior pace kept (`reconcileQuotaRead`), and a newer record
        // arrives as a pushed record change. Window resets still need the read's projected history.
        const windows = getProviderAccountUsageDerivationInterval({ current: read.current,
            history: read.history?.entries.map(entry => entry.snapshot) ?? [], nowMs, boundaries: 'windows' });
        return { value, derivation: windows ?? { fromMs: Infinity, untilMs: 0 } };
    };
    // Quota pushes replace the retained resource identity. Each replacement keeps the record
    // ids it named, so a view reopened after closed-view pushes rereads only those records.
    const resourceInputSteps = new WeakMap<object, Readonly<{ next: object; recordIds: readonly string[] | undefined }>>();
    const replaceResourceInputs = (recordIds: readonly string[] | undefined, allowanceOnly: boolean) => {
        const advance = (from: object) => {
            const next = {};
            resourceInputSteps.set(from, { next, recordIds });
            return next;
        };
        resourceInputs = advance(resourceInputs);
        // A watcher that skips this wake must keep its admission current too.
        if (!allowanceOnly) quotaFreeResourceInputs = advance(quotaFreeResourceInputs);
    };
    /** The record ids changed since `from` was the resource identity; `undefined` when unknown. */
    const readResourceInputChanges = (from: object, current: object): readonly string[] | undefined => {
        const ids = new Set<string>();
        for (let at = from; at !== current;) {
            const step = resourceInputSteps.get(at);
            if (!step?.recordIds) return undefined;
            for (const id of step.recordIds) ids.add(id);
            at = step.next;
        }
        return [...ids];
    };
    const projectionDocuments: ProviderAccountUsageProjectionDocuments = new Map();
    const history: AccountResourceOwner['history'] = new Map();
    // Allowances belong to this Account, not a page's accounting batch. Keep
    // their latest Resource revision across navigation, including zero views.
    // New query ranges still read their own history; these facts seed the body
    // until that replacement answers, rather than claiming its range is read.
    let allowance: RetainedUsageAllowance | undefined;
    // Queries move between route batches as visible widgets register. These
    // are the same Account Resource's admitted slices, independent of batch membership.
    // Keep private evidence and selector state beside accounting so a changed
    // widget demand cannot retire only part of the same query's admission.
    const slicesByQuery = new Map<string, Readonly<{ slice: UsageQueryResultSlice;
        workInput?: UsageWorkMachineInput; activitySessions?: UsageActivityAdmission }>>();
    const sessionInputs = createUsageQuerySessionInputs({ lifetime, signal: evidenceAbort.signal,
        assertCurrent: () => requireCurrent(sharedContext, evidenceAbort.signal),
        onRefusal: replaceRefusedEvidence });
    const listeners = new Map<(event: ResourceSubscriptionEvent, change?: UsageQueryInvalidation, quotaRecordIds?: readonly string[], quotaSourceKeys?: readonly string[]) => void, Readonly<{
        reference: Parameters<PluginUiResourceStore['getEntry']>[0];
        takeReadDemand(): UsageQueryReadDemand;
        isAllowanceReadPending(): boolean;
        requestAllowanceRead(failedOnly: boolean): void;
        readsAllowance: boolean;
        queries: readonly UsageQuery[];
        workInputs(): readonly UsageWorkMachineInput[];
        machineId?: string;
    }>>();
    const demandSubscriptions = new Map<() => () => void, { allowanceOnly: boolean; detach?: () => void }>();
    const whileDemanded = (attach: () => () => void, allowanceOnly = false) => {
        const subscription: { allowanceOnly: boolean; detach?: () => void } = { allowanceOnly };
        demandSubscriptions.set(attach, subscription);
        return () => { subscription.detach?.(); demandSubscriptions.delete(attach); };
    };
    const resourceKey = (reference: Parameters<PluginUiResourceStore['getEntry']>[0]) => {
        if (typeof reference !== 'string' && 'hostRead' in reference && reference.hostRead === 'usage.query') {
            return JSON.stringify(['host', 'usage.query', getUsageQueryBatchKey(reference.input)]);
        }
        return pluginUiResourceReferenceKey(reference, null);
    };
    const readNeedsRecovery = (reference: Parameters<PluginUiResourceStore['getEntry']>[0]) => {
        const snapshot = owner.store.getEntry(reference).getSnapshot();
        if (snapshot.pending !== 'idle' || snapshot.value === undefined || snapshot.error) return true;
        if (typeof reference === 'string' || !('hostRead' in reference) || reference.hostRead !== 'usage.query') return false;
        // The batch can settle successfully while accounting keeps a failed
        // acquisition on an individual slice, including a retained stale value.
        return decodeUsageQueryResource(snapshot.value).results.some(slice =>
            slice.sources.some(source => source.source === 'accounting' && source.errorCode === 'usage_query_failed')
            || slice.comparison?.source.errorCode === 'usage_query_failed');
    };
    // subscribe/refresh synchronously starts readResource. Only that start
    // captures this operation's caller; joining admitted work leaves no origin.
    let acquisitionCaller: Readonly<{ context?: ActionExecutorContext; kind: UsageQueryAcquisitionKind }> | undefined;
    const entryReads = new Map<string, UsageEntryRead>();
    const replaceRetainedUsageValues = (replace: (value: ResourceContent) => ResourceContent) => {
        for (const read of entryReads.values()) read.replaceRetained(replace);
        owner.store.replaceRetainedValues(replace);
    };
    const readWorkMachineKey = (targets: UsageWorkSessionTargets) => {
        const ids = readWorkTargetMachineIds(targets);
        const state = getStorage().getState();
        const machines = Object.fromEntries(ids.flatMap(id => {
            const machine = resolveServerScopedMachine(state, lifetime.scope.serverId, id);
            return machine ? [[id, machine] as const] : [];
        }));
        return getUsageQueryMachineInvalidationKey(machines, Date.now(), lifetime.scope,
            { includeMachineNames: false, poolMachineFilters: [], sessionMachineIds: ids });
    };
    const readWorkMachineInput = (queryKey: string, targets: UsageWorkSessionTargets): UsageWorkMachineInput => {
        return {
            queryKey, sessionIds: [...targets.keys()], targets,
            targetKey: JSON.stringify([...targets].map(([id, target]) => 'machineId' in target
                ? [id, target.machineId, target.cwd] : [id, target.errorCode, target.httpStatus, target.updateRequired])),
            machineKey: readWorkMachineKey(targets),
        };
    };
    const workTargetNeedsAdmission = (id: string, target: UsageWorkSessionTarget) => {
        const observed = readObservedWorkMetadataVersion(lifetime.scope, id);
        return observed !== undefined && observed !== target.metadataVersion && observed !== target.observedMetadataVersion;
    };
    // Read and watch consume the same Account admission. The watch can name
    // its retained identity so establishment converges after its mandatory read,
    // without scheduling a second read of those same admitted inputs.
    const readUsageAdmission = (reference: Parameters<PluginUiResourceStore['getEntry']>[0], queries: readonly UsageQuery[],
        projected?: ResourceContent) => {
        unwatchState?.reconcile();
        const privateQueries = queries.filter(query => query.includeSessionEvidence || query.includeTranscriptEvidence || query.includeWorkEvidence);
        if (privateQueries.length) {
            const ids = privateQueries.some(query => query.session === null) ? undefined
                : privateQueries.flatMap(query => typeof query.session === 'string' ? [query.session] : query.session ?? []);
            if (sessionInputs.reconcile(ids, undefined, new Set(privateQueries.map(getUsageQueryKey)))) owner.invalidate('session-evidence');
        }
        if (!retainedCurrentness.isCurrent()) replaceAccountInputs();
        // Watching can name the first input before the initial cursor is ready.
        // Only an admitted read anchors its window. Established windows still
        // advance at the local-day boundary even while closed.
        if (admittedAccounting) for (const query of queries) owner.readAccountingInstant(query);
        const readInputs = [usageQueriesReadAllowance(queries) ? resourceInputs : quotaFreeResourceInputs,
            ...(queries.some(query => query.includeSessionEvidence || query.includeTranscriptEvidence || query.includeWorkEvidence)
                ? [sessionEvidenceInputs] : []), ...queries.map(query => {
                // Preserve the per-query position without making quota-only
                // admissions depend on the accounting feed's input revisions.
                if (!query.includeAccounting) return lifetime;
                const key = accountingInputKey(query);
                let input = accountingInputs.get(key);
                if (!input) { input = { query, identity: {} }; accountingInputs.set(key, input); }
                return input.identity;
            })];
        const snapshot = projected ? undefined : owner.store.getEntry(reference).getSnapshot();
        const content = projected ?? snapshot?.value;
        const admission = content && decodedValues.get(content)?.admission;
        const nowMs = Date.now();
        const quotaClockCurrent = !!admission && nowMs >= admission.quotaInterval.fromMs && nowMs < admission.quotaInterval.untilMs;
        // Inside the derivation interval only source freshness can have moved: a reprojection, not a reread.
        const derivationCurrent = !!admission && nowMs >= admission.derivationInterval.fromMs && nowMs < admission.derivationInterval.untilMs;
        const inputsCurrent = !!admission && admission.inputs.length === readInputs.length
            && admission.inputs.every((identity, index) => identity === readInputs[index]);
        let workMachinesCurrent = true;
        let workAwaitingOwnRead = false;
        let changedWorkTargets: Map<string, boolean> | undefined;
        const reconcileWorkInput = (input: UsageWorkMachineInput) => {
            const changed = [...input.targets].filter(([id, target]) => workTargetNeedsAdmission(id, target));
            // A newly observed revision can supersede a checkout's witnesses.
            // Late hydration of the exact admitted Home revision changes nothing.
            return { targetChanged: changed.length > 0, canSeed: changed.every(([, target]) => !('machineId' in target)),
                machineChanged: readWorkMachineKey(input.targets) !== input.machineKey };
        };
        for (const input of admission?.workMachineInputs ?? []) {
            // Only a mirrored refusal retains Work for resolved Sessions without admitted turns.
            workAwaitingOwnRead ||= input.source !== undefined && input.sessionIds.length > 0 && input.turns === undefined;
            const { targetChanged, canSeed, machineChanged } = reconcileWorkInput(input);
            if (targetChanged) (changedWorkTargets ??= new Map()).set(input.queryKey, canSeed);
            if (machineChanged) workMachinesCurrent = false;
        }
        workMachinesCurrent &&= !changedWorkTargets;
        const current = !snapshot?.error && inputsCurrent && workMachinesCurrent;
        const admitted = current && admission?.settled === true && quotaClockCurrent;
        const sourcesCurrent = admission?.settled === true && workMachinesCurrent && admission.inputs.length === readInputs.length
            && admission.inputs.every((identity, index) => index === 0 || identity === readInputs[index]);
        return { readInputs, nowMs, admission, quotaClockCurrent, derivationCurrent, sourcesCurrent, changedWorkTargets, reconcileWorkInput,
            error: !!snapshot?.error, workAwaitingOwnRead,
            // Views may show the stripped projection while Work is pending. An
            // Action must wait for this entry's own answer after a withdrawal.
            currentSnapshot: current && !workAwaitingOwnRead || snapshot?.error ? snapshot : undefined,
            currentContent: current && !workAwaitingOwnRead ? content : undefined,
            content: admitted ? content : undefined, reusable: admitted && admission?.reusable === true };
    };
    function projectActivityPublication(slice: UsageQueryResultSlice, activity: UsageActivityAdmission | undefined,
        work?: UsageWorkSourceSnapshot) {
        if (!slice.howYouWork || !activity?.subjects.some(id =>
            sessionInputs.detailRefusal(id) instanceof UsageAccountingSliceRefusal)) return;
        const retained = readRetainedActivityAfterRefusal(sharedContext, slice, activity, sessionInputs);
        if (!retained) return;
        return {
            slice: projectRetainedUsageActivity(sharedContext, slice, slice, undefined, {
                ...retained, nowMs: activity.opened.nowMs, suppressions: owner.coachSuppressions, work,
            }),
            // Keep the selected subject for the replacement but not its old evidence.
            activitySessions: { ...activity, opened: retained.admission.opened },
        };
    }
    function replaceActivityPublication(content: ResourceContent): ResourceContent {
        const decoded = decodedValues.get(content);
        const admission = decoded?.admission;
        if (!decoded || !admission) return content;
        let activitySessions: Map<string, UsageActivityAdmission> | undefined;
        const results = decoded.value.results.map(slice => {
            const activity = admission.activitySessions.get(slice.key);
            const work = admission.workMachineInputs.find(input => input.queryKey === slice.key)?.source;
            const replacement = projectActivityPublication(slice, activity, work);
            if (!replacement) return slice;
            (activitySessions ??= new Map(admission.activitySessions)).set(slice.key, replacement.activitySessions);
            return replacement.slice;
        });
        if (!activitySessions) return content;
        const value = { ...decoded.value, results };
        const replacement = createUsageQueryResourceContent(value);
        decodedValues.set(replacement, { value, admission: { ...admission, activitySessions, reusable: false } });
        return replacement;
    }
    function replaceRefusedEvidence(sessionId: string, kind: UsageSessionEvidenceKind, origin?: string) {
        sessionEvidenceInputs = {};
        const sessionIds = new Set([sessionId]);
        const accountingRefusal = kind === 'detail' && sessionInputs.detailRefusal(sessionId) instanceof UsageAccountingSliceRefusal;
        if (accountingRefusal) for (const [key, retained] of slicesByQuery) {
            const replacement = projectActivityPublication(retained.slice, retained.activitySessions, retained.workInput?.source);
            if (replacement) slicesByQuery.set(key, { ...retained, ...replacement });
        }
        const withdraw = kind === 'work' ? owner.withdrawSessionWork(sessionIds)
            : accountingRefusal ? replaceActivityPublication : undefined;
        if (withdraw) for (const read of entryReads.values()) read.replaceRetained(withdraw);
        owner.store.replaceRetainedValues((content, refreshIfDemanded, key) => {
            const basis = decodedValues.get(content)?.admission;
            // The entry that observed the refusal is already replacing this
            // evidence. Other evidence it acquired still gets the handoff check.
            const affected = basis?.workMachineInputs.some(input => input.sessionIds.includes(sessionId))
                || kind === 'detail' && [...(basis?.activitySessions.values() ?? [])].some(activity => activity.subjects.includes(sessionId));
            if (affected && key !== origin) refreshIfDemanded();
            return withdraw?.(content) ?? content;
        });
    }

    const owner: AccountResourceOwner = {
        get coachSuppressions() { return coachSuppressions; },
        async readCoachSuppressions(read) {
            const inputs = resourceInputs;
            const previous = coachSuppressions;
            const state = await read();
            // Acknowledgement replaces both the operand and its Resource input.
            // Unrelated projection changes keep a still-current source answer.
            if (resourceInputs === inputs || coachSuppressions === previous) coachSuppressions = state;
        },
        publishCoachSuppressions(state) {
            if (sameStrictJsonValue(coachSuppressions, state)) return;
            coachSuppressions = state;
            owner.invalidate('projection-inputs');
        },
        projectionDocuments,
        history,
        retrySessionInputFailures: sessionInputs.retryFailures,
        readAccountingInstant(query) {
            const nowMs = Date.now();
            if (!query.includeAccounting) return nowMs;
            const admitted = admittedAccounting;
            const key = accountingInputKey(query);
            const previous = accountingInputs.get(key);
            if (!admitted || resolveUsageQueryPeriod(query, previous?.nowMs ?? admitted.nowMs).startMs !== resolveUsageQueryPeriod(query, nowMs).startMs) {
                if (admitted) replaceAccounting();
                admittedAccounting = { nowMs, answers: new Map() };
            }
            let input = accountingInputs.get(key);
            if (!input) {
                input = { query, identity: {} };
                accountingInputs.set(key, input);
            }
            return input.nowMs ??= admittedAccounting!.nowMs;
        },
        readAccounting(request, query, signal, includeContributions = true, includeSessionIds = false, workOnly = false, onIssued) {
            requireCurrent(sharedContext, signal);
            owner.readAccountingInstant(query);
            const inputKey = accountingInputKey(query);
            const input = accountingInputs.get(inputKey);
            // Opaque invocation-bound request closures keep their own exact transport.
            const admitted = sharedContext.readTransport ? admittedAccounting : undefined;
            // A scoped sibling wake preserves this query's pending admission;
            // replacement of its input or the whole answer map retires it.
            const isAdmitted = () => admitted && admittedAccounting?.answers === admitted.answers
                && accountingInputs.get(inputKey) === input;
            const key = getUsageAccountingReadKey(request, includeContributions, includeSessionIds, workOnly);
            const answered = admitted?.answers.get(key);
            if (answered) return answered;
            if (admitted) for (const [candidateKey, answer] of admitted.answers) {
                // A summary can drop Session membership from an admitted answer.
                // Missing membership and different detail still need their own read.
                const [queryKey, detail, sessions, compactWork = false] = JSON.parse(candidateKey) as [string, boolean, boolean, boolean?];
                if (detail !== includeContributions || includeSessionIds && !sessions || compactWork && !workOnly) continue;
                const projected = projectUsageAnalyticsResponseDemand(answer.value, JSON.parse(queryKey) as UsageAnalyticsQueryRequest, request);
                if (!projected) continue;
                let selected = projected;
                if (sessions && !includeSessionIds) {
                    const { sessionIds: _sessions, sessionMembership: _turns, ...summary } = projected;
                    selected = summary;
                }
                const projectedAnswer = { value: selected, readAtMs: answer.readAtMs };
                admitted.answers.set(key, projectedAnswer);
                return projectedAnswer;
            }
            return (async () => {
                const cancellation = mergeAbortSignals([signal, evidenceAbort.signal]);
                try {
                    // "Your apps" (D33) answers from the selected Environments' collectors, never the Agents' accounting.
                    const appEnvironmentIds = readUsageAppCallsEnvironmentIds(request.filters?.sources);
                    const value = appEnvironmentIds ? (onIssued?.(), await readUsageAppCallsAccounting({
                        execute: createFrontDoorUiActionExecutor(undefined, { serverId: sharedContext.accountLifetime.scope.serverId,
                            expectedAccountId: sharedContext.accountLifetime.scope.accountId }),
                        serverId: sharedContext.accountLifetime.scope.serverId, request, environmentIds: appEnvironmentIds,
                        readCatalog: (_modelIds, signal) => readUiUsageModelPrices(sharedContext, false, signal),
                        readOverrides: () => readUsageAppCallsPriceOverrides(sharedContext.accountLifetime.scope),
                        signal: cancellation.signal,
                    })) : await accountingReads.read(request, cancellation.signal, includeContributions, includeSessionIds, workOnly, onIssued);
                    requireCurrent(sharedContext, cancellation.signal);
                    // Borrowers of the same pending acquisition share its one admitted
                    // answer, including preparation completed by an earlier borrower.
                    const sharedAnswer = isAdmitted() ? admitted!.answers.get(key) : undefined;
                    if (sharedAnswer) return sharedAnswer;
                    const readAtMs = Date.now();
                    let result = value;
                    if (value.contributions !== undefined && (value.summary || includeContributions || includeSessionIds)) {
                        const { contributions: _rows, sessionIds: _members, sessionMembership: _turns, ...summary } = value;
                        const { summary: _basis, sessionIds: _sessionIds, ...detail } = value;
                        const membership = { sessionIds: [...new Set(value.contributions.flatMap(row => row.sessionId === null ? [] : [row.sessionId]))],
                            sessionMembership: value.sessionMembership ?? projectUsageAccountingSessionMembership(value.contributions) };
                        // Rich evidence still needs its distinct historical membership
                        // after final delivery removes the rows. Keep it on this same
                        // admitted answer, including replies from older rich Homes.
                        if (value.summary) {
                            result = includeContributions ? { ...detail, ...membership }
                                : includeSessionIds ? { ...summary, ...membership } : summary;
                            if (isAdmitted()) {
                                admitted!.answers.set(getUsageAccountingReadKey(request, false), { value: summary, readAtMs });
                                admitted!.answers.set(getUsageAccountingReadKey(request, false, true), { value: { ...summary, ...membership }, readAtMs });
                            }
                        } else result = { ...value, ...membership };
                    }
                    // A replacement during this read means the answer may predate it.
                    const answer = { value: result, readAtMs };
                    if (isAdmitted()) admitted!.answers.set(key, answer);
                    return answer;
                } finally { cancellation.dispose(); }
            })();
        },
        withdrawSessionAccess(query, refusal, origin) {
            const denied = readUsageSessionScope(query.session);
            const { code: errorCode } = refusal;
            // Public-profile preparation can be refused by its own feature decision.
            if (!denied.length || query.population === 'public_eligible_personal') return;
            // This mixed Activity read already has a typed Session refusal. Its
            // Accounting denial also settles scopes containing the entire set.
            // Home's per-Session Activity read decides the remaining subjects.
            const resolvingKnownRefusal = canReadActivityWithoutRefusedAccounting(query)
                && denied.some(id => sessionInputs.detailRefusal(id) !== undefined);
            const matchesScope = (selection: readonly string[]) => resolvingKnownRefusal
                ? denied.every(id => selection.includes(id)) : selection.some(id => denied.includes(id));
            const matches: WithdrawUsageQuery = candidate => candidate.population !== 'public_eligible_personal'
                && matchesScope(readUsageSessionScope(candidate.session));
            for (const [key, input] of accountingInputs) {
                if (matches(input.query)) accountingInputs.set(key, { ...input, identity: {} });
            }
            retireAccountingReads(request => request.population !== 'public_eligible_personal'
                && matchesScope(request.filters?.sessionIds ?? []));
            for (const [key, { slice }] of slicesByQuery) {
                if (matches(slice.requestedQuery)) slicesByQuery.delete(key);
            }
            const refusedQueryKey = getUsageQueryKey(query);
            for (const withdraw of readingAccess) withdraw.accounting(matches, errorCode, refusedQueryKey);
            if (denied.length === 1) sessionInputs.beginDetailAdmission(origin)(denied[0]!, refusal);
            replaceRetainedUsageValues(content => {
                const admitted = decodedValues.get(content);
                if (!admitted) return content;
                const { value, admission } = admitted;
                if (!value.results.some(slice => matches(slice.requestedQuery))) return content;
                const replacement = { ...value, results: value.results.map(slice => matches(slice.requestedQuery)
                    ? withdrawUsageQuerySlice(slice, errorCode) : slice) };
                const next = createUsageQueryResourceContent(replacement);
                // The stripped publication belongs to the refusal's Accounting
                // admission. Advance no identity for a slice whose facts survive.
                const fullyWithdrawn = new Set(replacement.results.filter(slice => matches(slice.requestedQuery)
                    && !canReadActivityWithoutRefusedAccounting(slice.requestedQuery)).map(slice => slice.key));
                const hasReadableEvidence = replacement.results.some(slice => !fullyWithdrawn.has(slice.key)
                    && (slice.requestedQuery.includeSessionEvidence || slice.requestedQuery.includeTranscriptEvidence
                        || slice.requestedQuery.includeWorkEvidence));
                const queryOffset = (admission?.inputs.length ?? 0) - replacement.results.length;
                const inputs = admission?.inputs.map((identity, index) => {
                    if (queryOffset > 1 && index === 1 && !hasReadableEvidence) return sessionEvidenceInputs;
                    const slice = replacement.results[index - queryOffset];
                    return slice && fullyWithdrawn.has(slice.key)
                        ? accountingInputs.get(accountingInputKey(slice.requestedQuery))?.identity ?? identity : identity;
                });
                decodedValues.set(next, { value: replacement,
                    admission: admission && inputs && { ...admission, inputs, reusable: false,
                        workMachineInputs: admission.workMachineInputs.filter(input => !fullyWithdrawn.has(input.queryKey)),
                    } });
                return next;
            });
        },
        withdrawSessionWork(sessionIds) {
            // Keep this viewer's accounting and the Work of other admitted Sessions.
            for (const [key, retained] of slicesByQuery) {
                const { slice, workInput } = retained;
                if (!workInput || !workInput.sessionIds.some(id => sessionIds.has(id))) continue;
                slicesByQuery.set(key, { ...retained, ...withdrawRetainedWorkAdmission(slice, workInput, sessionIds) });
            }
            return content => {
                const admitted = decodedValues.get(content);
                if (!admitted?.admission) return content;
                const { value, admission } = admitted;
                const affected = admission.workMachineInputs.filter(input => input.sessionIds.some(id => sessionIds.has(id)));
                if (!affected.length) return content;
                const inputs = new Map(affected.map(input => [input.queryKey, input]));
                let changed = false;
                const results = value.results.map(slice => {
                    const input = inputs.get(slice.key);
                    if (!input) return slice;
                    const next = withdrawRetainedWorkAdmission(slice, input, sessionIds);
                    inputs.set(slice.key, next.workInput);
                    changed ||= next.slice !== slice;
                    return next.slice;
                });
                if (!changed) return content;
                const replacement = { ...value, results };
                const next = createUsageQueryResourceContent(replacement);
                decodedValues.set(next, { value: replacement, admission: { ...admission, reusable: false,
                    workMachineInputs: admission.workMachineInputs.map(input => inputs.get(input.queryKey) ?? input) } });
                return next;
            };
        },
        sessionInputs,
        readSessionInput: sessionInputs.read,
        readSessionSelection: sessionInputs.readSelection,
        projectSessionSelection: sessionInputs.projectSelection,
        store: withExplicitAllowanceRefresh(createPluginUiResourceStore({ accountLifetime: lifetime, client: {
            resourceKey,
            contentIdentity: content => decodedValues.get(content)?.value,
            async readResource(reference, options) {
                const caller = acquisitionCaller;
                acquisitionCaller = undefined;
                const readContext = caller?.context ? { ...sharedContext, callerContext: caller.context } : sharedContext;
                if (typeof reference === 'string' || !('hostRead' in reference)) {
                    throw Object.assign(new Error('Unsupported host read'), { code: 'unsupported_method' });
                }
                requireCurrent(sharedContext, options?.signal);
                syncQualifiedSubscriptions();
                if (reference.hostRead === 'connectedServices.quota.get') {
                    const result = await readUiQuota(sharedContext, ConnectedServiceQuotaGetInputV1Schema.parse(reference.input), options?.signal);
                    const bytes = new TextEncoder().encode(JSON.stringify(result));
                    const digest = await computePluginUiArtifactSha256Digest(bytes);
                    requireCurrent(sharedContext, options?.signal);
                    return { contentType: 'application/json', bytes, digest };
                }
                if (reference.hostRead === 'connectedServices.pools.selection.get') {
                    const input = ConnectedServicePoolSelectionGetRequestV1Schema.parse(reference.input);
                    const result = await withUiConnectedServiceReader(readContext, options?.signal, (_readQuota, readSelection) => readSelection(input));
                    requireCurrent(sharedContext, options?.signal);
                    const bytes = new TextEncoder().encode(JSON.stringify(result));
                    const digest = computePluginUiArtifactSha256DigestV1(bytes);
                    return { contentType: 'application/json', bytes, digest };
                }
                if (reference.hostRead !== 'usage.query') throw Object.assign(new Error('Unsupported host read'), { code: 'unsupported_method' });
                const entry = owner.store.getEntry(reference);
                const entryKey = resourceKey(reference);
                let terminal: UsageEntryAccountingOutcome | undefined;
                let resolveRead!: (outcome: UsageEntryAccountingOutcome) => void;
                const entryRead: UsageEntryRead = {
                    accounting: new Promise(resolve => { resolveRead = resolve; }),
                    completion: Promise.resolve().then(finishRead),
                    signal: options?.signal,
                    replaceRetained(replace) {
                        if (entryRead.projected) entryRead.projected = replace(entryRead.projected);
                        if (!terminal?.ok) return;
                        const value = replace(terminal.value);
                        if (value === terminal.value) return;
                        terminal = { ok: true, value };
                        // Borrowers joining after a withdrawal consume the same
                        // admitted read with the owner's withdrawn facts removed.
                        entryRead.accounting = Promise.resolve(terminal);
                    },
                };
                const settle = (outcome: UsageEntryAccountingOutcome) => {
                    if (terminal) return;
                    terminal = outcome;
                    resolveRead(outcome);
                };
                entryReads.set(entryKey, entryRead);
                const cancel = () => settle({ ok: false, error: new HappyError(
                    'Usage Resource read was cancelled', false, { code: 'plugin_resource_aborted' }) });
                options?.signal?.addEventListener('abort', cancel, { once: true });
                const publishContent = (content: ResourceContent) => {
                    entryRead.projected = content;
                    options?.onProgress?.(content);
                };
                const acquire = async () => {
                const queries = normalizeUsageQueryBatchInput(reference.input).queries;
                const readDemand = [...listeners.values()].filter(watched => resourceKey(watched.reference) === resourceKey(reference))
                    .map(watched => watched.takeReadDemand());
                let withdrawn: Map<string, Readonly<{ errorCode: UsageAccountingSliceRefusal['code']; identity?: object; direct: boolean }>> | undefined;
                const withdraw = (matches: WithdrawUsageQuery, errorCode: UsageAccountingSliceRefusal['code'], refusedQueryKey: string) => {
                    for (const query of queries) if (matches(query)) {
                        const key = getUsageQueryKey(query);
                        (withdrawn ??= new Map()).set(key, {
                            errorCode, identity: accountingInputs.get(accountingInputKey(query))?.identity,
                            direct: key === refusedQueryKey,
                        });
                    }
                };
                const withdrawAccess = { accounting: withdraw };
                try {
                if (readDemand.some(demand => demand.authorityChanged)) replaceAccountInputs();
                const retained = readUsageAdmission(reference, queries);
                const { readInputs, nowMs, admission, quotaClockCurrent } = retained;
                if (retained.reusable && retained.content && (readDemand.length === 0 || readDemand.every(demand => demand.unchanged))) return retained.content;
                if (queries.some(query => query.session !== null)) readingAccess.add(withdrawAccess);
                // Keep the admitted facts, not the superseded serialized bytes,
                // in this async frame while unrelated source reads are pending.
                const { value: ownPrevious, reproject: previousReproject } = (() => {
                    const retained = entry.getSnapshot().value;
                    return { value: retained ? decodeUsageQueryResource(retained) : undefined,
                        reproject: retained ? decodedValues.get(retained)?.reproject : undefined };
                })();
                // A data wake can age an accounting batch without changing
                // its authority or operands. Retry still preserves its refusals.
                const retryRequested = ownPrevious !== undefined && readDemand.length > 0
                    && readDemand.every(demand => demand.retryFailuresOnly);
                const retryCurrentFailuresOnly = retryRequested && retained.currentSnapshot !== undefined;
                if (retryCurrentFailuresOnly) owner.retrySessionInputFailures(new Set(ownPrevious.results.filter(slice =>
                    slice.sources.some(source => (source.source === 'how_you_work' || source.source === 'work')
                        && canRetryUsageCoverageFailure(source))).map(slice => slice.key)));
                const previousByKey = new Map(ownPrevious?.results.map(slice => [slice.key, slice]));
                const ownWorkInputs = new Map(admission?.workMachineInputs.map(input => [input.queryKey, input]));
                const previousActivitySessions = new Map(admission?.activitySessions);
                const acquiredActivitySessions = new Map<string, UsageActivityAdmission>();
                const acquiredWorkWitnesses = new Map<string, (sessionId: string) => boolean>();
                const seedWorkInputs = new Map<string, Readonly<{
                    input: UsageWorkMachineInput; status?: UsageQuerySourceState['status'];
                }>>();
                const retryWork = retryRequested || caller?.kind === 'retry';
                const forceWork = caller?.kind === 'refresh'
                    || readDemand.some(demand => demand.authorityChanged || demand.reuseWorkOnWake === false && !retryWork);
                // The same Work acquisition serves a page and an exact Action.
                // A routing hint or a different set of sibling queries is not a Work input.
                const reuseAdmittedWork = (query: UsageQuery, input: UsageWorkMachineInput, turns: UsageWorkTurns) => {
                    const candidate = seedWorkInputs.get(input.queryKey);
                    const prior = candidate?.input;
                    const source = prior?.source;
                    if (!source || !prior?.basis || !input.basis || !candidate?.status
                        || candidate.status === 'pending' || candidate.status === 'not_loaded') return undefined;
                    const retryable = canRetryUsageCoverageFailure({ ...source, source: 'work' });
                    // The mounted Action can consume another entry's settled
                    // Work answer. Explicit Retry and later acquisitions of
                    // this entry's own failed answer still reopen it.
                    const borrowsSettlement = caller?.kind === 'action' && prior !== ownWorkInputs.get(input.queryKey);
                    if (retryable && (retryWork || !borrowsSettlement
                        && !readDemand.some(demand => demand.reuseWorkOnWake === true))) return undefined;
                    if (prior.basis.accountModeRevision !== input.basis.accountModeRevision
                        || prior.basis.startMs !== input.basis.startMs || prior.basis.fixedEndMs !== input.basis.fixedEndMs) return undefined;
                    if (prior.basis.sessionEvidence !== input.basis.sessionEvidence
                        && input.sessionIds.some(id => sessionInputs.workRefused(id) || sessionInputs.detailRefusal(id))) return undefined;
                    return hasSameUsageQueryWorkEvidenceMembership({ query, admittedTurns: turns, previousAdmittedTurns: prior.turns })
                        ? source : undefined;
                };
                const sharedAllowance = allowance;
                const heads = [...(sharedAllowance?.heads.values() ?? [])];
                const head: UsageAllowanceProjection = { quota: heads.map(row => row.read), sources: heads.map(row => row.state) };
                const previousSlices = queries.flatMap(query => {
                    const key = getUsageQueryKey(query);
                    const own = previousByKey.get(key);
                    const indexedSlice = slicesByQuery.get(key);
                    if (!own && indexedSlice?.activitySessions) previousActivitySessions.set(key, indexedSlice.activitySessions);
                    let slice = own ?? indexedSlice?.slice;
                    if (slice && query.includeWorkEvidence) {
                        // Equal queries share the latest Work admission even when
                        // their Accounting projections belong to different entries.
                        const indexedWork = indexedSlice?.workInput ? indexedSlice : undefined;
                        const ownWork = ownWorkInputs.get(key);
                        const witness = indexedWork?.workInput ?? ownWork;
                        if (witness && (witness === ownWork ? retained.changedWorkTargets?.get(key) !== false
                            : retained.reconcileWorkInput(witness).canSeed)) {
                            const workSlice = indexedWork?.slice ?? slice;
                            const workSource = workSlice.sources.find(source => source.source === 'work');
                            seedWorkInputs.set(key, { input: witness, status: workSource?.status });
                            if (workSlice !== slice) {
                                // A retained link and its date belong to the same Work answer.
                                const { work, workSummary, mergedOutcomes } = workSlice;
                                slice = { ...slice, work, workSummary, mergedOutcomes,
                                    sources: [...slice.sources.filter(source => source.source !== 'work'),
                                        ...(workSource ? [workSource] : [])] };
                            }
                        } else {
                            // Work from an obsolete checkout cannot seed a replacement.
                            const { work: _work, workSummary: _summary, mergedOutcomes: _outcomes, publicProfileEvidence: _profile, ...inputs } = slice;
                            slice = { ...inputs, sources: inputs.sources.filter(source => source.source !== 'work') };
                        }
                    }
                    if (query.includeQuota === false || !sharedAllowance) return slice ? [slice] : [];
                    const sibling = sharedAllowance.slices.get(getRetainedQuotaPeriodKey(query));
                    if (!slice && !sibling && !heads.length) return [];
                    const base = slice ?? { key, requestedQuery: query, shownQuery: query, sources: [], pending: false };
                    // A head can seed the current number. A matching range owns its history state.
                    const historySources = sibling?.sources ?? base.sources;
                    const retainedAllowance = mergeRetainedUsageAllowance({
                        ...head, sources: head.sources.filter(state => !historySources.some(history => history.source === state.source)),
                    }, base);
                    const merged = sibling ? mergeRetainedUsageAllowance(retainedAllowance, sibling) : retainedAllowance;
                    return [{ ...base, quota: merged.quota,
                        sources: [...base.sources.filter(source => source.source !== 'quota' && !source.source.startsWith('quota:')), ...merged.sources] }];
                });
                const previous = previousSlices.length ? { v: 1 as const, results: previousSlices } : undefined;
                const pendingSessionEvidence = {};
                const replacingRefusedEvidence = [...previousActivitySessions.values()]
                    .some(activity => activity.subjects.some(id => sessionInputs.detailRefusal(id)))
                    || [...seedWorkInputs.values()].some(({ input }) => input.sessionIds.some(id => sessionInputs.workRefused(id)
                        || sessionInputs.detailRefusal(id)));
                let reproject: UsageQueryReprojection | undefined;
                let projectionIsCurrent: (() => boolean) | undefined;
                const assertProjectionCurrent = () => {
                    requireCurrent(sharedContext, options?.signal);
                    if (projectionIsCurrent?.() === false) throw Object.assign(new Error('Usage projection admission changed'), {
                        code: 'account_encryption_currentness_changed',
                    });
                };
                let settledRead = false;
                const acquiredWorkInputs = new Map(ownWorkInputs);
                const keepContent = (content: ResourceContent, value: UsageQueryBatchResult, publishSlices = false): ResourceContent => {
                    const workMachineInputs: UsageWorkMachineInput[] = [];
                    const activitySessions = new Map<string, UsageActivityAdmission>();
                    for (const slice of value.results) {
                        const status = slice.requestedQuery.includeWorkEvidence
                            ? slice.sources.find(source => source.source === 'work')?.status : undefined;
                        // Pending and stale links belong to the seed's targets.
                        // Remember a failed replacement only on those same targets;
                        // an accounting wake cannot turn it into current PR coverage.
                        const seed = seedWorkInputs.get(slice.key)?.input;
                        const acquired = acquiredWorkInputs.get(slice.key);
                        const workInput = status === 'pending' ? seed : status === 'stale'
                            ? seed && (acquired?.targetKey === seed.targetKey && acquired.machineKey === seed.machineKey
                                ? { ...seed, turns: acquired.turns, source: acquired.source } : { ...seed, source: undefined })
                            : acquired;
                        if (workInput) workMachineInputs.push(workInput);
                        const subjects = slice.howYouWork
                            ? acquiredActivitySessions.get(slice.key) ?? previousActivitySessions.get(slice.key) : undefined;
                        if (subjects?.subjects.length) activitySessions.set(slice.key, subjects);
                        if (publishSlices) slicesByQuery.set(slice.key, { slice, workInput, activitySessions: subjects });
                    }
                    // Keep the read's initial clock basis: a held read that
                    // crosses a quota boundary cannot renew its old derivation.
                    // Lasting coverage refusals settle this input basis too.
                    // Its existing invalidation still observes changed access,
                    // keys and Session facts; retryable failures recover on reopen.
                    // The final requested sources can publish before a private
                    // Action releases its consumer and the producer tears down.
                    const settled = settledRead || value.results.every(slice => !slice.pending && !hasPendingCoachEvidence(slice));
                    // A masked sibling may settle this read without disclosing facts,
                    // but only a direct refusal can satisfy another acquisition.
                    const reusable = settled && value.results.every(slice => !slice.pending
                        && withdrawn?.get(slice.key)?.direct !== false && slice.sources.every(source => source.status !== 'pending'
                            && (source.status === 'unsupported' || (source.errorCode
                                ? !readUsageHistoryFailure({ errorCode: source.errorCode }).retryable
                                : source.status !== 'error' && !source.updateRequired))));
                    const intervals = settled ? [...new Set(value.results.flatMap(slice => slice.quota ?? []))]
                        .map(read => readQuotaInterval(read, nowMs)) : [];
                    const intersect = (pick: (interval: NonNullable<ReturnType<typeof readQuotaInterval>>) => Readonly<{ fromMs: number; untilMs: number }>) => ({
                        fromMs: Math.max(0, ...intervals.map(interval => interval ? pick(interval).fromMs : Infinity)),
                        untilMs: Math.min(Infinity, ...intervals.map(interval => interval ? pick(interval).untilMs : 0)) });
                    const quotaInterval = intersect(interval => interval.value);
                    const derivationInterval = intersect(interval => interval.derivation);
                    // Progress reaches this owner only after the accounting
                    // reader's physical-issuance barrier. Keep that same
                    // admission identity available to newly mounted bodies.
                    // The denial itself rotated the input. Publish only its
                    // stripped result against that exact authority revision.
                    const inputs = withdrawn ? readInputs.map((identity, index) => {
                        const query = queries[index - (readInputs.length - queries.length)];
                        return (query && withdrawn?.get(getUsageQueryKey(query))?.identity) ?? identity;
                    }) : replacingRefusedEvidence && !settled
                        ? readInputs.map((identity, index) => index === 1 ? admission?.inputs[1] ?? pendingSessionEvidence : identity)
                        : readInputs;
                    decodedValues.set(content, { value, ...(reproject && !withdrawn ? { reproject } : {}),
                        admission: { inputs, quotaInterval, derivationInterval, reusable, settled, workMachineInputs, activitySessions } });
                    return content;
                };
                const contentFor = async (batch: UsageQueryBatchResult, failureCode?: string): Promise<ResourceContent> => {
                    assertProjectionCurrent();
                    const current = entry.getSnapshot().value;
                    if (withdrawn) batch = { ...batch, results: batch.results.map(slice => {
                        const refusal = withdrawn?.get(slice.key);
                        return refusal && !(refusal.direct && canReadActivityWithoutRefusedAccounting(slice.requestedQuery))
                            ? withdrawUsageQuerySlice(slice, refusal.errorCode) : slice;
                    }) };
                    let custodyChanged = false;
                    if (failureCode !== undefined) {
                        const shownAdmission = current && decodedValues.get(current)?.admission;
                        const shownWork = new Map(shownAdmission?.workMachineInputs.map(input => [input.queryKey, input]));
                        const results = batch.results.map(shown => {
                            if (withdrawn?.has(shown.key) && !canReadActivityWithoutRefusedAccounting(shown.requestedQuery)) return shown;
                            let slice = shown;
                            const work = shownWork.get(shown.key);
                            let workSource = work?.source;
                            const refused = work?.sessionIds.filter(id => sessionInputs.workRefused(id) || sessionInputs.detailRefusal(id));
                            if (work && refused?.length) {
                                const repaired = withdrawRetainedWorkAdmission(slice, work, new Set(refused));
                                if (repaired.slice !== slice) {
                                    seedWorkInputs.set(shown.key, { input: repaired.workInput });
                                    acquiredWorkInputs.set(shown.key, repaired.workInput);
                                    workSource = repaired.workInput.source;
                                    slice = { ...repaired.slice, sources: repaired.slice.sources.map(source =>
                                        source.source === 'work' && workSource ? { ...source, status: workSource.status } : source) };
                                }
                            }
                            const activity = shownAdmission?.activitySessions.get(shown.key);
                            const phase = shown.sources.find(source => source.source === 'how_you_work');
                            // A distinct source failure closes only Activity still
                            // awaiting a replacement. Its own settled answer stands.
                            const acquiring = phase?.status === 'pending' || phase?.status === 'stale'
                                || acquiredActivitySessions.get(shown.key) !== activity;
                            if (activity && shown.howYouWork && acquiring
                                && (phase?.status !== 'error' || canRetainUsageReadFailure(phase.errorCode))) {
                                const retained = readRetainedActivityAfterRefusal(sharedContext, shown, activity, sessionInputs);
                                if (retained) {
                                    slice = projectRetainedUsageActivity(sharedContext, slice, shown, failureCode, {
                                        ...retained, nowMs: activity.opened.nowMs, suppressions: owner.coachSuppressions, work: workSource,
                                    });
                                    acquiredActivitySessions.delete(shown.key);
                                    previousActivitySessions.set(shown.key, retained.admission);
                                } else if (phase?.status === 'pending') {
                                    slice = projectRetainedUsageActivity(sharedContext, slice, shown, failureCode);
                                }
                            }
                            custodyChanged ||= slice !== shown;
                            return !slice.pending && !hasPendingCoachEvidence(slice) ? slice : { ...slice, pending: false,
                                sources: slice.sources.map(source => isUsageQuerySourceOutstanding(slice.requestedQuery, source)
                                    ? { ...source, status: 'error' as const, errorCode: source.source === USAGE_COACH_PREFERENCES_READ_SOURCE
                                        ? source.errorCode ?? failureCode : failureCode } : source) };
                        });
                        if (results.some((slice, index) => slice !== batch.results[index])) batch = { ...batch, results };
                        if (custodyChanged) reproject = undefined;
                    }
                    if (failureCode === undefined) {
                        // The same projection applies whether this is a new
                        // answer or an admitted read publishing after refusal.
                        const results = batch.results.map(slice => {
                            const admissions = acquiredActivitySessions.has(slice.key)
                                ? acquiredActivitySessions : previousActivitySessions;
                            const activity = admissions.get(slice.key);
                            if (!activity) return slice;
                            const work = slice.sources.find(source => source.source === 'work')?.status === 'pending'
                                ? seedWorkInputs.get(slice.key)?.input : acquiredWorkInputs.get(slice.key);
                            const replacement = projectActivityPublication(slice, activity, work?.source);
                            if (!replacement) return slice;
                            admissions.set(slice.key, replacement.activitySessions);
                            return replacement.slice;
                        });
                        if (results.some((slice, index) => slice !== batch.results[index])) {
                            batch = { ...batch, results };
                            reproject = undefined;
                        }
                    }
                    // Usage arrivals age the admitted answer; they do not revoke
                    // it. Publish completed facts with their original input basis,
                    // so Refresh/reopen can acquire the newer accounting inputs.
                    const staleAccounting = new Set(queries.filter((query, index) => readDemand.some(demand => demand.hasPendingChanges()) && query.includeAccounting
                        && readInputs[readInputs.length - queries.length + index]
                            !== accountingInputs.get(accountingInputKey(query))?.identity).map(getUsageQueryKey));
                    if (staleAccounting.size) batch = { ...batch, results: batch.results.map(slice => !staleAccounting.has(slice.key)
                        ? slice : { ...slice, sources: slice.sources.map(source => source.source === 'accounting' && source.status === 'available'
                            ? { ...source, status: 'stale' as const } : source),
                            ...(slice.comparison?.source.status === 'available'
                                ? { comparison: { ...slice.comparison, source: { ...slice.comparison.source, status: 'stale' as const } } } : {}) }) };
                    // An older in-flight batch may publish after a sibling has
                    // settled. Pending is activity, never a replacement for those facts.
                    if (allowance && batch.results.some(slice => slice.requestedQuery.includeQuota !== false)) {
                        const opened = readOpenedQuotaScope(sharedContext);
                        const admitted = new Map(opened?.sources.map(({ source, key }) =>
                            [createCanonicalJsonSigningInput(source), getQualifiedQuotaSnapshotEntry(key)]));
                        const shared = allowance;
                        batch = { ...batch, results: batch.results.map(slice => {
                            if (slice.requestedQuery.includeQuota === false) return slice;
                            const matching = shared.slices.get(getRetainedQuotaPeriodKey(slice.requestedQuery));
                            const states = new Map(matching?.sources.map(state => [state.source, state]));
                            const reads = new Map(matching?.quota?.map(read => [createCanonicalJsonSigningInput(read.source), read]));
                            const replacements = new Map<string, ConnectedServiceQuotaGetResultV1>();
                            const sources = slice.sources.map(state => {
                                if (!state.source.startsWith('quota:')) return state;
                                const key = state.source.slice('quota:'.length);
                                const sibling = reads.get(key);
                                const head = shared.heads.get(key);
                                const read = sibling ?? head?.read;
                                const admission = admitted.get(key);
                                if (!read || !admission) return state;
                                const reconciled = reconcileQuotaRead({ admitted: admission, source: read.source, previous: read,
                                    previousState: sibling ? states.get(state.source) : head?.state, revision: { kind: 'sibling', state } });
                                if (!reconciled.value) return state;
                                replacements.set(key, reconciled.value);
                                return reconciled.state!;
                            });
                            if (!replacements.size) return slice;
                            const quota = new Map(slice.quota?.map(read => [createCanonicalJsonSigningInput(read.source), read]));
                            replacements.forEach((read, key) => quota.set(key, read));
                            const { value: _values, sources: _qualified, ...aggregate } = projectUsageQuotaCoverage(
                                sources.filter(state => state.source.startsWith('quota:')).map(state => ({
                                    state, value: quota.get(state.source.slice('quota:'.length)) ?? null,
                                })), 'partial');
                            return { ...slice, quota: [...quota.values()], sources: sources.map(state => state.source === 'quota'
                                ? { source: 'quota', ...aggregate } : state) };
                        }) };
                    }
                    // Reconcile each revision against the same entry's admitted
                    // value so unrelated slices keep their selected references.
                    const currentBatch = current ? decodeUsageQueryResource(current) : undefined;
                    const value = retainUsageQueryResultReferences(batch, currentBatch, ownPrevious);
                    // Reuse the entry's content as well as its decoded value. A
                    // terminal read commonly repeats its last progress revision.
                    if (current && value === currentBatch && failureCode !== 'usage_query_result_invalid') {
                        return failureCode === undefined ? keepContent(current, currentBatch) : current;
                    }
                    if (failureCode !== undefined) {
                        const content = createUsageQueryResourceContent(value);
                        if (!custodyChanged && failureCode === 'usage_query_result_invalid') {
                            // Malformed input cannot admit this retained answer for an Action.
                            const shownAdmission = current && decodedValues.get(current)?.admission;
                            decodedValues.set(content, { value, admission: shownAdmission && { ...shownAdmission, reusable: false } });
                        } else {
                            keepContent(content, value, custodyChanged);
                            const retained = decodedValues.get(content)?.admission;
                            decodedValues.set(content, { value, admission: retained && { ...retained, reusable: false } });
                        }
                        return content;
                    }
                    allowance = retainUsageAllowance(value, allowance);
                    return keepContent(createUsageQueryResourceContent(value), value, true);
                };
                let queuedProgress: UsageQueryReprojection | null = null;
                let progressContent: Promise<void> | null = null;
                const drainProgress = (): void => {
                    if (progressContent) return;
                    // Sibling results from one delivered stream chunk settle in
                    // the same microtask turn. Consume their latest projection
                    // after those completions, before encoding any partial copy.
                    progressContent = Promise.resolve().then(async () => {
                        while (queuedProgress) {
                            const project = queuedProgress;
                            queuedProgress = null;
                            const content = await contentFor(project(options?.signal));
                            publishContent(content);
                        }
                    }).finally(() => {
                        progressContent = null;
                        // A phase can arrive after the loop observes an empty
                        // queue but before this promise releases the drain.
                        if (queuedProgress) drainProgress();
                    });
                    // The final read awaits the same drain. Observe a prompt
                    // rejection now so a slow producer cannot turn an eventual
                    // read failure into an unhandled one.
                    void progressContent.catch(() => {});
                };
                let result: UsageQueryBatchResult;
                // Reuse the admitted source snapshots for a presentation wake;
                // an explicit refresh or coalesced acquisition always wins.
                const missedProjectionOnly = readDemand.length === 0 && retained.sourcesCurrent && admission?.reusable
                    && readResourceInputChanges(admission.inputs[0]!, readInputs[0]!)?.length === 0;
                if (previousReproject && !previous?.results.some(hasPendingCoachEvidence) && !retained.changedWorkTargets && (!admission || quotaClockCurrent)
                    && (missedProjectionOnly || readDemand.length > 0 && readDemand.every(demand => demand.projectionOnly))) {
                    projectionIsCurrent = () => readDemand.length > 0
                        ? readDemand.every(demand => demand.isCurrent()) : retainedCurrentness.isCurrent();
                    assertProjectionCurrent();
                    reproject = previousReproject;
                    settledRead = true;
                    return await contentFor(reproject(options?.signal));
                }
                const retainedProjection = previousReproject && retained.sourcesCurrent && readDemand.length > 0
                    && readDemand.every(demand => demand.allowanceOnly) ? previousReproject : undefined;
                if (retainedProjection) {
                    reproject = retainedProjection;
                    projectionIsCurrent = () => readDemand.every(demand => demand.isCurrent());
                }
                try {
                    // Keep the progressive typed producer. A direct command
                    // enters Action admission once and consumes these same facts.
                    const allowanceDemands = readDemand.filter(demand => demand.allowance !== false);
                    const read = async () => {
                        if (!retainedProjection) acquiredWorkInputs.clear();
                        return await readUiUsageQueryBatch(readContext, { queries }, options?.signal, previous,
                        {
                            referenceKey: resourceKey(reference),
                            activityRead: (query, snapshot) => {
                                const key = getUsageQueryKey(query);
                                if (snapshot?.opened && snapshot.sessions) {
                                    acquiredActivitySessions.set(key, { opened: snapshot.opened, asOfMs: snapshot.asOfMs, subjects: snapshot.sessions.map(session => session.id) });
                                } else acquiredActivitySessions.delete(key);
                            },
                            previousActivity: key => previousActivitySessions.get(key),
                            retainActivity: (key, retained) => { previousActivitySessions.set(key, retained); },
                            admitWork: async (query, turns, period, readTargets) => {
                                const queryKey = getUsageQueryKey(query);
                                const basis = {
                                    startMs: period.startMs,
                                    // A rolling end is already represented by the admitted turn set.
                                    fixedEndMs: query.period.relative === undefined ? period.endMs : undefined,
                                    accountModeRevision: getAccountEncryptionModeCacheRevision(lifetime.scope.serverId),
                                    sessionEvidence: readInputs[1]!,
                                };
                                const prior = seedWorkInputs.get(queryKey)?.input;
                                // Reuse the complete admission or read a fresh Home target.
                                // A projection-only wake must not reopen Session detail.
                                const changes = prior && !forceWork ? retained.reconcileWorkInput(prior) : undefined;
                                const candidate = prior && changes && !changes.targetChanged && !changes.machineChanged
                                    ? { ...prior, basis } : undefined;
                                const work = candidate && reuseAdmittedWork(query, candidate, turns);
                                const input = work && candidate ? candidate : { ...readWorkMachineInput(queryKey, await readTargets()), basis };
                                return {
                                    targets: input.targets,
                                    retained: work,
                                    settle(source, detailRefusedDuringRead) {
                                        acquiredWorkInputs.set(input.queryKey, { ...input, turns, source });
                                        if (detailRefusedDuringRead) for (const id of readUsageWorkWitnessSessions(source)) {
                                            acquiredWorkWitnesses.set(id, detailRefusedDuringRead);
                                        }
                                    },
                                };
                            },
                            retainedProjection,
                            retryAccountingFailuresOnly: retryRequested && admission !== undefined,
                            retryQuotaFailuresOnly: retryCurrentFailuresOnly,
                            retainAllowance: readDemand.length > 0 && readDemand.every(demand => demand.allowance === false),
                            allowanceTargets: allowanceDemands.map(demand => demand.allowanceTargets)
                                .reduce(joinAllowanceReadTargets, allowanceDemands[0]?.allowanceTargets),
                            allowanceDayChange: allowanceDemands.map(demand => demand.allowanceDayChange).reduce(joinAllowanceDayChanges, allowanceDemands[0]?.allowanceDayChange),
                            onAccountingSettled: async (value, failure) => {
                                if (failure) {
                                    const fallback = await contentFor(value, 'usage_query_result_invalid');
                                    const outcome = { ok: false as const, error: failure.error, fallback };
                                    options?.onFailureContent?.(outcome.fallback);
                                    settle(outcome);
                                    return;
                                }
                                const content = await contentFor(value);
                                publishContent(content);
                                // A known withdrawal already owns this entry's replacement.
                                // The visible pending display is not that admitted answer.
                                if (!replacingRefusedEvidence) settle({ ok: true, value: content });
                            },
                            onProgress: project => {
                                // Keep the original admitted closure, rather than
                                // retaining one wrapper for every allowance wake.
                                reproject = retainedProjection ?? project;
                                queuedProgress = project;
                                drainProgress();
                                return progressContent ?? undefined;
                            },
                        });
                    };
                    if (caller?.context && caller.kind !== 'action') {
                        let admittedResult: UsageQueryBatchResult | undefined;
                        const execute = createFrontDoorActionExecute(undefined, { usageQueryRead: async () => {
                            admittedResult = await read();
                            return admittedResult;
                        } });
                        const outcome = await execute('usage.query', { queries }, { ...caller.context,
                            serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
                            signal: options?.signal });
                        requireActionSuccess(outcome);
                        if (!admittedResult) throw new HappyError('Usage query did not run', false, { code: 'usage_query_result_invalid' });
                        result = admittedResult;
                    } else result = await read();
                } catch (error) {
                    // Material refusal withdraws this private read context; a
                    // transport outage still retains the admitted projection.
                    const failure = classifyAccountStorageReadFailure(error, options?.signal) === 'encryption-material-unavailable'
                        ? Object.assign(
                            Object.defineProperty(new Error('Usage Account encryption admission is unavailable'), 'cause',
                                { value: error, writable: true, configurable: true }),
                            { code: 'plugin_resource_context_unavailable' }) : error;
                    const code = failure && typeof failure === 'object' && 'code' in failure
                        && typeof failure.code === 'string' ? failure.code : undefined;
                    const errorCode = code ?? 'usage_query_failed';
                    queuedProgress = null;
                    if (!canRetainUsageReadFailure(errorCode)) {
                        allowance = undefined;
                        owner.projectionDocuments.clear();
                        slicesByQuery.clear();
                        // The Resource must deliver the refusal before any consumer can
                        // take the previous progress as a successful terminal answer.
                        throw failure;
                    }
                    // Non-Accounting failures still settle the progress of their own read.
                    // A failed Accounting handoff already supplied its entry's fallback.
                    if (terminal?.ok !== false && !options?.signal?.aborted && lifetime.isCurrent()) {
                        await Promise.resolve(progressContent).catch(() => undefined);
                        const shown = entryRead.projected;
                        if (shown) {
                            const content = await contentFor(decodeUsageQueryResource(shown), errorCode);
                            if (content !== shown) options?.onFailureContent?.(content);
                        }
                    }
                    if (code !== undefined || options?.signal?.aborted) throw failure;
                    throw new HappyError('Usage query failed', true, { code: errorCode });
                }
                requireCurrent(sharedContext, options?.signal);
                // The final value supersedes any progress revision that has not
                // started projecting yet. Finish only the in-flight projection.
                queuedProgress = null;
                await progressContent;
                settledRead = true;
                const content = await contentFor(result);
                // Check only evidence admitted by this operation. A failure
                // retaining last-known facts cannot schedule another replacement.
                const evidenceWasRefused = [...acquiredWorkWitnesses].some(([id, detailRefused]) => sessionInputs.workRefused(id)
                    || detailRefused(id))
                    || [...acquiredActivitySessions.values()].some(activity => activity.subjects.some(id => sessionInputs.detailRefusal(id)));
                if (evidenceWasRefused) {
                    void entry.refresh({ supersede: false });
                }
                return content;
                } finally {
                    readingAccess.delete(withdrawAccess);
                    for (const demand of readDemand) demand.finish();
                }
                };
                async function finishRead(): Promise<ResourceContent> {
                    try {
                        const content = await acquire();
                        entryRead.projected = content;
                        settle({ ok: true, value: content });
                        return content;
                    } catch (error) {
                        settle({ ok: false, error });
                        throw error;
                    } finally {
                        options?.signal?.removeEventListener('abort', cancel);
                        if (entryReads.get(entryKey) === entryRead) entryReads.delete(entryKey);
                    }
                }
                return await entryRead.completion;
            },
            async watchResource(reference, listener, options) {
                requireCurrent(sharedContext, options?.signal);
                if (typeof reference === 'string' || !('hostRead' in reference)) {
                    throw Object.assign(new Error('Unsupported host read'), { code: 'unsupported_method' });
                }
                const queries = reference.hostRead === 'usage.query' ? normalizeUsageQueryBatchInput(reference.input).queries : [];
                const readsAllowance = reference.hostRead !== 'usage.query' || usageQueriesReadAllowance(queries);
                const allowanceOnlyQuery = reference.hostRead === 'usage.query' && queries.every(query => !query.includeAccounting);
                const quotaSourceKey = reference.hostRead === 'connectedServices.quota.get'
                    ? createCanonicalJsonSigningInput(ConnectedServiceQuotaGetInputV1Schema.parse(reference.input).source) : undefined;
                const readQuotaRecordIds = () => {
                    const records = readOpenedQuotaScope(sharedContext)?.sources
                        .filter(({ source }) => quotaSourceKey === undefined || createCanonicalJsonSigningInput(source) === quotaSourceKey)
                        .map(({ key, source }) => getQualifiedQuotaSnapshotEntry(key).usageRecordId
                            ?? allowance?.heads.get(createCanonicalJsonSigningInput(source))?.read.current?.recordId);
                    return records?.length ? records : [undefined];
                };
                const privateEvidence = queries.some(query => query.includeSessionEvidence || query.includeTranscriptEvidence || query.includeWorkEvidence);
                let allowanceReadDemand: boolean | undefined;
                let allowanceTargets: UsageAllowanceReadTargets | undefined;
                let allowanceDayChange: ProviderAccountUsageDayChangeV1 | undefined;
                // Keep the demand already taken by the active read; retained B
                // can stay available while its real replacement is outstanding.
                let activeReadDemand: UsageQueryReadDemand | undefined;
                let projectionOnly: boolean | undefined;
                let allowanceOnlyDemand: boolean | undefined;
                let woken = false;
                let retryFailuresOnly = false;
                let reuseWorkOnWake: boolean | undefined;
                let accountingWakeScheduled = false;
                // Disclosure withdrawals also cover socket churn. The canonical
                // finite currentness owner distinguishes those from mode changes.
                let accountModeCurrentness = captureAccountEncryptionCurrentness(lifetime.scope.serverId);
                const takeAccountModeChange = () => {
                    if (accountModeCurrentness.isCurrent()) return false;
                    accountModeCurrentness.dispose();
                    accountModeCurrentness = captureAccountEncryptionCurrentness(lifetime.scope.serverId);
                    return true;
                };
                const observe = (event: ResourceSubscriptionEvent, change?: UsageQueryInvalidation,
                    quotaRecordIds?: readonly string[], quotaSourceKeys?: readonly string[]) => {
                    retryFailuresOnly = false;
                    const accountModeChanged = takeAccountModeChange();
                    if (accountModeChanged) replaceAccountInputs();
                    if (!accountModeChanged && typeof change === 'object' && change.source === 'connected'
                        && change.changesCatchUp === true && !readNeedsRecovery(reference)) return;
                    if (!accountModeChanged && typeof change === 'object' && isUsagePresentationHomeAccountChange(change)) return;
                    if (!accountModeChanged && change === 'session-evidence' && !privateEvidence) return;
                    if (!accountModeChanged && change === 'quota-inputs' && quotaRecordIds !== undefined
                        && !readQuotaRecordIds().some(id => usageQuotaRecordChangeAffects(id, quotaRecordIds))) return;
                    if (!accountModeChanged && !readsAllowance && isAllowanceOnlyUsageInvalidation(change)) return;
                    const accountingChange = typeof change === 'object' && change.usageAccountingChange
                        ? readUsageAccountingChangeScope(change) : undefined;
                    const allowanceChanged = readsAllowance && (accountModeChanged || change === undefined || change === 'quota-inputs'
                        || change === 'quota-pool-inputs' || change === 'material-inputs'
                        || typeof change === 'object' && isUsageProjectionHomeAccountChange(change, true, readQuotaRecordIds()));
                    if (!accountModeChanged && !allowanceChanged
                        && accountingChange && !usageAccountingChangeAffectsQueries(queries, accountingChange)) return;
                    // Session/accounting evidence does not change Capacity.
                    // Material Profile/Settings/Machine inputs still invalidate
                    // through their existing state subscription below.
                    if (!accountModeChanged && (allowanceOnlyQuery || quotaSourceKey !== undefined) && (change === 'session-evidence'
                        || typeof change === 'object' && !allowanceChanged)) return;
                    // Keep acquisition demand with the existing watch record until
                    // its next read. Only this input's own changes demand quota.
                    if (allowanceChanged) {
                        const changedIds = accountModeChanged ? undefined : quotaRecordIds
                            ?? (typeof change === 'object' ? readUsageQuotaChangedRecordIds(change) : undefined);
                        const bindingServiceKeys = typeof change === 'object' ? readUsageQuotaBindingServiceKeys(change) : undefined;
                        const dayChange = typeof change === 'object' ? change.providerAccountUsageDayChange : undefined;
                        const scopedDay = dayChange && changedIds?.includes(dayChange.recordId) ? dayChange : undefined;
                        allowanceDayChange = allowanceReadDemand === true ? joinAllowanceDayChanges(allowanceDayChange, scopedDay) : scopedDay;
                        const targets = !accountModeChanged && (changedIds !== undefined || quotaSourceKeys !== undefined || bindingServiceKeys !== undefined)
                            ? { recordIds: changedIds ?? [], sourceKeys: quotaSourceKeys ?? [], bindingServiceKeys } : undefined;
                        allowanceTargets = allowanceReadDemand === true ? joinAllowanceReadTargets(allowanceTargets, targets) : targets;
                    }
                    allowanceReadDemand = allowanceReadDemand === true || allowanceChanged;
                    projectionOnly = projectionOnly !== false && !accountModeChanged
                        && (change === 'projection-inputs' || change === 'quota-projection-inputs');
                    allowanceOnlyDemand = allowanceOnlyDemand !== false && !accountModeChanged
                        && (change === 'quota-inputs' || typeof change === 'object'
                            && (isUsageQuotaHomeAccountChange(change) || allowanceOnlyQuery && allowanceChanged));
                    woken = true;
                    const accountingWake = typeof change === 'object'
                        && change.source !== 'connected' && change.source !== 'snapshot'
                        && (change.usageAccountingChange !== undefined
                            || change.feedPageConsumed === true && change.usageAccountingAffects === true)
                        && !allowanceChanged;
                    // Refresh, authority changes and transport recovery still
                    // start a new read even with the same selectors.
                    reuseWorkOnWake = reuseWorkOnWake !== false && !accountModeChanged && change !== undefined
                        && (typeof change !== 'object' || (change.source !== 'connected' && change.source !== 'snapshot'));
                    // Accounting pushes and consumed pages change freshness, not the admitted
                    // read's lifetime. Let that read settle as stale instead of
                    // feeding an endless chain of queued replacement reads.
                    if (!accountModeChanged && accountingWake && activeReadDemand) return;
                    // Projection changes retain the admitted source facts for presentation.
                    // Current reads consume their own Resource admission.
                    const content = projectionOnly === true && event.kind === 'invalidated'
                        ? owner.store.getEntry(reference).getSnapshot().value : undefined;
                    // A reconnect recovers an interrupted transport, so it cannot
                    // wait behind the pre-reconnect read it is meant to replace.
                    const notification = typeof change === 'object' && change.source === 'connected'
                        ? { kind: 'invalidated' as const, supersede: true as const }
                        : content && event.kind === 'invalidated'
                            ? { kind: 'invalidated' as const, contentIdentity: decodedValues.get(content)?.value } : event;
                    if (!accountModeChanged && accountingWake) {
                        // Committed facts in one synchronous burst invalidate now,
                        // then admit their one replacement together. Starting a read
                        // inside the first push queues a redundant pre-dispatch read.
                        if (!accountingWakeScheduled) {
                            accountingWakeScheduled = true;
                            queueMicrotask(() => {
                                if (!accountingWakeScheduled || !listeners.has(observe)) return;
                                accountingWakeScheduled = false;
                                listener(notification);
                            });
                        }
                    } else {
                        accountingWakeScheduled = false;
                        listener(notification);
                    }
                };
                listeners.set(observe, {
                    reference,
                    requestAllowanceRead(failedOnly) {
                        retryFailuresOnly = failedOnly;
                        reuseWorkOnWake = false;
                        woken = true;
                        if (!readsAllowance) return;
                        allowanceReadDemand = true; allowanceTargets = undefined; allowanceDayChange = undefined;
                        projectionOnly = false; allowanceOnlyDemand = false;
                    },
                    isAllowanceReadPending() {
                        return allowanceReadDemand === true || activeReadDemand !== undefined
                            && !activeReadDemand.unchanged && !activeReadDemand.projectionOnly && activeReadDemand.allowance !== false;
                    },
                    takeReadDemand() {
                        // A queued replacement can start after a mode withdrawal
                        // even when no later Home wake has reached this observer.
                        const authorityChanged = takeAccountModeChange();
                        const witness = accountModeCurrentness;
                        const demand: UsageQueryReadDemand = { allowance: readsAllowance ? (authorityChanged ? true : allowanceReadDemand) : false,
                            allowanceTargets: authorityChanged ? undefined : allowanceTargets,
                            allowanceDayChange: authorityChanged ? undefined : allowanceDayChange,
                            projectionOnly: !authorityChanged && projectionOnly === true, authorityChanged,
                            retryFailuresOnly: !authorityChanged && retryFailuresOnly,
                            reuseWorkOnWake,
                            allowanceOnly: !authorityChanged && allowanceOnlyDemand === true,
                            unchanged: !authorityChanged && !woken, hasPendingChanges: () => woken, isCurrent: witness.isCurrent,
                            finish() { if (activeReadDemand === demand) activeReadDemand = undefined; } };
                        activeReadDemand = demand;
                        allowanceReadDemand = undefined;
                        allowanceTargets = undefined;
                        allowanceDayChange = undefined;
                        projectionOnly = undefined;
                        allowanceOnlyDemand = undefined;
                        woken = false;
                        retryFailuresOnly = false;
                        reuseWorkOnWake = undefined;
                        return demand;
                    },
                    readsAllowance,
                    queries,
                    workInputs: () => {
                        if (reference.hostRead !== 'usage.query') return [];
                        const content = owner.store.getEntry(reference).getSnapshot().value;
                        return content ? decodedValues.get(content)?.admission?.workMachineInputs ?? [] : [];
                    },
                    ...(reference.hostRead === 'connectedServices.pools.selection.get'
                        ? { machineId: ConnectedServicePoolSelectionGetRequestV1Schema.parse(reference.input).machineId } : {}),
                });
                syncQualifiedSubscriptions();
                // Demand reattaches retained collection observations first;
                // their closed-view changes belong to this same admission.
                const admission = reference.hostRead === 'usage.query' ? readUsageAdmission(reference, queries) : undefined;
                // A settled admission whose accounting and Session inputs still stand, closed while only
                // source freshness or named quota records changed, rereads just those records (often none)
                // and reprojects the rest at this instant (P03-TAB-CONTENT-2 W8).
                const missedRecordIds = admission && !admission.reusable && readsAllowance && !admission.error
                    && admission.admission?.settled === true && admission.admission.reusable && admission.sourcesCurrent
                    && admission.derivationCurrent ? readResourceInputChanges(admission.admission.inputs[0]!, admission.readInputs[0]!) : undefined;
                if (missedRecordIds !== undefined) {
                    allowanceReadDemand = true; allowanceTargets = { recordIds: missedRecordIds, sourceKeys: [] };
                    allowanceOnlyDemand = true; projectionOnly = false;
                }
                woken ||= admission?.reusable !== true;
                const dispose = () => {
                    activeReadDemand = undefined;
                    allowanceReadDemand = undefined;
                    accountModeCurrentness.dispose();
                    listeners.delete(observe);
                    syncQualifiedSubscriptions();
                    options?.signal?.removeEventListener('abort', dispose);
                };
                options?.signal?.addEventListener('abort', dispose, { once: true });
                return { dispose, ...(admission?.reusable && admission.content
                    ? { admittedIdentity: decodedValues.get(admission.content)?.value } : {}) };
            },
        } }), (context, kind, acquire) => {
            acquisitionCaller = context || kind !== 'presentation' ? { context, kind } : undefined;
            try { return acquire(); } finally { acquisitionCaller = undefined; }
        }, (reference, failedOnly) => {
            const usageQuery = typeof reference !== 'string' && 'hostRead' in reference && reference.hostRead === 'usage.query';
            if (usageQuery && !failedOnly) {
                const queries = normalizeUsageQueryBatchInput(reference.input).queries.filter(query => query.includeAccounting
                    && (query.includeSessionEvidence || query.includeTranscriptEvidence || query.includeWorkEvidence));
                owner.retrySessionInputFailures(new Set(queries.map(getUsageQueryKey)));
            }
            // Refresh asks at a new instant. Retry preserves current sibling
            // admissions, including typed refusals, while failed work is reopened.
            if (!usageQuery || !failedOnly) replaceAccountInputs();
            const key = resourceKey(reference);
            for (const watched of listeners.values()) {
                if (resourceKey(watched.reference) === key) watched.requestAllowanceRead(failedOnly);
            }
        }, reference => [...listeners.values()].some(watched => resourceKey(watched.reference) === resourceKey(reference)
            && watched.isAllowanceReadPending()), (reference, projected) => typeof reference !== 'string' && 'hostRead' in reference
                && reference.hostRead === 'usage.query'
                ? readUsageAdmission(reference, normalizeUsageQueryBatchInput(reference.input).queries, projected)
                : { reusable: false, currentSnapshot: undefined }, (reference, entry) => {
            if (typeof reference === 'string' || !('hostRead' in reference) || reference.hostRead !== 'usage.query') return usagePresentationReady;
            const queries = normalizeUsageQueryBatchInput(reference.input).queries;
            const { reusable } = readUsageAdmission(reference, queries);
            const initial = entry.getSnapshot();
            // A retained Resource value is already admitted to this Account.
            // Present it immediately while its replacement is acquired, including
            // before physical issuance. Cold/superset accounting still waits for
            // its own admission; readiness never skips the replacement read.
            let ready = initial.value !== undefined || reusable || queries.every(query => !query.includeAccounting);
            if (!ready && sharedContext.readTransport && admittedAccounting?.answers.size) ready = queries.every(query => resolveUsagePageAccountingReads([query],
                accountingInputs.get(accountingInputKey(query))?.nowMs ?? Date.now()).every(read => {
                const demand = resolveUsageAccountingDemand(sharedContext, read.query, read.period);
                return admittedAccounting?.answers.has(getUsageAccountingReadKey(
                    demand.request, demand.includeContributions, demand.includeSessionIds, demand.workOnly)) === true;
            }));
            // A warm facade needs only the settled readiness fact. Returning a
            // shared probe releases its initial content and decoded admission.
            if (ready) return usagePresentationReady;
            return () => {
                if (ready) return true;
                const snapshot = entry.getSnapshot();
                const admission = snapshot.value && decodedValues.get(snapshot.value)?.admission;
                // This entry's producer and Resource store already guard
                // currentness and retirement before publishing a new admission.
                ready = !!admission
                    || snapshot !== initial && snapshot.pending === 'idle' && !!snapshot.error;
                return ready;
            };
        }, reference => {
            const active = entryReads.get(resourceKey(reference));
            return active?.signal?.aborted ? undefined : active;
        }),
        invalidate(homeChange, quotaRecordIds, quotaSourceKeys) {
            if (!lifetime.isCurrent()) return;
            // A replacement demanded by this wake must not join pre-wake accounting.
            // Existing borrowers retain their own publication and Account fences.
            // A consumed page can carry separate accounting and quota changes.
            const quotaChange = typeof homeChange === 'object' && isUsageProjectionHomeAccountChange(homeChange, true);
            if (typeof homeChange === 'object' && homeChange.source === 'connected' && homeChange.changesCatchUp === true) {
                // Catch-up owns changed facts. Recover interrupted transports
                // without discarding this Account's settled accounting answers.
                accountingReads.invalidate();
            } else if (homeChange === undefined || typeof homeChange === 'object' && homeChange.source === 'snapshot') {
                replaceAccountInputs();
            } else if (typeof homeChange === 'object' && !isUsagePresentationHomeAccountChange(homeChange)
                && (homeChange.usageAccountingChange !== undefined
                    || homeChange.usageAccountingAffects !== false && !isUsageQuotaHomeAccountChange(homeChange))) {
                const change = readUsageAccountingChangeScope(homeChange);
                if (!change) {
                    if (homeChange.feedPageConsumed === true || homeChange.usageAccountingChange) replaceAccounting();
                    else replaceAccountInputs();
                } else {
                    // Relevance belongs to the Account admission, including
                    // closed references and slices entering a different batch.
                    const changedRequests = new Set<string>();
                    const nowMs = Date.now();
                    for (const [key, input] of accountingInputs) {
                        if (input.nowMs === undefined || !usageAccountingChangeAffectsQueries([input.query], change)) continue;
                        for (const read of resolveUsagePageAccountingReads([input.query], input.nowMs)) {
                            changedRequests.add(getUsageAnalyticsQueryRequestKey(usageQueryToAnalyticsRequest({ ...read.query, period: read.period },
                                undefined, usageProjectScopeKeys(lifetime.scope.serverId))));
                        }
                        // Relative windows advance only for affected queries;
                        // unrelated close/reopen/rebatch keeps its admitted clock.
                        accountingInputs.set(key, { query: input.query, identity: {}, nowMs });
                    }
                    const affected = (request: UsageAnalyticsQueryRequest) => changedRequests.has(getUsageAnalyticsQueryRequestKey(request))
                        || usageAccountingChangeAffectsQueries([usageAnalyticsRequestToQuery(request)], change);
                    retireAccountingReads(affected, nowMs);
                }
            }
            if (homeChange === 'session-evidence') sessionEvidenceInputs = {};
            else if (quotaChange || typeof homeChange === 'string') replaceResourceInputs(homeChange === 'projection-inputs' ? [] : homeChange === 'quota-inputs' ? quotaRecordIds
                : typeof homeChange === 'object' ? readUsageQuotaChangedRecordIds(homeChange) : undefined, isAllowanceOnlyUsageInvalidation(homeChange));
            for (const listener of [...listeners.keys()]) listener({ version: 1, subscriptionId: 'usage-query', kind: 'invalidated', digest: INVALIDATION_DIGEST }, homeChange, quotaRecordIds, quotaSourceKeys);
        },
    };
    accountStores.set(lifetime, owner);
    const qualifiedUnwatches = new Map<string, () => void>();
    let unobserveMetadata: (() => void) | undefined;
    function syncQualifiedSubscriptions(): void {
        const allowanceDemanded = [...listeners.values()].some(watched => watched.readsAllowance);
        for (const [attach, subscription] of demandSubscriptions) {
            const demanded = subscription.allowanceOnly ? allowanceDemanded : listeners.size > 0;
            if (demanded && !subscription.detach) {
                subscription.detach = () => {};
                subscription.detach = attach();
            }
            else if (!demanded && subscription.detach) { subscription.detach(); subscription.detach = undefined; }
        }
        const scope = allowanceDemanded ? readOpenedQuotaScope(sharedContext) : null;
        const keys = new Set(scope?.sources.map(({ key }) => key) ?? []);
        // The same catalog loader serves labels and entered prices. Demand it
        // while quota is watched, including host reads without a Plans widget.
        const needsMetadata = scope && keys.size > 0 && readQuotaFeatureDecision(sharedContext, scope)?.state === 'enabled'
            && [...listeners.values()].some(watched => watched.readsAllowance && watched.queries.length > 0);
        if (needsMetadata && !unobserveMetadata) unobserveMetadata = observeConnectedMetadataCatalog(lifetime.scope);
        else if (!needsMetadata && unobserveMetadata) { unobserveMetadata(); unobserveMetadata = undefined; }
        for (const [key, dispose] of qualifiedUnwatches) {
            if (!keys.has(key)) { dispose(); qualifiedUnwatches.delete(key); }
        }
        for (const key of keys) if (!qualifiedUnwatches.has(key)) {
            let observed = getQualifiedQuotaSnapshotEntry(key);
            qualifiedUnwatches.set(key, subscribeQualifiedQuotaSnapshotEntry(key, () => {
                const next = getQualifiedQuotaSnapshotEntry(key);
                const admissionChanged = next.supported !== observed.supported || next.usageRecordId !== observed.usageRecordId;
                const settled = !next.loading && !next.refreshing;
                const changed = admissionChanged || settled && (next.error === null) !== (observed.error === null);
                const recordIds = [observed.usageRecordId, next.usageRecordId].filter((id): id is string => id !== null);
                // Beginning acquisition clears the cache's error optimistically;
                // only its settled answer can replace that error observation.
                if (admissionChanged || settled) observed = next;
                // This reader consumes admission, not the cache's acquisition
                // flags. Starting/finishing an unchanged read is not invalidation.
                if (changed) owner.invalidate('quota-inputs', recordIds.length ? recordIds : undefined);
            }));
        }
    }
    syncQualifiedSubscriptions();
    const unwatch = subscribeHomeAccountChange(event => {
        if (event.usageQueryAffects !== false && areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) {
            // Exact Session changes fence their own admission. A content-free
            // Account wake is not evidence that every loaded Session changed:
            // those versions are observed below at the existing state owner.
            // Reconnects and Sessions absent from that owner still need fresh
            // admission when the wake cannot name the changed Session.
            const privateInputsChanged = sessionInputs.invalidateForHomeChange(event);
            if (privateInputsChanged && (event.changeKinds?.includes('session') || event.sessionSystemRecords?.length)) {
                sessionEvidenceInputs = {};
            }
            syncQualifiedSubscriptions();
            const accountingUnchanged = event.usageAccountingAffects === false
                && event.source !== 'snapshot' && !event.usageAccountingChange;
            const projectionChanged = isUsageQuotaHomeAccountChange(event) || isUsageProjectionHomeAccountChange(event, true);
            // A named record outside retained inputs changes no Usage fact.
            if (accountingUnchanged && !privateInputsChanged && !projectionChanged) return;
            owner.invalidate(projectionChanged ? event
                : accountingUnchanged ? 'session-evidence' : event);
        }
    }, { reconnect: { readNotCurrent: () => [...listeners.values()].some(({ reference }) => readNeedsRecovery(reference)) } });
    const readProviderRows = () => {
        const scope = readOpenedQuotaScope(sharedContext);
        return scope ? getProviderAccountUsageCacheState().entriesByCredentialScope[scope.providerScope] : undefined;
    };
    let observedRows = readProviderRows();
    const reconcileProvider: Parameters<typeof subscribeProviderAccountUsageCache>[0] = publication => {
        const rows = readProviderRows();
        if (rows === observedRows) return;
        const previous = observedRows;
        observedRows = rows;
        // This Account publication already reached the Resource's own listener.
        if (publication === 'account-observation') return;
        // Loading and retry deadlines change no displayed fact. Observation
        // times, replacements, removals and errors retain their known record scope.
        const keys = new Set([
            ...[...(allowance?.heads.values() ?? [])].flatMap(({ read }) => read.current ? [read.current.recordId] : []),
            ...(readOpenedQuotaScope(sharedContext)?.sources.flatMap(({ key }) => {
                const id = getQualifiedQuotaSnapshotEntry(key).usageRecordId;
                return id ? [id] : [];
            }) ?? []),
        ]);
        const changedIds = [...keys].filter(key => previous?.[key]?.hadError !== rows?.[key]?.hadError
            || !sameStrictJsonValue(previous?.[key]?.snapshot, rows?.[key]?.snapshot));
        if (changedIds.length) owner.invalidate('quota-inputs', changedIds);
    };
    const unwatchProvider = whileDemanded(() => { reconcileProvider(); return subscribeProviderAccountUsageCache(reconcileProvider); }, true);
    let observedFeatures = getCachedServerFeaturesSnapshot({ serverId: lifetime.scope.serverId });
    const reconcileFeatures = () => {
        const features = getCachedServerFeaturesSnapshot({ serverId: lifetime.scope.serverId });
        if (features === observedFeatures) return;
        const scope = readOpenedQuotaScope(sharedContext);
        // Usage consumes the quota decision, not unrelated discovery fields or
        // a replacement snapshot's identity. Compare both with current settings.
        const changed = scope && scope.sources.length > 0
            && readQuotaFeatureDecision(sharedContext, scope, observedFeatures ?? { status: 'loading' })?.state
                !== readQuotaFeatureDecision(sharedContext, scope, features ?? { status: 'loading' })?.state;
        observedFeatures = features;
        if (changed) { syncQualifiedSubscriptions(); owner.invalidate('quota-inputs'); }
    };
    const unwatchFeatures = whileDemanded(() => { reconcileFeatures(); return subscribeServerFeaturesSnapshot(reconcileFeatures); }, true);
    const unwatchState = subscribeUsageQueryStateInvalidation((input, quotaSourceKeys) => {
        syncQualifiedSubscriptions();
        owner.invalidate(input, undefined, quotaSourceKeys);
    }, () => {
        const opened = readOpenedQuotaScope(sharedContext);
        const poolMachineFilters: (readonly string[])[] = [];
        const sessionMachineIds = new Set<string>();
        let includeMachineNames = false;
        // Read mounted demand and its already-admitted value from the Resource
        // owner. No acquisition or second response lifetime lives in this key.
        for (const watched of listeners.values()) {
            includeMachineNames ||= watched.queries.some(query => query.includeAccounting);
            if (!opened) continue;
            if (watched.readsAllowance && opened.state.profile.connectedAccountGroupsV4.length) {
                poolMachineFilters.push(...watched.queries.map(query => query.machines));
            }
            if (watched.machineId) sessionMachineIds.add(watched.machineId);
            for (const input of watched.workInputs()) {
                for (const id of readWorkTargetMachineIds(input.targets)) sessionMachineIds.add(id);
            }
        }
        if (!opened) return { includeMachineNames, poolMachineFilters, sessionMachineIds: [] };
        return { includeMachineNames, poolMachineFilters, sessionMachineIds: [...sessionMachineIds] };
    }, whileDemanded);
    const readEnteredPrices = () => {
        const scope = readOpenedQuotaScope(sharedContext);
        if (!scope || readQuotaFeatureDecision(sharedContext, scope)?.state !== 'enabled') return undefined;
        const presentation = getConnectedMetadataCatalog(lifetime.scope).presentation;
        // Loading is not a new price. The catalog owner retains its admission
        // while refreshing and publishes the settled record separately.
        if (presentation.status === 'loading') return undefined;
        return { status: presentation.status,
            prices: isConnectedPresentationCatalogUsableV1(presentation) ? scope.sources.map(({ source }) =>
                [source.ref, readConnectedSubscriptionMonthlyPriceV1(presentation, source.ref)]) : undefined };
    };
    let observedPrices = readEnteredPrices();
    const reconcilePrices = () => {
        const prices = readEnteredPrices();
        if (prices === undefined) return;
        const changed = !sameStrictJsonValue(prices, observedPrices);
        observedPrices = prices;
        if (changed) owner.invalidate('quota-projection-inputs');
    };
    const unwatchPrices = whileDemanded(() => { reconcilePrices(); return subscribeConnectedMetadataCatalog(reconcilePrices); }, true);
    let observedProfileScope = readRegisteredStorageState()?.profileScope;
    const unwatchSessions = whileDemanded(() => subscribeRegisteredStorageState((state, previous) => {
        const scopeChanged = !areServerAccountScopesEqual(state.profileScope, observedProfileScope);
        observedProfileScope = state.profileScope;
        const queries = [...listeners.values()].flatMap(watched => watched.queries.filter(query =>
            query.includeSessionEvidence || query.includeTranscriptEvidence || query.includeWorkEvidence));
        if (!scopeChanged && !queries.length) return;
        const delta = state.sessionListRenderableDelta;
        const ids = new Set(delta && delta !== previous?.sessionListRenderableDelta
            ? [...delta.changedSessionIds, ...delta.removedSessionIds, ...(delta.hydratedSessionIds ?? [])] : []);
        // The existing publication names changed/hydrated identities, including
        // arrivals after a cold empty list. No whole-Session-map walk is needed.
        const consumed = new Set(queries.flatMap(query => selectUsageQueryWorkEvidenceSessionIds({ query,
            sessions: [...ids].map(id => ({ id })), contributions: slicesByQuery.get(getUsageQueryKey(query))?.slice.accounting?.contributions,
            sessionMembership: readUsageAccountingSessionMembership(slicesByQuery.get(getUsageQueryKey(query))?.slice.accounting) })));
        const changedIds = [...ids].filter(id => consumed.has(id));
        const changed = sessionInputs.reconcile(changedIds, { scopeChanged,
            membershipChangedSessionIds: changedIds.filter(id => Boolean(previous?.sessions[id]) !== Boolean(state.sessions[id])),
        });
        const workChanged = [...listeners.values()].some(watched => watched.workInputs().some(input =>
            changedIds.some(id => {
                const target = input.targets.get(id);
                return target && workTargetNeedsAdmission(id, target);
            })));
        if (changed || workChanged) owner.invalidate(scopeChanged ? undefined : 'session-evidence');
    }, { sessionListRenderableDelta: true, profileScope: true }) ?? (() => {}));
    const unwatchCredentials = subscribeHomeCredentialMutations(event => {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) return;
        if (event.kind === 'credentials_set' && event.credentials
            && resolveAuthCredentialsScopeKey(event.credentials) === resolveAuthCredentialsScopeKey(sharedContext.credentials)) return;
        owner.store.dispose();
        evidenceAbort.abort();
        retainedCurrentness.dispose();
        sessionInputs.dispose();
        owner.projectionDocuments.clear();
        slicesByQuery.clear();
        allowance = undefined;
        accountStores.delete(lifetime);
        unwatch();
        unwatchProvider();
        unwatchFeatures();
        unwatchState?.();
        unwatchPrices();
        unobserveMetadata?.();
        unwatchSessions?.();
        qualifiedUnwatches.forEach(dispose => dispose());
        qualifiedUnwatches.clear();
        unwatchCredentials();
    });
    lifetime.onRetire(() => {
        owner.store.dispose();
        evidenceAbort.abort();
        retainedCurrentness.dispose();
        sessionInputs.dispose();
        owner.projectionDocuments.clear();
        slicesByQuery.clear();
        allowance = undefined;
        accountStores.delete(lifetime);
        listeners.clear();
        unwatch();
        unwatchProvider();
        unwatchFeatures();
        unwatchState?.();
        unwatchPrices();
        unobserveMetadata?.();
        unwatchSessions?.();
        qualifiedUnwatches.forEach(dispose => dispose());
        qualifiedUnwatches.clear();
        unwatchCredentials();
    });
    return owner.store;
}

// Decode once per admitted immutable Resource value so independent consumers
// select the same slice reference. No response or request lifetime lives here.
const decodedValues = new WeakMap<ResourceContent, Readonly<{
    value: UsageQueryBatchResult;
    reproject?: UsageQueryReprojection;
    admission?: Readonly<{ inputs: readonly object[]; quotaInterval: Readonly<{ fromMs: number; untilMs: number }>;
        derivationInterval: Readonly<{ fromMs: number; untilMs: number }>; reusable: boolean; settled: boolean;
        workMachineInputs: readonly UsageWorkMachineInput[]; activitySessions: ReadonlyMap<string, UsageActivityAdmission> }>;
}>>();

export function decodeUsageQueryResource(value: ResourceContent): UsageQueryBatchResult {
    const existing = decodedValues.get(value);
    if (existing) return existing.value;
    const decoded = UsageQueryBatchResultSchema.parse(JSON.parse(new TextDecoder().decode(value.bytes)));
    decodedValues.set(value, { value: decoded });
    return decoded;
}
