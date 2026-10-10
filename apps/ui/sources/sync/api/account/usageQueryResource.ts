import { createPluginUiResourceStore, pluginUiResourceReferenceKey, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import type { ResourceContent, ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import { executeUsageAction } from '@happier-dev/protocol/actions/executor/usageActions';
import { getUsageQueryBatchKey, getUsageQueryKey, normalizeUsageQueryBatchInput, usageQueryToAnalyticsRequest, type UsageQuery, type UsageQueryBatchInput } from '@happier-dev/protocol/inputs/usageQuery';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmBranchListResponseSchema, type ScmBranchListRequest, type ScmBranchListResponse, type ScmBranchWorkEvidence, ScmPullRequestListResponseSchema, type ScmPullRequestListRequest, type ScmPullRequestListResponse } from '@happier-dev/protocol/scm';
import { resolveUsagePageAggregation, resolveUsagePageAccountingRequests, resolveUsageAccountingAsOfMs, retainUsageQueryResultReferences, UsageQueryBatchResultSchema, type UsageAccountingSourceSnapshot, type UsagePoolSourceSnapshot, type UsageQueryPoolSnapshot, type UsageQueryBatchResult, type UsageWorkSourceSnapshot } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { ConnectedServicePoolSelectionGetResponseV1Schema, type ConnectedServicePoolSelectionGetRequestV1, type ConnectedServicePoolSelectionGetResponseV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById, areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createServerFetchAtEndpoint, type ServerFetch } from '@/sync/http/client';
import { resolveServerScopedTransport } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { parseToken } from '@/utils/auth/parseToken';
import { queryUsageAnalytics } from './apiUsage';
import { runSessionScmRpc } from '@/sync/ops/sessionScm';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import type { UsageWorkEvidence } from '@happier-dev/protocol/usage/usageOutcomeAllocation';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { projectUsageQueryWorkEvidence } from '@/sync/domains/usage/usageWorkEvidence';
import { buildUsageCoachRemedies } from '@/sync/domains/usage/buildUsageCoachRemedies';
import { admitUsageCoachRemedies, applyUsageCoachPreferences } from '@happier-dev/protocol/usage/coach/evaluateUsageCoach';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readAccountSettingsForScope } from '@/sync/domains/state/accountSettingsPersistence';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { DecryptedMessage } from '@/sync/domains/state/storageTypes';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import { ConnectedServiceQuotaGetInputV1Schema, ConnectedServiceQuotaGetResultV1Schema, projectProviderAccountUsageQuotaReadV1, type ConnectedServiceQuotaGetInputV1, type ConnectedServiceQuotaGetResultV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { buildProviderAccountUsageScopeKey } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageLoadRoute';
import { getProviderAccountUsageCacheState, subscribeProviderAccountUsageCache } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageCache';
import { buildQualifiedQuotaSnapshotScopeKey, getQualifiedQuotaSnapshotEntry, subscribeQualifiedQuotaSnapshotEntry } from '@/hooks/server/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { shouldHideQuotaForCredentialStatus } from '@/sync/domains/connectedServices/shouldHideQuotaForCredentialStatus';
import { getCachedServerFeaturesSnapshot, subscribeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveRuntimeFeatureDecisionFromSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { UsageModelPriceCatalogSchema, type UsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { HappyError } from '@/utils/errors/errors';

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
        sources: state.profile.connectedAccountsV4.filter(account => !shouldHideQuotaForCredentialStatus(account.status)).map(account => ({
            source: { bindingKind: 'account' as const, ref: account.ref },
            key: buildQualifiedQuotaSnapshotScopeKey({ credentialScope, ref: account.ref,
                serverBasis: { serverId: scope.serverId, generation: serverBasis.generation } }),
        })) };
}

/** Observe already-admitted B; this path never probes, decrypts or refreshes a provider. */
function readOpenedQuota(context: UsageQueryAccountContext, previous?: UsageQueryBatchResult): NonNullable<Parameters<typeof resolveUsagePageAggregation>[0]['quota']> {
    const scope = readOpenedQuotaScope(context);
    if (!scope || scope.sources.length === 0) return { status: 'not_loaded' };
    const decision = readQuotaFeatureDecision(context, scope);
    if (decision?.state !== 'enabled') return { status: decision?.state === 'unknown' || !decision ? 'unknown' : 'unsupported' };
    const rows = getProviderAccountUsageCacheState().entriesByCredentialScope[scope.providerScope] ?? {};
    const retainedBySource = new Map(previous?.results.flatMap(slice => slice.quota ?? [])
        .map(value => [createCanonicalJsonSigningInput(value.source), value]));
    const value: ConnectedServiceQuotaGetResultV1[] = [];
    let pending = false;
    let unavailable = false;
    let stale = false;
    const nowMs = Date.now();
    for (const { source, key } of scope.sources) {
        const admitted = getQualifiedQuotaSnapshotEntry(key);
        const row = admitted.supported === true && admitted.usageRecordId ? rows[admitted.usageRecordId] : undefined;
        pending ||= admitted.loading || row?.loading === true;
        if (!row?.snapshot || row.snapshot.recordId !== admitted.usageRecordId) {
            unavailable = true;
            const retained = retainedBySource.get(createCanonicalJsonSigningInput(source));
            if (retained) { value.push(retained); stale = true; }
            continue;
        }
        stale ||= admitted.error !== null || row.hadError || nowMs >= row.snapshot.fetchedAtMs + row.snapshot.staleAfterMs;
        value.push(projectProviderAccountUsageQuotaReadV1({ input: { source }, current: row.snapshot, nowMs,
            targets: areServerAccountScopesEqual(scope.state.settingsScope, context.accountLifetime.scope)
                ? scope.state.settings.usagePacingTargetsV1 : undefined,
            waitingWork: { status: 'unavailable', reason: 'read_failed' } }));
    }
    if (value.length) {
        const clocks = value.flatMap(row => row.current ? [row.current.fetchedAtMs] : []);
        return { status: unavailable || pending ? 'partial' : stale ? 'stale' : 'available', value,
            ...(clocks.length ? { asOfMs: Math.min(...clocks) } : {}) };
    }
    return { status: pending ? 'pending' : scope.sources.every(({ key }) => getQualifiedQuotaSnapshotEntry(key).supported === false)
        ? 'unsupported' : 'not_loaded' };
}

function readQuotaFeatureDecision(context: UsageQueryAccountContext, scope: NonNullable<ReturnType<typeof readOpenedQuotaScope>>) {
    return resolveRuntimeFeatureDecisionFromSnapshot({ featureId: 'connectedServices.quotas',
        settings: scope.state.settings, snapshot: getCachedServerFeaturesSnapshot({ serverId: context.accountLifetime.scope.serverId })
            ?? { status: 'loading' }, scope: { scopeKind: 'runtime' } });
}

export type UsageQueryAccountContext = Readonly<{
    credentials: AuthCredentials;
    accountLifetime: ServerAccountScopeLifetime;
    request: ServerFetch;
}>;

function requireCurrent(context: UsageQueryAccountContext, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (!context.accountLifetime.isCurrent()) {
        throw Object.assign(new Error('Usage Account authority retired'), { code: 'stale_surface' });
    }
}

/** Public tariff transport is separate from private Account settings and never carries overrides. */
export async function readUiUsageModelPrices(context: UsageQueryAccountContext, refresh = false,
    signal?: AbortSignal): Promise<UsageModelPriceCatalog> {
    requireCurrent(context, signal);
    const response = await context.request(refresh ? '/v1/account/usage/prices/refresh' : '/v1/account/usage/prices', {
        method: refresh ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${context.credentials.token}`, ...(refresh ? { 'Content-Type': 'application/json' } : {}) },
        ...(refresh ? { body: '{}' } : {}), ...(signal ? { signal } : {}),
    });
    requireCurrent(context, signal);
    if (!response.ok) throw new HappyError('Model price catalog unavailable', false, {
        status: response.status, kind: response.status === 401 || response.status === 403 ? 'auth' : 'config',
        code: response.status === 401 || response.status === 403 ? 'denied'
            : [404, 405, 501].includes(response.status) ? 'unsupported' : 'usage_prices_read_failed',
    });
    const raw: unknown = await response.json();
    requireCurrent(context, signal);
    const value = UsageModelPriceCatalogSchema.parse(raw);
    if (refresh) invalidateUsageQueryResources(context.accountLifetime);
    return value;
}

/** The quota host read and Usage batch share the same admitted Action port. */
async function withUiConnectedServiceReader<T>(context: UsageQueryAccountContext, signal: AbortSignal | undefined,
    consume: (read: (input: ConnectedServiceQuotaGetInputV1) => Promise<ConnectedServiceQuotaGetResultV1>,
        readSelection: (input: ConnectedServicePoolSelectionGetRequestV1) => Promise<ConnectedServicePoolSelectionGetResponseV1>) => Promise<T>) {
    const [{ captureLazyActionAccountContext }, { createUiConnectedServiceAction }] = await Promise.all([
        import('@/sync/ops/actions/actionAccountContext'), import('@/sync/ops/actions/connectedServiceActionDeps'),
    ]);
    const account = await captureLazyActionAccountContext(context.accountLifetime.scope.serverId, signal);
    try {
        requireCurrent(context, signal); account.assertCurrent();
        if (!areServerAccountScopesEqual(account.accountLifetime.scope, context.accountLifetime.scope)) {
            throw Object.assign(new Error('Quota Account authority retired'), { code: 'stale_surface' });
        }
        const action = createUiConnectedServiceAction(account);
        const invoke = async (actionId: 'connectedServices.quota.get' | 'connectedServices.pools.selection.get',
            input: ConnectedServiceQuotaGetInputV1 | ConnectedServicePoolSelectionGetRequestV1) => {
            requireCurrent(context, signal); account.assertCurrent();
            const result = await action({ actionId, input,
                context: { surface: 'ui', authority: 'present_user' }, signal });
            requireCurrent(context, signal); account.assertCurrent();
            if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
                throw Object.assign(new Error('error' in result ? String(result.error) : 'Quota read failed'),
                    { code: 'errorCode' in result ? result.errorCode : 'quota_read_failed' });
            }
            return result;
        };
        return await consume(async input => ConnectedServiceQuotaGetResultV1Schema.parse(await invoke('connectedServices.quota.get', input)),
            async input => ConnectedServicePoolSelectionGetResponseV1Schema.parse(await invoke('connectedServices.pools.selection.get', input)));
    } finally { account.dispose(); }
}

async function readUiQuota(context: UsageQueryAccountContext, input: ConnectedServiceQuotaGetInputV1, signal?: AbortSignal) {
    return await withUiConnectedServiceReader(context, signal, read => read(input));
}

function readOpenedUsagePools(context: UsageQueryAccountContext, queries: readonly UsageQuery[]): UsagePoolSourceSnapshot[] {
    const scope = readOpenedQuotaScope(context);
    return queries.map(query => {
        const machines = Object.values(scope?.state.machines ?? {}).filter(machine => !isMachineReplaced(machine) && isMachineOnline(machine)
            && (query.machines.length === 0 || query.machines.includes(machine.id)));
        const machineId = machines.length === 1 ? machines[0]!.id : undefined;
        return { query, value: (scope?.state.profile.connectedAccountGroupsV4 ?? []).map(group => ({
            group: group.ref, memberAccountIds: group.members.map(member => member.connectedAccountId),
            activeAccountId: group.activeConnectedAccountId,
            selection: machineId ? { status: 'pending' as const, machineId }
                : machines.length > 1 ? { status: 'unknown' as const }
                    : { status: 'unsupported' as const, errorCode: 'no_machine' },
        })) };
    });
}

async function readUiUsagePools(context: UsageQueryAccountContext, opened: readonly UsagePoolSourceSnapshot[], signal: AbortSignal | undefined,
    onProgress: (pools: UsagePoolSourceSnapshot[]) => void): Promise<UsagePoolSourceSnapshot[]> {
    const reads = new Map<string, Promise<UsageQueryPoolSnapshot['selection']>>();
    const values = opened.map(snapshot => ({ query: snapshot.query, value: [...snapshot.value] }));
    await Promise.all(values.flatMap(snapshot => snapshot.value.map(async (pool, index) => {
        const machineId = pool.selection.machineId;
        if (!machineId) return;
        const key = JSON.stringify([machineId, pool.group]);
        let read = reads.get(key);
        if (!read) {
            read = (async (): Promise<UsageQueryPoolSnapshot['selection']> => {
                try {
                    const value = await withUiConnectedServiceReader(context, signal, async (_quota, readSelection) =>
                        readSelection({ machineId, group: pool.group }));
                    requireCurrent(context, signal);
                    return 'status' in value ? { status: value.code === 'unsupported' ? 'unsupported' : 'error', machineId, errorCode: value.code }
                        : { status: 'available', machineId, asOfMs: value.observedAtMs, value };
                } catch (error) {
                    requireCurrent(context, signal);
                    return { status: 'error', machineId, errorCode: error && typeof error === 'object' && 'code' in error
                        && typeof error.code === 'string' ? error.code : 'connected_service_request_failed' };
                }
            })();
            reads.set(key, read);
        }
        snapshot.value[index] = { ...pool, selection: await read };
        requireCurrent(context, signal);
        onProgress(values);
    })));
    return values;
}

async function readOpenedQuotaHistory(context: UsageQueryAccountContext, queries: readonly UsageQuery[], signal?: AbortSignal,
    onProgress?: (quota: NonNullable<Parameters<typeof resolveUsagePageAggregation>[0]['quota']>) => void, previous?: UsageQueryBatchResult):
    Promise<NonNullable<Parameters<typeof resolveUsagePageAggregation>[0]['quota']>> {
    const opened = readOpenedQuota(context, previous);
    const scope = readOpenedQuotaScope(context);
    if (!scope?.sources.length || readQuotaFeatureDecision(context, scope)?.state !== 'enabled') return opened;
    // 100 is a caller-selected transport batch size, not a history/result limit.
    // Exhaust the canonical cursor for the board's range; a failed later page
    // retains its cursor so the projection labels the accepted prefix partial.
    const range = { startAtMs: Math.min(...queries.map(query => query.period.startMs ?? 0)),
        endAtMs: Math.max(...queries.map(query => query.period.endMs ?? Date.now())) };
    if (range.endAtMs <= range.startAtMs) return opened;
    const retainedBySource = new Map(opened.value?.map(value => [createCanonicalJsonSigningInput(value.source), value]));
    const progressValues = scope.sources.map(({ source }) => retainedBySource.get(createCanonicalJsonSigningInput(source)) ?? null);
    const failures = new Map<number, string>();
    const projectQuota = (status: 'available' | 'partial' | 'stale' | 'error') => {
        const value = progressValues.filter((row): row is ConnectedServiceQuotaGetResultV1 => row !== null);
        const clocks = value.flatMap(row => row.current ? [row.current.fetchedAtMs] : []);
        return { status, ...(value.length ? { value } : {}), ...(clocks.length ? { asOfMs: Math.min(...clocks) } : {}),
            ...(failures.size && !value.length ? { errorCode: [...failures.values()][0] } : {}) };
    };
    const publishProgress = (index: number, value: ConnectedServiceQuotaGetResultV1 | null): void => {
        requireCurrent(context, signal);
        progressValues[index] = value;
        onProgress?.(projectQuota('partial'));
    };
    await Promise.all(scope.sources.map(async ({ source }, index) => {
        const retained = retainedBySource.get(createCanonicalJsonSigningInput(source));
        let accepted: ConnectedServiceQuotaGetResultV1 | undefined;
        const projectAccepted = () => projectProviderAccountUsageQuotaReadV1({ input: { source },
            current: accepted!.current, history: accepted!.history, targets: accepted!.targets,
            waitingWork: accepted!.waitingWork, nowMs: Date.now() });
        try {
            return await withUiConnectedServiceReader(context, signal, async read => {
                // Current B has its own useful revision before any history page.
                accepted = await read({ source });
                publishProgress(index, projectAccepted());
                let cursor: NonNullable<ConnectedServiceQuotaGetResultV1['history']>['nextCursor'] = null;
                do {
                    const page = await read({ source, history: { range, pageSize: 100,
                        ...(cursor ? { cursor } : {}) } });
                    // Source resolution must not splice observations from a
                    // newly bound record into the previously admitted record.
                    if (accepted && accepted.current?.recordId !== page.current?.recordId) {
                        failures.set(index, 'provider_account_usage_identity_mismatch'); publishProgress(index, null); return;
                    }
                    accepted = { ...page, ...(page.history ? { history: { ...page.history,
                        entries: [...(accepted?.history?.entries ?? []), ...page.history.entries] } } : {}) };
                    cursor = page.history?.nextCursor ?? null;
                    publishProgress(index, projectAccepted());
                } while (cursor);
            });
        } catch (error) {
            requireCurrent(context, signal);
            const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
                ? error.code : 'quota_read_failed';
            failures.set(index, code);
            if (['denied', 'permission_denied', 'stale_surface'].includes(code)) { publishProgress(index, null); return; }
            const projected = accepted ? projectAccepted() : retained;
            const value = projected ? accepted?.history ? projected
                : { ...projected, unusedCapacity: { historyStatus: 'unavailable' as const, windows: [] } } : null;
            publishProgress(index, value);
        }
    }));
    requireCurrent(context, signal);
    return projectQuota(failures.size === 0 ? 'available' : progressValues.every(value => value !== null) ? 'stale'
        : progressValues.some(value => value !== null) ? 'partial' : 'error');
}

async function readHowYouWorkEvidence(context: UsageQueryAccountContext, queries: readonly UsageQuery[], signal?: AbortSignal) {
    const active = captureActiveServerAccountScopeLifetime();
    const state = active?.isCurrent() && areServerAccountScopesEqual(active.scope, context.accountLifetime.scope)
        ? readRegisteredStorageState() : null;
    const selectedIds = [...new Set(queries.flatMap(query => query.session === null ? [] : typeof query.session === 'string' ? [query.session] : query.session))];
    const selected = new Map(await Promise.all(selectedIds.map(async sessionId => {
        try {
            const [{ runWithServerRequestAuthorityForServerAccountScope }, { readSessionSnapshotForAuthority }, { fetchSessionMessagesPage }, { readStoredSessionMessage }] = await Promise.all([
                import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope'),
                import('@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority'),
                import('@happier-dev/sync-client'), import('@/sync/runtime/readStoredSessionContent'),
            ]);
            return await runWithServerRequestAuthorityForServerAccountScope({ scope: context.accountLifetime.scope, activeRequest: context.request }, async authority => {
                requireCurrent(context, signal);
                const { session } = await readSessionSnapshotForAuthority({ authority, sessionId, isCurrent: context.accountLifetime.isCurrent });
                requireCurrent(context, signal);
                let openedMessages: DecryptedMessage[] | undefined;
                let completeMessageCoverage = false;
                if (session.access?.capabilities.readTranscript !== false && isSessionContentReadable(readSessionContentAvailability(session))) {
                    const page = await fetchSessionMessagesPage({ sessionId, scope: 'all', roles: ['user', 'event'], signal,
                        requestJson: async (path, pageSignal) => {
                            requireCurrent(context, pageSignal);
                            const response = await authority.request(path, { signal: pageSignal });
                            if (!response.ok) throw new Error('Session input evidence unavailable');
                            const value: unknown = await response.json();
                            requireCurrent(context, pageSignal);
                            return value;
                        } });
                    const encryption = authority.context.encryption?.getSessionEncryption(sessionId);
                    const messages = await Promise.all(page.messages.map(message => readStoredSessionMessage({ message,
                        sessionEncryptionMode: session.encryptionMode === 'plain' ? 'plain' : 'e2ee',
                        ...(encryption ? { decryptMessage: async (row) => (await encryption.decryptMessages([row]))[0] ?? null } : {}),
                    })));
                    const readableMessages = messages.filter((message): message is DecryptedMessage => message !== null && message.content !== null);
                    // An empty raw page was observed; a wholly unopened nonempty
                    // page supplies no private input evidence, not a zero count.
                    if (page.messages.length === 0 || readableMessages.length > 0) openedMessages = readableMessages;
                    completeMessageCoverage = page.hasMore === false && readableMessages.length === page.messages.length;
                }
                requireCurrent(context, signal);
                return [sessionId, { session, openedMessages, completeMessageCoverage }] as const;
            });
        } catch {
            requireCurrent(context, signal);
            return [sessionId, null] as const;
        }
    })));
    requireCurrent(context, signal);
    const asOfMs = Date.now();
    const nightHours = readAccountSettingsForScope({ scope: context.accountLifetime.scope,
        focusedScope: state?.settingsScope, focusedSettings: state?.settings ?? settingsDefaults }).usageNightHoursV1;
    return queries.map(query => {
        const sessions = query.session === null ? Object.values(state?.sessions ?? {})
            : (typeof query.session === 'string' ? [query.session] : query.session).flatMap(id => selected.get(id)?.session ? [selected.get(id)!.session] : []);
        const openedMessages = new Map([...selected].flatMap(([id, entry]) => entry?.openedMessages !== undefined
            ? [[id, entry.openedMessages] as const] : []));
        const completeMessageSessionIds = new Set([...selected].flatMap(([id, entry]) => entry?.completeMessageCoverage ? [id] : []));
        return { query, asOfMs, sessions, ...(nightHours ? { nightHours } : {}), detail: projectUsageQueryWorkEvidence({ query, scope: context.accountLifetime.scope,
            currentScope: query.session === null ? active?.scope ?? null : context.accountLifetime.scope,
            isCurrent: context.accountLifetime.isCurrent() && (query.session !== null || active?.isCurrent() === true), sessions, openedMessages,
            completeMessageSessionIds }) };
    });
}

type SessionWorkSourceResult = Readonly<
    | { status: 'unsupported' | 'error' }
    | { status: 'partial' | 'unsupported' | 'error'; evidence: readonly UsageWorkEvidence[]; branchEvidence?: readonly ScmBranchWorkEvidence[] }
>;

async function readSessionWorkEvidence(context: UsageQueryAccountContext, queries: readonly UsageQuery[],
    accounting: readonly UsageAccountingSourceSnapshot[], sessionReads: Map<string, Promise<SessionWorkSourceResult>>,
    signal?: AbortSignal): Promise<readonly UsageWorkSourceSnapshot[]> {
    const byQuery = new Map(accounting.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value]));
    const sessionIds = new Set(queries.flatMap(query => (byQuery.get(getUsageQueryKey(query))?.contributions ?? [])
        .flatMap(row => row.sessionId && row.turnId ? [row.sessionId] : [])));
    // Generic transport refusals quarantine every private sibling read. Only
    // explicit native failures may retain other independently witnessed graphs.
    const nativeReadFailureCodes = ['COMMAND_FAILED', 'COMMAND_TIMEOUT', 'COMMAND_OUTPUT_LIMIT_EXCEEDED',
        'REMOTE_NETWORK_FAILED', 'REPOSITORY_REFRESH_FAILED', 'FEATURE_UNSUPPORTED'];
    const loadSession = async (sessionId: string): Promise<SessionWorkSourceResult> => {
        const scope = context.accountLifetime.scope;
        if (!readMachineControlTargetForSession({ sessionId, serverId: scope.serverId, accountId: scope.accountId })) {
            return { status: 'unsupported' };
        }
        const states = await Promise.all((['branch', 'open', 'closed', 'merged'] as const).map(async (state): Promise<Readonly<{
            status: 'partial' | 'unsupported' | 'error'; evidence?: readonly UsageWorkEvidence[]; branchEvidence?: readonly ScmBranchWorkEvidence[]; quarantine?: boolean;
        }>> => {
          try {
            requireCurrent(context, signal);
            if (state === 'branch') {
                const response = ScmBranchListResponseSchema.safeParse(await runSessionScmRpc<ScmBranchListResponse, ScmBranchListRequest>(
                    sessionId, RPC_METHODS.SCM_BRANCH_LIST, { workEvidence: { sessionId } }, scope.serverId, signal, scope.accountId));
                requireCurrent(context, signal);
                if (!response.success) return { status: 'error', quarantine: true };
                if (!response.data.success) {
                    const nativeFailure = nativeReadFailureCodes.includes(response.data.errorCode ?? '');
                    return { status: 'error', quarantine: !nativeFailure };
                }
                if (!response.data.branchEvidence || response.data.branchEvidenceStatus !== 'partial') return { status: 'unsupported' };
                if (response.data.branchEvidence.some(witness => witness.sessionId !== sessionId)) return { status: 'error', quarantine: true };
                return { status: 'partial', branchEvidence: response.data.branchEvidence };
            }
            const response = ScmPullRequestListResponseSchema.safeParse(await runSessionScmRpc<ScmPullRequestListResponse, ScmPullRequestListRequest>(
                sessionId, RPC_METHODS.SCM_PULL_REQUEST_LIST, { state, workEvidence: { sessionId } }, scope.serverId, signal, scope.accountId));
            requireCurrent(context, signal);
            if (!response.success) return { status: 'error', quarantine: true };
            if (!response.data.success) {
                // The incumbent transport maps generic refusals to BACKEND_UNAVAILABLE.
                // Only explicit native-read failures can retain a sibling state's facts.
                const nativeFailure = nativeReadFailureCodes.includes(response.data.errorCode ?? '');
                return { status: 'error', quarantine: !nativeFailure };
            }
            if (!response.data.workEvidence || !response.data.workEvidenceStatus || response.data.workEvidenceStatus === 'unavailable') {
                return { status: 'unsupported' };
            }
            if (response.data.workEvidence.some(witness => witness.sessionId !== sessionId)) {
                return { status: 'error', quarantine: true };
            }
            // List is current-branch discovery, never proof of complete repository history.
            return { status: 'partial', evidence: response.data.workEvidence };
          } catch {
            requireCurrent(context, signal);
            return { status: 'error', quarantine: true };
          }
        }));
        if (states.some(source => source.quarantine)) return { status: 'error' };
        return { status: states.some(source => source.status === 'partial') ? 'partial' as const
            : states.some(source => source.status === 'error') ? 'error' as const : 'unsupported' as const,
            evidence: states.flatMap(source => source.evidence ?? []), branchEvidence: states.flatMap(source => source.branchEvidence ?? []) };
    };
    const sessions = new Map(await Promise.all([...sessionIds].map(async sessionId => {
        let read = sessionReads.get(sessionId);
        if (!read) { read = loadSession(sessionId); sessionReads.set(sessionId, read); }
        return [sessionId, await read] as const;
    })));
    return queries.map((query): UsageWorkSourceSnapshot => {
        const contributions = byQuery.get(getUsageQueryKey(query))?.contributions;
        if (!contributions) return { query, status: 'unsupported' };
        const turns = new Set(contributions.filter(row => row.sessionId && row.turnId).map(row => JSON.stringify([row.sessionId, row.turnId])));
        const selected = [...new Set(contributions.flatMap(row => row.sessionId && row.turnId ? [row.sessionId] : []))]
            .map(sessionId => sessions.get(sessionId)!);
        const evidence = selected.flatMap(source => 'evidence' in source ? source.evidence : [])
            .filter(witness => turns.has(JSON.stringify([witness.sessionId, witness.turnId])));
        const branchEvidence = selected.flatMap(source => 'branchEvidence' in source ? source.branchEvidence ?? [] : [])
            .filter(witness => turns.has(JSON.stringify([witness.sessionId, witness.turnId])));
        return { query, evidence, branchEvidence, status: selected.some(source => source.status === 'partial') ? 'partial'
            : selected.some(source => source.status === 'error') ? 'error' : selected.length ? 'unsupported' : 'unknown',
            ...(selected.some(source => source.status === 'error') ? { errorCode: 'work_evidence_failed' } : {}) };
    });
}

/** Capture the Home carrier and real Account lifetime; neither is a query input. */
export function captureUiUsageQueryAccountContext(credentials: AuthCredentials): UsageQueryAccountContext | null {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    if (!accountLifetime?.isCurrent() || parseToken(credentials.token) !== accountLifetime.scope.accountId) return null;
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
    return { credentials, accountLifetime, request };
}

/** One Action port batches resolved A requests; B/backfill never delays available A. */
export async function readUiUsageQueryBatch(
    context: UsageQueryAccountContext,
    input: UsageQueryBatchInput,
    signal?: AbortSignal,
    previous?: UsageQueryBatchResult,
    options?: Readonly<{ onProgress?: (value: UsageQueryBatchResult) => void }>,
): Promise<UsageQueryBatchResult> {
    requireCurrent(context, signal);
    const { queries } = normalizeUsageQueryBatchInput(input);
    const requests = resolveUsagePageAccountingRequests(queries);
    const priorAccounting = new Map(previous?.results.flatMap(slice => [
        [slice.key, { value: slice.accounting, asOfMs: slice.sources.find(source => source.source === 'accounting')?.asOfMs }] as const,
        ...(slice.comparison ? [[getUsageQueryKey(slice.comparison.query), { value: slice.comparison.accounting,
            asOfMs: slice.comparison.source.asOfMs }] as const] : []),
    ]));
    const accounting = new Map<string, UsageAccountingSourceSnapshot>(requests.map(query => {
        const retained = priorAccounting.get(getUsageQueryKey(query));
        return [getUsageQueryKey(query), { query, status: 'pending' as const,
            ...(retained?.value ? { value: retained.value } : {}),
            ...(retained?.asOfMs === undefined ? {} : { asOfMs: retained.asOfMs }) } satisfies UsageAccountingSourceSnapshot] as const;
    }));
    let work: readonly UsageWorkSourceSnapshot[] = queries.map(query => ({ query, status: 'pending' }));
    const sessionWorkReads = new Map<string, Promise<SessionWorkSourceResult>>();
    let howYouWork: Awaited<ReturnType<typeof readHowYouWorkEvidence>> | undefined;
    let mcpCatalog: McpServerCatalogSnapshotV1 | undefined;
    let quota = readOpenedQuota(context, previous);
    let pools = readOpenedUsagePools(context, queries);
    let admittedPrevious = previous;
    // All effects share this read's lifetime; snapshots are published directly
    // into its entry, never cached or rerun just to advance independent sources.
    const compose = (): UsageQueryBatchResult => {
        requireCurrent(context, signal);
        const settingsState = readRegisteredStorageState();
        const pricingOverrides = readAccountSettingsForScope({ scope: context.accountLifetime.scope,
            focusedScope: settingsState?.settingsScope, focusedSettings: settingsState?.settings ?? settingsDefaults }).usageModelPriceOverridesV1;
        const batch = resolveUsagePageAggregation({ queries, accounting: [...accounting.values()], previous: admittedPrevious,
            pricingOverrides, quota, pools, work, howYouWork, ...(!howYouWork ? { sources: [{ source: 'how_you_work', status: 'pending' as const }] } : {}) });
        return applyCoachPreferences(batch, howYouWork ?? []);
    };
    const publish = (): void => {
        if (!options?.onProgress) return;
        if (!previous && ![...accounting.values()].some(snapshot => snapshot.value)
            && !quota.value?.length && !howYouWork?.some(snapshot => snapshot.detail.status !== 'unknown')) return;
        const batch = compose();
        admittedPrevious = batch;
        options.onProgress(batch);
    };
    publish();
    const accountingTasks = new Map(requests.map(query => [getUsageQueryKey(query), (async () => {
        let snapshot: UsageAccountingSourceSnapshot;
        try {
            const value = await queryUsageAnalytics(context.credentials, usageQueryToAnalyticsRequest(query), { request: context.request, signal });
            const asOfMs = resolveUsageAccountingAsOfMs(value);
            snapshot = { query, value, status: 'available', ...(asOfMs === undefined ? {} : { asOfMs }) };
        } catch (error) {
            requireCurrent(context, signal);
            const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'usage_query_failed';
            if (['denied', 'permission_denied', 'stale_surface'].includes(errorCode)) throw error;
            snapshot = { query, status: 'error', errorCode };
        }
        requireCurrent(context, signal);
        accounting.set(getUsageQueryKey(query), snapshot);
        publish();
    })()]));
    await Promise.all([
        ...accountingTasks.values(),
        ...queries.map(async (query, index) => {
            // Each slice needs only its own contributions. Native Session reads
            // are still shared across slices within this one Action admission.
            await accountingTasks.get(getUsageQueryKey(query));
            requireCurrent(context, signal);
            const sources = await readSessionWorkEvidence(context, [query], [...accounting.values()], sessionWorkReads, signal);
            work = work.map((source, sourceIndex) => sourceIndex === index ? sources[0]! : source);
            publish();
        }),
        (async () => { howYouWork = await readHowYouWorkEvidence(context, queries, signal); publish(); })(),
        (async () => { quota = await readOpenedQuotaHistory(context, queries, signal, value => { quota = value; publish(); }, previous); publish(); })(),
        (async () => { pools = await readUiUsagePools(context, pools, signal, value => { pools = value; publish(); }); publish(); })(),
    ]);
    // Only witnessed binding advice needs this owner read. Other usage sources
    // publish independently, and an unavailable catalog never fabricates a remedy.
    if (compose().results.some(slice => slice.coach?.findings.some(finding => finding.detectorId === 'mcp_overhead'
        && finding.currentness === 'current' && finding.evidence.some(ref => ref.kind === 'mcp_usage')))) {
        const { readMcpServerCatalog } = await import('./apiMcpServerCatalog');
        mcpCatalog = await readMcpServerCatalog(context.accountLifetime.scope, signal, () => requireCurrent(context, signal));
        requireCurrent(context, signal);
        publish();
    }
    return compose();

    function applyCoachPreferences(batch: UsageQueryBatchResult, howYouWork: Awaited<ReturnType<typeof readHowYouWorkEvidence>>): UsageQueryBatchResult {
        const openedByQuery = new Map(howYouWork.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
        const settingsState = readRegisteredStorageState();
        const preferences = readAccountSettingsForScope({ scope: context.accountLifetime.scope,
            focusedScope: settingsState?.settingsScope, focusedSettings: settingsState?.settings ?? settingsDefaults }).usageCoachPreferencesV1;
        const nowMs = Date.now();
        const results = batch.results.map(slice => {
            const opened = openedByQuery.get(slice.key);
            if (!slice.coach) return slice;
            const proposals = !opened || opened.detail.status === 'unknown' ? [] : buildUsageCoachRemedies({ findings: slice.coach.findings.filter(finding => finding.remedy === null),
                composition: opened.detail.coach?.composition ?? [], sessions: opened.sessions,
                mcpUsage: opened.detail.coach?.detail?.mcpUsage ?? [], ...(mcpCatalog ? { mcpCatalog } : {}),
                serverId: context.accountLifetime.scope.serverId, accountId: context.accountLifetime.scope.accountId });
            const coach = proposals.length === 0 ? slice.coach : admitUsageCoachRemedies(slice.coach,
                [...(opened?.detail.coach?.admittedRemedies ?? []), ...proposals]);
            const preferred = applyUsageCoachPreferences(coach, preferences, nowMs);
            return sameStrictJsonValue(preferred, slice.coach) ? slice : { ...slice, coach: preferred };
        });
        return results.every((slice, index) => slice === batch.results[index]) ? batch : UsageQueryBatchResultSchema.parse({ ...batch, results });
    }
}

type AccountResourceOwner = Readonly<{ store: PluginUiResourceStore; invalidate(): void }>;
// This is the existing Resource store's Account ownership, not a response cache.
const accountStores = new WeakMap<ServerAccountScopeLifetime, AccountResourceOwner>();
const INVALIDATION_DIGEST = computePluginUiArtifactSha256DigestV1(new TextEncoder().encode('usage-owner-invalidation'));

export function invalidateUsageQueryResources(lifetime = captureActiveServerAccountScopeLifetime()): void {
    if (!lifetime?.isCurrent()) return;
    // Actions wrap the captured lifetime; mounted Resources use the active
    // same-Account lifetime. Match the existing store admission normalization.
    const active = captureActiveServerAccountScopeLifetime();
    const ownerLifetime = active && areServerAccountScopesEqual(active.scope, lifetime.scope) ? active : lifetime;
    accountStores.get(ownerLifetime)?.invalidate();
}

/** Mounted host widgets and admitted plugin host reads acquire this exact store. */
export function getUsageQueryResourceStore(context: UsageQueryAccountContext): PluginUiResourceStore {
    requireCurrent(context);
    const active = captureActiveServerAccountScopeLifetime();
    const sharedContext = active && areServerAccountScopesEqual(active.scope, context.accountLifetime.scope)
        ? { ...context, ...captureUiUsageQueryAccountContext(context.credentials) } : context;
    const lifetime = sharedContext.accountLifetime;
    const existing = accountStores.get(lifetime);
    if (existing) return existing.store;
    const listeners = new Set<(event: ResourceSubscriptionEvent) => void>();
    const owner = {
        store: createPluginUiResourceStore({ accountLifetime: lifetime, client: {
            resourceKey(reference) {
                if (typeof reference !== 'string' && 'hostRead' in reference && reference.hostRead === 'usage.query') {
                    return JSON.stringify(['host', 'usage.query', getUsageQueryBatchKey(reference.input)]);
                }
                return pluginUiResourceReferenceKey(reference, null);
            },
            async readResource(reference, options) {
                if (typeof reference === 'string' || !('hostRead' in reference)) {
                    throw Object.assign(new Error('Unsupported host read'), { code: 'unsupported_method' });
                }
                requireCurrent(sharedContext, options?.signal);
                syncQualifiedSubscriptions();
                if (reference.hostRead === 'connectedServices.quota.get') {
                    const result = await readUiQuota(sharedContext, ConnectedServiceQuotaGetInputV1Schema.parse(reference.input), options?.signal);
                    const bytes = new TextEncoder().encode(JSON.stringify(result));
                    return { contentType: 'application/json', bytes, digest: computePluginUiArtifactSha256DigestV1(bytes) };
                }
                if (reference.hostRead !== 'usage.query') throw Object.assign(new Error('Unsupported host read'), { code: 'unsupported_method' });
                const entry = owner.store.getEntry(reference);
                const retained = entry.getSnapshot().value;
                const previous = retained ? decodeUsageQueryResource(retained) : undefined;
                const contentFor = (batch: UsageQueryBatchResult): ResourceContent => {
                    requireCurrent(sharedContext, options?.signal);
                    const bytes = new TextEncoder().encode(JSON.stringify(batch));
                    const content = { contentType: 'application/json', bytes, digest: computePluginUiArtifactSha256DigestV1(bytes) };
                    const current = entry.getSnapshot().value;
                    // Reconcile each revision against the same entry's admitted
                    // value so unrelated slices keep their selected references.
                    const reconciled = retainUsageQueryResultReferences(batch, previous);
                    decodedValues.set(content, retainUsageQueryResultReferences(reconciled, current ? decodeUsageQueryResource(current) : undefined));
                    return content;
                };
                const result = await executeUsageAction('usage.query', reference.input, {
                    query: (input, actionContext) => readUiUsageQueryBatch(sharedContext, input, actionContext.signal, previous,
                        { onProgress: batch => options?.onProgress?.(contentFor(batch)) }),
                }, { signal: options?.signal });
                requireCurrent(sharedContext, options?.signal);
                if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
                return contentFor(UsageQueryBatchResultSchema.parse(result.result));
            },
            async watchResource(reference, listener, options) {
                requireCurrent(sharedContext, options?.signal);
                if (typeof reference === 'string' || !('hostRead' in reference)) {
                    throw Object.assign(new Error('Unsupported host read'), { code: 'unsupported_method' });
                }
                listeners.add(listener);
                const dispose = () => { listeners.delete(listener); options?.signal?.removeEventListener('abort', dispose); };
                options?.signal?.addEventListener('abort', dispose, { once: true });
                return { dispose };
            },
        } }),
        invalidate() {
            if (!lifetime.isCurrent()) return;
            for (const listener of [...listeners]) listener({ version: 1, subscriptionId: 'usage-query', kind: 'invalidated', digest: INVALIDATION_DIGEST });
        },
    } satisfies AccountResourceOwner;
    accountStores.set(lifetime, owner);
    const qualifiedUnwatches = new Map<string, () => void>();
    function syncQualifiedSubscriptions(): void {
        const keys = new Set(readOpenedQuotaScope(sharedContext)?.sources.map(({ key }) => key));
        for (const [key, dispose] of qualifiedUnwatches) {
            if (!keys.has(key)) { dispose(); qualifiedUnwatches.delete(key); }
        }
        for (const key of keys) if (!qualifiedUnwatches.has(key)) {
            qualifiedUnwatches.set(key, subscribeQualifiedQuotaSnapshotEntry(key, () => owner.invalidate()));
        }
    }
    syncQualifiedSubscriptions();
    const unwatch = subscribeHomeAccountChange(event => {
        if (areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) {
            syncQualifiedSubscriptions();
            owner.invalidate();
        }
    });
    const readProviderRows = () => {
        const scope = readOpenedQuotaScope(sharedContext);
        return scope ? getProviderAccountUsageCacheState().entriesByCredentialScope[scope.providerScope] : undefined;
    };
    let observedRows = readProviderRows();
    const unwatchProvider = subscribeProviderAccountUsageCache(() => {
        const rows = readProviderRows();
        if (rows === observedRows) return;
        observedRows = rows;
        owner.invalidate();
    });
    let observedFeatures = getCachedServerFeaturesSnapshot({ serverId: lifetime.scope.serverId });
    const unwatchFeatures = subscribeServerFeaturesSnapshot(() => {
        const features = getCachedServerFeaturesSnapshot({ serverId: lifetime.scope.serverId });
        if (features === observedFeatures) return;
        observedFeatures = features;
        owner.invalidate();
    });
    const readStateInvalidationInputs = () => {
        const state = readRegisteredStorageState();
        return [state?.profileScope, state?.profile.connectedAccountsV4, state?.profile.connectedAccountGroupsV4, state?.machines, state?.settingsScope,
            state?.settings.experiments, state?.settings.featureToggles, state?.settings.usagePacingTargetsV1,
            state?.settings.usageCoachPreferencesV1, state?.settings.usageNightHoursV1, state?.settings.usageModelPriceOverridesV1];
    };
    let observedStateInputs = readStateInvalidationInputs();
    const unwatchState = subscribeRegisteredStorageState(() => {
        const inputs = readStateInvalidationInputs();
        if (inputs.every((input, index) => input === observedStateInputs[index])) return;
        observedStateInputs = inputs;
        syncQualifiedSubscriptions();
        owner.invalidate();
    });
    const unwatchCredentials = subscribeHomeCredentialMutations(event => {
        if (!areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)) return;
        if (event.kind === 'credentials_set' && event.credentials
            && resolveAuthCredentialsScopeKey(event.credentials) === resolveAuthCredentialsScopeKey(sharedContext.credentials)) return;
        owner.store.dispose();
        accountStores.delete(lifetime);
        unwatch();
        unwatchProvider();
        unwatchFeatures();
        unwatchState?.();
        qualifiedUnwatches.forEach(dispose => dispose());
        qualifiedUnwatches.clear();
        unwatchCredentials();
    });
    lifetime.onRetire(() => {
        owner.store.dispose();
        accountStores.delete(lifetime);
        listeners.clear();
        unwatch();
        unwatchProvider();
        unwatchFeatures();
        unwatchState?.();
        qualifiedUnwatches.forEach(dispose => dispose());
        qualifiedUnwatches.clear();
        unwatchCredentials();
    });
    return owner.store;
}

// Decode once per admitted immutable Resource value so independent consumers
// select the same slice reference. No response or request lifetime lives here.
const decodedValues = new WeakMap<ResourceContent, UsageQueryBatchResult>();
export function decodeUsageQueryResource(value: ResourceContent): UsageQueryBatchResult {
    const existing = decodedValues.get(value);
    if (existing) return existing;
    const decoded = UsageQueryBatchResultSchema.parse(JSON.parse(new TextDecoder().decode(value.bytes)));
    decodedValues.set(value, decoded);
    return decoded;
}
