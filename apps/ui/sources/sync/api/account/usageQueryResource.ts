import { projectUsageAnalyticsResponseDemand } from '@happier-dev/protocol/usage/usageLeaderProjection';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { createFrontDoorActionExecute, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { USAGE_PRICE_ACTION_IDS } from '@happier-dev/protocol/usage/usageActionIdsV1';
import { getUsageAnalyticsQueryRequestKey, type UsageAnalyticsQueryRequest } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { createPluginUiResourceStore, pluginUiResourceReferenceKey, type PluginUiResourceStore, type PluginUiResourceEntry } from '@happier-dev/plugin-ui/advanced';
import type { ResourceContent, ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import { getUsageQueryBatchKey, getUsageQueryKey, normalizeUsageQuery, normalizeUsageQueryBatchInput, resolveUsageQueryPeriod, usageAnalyticsRequestToQuery, usageQueryToAnalyticsRequest, usageQueryNeedsContributionRows, type UsageQuery, type UsageQueryBatchInput } from '@happier-dev/protocol/inputs/usageQuery';
import { collectUsageWorkSources } from '@happier-dev/protocol/usage/usageWorkSources';
import { resolveUsagePageAccountingReads, resolveUsageAccountingAsOfMs, retainAccountingOnReadFailure, retainUsageQueryResultReferences, canRetainUsageReadFailure, UsageQueryBatchResultSchema, type UsageAccountingSourceSnapshot, type UsagePoolSourceSnapshot, type UsageQueryPoolSnapshot, type UsageQueryBatchResult, type UsageWorkSourceSnapshot, type UsageQuerySourceState } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { ConnectedServicePoolSelectionGetRequestV1Schema, type ConnectedServicePoolSelectionGetRequestV1, type ConnectedServicePoolSelectionGetResponseV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
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
import { createUsageAccountingReader, getUsageAccountingReadKey } from './usageAccountingReader';
import { captureAccountEncryptionCurrentness } from './apiAccountEncryptionMode';
import { classifyAccountStorageReadFailure } from '@/sync/encryption/accountStorageContext';
import { runSessionScmRpc } from '@/sync/ops/sessionScm';
import { readMachineControlTargetForSession, resolveMachineControlTargetForSessionFromState, resolveDisplayMachineIdForSessionFromState } from '@/sync/ops/sessionMachineTarget';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { projectUsageQueryWorkEvidence, selectUsageQueryWorkEvidenceSessionIds, projectUsageSessionInput } from '@/sync/domains/usage/usageWorkEvidence';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readAccountSettingsForScope } from '@/sync/domains/state/accountSettingsPersistence';
import { getConnectedMetadataCatalog, subscribeConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { observeConnectedMetadataCatalog } from '@/sync/engine/settings/connectedMetadataCatalogEngine';
import { readConnectedSubscriptionMonthlyPriceV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { projectUsageAccountingSessionMembership, readUsageAccountingSessionMembership, usageQueryNeedsSessionCandidates, projectSessionUsageWorkEvidence,
    type UsageSessionMessageEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, UsageSessionEvidenceResponseSchema, getUsageSessionEvidenceDemandKey,
    createUsageSessionEvidenceStreamDecoder,
    type UsageSessionEvidenceResponse } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { ConnectedServiceQuotaGetInputV1Schema, projectProviderAccountUsageQuotaReadV1, type ConnectedServiceQuotaGetInputV1, type ConnectedServiceQuotaGetResultV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { buildProviderAccountUsageScopeKey } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageLoadRoute';
import { getProviderAccountUsageCacheState, subscribeProviderAccountUsageCache, type ProviderAccountUsageCacheEntry } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageCache';
import { buildQualifiedQuotaSnapshotScopeKey, getQualifiedQuotaSnapshotEntry, subscribeQualifiedQuotaSnapshotEntry, type QualifiedQuotaSnapshotStoreEntry } from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { isConnectedServiceQuotaObservationFresh, wasConnectedServiceQuotaObserved } from '@happier-dev/protocol/connect/quotaObservationTime';
import { getProviderAccountUsageDerivationInterval } from '@happier-dev/protocol/connect/deriveProviderAccountUsagePace';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import { isConnectedServiceUsageCapable } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { getCachedServerFeaturesSnapshot, subscribeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveRuntimeFeatureDecisionFromSnapshot, type ServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { isTransientConnectivityError, RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { UsageModelPriceCatalogSchema, type UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { HappyError } from '@/utils/errors/errors';
import { readMachineName } from '@/utils/sessions/machineDisplayNames';
import { getUsageQueryPoolMachineSelection, isUsagePresentationHomeAccountChange, isUsageQuotaHomeAccountChange, isUsageProjectionHomeAccountChange, readUsageAccountingChangeScope, readUsageQuotaChangedRecordIds, usageQuotaRecordChangeAffects, subscribeUsageQueryStateInvalidation, usageAccountingChangeAffectsQueries } from './usageQueryInvalidation';
import type { ProviderAccountUsageProjectionDocuments } from './apiProviderAccountUsage';
import { createUsageQueryResourceContent, encodeUsageQueryResource } from './usageQueryResourceEncoding';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import { createCapturedServerReadTransport, type CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';
import { createUsageQuerySessionInputs, type SessionInputEvidence, type SessionInputReader, type SessionInputSelectionReader, type SessionInputSelectionProjector } from './usageQuerySessionInputs';
import { UsageQueryEvidencePhase } from './usageQueryEvidencePhase';
import { SessionPartsHttpError, SessionPartsInvalidResponseError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority';
import { OperationUpdateRequiredV1Schema } from '@happier-dev/protocol/compat/operationUpdateRequiredV1';
import { createUiCoachSuppressionPort } from './usageCoachSuppressions';
import type { UsageHistoryReadState } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { UsageHistoryEntry, readUsageHistoryFailure } from './usageHistoryReadState';
import type { UsageCoachSuppressionStateV1 } from '@happier-dev/protocol/usage/coach/coachActions';
import { openUsageCompactInput, persistUsageCompactInput } from './usageCompactInput';

import { projectUsageQueryBatch, projectUsageEnteredPrices, type HowYouWorkEvidenceSnapshot, type HowYouWorkReadSnapshot,
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
        sources: state.profile.connectedAccountsV4.filter(account => !shouldHideQuotaForCredentialStatus(account.status)
            && isConnectedServiceUsageCapable(account.ref.service)).map(account => ({
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

/** Reconcile B once, whether its revision came from cache, read progress or a sibling. */
function reconcileQuotaRead(input: Readonly<{
    admitted: Pick<QualifiedQuotaSnapshotStoreEntry, 'supported' | 'usageRecordId' | 'loading' | 'error'>;
    source: ConnectedServiceQuotaGetInputV1['source'];
    previous?: ConnectedServiceQuotaGetResultV1;
    previousState?: UsageQuerySourceState;
    revision: Readonly<{ kind: 'cache'; row: ProviderAccountUsageCacheEntry | undefined; nowMs: number;
        targets: Parameters<typeof projectProviderAccountUsageQuotaReadV1>[0]['targets'] }>
        | Readonly<{ kind: 'progress'; value: ConnectedServiceQuotaGetResultV1 | null; settled: boolean; errorCode?: string }>
        | Readonly<{ kind: 'sibling'; state: UsageQuerySourceState }>;
}>): Readonly<{ value: ConnectedServiceQuotaGetResultV1 | null; state?: UsageQuerySourceState;
    pending?: boolean; unavailable?: boolean; stale?: boolean }> {
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
            const state = settledState.status === 'available' && !isConnectedServiceQuotaObservationFresh({
                observedAtMs: retained.current.observedAtMs, nowMs, maxAgeMs: retained.current.staleAfterMs,
            }) ? { ...settledState, status: 'stale' as const } : settledState;
            return { value: retained, state, stale: state.status !== 'available' };
        }
        const pending = (admitted.loading || row?.loading === true)
            && (!row?.snapshot || !wasConnectedServiceQuotaObserved(row.snapshot));
        if (!row?.snapshot || row.snapshot.recordId !== admitted.usageRecordId) {
            return { value: retained ?? null, ...(retained && previousState ? { state: previousState } : {}),
                pending, unavailable: true, stale: !!retained };
        }
        const stale = admitted.error !== null || row.hadError || !isConnectedServiceQuotaObservationFresh({
            observedAtMs: row.snapshot.observedAtMs, nowMs, maxAgeMs: row.snapshot.staleAfterMs,
        });
        return { value: projectProviderAccountUsageQuotaReadV1({ input: { source: quotaSource }, current: row.snapshot, nowMs,
            targets, waitingWork: { status: 'unavailable', reason: 'read_failed' } }),
            state: wasConnectedServiceQuotaObserved(row.snapshot) ? { source, status: stale ? 'stale' : 'available', asOfMs: row.snapshot.fetchedAtMs }
                : previousState ?? { source, status: 'not_loaded' }, pending, stale };
    }
    let { value } = revision;
    const { settled, errorCode } = revision;
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
    return { value, state: { source,
        status: errorCode ? value ? 'stale' : 'error' : unobservedReplacement || retainedPace ? 'stale'
            : settled || value?.pageFacts?.historyStatus === 'complete' || value?.pageProjection || value?.history?.nextCursor === null
                ? value?.current && wasConnectedServiceQuotaObserved(value.current)
                    ? isConnectedServiceQuotaObservationFresh({ observedAtMs: value.current.observedAtMs,
                        nowMs: Date.now(), maxAgeMs: value.current.staleAfterMs }) ? 'available' : 'stale'
                    : 'partial'
                : value?.current && wasConnectedServiceQuotaObserved(value.current) ? 'stale' : 'pending',
        ...(value?.current && wasConnectedServiceQuotaObserved(value.current) ? { asOfMs: value.current.fetchedAtMs } : {}),
        ...(errorCode ? { errorCode } : {}),
    } };
}

/** Observe already-admitted B; this path never probes, decrypts or refreshes a provider. */
function readOpenedQuota(context: UsageQueryAccountContext, previous?: UsageQueryBatchResult): OpenedQuotaRead {
    const scope = readOpenedQuotaScope(context);
    if (!scope) return { status: 'unknown', errorCode: 'account_profile_unavailable' };
    if (scope.sources.length === 0) return scope.state.profile.connectedAccountsV4.length === 0
        ? { status: 'unsupported', errorCode: 'no_connected_accounts' }
        : { status: 'error', errorCode: 'connected_account_needs_reauth' };
    const decision = readQuotaFeatureDecision(context, scope);
    if (decision?.state !== 'enabled') return { status: decision?.state === 'unknown' || !decision ? 'unknown' : 'unsupported' };
    const rows = getProviderAccountUsageCacheState().entriesByCredentialScope[scope.providerScope] ?? {};
    const retainedBySource = new Map(previous?.results.flatMap(slice => slice.quota ?? [])
        .map(value => [createCanonicalJsonSigningInput(value.source), value]));
    const previousBySource = new Map(previous?.results.flatMap(slice => slice.sources)
        .filter(state => state.source.startsWith('quota:'))
        .map(state => [state.source, state]));
    const value: ConnectedServiceQuotaGetResultV1[] = [];
    const sources: UsageQuerySourceState[] = [];
    let pending = false;
    let unavailable = false;
    let stale = false;
    const nowMs = Date.now();
    for (const { source, key } of scope.sources) {
        const admitted = getQualifiedQuotaSnapshotEntry(key);
        const row = admitted.supported === true && admitted.usageRecordId ? rows[admitted.usageRecordId] : undefined;
        const sourceKey = `quota:${createCanonicalJsonSigningInput(source)}`;
        const reconciled = reconcileQuotaRead({ admitted, source,
            previous: retainedBySource.get(createCanonicalJsonSigningInput(source)), previousState: previousBySource.get(sourceKey),
            revision: { kind: 'cache', row, nowMs, targets: areServerAccountScopesEqual(scope.state.settingsScope, context.accountLifetime.scope)
                ? scope.state.settings.usagePacingTargetsV1 : undefined } });
        if (reconciled.value) value.push(reconciled.value);
        if (reconciled.state) sources.push(reconciled.state);
        pending ||= reconciled.pending === true;
        unavailable ||= reconciled.unavailable === true;
        stale ||= reconciled.stale === true;
    }
    if (value.length) {
        const clocks = value.flatMap(row => row.current && wasConnectedServiceQuotaObserved(row.current) ? [row.current.fetchedAtMs] : []);
        return { status: unavailable || pending ? 'partial' : stale ? 'stale' : 'available', value, sources,
            ...(clocks.length ? { asOfMs: Math.min(...clocks) } : {}) };
    }
    return { status: pending ? 'pending' : scope.sources.every(({ key }) => getQualifiedQuotaSnapshotEntry(key).supported === false)
        ? 'unsupported' : 'not_loaded' };
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
        if (!response.ok) throw new HappyError('Model price catalog unavailable', false, {
            status: response.status, kind: response.status === 401 || response.status === 403 ? 'auth' : 'config',
            code: response.status === 401 || response.status === 403 ? 'denied'
                : [404, 405, 501].includes(response.status) ? 'unsupported' : 'usage_prices_read_failed',
        });
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
    quotaReadOptions?: Pick<import('./apiProviderAccountUsage').ProviderAccountUsageQuotaReadOptions, 'readAllHistory' | 'includePendingWork'>) {
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
    const values = opened.map(snapshot => ({ query: snapshot.query, value: [...snapshot.value] }));
    try {
        await withUiConnectedServiceReader(context, signal, async (_quota, readSelection) => {
            await Promise.all(values.flatMap(snapshot => snapshot.value.map(async (pool, index) => {
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
                snapshot.value[index] = { ...pool, selection: await read };
                requireCurrent(context, signal);
                onProgress(values);
            })));
        });
    } catch (error) {
        requireCurrent(context, signal);
        const errorCode = readRpcErrorCode(error) ?? (error && typeof error === 'object' && 'code' in error
            && typeof error.code === 'string' ? error.code : 'connected_service_request_failed');
        for (const snapshot of values) {
            snapshot.value = snapshot.value.map(pool => pool.selection.machineId
                ? { ...pool, selection: { status: 'error', machineId: pool.selection.machineId, errorCode } } : pool);
        }
        onProgress(values);
    }
    return values;
}


/** The opened quota sources an allowance history read acquires, or null when it reads nothing. */
function readOpenedQuotaHistoryScope(context: UsageQueryAccountContext) {
    const scope = readOpenedQuotaScope(context);
    return scope?.sources.length && readQuotaFeatureDecision(context, scope)?.state === 'enabled' ? scope : null;
}

async function readOpenedQuotaHistory(context: UsageQueryAccountContext, periods: readonly NonNullable<UsageAccountingSourceSnapshot['period']>[], nowMs: number, signal?: AbortSignal,
    onProgress?: (quota: OpenedQuotaRead) => void, previous?: UsageQueryBatchResult,
    opened: OpenedQuotaRead = readOpenedQuota(context, previous), changedRecordIds?: readonly string[]): Promise<OpenedQuotaRead> {
    const scope = readOpenedQuotaHistoryScope(context);
    if (!scope) return opened;
    // Start at the existing transport batch size; the admitted B reader grows
    // subsequent pages and publishes their accepted change points progressively.
    const range = periods.length ? { startAtMs: Math.min(...periods.map(period => period.startMs ?? 0)),
        endAtMs: Math.max(...periods.map(period => period.endMs ?? nowMs)) } : undefined;
    if (range && range.endAtMs <= range.startAtMs) return { status: 'unknown', errorCode: 'quota_query_range_empty' };
    const retainedBySource = new Map(opened.value?.map(value => [createCanonicalJsonSigningInput(value.source), value]));
    const admissionBySource = new Map(scope.sources.map(({ source, key }) => [createCanonicalJsonSigningInput(source), key]));
    for (const value of previous?.results.flatMap(result => result.quota ?? []) ?? []) {
        const key = createCanonicalJsonSigningInput(value.source);
        const admissionKey = admissionBySource.get(key);
        if (!admissionKey || !canRetainQuotaRead(getQualifiedQuotaSnapshotEntry(admissionKey), value)) continue;
        const observed = retainedBySource.get(key);
        if (!observed?.current || observed.current.recordId === value.current?.recordId) retainedBySource.set(key, value);
    }
    const progressValues = scope.sources.map(({ source }) => retainedBySource.get(createCanonicalJsonSigningInput(source)) ?? null);
    const requestedIndices = scope.sources.flatMap(({ key }, index) => usageQuotaRecordChangeAffects(
        getQualifiedQuotaSnapshotEntry(key).usageRecordId ?? progressValues[index]?.current?.recordId, changedRecordIds) ? [index] : []);
    // Account reads settle independently. Keep their qualified identity even
    // when a failed read has no current facts to disclose.
    const settledBySource = new Map(opened.sources
        ?.filter(state => state.status !== 'pending' && state.status !== 'not_loaded')
        .map(state => [state.source, state]));
    const sources: UsageQuerySourceState[] = scope.sources.map(({ source }, index) => {
        const key = `quota:${createCanonicalJsonSigningInput(source)}`;
        return progressValues[index] && settledBySource.get(key) || { source: key, status: 'pending' };
    });
    const failures = new Map<number, string>();
    const projectQuota = (status: 'available' | 'partial' | 'stale' | 'error'): OpenedQuotaRead => {
        const value = progressValues.filter((row): row is ConnectedServiceQuotaGetResultV1 => row !== null);
        const clocks = value.flatMap(row => row.current && wasConnectedServiceQuotaObserved(row.current) ? [row.current.fetchedAtMs] : []);
        // A failure answering first cannot turn the still-unanswered accounts
        // into an empty/insufficient allowance result.
        const aggregateStatus = value.length ? sources.every(source => source.status === 'available') ? 'available' : status === 'available' ? 'partial' : status
            : sources.some(source => source.status === 'pending') ? 'pending'
            : failures.size ? 'error' : status;
        return { status: aggregateStatus, sources: [...sources], ...(value.length ? { value } : {}), ...(clocks.length ? { asOfMs: Math.min(...clocks) } : {}),
            ...(failures.size && !value.length ? { errorCode: [...failures.values()][0] } : {}) };
    };
    const publishProgress = (index: number, value: ConnectedServiceQuotaGetResultV1 | null, settled = false): void => {
        requireCurrent(context, signal);
        const { source, key } = scope.sources[index]!;
        const reconciled = reconcileQuotaRead({ admitted: getQualifiedQuotaSnapshotEntry(key), source,
            previous: retainedBySource.get(createCanonicalJsonSigningInput(source)), previousState: settledBySource.get(sources[index]!.source),
            revision: { kind: 'progress', value, settled, errorCode: failures.get(index) } });
        progressValues[index] = reconciled.value;
        sources[index] = reconciled.state!;
        onProgress?.(projectQuota('partial'));
    };
    // A cold admitted read is pending, not an unissued cache observation. Every
    // skipped read above has already returned a terminal reason.
    if (!opened.value?.length) onProgress?.({ status: 'pending', sources: [...sources] });
    const sourceIndices = new Map(scope.sources.map(({ source }, index) => [createCanonicalJsonSigningInput(source), index]));
    const acceptedBySource = new Map<number, ConnectedServiceQuotaGetResultV1>();
    const failSource = (index: number, error: unknown) => {
        requireCurrent(context, signal);
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code : 'quota_read_failed';
        failures.set(index, code);
        publishProgress(index, acceptedBySource.get(index) ?? null);
    };
    // The batch has one captured Home/Account lifetime. Share its existing
    // mode promise and live catalog reads instead of recapturing per source.
    try {
        await withUiConnectedServiceReader(context, signal, async read => Promise.all(requestedIndices.map(async index => {
            const { source } = scope.sources[index]!;
            try {
                const accepted = await read({ source, ...(range ? { projection: { range, resolution: 'accepted_observations' as const } } : {}) });
                acceptedBySource.set(index, accepted);
                publishProgress(index, accepted, true);
            } catch (error) { failSource(index, error); }
        })), { includePendingWork: !!range, readAllHistory: { onProgress: value => {
            const index = sourceIndices.get(createCanonicalJsonSigningInput(value.source));
            if (index === undefined) throw new Error('Quota reader returned an unrequested source');
            acceptedBySource.set(index, value);
            publishProgress(index, value);
        } } });
    } catch (error) {
        // A failure capturing the common Account applies to every source;
        // an individual provider refusal above still settles independently.
        requestedIndices.forEach(index => failSource(index, error));
    }
    requireCurrent(context, signal);
    return projectQuota(failures.size === 0 ? 'available' : progressValues.every(value => value !== null) ? 'stale'
        : progressValues.some(value => value !== null) ? 'partial' : 'error');
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
    onFailure: (sessionId: string, error: unknown) => void,
    loadBatch: (requests: readonly SessionInputLoadRequest[], signal: AbortSignal) => Promise<void>,
    onValue: (id: string, value: SessionInputEvidence | null) => void,
    onProgress?: (id: string, value: SessionInputEvidence) => void,
    admitted?: ReadonlyMap<string, SessionInputEvidence | null>, demandKey?: string, sourceReferenceKey?: string,
    demandSignal?: AbortSignal) {
    const requests: SessionInputLoadRequest[] = [];
    const reads = ids.map(sessionId => readSession(sessionId, readTranscript,
        (assertCurrent, signal, retained, publish) => new Promise((resolve, reject) => {
            requests.push({ sessionId, assertCurrent, signal, retained, publish, resolve, reject });
        }), onProgress ? value => onProgress(sessionId, value) : undefined, admitted?.get(sessionId) ?? undefined, demandKey, sourceReferenceKey,
        demandSignal,
    ).catch(error => {
        if (!demandSignal?.aborted) onFailure(sessionId, error);
        if (!(error instanceof SessionPartsHttpError) && readUsageHistoryFailure(error).retryable) throw error;
        return null;
    }).then(value => { onValue(sessionId, value); return [sessionId, value] as const; }));
    // One physical batch serves every collected Session read. It ends only when
    // each of those reads has lost all of its borrowers (or the Account retired).
    const batchAbort = new AbortController();
    let borrowed = requests.length;
    const leave = () => { if (--borrowed === 0) batchAbort.abort(); };
    for (const request of requests) {
        if (request.signal.aborted) leave();
        else request.signal.addEventListener('abort', leave, { once: true });
    }
    const loading = requests.length ? loadBatch(requests, batchAbort.signal).catch(error => {
        for (const request of requests) request.reject(error);
    }).finally(() => { for (const request of requests) request.signal.removeEventListener('abort', leave); }) : Promise.resolve();
    const [values] = await Promise.all([Promise.all(reads), loading]);
    return new Map(values);
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

function sessionEvidenceReadError(error: unknown): unknown {
    return error instanceof Error && 'httpStatus' in error && typeof error.httpStatus === 'number' && error.httpStatus >= 500
        ? new RetryableServerResponseError(error.httpStatus, 'Session input evidence unavailable') : error;
}

type SelectionInputs = Readonly<{ inputs: ReadonlyMap<string, { value: SessionInputEvidence } | { error: unknown }>;
    isInputCurrent(sessionId: string): boolean }>;

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

async function readHowYouWorkEvidence(context: UsageQueryAccountContext, query: UsageQuery,
    accounting: readonly UsageAccountingSourceSnapshot[], readSession: SessionInputReader, readSelection: SessionInputSelectionReader,
    projectSelection: SessionInputSelectionProjector,
    readAccountCurrentnessSource: () => Promise<SessionAccountCurrentnessSource>,
    nowMs: number,
    signal?: AbortSignal,
    onProgress?: (snapshots: readonly HowYouWorkReadSnapshot[], sources: readonly UsageQuerySourceState[], settled: boolean) => void,
    history?: Readonly<{ readUnconverted?: boolean; coverage(selected: ReadonlySet<string>, notRead: number): void;
        converted(sessionId: string): void; succeeded(sessionId: string): void;
        failed(code: string, sessionId?: string, retryable?: boolean): void }>): Promise<HowYouWorkReadSnapshot[]> {
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
        const input = UsageSessionEvidenceRequestSchema.parse({ nowMs, ...(readWorkFacts ? { readWorkFacts: true } : {}), requests: [{ query, ...(sessionIds ? { sessionIds } : {}),
            ...(candidateSessionIds ? { candidateSessionIds } : {}) }] });
        const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
            body: JSON.stringify(input), signal: phaseSignal };
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
                if (requests.length !== 1 || !selection || getUsageQueryKey(selection.query) !== getUsageQueryKey(query)
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
                            isCurrent: () => context.accountLifetime.isCurrent() && accountCurrentnessSource.isCurrent() });
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
            const selection = await readSelection(getUsageSessionEvidenceDemandKey(summaryQuery, nowMs), async (isInputCurrent, ownerSignal, candidates) => {
                const summary = await readSummary(summaryQuery, undefined, ownerSignal, candidates);
                return { ids: summary.body.requests[0]!.sessionIds, rows: { inputs: summary.inputs, isInputCurrent } satisfies SelectionInputs };
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
    const summaryDemandKey = getUsageSessionEvidenceDemandKey(summaryQuery, nowMs);
    // Widget output flags do not override the shared window/history read policy.
    const transcriptQuery = normalizeUsageQuery({ ...query, includeTranscriptEvidence: true });
    const transcriptDemandKey = getUsageSessionEvidenceDemandKey(transcriptQuery, nowMs);
    const readTranscript = history?.readUnconverted || readsUnconvertedTranscriptsOnOpen(query);
    let updateRequired: UsageQuerySourceState['updateRequired'];
    let projectedReadFailure: SessionPartsHttpError | undefined;
    let sessionReadFailure: ReturnType<typeof readUsageHistoryFailure> | undefined;
    const recordReadFailure = (sessionId: string, error: unknown) => {
        const failure = readUsageHistoryFailure(error);
        if (!sessionReadFailure || failure.retryable) sessionReadFailure = failure;
        history?.failed(failure.errorCode, sessionId, failure.retryable);
        if ((typeof __DEV__ !== 'undefined' && __DEV__)
            || ['1', 'true'].includes(String(process.env.EXPO_PUBLIC_DEBUG ?? '').trim().toLowerCase())) {
            // The diagnostic contains typed failure facts only, never Session identity or content.
            console.info('[usageHistory] Session evidence failure', failure);
        }
        if (error instanceof SessionPartsHttpError) updateRequired ??= error.updateRequired;
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
                            } });
                        let allPagesOpened = true;
                        let beforeSeq: number | undefined;
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
                                detail = projectSessionUsageWorkEvidence(session, readableMessages,
                                    { messagesComplete: completeMessageCoverage, messageEvidence });
                                messageEvidence = { acceptedInputs: detail.acceptedInputs, phaseEvents: detail.phaseEvents, coach: detail.coach,
                                    collaboration: detail.collaboration };
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
                        isCurrent: () => context.accountLifetime.isCurrent() && accountCurrentnessSource.isCurrent() });
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
    const project = (admitted: boolean): HowYouWorkEvidenceSnapshot[] => queries.map(query => {
        // Loaded Sessions supply demand, never an access/content fallback after
        // a fresh exact-Account admission fails or denies transcript access.
        const { sessions, detail } = projectSelection({ query, nowMs, admitted, selected,
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
            notRead: [...selected.values()].filter(value => value && (!value.completeMessageCoverage || value.workFactsPersisted === false)).length };
        history?.coverage(selectedIdSet,
            [...selected.values()].filter(value => value && canReadUnconvertedSessionHistory(value)).length);
        return { query, asOfMs: Date.now(), sessions, sessionCoverage, detail,
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
        onProgress?.(admitted || refused ? project(admitted) : [], sessionReadFailure ? sources.map(source => source.status === 'partial'
            ? { ...source, errorCode: sessionReadFailure.errorCode } : source) : sources, admitted && !query.includeTranscriptEvidence);
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
    const summaries = await readSessionInputPhase(selectedIds, false, readSession, recordReadFailure, async (requests, ownerSignal) => {
        try {
            const discovery = discovered.get(getUsageQueryKey(query));
            const inputs = new Map(discovery ? [...discovery.inputs].filter(([id]) => discovery.isInputCurrent(id)) : []);
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
                        const failure = sessionEvidenceReadError(result.error);
                        request.reject(failure);
                        continue;
                    }
                    if (result && 'value' in result) request.resolve(result.value);
                    else request.reject(new SessionPartsInvalidResponseError());
                } catch (error) { request.reject(error); }
            }
        } catch (error) {
            requireCurrent(context, ownerSignal);
            const failure = sessionEvidenceReadError(error);
            for (const request of requests) {
                // Failed replacement is not a new empty admission. Let the
                // Resource retain its admitted snapshot and expose the failure;
                // cold reads and actual refusals still withdraw unavailable facts.
                request.reject(failure);
            }
        }
    }, (id, value) => onValue(id, value, !needsTranscript(value)), undefined, undefined, summaryDemandKey, getUsageQueryKey(query), signal);
    // Private facts follow the same Usage window and admitted population.
    // Held private evidence never holds interval publication.
    if (readTranscript) await readSessionInputPhase(selectedIds.filter(id => needsTranscript(summaries.get(id))), true, readSession, recordReadFailure, async (requests, ownerSignal) => {
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
                else request.reject(result && 'error' in result ? result.error : sessionEvidenceReadError(error));
            }
        }
    }, (id, value) => onValue(id, value, true), (id, value) => { evidencePhase.select(id, value); publish(); }, summaries, transcriptDemandKey, getUsageQueryKey(query), signal);
    requireCurrent(context, signal);
    return project(true);
}

type SessionWorkSourceResult = import('@happier-dev/protocol/usage/usageWorkSources').SessionWorkSourceResult;

async function readSessionWorkEvidence(context: UsageQueryAccountContext, queries: readonly UsageQuery[],
    accounting: readonly UsageAccountingSourceSnapshot[], sessionReads: Map<string, Promise<SessionWorkSourceResult>>,
    signal?: AbortSignal): Promise<readonly UsageWorkSourceSnapshot[]> {
    return collectUsageWorkSources({ queries, accounting, sessionReads, assertCurrent: () => requireCurrent(context, signal),
        readSession: async sessionId => {
            const scope = context.accountLifetime.scope;
            if (!readMachineControlTargetForSession({ sessionId, serverId: scope.serverId, accountId: scope.accountId })) return null;
            return (method, request) => runSessionScmRpc(sessionId, method, request, scope.serverId, signal, scope.accountId);
        },
    });
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

export async function readUiUsageQueryBatch(
    context: UsageQueryAccountContext,
    input: UsageQueryBatchInput,
    signal?: AbortSignal,
    previous?: UsageQueryBatchResult,
    options?: Readonly<{
        /** Async consumers return their existing progress drain so settlement can reuse its projection. */
        onProgress?: (reproject: UsageQueryReprojection) => void | Promise<void>;
        /** Only the shared explicit Read now Action may open unconverted wide-window Sessions. */
        readUnconvertedHistory?: boolean;
        /** A wake of another Usage input does not demand replacement allowance acquisition. */
        retainAllowance?: boolean;
        /** Undefined retains full acquisition for legacy and recovery demand. */
        allowanceRecordIds?: readonly string[];
    }>,
): Promise<UsageQueryBatchResult> {
    requireCurrent(context, signal);
    const { queries } = normalizeUsageQueryBatchInput(input);
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
    const priorAccounting = new Map(previous?.results.flatMap(slice => [
        [slice.key, { value: slice.accounting, asOfMs: slice.sources.find(source => source.source === 'accounting')?.asOfMs }] as const,
        ...(slice.comparison ? [[getUsageQueryKey(slice.comparison.query), { value: slice.comparison.accounting,
            asOfMs: slice.comparison.source.asOfMs }] as const] : []),
    ]));
    const accountingAnswers = new Map<string, UsageAccountingAnswer>();
    const accountingReads = new Map<string, UsageAccountingAnswer | Promise<UsageAccountingAnswer>>();
    const snapshotForAnswer = (query: UsageQuery, answer: UsageAccountingAnswer): UsageAccountingSourceSnapshot => {
        const asOfMs = resolveUsageAccountingAsOfMs(answer.value);
        return { query, period: periods.get(getUsageQueryKey(query)), value: answer.value, status: 'available',
            ...(asOfMs === undefined ? {} : { asOfMs }) };
    };
    const accounting = new Map<string, UsageAccountingSourceSnapshot>(requests.map(query => {
        const key = getUsageQueryKey(query);
        const request = usageQueryToAnalyticsRequest({ ...query, period: periods.get(key)! }, undefined,
            usageProjectScopeKeys(context.accountLifetime.scope.serverId));
        const needsRows = usageQueryNeedsContributionRows(query);
        const needsMembership = !needsRows && (query.includeSessionEvidence || query.includeWorkEvidence);
        const workOnly = needsRows && query.includeWorkEvidence && !query.includeContributions
            && !query.includeTranscriptEvidence && !query.includeSessionEvidence;
        const read = accountOwner.readAccounting(request, query, signal, needsRows, needsMembership, workOnly);
        accountingReads.set(key, read);
        // The Account owner already admitted this exact answer. Only actual
        // acquisition starts pending when unrelated sources need another read.
        if (!(read instanceof Promise)) {
            accountingAnswers.set(key, read);
            return [key, snapshotForAnswer(query, read)] as const;
        }
        const retained = priorAccounting.get(key);
        return [key, { query, period: periods.get(key), status: 'pending' as const,
            ...(retained?.value ? { value: retained.value } : {}),
            ...(retained?.asOfMs === undefined ? {} : { asOfMs: retained.asOfMs }) } satisfies UsageAccountingSourceSnapshot] as const;
    }));
    const evidenceQueries = queries.filter(query => query.includeAccounting && query.includeSessionEvidence);
    let coachSuppressions: UsageCoachSuppressionStateV1 | undefined;
    let work: readonly UsageWorkSourceSnapshot[] = queries.map(query => ({ query, status: query.includeAccounting && query.includeWorkEvidence ? 'pending' : 'not_loaded' }));
    const sessionWorkReads = new Map<string, Promise<SessionWorkSourceResult>>();
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
    let mcpCatalog: McpServerCatalogSnapshotV1 | undefined;
    let mcpCatalogRead: Promise<McpServerCatalogSnapshotV1> | undefined;
    let quota: OpenedQuotaRead = readOpenedQuota(context, previous);
    let pools: readonly UsagePoolSourceSnapshot[] = readOpenedUsagePools(context, queries);
    const priorSlices = new Map(previous?.results.map(slice => [slice.key, slice]));
    let admittedPrevious = previous;
    // All effects share this read's lifetime; snapshots are published directly
    // into its entry, never cached or rerun just to advance independent sources.
    const compose = (projectionSignal: AbortSignal | undefined): UsageQueryBatchResult => {
        requireCurrent(context, projectionSignal);
        quota = projectUsageEnteredPrices(quota, context.accountLifetime.scope);
        return projectUsageQueryBatch({ context, queries, accountingNowMs, accounting, priorAccounting, calendarQueryKeys, previous, admittedPrevious,
            prepareAccounting(snapshot, prepare) {
                const answer = accountingAnswers.get(getUsageQueryKey(snapshot.query));
                const retained = answer?.prepared;
                const prepared = prepare(retained ? { ...snapshot, value: retained.value, priceProjection: retained.priceProjection,
                    agentCalendarAccounting: retained.agentCalendarAccounting, delivery: retained.delivery } : snapshot);
                if (answer) answer.prepared = prepared;
                return prepared;
            },
            work, howYouWork, howYouWorkSourcesByQuery, settledHowYouWorkQueries, evidenceQueries, quota, pools, priorSlices, mcpCatalog, coachSuppressions,
            sourceLocations: Object.values(readOpenedQuotaScope(context)?.state.machines ?? {}).flatMap(machine => {
                const displayLocation = readMachineName(machine);
                return displayLocation ? [{ machineId: machine.id, displayLocation }] : [];
            }) });
    };
    let projectionPending = true;
    let progress: void | Promise<void> = undefined;
    const reproject: UsageQueryReprojection = projectionSignal => {
        const batch = compose(projectionSignal);
        admittedPrevious = batch;
        projectionPending = false;
        return batch;
    };
    const publish = (): void => {
        projectionPending = true;
        if (!options?.onProgress) return;
        // The Resource already coalesces source progress while native encoding
        // settles. Compose only the revisions that its existing drain consumes.
        progress = options.onProgress(reproject);
    };
    // Available preference-backed facts can progress while another source's
    // read remains pending. The Account settings owner remains the authority.
    const readNightHours = () => {
        const state = readRegisteredStorageState();
        return readAccountSettingsForScope({ scope: context.accountLifetime.scope,
            focusedScope: state?.settingsScope, focusedSettings: state?.settings ?? settingsDefaults }).usageNightHoursV1;
    };
    let observedNightHours = readNightHours();
    const unwatchNightHours = options?.onProgress ? subscribeRegisteredStorageState(() => {
        if (!context.accountLifetime.isCurrent() || signal?.aborted) return;
        const next = readNightHours();
        if (sameStrictJsonValue(observedNightHours, next)) return;
        observedNightHours = next;
        publish();
    }, { settingsScope: true, settings: ['usageNightHoursV1'] }) : undefined;
    try {
        publish();
        const accountingTasks = new Map(requests.map(query => [getUsageQueryKey(query), (async () => {
        let snapshot: UsageAccountingSourceSnapshot;
        try {
            const read = accountingReads.get(getUsageQueryKey(query))!;
            if (!(read instanceof Promise)) return;
            const answer = await read;
            accountingAnswers.set(getUsageQueryKey(query), answer);
            snapshot = snapshotForAnswer(query, answer);
        } catch (error) {
            requireCurrent(context, signal);
            const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'usage_query_failed';
            // Malformed wire is a typed admission failure, not a usable partial
            // source. The Resource still owns retaining its last valid bytes.
            if (errorCode === 'usage_query_result_invalid') throw error;
            if (!canRetainUsageReadFailure(errorCode)) throw error;
            const retained = priorAccounting.get(getUsageQueryKey(query));
            // Detail/Work membership must see the same retained accounting as
            // aggregation, rather than shrinking to the currently hydrated Sessions.
            snapshot = retainAccountingOnReadFailure({ query, period: periods.get(getUsageQueryKey(query)), status: 'error', errorCode },
                retained?.value, retained?.asOfMs)!;
        }
        requireCurrent(context, signal);
        accounting.set(getUsageQueryKey(query), snapshot);
        publish();
        })()]));
        await Promise.all([
        (async () => {
            if (!evidenceQueries.length) return;
            coachSuppressions = await createUiCoachSuppressionPort(context, signal,
                async () => (await readSessionCurrentness()).read()).read();
            requireCurrent(context, signal);
            publish();
        })(),
        ...accountingTasks.values(),
        ...queries.map(async (query, index) => {
            if (!query.includeAccounting || !query.includeWorkEvidence) return;
            // Each slice needs only its own contributions. Native Session reads
            // are still shared across slices within this one Action admission.
            await accountingTasks.get(getUsageQueryKey(query));
            requireCurrent(context, signal);
            const sources = await readSessionWorkEvidence(context, [query], [...accounting.values()], sessionWorkReads, signal);
            work = work.map((source, sourceIndex) => sourceIndex === index
                ? { ...sources[0]!, ...(sources[0]!.status === 'error' ? {} : { asOfMs: accountingNowMs }) } : source);
            publish();
        }),
        ...evidenceQueries.map(async query => {
            // Current accounting owns historical dimension membership. A held
            // comparison or sibling query must not delay this slice's detail.
            await accountingTasks.get(getUsageQueryKey(query));
            requireCurrent(context, signal);
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
                            howYouWorkByQuery.set(key, snapshots[0]);
                            howYouWork = [...howYouWorkByQuery.values()];
                        }
                        publish();
                    }, { readUnconverted: options?.readUnconvertedHistory,
                        coverage: (selected, notRead) => readUsageHistoryEntry(accountOwner, query).coverage(selected,
                            readsUnconvertedTranscriptsOnOpen(query) ? 0 : notRead),
                        converted: id => readUsageHistoryEntry(accountOwner, query).converted(id),
                        succeeded: id => readUsageHistoryEntry(accountOwner, query).succeeded(id),
                        failed: (code, id, retryable) => readUsageHistoryEntry(accountOwner, query).failed(code, id, retryable) });
            } catch (error) {
                requireCurrent(context, signal);
                if (!isTransientConnectivityError(error)) throw error;
                const key = getUsageQueryKey(query);
                const errorCode = 'usage_session_evidence_read_failed';
                readUsageHistoryEntry(accountOwner, query).failed(errorCode);
                // Keep any actual partial admission/refusal already published.
                // Otherwise the shared aggregation owner retains the prior facts.
                howYouWorkByQuery.set(key, { ...(howYouWorkByQuery.get(key) ?? { query }), errorCode });
                howYouWork = [...howYouWorkByQuery.values()];
                howYouWorkSourcesByQuery.set(key, (howYouWorkSourcesByQuery.get(key) ?? []).map(source =>
                    source.status === 'pending' ? { ...source, status: 'error', errorCode } : source));
                settledHowYouWorkQueries.add(key);
                publish();
                return;
            }
            // Binding advice and its catalog admission are one private-evidence
            // result. Unrelated quota/history reads must not hold them back.
            const admittedSnapshot = snapshots[0]!;
            if (admittedSnapshot.detail?.coach?.detail?.mcpUsage?.length) {
                mcpCatalogRead ??= import('./apiMcpServerCatalog').then(({ readMcpServerCatalog }) =>
                    readMcpServerCatalog(context.accountLifetime.scope, signal, () => requireCurrent(context, signal)));
                mcpCatalog = await mcpCatalogRead;
                requireCurrent(context, signal);
            }
            howYouWorkByQuery.set(getUsageQueryKey(query), admittedSnapshot);
            howYouWork = [...howYouWorkByQuery.values()];
            settledHowYouWorkQueries.add(getUsageQueryKey(query));
            publish();
        }),
        (async () => {
            // Acquisition follows the changed input, independently of whether
            // its retained observation is complete, stale, unavailable or failed.
            if (!options?.retainAllowance) {
                const settled = await readOpenedQuotaHistory(context, queries.filter(query => query.includeQuotaHistory).map(query => periods.get(getUsageQueryKey(query))!), accountingNowMs, signal,
                    value => { quota = value; publish(); }, previous, quota, options?.allowanceRecordIds);
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
        return projectionPending || !admittedPrevious ? reproject(signal) : admittedPrevious;
    } finally {
        sessionCurrentnessClosed = true;
        unwatchNightHours?.();
        // Construction is only a module import and local observation capture;
        // never await a pending private network read during teardown.
        await sessionCurrentness?.then(source => source.dispose(), () => undefined);
    }

}

type UsageQueryInvalidation = HomeAccountChangeEvent | 'session-evidence' | 'quota-inputs' | 'projection-inputs';
type UsageQueryReadDemand = Readonly<{
    allowance: boolean | undefined;
    allowanceRecordIds?: readonly string[];
    projectionOnly: boolean;
    authorityChanged: boolean;
    /** Nothing reached this watch since its previous read, whose bytes are therefore still current. */
    unchanged: boolean;
    isCurrent(): boolean;
    finish(): void;
}>;

/** Activity comes from this watch's admitted demand, independently of retained allowance facts. */
export type UsageQueryResourceEntry = Omit<PluginUiResourceEntry, 'refresh'> & Readonly<{
    refresh(options?: Readonly<{ supersede?: boolean; callerContext?: ActionExecutorContext }>): ReturnType<PluginUiResourceEntry['refresh']>;
    /** Only the canonical Usage Action port calls this after admission. */
    acquire(callerContext: ActionExecutorContext): ReturnType<PluginUiResourceEntry['refresh']>;
    isAllowanceReadPending(): boolean;
}>;
type UsageQueryResourceStore = Omit<PluginUiResourceStore, 'getEntry'> & Readonly<{
    getEntry(reference: Parameters<PluginUiResourceStore['getEntry']>[0], callerContext?: ActionExecutorContext): UsageQueryResourceEntry;
}>;

/** Explicit recovery replaces this entry's read; ordinary push wakes stay coalesced. */
function withExplicitAllowanceRefresh(store: PluginUiResourceStore,
    withCaller: <T>(callerContext: ActionExecutorContext | undefined, admitted: boolean, acquire: () => T) => T,
    requestFresh: (reference: Parameters<PluginUiResourceStore['getEntry']>[0]) => void,
    isAllowanceReadPending: (reference: Parameters<PluginUiResourceStore['getEntry']>[0]) => boolean): UsageQueryResourceStore {
    return Object.freeze<UsageQueryResourceStore>({
        ...store,
        getEntry(reference, callerContext) {
            const entry = store.getEntry(reference);
            let initialCaller = callerContext;
            const subscribe: UsageQueryResourceEntry['subscribe'] = (listener, live) => {
                const caller = initialCaller;
                initialCaller = undefined;
                return withCaller(caller, false, () => entry.subscribe(listener, live));
            };
            const refresh: UsageQueryResourceEntry['refresh'] = options => {
                initialCaller = undefined;
                // Ordinary acquisition joins admitted facts and still settles on
                // failure or retirement. Manual Refresh asks for a new answer.
                return withCaller(options?.callerContext, false, () => {
                    if (options?.supersede === false) return entry.refresh(options);
                    requestFresh(reference);
                    return entry.refresh({ supersede: true });
                });
            };
            return Object.freeze<UsageQueryResourceEntry>({
                ...entry,
                subscribe,
                refresh,
                acquire(context) {
                    initialCaller = undefined;
                    return withCaller(context, true, () => entry.refresh({ supersede: false }));
                },
                isAllowanceReadPending: () => entry.getSnapshot().pending !== 'idle' && isAllowanceReadPending(reference),
                select(projection, selector) {
                    const selection = entry.select(projection, selector);
                    return Object.freeze({ ...selection,
                        subscribe(listener: () => void, live: boolean) {
                            const caller = initialCaller;
                            initialCaller = undefined;
                            return withCaller(caller, false, () => selection.subscribe(listener, live));
                        },
                        refresh: async () => { await refresh(); } });
                },
            });
        },
    });
}
type UsageAccountingAnswer = {
    readonly value: Awaited<ReturnType<typeof queryUsageAnalytics>>;
    /** Protocol validates the prepared operand, cost basis and overrides before reuse. */
    prepared?: PreparedUsageAccountingSnapshot;
};
type AccountResourceOwner = Readonly<{ store: UsageQueryResourceStore; invalidate(event?: UsageQueryInvalidation): void; readSessionInput: SessionInputReader;
    readSessionSelection: SessionInputSelectionReader;
    projectSessionSelection: SessionInputSelectionProjector;
    history: Map<string, UsageHistoryEntry>;
    /** The instant this read resolves its accounting windows at. */
    readAccountingInstant(query: UsageQuery): number;
    readAccounting(request: Parameters<typeof queryUsageAnalytics>[1], query: UsageQuery, signal?: AbortSignal,
        includeContributions?: boolean, includeSessionIds?: boolean, workOnly?: boolean): UsageAccountingAnswer | Promise<UsageAccountingAnswer>;
    projectionDocuments: ProviderAccountUsageProjectionDocuments }>;
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
    const entry = readUsageHistoryEntry(usageHistoryOwner(context), input.query);
    const notify = () => options?.onProgress?.(entry.state);
    entry.listeners.add(notify);
    let removeCancellation: (() => void) | undefined;
    try {
        if (!entry.pending) {
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
                    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                        ? error.code : 'usage_history_read_failed';
                    entry.publish({ ...entry.state, status: controller.signal.aborted ? 'cancelled' : 'partial',
                        ...(controller.signal.aborted ? {} : { errorCode: entry.state.errorCode ?? code }) });
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
    // Closed accounting views do not consume Session/private input changes.
    // Private views retain their own input identity and refresh when reopened.
    let sessionEvidenceInputs = resourceInputs;
    const accountingInputs = new Map<string, { query: UsageQuery; identity: object; nowMs: number }>();
    let retainedCurrentness = captureAccountEncryptionCurrentness(lifetime.scope.serverId);
    const replaceAccounting = () => {
        resourceInputs = {};
        sessionEvidenceInputs = resourceInputs;
        retainedCurrentness.dispose();
        retainedCurrentness = captureAccountEncryptionCurrentness(lifetime.scope.serverId);
        admittedAccounting = undefined;
        accountingInputs.clear();
        accountingReads.invalidate();
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
        return value;
    };
    const projectionDocuments: ProviderAccountUsageProjectionDocuments = new Map();
    const history: AccountResourceOwner['history'] = new Map();
    // Allowances belong to this Account, not a page's accounting batch. Keep
    // their latest Resource revision across navigation, including zero views.
    // New query ranges still read their own history; these facts seed the body
    // until that replacement answers, rather than claiming its range is read.
    let allowance: Pick<UsageQueryBatchResult['results'][number], 'key' | 'requestedQuery' | 'shownQuery' | 'quota' | 'sources' | 'pending'> | undefined;
    // Queries move between route batches as visible widgets register. These
    // are the same Account Resource's admitted slices, independent of batch membership.
    // Keep private evidence and selector state beside accounting so a changed
    // widget demand cannot retire only part of the same query's admission.
    const slicesByQuery = new Map<string, UsageQueryBatchResult['results'][number]>();
    const sessionInputs = createUsageQuerySessionInputs({ lifetime, signal: evidenceAbort.signal,
        assertCurrent: () => requireCurrent(sharedContext, evidenceAbort.signal) });
    const listeners = new Map<(event: ResourceSubscriptionEvent, change?: UsageQueryInvalidation) => void, Readonly<{
        reference: Parameters<PluginUiResourceStore['getEntry']>[0];
        takeReadDemand(): UsageQueryReadDemand;
        isAllowanceReadPending(): boolean;
        requestAllowanceRead(): void;
        queries: readonly UsageQuery[];
        previous(): UsageQueryBatchResult | undefined;
        machineId?: string;
    }>>();
    const demandSubscriptions = new Map<() => () => void, (() => void) | undefined>();
    const whileDemanded = (attach: () => () => void) => {
        demandSubscriptions.set(attach, undefined);
        return () => { demandSubscriptions.get(attach)?.(); demandSubscriptions.delete(attach); };
    };
    const resourceKey = (reference: Parameters<PluginUiResourceStore['getEntry']>[0]) => {
        if (typeof reference !== 'string' && 'hostRead' in reference && reference.hostRead === 'usage.query') {
            return JSON.stringify(['host', 'usage.query', getUsageQueryBatchKey(reference.input)]);
        }
        return pluginUiResourceReferenceKey(reference, null);
    };
    // subscribe/refresh synchronously starts readResource. Only that start
    // captures this operation's caller; joining admitted work leaves no origin.
    let acquisitionCaller: Readonly<{ context: ActionExecutorContext; admitted: boolean }> | undefined;
    // Read and watch consume the same Account admission. The watch can name
    // its retained digest so establishment converges after its mandatory read,
    // without scheduling a second read of those same admitted inputs.
    const readUsageAdmission = (reference: Parameters<PluginUiResourceStore['getEntry']>[0], queries: readonly UsageQuery[]) => {
        if (!retainedCurrentness.isCurrent()) replaceAccounting();
        // Relative windows advance at the local-day boundary even while closed.
        for (const query of queries) owner.readAccountingInstant(query);
        const readInputs = [resourceInputs,
            ...(queries.some(query => query.includeSessionEvidence || query.includeTranscriptEvidence || query.includeWorkEvidence)
                ? [sessionEvidenceInputs] : []), ...queries.map(query => {
                const key = getUsageQueryKey(query);
                let admitted = accountingInputs.get(key);
                if (!admitted) { admitted = { query, identity: {}, nowMs: Date.now() }; accountingInputs.set(key, admitted); }
                return admitted.identity;
            })];
        const snapshot = owner.store.getEntry(reference).getSnapshot();
        const content = snapshot.value;
        const admission = content && decodedValues.get(content)?.admission;
        const nowMs = Date.now();
        const quotaClockCurrent = !!admission && nowMs >= admission.quotaInterval.fromMs && nowMs < admission.quotaInterval.untilMs;
        const admitted = !snapshot.error && admission?.inputs.length === readInputs.length
            && admission.inputs.every((identity, index) => identity === readInputs[index]) && quotaClockCurrent;
        return { readInputs, nowMs, admission, quotaClockCurrent,
            content: admitted ? content : undefined, reusable: admitted && admission?.reusable === true };
    };
    const owner: AccountResourceOwner = {
        projectionDocuments,
        history,
        readAccountingInstant(query) {
            const nowMs = Date.now();
            if (!query.includeAccounting) return nowMs;
            const admitted = admittedAccounting;
            const key = getUsageQueryKey(query);
            const previous = accountingInputs.get(key);
            if (!admitted || resolveUsageQueryPeriod(query, previous?.nowMs ?? admitted.nowMs).startMs !== resolveUsageQueryPeriod(query, nowMs).startMs) {
                if (admitted) replaceAccounting();
                admittedAccounting = { nowMs, answers: new Map() };
            }
            let input = accountingInputs.get(key);
            if (!input) {
                input = { query, identity: {}, nowMs: admittedAccounting!.nowMs };
                accountingInputs.set(key, input);
            }
            return input.nowMs;
        },
        readAccounting(request, query, signal, includeContributions = true, includeSessionIds = false, workOnly = false) {
            requireCurrent(sharedContext, signal);
            owner.readAccountingInstant(query);
            const inputKey = getUsageQueryKey(query);
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
                // Keys were serialized by this owner. Private detail and Session
                // membership remain exact even when displayed output is narrower.
                const [queryKey, detail, sessions, compactWork = false] = JSON.parse(candidateKey) as [string, boolean, boolean, boolean?];
                if (detail !== includeContributions || sessions !== includeSessionIds || compactWork && !workOnly) continue;
                const projected = projectUsageAnalyticsResponseDemand(answer.value, JSON.parse(queryKey) as UsageAnalyticsQueryRequest, request);
                if (!projected) continue;
                const projectedAnswer = { value: projected };
                admitted.answers.set(key, projectedAnswer);
                return projectedAnswer;
            }
            return (async () => {
                const cancellation = mergeAbortSignals([signal, evidenceAbort.signal]);
                try {
                    const value = await accountingReads.read(request, cancellation.signal, includeContributions, includeSessionIds, workOnly);
                    requireCurrent(sharedContext, cancellation.signal);
                    // Borrowers of the same pending acquisition share its one admitted
                    // answer, including preparation completed by an earlier borrower.
                    const sharedAnswer = isAdmitted() ? admitted!.answers.get(key) : undefined;
                    if (sharedAnswer) return sharedAnswer;
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
                                admitted!.answers.set(getUsageAccountingReadKey(request, false), { value: summary });
                                admitted!.answers.set(getUsageAccountingReadKey(request, false, true), { value: { ...summary, ...membership } });
                            }
                        } else result = { ...value, ...membership };
                    }
                    // A replacement during this read means the answer may predate it.
                    const answer = { value: result };
                    if (isAdmitted()) admitted!.answers.set(key, answer);
                    return answer;
                } finally { cancellation.dispose(); }
            })();
        },
        readSessionInput: sessionInputs.read,
        readSessionSelection: sessionInputs.readSelection,
        projectSessionSelection: sessionInputs.projectSelection,
        store: withExplicitAllowanceRefresh(createPluginUiResourceStore({ accountLifetime: lifetime, client: {
            resourceKey,
            async readResource(reference, options) {
                const caller = acquisitionCaller;
                acquisitionCaller = undefined;
                const readContext = caller ? { ...sharedContext, callerContext: caller.context } : sharedContext;
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
                    const result = await withUiConnectedServiceReader(sharedContext, options?.signal, (_readQuota, readSelection) => readSelection(input));
                    requireCurrent(sharedContext, options?.signal);
                    const bytes = new TextEncoder().encode(JSON.stringify(result));
                    const digest = computePluginUiArtifactSha256DigestV1(bytes);
                    return { contentType: 'application/json', bytes, digest };
                }
                if (reference.hostRead !== 'usage.query') throw Object.assign(new Error('Unsupported host read'), { code: 'unsupported_method' });
                const entry = owner.store.getEntry(reference);
                const queries = normalizeUsageQueryBatchInput(reference.input).queries;
                const readDemand = [...listeners.values()].filter(watched => resourceKey(watched.reference) === resourceKey(reference))
                    .map(watched => watched.takeReadDemand());
                try {
                if (readDemand.some(demand => demand.authorityChanged)) replaceAccounting();
                const retained = readUsageAdmission(reference, queries);
                const { readInputs, nowMs, admission, quotaClockCurrent } = retained;
                if (retained.content && readDemand.length > 0 && readDemand.every(demand => demand.unchanged)) return retained.content;
                // Keep the admitted facts, not the superseded serialized bytes,
                // in this async frame while unrelated source reads are pending.
                const { value: ownPrevious, digest: ownPreviousDigest, reproject: previousReproject } = (() => {
                    const retained = entry.getSnapshot().value;
                    return { value: retained ? decodeUsageQueryResource(retained) : undefined, digest: retained?.digest,
                        reproject: retained ? decodedValues.get(retained)?.reproject : undefined };
                })();
                const previousByKey = new Map(ownPrevious?.results.map(slice => [slice.key, slice]));
                const previousSlices = queries.flatMap(query => {
                    const key = getUsageQueryKey(query);
                    const slice = previousByKey.get(key) ?? slicesByQuery.get(key);
                    return slice ? [slice] : [];
                });
                const priorBatch = previousSlices.length ? { v: 1 as const, results: previousSlices } : undefined;
                const sharedAllowance = allowance;
                const previous = priorBatch && sharedAllowance ? { ...priorBatch, results: priorBatch.results.map(slice => ({
                    ...slice, quota: sharedAllowance.quota,
                    sources: [...slice.sources.filter(source => source.source !== 'quota' && !source.source.startsWith('quota:')),
                        ...sharedAllowance.sources],
                })) } : priorBatch ?? (sharedAllowance ? { v: 1 as const, results: [sharedAllowance] } : undefined);
                let reproject: UsageQueryReprojection | undefined;
                let projectionIsCurrent: (() => boolean) | undefined;
                const assertProjectionCurrent = () => {
                    requireCurrent(sharedContext, options?.signal);
                    if (projectionIsCurrent?.() === false) throw Object.assign(new Error('Usage projection admission changed'), {
                        code: 'account_encryption_currentness_changed',
                    });
                };
                let settledRead = false;
                const keepContent = (content: ResourceContent, value: UsageQueryBatchResult): ResourceContent => {
                    // Keep the read's initial clock basis: a held read that
                    // crosses a quota boundary cannot renew its old derivation.
                    // Failed or incomplete sources keep their existing reopen
                    // recovery; only a settled admission can skip reacquisition.
                    const reusable = settledRead && value.results.every(slice => !slice.pending
                        && slice.sources.every(source => source.status !== 'error' && source.status !== 'pending'
                            && (!source.errorCode || source.status === 'unsupported') && !source.updateRequired));
                    const intervals = settledRead ? [...new Set(value.results.flatMap(slice => slice.quota ?? []))]
                        .map(read => readQuotaInterval(read, nowMs)) : [];
                    const quotaInterval = { fromMs: Math.max(0, ...intervals.map(interval => interval?.fromMs ?? Infinity)),
                        untilMs: Math.min(Infinity, ...intervals.map(interval => interval?.untilMs ?? 0)) };
                    decodedValues.set(content, { value, ...(reproject ? { reproject } : {}),
                        ...(settledRead ? { admission: { inputs: readInputs, quotaInterval, reusable } } : {}) });
                    return content;
                };
                const contentFor = async (batch: UsageQueryBatchResult): Promise<ResourceContent> => {
                    assertProjectionCurrent();
                    requireCurrent(sharedContext, options?.signal);
                    // An older in-flight batch may publish after a sibling has
                    // settled. Pending is activity, never a replacement for those facts.
                    if (allowance) {
                        const opened = readOpenedQuotaScope(sharedContext);
                        const admitted = new Map(opened?.sources.map(({ source, key }) =>
                            [createCanonicalJsonSigningInput(source), getQualifiedQuotaSnapshotEntry(key)]));
                        const states = new Map(allowance.sources.map(state => [state.source, state]));
                        const reads = new Map(allowance.quota?.map(read => [createCanonicalJsonSigningInput(read.source), read]));
                        batch = { ...batch, results: batch.results.map(slice => {
                            const replacements = new Map<string, ConnectedServiceQuotaGetResultV1>();
                            const sources = slice.sources.map(state => {
                                if (!state.source.startsWith('quota:')) return state;
                                const key = state.source.slice('quota:'.length);
                                const read = reads.get(key);
                                const admission = admitted.get(key);
                                if (!read || !admission) return state;
                                const reconciled = reconcileQuotaRead({ admitted: admission, source: read.source, previous: read,
                                    previousState: states.get(state.source), revision: { kind: 'sibling', state } });
                                if (!reconciled.value) return state;
                                replacements.set(key, reconciled.value);
                                return reconciled.state!;
                            });
                            if (!replacements.size) return slice;
                            const quota = new Map(slice.quota?.map(read => [createCanonicalJsonSigningInput(read.source), read]));
                            replacements.forEach((read, key) => quota.set(key, read));
                            const qualified = sources.filter(state => state.source.startsWith('quota:'));
                            const status = qualified.every(state => state.status === 'available') ? 'available' as const
                                : qualified.some(state => state.status === 'stale') ? 'stale' as const : 'partial' as const;
                            const clocks = qualified.flatMap(state => state.asOfMs === undefined ? [] : [state.asOfMs]);
                            const settledSources = sources.map(state => state.source === 'quota'
                                ? { ...state, status, ...(clocks.length ? { asOfMs: Math.min(...clocks) } : {}) } : state);
                            return { ...slice, quota: [...quota.values()], sources: settledSources };
                        }) };
                    }
                    const first = batch.results.find(slice => slice.requestedQuery.includeQuotaHistory) ?? batch.results[0];
                    // A current-only sibling cannot replace the Account's richer admitted history.
                    if (first && (!allowance?.requestedQuery.includeQuotaHistory || first.requestedQuery.includeQuotaHistory)) allowance = { key: first.key, requestedQuery: first.requestedQuery, shownQuery: first.shownQuery,
                        quota: first.quota, sources: first.sources.filter(source => source.source === 'quota' || source.source.startsWith('quota:')),
                        pending: first.sources.some(source => (source.source === 'quota' || source.source.startsWith('quota:')) && source.status === 'pending') };
                    for (const slice of batch.results) slicesByQuery.set(slice.key, slice);
                    const current = entry.getSnapshot().value;
                    // Reconcile each revision against the same entry's admitted
                    // value so unrelated slices keep their selected references.
                    const currentBatch = current ? decodeUsageQueryResource(current) : undefined;
                    const value = retainUsageQueryResultReferences(batch, currentBatch, ownPrevious);
                    // Reuse the entry's content as well as its decoded value. A
                    // terminal read commonly repeats its last progress revision.
                    if (current && value === currentBatch) return keepContent(current, currentBatch);
                    const encoded = encodeUsageQueryResource(value);
                    const bytes = encoded.bytes;
                    const digest = await computePluginUiArtifactSha256Digest(bytes);
                    assertProjectionCurrent();
                    if (current?.digest === digest) return keepContent(current, currentBatch!);
                    // The existing transport digest already proves a return to
                    // the settled value; do not deep-compare that whole slice.
                    const admittedValue = digest === ownPreviousDigest && ownPrevious ? ownPrevious : value;
                    const content = createUsageQueryResourceContent(admittedValue, bytes, digest);
                    return keepContent(content, admittedValue);
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
                            options?.onProgress?.(content);
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
                if (previousReproject && (!admission || quotaClockCurrent)
                    && readDemand.length > 0 && readDemand.every(demand => demand.projectionOnly)) {
                    projectionIsCurrent = () => readDemand.every(demand => demand.isCurrent());
                    assertProjectionCurrent();
                    reproject = previousReproject;
                    settledRead = true;
                    return await contentFor(reproject(options?.signal));
                }
                try {
                    // Keep the progressive typed producer. A direct command
                    // enters Action admission once and consumes these same facts.
                    const allowanceDemands = readDemand.filter(demand => demand.allowance !== false);
                    const read = async () => await readUiUsageQueryBatch(readContext, { queries }, options?.signal, previous,
                        {
                            retainAllowance: readDemand.length > 0 && readDemand.every(demand => demand.allowance === false),
                            allowanceRecordIds: allowanceDemands.length > 0 && allowanceDemands.every(demand => demand.allowanceRecordIds !== undefined)
                                ? [...new Set(allowanceDemands.flatMap(demand => demand.allowanceRecordIds!))] : undefined,
                            onProgress: project => {
                                reproject = project;
                                queuedProgress = project;
                                drainProgress();
                                return progressContent ?? undefined;
                            },
                        });
                    if (caller && !caller.admitted) {
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
                        ? Object.assign(new Error('Usage Account encryption admission is unavailable', { cause: error }),
                            { code: 'plugin_resource_context_unavailable' }) : error;
                    const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined;
                    if (typeof code === 'string' && !canRetainUsageReadFailure(code)) {
                        allowance = undefined;
                        owner.projectionDocuments.clear();
                        slicesByQuery.clear();
                    }
                    throw failure;
                }
                requireCurrent(sharedContext, options?.signal);
                // The final value supersedes any progress revision that has not
                // started materializing yet. Finish only the in-flight digest.
                queuedProgress = null;
                await progressContent;
                settledRead = true;
                return await contentFor(result);
                } finally { for (const demand of readDemand) demand.finish(); }
            },
            async watchResource(reference, listener, options) {
                requireCurrent(sharedContext, options?.signal);
                if (typeof reference === 'string' || !('hostRead' in reference)) {
                    throw Object.assign(new Error('Unsupported host read'), { code: 'unsupported_method' });
                }
                const queries = reference.hostRead === 'usage.query' ? normalizeUsageQueryBatchInput(reference.input).queries : [];
                const allowanceOnly = reference.hostRead === 'usage.query' && queries.every(query => !query.includeAccounting);
                const quotaSourceKey = reference.hostRead === 'connectedServices.quota.get'
                    ? createCanonicalJsonSigningInput(ConnectedServiceQuotaGetInputV1Schema.parse(reference.input).source) : undefined;
                const readQuotaRecordIds = () => {
                    const records = readOpenedQuotaScope(sharedContext)?.sources
                        .filter(({ source }) => quotaSourceKey === undefined || createCanonicalJsonSigningInput(source) === quotaSourceKey)
                        .map(({ key, source }) => getQualifiedQuotaSnapshotEntry(key).usageRecordId
                            ?? allowance?.quota?.find(read => createCanonicalJsonSigningInput(read.source) === createCanonicalJsonSigningInput(source))?.current?.recordId);
                    return records?.length ? records : [undefined];
                };
                const privateEvidence = queries.some(query => query.includeSessionEvidence || query.includeTranscriptEvidence || query.includeWorkEvidence);
                let allowanceReadDemand: boolean | undefined;
                let allowanceRecordIds: readonly string[] | undefined;
                // Keep the demand already taken by the active read; retained B
                // can stay available while its real replacement is outstanding.
                let activeReadDemand: UsageQueryReadDemand | undefined;
                let projectionOnly: boolean | undefined;
                // Closed private demand checks its consumed bases on admission.
                // Other live Usage watches do not keep this private read active.
                if (privateEvidence) {
                    const privateQueries = queries.filter(query => query.includeSessionEvidence
                        || query.includeTranscriptEvidence || query.includeWorkEvidence);
                    const ids = privateQueries.some(query => query.session === null) ? undefined
                        : privateQueries.flatMap(query => typeof query.session === 'string' ? [query.session] : query.session ?? []);
                    if (sessionInputs.reconcile(ids)) owner.invalidate('session-evidence');
                }
                let woken = false;
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
                const observe = (event: ResourceSubscriptionEvent, change?: UsageQueryInvalidation) => {
                    const accountModeChanged = takeAccountModeChange();
                    if (accountModeChanged) replaceAccounting();
                    if (!accountModeChanged && typeof change === 'object' && isUsagePresentationHomeAccountChange(change)) return;
                    if (!accountModeChanged && change === 'session-evidence' && !privateEvidence) return;
                    const accountingChange = typeof change === 'object' && change.usageAccountingChange
                        ? readUsageAccountingChangeScope(change) : undefined;
                    if (!accountModeChanged && accountingChange && !usageAccountingChangeAffectsQueries(queries, accountingChange)) return;
                    // Session/accounting evidence does not change Capacity.
                    // Material Profile/Settings/Machine inputs still invalidate
                    // through their existing state subscription below.
                    if (!accountModeChanged && (allowanceOnly || quotaSourceKey !== undefined) && (change === 'session-evidence'
                        || typeof change === 'object' && !isUsageProjectionHomeAccountChange(change, true, readQuotaRecordIds()))) return;
                    // Keep acquisition demand with the existing watch record until
                    // its next read. Only this input's own changes demand quota.
                    const allowanceChanged = accountModeChanged || change === undefined || change === 'quota-inputs'
                        || typeof change === 'object' && isUsageProjectionHomeAccountChange(change, true, readQuotaRecordIds());
                    if (allowanceChanged) {
                        const changedIds = !accountModeChanged && typeof change === 'object' ? readUsageQuotaChangedRecordIds(change) : undefined;
                        allowanceRecordIds = allowanceReadDemand === true
                            ? allowanceRecordIds === undefined || changedIds === undefined ? undefined : [...new Set([...allowanceRecordIds, ...changedIds])]
                            : changedIds;
                    }
                    allowanceReadDemand = allowanceReadDemand === true || allowanceChanged;
                    projectionOnly = projectionOnly !== false && !accountModeChanged && change === 'projection-inputs';
                    woken = true;
                    // Presentation inputs keep the admitted source facts fresh.
                    // The matching digest is only the store's existing continuity
                    // hint: it still rereads and publishes the changed projection.
                    const digest = projectionOnly === true && event.kind === 'invalidated'
                        ? owner.store.getEntry(reference).getSnapshot().digest : undefined;
                    const notification = digest && event.kind === 'invalidated' ? { ...event, digest } : event;
                    if (!accountModeChanged && typeof change === 'object' && change.usageAccountingChange) {
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
                    requestAllowanceRead() { allowanceReadDemand = true; allowanceRecordIds = undefined; projectionOnly = false; woken = true; },
                    isAllowanceReadPending() {
                        return allowanceReadDemand === true || activeReadDemand !== undefined
                            && !activeReadDemand.unchanged && !activeReadDemand.projectionOnly && activeReadDemand.allowance !== false;
                    },
                    takeReadDemand() {
                        // A queued replacement can start after a mode withdrawal
                        // even when no later Home wake has reached this observer.
                        const authorityChanged = takeAccountModeChange();
                        const witness = accountModeCurrentness;
                        const demand: UsageQueryReadDemand = { allowance: authorityChanged ? true : allowanceReadDemand,
                            allowanceRecordIds: authorityChanged ? undefined : allowanceRecordIds,
                            projectionOnly: !authorityChanged && projectionOnly === true, authorityChanged,
                            unchanged: !authorityChanged && !woken, isCurrent: witness.isCurrent,
                            finish() { if (activeReadDemand === demand) activeReadDemand = undefined; } };
                        activeReadDemand = demand;
                        allowanceReadDemand = undefined;
                        allowanceRecordIds = undefined;
                        projectionOnly = undefined;
                        woken = false;
                        return demand;
                    },
                    queries,
                    previous: () => {
                        if (reference.hostRead !== 'usage.query') return undefined;
                        const content = owner.store.getEntry(reference).getSnapshot().value;
                        return content ? decodeUsageQueryResource(content) : undefined;
                    },
                    ...(reference.hostRead === 'connectedServices.pools.selection.get'
                        ? { machineId: ConnectedServicePoolSelectionGetRequestV1Schema.parse(reference.input).machineId } : {}),
                });
                syncQualifiedSubscriptions();
                // Demand reattaches retained collection observations first;
                // their closed-view changes belong to this same admission.
                const admission = reference.hostRead === 'usage.query' ? readUsageAdmission(reference, queries) : undefined;
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
                return { dispose, ...(admission?.reusable && admission.content ? { admittedDigest: admission.content.digest } : {}) };
            },
        } }), (context, admitted, acquire) => {
            acquisitionCaller = context ? { context, admitted } : undefined;
            try { return acquire(); } finally { acquisitionCaller = undefined; }
        }, reference => {
            if (typeof reference !== 'string' && 'hostRead' in reference && reference.hostRead === 'usage.query') {
                const queries = normalizeUsageQueryBatchInput(reference.input).queries.filter(query => query.includeAccounting
                    && (query.includeSessionEvidence || query.includeTranscriptEvidence || query.includeWorkEvidence));
                sessionInputs.retryFailures(new Set(queries.map(getUsageQueryKey)));
            }
            // An explicit refresh asks the server again at a new instant.
            replaceAccounting();
            const key = resourceKey(reference);
            for (const watched of listeners.values()) {
                if (resourceKey(watched.reference) === key) watched.requestAllowanceRead();
            }
        }, reference => [...listeners.values()].some(watched => resourceKey(watched.reference) === resourceKey(reference)
            && watched.isAllowanceReadPending())),
        invalidate(homeChange) {
            if (!lifetime.isCurrent()) return;
            // A replacement demanded by this wake must not join pre-wake accounting.
            // Existing borrowers retain their own publication and Account fences.
            // Session, quota-input and projection wakes change no server answer.
            const quotaChange = typeof homeChange === 'object' && (isUsageQuotaHomeAccountChange(homeChange)
                || homeChange.usageAccountingAffects === false && isUsageProjectionHomeAccountChange(homeChange, true));
            if (homeChange === undefined || typeof homeChange === 'object' && !quotaChange && !isUsagePresentationHomeAccountChange(homeChange)) {
                const change = typeof homeChange === 'object' ? readUsageAccountingChangeScope(homeChange) : undefined;
                if (!change) replaceAccounting();
                else {
                    // Relevance belongs to the Account admission, including
                    // closed references and slices entering a different batch.
                    const changedRequests = new Set<string>();
                    const nowMs = Date.now();
                    for (const [key, input] of accountingInputs) {
                        if (!usageAccountingChangeAffectsQueries([input.query], change)) continue;
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
                    if (admittedAccounting) {
                        const answers = admittedAccounting.answers;
                        for (const key of answers.keys()) {
                            const [queryKey] = JSON.parse(key) as [string];
                            const request = JSON.parse(queryKey) as UsageAnalyticsQueryRequest;
                            if (affected(request)) answers.delete(key);
                        }
                        // A pending pre-change answer cannot re-enter admission;
                        // keep unaffected answers at the same accounting instant.
                        admittedAccounting = { nowMs, answers };
                    }
                    accountingReads.invalidate(affected);
                }
            } else if (homeChange === 'session-evidence') sessionEvidenceInputs = {};
            else if (quotaChange || typeof homeChange === 'string') resourceInputs = {};
            for (const listener of [...listeners.keys()]) listener({ version: 1, subscriptionId: 'usage-query', kind: 'invalidated', digest: INVALIDATION_DIGEST }, homeChange);
        },
    };
    accountStores.set(lifetime, owner);
    const qualifiedUnwatches = new Map<string, () => void>();
    let unobserveMetadata: (() => void) | undefined;
    function syncQualifiedSubscriptions(): void {
        for (const [attach, detach] of demandSubscriptions) {
            if (listeners.size > 0 && !detach) {
                demandSubscriptions.set(attach, () => {});
                demandSubscriptions.set(attach, attach());
            }
            else if (listeners.size === 0 && detach) { detach(); demandSubscriptions.set(attach, undefined); }
        }
        const scope = readOpenedQuotaScope(sharedContext);
        const keys = new Set(listeners.size ? scope?.sources.map(({ key }) => key) : []);
        // The same catalog loader serves labels and entered prices. Demand it
        // while quota is watched, including host reads without a Plans widget.
        const needsMetadata = scope && keys.size > 0 && readQuotaFeatureDecision(sharedContext, scope)?.state === 'enabled'
            && [...listeners.values()].some(watched => watched.queries.length > 0);
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
                // Beginning acquisition clears the cache's error optimistically;
                // only its settled answer can replace that error observation.
                if (admissionChanged || settled) observed = next;
                // This reader consumes admission, not the cache's acquisition
                // flags. Starting/finishing an unchanged read is not invalidation.
                if (changed) owner.invalidate('quota-inputs');
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
            sessionInputs.invalidateForHomeChange(event);
            syncQualifiedSubscriptions();
            const accountingUnchanged = event.usageAccountingAffects === false
                && event.source !== 'snapshot' && !event.usageAccountingChange;
            owner.invalidate(isUsageQuotaHomeAccountChange(event)
                || accountingUnchanged && isUsageProjectionHomeAccountChange(event, true) ? event
                : accountingUnchanged ? 'session-evidence' : event);
        }
    }, { reconnect: 'refresh' });
    const readProviderRows = () => {
        const scope = readOpenedQuotaScope(sharedContext);
        return scope ? getProviderAccountUsageCacheState().entriesByCredentialScope[scope.providerScope] : undefined;
    };
    let observedRows = readProviderRows();
    const reconcileProvider = () => {
        const rows = readProviderRows();
        if (rows === observedRows) return;
        const previous = observedRows;
        observedRows = rows;
        // Cache loading, retry deadlines and observation-only publications do
        // not change Usage facts. Preserve real replacement/removal and errors.
        const keys = new Set([
            ...(allowance?.quota?.flatMap(read => read.current ? [read.current.recordId] : []) ?? []),
            ...(readOpenedQuotaScope(sharedContext)?.sources.flatMap(({ key }) => {
                const id = getQualifiedQuotaSnapshotEntry(key).usageRecordId;
                return id ? [id] : [];
            }) ?? []),
        ]);
        if ([...keys].some(key => previous?.[key]?.hadError !== rows?.[key]?.hadError
            || !sameStrictJsonValue(previous?.[key]?.snapshot, rows?.[key]?.snapshot))) owner.invalidate('quota-inputs');
    };
    const unwatchProvider = whileDemanded(() => { reconcileProvider(); return subscribeProviderAccountUsageCache(reconcileProvider); });
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
    const unwatchFeatures = whileDemanded(() => { reconcileFeatures(); return subscribeServerFeaturesSnapshot(reconcileFeatures); });
    const unwatchState = subscribeUsageQueryStateInvalidation(input => {
        syncQualifiedSubscriptions();
        owner.invalidate(input);
    }, machines => {
        const opened = readOpenedQuotaScope(sharedContext);
        const poolMachineFilters: (readonly string[])[] = [];
        const sessionMachineIds = new Set<string>();
        let includeMachineNames = false;
        // Read mounted demand and its already-admitted value from the Resource
        // owner. No acquisition or second response lifetime lives in this key.
        const sessionIds = new Set<string>();
        for (const watched of listeners.values()) {
            includeMachineNames ||= watched.queries.some(query => query.includeAccounting);
            if (!opened) continue;
            if (opened.state.profile.connectedAccountGroupsV4.length) {
                poolMachineFilters.push(...watched.queries.map(query => query.machines));
            }
            if (watched.machineId) sessionMachineIds.add(watched.machineId);
            for (const slice of watched.previous()?.results ?? []) {
                if (!slice.requestedQuery.includeAccounting || !slice.requestedQuery.includeWorkEvidence) continue;
                for (const turn of readUsageAccountingSessionMembership(slice.accounting)?.turns ?? []) sessionIds.add(turn.sessionId);
                for (const row of slice.accounting?.contributions ?? []) {
                    if (!row.sessionId || !row.turnId) continue;
                    sessionIds.add(row.sessionId);
                }
            }
        }
        if (!opened) return { includeMachineNames, poolMachineFilters, sessionMachineIds: [] };
        const state = { ...opened.state, machines };
        for (const sessionId of sessionIds) {
            const target = resolveMachineControlTargetForSessionFromState(state, { ...lifetime.scope, sessionId });
            const displayId = resolveDisplayMachineIdForSessionFromState({ state, serverId: lifetime.scope.serverId, sessionId });
            if (target) sessionMachineIds.add(target.machineId);
            if (displayId) sessionMachineIds.add(displayId);
        }
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
            prices: presentation.status === 'ready' ? scope.sources.map(({ source }) =>
                [source.ref, readConnectedSubscriptionMonthlyPriceV1(presentation, source.ref)]) : undefined };
    };
    let observedPrices = readEnteredPrices();
    const reconcilePrices = () => {
        const prices = readEnteredPrices();
        if (prices === undefined) return;
        const changed = !sameStrictJsonValue(prices, observedPrices);
        observedPrices = prices;
        if (changed) owner.invalidate('projection-inputs');
    };
    const unwatchPrices = whileDemanded(() => { reconcilePrices(); return subscribeConnectedMetadataCatalog(reconcilePrices); });
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
            sessions: [...ids].map(id => ({ id })), contributions: slicesByQuery.get(getUsageQueryKey(query))?.accounting?.contributions,
            sessionMembership: readUsageAccountingSessionMembership(slicesByQuery.get(getUsageQueryKey(query))?.accounting) })));
        const changedIds = [...ids].filter(id => consumed.has(id));
        const changed = sessionInputs.reconcile(changedIds, { scopeChanged,
            membershipChangedSessionIds: changedIds.filter(id => Boolean(previous?.sessions[id]) !== Boolean(state.sessions[id])),
        });
        if (changed) owner.invalidate(scopeChanged ? undefined : 'session-evidence');
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
    admission?: Readonly<{ inputs: readonly object[]; quotaInterval: Readonly<{ fromMs: number; untilMs: number }>; reusable: boolean }>;
}>>();

export function decodeUsageQueryResource(value: ResourceContent): UsageQueryBatchResult {
    const existing = decodedValues.get(value);
    if (existing) return existing.value;
    const decoded = UsageQueryBatchResultSchema.parse(JSON.parse(new TextDecoder().decode(value.bytes)));
    decodedValues.set(value, { value: decoded });
    return decoded;
}
