import { createPluginSurfaceHostReadStore } from '@/components/plugins/surfaces/pluginSurfaceHostReadStore';
import { UsageRecapComposeResultSchema } from '@happier-dev/protocol/usage/usageRecap';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createCanonicalJsonSigningInput } from '@happier-dev/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServedHomeAccountToken, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary, createUsageSessionEvidenceHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { USAGE_HISTORY_ACTION_IDS, USAGE_PRIVATE_RECAP_ACTION_IDS } from '@happier-dev/protocol/usage/usageActionIdsV1';
import { UsageHistoryReadStateSchema, type UsageHistoryReadInput } from '@happier-dev/protocol/usage/usageSessionEvidence';
import * as usageSessionEvidence from '@happier-dev/protocol/usage/usageSessionEvidence';
import type { UsageWorkEvidence } from '@happier-dev/protocol/usage/usageOutcomeAllocation';
import { ScmWorkEvidenceReadResponseSchema, type ScmWorkEvidenceReadRequest, type ScmWorkEvidenceSessionResult } from '@happier-dev/protocol/scm';
import { collectUsageWorkSources } from '@happier-dev/protocol/usage/usageWorkSources';
import { collectUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery, resolveEffectiveUsageCostUsd } from '@happier-dev/protocol/usage/usageCost';
import { aggregateUsageContributionCosts } from '@happier-dev/protocol/usage/usageAggregation';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getRetainedQuotaPeriodKey, getUsageQueryResourceStore, invalidateUsageQueryResources, mergeRetainedUsageAllowance, readUiUsageQueryBatch } from './usageQueryResource';
import type { UsageQueryReprojection } from './usageQueryProjection';
import { storage } from '@/sync/domains/state/storage';
import { publishHomeAccountChange, publishHomeAccountChangeWake, subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { buildConnectedAccountCatalogPhysicalKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { buildDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { buildConnectedServicesAccountChangeV1, HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { createArtifactReadBatchHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { planSyncActionsFromChanges, plannedChangesAffectUsageQuery, plannedChangesAffectUsageAccounting } from '@/sync/runtime/orchestration/changesPlanner';
// These source-adapter tests do not register unrelated Settings surfaces.
// Keep the canonical helpers without the presentation harness barrel graph.
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { QualifiedConnectedAccountGroupV4Schema} from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryBatchResponseSchema, getUsageAnalyticsQueryRequestKey } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { readUsageAccountingReadAtMs, UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainSessionWithDisplayRecordFixture as createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { createMachineFixture, createMachineMetadataFixture, createHydratedPlainMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { usageQaAccountingFixture } from '@/dev/testkit/fixtures/usageQaAccountingFixture';
import { observeMachinePresenceForTest, publishMachineActivityForTest, publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { clearMachineRequestReachabilityForMachine } from '@/sync/domains/machines/reachability/machineReachability';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { buildProviderAccountUsageMaterialChangesV1, readProviderAccountUsageChangedRecordIdsV1 } from '@happier-dev/protocol/changes/providerAccountUsage';
import { QualifiedConnectedAccountQuotaResponseV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedProviderAccountUsageHistoryRequestV4Schema, ProviderAccountUsagePageProjectionReadV1Schema, ProviderAccountUsagePageProjectionWriteV1Schema, ConnectedServiceQuotaGetResultV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { ProviderAccountUsageDaySummaryReadV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageDaySummary';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { buildProviderAccountUsageScopeKey } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageLoadRoute';
import { getProviderAccountUsageCacheState, updateProviderAccountUsageCacheEntries } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageCache';
import { getProviderAccountUsageSnapshotPlain } from './apiProviderAccountUsage';
import { buildQualifiedQuotaSnapshotScopeKey, getQualifiedQuotaSnapshotEntry, loadQualifiedQuotaSnapshotOnce, reloadQualifiedQuotaSnapshotAfterRecovery,
  subscribeQualifiedQuotaSnapshotEntry } from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { settingsParse } from '@/sync/domains/settings/settings';
import * as React from 'react';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { useProviderAccountUsageSnapshots } from '@/hooks/server/connectedServices/useProviderAccountUsageSnapshots';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { UsageWidgetBodyModel } from '@/components/settings/usage/useUsageWidgetResource';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { act } from 'react-test-renderer';
import * as platformDigest from '@/platform/digest';
import { projectUsagePlans } from '@/components/settings/usage/widgets/plans/usagePlansModel';
import { usageCoverageSummary } from '@/components/settings/usage/widgets/usageBodyKit';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded, withdrawMachinePresenceForScope } from '@/sync/domains/machines/reachability/machineReachability';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ConnectedServicePoolSelectionGetResponseV1Schema } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { UsageFileResultSchema } from '@happier-dev/protocol/usage/usageExport';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createUiUsageActionPorts } from '@/sync/ops/actions/usageActionDeps';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { saveAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { evaluateUsageCoach } from '@happier-dev/protocol/usage/coach/evaluateUsageCoach';
import { UsageMcpBindingUsageSchema } from '@happier-dev/protocol/usage/coach/usageMcpBindingUsage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { USAGE_COACH_DETECTOR_IDS } from '@happier-dev/protocol/usage/coach/coachFinding';
import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1,
  ConnectedPresentationRowReadResponseV1Schema, ConnectedAcknowledgementsRowReadResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { SessionSystemRecordStoredUpsertRequestSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { createUsageQuerySessionInputs, type SessionInputEvidence } from './usageQuerySessionInputs';
import { projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import * as usageWorkEvidence from '@happier-dev/protocol/usage/usageWorkEvidence';
import { projectUsageSessionInput } from '@/sync/domains/usage/usageWorkEvidence';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, UsageSessionStateEvidenceSchema,
  type UsageSessionEvidenceResponse } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { buildUsageBreakdownList } from '@happier-dev/protocol/usage/usageLeaderProjection';
import { formatUsageCost } from '@happier-dev/protocol/usage/usageFormatting';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { summarizeUsageWork } from '@/components/settings/usage/widgets/usageWorkPresentation';
import { buildUsagePriceEditorModel } from '@/sync/domains/usage/usagePriceEditorModel';
import { resolveUsageShownCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
import { createUiCoachSuppressionPort } from './usageCoachSuppressions';
import { USAGE_COACH_SUPPRESSIONS_KV_KEY } from '@happier-dev/protocol/usage/coach/coachActions';
import { countUsageCheckedSessions } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';

const scmTransport = vi.hoisted(() => vi.fn());
function workBatch(request: { payload: ScmWorkEvidenceReadRequest }, result: Omit<ScmWorkEvidenceSessionResult, 'sessionId'>) {
  return ScmWorkEvidenceReadResponseSchema.parse({ sessions: request.payload.sessions.map(session => ({ sessionId: session.sessionId, ...result })) });
}
// These Homes are served at the HTTP boundary; prevent real Engine.IO dials
// from withdrawing their admitted Machine presence during Resource reads.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// Only the external daemon acknowledgement is substituted; scoped RPC admission stays real.
beforeEach(() => {
  scmTransport.mockReset();
  installSessionActionRpcBoundary((request, transport) => {
    const separator = request.method.indexOf(':');
    if (separator < 1) throw new Error('Expected a Machine daemon RPC');
    return scmTransport({ machineId: request.method.slice(0, separator),
      method: request.method.slice(separator + 1), payload: request.params, authorization: request.authorization, serverUrl: transport.serverUrl });
  });
});

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
let homeSequence = 0;
let sessionBatchBoundary: ReturnType<typeof createUsageSessionEvidenceHttpBoundary> | undefined;
const sessionRequests = () => [...home!.requests.filter(request => request.path !== '/v2/sessions/read-batch'),
  ...(sessionBatchBoundary?.componentRequests ?? [])];
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); clearMachineRequestReachabilityForTest(); await home?.dispose(); home = undefined;
  sessionBatchBoundary = undefined;
  // Digest and clock spies are system boundaries scoped to one case; leaving
  // them installed changes later Resource progress and timing observations.
  vi.restoreAllMocks();
});

const value: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
  cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
function successfulUsageFactWrite(body: unknown): Response {
  const write = SessionSystemRecordStoredUpsertRequestSchema.parse(body);
  return Response.json({ record: { ...write, id: 'sysrec_1', revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } });
}

const workContribution = { id: 'cost', observedAtMs: 500, sessionId: 'work-session', turnId: 'turn', agentId: null,
  modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
  tokens: value.totals.tokens, cost: value.totals.cost };

const ownerSessionAccess = {
  effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
    capabilities: createSessionAccessFixture().capabilities } satisfies NonNullable<UsageSessionEvidenceResponse['results'][number]['workFacts']>['session']['access'],
  responsibleAccountId: null, responsibleAccount: null,
};

async function context(route: Parameters<typeof serveAccountHomes>[0]['route'],
  profile?: Parameters<typeof serveAccountHomes>[0]['homes'][number]['profile'],
  settings?: Parameters<typeof serveAccountHomes>[0]['homes'][number]['settings'],
  homeOptions: Pick<Parameters<typeof serveAccountHomes>[0]['homes'][number], 'accountMode' | 'credentials' | 'encryptionCurrentness'> = {}) {
  // HTTP persistence boundary; the real B producer, protection, Resource and
  // Plans projection remain in-process. Server admission has its SQLite suite.
  const projections = new Map<string, ReturnType<typeof ProviderAccountUsagePageProjectionWriteV1Schema.parse>>();
  const kv = createAccountKvHttpFixture();
  sessionBatchBoundary = createUsageSessionEvidenceHttpBoundary(route, () => Object.keys(storage.getState().sessions));
  // Incumbent Work cases publish their fixture Session revision to the client.
  // Serve that same fixture on Home's metadata-only boundary. An explicit Home
  // response wins, including cases where there is no matching client row.
  const workTargets = createSessionReadBatchHttpBoundary(async request => {
    const explicit = await route(request);
    if (explicit || !request.path.startsWith('/v2/sessions/')) return explicit;
    const sessionId = decodeURIComponent(request.path.slice('/v2/sessions/'.length));
    const session = storage.getState().sessions[sessionId];
    return session?.encryptionMode === 'plain' ? Response.json(createPlainSessionByIdResponseFixture(session)) : undefined;
  });
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: `https://usage-batch-${++homeSequence}.test`, accountId: 'account-a', profile, settings, ...homeOptions }],
    route: async request => {
      if (request.path === '/v4/connect/qualified/provider-account-usage/history' && request.method === 'PUT') {
        const projection = ProviderAccountUsagePageProjectionWriteV1Schema.parse(request.body);
        projections.set(projection.recordId, projection);
        return Response.json({ success: true });
      }
      const metadataOnly = request.path === '/v2/sessions/read-batch'
        && SessionReadBatchRequestV1Schema.safeParse(request.body).data?.includeTurns === false;
      const response = metadataOnly ? await workTargets.handle(request) : await sessionBatchBoundary!.handle(request);
      if (request.path === '/v4/connect/qualified/provider-account-usage/history' && response?.ok) {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        if ('projection' in query) {
          // Cases exercising an incomplete/invalidated materialization can
          // serve the canonical HTTP read envelope instead of the default store.
          if (ProviderAccountUsagePageProjectionReadV1Schema.safeParse(await response.clone().json()).success) return response;
          const projection = projections.get(query.recordId) ?? null;
          return Response.json({ projection, complete: projection !== null });
        }
      }
      if (response) return response;
      const machineRead = createPlainMachineReadHttpResponseFixture(request.path, {
        method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      }, 'account-a', { activeAt: Date.now() });
      if (machineRead) return machineRead;
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v1/machines') return Response.json(Object.values(storage.getState().machines)
        .map(machine => createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine })));
      // This harness supplies a plain Account token; storage reads also need
      // its canonical currentness response, not just the legacy mode route.
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      const kvResponse = await kv.handleFetch(request.url, { method: request.method,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
      if (kvResponse) return kvResponse;
      return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method, headers: request.headers }) ?? undefined;
    } });
  const { sync } = await import('@/sync/sync');
  await sync.awaitBootstrapForegroundAcquisition();
  await sync.refreshSessions();
  await sync.refreshMachines();
  publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
  const captured = captureUiUsageQueryAccountContext(credentials);
  if (!captured) throw new Error('Expected admitted fixture Account');
  // The HTTP harness admits a Home/Account; its UI Profile projection must
  // carry that same scope before an Account-owned Usage read can use it.
  storage.setState({ profileScope: captured.accountLifetime.scope,
    profile: AccountProfileSchema.parse({ ...profile, id: captured.accountLifetime.scope.accountId }) });
  await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
  // Foreground bootstrap does not await the endpoint-online recovery queued
  // by these HTTP reads. Settle that real Home catch-up before measuring Usage
  // demand; its empty changes/metadata reads are not work caused by a reopen.
  await sync.resumeSync('server-reachable');
  return captured;
}

describe('usage query captured Resource adapter', () => {
  it('withdraws warm Accounting when Home requires present-user authority', async () => {
    let refused = false;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query-batch' && refused) {
        return Response.json({ error: 'present_user_required' }, { status: 403 });
      }
      return request.path === '/v2/usage/query' ? Response.json(value) : undefined;
    });
    const query = normalizeUsageQuery({ includeComparison: false, includeQuota: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    try {
      await entry.refresh({ supersede: false });
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals).toEqual(value.totals);
      const reads = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch').length;
      const previousReads = reads();
      refused = true;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, [], {
        changeKinds: ['account'], usageQueryAffects: true, usageAccountingChange: { sessionId: null },
      });
      await expect.poll(reads).toBeGreaterThan(previousReads);
      await expect.poll(() => entry.getSnapshot().error?.code).toBe('present_user_required');
      const declined = entry.getSnapshot();
      expect(declined.value ? decodeUsageQueryResource(declined.value).results[0]?.accounting : undefined).toBeUndefined();
    } finally { release(); }
  });

  it('retains distinct quota history keys for different periods with optional bounds', () => {
    const exact = normalizeUsageQuery({ period: { startMs: 0, endMs: 20, relative: undefined } });
    const same = normalizeUsageQuery({ ...exact, period: { startMs: 0, endMs: 20 } });
    const later = normalizeUsageQuery({ ...exact, period: { startMs: 1, endMs: 20 } });
    const open = normalizeUsageQuery({ ...exact, period: { startMs: undefined, endMs: 20 } });
    const week = normalizeUsageQuery({ ...exact, period: { relative: '7days', startMs: undefined } });
    const month = normalizeUsageQuery({ ...exact, period: { relative: '30days' } });

    expect(getRetainedQuotaPeriodKey(exact)).toBe(getRetainedQuotaPeriodKey(same));
    expect(new Set([exact, later, open, week, month].map(getRetainedQuotaPeriodKey)).size).toBe(5);
  });

  it.each(['empty', 'started', 'accounted'] as const)(
    'keeps the Coach population canonical when an archived %s Session has compact facts without turns', async kind => {
      const nowMs = 1_710_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(nowMs);
      const id = 'archived-launch';
      const session = createSessionFixture({ id, seq: 0, active: false, createdAt: nowMs - 1_000, updatedAt: nowMs - 100,
        sessionTurns: { v: 1, sessionId: id, updatedAt: nowMs - 100, turns: kind === 'started'
          ? [{ turnId: 'completed', status: 'completed', startedAt: nowMs - 800,
            terminalAt: nowMs - 600, updatedAt: nowMs - 100 }] : [] } });
      const records = usageWorkEvidence.createUsageSessionFactRecordsV1(session,
        projectSessionUsageWorkEvidence(session, [], { messagesComplete: true }));
      const captured = await context(request => {
        if (request.path === '/v2/usage/query') return Response.json({ ...value,
          totals: kind === 'accounted' ? value.totals : { eventCount: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
          sessionIds: kind === 'accounted' ? [id] : [], sessionMembership: { turns: [] },
        } satisfies UsageAnalyticsQueryResponse);
        if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
        const input = UsageSessionEvidenceRequestSchema.parse(request.body);
        return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })),
          results: [{ sessionId: id, workFacts: { session: { id, seq: 0, createdAt: session.createdAt, updatedAt: session.updatedAt, active: false,
            metadataVersion: session.metadataVersion, agentStateVersion: session.agentStateVersion,
            metadataLayoutVersion: session.metadataLayoutVersion ?? 0, encryptionMode: 'plain',
            dataEncryptionKey: null, viewerRole: 'owner', access: ownerSessionAccess.effectiveAccess },
            records: records.filter(record => (input.workFactKinds ?? ['work']).includes(record.kind))
              .map(record => ({ kind: record.kind, content: { t: 'plain', v: projectNativeJsonValueForTransport(record) } })) } }],
        } satisfies UsageSessionEvidenceResponse);
      });
      const query = normalizeUsageQuery({ period: { relative: '7days' }, includeCoach: true,
        includeTranscriptEvidence: true, includeWorkEvidence: false, includeQuota: false, includeComparison: false });
      for (let visit = 0; visit < 2; visit++) {
        const slice = (await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]!;
        expect(countUsageCheckedSessions(slice.coach?.sessionCoverage)).toBe(kind === 'empty' ? 0 : 1);
        expect(slice.coach?.sessionCoverage).toEqual(slice.howYouWork?.sessionCoverage);
      }
    });

  it('retains settled allowance rows and states when a replacement revision is partial', () => {
    const sourceA = { bindingKind: 'account' as const, ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai' }, accountId: 'a' } };
    const sourceB = { bindingKind: 'account' as const, ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai' }, accountId: 'b' } };
    const sourceKey = (source: typeof sourceA) => `quota:${createCanonicalJsonSigningInput(source)}`;
    const quotaRead = (source: typeof sourceA, observed: boolean) => {
      const recordKey = { providerId: 'codex', accountSubjectId: source.ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
      return ConnectedServiceQuotaGetResultV1Schema.parse({ source, pace: [], targets: [], waitingWork: { status: 'available', entries: [] },
        current: observed ? { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'codex',
          accountSubject: { kind: 'providerSubject', id: source.ref.accountId }, observedAtMs: 1, fetchedAtMs: 1,
          staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] } : null });
    };
    const previous = {
      quota: [quotaRead(sourceA, true), quotaRead(sourceB, true)],
      sources: [
        { source: sourceKey(sourceA), status: 'available' as const },
        { source: sourceKey(sourceB), status: 'available' as const },
      ],
    };
    const replacement = {
      quota: [quotaRead(sourceA, false)],
      sources: [
        { source: sourceKey(sourceA), status: 'pending' as const },
      ],
    };
    const merged = mergeRetainedUsageAllowance(previous, replacement);
    expect(merged.quota.map(read => read.current?.recordId)).toEqual(previous.quota.map(read => read.current!.recordId));
    expect(merged.sources).toEqual(previous.sources);
  });

  it('normalizes evidence demand per query phase rather than per selected Session', async () => {
    let ids = ['demand-0'];
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: ids })),
        results: ids.map(id => ({ sessionId: id,
          detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, active: false }) } },
          turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [] } },
        })) } satisfies UsageSessionEvidenceResponse);
    });
    // Observe the real normalization owner; no internal result is replaced.
    const normalize = vi.spyOn(usageSessionEvidence, 'getUsageSessionEvidenceDemandKey');
    const read = async (startMs: number) => {
      normalize.mockClear();
      const batch = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({
        period: { startMs, endMs: 2000 }, includeWorkEvidence: false, includeQuotaHistory: false,
        includeComparison: false, includeTranscriptEvidence: false,
      })] });
      expect(batch.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ selected: ids.length, admitted: ids.length });
      return normalize.mock.calls.length;
    };
    const single = await read(0);
    ids = Array.from({ length: 64 }, (_, index) => `demand-${index}`);
    expect(await read(1), 'a larger cohort must not repeat query normalization for each Session').toBe(single);
  });

  it('writes each scoped compact fact once per real Session change and never for an unchanged minute', async () => {
    const id = 'compact-write-cost';
    let seq = 1;
    let nowMs = 1_710_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const captured = await context(request => {
      if (request.method === 'PUT' && request.path === `/v2/sessions/${id}/system-records`) {
        return successfulUsageFactWrite(request.body);
      }
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })),
        results: [{ sessionId: id,
          detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq, active: false }) } },
          turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
            { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
          ] } }, ...(input.requests[0]!.query.includeTranscriptEvidence
            ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
        }] } satisfies UsageSessionEvidenceResponse);
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false,
      includeQuotaHistory: false, includeComparison: false, includeTranscriptEvidence: true });
    const writes = () => home!.requests.filter(request => request.method === 'PUT'
      && request.path === `/v2/sessions/${id}/system-records`).map(request => {
        const { content } = SessionSystemRecordStoredUpsertRequestSchema.parse(request.body);
        const fact = usageWorkEvidence.UsageSessionFactRecordV1Schema.parse(content.t === 'plain' ? content.v : null);
        return { kind: fact.kind, seq: fact.seq };
      });
    const read = () => readUiUsageQueryBatch(captured, { queries: [query] });
    const initial = (await read()).results[0];
    expect(home!.requests.filter(request => request.path === `/v2/sessions/${id}/system-records`).map(request => request.method),
      'complete private evidence saves Coach then work through the server-owned PUT contract').toEqual(['PUT', 'PUT']);
    expect(initial?.howYouWork?.sessionCoverage).toMatchObject({ selected: 1, admitted: 1, notRead: 0 });
    expect(writes()).toEqual([{ kind: 'coach', seq: 1 }, { kind: 'work', seq: 1 }]);
    for (let tick = 0; tick < 60; tick++) {
      nowMs += 1000;
      await read();
    }
    expect(writes(), 'sixty unchanged clock advances produce no extra compact writes')
      .toEqual([{ kind: 'coach', seq: 1 }, { kind: 'work', seq: 1 }]);
    seq++;
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, [id],
      { changeKinds: ['session'], usageQueryAffects: true, usageAccountingAffects: false });
    expect((await read()).results[0]?.howYouWork?.sessionCoverage).toMatchObject({ selected: 1, admitted: 1, notRead: 0 });
    expect(writes(), 'a real Session advance persists each replacement once').toEqual([
      { kind: 'coach', seq: 1 }, { kind: 'work', seq: 1 }, { kind: 'coach', seq: 2 }, { kind: 'work', seq: 2 },
    ]);
    await read();
    expect(writes()).toHaveLength(4);
  });

  it('checks only named non-member Session candidates when a live Usage window wakes', async () => {
    const initial = ['window-a', 'window-b', 'window-c'];
    const selected = new Set(initial);
    const subjects: string[][] = [];
    let memberSeq = 1;
    const captured = await context(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: undefined, sessionIds: [] });
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      const demand = input.requests[0]!;
      const rawCandidates: unknown = Reflect.get(demand, 'candidateSessionIds');
      const candidates = Array.isArray(rawCandidates) ? rawCandidates.filter((id): id is string => typeof id === 'string') : undefined;
      const ids = demand.sessionIds ?? (candidates ?? [...selected]).filter(id => selected.has(id));
      if (!demand.query.includeTranscriptEvidence) subjects.push(ids);
      return Response.json({ requests: [{ query: demand.query, sessionIds: ids }], results: ids.map(id => ({ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id,
          seq: id === initial[0] ? memberSeq : 1 }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100,
            terminalAt: id === initial[0] ? 400 + (memberSeq - 1) * 100 : 400, updatedAt: 900 },
        ] } }, ...(demand.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
      })) } satisfies UsageSessionEvidenceResponse);
    });
    // Observe real Session fact derivation through HTTP, admission and the
    // Resource's input owner; no internal derivation result is substituted.
    const derive = vi.spyOn(usageWorkEvidence, 'projectSessionUsageWorkEvidence');
    // The shared read opens summary facts, then the richer transcript input,
    // independently of this widget's output flags. Each is derived once.
    const expectDerivedSessions = (ids: readonly string[]) => {
      for (const transcript of [false, true]) {
        expect(derive.mock.calls.filter(([, , coverage]) => (coverage !== undefined) === transcript)
          .map(([session]) => session.id).sort(), transcript ? 'transcript inputs' : 'summary inputs')
          .toEqual([...ids].sort());
      }
      derive.mock.calls.forEach(([, , coverage], index) => {
        const projected = derive.mock.results[index]!;
        expect(projected.type).toBe('return');
        if (projected.type === 'return') {
          expect(projected.value.acceptedInputs).toEqual(coverage === undefined ? undefined : []);
        }
      });
    };
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false,
      includeTranscriptEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    const wait = async () => {
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      await flushHookEffects({ cycles: 20 });
    };
    const wake = (id: string) => publishHomeAccountChange(captured.accountLifetime.scope.serverId, [id],
      { changeKinds: ['session'], usageQueryAffects: true, usageAccountingAffects: false });
    try {
      await wait();
      expect(subjects.flat()).toHaveLength(initial.length);
      expectDerivedSessions(initial);
      derive.mockClear();
      await act(async () => wake('outside-window'));
      await wait();
      expect(subjects.flat(), 'an irrelevant one-Session wake must not transfer the admitted window again').toHaveLength(initial.length);
      expect(derive.mock.calls, 'an unrelated arrival must not rederive admitted Sessions').toHaveLength(0);
      selected.add('arriving');
      await act(async () => wake('arriving'));
      await wait();
      expect(subjects.flat(), JSON.stringify(subjects)).toHaveLength(initial.length + 1);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork)
        .toMatchObject({ sessionCoverage: { selected: initial.length + 1, admitted: initial.length + 1 },
          intervals: { agentTimeMs: 1200 } });
      expectDerivedSessions(['arriving']);
      const reads = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
        .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
      expect(reads.filter(row => !row.sessionIds && !Reflect.get(row, 'candidateSessionIds'))).toHaveLength(1);
      expect(reads.flatMap(row => Reflect.get(row, 'candidateSessionIds') ?? [])).toEqual(['outside-window', 'arriving']);
      derive.mockClear();
      memberSeq++;
      await act(async () => wake(initial[0]!));
      await wait();
      expectDerivedSessions([initial[0]!]);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork)
        .toMatchObject({ sessionCoverage: { selected: initial.length + 1, admitted: initial.length + 1 },
          intervals: { agentTimeMs: 1300 } });
    } finally { release(); }
  });

  it.each(['http', 'detail', 'turns', 'messages'] as const)('retains accounting when projected historical Usage evidence admission is refused (%s)', async component => {
    const id = 'refused-historical';
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: undefined,
        sessionIds: [id], sessionMembership: { turns: [{ sessionId: id, turnId: 'turn', executions: ['happier'] }] } });
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      if (input.requests[0]!.sessionIds === undefined) return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [] })), results: [] });
      if (component === 'http') return Response.json({ error: 'credential_scope_denied' }, { status: 403 });
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })), results: [{ sessionId: id,
        detail: component === 'detail' ? { status: 403, body: { error: 'forbidden' } }
          : { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 }) } },
        turns: component === 'turns' ? { status: 403, body: { error: 'forbidden' } }
          : { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
            { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
          ] } }, ...(component === 'messages' && input.requests[0]!.query.includeTranscriptEvidence
          ? { messages: { status: 403, body: { error: 'forbidden' } } } : {}),
      }] });
    });
    const batch = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 },
      machines: ['machine-a'], includeWorkEvidence: false })] });
    expect(batch.results[0]?.accounting?.totals.tokens.total).toBe(15);
    if (component === 'http') expect(batch.results[0]?.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work',
      errorCode: 'credential_scope_denied' }));
    else expect(batch.results[0]?.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'unknown' }));
    expect(batch.results[0]?.howYouWork?.inputs).toBeNull();
  });

  it.each(['machine', 'agent'] as const)('keeps compact historical %s membership when current Session discovery excludes it', async dimension => {
    const id = 'historical-selected';
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: undefined,
        sessionIds: [id], sessionMembership: { turns: [{ sessionId: id, turnId: 'turn', executions: ['happier'] }] } });
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      const ids = input.requests[0]!.sessionIds ?? [];
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: ids })), results: ids.map(sessionId => ({ sessionId,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, seq: 1,
          metadata: { path: '/repo', host: 'usage-test', machineId: 'machine-b' } }) } },
        turns: { status: 200, body: { v: 1, sessionId, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
        ] } }, ...(input.requests[0]!.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [{ inputId: 'accepted',
          workId: JSON.stringify([id, 'turn']), acceptedAtMs: 200, deliveryKind: 'steer', turnId: 'turn' }] }, messagesComplete: true } : {}),
      })) } satisfies UsageSessionEvidenceResponse);
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false,
      ...(dimension === 'machine' ? { machines: ['machine-a'] } : { agents: ['claude'] }) });
    const batch = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(batch.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
    expect(batch.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 1, steeringCount: 1 });
    const demands = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
    expect(demands.some(demand => demand.sessionIds === undefined)).toBe(true);
    expect(demands.some(demand => !demand.query.includeTranscriptEvidence && demand.sessionIds?.includes(id))).toBe(true);
    expect(home!.requests.some(request => request.path === '/v2/sessions/read-batch')).toBe(false);
  });

  it.each(['today', '7days', '90days'] as const)('keeps %s evidence within discovered and window-accounting membership despite a large hydrated inventory', async relative => {
    const nowMs = 1_710_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const discoveredId = 'window-discovered';
    const historicalId = 'window-historical-turn';
    const nullTurnId = 'window-historical-null-turn';
    const selectedIds = [discoveredId, historicalId, nullTurnId];
    // The accounting boundary admits only this window's two historical members.
    // The hydrated list also contains older accounting Sessions from other periods.
    const unrelatedIds = Array.from({ length: 3233 }, (_, index) => `older-accounting-${index}`);
    const captured = await context(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) {
        const write = SessionSystemRecordStoredUpsertRequestSchema.parse(request.body);
        return Response.json({ record: { ...write, id: 'sysrec_1', revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
          createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString() } });
      }
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: undefined,
        sessionIds: [historicalId, nullTurnId], sessionMembership: { turns: [
          { sessionId: historicalId, turnId: 'turn', executions: ['happier'] },
        ] } });
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      const demand = input.requests[0]!;
      const ids = demand.sessionIds ?? [discoveredId];
      return Response.json({ requests: [{ query: demand.query, sessionIds: ids }], results: ids.map(sessionId => ({ sessionId,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, seq: 1,
          metadata: { path: '/repo', host: 'usage-test', machineId: sessionId === discoveredId ? 'machine-a' : 'machine-b' } }) } },
        turns: { status: 200, body: { v: 1, sessionId, updatedAt: nowMs - 100, turns: sessionId === nullTurnId ? [] : [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: nowMs - 900, terminalAt: nowMs - 600, updatedAt: nowMs - 100 },
        ] } }, ...(demand.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: sessionId === nullTurnId ? [] : [{ inputId: `input-${sessionId}`,
          workId: JSON.stringify([sessionId, 'turn']), acceptedAtMs: nowMs - 800,
          deliveryKind: 'steer', turnId: 'turn' }] }, messagesComplete: true } : {}),
      })) } satisfies UsageSessionEvidenceResponse);
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: Object.fromEntries([...unrelatedIds, ...selectedIds].map(id => [id,
      createSessionFixture({ id, seq: 1, serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain',
        createdAt: nowMs - 400 * 86_400_000, updatedAt: nowMs - 400 * 86_400_000 })])) });
    const query = normalizeUsageQuery({ period: { relative }, includeComparison: false, includeWorkEvidence: false });
    let result = await readUiUsageQueryBatch(captured, { queries: [query] });
    const demands = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
    expect(demands.filter(demand => demand.sessionIds === undefined)).toHaveLength(1);
    expect(demands.filter(demand => !demand.query.includeTranscriptEvidence && demand.sessionIds !== undefined)
      .flatMap(demand => demand.sessionIds!).sort()).toEqual([historicalId, nullTurnId].sort());
    // The shared owner auto-reads missing facts through 30D; wide windows require Read now.
    const opensTranscripts = relative !== '90days';
    expect(demands.filter(demand => demand.query.includeTranscriptEvidence).flatMap(demand => demand.sessionIds ?? []).sort())
      .toEqual(opensTranscripts ? [...selectedIds].sort() : []);
    expect(demands.every(demand => demand.sessionIds?.every(id => selectedIds.includes(id)) ?? true)).toBe(true);
    expect(result.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ selected: 3, admitted: 3 });
    expect(result.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(600);
    if (opensTranscripts) expect(result.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 2 });
    else expect(result.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ notRead: 3 });
    if (relative === '90days') {
      expect(result.results[0]?.howYouWork?.inputs).toBeNull();
      const { readUiUsageHistory } = await import('./usageQueryResource');
      expect(await readUiUsageHistory(captured, { query })).toMatchObject({ status: 'complete',
        progress: { selected: 3, notRead: 0, completed: 3, failed: 0 } });
      result = await readUiUsageQueryBatch(captured, { queries: [query] });
      const completedDemands = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
        .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
      expect(completedDemands.filter(demand => demand.query.includeTranscriptEvidence)
        .flatMap(demand => demand.sessionIds ?? []).sort()).toEqual([...selectedIds].sort());
      expect(completedDemands.every(demand => demand.sessionIds?.every(id => selectedIds.includes(id)) ?? true)).toBe(true);
      expect(result.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ selected: 3, admitted: 3 });
      expect(result.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(600);
      expect(result.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 2 });
    }
  });

  it.each(['stream', 'buffered', 'truncated'] as const)('reads %s projected Usage records across UTF-8 boundaries and admits only a complete cohort', async transport => {
    const ids = ['stream-a', 'stream-b'];
    const turnId = 'turn-🚀';
    let truncate = transport === 'truncated';
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      const results: UsageSessionEvidenceResponse['results'] = ids.map(id => ({ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId, agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
        ] } }, ...(input.requests[0]!.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [{
          inputId: `input-${id}`, workId: JSON.stringify([id, turnId]), acceptedAtMs: 200, deliveryKind: 'steer', turnId,
        }] }, messagesComplete: true } : {}),
      }));
      const text = [JSON.stringify({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: ids })) }),
        ...results.slice(0, truncate ? 1 : 2).map(result => JSON.stringify(result))].join('\r\n');
      const bytes = new TextEncoder().encode(text);
      let offset = 0;
      const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (offset === bytes.length) { controller.close(); return; }
        const end = Math.min(offset + 7, bytes.length);
        controller.enqueue(bytes.subarray(offset, end)); offset = end;
      } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
      if (transport === 'buffered') Object.defineProperty(response, 'body', { value: null });
      return response;
    });
    const input = { queries: [normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false })] };
    let reading = readUiUsageQueryBatch(captured, input);
    if (transport === 'truncated') {
      await expect(reading).rejects.toThrow();
      truncate = false;
      reading = readUiUsageQueryBatch(captured, input);
    }
    const batch = await reading;
    expect(batch.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(600);
    expect(batch.results[0]?.howYouWork?.intervals?.lanes.map(lane => lane.workId).sort()).toEqual(ids.map(id => JSON.stringify([id, turnId])));
    expect(batch.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 2, steeringCount: 2 });
    expect(home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .every(request => request.headers.get('Accept') === 'application/x-ndjson')).toBe(true);
    expect(home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests)
      .filter(demand => demand.sessionIds === undefined)).toHaveLength(transport === 'truncated' ? 2 : 1);
  });

  it('does not cancel completed Usage evidence after EOF', async () => {
    const captured = await context(request => {
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      return new Response(JSON.stringify({ requests: input.requests.map(row => ({ query: row.query, sessionIds: [] })) }) + '\n',
        { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    const transport = captured.readTransport!;
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const observed: typeof captured = { ...captured, readTransport: { ...transport,
      read(path, init, options, consume) {
        return transport.read(path, init, options, response => {
          // Observe the real network response borrower; parsing and settlement stay real.
          if (path === USAGE_SESSION_EVIDENCE_PATH && response.body) {
            const reader = response.body.getReader();
            readers.push(reader);
            vi.spyOn(reader, 'cancel');
            Object.defineProperty(response.body, 'getReader', { value: () => reader });
          }
          return consume(response);
        });
      },
    } };
    const batch = await readUiUsageQueryBatch(observed, { queries: [normalizeUsageQuery({ period: { relative: '90days' } })] });
    expect(batch.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ selected: 0, admitted: 0 });
    expect(readers.length).toBeGreaterThan(0);
    for (const reader of readers) expect(reader.cancel, 'a fully consumed response is not cancelled during settlement').not.toHaveBeenCalled();
  });

  it('cancels a held Usage evidence stream on Account retirement without publishing its unfinished private facts', async () => {
    const id = 'stream-retirement';
    const consumed = createDeferred<void>();
    let cancelled = false;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      const response = { requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })), results: [{ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
        ] } }, messageEvidence: { acceptedInputs: [{ inputId: 'accepted', workId: JSON.stringify([id, 'turn']),
          acceptedAtMs: 200, deliveryKind: 'steer', turnId: 'turn' }] }, messagesComplete: true,
      }] } satisfies UsageSessionEvidenceResponse;
      if (!input.requests[0]!.query.includeTranscriptEvidence) return Response.json(response);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode([JSON.stringify({ requests: response.requests }),
          ...response.results.map(result => JSON.stringify(result)), ''].join('\n')));
      }, pull() { consumed.resolve(); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [
      normalizeUsageQuery({ session: id, period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false }),
    ] }) });
    const release = entry.subscribe(() => {}, false);
    const reading = entry.refresh();
    try {
      await consumed.promise;
      await expect.poll(() => entry.getSnapshot().value
        && decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
      const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      expect(slice.howYouWork?.intervals?.agentTimeMs).toBe(300);
      expect(slice.howYouWork?.inputs).toBeNull();
      retireActiveServerAccountScopeLifetime();
      await reading;
      await expect.poll(() => cancelled).toBe(true);
      expect(entry.getSnapshot().value).toBeUndefined();
    } finally { retireActiveServerAccountScopeLifetime(); await reading; release(); }
  });

  it.each(['action', 'joined-signal'] as const)('cancels the Account history read and its held evidence stream (%s)', async cancellation => {
    const consumed = createDeferred<void>();
    let cancelled = false;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ requests: input.requests.map(demand => ({
          query: demand.query, sessionIds: ['held-history'],
        })) }) + '\n'));
      }, pull() { consumed.resolve(); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    const { readUiUsageHistory, getUiUsageHistoryState } = await import('./usageQueryResource');
    const query = normalizeUsageQuery({ period: { relative: '90days' }, includeWorkEvidence: false });
    const reading = readUiUsageHistory(captured, { query });
    await consumed.promise;
    expect(getUiUsageHistoryState(captured, query).status).toBe('reading');
    let joined: ReturnType<typeof readUiUsageHistory> | undefined;
    if (cancellation === 'action') {
      const result = await createDefaultActionExecutor().execute(USAGE_HISTORY_ACTION_IDS.read, { query, operation: 'cancel' }, {
        surface: 'ui', actionCaller: { kind: 'host' }, serverId: captured.accountLifetime.scope.serverId,
        expectedAccountId: captured.accountLifetime.scope.accountId, authority: 'present_user',
      });
      expect(result.ok).toBe(true);
    } else {
      const controller = new AbortController();
      joined = readUiUsageHistory(captured, { query }, { signal: controller.signal });
      controller.abort();
    }
    const state = await reading;
    expect(state).toMatchObject({ status: 'cancelled', progress: { completed: 0, failed: 0 } });
    if (joined) expect(await joined).toEqual(state);
    expect(getUiUsageHistoryState(captured, query)).toEqual(state);
    expect(cancelled, 'local cancellation closes the real pending HTTP body').toBe(true);
  });

  it.each([false, true])('projects content-free permission and wait facts with no AgentState (transcript %s)', async includeTranscriptEvidence => {
    const { projectUsageSessionStateEvidenceFromRequests } = await import('@happier-dev/protocol/usage/usageWorkEvidence');
    const id = 'projected-state';
    const stateEvidence = UsageSessionStateEvidenceSchema.parse(projectUsageSessionStateEvidenceFromRequests({ sessionId: id, machineId: null,
      turns: [{ turnId: 'turn', agentId: 'codex' }], requests: {}, completedRequests: {
        permission: { tool: 'Bash', turnId: 'turn', createdAt: 100, completedAt: 200, status: 'approved' },
      } }));
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })), results: [{ sessionId: id,
        detail: { status: 200, body: { session: { ...createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 }), agentState: null } } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
        ] } }, stateEvidence,
        ...(input.requests[0]!.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
      }] } satisfies UsageSessionEvidenceResponse);
    });
    const batch = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ session: id,
      period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false, includeTranscriptEvidence })] });
    expect(batch.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(200);
    expect(batch.results[0]?.howYouWork?.permissions).toMatchObject({ decisionLatencyMs: 100 });
  });

  it('isolates compact row stale context from newly admitted turns', async () => {
    const captured = await context(() => undefined);
    const [{ openUsageCompactInput }, { captureServerRequestAuthorityForServerAccountScope }] = await Promise.all([
      import('./usageCompactInput'),
      import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope'),
    ]);
    const authority = await captureServerRequestAuthorityForServerAccountScope({ scope: captured.accountLifetime.scope,
      activeRequest: captured.request });
    const id = 'stale-compact-context';
    const identity = { id, seq: 2, createdAt: 0, updatedAt: 900, active: false,
      metadataVersion: 2, agentStateVersion: 2, metadataLayoutVersion: 1,
      encryptionMode: 'plain' as const, dataEncryptionKey: null, viewerRole: 'owner' as const,
      access: ownerSessionAccess.effectiveAccess };
    try {
      for (const basis of [
        { seq: 1, metadataVersion: 2, agentStateVersion: 2 },
        { seq: 2, metadataVersion: 1, agentStateVersion: 2 },
        { seq: 2, metadataVersion: 2, agentStateVersion: 1 },
        { seq: 2, metadataVersion: 2, agentStateVersion: 2 },
      ]) {
        const current = Object.entries(basis).every(([key, version]) => identity[key as keyof typeof basis] === version);
        const opened = await openUsageCompactInput({ context: captured, opening: authority.context,
          isCurrent: captured.accountLifetime.isCurrent, row: { sessionId: id,
            workFacts: { session: identity, records: [{ kind: 'work', content: { t: 'plain', v: projectNativeJsonValueForTransport({ v: 1, kind: 'work', ...basis,
              evidence: { status: 'partial' }, session: { metadata: { machineId: 'old-machine' },
                ownerMetadata: { machineId: 'old-machine', path: '/old/private/path' } } }) } }] },
            turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
              { turnId: 'new-turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
            ] } },
          } });
        if (!opened) throw new Error('Admitted turns must retain baseline summary evidence');
        expect(opened.completeMessageCoverage).toBe(current);
        expect(opened.session.metadata).toEqual(current ? { machineId: 'old-machine' } : null);
        expect(opened.session.ownerMetadata).toEqual(current ? { machineId: 'old-machine', path: '/old/private/path' } : null);
        if (!current) expect(opened.detail.facts).toEqual(expect.arrayContaining([
          expect.objectContaining({ evidenceId: 'new-turn', machineId: null }),
        ]));
      }
    } finally { await authority.release(); }
  });

  it.each(['missing', 'seq', 'metadata', 'state', 'substituted', 'wrong-mode'] as const)(
    'keeps Coach history partial for a %s sibling without discarding work compactions', async status => {
      const [{ openUsageCompactInput }, { captureServerRequestAuthorityForServerAccountScope }] = await Promise.all([
        import('./usageCompactInput'), import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope'),
      ]);
      const captured = await context(() => undefined);
      const authority = await captureServerRequestAuthorityForServerAccountScope({ scope: captured.accountLifetime.scope,
        activeRequest: captured.request });
      const id = 'partial-coach';
      const identity = { id, seq: 2, createdAt: 0, updatedAt: 900, active: false,
        metadataVersion: 2, agentStateVersion: 2, metadataLayoutVersion: 1,
        encryptionMode: 'plain' as const, dataEncryptionKey: null, viewerRole: 'owner' as const,
        access: ownerSessionAccess.effectiveAccess };
      const facts = usageWorkEvidence.createUsageSessionFactRecordsV1({ ...identity, metadata: null, agentState: null }, {
        status: 'available', coach: { compositionCoverage: 'partial', composition: [], detail: { coverage: 'partial',
          compactions: [{ evidenceId: 'retained-compaction', observedAtMs: 300, sessionId: id, turnId: null }] } },
      });
      const work = facts.find(fact => fact.kind === 'work')!;
      const coach = facts.find(fact => fact.kind === 'coach')!;
      const sibling = status === 'seq' ? { ...coach, seq: 1 } : status === 'metadata' ? { ...coach, metadataVersion: 1 }
        : status === 'state' ? { ...coach, agentStateVersion: 1 } : status === 'substituted' ? work : coach;
      try {
        const opened = openUsageCompactInput({ context: captured, opening: authority.context,
          isCurrent: captured.accountLifetime.isCurrent, recordKinds: ['work', 'coach'], row: { sessionId: id,
            workFacts: { session: identity, records: [
              { kind: 'work', content: { t: 'plain', v: projectNativeJsonValueForTransport(work) } },
              { kind: 'coach', content: status === 'missing' ? null : status === 'wrong-mode'
                ? { t: 'encrypted', c: 'opaque' } : { t: 'plain', v: projectNativeJsonValueForTransport(sibling) } },
            ] } } });
        if (status === 'substituted') await expect(opened).rejects.toThrow();
        else if (status === 'wrong-mode') await expect(opened).rejects.toMatchObject({ code: 'usage_work_facts_mode_mismatch' });
        else {
          const value = await opened;
          expect(value?.completeMessageCoverage).toBe(false);
          expect(value?.detail.coach).toMatchObject({ compositionCoverage: 'unknown', detail: { coverage: 'unknown',
            compactions: [{ evidenceId: 'retained-compaction' }] } });
        }
      } finally { await authority.release(); }
    });

  it.each(['plain', 'e2ee'] as const)('round-trips both scoped facts through real sealing for a %s Session', async mode => {
    const [{ openUsageCompactInput, persistUsageCompactInput }, { captureServerRequestAuthorityForServerAccountScope },
      { Encryption }, { encodeBase64 }, { sealEncryptedDataKeyEnvelopeV1 }] = await Promise.all([
      import('./usageCompactInput'), import('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope'),
      import('@/sync/encryption/encryption'), import('@/encryption/base64'), import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1'),
    ]);
    const id = `sealed-scoped-${mode}`;
    const secret = new Uint8Array(32).fill(7);
    const sessionKey = new Uint8Array(32).fill(9);
    const encryption = mode === 'e2ee' ? await Encryption.create(secret) : null;
    const dataEncryptionKey = mode === 'plain' ? null : encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionKey,
      recipientPublicKey: encryption!.contentDataKey, randomBytes: length => new Uint8Array(length).fill(3) }), 'base64');
    const stored = new Map<string, ReturnType<typeof SessionSystemRecordStoredUpsertRequestSchema.parse>['content']>();
    const credentials = { token: createServedHomeAccountToken('account-a'),
      ...(mode === 'e2ee' ? { secret: encodeBase64(secret, 'base64url') } : {}) };
    const captured = await context(request => {
      if (request.path !== `/v2/sessions/${id}/system-records` || request.method !== 'PUT') return undefined;
      const record = SessionSystemRecordStoredUpsertRequestSchema.parse(request.body);
      stored.set(record.address.localId, record.content);
      return successfulUsageFactWrite(request.body);
    }, undefined, undefined, { credentials, accountMode: mode,
      encryptionCurrentness: () => createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    const authority = await captureServerRequestAuthorityForServerAccountScope({ scope: captured.accountLifetime.scope,
      activeRequest: captured.request });
    const session = projectUsageSessionInput(createSessionFixture({ id, seq: 2, active: false, encryptionMode: mode,
      serverId: captured.accountLifetime.scope.serverId, metadataVersion: 2, agentStateVersion: 2 }));
    const detail = { status: 'partial' as const, acceptedInputs: [], phaseEvents: [],
      coach: { compositionCoverage: 'partial' as const, composition: [], detail: { coverage: 'partial' as const,
        compactions: [{ evidenceId: 'saved-compaction', observedAtMs: 300, sessionId: id, turnId: null }], mcpUsage: [], modelRequests: [] } } };
    try {
      expect(await persistUsageCompactInput({ context: captured, opening: authority.context,
        value: { session, callerDataKeyEnvelope: dataEncryptionKey, detail, completeMessageCoverage: true },
        isCurrent: captured.accountLifetime.isCurrent })).toBe(true);
      expect([...stored.keys()]).toEqual(['coach', 'work']);
      expect([...stored.values()].map(content => content.t)).toEqual(mode === 'plain' ? ['plain', 'plain'] : ['encrypted', 'encrypted']);
      const opened = await openUsageCompactInput({ context: captured, opening: authority.context,
        isCurrent: captured.accountLifetime.isCurrent, recordKinds: ['work', 'coach'], row: { sessionId: id,
          workFacts: { session: { id, seq: 2, createdAt: 0, updatedAt: session.updatedAt, active: false,
            metadataVersion: 2, agentStateVersion: 2, metadataLayoutVersion: session.metadataLayoutVersion ?? 0,
            encryptionMode: mode, dataEncryptionKey, viewerRole: 'owner', access: ownerSessionAccess.effectiveAccess },
            records: (['work', 'coach'] as const).map(kind => ({ kind, content: stored.get(kind)! })) } } });
      expect(opened?.completeMessageCoverage).toBe(true);
      expect(opened?.detail).toEqual(detail);
    } finally { await authority.release(); }
  });

  it('reads zero Coach records for a census-sized Usage open and one scoped cohort when Coach mounts', async () => {
    // USAGE-PAYLOAD-IDLE-1107 measured 3,368 opened compact records.
    const count = 3_368;
    const facts = Array.from({ length: count }, (_, index) => {
      const id = `scoped-fact-${index}`;
      return usageWorkEvidence.createUsageSessionFactRecordsV1({ id, seq: 1, active: false,
        metadataVersion: 1, agentStateVersion: 1, metadata: null, agentState: null }, {
        status: 'available', acceptedInputs: [], phaseEvents: [],
        coach: { compositionCoverage: 'partial', composition: [{ v: 1, evidenceId: 'composition', sessionId: id,
          turnId: null, inputId: null, observedAtMs: 200, boundary: 'host_pre_dispatch', deliveryKind: 'newTurn',
          coverage: 'host_only', nativePrefix: null, contextWindowTokens: null,
          components: Array.from({ length: 8 }, (_, component) => ({ sourceId: component.toString(16).repeat(64),
            digest: 'b'.repeat(64), kind: 'instructions', location: 'user', byteLength: 200,
            tokenCount: null, tokenizerId: null, cacheClass: 'unknown', overlap: 'none' })) }],
          detail: { coverage: 'partial', compactions: [{ evidenceId: 'compaction', sessionId: id, turnId: null, observedAtMs: 300 }],
            mcpUsage: [], modelRequests: [] } },
      });
    });
    let coachRecords = 0;
    let reads = 0;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      reads++;
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query,
        sessionIds: facts.map((_, index) => `scoped-fact-${index}`) })),
        results: facts.map((records, index) => {
          const selected = records.filter(fact => (input.workFactKinds ?? ['work']).includes(fact.kind));
          coachRecords += selected.filter(fact => fact.kind === 'coach').length;
          const id = `scoped-fact-${index}`;
          return { sessionId: id, workFacts: { session: { id, seq: 1, createdAt: 0, updatedAt: 900, active: false,
            metadataVersion: 1, agentStateVersion: 1, metadataLayoutVersion: 1, encryptionMode: 'plain',
            dataEncryptionKey: null, viewerRole: 'owner', access: ownerSessionAccess.effectiveAccess },
            records: selected.map(fact => ({ kind: fact.kind, content: { t: 'plain', v: projectNativeJsonValueForTransport(fact) } })) } };
        }) });
    });
    const query = normalizeUsageQuery({ period: { relative: 'all' }, includeCoach: false, includeQuota: false,
      includeWorkEvidence: false, includeTranscriptEvidence: false });
    const opened = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(opened.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ selected: count, admitted: count, notRead: 0 });
    expect(coachRecords, 'Usage must not receive Coach-only evidence records').toBe(0);
    expect(reads).toBe(1);
    const coach = normalizeUsageQuery({ ...query, includeCoach: true, includeTranscriptEvidence: true });
    await readUiUsageQueryBatch(captured, { queries: [coach, coach] });
    expect(coachRecords).toBe(count);
    expect(reads, 'One scoped physical read serves the mounted Coach cohort').toBe(2);
    await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(reads, 'Returning to Usage reuses its admitted work records').toBe(2);
    await readUiUsageQueryBatch(captured, { queries: [
      normalizeUsageQuery({ ...query, period: { relative: '90days' } }),
      normalizeUsageQuery({ ...coach, period: { relative: '90days' } }),
    ] });
    expect(coachRecords, 'Coach joining work-only membership still acquires its private payload').toBe(count * 2);
  });

  it('reuses one complete transcript conversion across work-only and Coach fact scopes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const id = 'shared-scope-conversion';
    const captured = await context(request => {
      if (request.method === 'PUT' && request.path === `/v2/sessions/${id}/system-records`) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      const demand = input.requests[0]!;
      return Response.json({ requests: [{ query: demand.query, sessionIds: [id] }], results: [{ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1,
          createdAt: 0, updatedAt: 900, active: false }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
        ] } }, ...(demand.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [{ inputId: 'steer',
          workId: JSON.stringify([id, 'turn']), acceptedAtMs: 200, deliveryKind: 'steer', turnId: 'turn' }] }, messagesComplete: true } : {}),
      }] } satisfies UsageSessionEvidenceResponse);
    });
    const work = normalizeUsageQuery({ period: { relative: 'today' }, includeCoach: false, includeQuota: false,
      includeWorkEvidence: false, includeTranscriptEvidence: false });
    const opened = await readUiUsageQueryBatch(captured, { queries: [work] });
    expect(opened.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
    const coach = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ ...work, includeCoach: true,
      includeTranscriptEvidence: true })] });
    expect(coach.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 1, steeringCount: 1 });
    expect(coach.results[0]?.sources).toContainEqual({ source: 'how_you_work:transcripts', status: 'available' });
    const reads = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .map(request => UsageSessionEvidenceRequestSchema.parse(request.body));
    expect(reads.filter(input => input.readWorkFacts).map(input => input.workFactKinds),
      'the completed transcript conversion already admitted both fact kinds').toEqual([['work']]);
    expect(reads.filter(input => input.requests.some(demand => demand.query.includeTranscriptEvidence)),
      'fact scope changes do not repeat the same Session transcript conversion').toHaveLength(1);
  });

  it.each(['current', 'stale', 'malformed'] as const)('uses saved compact facts without turns and falls back to summary for $0 facts', async status => {
    const id = 'compact-without-turns';
    const record = createPlainSessionCurrentProjectionRecordFixture({
      id, seq: 2, createdAt: 0, updatedAt: 900, active: false });
    let summaries = 0;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      if (!input.readWorkFacts && !input.requests[0]!.query.includeTranscriptEvidence) summaries++;
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })),
        results: [{ sessionId: id, ...(input.readWorkFacts ? { workFacts: { session: {
          id, seq: record.seq, createdAt: 0, updatedAt: 900, active: false,
          metadataVersion: record.metadataVersion, agentStateVersion: record.agentStateVersion!, metadataLayoutVersion: 1,
          encryptionMode: 'plain' as const, dataEncryptionKey: null, viewerRole: 'owner' as const,
          access: ownerSessionAccess.effectiveAccess }, records: [{ kind: 'work', content: { t: 'plain' as const, v: projectNativeJsonValueForTransport(
            status === 'malformed' ? { v: 999 } : { v: 1, kind: 'work', seq: status === 'stale' ? 1 : 2, evidence: { status: 'partial',
              facts: [{ workId: JSON.stringify([id, 'turn']), evidenceId: 'turn', agentId: 'codex', machineId: null,
                kind: 'busy', startMs: 100, endMs: 400 }] } }) } }] } } : {
          detail: { status: 200 as const, body: { session: record } },
          turns: { status: 200 as const, body: { v: 1 as const, sessionId: id, updatedAt: 900,
            turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed' as const, startedAt: 100, terminalAt: 400, updatedAt: 900 }] } },
          ...(input.requests[0]!.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
        }) }] } satisfies UsageSessionEvidenceResponse);
    });
    const batch = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ session: id,
      period: { startMs: 0, endMs: 1000 }, includeCoach: false, includeWorkEvidence: false, includeTranscriptEvidence: false })] });
    expect(batch.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
    expect(summaries).toBe(status === 'current' ? 0 : 1);
  });

  it('isolates compact row opening failures while retaining readable all-time siblings', async () => {
    const ids = ['readable-compact-row', 'invalid-compact-row'];
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      if (!input.readWorkFacts) return Response.json({
        requests: input.requests.map(demand => ({ query: demand.query, sessionIds: demand.sessionIds ?? [] })),
        results: input.requests.flatMap(demand => (demand.sessionIds ?? []).map(sessionId => ({ sessionId,
          detail: { status: 404, body: { error: 'Session not found' } } }))),
      });
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: ids })),
        results: ids.map((id, index) => ({ sessionId: id,
          workFacts: { session: { id, seq: 1, createdAt: 0, updatedAt: 900, active: false,
            metadataVersion: 1, agentStateVersion: 1, metadataLayoutVersion: 1,
            encryptionMode: 'plain' as const, dataEncryptionKey: null, viewerRole: 'owner' as const,
            access: ownerSessionAccess.effectiveAccess }, records: [{ kind: 'work', content: { t: 'plain' as const,
            v: projectNativeJsonValueForTransport(index ? { v: 999 } : { v: 1, kind: 'work', seq: 1, evidence: { status: 'partial',
              facts: [{ workId: JSON.stringify([id, 'turn']), evidenceId: 'turn', agentId: 'codex', machineId: null,
                kind: 'busy', startMs: 100, endMs: 400 }] } }) } }] },
          turns: { status: 200 as const, body: { v: 1 as const, sessionId: id, updatedAt: 900, turns: [
            { turnId: 'turn', agentId: 'codex', status: 'completed' as const, startedAt: 100, terminalAt: 400, updatedAt: 900 },
          ] } },
        })) } satisfies UsageSessionEvidenceResponse);
    });
    const batch = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ period: { relative: 'all' },
      includeCoach: false, includeWorkEvidence: false })] });
    expect(batch.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
    expect(batch.results[0]?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'how_you_work:sessions', status: 'partial' }),
    ]));
  });

  it.each([...([
    { transport: 'json', compact: false, range: 'explicit' }, { transport: 'stream', compact: false, range: 'explicit' },
    { transport: 'json', compact: true, range: 'explicit' }, { transport: 'stream', compact: true, range: 'explicit' },
    { transport: 'json', compact: true, range: '7days' },
    { transport: 'json', compact: false, range: '7days' },
    { transport: 'json', compact: true, range: '30days' },
    { transport: 'stream', compact: true, range: '90days' }, { transport: 'json', compact: true, range: 'all' },
    { transport: 'json', compact: false, range: '90days' }, { transport: 'stream', compact: false, range: 'all' },
  ] as const).map(row => ({ ...row, writeFailure: false, contextAdvance: false, active: false, includeTranscriptEvidence: true })),
    { transport: 'json', compact: false, range: 'all', writeFailure: false, contextAdvance: false, active: false, includeTranscriptEvidence: true, paginated: true },
    { transport: 'stream', compact: false, range: 'all', writeFailure: false, contextAdvance: false, active: false, includeTranscriptEvidence: true, paginated: true },
    { transport: 'stream', compact: false, range: 'explicit', writeFailure: false, contextAdvance: false, active: false, includeTranscriptEvidence: true, comparePagePartitions: true },
    { transport: 'json', compact: false, range: 'all', writeFailure: false, contextAdvance: false, active: false, includeTranscriptEvidence: true, paginated: true, unopenedFirstPage: true },
    { transport: 'json', compact: false, range: 'all', writeFailure: true, contextAdvance: false, active: false, includeTranscriptEvidence: true },
    { transport: 'json', compact: false, range: 'all', writeFailure: true, contextAdvance: true, active: false, includeTranscriptEvidence: true },
    { transport: 'json', compact: false, range: 'all', writeFailure: false, contextAdvance: false, active: true, includeTranscriptEvidence: true },
    { transport: 'json', compact: false, range: '90days', writeFailure: false, contextAdvance: false, active: false, includeTranscriptEvidence: false },
    { transport: 'json', compact: false, range: '7days', writeFailure: false, contextAdvance: false, active: false, includeTranscriptEvidence: false },
    { transport: 'json', compact: true, range: '7days', writeFailure: false, contextAdvance: false, active: false, includeTranscriptEvidence: false },
  ] as const)('opens E2EE evidence and reuses compact Session facts without transcript reads ($transport, compact=$compact, range=$range, writeFailure=$writeFailure, contextAdvance=$contextAdvance, active=$active, transcript=$includeTranscriptEvidence, paginated=$paginated, unopenedFirstPage=$unopenedFirstPage, comparePagePartitions=$comparePagePartitions)', async (testCase) => {
    const { transport, compact, range, writeFailure, contextAdvance, active, includeTranscriptEvidence } = testCase;
    const paginated = 'paginated' in testCase && testCase.paginated;
    const unopenedFirstPage = 'unopenedFirstPage' in testCase && testCase.unopenedFirstPage;
    const comparePagePartitions = 'comparePagePartitions' in testCase && testCase.comparePagePartitions;
    const nowMs = Date.UTC(2026, 10, 6);
    const baseMs = nowMs - 1000;
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const [{ Encryption }, { encodeBase64 }, { sealEncryptedDataKeyEnvelopeV1 }, { AES256Encryption }] = await Promise.all([
      import('@/sync/encryption/encryption'), import('@/encryption/base64'), import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1'),
      import('@/sync/encryption/encryptor'),
    ]);
    const id = 'projected-encrypted';
    const secret = new Uint8Array(32).fill(7);
    const sessionKey = new Uint8Array(32).fill(9);
    const encryption = await Encryption.create(secret);
    await encryption.initializeSessions(new Map([[id, sessionKey]]));
    const sessionEncryption = encryption.getSessionEncryption(id)!;
    const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionKey,
      recipientPublicKey: encryption.contentDataKey, randomBytes: length => new Uint8Array(length).fill(3) }), 'base64');
    const privateMetadata = { ...createSessionFixture({ id }).metadata!, machineId: 'compact-fact-machine', path: '/work/compact-facts' };
    const metadata = await sessionEncryption.encryptMetadata(privateMetadata);
    const compactRecords = usageWorkEvidence.createUsageSessionFactRecordsV1({ id, seq: 1, metadata: null, agentState: null }, { status: 'partial',
      facts: [{ workId: JSON.stringify([id, 'turn']), evidenceId: 'turn', agentId: 'codex', machineId: null,
        kind: 'busy', startMs: baseMs + 100, endMs: baseMs + 400 }],
      acceptedInputs: [{ inputId: 'accepted', workId: JSON.stringify([id, 'turn']), acceptedAtMs: baseMs + 200,
        deliveryKind: 'steer', turnId: 'turn' }], phaseEvents: [], collaboration: [],
      coach: { compositionCoverage: 'complete', composition: [{ v: 1, evidenceId: 'composition', sessionId: id,
        turnId: 'turn', inputId: 'accepted', observedAtMs: baseMs + 200, boundary: 'host_pre_dispatch', deliveryKind: 'steer',
        coverage: 'host_only', nativePrefix: null, contextWindowTokens: null,
        components: ['a', 'c'].map(source => ({ sourceId: source.repeat(64), digest: 'b'.repeat(64), kind: 'instructions',
          location: 'user', byteLength: 200, tokenCount: null, tokenizerId: null, cacheClass: 'unknown', overlap: 'none' })) }] } });
    const factCiphertexts = new Map(await Promise.all(compactRecords.map(async fact =>
      [fact.kind, await sessionEncryption.encryptRaw(fact)] as const)));
    const body = 'private body stays on the authorized client';
    const ciphertext = await sessionEncryption.encryptRawRecord({ role: 'user', content: { type: 'text', text: body } });
    const [unopenedContent] = await new AES256Encryption(new Uint8Array(32).fill(4)).encrypt([
      { role: 'user', content: { type: 'text', text: body } },
    ]);
    const [delivery] = await new AES256Encryption(sessionKey).encrypt([{ v: 1, acceptedAtMs: baseMs + 200,
      delivery: { kind: 'steer', turnId: 'turn' } }]);
    const runId = 'partition-fixture-run';
    const runTargetId = `run:${runId}`;
    const runCiphertext = comparePagePartitions ? await sessionEncryption.encryptRawRecord({
      role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'partition-fixture-call',
        name: 'SubAgentRun', input: { runId, launchOrigin: { kind: 'session', sessionId: id }, startedAtMs: baseMs + 200 } } },
    }) : ciphertext;
    const comparisonMessages = comparePagePartitions ? Array.from({ length: 8 }, (_, index) => ({
      id: `comparison-message-${index}`, localId: index === 7 ? 'accepted' : `unaccepted-${index}`, seq: 8 - index,
      createdAt: baseMs + 200, updatedAt: baseMs + 200,
      content: { t: 'encrypted' as const, c: index === 0 ? runCiphertext : ciphertext },
      ...(index === 7 ? { deliveryResolution: { v: 1 as const, kind: 'provider_accepted' as const,
        content: { t: 'encrypted' as const, c: encodeBase64(delivery!, 'base64') } } } : {}),
    })) : [];
    const sentinelTurnId = 'lifecycle-only-turn';
    const sessionTurns = [
      { turnId: 'turn', agentId: 'codex', status: 'completed' as const, startedAt: baseMs + 100, terminalAt: baseMs + 400, updatedAt: baseMs + 900 },
      ...(comparePagePartitions ? [{ turnId: sentinelTurnId, agentId: 'codex', status: 'completed' as const,
        startedAt: baseMs + 500, terminalAt: baseMs + 800, updatedAt: baseMs + 900 }] : []),
    ];
    let comparedPaging: { pageSize: number; observePage: () => void } | undefined;
    const comparisonPage = (beforeSeq: number, paging: NonNullable<typeof comparedPaging>) => {
      paging.observePage();
      const remaining = comparisonMessages.filter(message => message.seq < beforeSeq);
      const messages = remaining.slice(0, paging.pageSize);
      const hasMore = messages.length < remaining.length;
      return { messages, hasMore, ...(hasMore ? { nextBeforeSeq: messages.at(-1)!.seq } : {}) };
    };
    const { ownerMetadata: _owner, displayProjectionV1: _display, ...base } = createPlainSessionCurrentProjectionRecordFixture({
      id, seq: comparePagePartitions ? comparisonMessages.length : paginated ? 2 : 1,
      createdAt: baseMs, updatedAt: baseMs + 900, active });
    let record = { ...base, metadataLayoutVersion: 0, encryptionMode: 'e2ee' as const, dataEncryptionKey, metadata, agentState: null };
    const credentials = { token: createServedHomeAccountToken('account-a'), secret: encodeBase64(secret, 'base64url') };
    const factWrites: unknown[] = [];
    let transcriptAttempts = 0;
    const captureFixture = () => context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === `/v1/sessions/${id}/messages`) {
        if (comparedPaging) return Response.json(comparisonPage(Number(request.url.searchParams.get('beforeSeq')), comparedPaging));
        expect(request.url.searchParams.get('beforeSeq')).toBe('2');
        return Response.json({ messages: [{ id: 'older-opaque', localId: 'accepted', seq: 1,
          createdAt: baseMs + 200, updatedAt: baseMs + 200, content: { t: 'encrypted', c: ciphertext },
          deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'encrypted', c: encodeBase64(delivery!, 'base64') } },
        }], hasMore: false });
      }
      if (request.path === `/v2/sessions/${id}/system-records` && request.method === 'PUT') {
        factWrites.push(request.body);
        if (writeFailure && factWrites.length === 1) return Response.json({ error: 'Plugin Session system record operation failed',
          code: 'plugin_session_record_forbidden' }, { status: 403 });
        return Response.json({ record: { ...(request.body as Record<string, unknown>), id: 'sysrec_1', revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
          createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString() } });
      }
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      if (input.requests[0]!.query.includeTranscriptEvidence) transcriptAttempts++;
      const response = { requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })), results: [{ sessionId: id,
        ...(input.readWorkFacts ? { workFacts: { session: { id, seq: record.seq, createdAt: baseMs, updatedAt: baseMs + 900,
          encryptionMode: 'e2ee' as const, dataEncryptionKey, viewerRole: 'owner' as const, active: record.active,
          metadataVersion: record.metadataVersion, agentStateVersion: record.agentStateVersion!, metadataLayoutVersion: 0,
          access: ownerSessionAccess.effectiveAccess },
          records: (input.workFactKinds ?? ['work']).map(kind => ({ kind,
            content: compact ? { t: 'encrypted' as const, c: factCiphertexts.get(kind)! } : null })) } }
          : { detail: { status: 200, body: { session: record } } }),
        ...(input.readWorkFacts && compact ? {} : { turns: { status: 200 as const, body: { v: 1 as const, sessionId: id, updatedAt: baseMs + 900,
          turns: sessionTurns } } }),
        ...(input.requests[0]!.query.includeTranscriptEvidence ? { messages: { status: 200,
          body: comparedPaging ? comparisonPage(record.seq + 1, comparedPaging) : { messages: [
          { id: 'opaque', localId: paginated ? 'unaccepted' : 'accepted', seq: record.seq, createdAt: baseMs + 200, updatedAt: baseMs + 200,
            content: { t: 'encrypted', c: unopenedFirstPage && transcriptAttempts === 1 ? encodeBase64(unopenedContent!, 'base64') : ciphertext },
            ...(!paginated ? { deliveryResolution: { v: 1 as const, kind: 'provider_accepted' as const,
              content: { t: 'encrypted' as const, c: encodeBase64(delivery!, 'base64') } } } : {}) },
        ], hasMore: paginated, ...(paginated ? { nextBeforeSeq: 2 } : {}) } } } : {}),
      }] } satisfies UsageSessionEvidenceResponse;
      return transport === 'json' ? Response.json(response) : new Response([
        JSON.stringify({ requests: response.requests }), ...response.results.map(result => JSON.stringify(result)),
      ].join('\n'), { headers: { 'Content-Type': 'application/x-ndjson' } });
    }, undefined, undefined, { credentials, accountMode: 'e2ee',
      encryptionCurrentness: () => createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    const query = normalizeUsageQuery({ session: id,
      period: range === 'explicit' ? { startMs: baseMs, endMs: nowMs } : { relative: range },
      includeWorkEvidence: false, includeTranscriptEvidence });
    if (comparePagePartitions) {
      const readPartition = async (pageSize: number) => {
        let summaryPublished = false;
        const beforePages: { summaryPublished: boolean; writes: number }[] = [];
        comparedPaging = { pageSize, observePage: () => { beforePages.push({ summaryPublished, writes: factWrites.length }); } };
        const captured = await captureFixture();
        const stringify = JSON.stringify;
        let lifecycleKeys = 0;
        let collaborationKeys = 0;
        // Count only the two fixture keys, without retaining any stringify arguments.
        JSON.stringify = new Proxy(stringify, {
          apply(target, receiver, args) {
            const key = args[0];
            if (Array.isArray(key)) {
              if (key.length === 2 && key[0] === id && key[1] === sentinelTurnId) lifecycleKeys++;
              if (key.length === 4 && key[0] === 'run' && key[1] === null && key[2] === runTargetId && key[3] === null) collaborationKeys++;
            }
            return Reflect.apply(target, receiver, args);
          },
        });
        let batch: Awaited<ReturnType<typeof readUiUsageQueryBatch>>;
        try {
          batch = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, undefined, {
            onProgress: project => {
              summaryPublished ||= project().results[0]?.howYouWork?.intervals?.agentTimeMs === 600;
            },
          });
        } finally {
          JSON.stringify = stringify;
        }
        expect(beforePages).toEqual(Array.from({ length: comparisonMessages.length / pageSize },
          () => ({ summaryPublished: true, writes: 0 })));
        const result = batch.results[0]!;
        expect(result.howYouWork).toMatchObject({ intervals: { agentTimeMs: 600 },
          inputs: { acceptedCount: 1, steeringCount: 1 }, sessionCoverage: { selected: 1, admitted: 1, notRead: 0 } });
        expect(result.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work:transcripts', status: 'available' }));
        const facts = await Promise.all(factWrites.map(async body => {
          const stored = SessionSystemRecordStoredUpsertRequestSchema.parse(body);
          if (stored.content.t !== 'encrypted') throw new Error('Expected encrypted Usage Session fact');
          return usageWorkEvidence.UsageSessionFactRecordV1Schema.parse(await sessionEncryption.decryptRaw(stored.content.c));
        }));
        expect(facts.map(fact => fact.kind)).toEqual(['coach', 'work']);
        expect(facts.find(fact => fact.kind === 'work')?.evidence.collaboration)
          .toContainEqual(expect.objectContaining({ relation: 'run', targetId: runTargetId }));
        return { howYouWork: result.howYouWork, facts, lifecycleKeys, collaborationKeys };
      };

      const singlePage = await readPartition(comparisonMessages.length);
      retireActiveServerAccountScopeLifetime();
      await home!.dispose();
      home = undefined;
      factWrites.length = 0;
      const eightPages = await readPartition(1);
      expect(eightPages.howYouWork).toEqual(singlePage.howYouWork);
      expect(eightPages.facts).toEqual(singlePage.facts);
      expect.soft(eightPages.lifecycleKeys, 'lifecycle key writes by page partition').toBe(singlePage.lifecycleKeys);
      expect.soft(eightPages.collaborationKeys, 'collaboration key writes by page partition').toBe(singlePage.collaborationKeys);
      return;
    }
    const captured = await captureFixture();
    const activeMarker = createSessionFixture({ id, seq: record.seq, updatedAt: record.updatedAt,
      metadataVersion: record.metadataVersion, agentStateVersion: record.agentStateVersion,
      metadataLayoutVersion: record.metadataLayoutVersion, encryptionMode: 'e2ee',
      serverId: captured.accountLifetime.scope.serverId, active: true });
    if (active) storage.setState({ profileScope: captured.accountLifetime.scope, sessions: { [id]: activeMarker } });
    const before = home!.requests.length;
    const beforeHttp = home!.httpRequests.length;
    const batch = await readUiUsageQueryBatch(captured, { queries: [query] });
    const notRead = !compact && (range === '90days' || range === 'all');
    expect(batch.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
    if (notRead) {
      expect(batch.results[0]?.howYouWork?.inputs).toBeNull();
      expect(batch.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ selected: 1, admitted: 1, notRead: 1 });
    } else expect(batch.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 1, steeringCount: 1 });
    if (compact) expect(batch.results[0]?.coach?.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ detectorId: 'duplicated_instructions' }),
    ]));
    if (compact && includeTranscriptEvidence) expect(batch.results[0]?.sources).toContainEqual(expect.objectContaining({
      source: 'how_you_work:transcripts', status: 'available',
    }));
    expect(JSON.stringify(batch)).not.toContain(body);
    expect(JSON.stringify(batch)).not.toContain(ciphertext);
    const transcriptReads = home!.httpRequests.slice(beforeHttp).filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH
      && UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => demand.query.includeTranscriptEvidence));
    expect(transcriptReads).toHaveLength(compact || notRead ? 0 : 1);
    expect(factWrites).toHaveLength(compact || notRead ? 0 : 2);
    expect(home!.requests.slice(before).filter(request => request.path === '/v2/sessions/read-batch'
      || /^\/v[12]\/sessions\/[^/]+(?:\/|$)/.test(request.path) && request.method === 'GET')).toEqual([]);
    if (notRead) {
      const { readUiUsageHistory } = await import('./usageQueryResource');
      const progress: string[] = [];
      const query = batch.results[0]!.requestedQuery;
      const executor = createDefaultActionExecutor();
      const caller = { surface: 'ui' as const, actionCaller: { kind: 'host' as const },
        serverId: captured.accountLifetime.scope.serverId, expectedAccountId: captured.accountLifetime.scope.accountId,
        authority: 'present_user' as const,
        operationProgress: { update: (state: Readonly<{ phase?: string }>) => { if (state.phase) progress.push(state.phase); } } };
      const invokeHistory = async (operation: UsageHistoryReadInput['operation']) => {
        const outcome = await executor.execute(USAGE_HISTORY_ACTION_IDS.read, { query, operation }, caller);
        expect(outcome.ok, outcome.ok ? undefined : outcome.errorCode).toBe(true);
        if (!outcome.ok) throw new Error(outcome.errorCode);
        return UsageHistoryReadStateSchema.parse(outcome.result);
      };
      if (active) {
        // QA's clean read must not offer another conversion for a Session
        // which the fact owner cannot finalize while it remains active.
        expect(await invokeHistory('status')).toMatchObject({ status: 'complete',
          progress: { selected: 1, notRead: 0, completed: 0, failed: 0 } });
        expect(await invokeHistory('read')).toMatchObject({ status: 'complete',
          progress: { selected: 1, notRead: 0, completed: 0, failed: 0 } });
        expect(home!.httpRequests.slice(beforeHttp).filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH
          && UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => demand.query.includeTranscriptEvidence))).toHaveLength(0);
        expect(factWrites).toHaveLength(0);
        const reopened = await readUiUsageQueryBatch(captured, { queries: [query] });
        // Unchecked evidence stays explicit, independently of actionable reads.
        expect(reopened.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ selected: 1, admitted: 1, notRead: 1 });
        record = { ...record, active: false };
        storage.setState({ profileScope: captured.accountLifetime.scope, sessions: { [id]: { ...activeMarker, active: false } } });
        await readUiUsageQueryBatch(captured, { queries: [query] });
        expect(await invokeHistory('status')).toMatchObject({ status: 'idle', progress: { notRead: 1 } });
        expect(await invokeHistory('read')).toMatchObject({ status: 'complete',
          progress: { notRead: 0, completed: 1, failed: 0 } });
        expect(factWrites).toHaveLength(2);
        return;
      }
      if (range === '90days') expect(await invokeHistory('status')).toMatchObject({ status: 'idle' });
      let read = range === '90days' ? await invokeHistory('read')
        : await readUiUsageHistory(captured, { query }, { onProgress: state => { progress.push(state.status); } });
      if (unopenedFirstPage) {
        expect(read).toMatchObject({ status: 'partial', progress: { notRead: 1, completed: 0 } });
        expect(factWrites).toHaveLength(0);
        read = await readUiUsageHistory(captured, { query });
      }
      if (writeFailure) {
        expect(read).toMatchObject({ status: 'partial', errorCode: 'plugin_session_record_forbidden',
          progress: { selected: 1, notRead: 1, completed: 0, failed: 1 } });
        if (contextAdvance) {
          record = { ...record, metadataVersion: record.metadataVersion + 1,
            metadata: await sessionEncryption.encryptMetadata({ ...privateMetadata, path: '/work/refreshed-context' }) };
          storage.setState({ profileScope: captured.accountLifetime.scope, sessions: { [id]: createSessionFixture({
            id, seq: record.seq, updatedAt: record.updatedAt, metadataVersion: record.metadataVersion,
            agentStateVersion: record.agentStateVersion, metadataLayoutVersion: record.metadataLayoutVersion,
            encryptionMode: 'e2ee', serverId: captured.accountLifetime.scope.serverId,
          }) } });
        }
        read = await readUiUsageHistory(captured, { query });
      }
      expect(read, `History state ${JSON.stringify(read)}; fact writes ${factWrites.length}`).toMatchObject({
        status: 'complete', progress: { selected: 1, notRead: 0, completed: 1, failed: 0 } });
      expect(progress).toContain('reading');
      const allTranscriptReads = home!.httpRequests.slice(beforeHttp).filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH
        && UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => demand.query.includeTranscriptEvidence));
      expect(allTranscriptReads).toHaveLength(unopenedFirstPage ? 2 : 1);
      expect(factWrites).toHaveLength(writeFailure ? 3 : 2);
      expect(home!.httpRequests.slice(beforeHttp).filter(request => request.path === `/v1/sessions/${id}/messages`))
        .toHaveLength(paginated ? unopenedFirstPage ? 2 : 1 : 0);
      expect(factWrites[0]).toMatchObject({ address: { owner: 'host', namespace: 'usage', kind: 'work_facts.v1', localId: 'coach' },
        content: { t: 'encrypted' } });
      expect(JSON.stringify(factWrites)).not.toContain(body);
      for (const [index, write] of factWrites.entries()) {
        const stored = SessionSystemRecordStoredUpsertRequestSchema.parse(write);
        expect(stored.content.t).toBe('encrypted');
        if (stored.content.t !== 'encrypted') throw new Error('Expected encrypted Usage Session fact');
        const opened = await sessionEncryption.decryptRaw(stored.content.c);
        expect(opened).toMatchObject({ kind: stored.address.localId });
        if (stored.address.localId === 'work') expect(opened).toMatchObject({
          session: { metadata: { machineId: privateMetadata.machineId },
            ownerMetadata: { path: contextAdvance && index > 0 ? '/work/refreshed-context' : privateMetadata.path } },
        });
      }
      const reopened = await readUiUsageQueryBatch(captured, { queries: [query] });
      expect(reopened.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 1, steeringCount: 1 });
      expect(reopened.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ notRead: 0 });
      if (range === '90days') {
        expect(await invokeHistory('status')).toMatchObject({ status: 'complete', progress: read.progress });
        expect(await invokeHistory('cancel')).toMatchObject({ status: 'complete', progress: read.progress });
        await invokeHistory('read');
      } else await readUiUsageHistory(captured, { query });
      expect(home!.httpRequests.slice(beforeHttp).filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH
        && UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => demand.query.includeTranscriptEvidence))).toHaveLength(unopenedFirstPage ? 2 : 1);
    }
  });

  it.each([true, false])('reads each Usage window through projected evidence without acquiring complete Session transcripts (explicit %s)', async explicit => {
    const id = 'projected-work';
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      const query = input.requests[0]!.query;
      const start = 'startMs' in query.period ? query.period.startMs! : 0;
      const terminalAt = start === 0 ? 400 : start + 700;
      const response = { requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })),
        results: [{ sessionId: id,
          detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 }) } },
          turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 2000, turns: [
            { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: start + 100, terminalAt, updatedAt: 2000 },
          ] } },
          ...(query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [{ inputId: 'accepted',
            workId: JSON.stringify([id, 'turn']), acceptedAtMs: start + 200, deliveryKind: 'newTurn', turnId: 'turn' }] },
            messagesComplete: true } : {}),
        }] } satisfies UsageSessionEvidenceResponse;
      return Response.json(response);
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: Object.fromEntries(
      [...(explicit ? [id] : []), ...Array.from({ length: 40 }, (_, index) => `unrelated-${index}`)].map(sessionId => [sessionId,
        createSessionFixture({ id: sessionId, seq: 1, serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' })])) });
    const before = home!.requests.length;
    const queries = [normalizeUsageQuery({ ...(explicit ? { session: id } : {}), period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false }),
      normalizeUsageQuery({ ...(explicit ? { session: id } : {}), period: { startMs: 1000, endMs: 2000 }, includeWorkEvidence: false })];
    const batch = await readUiUsageQueryBatch(captured, { queries });
    expect(batch.results.map(slice => slice.howYouWork?.intervals?.agentTimeMs)).toEqual([300, 600]);
    expect(batch.results.map(slice => slice.howYouWork?.inputs?.acceptedCount)).toEqual([1, 1]);
    const requests = home!.requests.slice(before);
    expect(requests.some(request => request.path === USAGE_SESSION_EVIDENCE_PATH)).toBe(true);
    for (const request of requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)) {
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      expect(input.requests.every(demand => demand.sessionIds === undefined
        ? !explicit && !demand.query.includeTranscriptEvidence
        : demand.sessionIds.length === 1 && demand.sessionIds[0] === id)).toBe(true);
      for (const demand of input.requests) expect(queries.map(query => query.period)).toContainEqual(demand.query.period);
    }
    expect(requests.filter(request => request.path === '/v2/sessions/read-batch'
      || /^\/v[12]\/sessions\/[^/]+(?:\/|$)/.test(request.path)
        && !(request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)))).toEqual([]);
    const evidenceReads = () => home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH).length;
    const beforeReuse = evidenceReads();
    const reused = await readUiUsageQueryBatch(captured, { queries });
    expect(reused.results.map(slice => slice.howYouWork?.intervals?.agentTimeMs)).toEqual([300, 600]);
    expect(evidenceReads() - beforeReuse, 'unchanged inputs retain their admitted population witness').toBe(0);
    const beforeWindowChange = home!.requests.length;
    const changedQuery = normalizeUsageQuery({ ...(explicit ? { session: id } : {}),
      period: { startMs: 2000, endMs: 3000 }, includeWorkEvidence: false });
    const changed = await readUiUsageQueryBatch(captured, { queries: [changedQuery] });
    expect(changed.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(600);
    expect(changed.results[0]?.howYouWork?.inputs?.acceptedCount).toBe(1);
    const changedDemands = home!.requests.slice(beforeWindowChange)
      .filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
    expect(changedDemands.filter(demand => demand.sessionIds === undefined)).toHaveLength(explicit ? 0 : 1);
    expect(changedDemands.length).toBeGreaterThan(0);
    expect(changedDemands.every(demand => JSON.stringify(demand.query.period) === JSON.stringify(changedQuery.period))).toBe(true);
  });

  it('publishes admitted Usage intervals while its projected private evidence is held', async () => {
    const privateRead = createDeferred<void>();
    const id = 'held-projected';
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      if (input.requests[0]!.query.includeTranscriptEvidence) await privateRead.promise;
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })), results: [{ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
        ] } }, ...(input.requests[0]!.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
      }] } satisfies UsageSessionEvidenceResponse);
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: { [id]: createSessionFixture({ id,
      seq: 1, serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' }) } });
    const query = normalizeUsageQuery({ session: id, period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, false);
    const reading = entry.refresh();
    const slice = () => entry.getSnapshot().value && decodeUsageQueryResource(entry.getSnapshot().value!).results[0];
    try {
      await expect.poll(() => slice()?.howYouWork?.intervals?.agentTimeMs).toBe(300);
      expect(slice()?.pending).toBe(true);
      expect(slice()?.howYouWork?.inputs).toBeNull();
      privateRead.resolve();
      await reading;
      expect(slice()?.pending).toBe(false);
      expect(slice()?.howYouWork?.inputs?.acceptedCount).toBe(0);
    } finally { privateRead.resolve(); await reading; release(); }
  });

  it.each(['missing', 'foreign', 'duplicate', 'query'] as const)('rejects a %s projected Usage cohort before publishing private facts', async scenario => {
    const ids = ['cohort-a', 'cohort-b'];
    let privateReads = 0;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      const privateDemand = input.requests[0]!.query.includeTranscriptEvidence;
      const response: UsageSessionEvidenceResponse = { requests: input.requests.map(demand => ({ query: demand.query, sessionIds: ids })),
        results: ids.map(id => ({ sessionId: id,
          detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 }) } },
          turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
            { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
          ] } }, ...(privateDemand ? { messageEvidence: { acceptedInputs: [{ inputId: 'accepted', workId: JSON.stringify([id, 'turn']),
            acceptedAtMs: 200, deliveryKind: 'newTurn', turnId: 'turn' }] }, messagesComplete: true } : {}),
        })) };
      if (privateDemand) {
        privateReads++;
        if (scenario === 'missing') response.results.pop();
        if (scenario === 'foreign') response.results[1]!.sessionId = 'foreign';
        if (scenario === 'duplicate') response.results[1] = response.results[0]!;
        if (scenario === 'query') response.requests[0]!.query = normalizeUsageQuery({ ...response.requests[0]!.query, period: { startMs: 1000, endMs: 2000 } });
      }
      return Response.json(response);
    });
    const query = normalizeUsageQuery({ session: ids, period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const observed: NonNullable<ReturnType<typeof decodeUsageQueryResource>>['results'][number][] = [];
    const release = entry.subscribe(() => { if (entry.getSnapshot().value) observed.push(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!); }, false);
    try {
      await entry.refresh();
      expect(privateReads).toBe(1);
      expect(entry.getSnapshot().error).toBeTruthy();
      expect(observed.some(slice => slice.howYouWork?.intervals?.agentTimeMs === 600)).toBe(true);
      expect(observed.every(slice => !slice.howYouWork?.inputs || slice.howYouWork.inputs.acceptedCount === 0)).toBe(true);
      // The failed read has ended: its retained progress must not keep a body reading.
      const retained = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      expect(retained.sources.filter(source => source.status === 'pending')).toEqual([]);
      expect(retained.pending).toBe(false);
    } finally { release(); }
  });

  it('retries one failed Usage window without reopening a failed sibling for the same Session', async () => {
    const id = 'projected-retry';
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
        const input = UsageSessionEvidenceRequestSchema.parse(request.body);
        return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })),
          results: [{ sessionId: id, detail: { status: 503, body: { error: 'unavailable' } } }],
        } satisfies UsageSessionEvidenceResponse);
      }
      return undefined;
    });
    storage.setState({ sessions: { [id]: createSessionFixture({ id, encryptionMode: 'plain', serverId: captured.accountLifetime.scope.serverId }) } });
    const store = getUsageQueryResourceStore(captured);
    const entries = [0, 1000].map(startMs => store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [
      normalizeUsageQuery({ session: id, period: { startMs, endMs: startMs + 1000 }, includeWorkEvidence: false, includeTranscriptEvidence: false }),
    ] }) }));
    const releases = entries.map(entry => entry.subscribe(() => {}, true));
    const reads = () => [0, 1000].map(start => home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests)
      .filter(demand => 'startMs' in demand.query.period && demand.query.period.startMs === start).length);
    const idle = () => entries.every(entry => entry.getSnapshot().pending === 'idle' && entry.getSnapshot().value !== undefined);
    try {
      await expect.poll(idle).toBe(true);
      expect(reads()).toEqual([1, 1]);
      await entries[0]!.refresh();
      invalidateUsageQueryResources(captured.accountLifetime);
      await expect.poll(idle).toBe(true);
      expect(reads()).toEqual([2, 1]);
      await entries[1]!.refresh();
      expect(reads()).toEqual([2, 2]);
    } finally { releases.forEach(release => release()); }
  });

  it.each(['unknown', 'empty', 'plain-transcript'] as const)('keeps projected Usage inputs %s while retaining their admitted intervals', async evidence => {
    const id = 'projected-coverage';
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })), results: [{ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
        ] } }, ...(input.requests[0]!.query.includeTranscriptEvidence && evidence === 'empty'
          ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
        ...(input.requests[0]!.query.includeTranscriptEvidence && evidence === 'plain-transcript'
          ? { messages: { status: 200, body: { messages: [], hasMore: false } } } : {}),
      }] } satisfies UsageSessionEvidenceResponse);
    });
    const batch = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ session: id,
      period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false })] });
    expect(batch.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
    expect(batch.results[0]?.howYouWork?.inputs).toEqual(evidence === 'empty'
      ? expect.objectContaining({ acceptedCount: 0, steeringCount: 0 }) : null);
    expect(batch.results[0]?.sources).toContainEqual({ source: 'how_you_work:transcripts', status: evidence === 'empty' ? 'available' : 'partial' });
  });

  it('withdraws collection work after the last Usage consumer and skips Session inventory on quota Refresh', async () => {
    const captured = await context(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/idle-evidence') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({
        id: 'idle-evidence', createdAt: 1, updatedAt: 900, seq: 1, metadataVersion: 1, agentStateVersion: 1 }) });
      if (request.path === '/v1/sessions/idle-evidence/turns') return Response.json({ v: 1, sessionId: 'idle-evidence', updatedAt: 900,
        turns: [{ turnId: 'idle-turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] });
      if (request.path === '/v1/sessions/idle-evidence/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.getState().applySessions([createSessionFixture({ id: 'idle-evidence', serverId: captured.accountLifetime.scope.serverId,
      encryptionMode: 'plain', seq: 1, agentStateVersion: 1 })]);
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeSessionEvidence: true,
      includeTranscriptEvidence: false, includeWorkEvidence: false, includeQuotaHistory: false });
    const store = getUsageQueryResourceStore(captured);
    const entry = store.getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    await entry.refresh();
    await flushHookEffects({ cycles: 20 });
    expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
    release();
    const previous = storage.getState().sessions;
    let sessionKeyVisits = 0;
    let evidenceVisits = 0;
    const unrelated = createSessionFixture({ id: 'unrelated-idle', serverId: captured.accountLifetime.scope.serverId });
    const retained = previous['idle-evidence']!;
    const version = retained.agentStateVersion;
    Object.defineProperty(retained, 'agentStateVersion', { enumerable: true, configurable: true,
      get() { evidenceVisits++; return version; } });
    const sessions = new Proxy({ ...previous, [unrelated.id]: unrelated }, {
      ownKeys(target) {
        // The real store also publishes Session relations and voice bindings.
        // Count this Account owner's visits, rather than those other consumers.
        if (/usageQuery(?:Resource|SessionInputs|Invalidation)\.ts:\d/.test(new Error().stack ?? '')) sessionKeyVisits++;
        return Reflect.ownKeys(target);
      },
    });
    const before = home!.httpRequests.length;
    let machineVisits = 0;
    const machines = new Proxy({ ...storage.getState().machines, 'idle-machine': createMachineFixture({ id: 'idle-machine' }) }, {
      ownKeys(target) { machineVisits++; return Reflect.ownKeys(target); },
    });
    storage.setState({ sessions, machines });
    await flushHookEffects({ cycles: 20 });
    expect.soft(sessionKeyVisits, 'Closed Usage visits no Session keys').toBe(0);
    expect.soft(evidenceVisits, 'Closed Usage visits no evidence versions').toBe(0);
    expect.soft(machineVisits, 'Closed Usage visits no Machine keys').toBe(0);
    expect.soft(home!.httpRequests.length - before, 'Closed Usage issues no HTTP').toBe(0);
    sessionKeyVisits = 0;
    await store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({ ...query,
      includeAccounting: false, includeSessionEvidence: false })] }) }).refresh();
    expect.soft(sessionKeyVisits, 'Quota-only Refresh visits no Session keys').toBe(0);
    Object.defineProperty(retained, 'agentStateVersion', { enumerable: true, configurable: true, writable: true, value: version });
  });

  it('preserves report-covered series money through derived Resource JSON after private repricing', async () => {
    const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
    const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const row = { ...workContribution, id: 'covered-event', sessionId: null, turnId: null, modelId: 'reference', observedAtMs: 500,
      eventCount: 1, tokens, tokenCategories: tokens, cost: { reportedUsd: 0, estimatedUsd: 2, currency: 'USD',
        costSource: 'pricing_estimate' as const, reportedTotalId: 'final-report' } };
    const final = { ...workContribution, id: 'final-report', sessionId: null, turnId: null, observedAtMs: 1500,
      eventCount: 1, tokens: zero, tokenCategories: zero, cost: { reportedUsd: 3, estimatedUsd: 0, currency: 'USD',
        costSource: 'provider_reported' as const, reportedTotalContributionIds: ['covered-event'] } };
    const accounting: UsageAnalyticsQueryResponse = { v: 1, contributions: [row, final],
      totals: { eventCount: 2, tokens, cost: aggregateUsageContributionCosts([row, final], 'auto') },
      series: [{ bucketStartMs: 0, bucketEndMs: 1000, eventCount: 1, tokens, cost: aggregateUsageContributionCosts([row], 'auto') },
        { bucketStartMs: 1000, bucketEndMs: 2000, eventCount: 1, tokens: zero, cost: aggregateUsageContributionCosts([final], 'auto') }],
      priceCatalog: { v: 1, models: { reference: { inputUsdPerMillion: 1, outputUsdPerMillion: 0 } },
        provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'covered-cell', fetchStatus: 'ready' } } };
    const settings = settingsParse({ usageModelPriceOverridesV1: {
      reference: { kind: 'rates', inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 } } });
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined, undefined, settings);
    saveAccountSettings(captured.accountLifetime.scope, settings, 1);
    storage.setState({ settingsScope: captured.accountLifetime.scope, settings });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 2000 }, includeWorkEvidence: false,
      includeComparison: false, includeQuotaHistory: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await entry.refresh();
      const content = entry.getSnapshot().value!;
      const typed = decodeUsageQueryResource(content).results[0]!.accounting!;
      const encoded = UsageQueryBatchResultSchema.parse(JSON.parse(new TextDecoder().decode(content.bytes))).results[0]!.accounting!;
      const money = (value: UsageAnalyticsQueryResponse) => value.series?.map(cell => resolveEffectiveUsageCostUsd(cell.cost, 'auto'));
      // The report owns the charge; its covered cell has no independently measured selected amount.
      expect(money(typed)).toEqual([null, 3]);
      expect(money(encoded)).toEqual(money(typed));
      expect(encoded.totals.cost.reportedUsd).toBe(3);
      expect('contributions' in encoded).toBe(false);
    } finally { release(); }
  });

  it('keeps compact all-time observation bounds through an accounting failure and replaces them on Retry after reopening', async () => {
    let nowMs = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    let failed = false;
    let shiftMs = 0;
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      if (failed) return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ ...value, contributions: [101, 500, 899].map((observedAtMs, index) => ({ ...workContribution,
        id: `range-event-${index}`, sessionId: null, turnId: null, observedAtMs: observedAtMs + shiftMs })) });
    });
    const query = normalizeUsageQuery({ period: { relative: 'all' }, includeActivity: true,
      includeWorkEvidence: false, includeComparison: false, includeQuotaHistory: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    let release = entry.subscribe(() => {}, false);
    const range = () => {
      const content = entry.getSnapshot().value!;
      const slice = decodeUsageQueryResource(content).results[0]!;
      expect('contributions' in slice.accounting!).toBe(false);
      return resolveUsageShownCalendarRange(query, slice.accounting?.coverage, slice.accounting, slice.accountingObservationRange);
    };
    try {
      await entry.refresh();
      const original = range();
      expect(original).toMatchObject({ startMs: 0, endMs: 1000 });
      failed = true;
      await entry.refresh();
      expect(range()).toEqual(original);
      release();
      failed = false;
      shiftMs = 86_400_000;
      nowMs += shiftMs;
      release = entry.subscribe(() => {}, true);
      await flushHookEffects({ cycles: 20 });
      expect(range()).toEqual(original);
      await entry.refresh();
      await expect.poll(() => range()?.startMs).toBe(86_400_000);
      expect(range()).toMatchObject({ startMs: 86_400_000, endMs: 86_401_000 });
    } finally { release(); }
  });

  it('publishes derived Coach facts rather than 32,975 accounting rows while preserving prices, ranges, exports and Work', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    let count = 3;
    const catalog = { v: 1 as const, models: { reference: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } },
      provenance: { source: 'litellm' as const, origin: 'bundled' as const, asOfMs: 1, revision: 'derived-delivery', fetchStatus: 'ready' as const } };
    const historical = (range?: { startMs?: number; endMs?: number }): UsageAnalyticsQueryResponse => {
      const contributions = Array.from({ length: count }, (_, index) => ({ ...workContribution,
        id: `derived-event-${index}`, eventCount: 1, sessionId: 'derived-session', agentId: 'codex',
        observedAtMs: index === 0 ? 101 : index === count - 1 ? 899 : 500,
        modelId: index % 3 === 0 ? 'reference' : index % 3 === 1 ? 'private-model' : null }))
        .filter(row => row.observedAtMs >= (range?.startMs ?? 0) && row.observedAtMs < (range?.endMs ?? Infinity));
      const selected = contributions.length;
      return { ...value, contributions, priceCatalog: catalog,
        totals: { eventCount: selected, tokens: { input: selected * 10, output: selected * 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: selected * 15 },
          cost: { reportedUsd: selected, estimatedUsd: 0, currency: 'USD' } },
        breakdowns: { model: buildUsageBreakdownList(contributions, 'model', 20, 'auto') } };
    };
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(historical(UsageAnalyticsQueryRequestSchema.parse(request.body).dateRange));
      if (request.path === '/v2/sessions/derived-session') return Response.json({ session: {
        ...createPlainSessionCurrentProjectionRecordFixture({ id: 'derived-session', createdAt: 1, updatedAt: 900, seq: 1,
          active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1 }),
        agentState: JSON.stringify({ completedRequests: { approval: { tool: 'Bash', arguments: {},
          createdAt: 100, completedAt: 700, status: 'approved' } } }) } });
      if (request.path === '/v1/sessions/derived-session/turns') return Response.json({ v: 1, sessionId: 'derived-session', updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 }] });
      if (request.path === '/v1/sessions/derived-session/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    const query = normalizeUsageQuery({ period: { relative: 'all' }, includeActivity: true, breakdown: ['model'], includeComparison: false,
      includeQuotaHistory: false, includeWorkEvidence: false });
    const store = getUsageQueryResourceStore(captured);
    const entry = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, false);
    const read = () => {
      const content = entry.getSnapshot().value!;
      const decoded = decodeUsageQueryResource(content);
      const transported = UsageQueryBatchResultSchema.parse(JSON.parse(new TextDecoder().decode(content.bytes)));
      expect(JSON.parse(JSON.stringify(decoded))).toEqual(JSON.parse(JSON.stringify(transported)));
      return { slice: decoded.results[0]!, transported: transported.results[0]!, bytes: content.bytes.byteLength };
    };
    try {
      await entry.refresh();
      const small = read();
      const expectedRange = { startMs: 0, endMs: 1000, granularity: query.granularity, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes };
      expect(small.slice.coach?.findings).toEqual(expect.arrayContaining([expect.objectContaining({ detectorId: 'approval_friction' })]));
      count = 32_975;
      await entry.refresh();
      const large = read();
      const visible = (slice: typeof large.slice) => ({ findings: slice.coach?.findings.map(({ asOfMs: _clock, period: _period, ...facts }) => facts), permissions: slice.howYouWork?.permissions,
        range: resolveUsageShownCalendarRange(query, slice.accounting?.coverage, slice.accounting, slice.accountingObservationRange),
        prices: buildUsagePriceEditorModel(slice, {}) });
      const expected = historical();
      const rawSlice = { ...large.slice, accounting: expected };
      expect(visible(large.slice).findings).toEqual(visible(small.slice).findings);
      expect(visible(large.slice).permissions).toEqual(visible(small.slice).permissions);
      expect(visible(large.slice).range).toEqual(expectedRange);
      expect(visible(large.transported).range).toEqual(expectedRange);
      expect(visible(large.slice).prices).toEqual(buildUsagePriceEditorModel(rawSlice, {}));
      expect(visible(large.transported).prices).toEqual(buildUsagePriceEditorModel(rawSlice, {}));
      expect(large.slice.accounting?.priceCatalog).toEqual(catalog);
      expect(large.slice.accounting?.totals.tokens.total).toBe(count * 15);
      expect(large.slice.accounting?.totals.cost.reportedUsd).toBe(count);
      console.info('derived Resource delivery bytes', JSON.stringify({ small: small.bytes, large: large.bytes,
        eventCount: count, rawAccountingBytes: new TextEncoder().encode(JSON.stringify(expected)).byteLength }));
      expect.soft('contributions' in large.slice.accounting!).toBe(false);
      expect.soft('contributions' in large.transported.accounting!).toBe(false);
      expect.soft(large.bytes).toBeLessThan(small.bytes * 2);
      const controls = [normalizeUsageQuery({ ...query, includeContributions: true }),
        normalizeUsageQuery({ ...query, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: true })];
      const kept = await readUiUsageQueryBatch(captured, { queries: controls });
      const exported = kept.results.find(slice => slice.key === getUsageQueryKey(controls[0]));
      const worked = kept.results.find(slice => slice.key === getUsageQueryKey(controls[1]));
      expect(exported?.accounting?.contributions).toHaveLength(count);
      expect(worked?.work?.allocations).toHaveLength(count);
      expect(worked?.work?.allocations.map(row => row.contributionId)).toEqual(worked?.accounting?.contributions?.map(row => row.id));
      expect(summarizeUsageWork(worked!.work!, worked!.accounting!.contributions!, { metric: 'cost', costBasis: 'auto' }).total).toBe(count);
      count = 3;
      const comparison = normalizeUsageQuery({ ...query, period: { startMs: 500, endMs: 1000 }, includeComparison: true,
        includeSessionEvidence: false, includeTranscriptEvidence: false });
      const compared = await readUiUsageQueryBatch(captured, { queries: [comparison] });
      expect(compared.results[0]?.accounting?.totals.cost.reportedUsd).toBe(2);
      expect(compared.results[0]?.comparison?.accounting?.totals.cost.reportedUsd).toBe(1);
      expect(compared.results[0]?.accounting?.contributions).toBeUndefined();
      expect(compared.results[0]?.comparison?.accounting?.contributions).toBeUndefined();
      const coverage = { status: 'complete' as const, reasons: [], missingDimensions: [], ranked: [], sources: [],
        range: { startMs: 0, endMs: 2000, complete: true } };
      expect(resolveUsageShownCalendarRange(query, coverage, large.slice.accounting, large.slice.accountingObservationRange))
        .toEqual(expectedRange);
      count = 0;
      await entry.refresh();
      const empty = read();
      expect(empty.slice.accounting?.totals.eventCount).toBe(0);
      expect(empty.slice.accountingObservationRange).toBeUndefined();
      expect(resolveUsageShownCalendarRange(query, empty.slice.accounting?.coverage, empty.slice.accounting, empty.slice.accountingObservationRange))
        .toEqual({ ...expectedRange, startMs: 1000 });
      expect(resolveUsageShownCalendarRange(query, coverage, empty.slice.accounting, empty.slice.accountingObservationRange))
        .toEqual({ ...expectedRange, startMs: 1000 });
      const pinned = normalizeUsageQuery({ ...query, period: { startMs: 0, endMs: 2000 } });
      expect(resolveUsageShownCalendarRange(pinned, coverage, large.slice.accounting, large.slice.accountingObservationRange))
        .toEqual({ ...expectedRange, startMs: 0, endMs: 2000 });
    } finally { release(); }
  }, 60_000);

  it('shares one bounded accounting inventory across four filter fields at 32,975 events', async () => {
    const contributions = Array.from({ length: 32_975 }, (_, index) => ({ ...workContribution,
      id: `inventory-event-${index}`, eventCount: 1, agentId: `agent-${index % 21}`, machineId: `machine-${index % 21}`,
      projectKey: `project-${index % 21}`, source: `source-${index % 21}` }));
    const dimensions = ['agent', 'machine', 'project', 'source'] as const;
    const inventories = new Map<typeof dimensions[number], ReturnType<typeof buildUsageBreakdownList>>();
    const delivered: string[] = [];
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query-batch') return undefined;
      const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
      const results = input.queries.map(query => {
        const selected = contributions.filter(row => row.observedAtMs >= (query.dateRange?.startMs ?? 0)
          && row.observedAtMs < (query.dateRange?.endMs ?? Infinity));
        const breakdowns = Object.fromEntries(dimensions.map(dimension => {
          const previous = Array.from({ length: 21 }, (_, index) => ({ key: `${dimension}-${index}`,
            label: `${dimension} label ${index}`, ...value.totals }));
          const entries = buildUsageBreakdownList(selected, dimension, query.topLimit, query.costMode ?? 'auto', previous);
          inventories.set(dimension, entries);
          return [dimension, entries];
        }));
        const rich: UsageAnalyticsQueryResponse = { ...value, contributions: selected, breakdowns,
          totals: { eventCount: selected.length, tokens: { input: selected.length * 10, output: selected.length * 5,
            reasoning: 0, cacheRead: 0, cacheWrite: 0, total: selected.length * 15 },
            cost: { reportedUsd: selected.length, estimatedUsd: 0, currency: 'USD' } },
          coverage: { status: 'complete', reasons: [], missingDimensions: [], ranked: [], range: { ...query.dateRange, complete: true },
            sources: Array.from({ length: 21 }, (_, index) => ({ source: `source-${index}`, machineId: `machine-${index}`,
              path: 'runtime', status: 'available', captureKind: 'measured', eventCount: selected.filter(row => row.source === `source-${index}`).length })) } };
        return { query, value: rich };
      });
      const batch = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1, results }, input, false));
      delivered.push(JSON.stringify(batch));
      return Response.json(batch);
    });
    const account = await captureLazyActionAccountContext(captured.accountLifetime.scope.serverId);
    const ports = createUiUsageActionPorts(account);
    const deps = createActionExecutorBoundaryFixture({ usageActions: ports, machinesList: async () => ({ items: [] }) });
    const executor = createActionExecutor(deps);
    // Call-through observations only; the Resource and option owner remain real.
    const calls = vi.spyOn(ports, 'query');
    const parse = vi.spyOn(UsageQueryBatchResultSchema, 'parse');
    const safeParse = vi.spyOn(UsageQueryBatchResultSchema, 'safeParse');
    const httpParse = vi.spyOn(UsageAnalyticsQueryBatchResponseSchema, 'parse');
    const httpSafeParse = vi.spyOn(UsageAnalyticsQueryBatchResponseSchema, 'safeParse');
    const requestsBefore = home!.httpRequests.length;
    try {
      for (const [field, dimension] of [['agents', 'agent'], ['machines', 'machine'], ['projects', 'project'], ['sources', 'source']] as const) {
        const selected = `selected-${field}`;
        const result = await executor.execute('action.options.resolve', { optionsSourceId: `usage.filters.${field}`,
          draftInput: { query: { period: { startMs: 0, endMs: 1000 }, [field]: [selected] } } },
          { surface: 'ui', serverId: captured.accountLifetime.scope.serverId });
        const expected = new Map(inventories.get(dimension)!.map(entry => [entry.key, entry.label ?? entry.key]));
        if (field === 'machines' || field === 'sources') for (let index = 0; index < 21; index++) {
          const id = `${dimension}-${index}`;
          if (!expected.has(id)) expected.set(id, id);
        }
        expected.set(selected, field === 'projects' ? 'No project name' : selected);
        expect(result).toMatchObject({ ok: true, result: { options: [...expected].map(([value, label]) => ({ value, label })) } });
      }
      expect(calls).toHaveBeenCalledTimes(4);
      expect(calls.mock.calls.every(([request]) => request.queries.length === 1 && request.queries[0]!.includeComparison === false
        && request.queries[0]!.includeSessionEvidence === false && request.queries[0]!.includeWorkEvidence === false
        && request.queries[0]!.includeTranscriptEvidence === false && request.queries[0]!.includeQuotaHistory === false)).toBe(true);
      const requests = home!.httpRequests.slice(requestsBefore);
      const accounting = requests.filter(request => request.path === '/v2/usage/query-batch');
      expect(accounting).toHaveLength(1);
      const input = UsageAnalyticsQueryBatchRequestSchema.parse(accounting[0]!.body);
      expect(input.includeContributions).toBe(false);
      expect(input.queries).toHaveLength(1);
      expect(input.queries[0]).toMatchObject({ includeSeries: false, includeActivity: false, includeInsights: false,
        includeLeaders: false, includeModelTimeline: false, includeMessageStats: false, topLimit: 20 });
      expect(requests.filter(request => request.path.includes('/provider-account-usage/')
        || request.path === '/v2/sessions/read-batch' || request.path.endsWith('/messages') || request.path.endsWith('/turns'))).toEqual([]);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).not.toMatch(/inventory-event-|"contributions"/);
      expect(httpParse.mock.calls.length + httpSafeParse.mock.calls.length, 'one HTTP admission, independent of throwing or typed error return').toBe(1);
      expect(parse).not.toHaveBeenCalled();
      expect(safeParse).not.toHaveBeenCalled();
    } finally { account.dispose(); }
  });

  it('keeps an idle accounting view quiet through source-status pushes and reads one genuine accounting change', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeQuotaHistory: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    let sourceWakes = 0;
    const releaseSources = subscribeHomeAccountChange(() => { sourceWakes++; }, {
      serverIds: [captured.accountLifetime.scope.serverId], usageSourcesMachineIds: ['capture-machine'],
    });
    const reads = () => home!.httpRequests.filter(row => row.path === '/v2/usage/query-batch').length;
    const { applyUsageSocketUpdate } = await import('@/sync/engine/socket/usageUpdates');
    try {
      await entry.refresh();
      await flushHookEffects({ cycles: 20 });
      const baseline = reads();
      vi.useFakeTimers();
      for (let index = 0; index < 30; index++) {
        applyUsageSocketUpdate({ type: 'usage-sources-invalidated', machineId: 'capture-machine', installationId: 'installation' },
          captured.accountLifetime.scope.serverId, captured.accountLifetime.scope.accountId);
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect.soft(reads() - baseline, '300 idle seconds and source-status pushes change no accounting fact').toBe(0);
      expect(sourceWakes, 'The source inventory still receives its own status changes').toBe(30);
      applyUsageSocketUpdate({ type: 'usage', id: null, key: 'native', tokens: { total: 1 }, cost: { total: 0 },
        timestamp: 500, accountingChange: { sessionId: null } }, captured.accountLifetime.scope.serverId,
        captured.accountLifetime.scope.accountId);
      await vi.advanceTimersByTimeAsync(0);
      await flushHookEffects({ cycles: 20 });
      expect(reads() - baseline, 'A real accounting push must still reach the visible entry').toBe(1);
    } finally { vi.useRealTimers(); releaseSources(); release(); }
  });

  it('retains accounting bytes across 47 proven Session status wakes while closed private evidence refreshes', async () => {
    let revision = 1;
    const captured = await context(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json({ ...value, totals: { ...value.totals, eventCount: revision } });
      if (request.path === '/v2/sessions/status-session') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({
        id: 'status-session', createdAt: 1, updatedAt: 900 + revision, seq: 1, active: true, activeAt: 900,
        metadataVersion: 1, agentStateVersion: revision }) });
      if (request.path === '/v1/sessions/status-session/turns') return Response.json({ v: 1, sessionId: 'status-session', updatedAt: 900 + revision,
        turns: [{ turnId: 'status-turn', agentId: 'codex', status: 'completed', startedAt: 100,
          terminalAt: 100 + 300 * revision, updatedAt: 900 + revision }] });
      if (request.path === '/v1/sessions/status-session/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    const session = createSessionFixture({ id: 'status-session', serverId: captured.accountLifetime.scope.serverId,
      encryptionMode: 'plain', seq: 1, agentStateVersion: 1 });
    storage.getState().applySessions([session]);
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeInsights: true,
      includeComparison: false, includeQuotaHistory: false, includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeWorkEvidence: false });
    const store = getUsageQueryResourceStore(captured);
    const entry = (privateEvidence: boolean) => store.getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({ ...query, includeSessionEvidence: privateEvidence })] }) });
    const accounting = entry(false);
    const evidence = entry(true);
    let releaseAccounting = accounting.subscribe(() => {}, true);
    let releaseEvidence = evidence.subscribe(() => {}, true);
    const settle = async () => { await flushHookEffects({ cycles: 20 });
      await expect.poll(() => [accounting, evidence].every(row => row.getSnapshot().pending === 'idle')).toBe(true); };
    try {
      await Promise.all([accounting.refresh({ supersede: false }), evidence.refresh({ supersede: false })]);
      await settle();
      expect(decodeUsageQueryResource(evidence.getSnapshot().value!).results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
      const retained = accounting.getSnapshot().value;
      const tokens = decodeUsageQueryResource(retained!).results[0]!.accounting!.totals.tokens;
      const total = tokens.total;
      let factReads = 0;
      Object.defineProperty(tokens, 'total', { enumerable: true, configurable: true, get: () => { factReads++; return total; } });
      releaseAccounting();
      releaseEvidence();
      revision = 2;
      storage.getState().applySessions([{ ...session, agentStateVersion: 2, updatedAt: session.updatedAt + 1 }]);
      const afterCursor = 10;
      const publishStatus = (index: number) => {
        // This is the focused page's real canonical producer decision; no
        // hint-key heuristic or Resource-local Session classifier stands in.
        const change: ApiChangeEntry = { kind: 'session', entityId: session.id, cursor: 11 + index, changedAt: 901,
          hint: { agentStateVersion: 2, usageAccountingChanged: false, usageAccountingUnchangedSinceCursor: 10 } };
        const planned = planSyncActionsFromChanges([change], { isSessionListMember: () => true, afterCursor });
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, [session.id], { changeKinds: ['session'],
          usageQueryAffects: plannedChangesAffectUsageQuery(planned), usageAccountingAffects: plannedChangesAffectUsageAccounting(planned) });
      };
      for (let index = 0; index < 47; index++) publishStatus(index);
      const beforeHttp = home!.httpRequests.length;
      releaseAccounting = accounting.subscribe(() => {}, true);
      await settle();
      expect.soft(accounting.getSnapshot().value, 'Unchanged accounting reopens with its admitted bytes and no recomposition').toBe(retained);
      expect.soft(home!.httpRequests.length - beforeHttp, 'Session-only publications require no HTTP from an accounting-only reopen').toBe(0);
      expect.soft(factReads, 'Unchanged accounting reopens without walking admitted facts').toBe(0);
      for (let index = 47; index < 94; index++) publishStatus(index);
      await settle();
      expect.soft(accounting.getSnapshot().value, 'A live accounting view also ignores private-only status changes').toBe(retained);
      expect.soft(home!.httpRequests.length - beforeHttp).toBe(0);
      expect.soft(factReads).toBe(0);
      const beforeAccounting = home!.httpRequests.filter(row => row.path === '/v2/usage/query-batch').length;
      releaseEvidence = evidence.subscribe(() => {}, true);
      await settle();
      expect.soft(decodeUsageQueryResource(evidence.getSnapshot().value!).results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(600);
      expect.soft(home!.httpRequests.filter(row => row.path === '/v2/usage/query-batch').length - beforeAccounting,
        'Refreshing private evidence keeps the admitted accounting answer').toBe(0);
      revision = 3;
      storage.getState().applySessions([{ ...session, agentStateVersion: 3, updatedAt: session.updatedAt + 2 }]);
      const mixedChanges: ApiChangeEntry[] = [
        { kind: 'session', entityId: session.id, cursor: 108, changedAt: 902,
          hint: { agentStateVersion: 3, usageAccountingChanged: false, usageAccountingUnchangedSinceCursor: 107 } },
        { kind: 'account', entityId: 'provider-account-usage', cursor: 109, changedAt: 902 },
      ];
      const mixedPlan = planSyncActionsFromChanges(mixedChanges, { isSessionListMember: () => true, afterCursor: 107 });
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, mixedChanges.map(change => change.entityId), {
        changeKinds: mixedChanges.map(change => change.kind), usageQueryAffects: plannedChangesAffectUsageQuery(mixedPlan),
        usageAccountingAffects: plannedChangesAffectUsageAccounting(mixedPlan),
      });
      await settle();
      expect.soft(decodeUsageQueryResource(evidence.getSnapshot().value!).results[0]?.howYouWork?.intervals?.agentTimeMs,
        'A mixed allowance wake must also refresh changed private Session evidence').toBe(900);
      expect.soft(home!.httpRequests.filter(row => row.path === '/v2/usage/query-batch').length - beforeAccounting).toBe(0);
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, [], { changeKinds: ['account'],
        usageQueryAffects: true, usageAccountingChange: { sessionId: null } });
      await settle();
      expect.soft(home!.httpRequests.filter(row => row.path === '/v2/usage/query-batch').length - beforeAccounting,
        'One real accounting change produces one shared batch').toBe(1);
      expect(decodeUsageQueryResource(accounting.getSnapshot().value!).results[0]?.accounting?.totals.eventCount).toBe(3);
    } finally { releaseAccounting(); releaseEvidence(); }
  });

  it('retains accounting through captured mixed catalog, policy, allowance and Deployment pages, and reads real or unknown changes', async () => {
    let revision = 1;
    const captured = await context(request => request.path === '/v2/usage/query'
      ? Response.json({ ...value, totals: { ...value.totals, eventCount: revision } }) : undefined);
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeComparison: false,
      includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    let publications = 0;
    const release = entry.subscribe(() => { publications++; }, true);
    const reads = () => home!.httpRequests.filter(row => row.path === '/v2/usage/query-batch').length;
    const settle = async () => { await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle'); };
    const publishPage = (changes: ApiChangeEntry[]) => {
      const planned = planSyncActionsFromChanges(changes, { isSessionListMember: () => true, afterCursor: 1 });
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, changes.map(change => change.entityId), {
        changeKinds: changes.map(change => change.kind), usageQueryAffects: plannedChangesAffectUsageQuery(planned),
        usageAccountingAffects: plannedChangesAffectUsageAccounting(planned),
      });
    };
    const machine: ApiChangeEntry = { kind: 'machine', entityId: 'policy-controller-fixture', cursor: 2, changedAt: 1 };
    try {
      await entry.refresh({ supersede: false });
      await settle();
      const before = reads();
      const retained = entry.getSnapshot().value;
      expect(before, 'One resolved accounting request admits one batch').toBe(1);
      publications = 0;
      // The live Overview/Work trace repeatedly received all three Deployment
      // rows, including the content-free socket wake, with unchanged Usage demand.
      for (let index = 0; index < 7; index++) {
        const identity = { projectSourceId: 'usage-deployment-source', environmentId: 'usage-environment' };
        const deploymentChanges = [
          buildDeploymentAccountChangeV1({ ...identity, revision: index + 1 }),
          buildDeploymentAccountChangeV1({ ...identity, deploymentId: 'usage-deployment', revision: index + 1 }),
          buildDeploymentAccountChangeV1({ ...identity, activityChanged: true, revision: index + 1 }),
        ];
        if (index % 2 === 0) publishPage([...deploymentChanges.map((change, row) => ({
          ...change, cursor: 10 + index * 3 + row, changedAt: index + 1,
        })), machine]);
        else publishHomeAccountChangeWake(captured.accountLifetime.scope.serverId, {
          t: 'account-change', changeKinds: ['account'], entityIds: deploymentChanges.map(change => change.entityId),
        }, 'socket');
        await settle();
      }
      expect.soft(reads() - before, 'Seven Deployment pages admit no replacement accounting batch').toBe(0);
      expect.soft(entry.getSnapshot().value, 'Deployment wakes retain the admitted accounting bytes').toBe(retained);
      expect.soft(publications, 'Deployment-only changes publish no Usage Resource updates').toBe(0);
      for (let catalogRevision = 5363; catalogRevision <= 5371; catalogRevision++) {
        publishPage([{ kind: 'account', entityId: buildConnectedAccountCatalogPhysicalKeyV1('configurations'), cursor: 3, changedAt: 1,
          hint: { connectedAccountCatalog: true, key: 'configurations', revision: catalogRevision } }, machine]);
        await settle();
      }
      publishPage([{ kind: 'account', entityId: 'managed-policy-fixture', cursor: 4, changedAt: 1,
        hint: { managedMachinePolicy: true, machineId: machine.entityId } }, machine]);
      await settle();
      expect.soft(entry.getSnapshot().value, 'Configuration and policy wakes retain admitted accounting bytes').toBe(retained);
      publishPage([{ kind: 'account', entityId: 'provider-account-usage', cursor: 5, changedAt: 1 }, machine,
        { kind: 'automation', entityId: 'automation-fixture', cursor: 6, changedAt: 1 }]);
      await settle();
      // Captured mounted Year pages mixed quota with independent Home/Team
      // administration and plugin checkpoints, without a UsageEvent change.
      for (const entityId of [HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1, TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]) {
        publishPage([{ kind: 'account', entityId: 'provider-account-usage', cursor: 5, changedAt: 1 }, machine,
          { kind: 'account', entityId, cursor: 6, changedAt: 1 },
          { kind: 'pluginDomain', entityId: 'pluginDomain/happier.scm.forge.github/data-collection/automation-event-checkpoints-v1', cursor: 7, changedAt: 1 },
          { kind: 'automation', entityId: 'automation-source-status', cursor: 8, changedAt: 1 }]);
        await settle();
      }
      expect.soft(reads() - before, 'Catalog configuration, Machine policy and allowance changes contain no accounting events').toBe(0);
      revision = 2;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, [], { changeKinds: ['account'], usageQueryAffects: true,
        usageAccountingChange: { sessionId: null } });
      await settle();
      expect.soft(reads() - before).toBe(1);
      expect.soft(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals.eventCount).toBe(2);
      revision = 3;
      publishPage([{ kind: 'account', entityId: 'unknown-account-fixture', cursor: 7, changedAt: 1 }, machine,
        { ...buildDeploymentAccountChangeV1({ environmentId: 'usage-environment', revision: 8 }), cursor: 8, changedAt: 1 }]);
      await settle();
      expect.soft(reads() - before, 'An unknown Account row remains conservative even on a mixed page').toBe(2);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals.eventCount).toBe(3);
    } finally { release(); }
  });

  it('keeps admitted accounting quiet through provider quota Home publications and still reads a real accounting change', async () => {
    let revision = 1;
    let held: ReturnType<typeof createDeferred<void>> | undefined;
    const captured = await context(async request => {
      if (request.path !== '/v2/usage/query') return undefined;
      await held?.promise;
      return Response.json({ ...value, totals: { ...value.totals, eventCount: revision } });
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeQuotaHistory: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false, includeInsights: true });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    const reads = () => home!.httpRequests.filter(row => row.path === '/v2/usage/query-batch').length;
    const settle = async () => { await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle'); };
    try {
      await entry.refresh({ supersede: false });
      await settle();
      const before = reads();
      for (let index = 0; index < 3; index++) {
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['provider-account-usage'],
          { changeKinds: ['account'], usageQueryAffects: true });
        await settle();
      }
      expect.soft(reads() - before, 'Allowance publications change no server accounting answer, including insights').toBe(0);
      for (let index = 0; index < 3; index++) {
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, undefined,
          { source: 'connected', changesCatchUp: true });
        await settle();
      }
      expect.soft(reads() - before, 'The primary Home reconnect reuses settled accounting while its feed catches up').toBe(0);
      const retained = entry.getSnapshot().value;
      held = createDeferred<void>();
      const pending = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
        input: projectNativeJsonValueForTransport({ queries: [{ ...query, period: { startMs: 2000, endMs: 3000 } }] }) });
      const releasePending = pending.subscribe(() => {}, true);
      try {
        await expect.poll(reads).toBeGreaterThan(before);
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, undefined,
          { source: 'connected', changesCatchUp: true });
        await flushHookEffects({ cycles: 20 });
        expect.soft(entry.getSnapshot().pending, 'Recovering an interrupted sibling retains this settled accounting').toBe('idle');
        expect.soft(entry.getSnapshot().value).toBe(retained);
        held.resolve();
        held = undefined;
        await expect.poll(() => pending.getSnapshot().pending).toBe('idle');
      } finally { held?.resolve(); held = undefined; releasePending(); }
      const beforeAccountingChange = reads();
      revision = 2;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, [], {
        changeKinds: ['account'], usageQueryAffects: true, usageAccountingChange: { sessionId: null },
      });
      await settle();
      expect.soft(reads() - beforeAccountingChange, 'The accounting producer still replaces its admitted answer once').toBe(1);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals.eventCount).toBe(2);
    } finally { release(); }
  });

  it('recovers a settled accounting slice that failed before the Home reconnected', async () => {
    let failed = true;
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query-batch') return undefined;
      const { queries } = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
      return Response.json({ v: 1, results: queries.map(query => failed
        ? { query, error: 'usage_query_failed' }
        : { query, value }) });
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeQuota: false,
      includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false,
      includeWorkEvidence: false, includeComparison: false, includeInsights: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    const slice = () => {
      const content = entry.getSnapshot().value;
      return content && decodeUsageQueryResource(content).results[0];
    };
    const reads = () => home!.httpRequests.filter(row => row.path === '/v2/usage/query-batch').length;
    try {
      await entry.refresh({ supersede: false });
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(slice()?.sources).toContainEqual(expect.objectContaining({
        source: 'accounting', status: 'error', errorCode: 'usage_query_failed',
      }));
      const before = reads();
      failed = false;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, undefined,
        { source: 'connected', changesCatchUp: true });
      await expect.poll(() => slice()?.accounting?.totals.eventCount).toBe(value.totals.eventCount);
      expect(reads() - before).toBe(1);
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, undefined,
        { source: 'connected', changesCatchUp: true });
      await flushHookEffects({ cycles: 20 });
      expect(reads() - before).toBe(1);
    } finally { release(); }
  });

  it.each(['failed', 'empty'] as const)('publishes only observed Activity coverage for %s Project accounting', async result => {
    const captured = await context(request => {
      const empty = { ...value, contributions: [], sessionIds: [], sessionMembership: { turns: [] } };
      if (request.path === '/v2/usage/query') return result === 'failed'
        ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(empty);
      if (request.path !== '/v2/usage/query-batch') return undefined;
      const { queries } = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
      return Response.json({ v: 1, results: queries.map(query => result === 'failed'
        ? { query, error: 'usage_query_failed' } : { query, value: empty }) });
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, projects: ['project'],
      includeQuota: false, includeComparison: false, includeCoach: false, includeWorkEvidence: false,
      includeSessionEvidence: true, includeTranscriptEvidence: true });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await entry.refresh();
      const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      const phase = result === 'empty' ? 'available' : 'partial';
      expect(slice.sources.filter(source => ['how_you_work:sessions', 'how_you_work:transcripts'].includes(source.source))).toEqual([
        { source: 'how_you_work:sessions', status: phase },
        { source: 'how_you_work:transcripts', status: phase },
      ]);
    } finally { release(); }
  });

  it('lets Retry cancel the in-flight accounting body and issue exactly one replacement read', async () => {
    const held = createDeferred<void>();
    let revision = 1;
    const captured = await context(async request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const observed = revision;
      if (observed === 1) await held.promise;
      return Response.json({ ...value, totals: { ...value.totals, tokens: { ...value.totals.tokens, total: observed } } });
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeQuotaHistory: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    const reads = () => home!.httpRequests.filter(row => row.path === '/v2/usage/query-batch');
    let retry: ReturnType<typeof entry.refresh> | undefined;
    try {
      await vi.waitFor(() => expect(reads()).toHaveLength(1));
      const original = reads()[0]!;
      revision = 2;
      retry = entry.refresh();
      await vi.waitFor(() => expect(original.signal?.aborted, 'Retry retires the physical read, including a held body').toBe(true));
      await retry;
      await flushHookEffects({ cycles: 20 });
      expect(reads()).toHaveLength(2);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals.tokens.total).toBe(2);
      held.resolve();
      await flushHookEffects({ cycles: 20 });
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals.tokens.total).toBe(2);
      expect(reads()).toHaveLength(2);
    } finally { held.resolve(); await retry; release(); }
  });

  it.each([['calendar', false], ['both', false], ['both', true]] as const)('projects summary Work and public private facts for %s publication (transcript %s) without Usage rows', async (activityResolution, includeTranscriptEvidence) => {
    const accounting: UsageAnalyticsQueryResponse = { ...value, contributions: [
      { ...workContribution, agentId: 'codex', projectKey: 'historical-project', source: 'runtime', sourceContext: { path: 'runtime', execution: 'happier' } },
    ] };
    const deliveries: unknown[] = [];
    const captured = await context(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query-batch') {
        const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
        const delivered = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
          results: input.queries.map(query => ({ query, value: accounting })) },
          input, false));
        deliveries.push(delivered);
        return Response.json(delivered);
      }
      if (request.path === '/v2/sessions/work-session') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({
        id: 'work-session', createdAt: 1, updatedAt: 900, seq: 1, active: false, activeAt: 900,
        metadataVersion: 1, agentStateVersion: 1, metadata: { path: '/repo', host: 'test', machineId: 'work-machine' },
      }) });
      if (request.path === '/v1/sessions/work-session/turns') return Response.json({ v: 1, sessionId: 'work-session', updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] });
      if (request.path === '/v1/sessions/work-session/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.getState().applySessions([createSessionFixture({ id: 'work-session', serverId: captured.accountLifetime.scope.serverId,
      metadata: { machineId: 'work-machine', path: '/repo', host: 'test', homeDir: '/home/test' } })]);
    storage.getState().applyMachines([createHydratedPlainMachineFixture({ id: 'work-machine', accountId: 'account-a', machine: { activeAt: Date.now() } })]);
    const witness: UsageWorkEvidence = { sessionId: 'work-session', turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
      pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
        nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } }, number: 1, title: 'Merged',
        url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'merged' } };
    scmTransport.mockImplementation(async request => workBatch(request, { status: 'partial', evidence: [witness, witness], branchEvidence: [], pullRequestsRead: true }));
    // Private Coach checks consume accounting rows (b67931869cc); this compact Work summary excludes Coach.
    const summary = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, projects: ['historical-project'], includeWorkEvidence: true, workProjection: 'summary',
      includeSessionEvidence: true, includeCoach: false, includeTranscriptEvidence, includeQuotaHistory: false, includeActivity: true,
      includeComparison: false, includeSeries: false, includeInsights: false, includeLeaders: false,
      includeModelTimeline: false, includeMessageStats: false });
    const profile = normalizeUsageQuery({ ...summary, projects: [], population: 'public_eligible_personal', activityResolution });
    const account = await captureLazyActionAccountContext(captured.accountLifetime.scope.serverId);
    const usage = createUiUsageActionPorts(account);
    const actionContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      usageQueryReadiness: 'public_profile' } as const;
    let result: ReturnType<typeof UsageQueryBatchResultSchema.parse>;
    try {
      const publication = UsageQueryBatchResultSchema.parse(await usage.query({ queries: [profile] }, actionContext));
      const ordinary = await readUiUsageQueryBatch(captured, { queries: [summary] });
      result = { v: 1, results: [...ordinary.results, ...publication.results] };
    } finally { account.dispose(); }
    const ordinary = result.results.find(slice => slice.key === getUsageQueryKey(summary))!;
    const publicSlice = result.results.find(slice => slice.key === getUsageQueryKey(profile))!;
    expect.soft(JSON.stringify(deliveries), 'Private transcript demand needs admitted turns, not raw accounting rows').not.toContain('contributionPages');
    expect(ordinary.workSummary).toEqual({ mergedPrCount: 1, pullRequestsRead: true });
    expect(ordinary.howYouWork?.intervals?.agentTimeMs).toBe(300);
    expect(publicSlice.publicProfileEvidence?.facts).toMatchObject({ agentTimeMs: 300, peakParallel: 1, mergedPrs: 1,
      sessionDurations: [{ agentId: 'codex', durationMs: 300 }] });
    expect(publicSlice.publicProfileEvidence?.lenses.find(lens => lens.execution === 'happier')?.facts)
      .toMatchObject({ agentTimeMs: 300, peakParallel: 1, mergedPrs: 1 });
    expect(publicSlice.howYouWork).toBeUndefined();
    expect(publicSlice.work).toBeUndefined();
    expect(publicSlice.coach).toBeUndefined();
    expect(result.results.every(slice => slice.accounting?.contributions === undefined)).toBe(true);
    expect(JSON.stringify(deliveries)).not.toContain('contributionPages');
    expect(UsageQueryBatchResultSchema.safeParse(result).success).toBe(true);
    scmTransport.mockRejectedValue(new RetryableServerResponseError(503, 'Unavailable'));
    const retained = await readUiUsageQueryBatch(captured, { queries: [summary, profile] }, undefined, result);
    const retainedSummary = retained.results.find(slice => slice.key === getUsageQueryKey(summary))!;
    expect(retainedSummary.workSummary).toBeUndefined();
    expect(retainedSummary.sources).toContainEqual(expect.objectContaining({ source: 'work', status: 'stale' }));
    const retainedProfile = retained.results.find(slice => slice.key === getUsageQueryKey(profile))!;
    expect(retainedProfile.publicProfileEvidence?.facts.agentTimeMs).toBe(300);
    expect(retainedProfile.publicProfileEvidence?.facts.mergedPrs).toBeUndefined();
    expect(retainedProfile.sources).toContainEqual(expect.objectContaining({ source: 'work', status: 'stale' }));
    scmTransport.mockRejectedValue(new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN));
    const refused = await readUiUsageQueryBatch(captured, { queries: [summary, profile] }, undefined, retained);
    const refusedProfile = refused.results.find(slice => slice.key === getUsageQueryKey(profile))!;
    expect(refusedProfile.publicProfileEvidence?.facts.mergedPrs).toBeUndefined();
    expect(refusedProfile.publicProfileEvidence?.facts.agentTimeMs).toBe(300);
  });
  it('reuses admitted both activity for weaker calendar and weekday-hour output without crossing query inputs or accounting pushes', async () => {
    let revision = 1;
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const selected = UsageAnalyticsQueryRequestSchema.parse(request.body);
      return Response.json({ ...value, totals: { ...value.totals, eventCount: revision }, activity: {
        ...(selected.activityResolution === 'weekdayHour' ? {} : { calendarDays: [{ date: '1970-01-01', eventCount: revision }] }),
        ...(selected.activityResolution === 'calendar' ? {} : { weekdayHourBuckets: [{ weekday: 4, hour: 0, eventCount: revision }] }) } });
    });
    const both = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeAccounting: true,
      population: 'public_eligible_personal', includeActivity: true, activityResolution: 'both',
      includeComparison: false, includeSeries: false, includeInsights: false, includeLeaders: false,
      includeModelTimeline: false, includeMessageStats: false, includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeWorkEvidence: false, includeQuotaHistory: false });
    const store = getUsageQueryResourceStore(captured);
    const entry = (query: typeof both) => store.getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const read = async (query: typeof both) => {
      const current = entry(query);
      await current.refresh({ supersede: false });
      return decodeUsageQueryResource(current.getSnapshot().value!).results[0]!;
    };
    const reads = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch').length;
    const first = await read(both);
    expect(first.accounting?.activity).toEqual({ calendarDays: [{ date: '1970-01-01', eventCount: 1 }],
      weekdayHourBuckets: [{ weekday: 4, hour: 0, eventCount: 1 }] });
    for (const activityResolution of ['calendar', 'weekdayHour'] as const) {
      const result = await read(normalizeUsageQuery({ ...both, activityResolution }));
      expect(result.accounting?.totals).toEqual(first.accounting?.totals);
      expect(result.accounting?.activity).toEqual(activityResolution === 'calendar'
        ? { calendarDays: first.accounting!.activity!.calendarDays }
        : { weekdayHourBuckets: first.accounting!.activity!.weekdayHourBuckets });
      expect.soft(reads(), 'A weaker output consumes the same admitted accounting facts').toBe(1);
    }
    await read(normalizeUsageQuery({ ...both, activityResolution: 'calendar', agents: ['different'] }));
    expect(reads(), 'A changed accounting filter still acquires its own answer').toBe(2);
    revision = 2;
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['session-a'], { usageQueryAffects: true });
    const changed = await read(normalizeUsageQuery({ ...both, activityResolution: 'calendar' }));
    expect(changed.accounting?.totals.eventCount).toBe(2);
    expect(reads(), 'A real accounting push replaces the admitted answer').toBe(3);
    const expanded = await read(both);
    expect(expanded.accounting?.activity?.weekdayHourBuckets).toEqual([{ weekday: 4, hour: 0, eventCount: 2 }]);
    expect(reads(), 'A calendar-only answer cannot satisfy richer activity demand').toBe(4);
  });

  it('reuses refreshed Overview insights for Costs activity without repeating accounting or leaking undemanded message facts', async () => {
    let revision = 1;
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const selected = UsageAnalyticsQueryRequestSchema.parse(request.body);
      return Response.json({ ...value, totals: { ...value.totals, eventCount: revision },
        activity: {
          ...(selected.activityResolution === 'weekdayHour' ? {} : { calendarDays: [{ date: '1970-01-01', eventCount: revision }] }),
          ...(selected.activityResolution === 'calendar' ? {} : { weekdayHourBuckets: [] }) },
        ...(selected.includeInsights ? { insights: { activeDays: 1, longestStreakDays: 1, sessionsUsed: 1,
          messagesUsed: 3, modelsTried: 1, favoriteModelChangeCount: 0 } } : {}),
        ...(selected.includeInsights || selected.includeMessageStats ? { messageStats: { sessionCount: 1, messageCount: 3 } } : {}) });
    });
    // The recorded preset delta: Overview Rhythm and Costs Plan fit share
    // activity at the same coordinate; only Overview asks for insights.
    const costs = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeAccounting: true,
      includeActivity: true, activityResolution: 'both', includeInsights: false, includeSeries: false,
      includeLeaders: false, includeModelTimeline: false, includeMessageStats: false, includeComparison: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false, includeQuotaHistory: false });
    const overview = normalizeUsageQuery({ ...costs, includeInsights: true });
    const store = getUsageQueryResourceStore(captured);
    const read = async (query: typeof costs) => {
      const entry = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
      await entry.refresh({ supersede: false });
      return decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    };
    const reads = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch').length;
    await read(costs);
    revision = 2;
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['session-a'], { usageQueryAffects: true });
    const refreshed = await read(overview);
    expect(refreshed.accounting?.totals.eventCount).toBe(2);
    expect(refreshed.accounting?.insights?.messagesUsed).toBe(3);
    expect(reads()).toBe(2);
    const calendar = await read(normalizeUsageQuery({ ...costs, activityResolution: 'calendar' }));
    expect(calendar.accounting?.activity).toEqual({ calendarDays: refreshed.accounting!.activity!.calendarDays });
    expect(calendar.accounting?.insights).toBeUndefined();
    expect(calendar.accounting?.messageStats).toBeUndefined();
    expect.soft(reads(), 'Activity and insights narrowing compose from the same admitted Overview answer').toBe(2);
    const returned = await read(costs);
    expect(returned.accounting?.totals).toEqual(refreshed.accounting?.totals);
    expect(returned.accounting?.activity).toEqual(refreshed.accounting?.activity);
    expect(returned.accounting?.insights).toBeUndefined();
    expect(returned.accounting?.messageStats).toBeUndefined();
    expect.soft(reads(), 'Plan fit selects the refreshed admitted activity without another accounting POST').toBe(2);
    await read(normalizeUsageQuery({ ...costs, agents: ['different'] }));
    expect.soft(reads(), 'Changed population filters acquire their own facts').toBe(3);
    const messages = normalizeUsageQuery({ ...overview, includeMessageStats: true });
    await read(messages);
    const retainedMessages = await read(normalizeUsageQuery({ ...messages, includeInsights: false }));
    expect(retainedMessages.accounting?.messageStats).toEqual({ sessionCount: 1, messageCount: 3 });
    expect(retainedMessages.accounting?.insights).toBeUndefined();
    expect.soft(reads(), 'Explicit message demand survives the weaker insights projection').toBe(4);
  });

  it('selects Tokens from admitted Rhythm accounting without reacquiring or exposing its private membership', async () => {
    const posted: Array<ReturnType<typeof UsageAnalyticsQueryBatchRequestSchema.parse>> = [];
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query-batch') return undefined;
      const body = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
      posted.push(body);
      const members = new Set(body.sessionQueries?.map(getUsageAnalyticsQueryRequestKey));
      return Response.json({ v: 1, results: body.queries.map(query => ({ query, value: { ...value,
        activity: { calendarDays: [{ date: '1970-01-01', eventCount: 1 }], weekdayHourBuckets: [] },
        ...(members.has(getUsageAnalyticsQueryRequestKey(query)) ? { sessionIds: ['rhythm-session'],
          sessionMembership: { turns: [{ sessionId: 'rhythm-session', turnId: 'turn', executions: ['happier'] }] } } : {}),
      } })) });
    });
    const tokens = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeActivity: true,
      includeCoach: false, includeComparison: false, includeQuota: false, includeQuotaHistory: false, includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeWorkEvidence: false });
    const busy = normalizeUsageQuery({ ...tokens, metric: 'busy', includeSessionEvidence: true });
    const read = async (query: typeof tokens) => (await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]!;
    const first = await read(busy);
    expect(first.accounting?.totals).toEqual(value.totals);
    expect(posted[0]?.sessionQueries).toHaveLength(1);
    const switched = await read(tokens);
    expect(switched.requestedQuery.metric).toBe('tokens');
    expect(switched.accounting?.totals).toEqual(first.accounting?.totals);
    expect(switched.accounting?.activity).toEqual(first.accounting?.activity);
    expect(switched.accounting?.sessionIds).toBeUndefined();
    expect(switched.accounting?.sessionMembership).toBeUndefined();
    expect.soft(posted, 'Dropping private membership needs zero new accounting batches').toHaveLength(1);

    await read(normalizeUsageQuery({ ...tokens, agents: ['codex'] }));
    const beforeMembership = posted.length;
    await read(normalizeUsageQuery({ ...busy, agents: ['codex'] }));
    expect(posted).toHaveLength(beforeMembership + 1);
    expect(posted.at(-1)?.sessionQueries).toHaveLength(1);
  });

  it('reuses refreshed Overview inventory for an exact Costs Agent subset, and reacquires ambiguous truncated rankings', async () => {
    let revision = 1;
    let incompleteMachineRanking = false;
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const selected = UsageAnalyticsQueryRequestSchema.parse(request.body);
      const dimensions = selected.breakdowns ?? [];
      const missingDimensions = dimensions.includes('project') ? ['project' as const] : [];
      const ranked = dimensions.map(dimension => ({ dimension, totalEntries: dimension === 'machine' && incompleteMachineRanking ? 21 : 1,
        returnedEntries: dimension === 'machine' && incompleteMachineRanking ? 20 : 1, complete: dimension !== 'machine' || !incompleteMachineRanking }));
      const reasons = ranked.some(entry => !entry.complete) ? ['ranked_truncation' as const] : [];
      return Response.json({ ...value, totals: { ...value.totals, eventCount: revision },
        breakdowns: Object.fromEntries(dimensions.map(dimension => [dimension, [{ key: dimension, eventCount: revision, tokens: value.totals.tokens, cost: value.totals.cost }]])),
        coverage: { status: reasons.length || missingDimensions.length ? 'partial' : 'complete', reasons,
          sources: [{ source: 'runtime', path: 'runtime', status: 'available', historyComplete: true, eventCount: revision }],
          missingDimensions, ranked, range: { ...selected.dateRange, complete: true } } });
    });
    const costs = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, breakdown: ['agent'], includeAccounting: true,
      includeActivity: false, includeInsights: false, includeSeries: false, includeLeaders: false,
      includeModelTimeline: false, includeMessageStats: false, includeComparison: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false, includeQuotaHistory: false });
    const overview = normalizeUsageQuery({ ...costs, breakdown: ['agent', 'machine', 'project', 'source'] });
    const store = getUsageQueryResourceStore(captured);
    const read = async (query: typeof costs) => {
      const entry = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
      await entry.refresh({ supersede: false });
      return decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    };
    const reads = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch').length;
    await read(costs);
    revision = 2;
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['session-a'], { usageQueryAffects: true });
    const refreshed = await read(overview);
    expect(refreshed.accounting?.coverage?.missingDimensions).toEqual(['project']);
    expect(reads()).toBe(2);
    const returned = await read(costs);
    expect(returned.accounting?.totals.eventCount).toBe(2);
    expect(returned.accounting?.breakdowns).toEqual({ agent: refreshed.accounting?.breakdowns?.agent });
    expect(returned.accounting?.coverage).toEqual({ ...refreshed.accounting!.coverage!, status: 'complete',
      missingDimensions: [], ranked: refreshed.accounting!.coverage!.ranked.filter(row => row.dimension === 'agent') });
    expect.soft(reads(), 'The covered refreshed Agent ranking requires no new accounting POST').toBe(2);
    await read(normalizeUsageQuery({ ...costs, topLimit: 1 }));
    expect.soft(reads(), 'A different ranking limit remains a distinct request').toBe(3);
    revision = 3;
    incompleteMachineRanking = true;
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['session-a'], { usageQueryAffects: true });
    await read(overview);
    const resolved = await read(costs);
    expect(resolved.accounting?.totals.eventCount).toBe(3);
    expect(resolved.accounting?.coverage?.reasons).toEqual([]);
    expect.soft(reads(), 'Removing an incomplete ranking cannot invert an unqualified truncation reason').toBe(5);
  });

  it('requests only summary accounting for an aggregate slice without admitting contribution detail', async () => {
    const reads: unknown[] = [];
    const captured = await context(request => {
      if (request.path === '/v2/usage/query-batch') reads.push(request.body);
      return request.path === '/v2/usage/query' ? Response.json({ ...value, contributions: [workContribution] }) : undefined;
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, breakdown: ['agent'],
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
      includeQuotaHistory: false });
    const batch = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(reads).toHaveLength(1);
    expect(UsageAnalyticsQueryBatchRequestSchema.parse(reads[0])).toMatchObject({
      includeContributions: false, contributionQueries: [],
    });
    expect(batch.results[0]?.accounting?.totals).toMatchObject(value.totals);
    expect(batch.results[0]?.accounting).not.toHaveProperty('contributions');
  });

  it('upgrades summary demand to paged Work once and reuses its held summary on the next view', async () => {
    const contributions = [3, 6, 0, 0, 0].map((count, index) => ({ ...workContribution, id: `row-${index}`,
      sessionId: null, turnId: null, modelId: 'work-priced-model',
      tokens: { input: count, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: count } }));
    const captured = await context(request => request.path === '/v2/usage/query'
      ? Response.json({ ...value, contributions }) : undefined, undefined, settingsParse({ usageModelPriceOverridesV1: {
        'work-priced-model': { kind: 'rates', inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 } } }));
    const summary = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, topLimit: 2, costBasis: 'api_equivalent',
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false, includeQuotaHistory: false });
    const work = normalizeUsageQuery({ ...summary, includeWorkEvidence: true });
    const first = await readUiUsageQueryBatch(captured, { queries: [summary] });
    expect(first.results[0]?.accounting).not.toHaveProperty('contributions');
    const workEntry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [work] }) });
    await workEntry.refresh();
    const detailed = decodeUsageQueryResource(workEntry.getSnapshot().value!);
    expect(detailed.results[0]?.accounting?.contributions?.map(row => row.id)).toEqual(contributions.map(row => row.id));
    expect(detailed.results[0]?.work?.allocations.map(row => row.contributionId)).toEqual(contributions.map(row => row.id));
    const amount = summarizeUsageWork(detailed.results[0]!.work!, detailed.results[0]!.accounting!.contributions!, { metric: 'cost', costBasis: 'api_equivalent' }).total;
    expect(formatUsageCost(amount!, 'USD')).toBe('$0.0025');
    const reads = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch');
    expect(reads()).toHaveLength(2);
    expect(UsageAnalyticsQueryBatchRequestSchema.parse(reads()[1]!.body).contributionQueries).toHaveLength(1);
    const returned = await readUiUsageQueryBatch(captured, { queries: [summary] });
    expect(reads()).toHaveLength(2);
    expect(returned.results[0]?.accounting?.totals).toEqual(first.results[0]?.accounting?.totals);
    expect(returned.results[0]?.accounting).not.toHaveProperty('contributions');
  });

  it('admits one accounting reply burst per mounted view and never repeats its current input over sixty idle seconds', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let revision = 1;
    let held: ReturnType<typeof createDeferred<void>> | undefined;
    const captured = await context(async request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const observedRevision = revision;
      await held?.promise;
      return Response.json({ ...value, totals: { ...value.totals, eventCount: observedRevision } });
    });
    const query = normalizeUsageQuery({ period: { relative: '7days' }, session: 'reply-session',
      includeComparison: false, includeQuotaHistory: false, includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeWorkEvidence: false });
    const store = getUsageQueryResourceStore(captured);
    // Match the live Session layout, including its preceding comparison range.
    const queries = [normalizeUsageQuery({ ...query, breakdown: ['agent', 'machine', 'project', 'source'], includeComparison: true }),
      normalizeUsageQuery({ ...query, breakdown: ['machine'] }), normalizeUsageQuery({ ...query, breakdown: ['model'] }),
      normalizeUsageQuery({ ...query, includeSeries: true, includeModelTimeline: true }),
      normalizeUsageQuery({ ...query, includeInsights: true })];
    const entries = queries.map(query => store.getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) }));
    const releases = entries.map(entry => entry.subscribe(() => {}, true));
    const requests = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch');
    const { applyUsageSocketUpdate } = await import('@/sync/engine/socket/usageUpdates');
    const settled = async () => {
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entries.every(entry => entry.getSnapshot().pending === 'idle')).toBe(true);
    };
    try {
      await Promise.all(entries.map(entry => entry.refresh({ supersede: false })));
      await settled();
      const before = requests().length;
      now += 1000;
      revision = 3;
      held = createDeferred<void>();
      // One reply commits two genuine facts before the next admission runs.
      for (let index = 0; index < 2; index++) applyUsageSocketUpdate({ type: 'usage', id: 'reply-session',
        key: `reply-fact-${index}`, tokens: { total: 1 }, cost: { total: 0 }, timestamp: now,
        accountingChange: { sessionId: 'reply-session', observedFromMs: now - 2000 } },
      captured.accountLifetime.scope.serverId, captured.accountLifetime.scope.accountId);
      await expect.poll(() => requests().length).toBe(before + 1);
      const joined = readUiUsageQueryBatch(captured, { queries });
      await flushHookEffects({ cycles: 20 });
      expect.soft(requests().length - before, 'Identical in-flight inputs join the existing physical read').toBe(1);
      held.resolve();
      held = undefined;
      await joined;
      await settled();
      const burst = requests().slice(before).map(request => UsageAnalyticsQueryBatchRequestSchema.parse(request.body));
      expect.soft(burst, 'A synchronous reply burst has one transport batch for all mounted views').toHaveLength(1);
      expect.soft(burst.flatMap(batch => batch.queries), 'Five views and their one comparison are read exactly once').toHaveLength(6);
      expect.soft(burst.flatMap(batch => batch.queries.filter(query => query.dateRange?.endMs === now)),
        'The changed relative window advances to this admission, not the previous answer clock').toHaveLength(5);
      expect.soft(entries.map(entry => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals.eventCount))
        .toEqual([3, 3, 3, 3, 3]);
      const after = requests().length;
      await readUiUsageQueryBatch(captured, { queries });
      expect(requests().length - after, 'Identical current inputs rebatch without another request').toBe(0);
      for (let second = 1; second <= 60; second++) {
        now += 1000;
        // Secondary Home sockets must carry the planner's existing accounting
        // relevance, just as the focused durable page does. These facts alter
        // private evidence/access, not UsageEvent accounting.
        const kind = second === 12 ? 'discussion' : second === 24 ? 'share' : second === 60 ? 'machineRecipientAccess' : undefined;
        if (kind) publishHomeAccountChangeWake(captured.accountLifetime.scope.serverId,
          { t: 'account-change', changeKinds: [kind], entityIds: ['unrelated-private-fact'] }, 'socket');
        if (second === 36 || second === 48) {
          const change: ApiChangeEntry = { kind: 'account', entityId: NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1,
            cursor: second, changedAt: now };
          const planned = planSyncActionsFromChanges([change]);
          publishHomeAccountChange(captured.accountLifetime.scope.serverId, [change.entityId], {
            changeKinds: ['account'], feedPageConsumed: true, usageQueryAffects: plannedChangesAffectUsageQuery(planned),
            usageAccountingAffects: plannedChangesAffectUsageAccounting(planned),
          });
        }
        if (second === 40 || second === 56) {
          // QA's identical replay captured committed changes for another
          // Session without the optional ephemeral accountingChange hint.
          publishHomeAccountChange(captured.accountLifetime.scope.serverId,
            second === 40 ? ['other-reply-session'] : ['other-reply-session', 'another-reply-session'], {
            changeKinds: ['session'], feedPageConsumed: true,
            usageQueryAffects: true, usageAccountingAffects: true,
          });
        }
        await settled();
        await readUiUsageQueryBatch(captured, { queries });
      }
      expect(requests().length - after, 'An advancing clock, including the comparison window, produces zero reads for sixty idle seconds').toBe(0);
      now += 1000;
      revision = 4;
      applyUsageSocketUpdate({ type: 'usage', id: 'reply-session', key: 'newer-fact',
        tokens: { total: 1 }, cost: { total: 0 }, timestamp: now,
        accountingChange: { sessionId: 'reply-session', observedFromMs: now - 1 } },
      captured.accountLifetime.scope.serverId, captured.accountLifetime.scope.accountId);
      await settled();
      const newer = requests().slice(after).map(request => UsageAnalyticsQueryBatchRequestSchema.parse(request.body));
      expect.soft(newer, 'A fact newer than the prior answer also refreshes exactly once').toHaveLength(1);
      expect.soft(newer.flatMap(batch => batch.queries.filter(query => query.dateRange?.endMs === now))).toHaveLength(5);
      expect.soft(entries.map(entry => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals.eventCount))
        .toEqual([4, 4, 4, 4, 4]);
      const beforeOwnedPage = requests().length;
      now += 1000;
      revision = 5;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['reply-session'], {
        changeKinds: ['session'], feedPageConsumed: true, usageQueryAffects: true, usageAccountingAffects: true,
      });
      await settled();
      expect(requests().length - beforeOwnedPage, 'A named page for the owned Session still refreshes exactly once').toBe(1);
      expect(entries.map(entry => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals.eventCount))
        .toEqual([5, 5, 5, 5, 5]);
    } finally { held?.resolve(); releases.forEach(release => release()); }
  });

  it('keeps an unrelated in-flight accounting admission joinable and reusable after a scoped change', async () => {
    const held = createDeferred<void>();
    let holdA = true;
    const captured = await context(async request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const selected = UsageAnalyticsQueryRequestSchema.parse(request.body);
      if (selected.filters?.sessionIds?.includes('pending-a') && holdA) await held.promise;
      return Response.json(value);
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, session: 'pending-a',
      includeComparison: false, includeQuotaHistory: false, includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeWorkEvidence: false });
    const other = normalizeUsageQuery({ ...query, session: 'changed-b' });
    await readUiUsageQueryBatch(captured, { queries: [other] });
    const readsA = () => home!.requests.filter(request => request.path === '/v2/usage/query'
      && UsageAnalyticsQueryRequestSchema.parse(request.body).filters?.sessionIds?.includes('pending-a')).length;
    const first = readUiUsageQueryBatch(captured, { queries: [query] });
    try {
      await expect.poll(readsA).toBe(1);
      const { applyUsageSocketUpdate } = await import('@/sync/engine/socket/usageUpdates');
      applyUsageSocketUpdate({ type: 'usage', id: 'changed-b', key: 'fact-b', tokens: { total: 1 },
        cost: { total: 0 }, timestamp: 500, accountingChange: { sessionId: 'changed-b', observedFromMs: 500 } },
      captured.accountLifetime.scope.serverId, captured.accountLifetime.scope.accountId);
      const joined = readUiUsageQueryBatch(captured, { queries: [query, other] });
      await flushHookEffects({ cycles: 20 });
      expect.soft(readsA(), 'A scoped B change must not split the identical pending A read').toBe(1);
      holdA = false;
      held.resolve();
      await Promise.all([first, joined]);
      await readUiUsageQueryBatch(captured, { queries: [query] });
      expect(readsA(), 'A pending answer unaffected by B remains admitted after settlement').toBe(1);
    } finally { holdA = false; held.resolve(); await first; }
  });

  it('scopes accounting ingests to consumed Sessions and range ends, and coalesces a busy burst', async () => {
    let revision = 1;
    let held: ReturnType<typeof createDeferred<void>> | undefined;
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') {
        const observedRevision = revision;
        await held?.promise;
        return Response.json({ ...value, totals: { ...value.totals,
          tokens: { ...value.totals.tokens, total: observedRevision } } });
      }
      return undefined;
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, session: 'affected',
      includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const store = getUsageQueryResourceStore(captured);
    const entry = (query: ReturnType<typeof normalizeUsageQuery>) => store.getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const relevant = entry(query);
    const unrelated = entry(normalizeUsageQuery({ ...query, session: 'unrelated' }));
    const earlier = entry(normalizeUsageQuery({ ...query, period: { startMs: 0, endMs: 100 } }));
    const quotaOnly = entry(normalizeUsageQuery({ ...query, includeAccounting: false }));
    const entries = [relevant, unrelated, earlier, quotaOnly];
    const releases = entries.map(row => row.subscribe(() => {}, true));
    const reads = () => home!.requests.filter(row => row.path === '/v2/usage/query').length;
    const { EphemeralUpdateSchema } = await import('@happier-dev/protocol/updates');
    const { applyUsageSocketUpdate } = await import('@/sync/engine/socket/usageUpdates');
    const push = (accountingChange?: Readonly<{ sessionId: string | null; observedFromMs?: number }>) => applyUsageSocketUpdate(
      EphemeralUpdateSchema.parse({ type: 'usage', id: 'affected', key: 'codex:model', tokens: { total: 1 }, cost: { total: 0 },
        timestamp: 500, ...(accountingChange ? { accountingChange } : {}) }) as Extract<ReturnType<typeof EphemeralUpdateSchema.parse>, { type: 'usage' }>,
      captured.accountLifetime.scope.serverId, captured.accountLifetime.scope.accountId);
    const settled = async () => { await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entries.every(row => row.getSnapshot().pending === 'idle')).toBe(true); };
    try {
      // Join each initial admission. Explicit Refresh intentionally replaces
      // the Account instant and would retire earlier concurrent admissions.
      await Promise.all(entries.map(row => row.refresh({ supersede: false })));
      await settled();
      const before = reads();
      const unrelatedBefore = unrelated.getSnapshot().value;
      const earlierBefore = earlier.getSnapshot().value;
      revision = 2;
      push({ sessionId: 'affected', observedFromMs: 500 });
      await settled();
      expect.soft(reads() - before, 'One ingest reads only its consumed Session/range').toBe(1);
      expect.soft(unrelated.getSnapshot().value).toBe(unrelatedBefore);
      expect.soft(earlier.getSnapshot().value).toBe(earlierBefore);
      expect.soft(decodeUsageQueryResource(relevant.getSnapshot().value!).results[0]?.accounting?.totals.tokens.total).toBe(2);

      // A scoped ingest preserves unrelated admissions across navigation and
      // changes to the visible batch, not only while that watch stays mounted.
      const beforeReopen = reads();
      const beforeReopenRequests = home!.requests.length;
      releases[1]!();
      releases[1] = unrelated.subscribe(() => {}, true);
      await settled();
      await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ ...query, session: 'unrelated' }),
        normalizeUsageQuery({ ...query, includeAccounting: false })] });
      expect.soft(reads() - beforeReopen, 'Unaffected reopen/rebatch reuses its admitted accounting').toBe(0);
      expect.soft(home!.requests.slice(beforeReopenRequests)
        .map(row => row.path), 'Unaffected reopen/rebatch issues no HTTP').toEqual([]);

      const beforeBurst = reads();
      held = createDeferred<void>();
      revision = 3;
      push({ sessionId: 'affected', observedFromMs: 500 });
      await expect.poll(reads).toBeGreaterThan(beforeBurst);
      revision = 4;
      for (let index = 0; index < 10; index++) push({ sessionId: 'affected', observedFromMs: 500 });
      held.resolve();
      held = undefined;
      await settled();
      // USAGE-PENDING-STARVATION: newer ingests age the finite read;
      // they must not keep its selected answer pending through replacement reads.
      expect.soft(reads() - beforeBurst, 'Ten ingests during an active read settle its answer without an automatic follow-up').toBe(1);
      const settledBurst = decodeUsageQueryResource(relevant.getSnapshot().value!).results[0]!;
      expect.soft(settledBurst.accounting?.totals.tokens.total).toBe(3);
      expect.soft(settledBurst.pending).toBe(false);
      expect.soft(settledBurst.sources).toContainEqual(expect.objectContaining({ source: 'accounting', status: 'stale' }));

      const beforeNative = reads();
      revision = 5;
      push({ sessionId: null });
      await settled();
      expect.soft(reads() - beforeNative, 'Native subjects may cross Session identities and historical ranges').toBe(3);
      const beforeLegacy = reads();
      revision = 6;
      push();
      await settled();
      expect.soft(reads() - beforeLegacy, 'Older producers without routing facts remain conservative').toBe(3);

      // A later range has both current and comparison accounting reads. An
      // observation before its start still changes their cumulative baselines.
      for (const release of releases.splice(0)) release();
      const withBaseline = entry(normalizeUsageQuery({ ...query, period: { startMs: 600, endMs: 1000 } }));
      releases.push(withBaseline.subscribe(() => {}, true));
      await withBaseline.refresh();
      await expect.poll(() => withBaseline.getSnapshot().pending).toBe('idle');
      const beforeBaseline = reads();
      revision = 7;
      push({ sessionId: 'affected', observedFromMs: 500 });
      await expect.poll(() => withBaseline.getSnapshot().pending).toBe('idle');
      expect.soft(reads() - beforeBaseline, 'Pre-range baseline changes refresh current and comparison reads').toBe(2);
      expect.soft(decodeUsageQueryResource(withBaseline.getSnapshot().value!).results[0]?.accounting?.totals.tokens.total).toBe(7);
    } finally { held?.resolve(); releases.forEach(release => release()); }
  });

  it('publishes accounting calendars through the live Resource while sibling private evidence is held and refused', async () => {
    const session = createDeferred<Response>();
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: [workContribution] });
      if (request.path === '/v2/sessions/work-session') return session.promise;
      return undefined;
    });
    const summary = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeActivity: true,
      includeWorkEvidence: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeCoach: false });
    const detail = normalizeUsageQuery({ ...summary, includeSessionEvidence: true });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [summary, detail] }) });
    const release = entry.subscribe(() => {}, false);
    const account = await captureLazyActionAccountContext(captured.accountLifetime.scope.serverId);
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
    const actionContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    let releaseSummary: (() => void) | undefined;
    const slice = (query: typeof summary) => {
      const content = entry.getSnapshot().value;
      return content ? decodeUsageQueryResource(content).results.find(row => row.key === getUsageQueryKey(query)) : undefined;
    };
    try {
      await expect.poll(() => sessionRequests().some(request => request.path === '/v2/sessions/work-session')).toBe(true);
      await expect.poll(() => slice(summary)?.howYouWork?.agentCalendar?.periodSummary.totals.tokens).toBe(15);
      expect(slice(summary)?.pending).toBe(false);
      expect(slice(detail)?.pending).toBe(true);
      // The current Resource admission is useful before optional private evidence settles.
      const progressive = await executor.execute('usage.query', { queries: [summary, detail] }, actionContext);
      expect(progressive).toMatchObject({ ok: true, result: { results: expect.arrayContaining([
        expect.objectContaining({ key: getUsageQueryKey(detail), pending: true }),
      ]) } });
      session.resolve(Response.json({ error: 'denied' }, { status: 403 }));
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(slice(summary)?.howYouWork?.agentCalendar?.periodSummary.totals.tokens).toBe(15);
      expect(slice(detail)?.howYouWork?.agentCalendar?.periodSummary.totals.busyMs).toBeNull();
      expect(slice(detail)?.pending).toBe(false);
      expect(entry.getSnapshot().error).toBeUndefined();
      const accountingOnly = normalizeUsageQuery({ ...summary, includeActivity: false, includeCoach: false });
      const summaryEntry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
        input: projectNativeJsonValueForTransport({ queries: [accountingOnly] }) });
      releaseSummary = summaryEntry.subscribe(() => {}, true);
      await summaryEntry.refresh({ supersede: false });
      const retained = summaryEntry.getSnapshot().value;
      storage.getState().applySettingsLocal({ usageCoachPreferencesV1: {
        ...storage.getState().settings.usageCoachPreferencesV1, disabledChecks: [...USAGE_COACH_DETECTOR_IDS],
      } });
      // Coach preferences change admission without changing this Coach-excluded query's bytes.
      const unchanged = await executor.execute('usage.query', { queries: [accountingOnly] }, actionContext);
      expect(unchanged).toMatchObject({ ok: true });
      expect(summaryEntry.getSnapshot().value).toBe(retained);
    } finally { session.resolve(Response.json({ error: 'denied' }, { status: 403 })); releaseSummary?.(); account.dispose(); release(); }
  });

  it('keeps the accounting calendar stable while a sibling private read progresses and is refused', async () => {
    const session = createDeferred<Response>();
    const settings = settingsParse({ usageCoachPreferencesV1: { disabledChecks: [...USAGE_COACH_DETECTOR_IDS] } });
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: [workContribution] });
      if (request.path === '/v2/sessions/work-session') return session.promise;
      return undefined;
    }, undefined, settings);
    saveAccountSettings(captured.accountLifetime.scope, settings, 1);
    storage.setState({ settingsScope: captured.accountLifetime.scope, settings });
    const summary = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeActivity: true,
      includeWorkEvidence: false, includeSessionEvidence: false, includeTranscriptEvidence: false });
    const detail = normalizeUsageQuery({ ...summary, includeSessionEvidence: true });
    const publications: Awaited<ReturnType<typeof readUiUsageQueryBatch>>[] = [];
    const reading = readUiUsageQueryBatch(captured, { queries: [summary, detail] }, undefined, undefined,
      { onProgress: project => { publications.push(project()); } });
    let initial: NonNullable<Awaited<ReturnType<typeof readUiUsageQueryBatch>>['results'][number]['howYouWork']>['agentCalendar'];
    let observationReads = 0;
    try {
      await expect.poll(() => sessionRequests().some(request => request.path === '/v2/sessions/work-session')).toBe(true);
      await expect.poll(() => publications.some(batch => batch.results.find(slice => slice.key === getUsageQueryKey(summary))
        ?.howYouWork?.agentCalendar?.periodSummary.totals.tokens === 15)).toBe(true);
      initial = publications.find(batch => batch.results.find(slice => slice.key === getUsageQueryKey(summary))
        ?.howYouWork?.agentCalendar?.periodSummary.totals.tokens === 15)!.results.find(slice => slice.key === getUsageQueryKey(summary))!.howYouWork!.agentCalendar;
      const admitted = publications.at(-1)!.results.find(slice => slice.key === getUsageQueryKey(summary))!.accounting!.summary!.accountingCalendar!.value.days[0]!;
      const admittedDate = admitted.date;
      Object.defineProperty(admitted, 'date', { enumerable: true, get: () => { observationReads++; return admittedDate; } });
    } finally { session.resolve(Response.json({ error: 'denied' }, { status: 403 })); }
    const final = await reading;
    const summarySlice = final.results.find(slice => slice.key === getUsageQueryKey(summary))!;
    const detailSlice = final.results.find(slice => slice.key === getUsageQueryKey(detail))!;
    expect(summarySlice.howYouWork!.agentCalendar).toBe(initial);
    expect(observationReads, 'private-source progress must not fold the admitted accounting population again').toBe(0);
    expect(detailSlice.howYouWork!.agentCalendar!.periodSummary.totals.tokens).toBe(15);
    expect(detailSlice.howYouWork!.agentCalendar!.periodSummary.totals.busyMs).toBeNull();
    expect(summarySlice.pending).toBe(false);
    expect(UsageQueryBatchResultSchema.safeParse(final).success).toBe(true);
  });

  it('retains Work after repeated HTTP failures while batch transport refusal quarantines denial', async () => {
    let status = 200;
    let nowMs = 1000;
    let hasEvidence = true;
    const branchEvidence = { sessionId: 'work-session', turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
      branch: { ref: 'refs/heads/work', headSha: 'b'.repeat(40) } };
    const captured = await context(request => {
      if (!request.path.startsWith('/test/work/')) return undefined;
      if (status !== 200) return Response.json({ error: status === 403 ? 'denied' : 'unavailable' }, { status });
      return Response.json(ScmWorkEvidenceReadResponseSchema.parse({ sessions: [{ sessionId: 'work-session',
        status: 'partial', evidence: [], branchEvidence: hasEvidence ? [branchEvidence] : [] }] }));
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeSessionEvidence: false });
    const accounting = [{ query, value: { ...value, contributions: [workContribution] }, status: 'available' as const }];
    const read = async (previous?: ReturnType<typeof resolveUsagePageAggregation>) => {
      const work = await collectUsageWorkSources({ queries: [query], accounting, now: () => nowMs, assertCurrent: () => {
        if (!captured.accountLifetime.isCurrent()) throw new Error('retired');
      }, resolveSession: async () => ({ machineId: 'work-machine', cwd: '/repo' }), readMachine: async (_machineId, input) => {
        const response = await captured.request('/test/work/scm.workEvidence.read', { method: 'POST', body: JSON.stringify(input) });
        if (response.status >= 500) throw new RetryableServerResponseError(response.status, 'unavailable');
        if (!response.ok) throw new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN);
        return await response.json();
      } });
      return resolveUsagePageAggregation({ queries: [query], accounting, work, previous }, bundledUsageModelPriceCatalog);
    };
    const first = await read();
    expect(first.results[0]?.work?.branchAllocations[0]?.reason).toBe('allocated');
    status = 503;
    nowMs = 2000;
    let previous = first;
    for (let attempt = 0; attempt < 2; attempt++) {
      previous = await read(previous);
      expect.soft(previous.results[0]?.work?.branchAllocations[0]?.reason).toBe('allocated');
      expect.soft(previous.results[0]?.sources).toContainEqual({ source: 'work', status: 'stale', asOfMs: 1000, errorCode: 'work_evidence_failed',
        unreadSessions: { failed: 1 } });
    }
    status = 403;
    expect((await read(previous)).results[0]?.work?.branchAllocations[0]?.reason).toBe('missing_evidence');
    status = 200;
    hasEvidence = false;
    expect((await read(previous)).results[0]?.work?.branchAllocations[0]?.reason).toBe('missing_evidence');
  });
  it.each([
    { scenario: 'recovery', relative: false }, { scenario: 'empty-success', relative: false },
    { scenario: 'recovery', relative: true }, { scenario: 'empty-success', relative: true },
  ] as const)('admits only successfully acquired interval evidence: $scenario (relative: $relative)', async ({ scenario, relative }) => {
    let nowMs = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const ids = ['healthy-turns', 'retry-turns', 'empty-turns', 'unread', 'healthy-second'];
    let failedTurns = scenario === 'recovery';
    const captured = await context(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json(value);
      const detail = /^\/v2\/sessions\/(healthy-turns|retry-turns|empty-turns|unread|healthy-second)$/.exec(request.path);
      if (detail?.[1] === 'unread' && failedTurns) return Response.json({ error: 'unavailable' }, { status: 503 });
      if (detail) return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: detail[1]!,
        createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1 }) });
      const turn = /^\/v1\/sessions\/(healthy-turns|retry-turns|empty-turns|unread|healthy-second)\/turns$/.exec(request.path);
      if (turn) {
        const id = turn[1]!;
        if (id === 'retry-turns' && failedTurns) return Response.json({ error: 'unavailable' }, { status: 503 });
        return Response.json({ v: 1, sessionId: id, updatedAt: 900,
          turns: id === 'empty-turns' || id === 'unread' || id === 'retry-turns' && scenario === 'empty-success' ? [] : [
            { turnId: `${id}-turn`, agentId: 'codex', status: 'completed', startedAt: 100,
              terminalAt: id === 'retry-turns' ? 700 : 400, updatedAt: 900 },
          ] });
      }
      if (/^\/v1\/sessions\/(healthy-turns|retry-turns|empty-turns|unread|healthy-second)\/messages$/.test(request.path)) return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: Object.fromEntries(ids.map(id => [id,
      createSessionFixture({ id, seq: 1, serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' }),
    ])) });
    const query = normalizeUsageQuery({ period: relative ? { relative: 'all' } : { startMs: 0, endMs: 1000 },
      includeWorkEvidence: false, includeTranscriptEvidence: false });
    const intervalReadsFor = (id: string) => home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests)
      .filter(demand => !demand.query.includeTranscriptEvidence && (demand.sessionIds ?? ids).includes(id)).length;
    const entry = getUsageQueryResourceStore(captured)
      .getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const observed: ReturnType<typeof decodeUsageQueryResource>['results'][number][] = [];
    const slice = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    const release = entry.subscribe(() => {
      if (entry.getSnapshot().value) observed.push(slice());
    }, false);
    try {
      await entry.refresh();
      expect(slice().pending).toBe(false);
      expect(slice().howYouWork?.sessionCoverage).toEqual({ selected: 5, admitted: scenario === 'recovery' ? 3 : 5,
        notRead: scenario === 'recovery' ? 3 : 5 });
      expect(slice().coach?.sessionCoverage).toEqual(slice().howYouWork?.sessionCoverage);
      if (scenario === 'recovery') {
        expect(slice().sources).toContainEqual({ source: 'how_you_work:sessions', status: 'partial', errorCode: 'http_error' });
        expect(slice().howYouWork).toMatchObject({ detailStatus: 'partial',
          intervals: { agentTimeMs: 600 }, runLengths: { coverage: 'partial', sampleCount: 2,
            byAgent: [{ agentId: 'codex', durationsMs: [300, 300] }] } });
        expect(slice().howYouWork?.intervals?.lanes.map(lane => lane.workId).sort()).toEqual([
          '["healthy-second","healthy-second-turn"]', '["healthy-turns","healthy-turns-turn"]',
        ]);
        expect(observed.some(row => row.sources.some(source => source.source === 'how_you_work:sessions' && source.status === 'available'))).toBe(false);
        expect(observed.filter(row => row.howYouWork?.intervals).every(row => row.howYouWork?.detailStatus === 'partial')).toBe(true);
      } else {
        expect(slice().sources).toContainEqual({ source: 'how_you_work:sessions', status: 'available' });
        expect(slice().howYouWork?.intervals?.agentTimeMs).toBe(600);
      }
      const attemptsBeforeRetry = intervalReadsFor('retry-turns');
      const postsBeforeRetry = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH).length;
      failedTurns = false;
      nowMs = 2000;
      // No Session/store marker changes: Retry must reacquire only failed evidence.
      await entry.refresh();
      expect(slice().howYouWork?.intervals?.agentTimeMs).toBe(scenario === 'recovery' ? 1200 : 600);
      expect(slice().howYouWork?.sessionCoverage).toEqual({ selected: 5, admitted: 5, notRead: 5 });
      expect(slice().coach?.sessionCoverage).toEqual({ selected: 5, admitted: 5, notRead: 5 });
      expect(slice().sources).toContainEqual({ source: 'how_you_work:sessions', status: 'available' });
      expect(intervalReadsFor('healthy-turns')).toBe(1);
      expect(intervalReadsFor('retry-turns'))
        .toBe(attemptsBeforeRetry + (scenario === 'recovery' ? 1 : 0));
      const retryDemands = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
        .slice(postsBeforeRetry).flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests)
        .filter(demand => !demand.query.includeTranscriptEvidence);
      expect(retryDemands.map(demand => demand.sessionIds ? [...demand.sessionIds].sort() : undefined), 'Retry hydrates failed inputs through the retained complete cohort')
        .toEqual(scenario === 'recovery' ? [['retry-turns', 'unread']] : []);
      expect(home!.requests.filter(request => /^\/v[12]\/sessions\/(healthy-turns|retry-turns|empty-turns|unread|healthy-second)(\/|$)/.test(request.path))).toEqual([]);
    } finally { release(); }
  });

  it('reads the same witnessed intervals through projected Usage evidence without single-Session fan-out', async () => {
    const ids = ['batch-first', 'batch-second'];
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/read-batch') return Response.json({ results: ids.map(sessionId => ({
        sessionId,
        detail: { status: 200, body: { session: { ...createPlainSessionCurrentProjectionRecordFixture({ id: sessionId,
          createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1 }),
          agentState: JSON.stringify({ completedRequests: { approval: { tool: 'Bash', arguments: {},
            turnId: `${sessionId}-turn`, createdAt: 500, completedAt: 600, status: 'approved' } } }),
        } } },
        ...(request.body && typeof request.body === 'object' && 'includeMessages' in request.body && request.body.includeMessages
          ? { messages: { status: 200, body: { messages: [], hasMore: false } } } : {}),
        turns: { status: 200, body: { v: 1, sessionId, updatedAt: 900, turns: [
          { turnId: `${sessionId}-turn`, agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
        ] } },
      })) });
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: Object.fromEntries(ids.map(id => [id,
      createSessionFixture({ id, seq: 1, serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' }),
    ])) });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false, includeTranscriptEvidence: false });
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const batch = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(batch.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(600);
    expect(home!.requests.filter(request => /^\/v[12]\/sessions\/batch-(first|second)(\/|$)/.test(request.path))).toEqual([]);
    const demands = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
    expect(demands.filter(demand => !demand.query.includeTranscriptEvidence)).toHaveLength(1);
    expect(demands.filter(demand => demand.query.includeTranscriptEvidence).map(demand => demand.sessionIds)).toEqual([ids]);
    const slice = batch.results[0]!;
    expect(slice.howYouWork?.permissions).toMatchObject({ pairedDecisionCount: 2, decisionLatencyMs: 200 });
    const [{ UsageHumanLoopWidget }, { UsageParallelWidget }, { UsageCoachWidget }, { HappierDataMetric, IntervalTimeline }] = await Promise.all([
      import('@/components/settings/usage/widgets/UsageHumanLoopWidget'),
      import('@/components/settings/usage/widgets/UsageParallelWidget'),
      import('@/components/settings/usage/widgets/UsageCoachWidget'),
      import('@happier-dev/plugin-ui/presentation'),
    ]);
    const model = { requestedQuery: null, shownQuery: null, slice, pending: slice.pending, error: null,
      freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
    const props = { model, slice, query, serverId: captured.accountLifetime.scope.serverId };
    const screen = await renderScreen(React.createElement(InjectedAuthProvider, { credentials: captured.credentials,
      children: React.createElement(React.Fragment, null,
        React.createElement(UsageHumanLoopWidget, { ...props, id: 'usage_human_loop', testID: 'batch-loop' }),
        React.createElement(UsageParallelWidget, { ...props, id: 'usage_parallel', testID: 'batch-parallel', presentation: { style: 'timeline' } }),
        React.createElement(UsageCoachWidget, { ...props, id: 'usage_coach', testID: 'batch-coach' })) }));
    try {
      const metric = (testID: string) => screen.findAllByType(HappierDataMetric).find(node => node.props.testID === testID)?.props;
      expect(screen.findHostByTestId('batch-loop.loop')).not.toBeNull();
      expect(metric('batch-loop.waited')?.comparison.value).toBe('2');
      expect(screen.findHostByTestId('batch-parallel.parallel')).not.toBeNull();
      expect(metric('batch-parallel.peak')?.value).toBe(2);
      const intervals: readonly Readonly<{ pattern?: string }>[] = screen.findAllByType(IntervalTimeline)[0]?.props.intervals;
      expect(intervals.filter(interval => interval.pattern !== 'hatched')).toHaveLength(2);
      expect(intervals.filter(interval => interval.pattern === 'hatched')).toHaveLength(2);
      // Active Sessions still lack durable compact facts and remain unread history.
      expect(slice.coach?.sessionCoverage).toMatchObject({ admitted: 2, notRead: 2 });
      expect(metric('batch-coach.summary.sessions')?.value).toBe(0);
      for (const testID of ['batch-loop', 'batch-parallel', 'batch-coach']) {
        expect(screen.findHostByTestId(`${testID}.loading`)).toBeNull();
      }
    } finally { await screen.unmount(); }
  });

  it('ignores equivalent feature snapshots and updates only allowance when the consumed quota decision changes', async () => {
    let quotasEnabled = false;
    let diagnosticsEnabled = false;
    let eventCount = 1;
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
    const source = { bindingKind: 'account' as const, ref };
    const now = Date.now();
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const record = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
      staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
    const captured = await context(request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
        connectedServices: { enabled: true, quotas: { enabled: quotasEnabled } },
        browser: { diagnostics: { enabled: diagnosticsEnabled } },
      } }));
      if (request.path === '/v2/usage/query') return Response.json({ ...value, totals: { ...value.totals, eventCount } });
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({ source,
        recordId: record.recordId, providerAccountId: ref.accountId, fetchedAt: now, staleAfterMs: 600_000 });
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: record },
        metadata: { fetchedAt: now, staleAfterMs: 600_000, status: 'ok' }, sources: [source] });
      return undefined;
    }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    const serverId = captured.accountLifetime.scope.serverId;
    await getServerFeaturesSnapshot({ serverId, force: true });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
      queries: [normalizeUsageQuery({ includeSessionEvidence: false, includeWorkEvidence: false, includeComparison: false, includeQuotaHistory: false })],
    }) });
    const release = entry.subscribe(() => {}, true);
    const observed = () => entry.getSnapshot().value && decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals.eventCount;
    try {
      await entry.refresh();
      expect(observed()).toBe(1);
      eventCount = 2;
      diagnosticsEnabled = true;
      await getServerFeaturesSnapshot({ serverId, force: true });
      expect(entry.getSnapshot(), 'unrelated feature discovery must keep admitted Usage facts settled')
        .toMatchObject({ freshness: 'fresh', pending: 'idle' });
      await flushHookEffects({ cycles: 30 });
      expect(observed(), 'equivalent feature discovery must not re-arm the Usage read').toBe(1);
      quotasEnabled = true;
      await getServerFeaturesSnapshot({ serverId, force: true });
      await expect.poll(() => entry.getSnapshot().value && decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]?.current).toEqual(record);
      expect(observed(), 'enabling allowance changes no admitted accounting fact').toBe(1);
      eventCount = 3;
      quotasEnabled = false;
      await getServerFeaturesSnapshot({ serverId, force: true });
      await expect.poll(() => entry.getSnapshot().value && decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources.find(source => source.source === 'quota')?.status).toBe('unsupported');
      expect(observed(), 'disabling allowance changes no admitted accounting fact').toBe(1);
      expect(home!.requests.filter(request => request.path === '/v2/usage/query')).toHaveLength(1);
    } finally { release(); }
  });

  it('acquires no provider allowance for cold non-quota demand and preserves Capacity current reads', async () => {
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'quota-demand' };
    const source = { bindingKind: 'account' as const, ref };
    const now = Date.now();
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const record = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
      staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
    let reads = 0;
    const captured = await context(request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
        connectedServices: { enabled: true, quotas: { enabled: true } },
      } }));
      if (request.path.startsWith('/v4/connect/qualified/provider-account-usage/')) reads++;
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({ source,
        recordId: record.recordId, providerAccountId: ref.accountId, fetchedAt: now, staleAfterMs: 600_000 });
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: record },
        metadata: { fetchedAt: now, staleAfterMs: 600_000, status: 'ok' }, sources: [source] });
      return undefined;
    }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    reads = 0;
    const query = normalizeUsageQuery({ includeQuota: false, includeAccounting: false, includeQuotaHistory: false,
      includeComparison: false, includeSessionEvidence: false, includeWorkEvidence: false });
    const chart = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect.soft(reads, 'an undemanded allowance never crosses the HTTP boundary').toBe(0);
    expect(chart.results[0]?.quota).toBeUndefined();
    await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ ...query, includeQuota: true })] });
    expect(reads, 'Capacity still acquires current allowance without quota history').toBeGreaterThan(0);
  });

  it('ownership unproven withdraws previously observed quota and keeps the qualified account recoverable', async () => {
    const ref = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'team-work' };
    const source = { bindingKind: 'account' as const, ref };
    const sourceKey = `quota:${createCanonicalJsonSigningInput(source)}`;
    const now = Date.now();
    const recordKey = { providerId: 'vercel', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const snapshot = (usedPct: number, observedAtMs: number) => ProviderAccountUsageSnapshotV1Schema.parse({
      v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'vercel',
      accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs, fetchedAtMs: observedAtMs,
      staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'weekly', label: 'Weekly', usedPct, utilizationPct: usedPct, used: null, limit: null,
        unit: 'count', status: 'ok', resetsAt: now + 2 * 86_400_000, windowDurationMs: 7 * 86_400_000 }],
    });
    let record = snapshot(20, now - 1000);
    let ownershipProven = true;
    const captured = await context(request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
        connectedServices: { enabled: true, quotas: { enabled: true } },
      } }));
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        return ownershipProven
          ? Response.json({ source, recordId: record.recordId, providerAccountId: ref.accountId,
            fetchedAt: record.fetchedAtMs, staleAfterMs: record.staleAfterMs })
          : Response.json({ error: 'ownership_unproven' }, { status: 409 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({
        content: { t: 'plain', v: record }, metadata: { fetchedAt: record.fetchedAtMs, staleAfterMs: record.staleAfterMs, status: 'ok' },
        sources: [source],
      });
      return undefined;
    }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'token', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    const query = normalizeUsageQuery({ includeQuota: true, includeAccounting: false, includeQuotaHistory: false,
      includeComparison: false, includeSessionEvidence: false, includeWorkEvidence: false });
    const input = { queries: [query] };
    const { installConnectedAccountDescriptorProjection, retireConnectedAccountDescriptorProjection } =
      await import('@/sync/domains/connectedServices/connectedServiceRegistry');
    installConnectedAccountDescriptorProjection({ scopeKey: 'usage-ownership', status: 'ready', conflicts: [], errorReason: null,
      descriptors: [{ id: ref.service.localId, serviceId: ref.service.localId, pluginId: ref.service.pluginId,
        title: 'Vercel', provenance: 'external', sourceKind: 'installed',
        authentication: { defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] },
        capabilities: ['usage'], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }],
    }, captured.accountLifetime);
    try {
      const warm = await readUiUsageQueryBatch(captured, input);
      expect(warm.results[0]?.quota?.[0]?.current?.meters[0]?.usedPct).toBe(20);

      ownershipProven = false;
      const refused = await readUiUsageQueryBatch(captured, input, undefined, warm);
      const refusedSlice = refused.results[0]!;
      expect.soft(refusedSlice.sources.find(state => state.source === sourceKey)).toEqual({
        source: sourceKey, status: 'error', errorCode: 'ownership_unproven',
      });
      expect.soft(refusedSlice.quota).toBeUndefined();
      const projection = projectUsagePlans(refusedSlice.quota, now, refusedSlice.pools, refusedSlice.sources);
      expect.soft(projection.accounts).toMatchObject([{ accountId: ref.accountId, read: null, windows: [], observedAtMs: null }]);
      expect.soft(projection.tightest).toBeNull();

      record = snapshot(45, now);
      ownershipProven = true;
      const recovered = await readUiUsageQueryBatch(captured, input, undefined, refused);
      expect(recovered.results[0]?.sources.find(state => state.source === sourceKey)).toMatchObject({ status: 'available' });
      expect(recovered.results[0]?.quota?.[0]?.current?.meters[0]?.usedPct).toBe(45);
    } finally {
      retireConnectedAccountDescriptorProjection(captured.accountLifetime);
    }
  });

  it('keeps quota-free Resource demand quiet beside a live mixed allowance consumer', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'watched-quota-demand' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    let usedPct = 20;
    let enteredPrice = 17;
    let quotasEnabled = true;
    let heldQuota: ReturnType<typeof createDeferred<void>> | undefined;
    const readRecord = () => ProviderAccountUsageSnapshotV1Schema.parse({ v: 1,
      recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'codex',
      accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
      staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'weekly', label: 'Weekly', usedPct, utilizationPct: usedPct, used: null, limit: null,
        unit: 'count', status: 'ok', resetsAt: now + 3_600_000, windowDurationMs: 7 * 86_400_000 }],
      subscription: { status: 'subscribed', renewal: 'on', observedAtMs: now, staleAfterMs: 600_000,
        currentPeriodStartAtMs: now - 86_400_000, currentPeriodEndAtMs: now + 86_400_000 } });
    const captured = await context(async request => {
      if (request.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1) return Response.json(ConnectedPresentationRowReadResponseV1Schema.parse({
        status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [{ v: 1, label: '',
          subject: { kind: 'account', account: ref }, subscriptionMonthlyPrice: { amount: enteredPrice, currency: 'USD', enteredAtMs: now } }] } },
      }));
      if (request.path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1) return Response.json(ConnectedAcknowledgementsRowReadResponseV1Schema.parse({ status: 'deleted', revision: 1 }));
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
        connectedServices: { enabled: true, quotas: { enabled: quotasEnabled } },
      } }));
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        await heldQuota?.promise;
        return Response.json({ source, recordId: readRecord().recordId, providerAccountId: ref.accountId,
          fetchedAt: now, staleAfterMs: 600_000 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({
        content: { t: 'plain', v: readRecord() }, metadata: { fetchedAt: now, staleAfterMs: 600_000, status: 'ok' }, sources: [source] });
      return undefined;
    }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    const query = normalizeUsageQuery({ includeQuota: false, includeAccounting: false, includeQuotaHistory: false,
      includeComparison: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const store = getUsageQueryResourceStore(captured);
    const quotaFree = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    // Undefined retains legacy allowance demand, including beside an opt-out slice.
    const mixed = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
      queries: [query, normalizeUsageQuery({ ...query, includeQuota: undefined })],
    }) });
    let publications = 0;
    const beforeQuotaFree = home!.requests.length;
    const releaseQuotaFree = quotaFree.subscribe(() => { publications++; }, true);
    let releaseMixed = () => {};
    const mixedSlice = () => mixed.getSnapshot().value && decodeUsageQueryResource(mixed.getSnapshot().value!).results[1];
    try {
      await quotaFree.refresh();
      await expect.poll(() => quotaFree.getSnapshot().subscription === 'live' && quotaFree.getSnapshot().pending === 'idle').toBe(true);
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, [CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1], { changeKinds: ['account'] });
      await flushHookEffects({ cycles: 20 });
      expect.soft(home!.requests.slice(beforeQuotaFree).filter(request => request.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1
        || request.path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1), 'quota-free demand never activates a subscription-price catalog reader').toHaveLength(0);
      releaseMixed = mixed.subscribe(() => {}, true);
      await Promise.all([quotaFree.refresh(), mixed.refresh()]);
      await expect.poll(() => quotaFree.getSnapshot().subscription === 'live' && mixed.getSnapshot().subscription === 'live'
        && quotaFree.getSnapshot().pending === 'idle' && mixed.getSnapshot().pending === 'idle').toBe(true);
      await flushHookEffects({ cycles: 20 });
      expect(mixedSlice()?.quota?.[0]?.current?.meters[0]?.usedPct).toBe(20);
      const retained = quotaFree.getSnapshot().value;
      publications = 0;
      heldQuota = createDeferred<void>();
      usedPct = 50;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['provider-account-usage'], {
        changeKinds: ['account'], usageQueryAffects: true, usageAccountingAffects: false,
      });
      expect.soft(quotaFree.isAllowanceReadPending(), 'an opt-out never presents allowance acquisition').toBe(false);
      expect.soft(quotaFree.getSnapshot(), 'quota-only arrivals keep an opt-out settled').toMatchObject({ pending: 'idle', freshness: 'fresh' });
      await expect.poll(() => mixed.isAllowanceReadPending()).toBe(true);
      heldQuota.resolve();
      heldQuota = undefined;
      await expect.poll(() => mixedSlice()?.quota?.[0]?.current?.meters[0]?.usedPct).toBe(50);
      await expect.poll(() => quotaFree.getSnapshot().pending === 'idle' && mixed.getSnapshot().pending === 'idle').toBe(true);
      await flushHookEffects({ cycles: 20 });
      expect.soft(publications, 'quota-only Home changes publish nothing to a quota-free consumer').toBe(0);
      expect.soft(quotaFree.getSnapshot().value).toBe(retained);
      enteredPrice = 29;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, [CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1], { changeKinds: ['account'] });
      await expect.poll(() => mixedSlice()?.quota?.[0]?.current?.subscription?.enteredMonthlyPrice?.amount).toBe(29);
      await expect.poll(() => mixed.getSnapshot().pending).toBe('idle');
      await flushHookEffects({ cycles: 20 });
      expect.soft(publications, 'entered allowance prices publish nothing to a quota-free consumer').toBe(0);
      expect.soft(quotaFree.getSnapshot().value).toBe(retained);
      quotasEnabled = false;
      await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
      await expect.poll(() => mixedSlice()?.sources.find(state => state.source === 'quota')?.status).toBe('unsupported');
      await expect.poll(() => mixed.getSnapshot().pending).toBe('idle');
      await flushHookEffects({ cycles: 20 });
      expect.soft(publications, 'quota-input changes publish nothing to a quota-free consumer').toBe(0);
      expect.soft(quotaFree.getSnapshot().value).toBe(retained);
      const refreshing = quotaFree.refresh();
      expect.soft(quotaFree.isAllowanceReadPending(), 'explicit refresh preserves the query allowance opt-out').toBe(false);
      await refreshing;
      expect(quotaFree.getSnapshot().error).toBeUndefined();
      expect(decodeUsageQueryResource(quotaFree.getSnapshot().value!).results[0]?.quota).toBeUndefined();
      expect(home!.requests.filter(request => request.path === '/v2/usage/query'), 'neither no-accounting consumer acquires accounting').toHaveLength(0);
    } finally { heldQuota?.resolve(); releaseQuotaFree(); releaseMixed(); }
  });

  it('reopens quota-free accounting without work after a quota-only Home arrival', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    const query = normalizeUsageQuery({ includeQuota: false, includeQuotaHistory: false, includeComparison: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    let release = entry.subscribe(() => {}, true);
    const settle = async () => {
      await expect.poll(() => entry.getSnapshot().subscription === 'live' && entry.getSnapshot().pending === 'idle'
        && entry.getSnapshot().value !== undefined).toBe(true);
      await flushHookEffects({ cycles: 20 });
    };
    try {
      await settle();
      const retained = entry.getSnapshot().value!;
      const tokens = decodeUsageQueryResource(retained).results[0]!.accounting!.totals.tokens;
      let factReads = 0;
      Object.defineProperty(tokens, 'total', { configurable: true, get() { factReads++; return 15; } });
      const reads = home!.requests.length;
      release();
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['provider-account-usage'], {
        changeKinds: ['account'], usageQueryAffects: true, usageAccountingAffects: false,
      });
      release = entry.subscribe(() => {}, true);
      await settle();
      expect.soft(entry.getSnapshot().value, 'unconsumed allowance changes retain the settled accounting projection').toBe(retained);
      expect.soft(home!.requests.slice(reads).map(request => request.path), 'reopening does not acquire any unconsumed replacement').toEqual([]);
      expect.soft(factReads, 'reopening does not walk or serialize unchanged admitted accounting').toBe(0);
      expect(entry.isAllowanceReadPending()).toBe(false);
    } finally { release(); }
  });

  it('keeps quota-free Resource demand quiet when an unused pool selector Machine recovers', async () => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const captured = await context(() => undefined, {
      connectedAccountGroupsV4: [QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'unused-pool' },
        incarnation: 'incarnation', displayName: 'Unused pool', policy: { strategy: 'priority' }, activeConnectedAccountId: 'work',
        generation: 1, runtimeStateRevision: 1, state: {}, createdAt: 1, updatedAt: 1,
        members: [{ v: 1, connectedAccountId: 'work', priority: 1, enabled: true, state: {}, createdAt: 1, updatedAt: 1 }] })],
    });
    const scope = captured.accountLifetime.scope;
    const machine = createMachineFixture({ id: 'unused-selector', active: false, activeAt: 1, presenceProtocolVersion: 1 });
    storage.getState().applyMachines([machine]);
    const query = normalizeUsageQuery({ includeQuota: false, includeAccounting: false, includeQuotaHistory: false,
      includeComparison: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    let publications = 0;
    const release = entry.subscribe(() => { publications++; }, true);
    try {
      await entry.refresh();
      await expect.poll(() => entry.getSnapshot().subscription === 'live' && entry.getSnapshot().pending === 'idle').toBe(true);
      await flushHookEffects({ cycles: 20 });
      const retained = entry.getSnapshot().value;
      publications = 0;
      storage.getState().applyMachines([{ ...machine, active: true, activeAt: Date.now() }]);
      observeMachinePresenceForTest(scope, [machine.id]);
      await flushHookEffects({ cycles: 20 });
      expect.soft(publications, 'an unconsumed pool selector has no Resource publication').toBe(0);
      expect.soft(entry.getSnapshot()).toMatchObject({ pending: 'idle', freshness: 'fresh' });
      expect.soft(entry.getSnapshot().value).toBe(retained);
      expect.soft(entry.isAllowanceReadPending()).toBe(false);
      expect(home!.requests.filter(request => request.path.startsWith('/v4/connect/qualified/provider-account-usage/'))).toHaveLength(0);
    } finally { release(); }
  });

  it('reconciles consumed Machine recovery before a closed Action reuses offline Work', async () => {
    let daemonReachable = false;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value,
        contributions: [workContribution, { ...workContribution, id: 'sibling-cost', sessionId: 'work-sibling' }] });
      return createPlainMachineReadHttpResponseFixture(request.path, {
        method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      }, 'account-a', { active: daemonReachable, activeAt: daemonReachable ? Date.now() : 1, presenceProtocolVersion: 1 }) ?? undefined;
    });
    const scope = captured.accountLifetime.scope;
    const machine = createHydratedPlainMachineFixture({ id: 'work-machine', accountId: 'account-a', machine: { active: false, activeAt: 1, presenceProtocolVersion: 1 } });
    const unrelated = createHydratedPlainMachineFixture({ id: 'unconsumed-machine', accountId: 'account-a', machine: { active: false, activeAt: 1, presenceProtocolVersion: 1 } });
    await publishMachineInventoryForTest(scope, [machine, unrelated]);
    storage.getState().applySessions(['work-session', 'work-sibling'].map(id => createSessionFixture({ id, active: true, serverId: scope.serverId,
      metadata: { machineId: machine.id, path: '/repo', host: 'test', homeDir: '/home/test' } })));
    const witness: UsageWorkEvidence = { sessionId: 'work-session', turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
      pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
        nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } }, number: 1, title: 'Merged',
        url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'merged' } };
    scmTransport.mockImplementation(async request => ScmWorkEvidenceReadResponseSchema.parse({
      sessions: request.payload.sessions.map(({ sessionId }: { sessionId: string }) => ({
        sessionId, status: 'partial', evidence: [{ ...witness, sessionId }], branchEvidence: [], pullRequestsRead: true,
      })),
    }));
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeQuota: false, includeQuotaHistory: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: true, workProjection: 'summary', includeComparison: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const account = await captureLazyActionAccountContext(scope.serverId);
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
    const accountingOnly = normalizeUsageQuery({ ...query, includeWorkEvidence: false, includeCoach: false });
    const read = async (selected = query) => {
      const response = await executor.execute('usage.query', { queries: [selected] }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, usageQueryReadiness: 'public_profile' });
      expect(response).toMatchObject({ ok: true });
      if (!response.ok) throw new Error(response.errorCode);
      return UsageQueryBatchResultSchema.parse(response.result).results[0]!;
    };
    const accountingReads = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch').length;
    let release = entry.subscribe(() => {}, true);
    try {
      await entry.refresh({ supersede: false });
      await expect.poll(() => entry.getSnapshot().subscription === 'live' && entry.getSnapshot().pending === 'idle').toBe(true);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources).toContainEqual(expect.objectContaining({ source: 'work', errorCode: 'machine_offline' }));
      expect(scmTransport).not.toHaveBeenCalled();
      release(); release = () => {};
      await read(accountingOnly);
      const beforeAccounting = accountingReads();
      await publishMachineInventoryForTest(scope, [machine, createHydratedPlainMachineFixture({ id: unrelated.id, accountId: 'account-a',
        machine: { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 } })]);
      clearMachineRequestReachabilityForMachine(scope, unrelated.id);
      expect((await read()).workSummary?.mergedPrCount).toBeUndefined();
      expect(scmTransport, 'unconsumed Machine recovery does not acquire Work').not.toHaveBeenCalled();
      daemonReachable = true;
      await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({ id: machine.id, accountId: 'account-a',
        machine: { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 } }), storage.getState().machines[unrelated.id]!]);
      clearMachineRequestReachabilityForMachine(scope, machine.id);
      // Another closed query can reconcile global state first; this Work admission owns its consumed basis.
      await read(accountingOnly);
      const recovered = await read();
      expect(recovered.workSummary?.mergedPrCount, 'closed static admission consumes the authenticated Machine recovery').toBe(1);
      expect(scmTransport, 'one recovered Machine batches its two admitted Session selectors').toHaveBeenCalledTimes(1);
      expect(scmTransport.mock.calls[0]?.[0].payload.sessions.map((session: { sessionId: string }) => session.sessionId).sort())
        .toEqual(['work-session', 'work-sibling']);
      expect(accountingReads(), 'Machine recovery reuses the admitted accounting answer').toBe(beforeAccounting);
      expect((await read()).workSummary?.mergedPrCount).toBe(1);
      expect(scmTransport, 'unchanged closed return acquires no additional Work').toHaveBeenCalledTimes(1);
      expect(accountingReads(), 'unchanged closed return posts no accounting query').toBe(beforeAccounting);
    } finally { release(); account.dispose(); }
  });

  it.each([
    { change: 'a new workspace on the same Machine', nextPaths: ['/repo/third', '/repo/second'] },
    { change: 'two Sessions swapping workspaces with the same Machine set', nextPaths: ['/repo/second', '/repo/first'] },
    { change: 'rebatching Work after a workspace move', nextPaths: ['/repo/third', '/repo/second'], rebatch: true },
  ])('reconciles $change before the closed Action reuses Work', async ({ nextPaths, rebatch }) => {
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value,
        contributions: [workContribution, { ...workContribution, id: 'sibling-cost', sessionId: 'work-sibling' }] });
      return createPlainMachineReadHttpResponseFixture(request.path, {
        method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      }, 'account-a', { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 }) ?? undefined;
    });
    const scope = captured.accountLifetime.scope;
    const machine = createHydratedPlainMachineFixture({ id: 'work-machine', accountId: 'account-a',
      machine: { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 } });
    await publishMachineInventoryForTest(scope, [machine]);
    const sessionIds = ['work-session', 'work-sibling'];
    const originalPaths = ['/repo/first', '/repo/second'];
    const applyPaths = (paths: readonly string[], metadataVersion: number) => storage.getState().applySessions(
      sessionIds.map((id, index) => createSessionFixture({ id, active: true, serverId: scope.serverId, metadataVersion,
        metadata: { machineId: machine.id, path: paths[index]!, host: 'test', homeDir: '/home/test' } })));
    applyPaths(originalPaths, 1);
    const branchFor = (path: string) => `refs/heads/${path.split('/').at(-1)}`;
    const held = createDeferred<void>();
    let replacementIssued = false;
    scmTransport.mockImplementation(async ({ payload }: { payload: ScmWorkEvidenceReadRequest }) => {
      if (rebatch && payload.sessions.some(row => row.cwd === nextPaths[0])) {
        replacementIssued = true;
        await held.promise;
      }
      return ScmWorkEvidenceReadResponseSchema.parse({
        sessions: payload.sessions.map(({ sessionId, cwd, turnIds }) => ({
          sessionId, status: 'partial', evidence: [{
            sessionId, turnId: turnIds[0], repositoryKey: cwd, checkpointRef: 'checkpoint',
            checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
            attributionScope: 'no_happier_checkpoint_overlap_observed',
            pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
              nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
              number: 1, title: 'Merged', url: 'https://github.com/owner/repo/pull/1',
              baseBranch: 'main', headBranch: 'feature', state: 'merged' },
          }], branchEvidence: [{ sessionId, turnId: turnIds[0], repositoryKey: cwd,
            checkpointRef: 'checkpoint', checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
            attributionScope: 'no_happier_checkpoint_overlap_observed',
            branch: { ref: branchFor(cwd), headSha: 'b'.repeat(40) } }],
        })),
      });
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeQuota: false, includeQuotaHistory: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: true, includeCoach: false,
      workProjection: 'detail', includeComparison: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const account = await captureLazyActionAccountContext(scope.serverId);
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
    const read = async (queries = [query], waitForWork = true) => {
      const response = await executor.execute('usage.query', { queries },
        { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
          ...(waitForWork ? { usageQueryReadiness: 'public_profile' as const } : {}) });
      if (!response.ok) throw new Error(response.errorCode);
      const results = UsageQueryBatchResultSchema.parse(response.result).results;
      return results.find(slice => slice.requestedQuery.includeWorkEvidence) ?? results[0]!;
    };
    const branches = (slice: Awaited<ReturnType<typeof read>>) => sessionIds.map(id =>
      slice.work?.branchAllocations.find((_, index) =>
        slice.accounting?.contributions?.[index]?.sessionId === id)?.branch?.branch.ref);
    const accountingReads = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch').length;
    let release = entry.subscribe(() => {}, true);
    try {
      await entry.refresh({ supersede: false });
      await expect.poll(() => entry.getSnapshot().subscription === 'live' && entry.getSnapshot().pending === 'idle').toBe(true);
      expect(branches(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!)).toEqual(originalPaths.map(branchFor));
      release(); release = () => {};
      expect(branches(await read())).toEqual(originalPaths.map(branchFor));
      expect(scmTransport, 'unchanged Work targets reuse the closed admission').toHaveBeenCalledTimes(1);
      const beforeAccounting = accountingReads();
      if (rebatch) {
        const warm = await read();
        expect(warm.work?.outcomes.length).toBeGreaterThan(0);
        const sibling = normalizeUsageQuery({ ...query, session: 'work-sibling', includeWorkEvidence: false });
        expect((await read([sibling])).accounting).toBeDefined();
        applyPaths(nextPaths, 2);
        const rebatchEntry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
          input: projectNativeJsonValueForTransport({ queries: [query, sibling] }) });
        // Keep the finite SCM read visible after the Action returns its accounting-ready snapshot.
        // This static observation starts no live Usage view or watch.
        const stop = rebatchEntry.subscribe(() => {}, false);
        try {
          const current = await read([query, sibling], false);
          expect(current.accounting?.totals.tokens.total).toBe(15);
          expect.soft(branches(current), 'old workspace branch is absent while replacement Work is held')
            .toEqual([undefined, undefined]);
          expect.soft(current.work?.outcomes ?? [], 'old workspace PR outcome is absent while replacement Work is held')
            .toEqual([]);
          expect.soft(current.workSummary?.mergedPrCount ?? 0, 'the old workspace PR contributes no totals').toBe(0);
          expect(current.sources).toContainEqual(expect.objectContaining({ source: 'work', status: 'pending' }));
          await expect.poll(() => replacementIssued).toBe(true);
        } finally { stop(); }
        return;
      }
      applyPaths(nextPaths, 2);
      expect(branches(await read()), 'closed Action attributes Work to each changed Session workspace').toEqual(nextPaths.map(branchFor));
      expect(branches(await read())).toEqual(nextPaths.map(branchFor));
      expect(scmTransport, 'only the changed target basis reads Work again').toHaveBeenCalledTimes(2);
      expect(accountingReads(), 'changing only Work targets reuses accounting').toBe(beforeAccounting);
    } finally { held.resolve(); release(); account.dispose(); }
  });

  it.each([false, true])('refreshes only Work after an authenticated Machine reconnect (quota: %s)', async includeQuota => {
    let daemonReachable = false;
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'unrelated-allowance' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const now = Date.now();
    const record = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
      staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'weekly', label: 'Weekly', usedPct: 40, utilizationPct: 40, used: null, limit: null, unit: 'count', status: 'ok',
        resetsAt: now + 3_600_000, windowDurationMs: 7 * 86_400_000 }] });
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value,
        contributions: [workContribution, { ...workContribution, id: 'sibling-cost', sessionId: 'work-sibling' }] });
      if (request.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1) return Response.json(ConnectedPresentationRowReadResponseV1Schema.parse({ status: 'deleted', revision: 1 }));
      if (request.path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1) return Response.json(ConnectedAcknowledgementsRowReadResponseV1Schema.parse({ status: 'deleted', revision: 1 }));
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({
        source, recordId: record.recordId, providerAccountId: ref.accountId, fetchedAt: record.fetchedAtMs, staleAfterMs: 600_000 });
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: record },
        metadata: { fetchedAt: record.fetchedAtMs, staleAfterMs: 600_000, status: 'ok' }, sources: [source] });
      return createPlainMachineReadHttpResponseFixture(request.path, {
        method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      }, 'account-a', { active: daemonReachable, activeAt: daemonReachable ? Date.now() : 1, presenceProtocolVersion: 1 }) ?? undefined;
    }, { connectedAccountsV4: includeQuota ? [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] : [] });
    const scope = captured.accountLifetime.scope;
    const machine = createHydratedPlainMachineFixture({ id: 'work-machine', accountId: 'account-a', machine: { active: false, activeAt: 1, presenceProtocolVersion: 1 } });
    await publishMachineInventoryForTest(scope, [machine]);
    storage.getState().applySessions(['work-session', 'work-sibling'].map(id => createSessionFixture({ id, active: true, serverId: scope.serverId,
      metadata: { machineId: machine.id, path: '/repo', host: 'test', homeDir: '/home/test' } })));
    const witness: UsageWorkEvidence = { sessionId: 'work-session', turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
      pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
        nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } }, number: 1, title: 'Merged',
        url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'merged' } };
    scmTransport.mockImplementation(async request => {
      // Count the actual SocketRPC CALL boundary. Pushed offline presence
      // should prevent this call; authenticated recovery supplies witnesses.
      if (!daemonReachable) throw createRpcCallError({
        error: 'Machine unavailable', errorCode: 'target_unavailable',
      });
      return ScmWorkEvidenceReadResponseSchema.parse({ sessions: request.payload.sessions.map(({ sessionId }: { sessionId: string }) => ({
        sessionId, status: 'partial', evidence: [{ ...witness, sessionId }], branchEvidence: [], pullRequestsRead: true,
      })) });
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeQuota, includeQuotaHistory: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: true, workProjection: 'summary', includeComparison: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    const slice = () => entry.getSnapshot().value && decodeUsageQueryResource(entry.getSnapshot().value!).results[0];
    const work = () => slice()?.workSummary;
    const allowanceRequests = () => home!.requests.filter(request => request.path.startsWith('/v4/connect/qualified/provider-account-usage/'));
    try {
      await entry.refresh();
      await expect.poll(() => entry.getSnapshot().subscription === 'live' && entry.getSnapshot().pending === 'idle').toBe(true);
      expect(work()?.mergedPrCount).toBeUndefined();
      expect.soft(scmTransport, 'an answered offline Machine receives zero automatic Work RPCs').not.toHaveBeenCalled();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources).toContainEqual(expect.objectContaining({
        source: 'work', status: 'unknown', errorCode: 'machine_offline', unreadSessions: { machine_unavailable: 2 },
      }));
      if (includeQuota) expect(slice()?.quota?.[0]?.current?.meters[0]?.usedPct).toBe(40);
      const quotaReads = allowanceRequests().length;
      if (includeQuota) expect(quotaReads).toBeGreaterThan(0);
      const accountingReads = home!.requests.filter(request => request.path === '/v2/usage/query').length;
      scmTransport.mockClear();
      daemonReachable = true;
      await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({ id: machine.id, accountId: 'account-a',
        machine: { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 } })]);
      // Presence does not retire a failed request; the authenticated reconnect does.
      clearMachineRequestReachabilityForMachine(scope, machine.id);
      expect.soft(entry.isAllowanceReadPending(), 'Work Machine recovery leaves allowance settled').toBe(false);
      await expect.poll(() => work()?.mergedPrCount).toBe(1);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(scmTransport, 'one recovered Machine carries both admitted Session selectors in one batch').toHaveBeenCalledTimes(1);
      expect(scmTransport.mock.calls[0]?.[0].payload.sessions.map((session: { sessionId: string }) => session.sessionId).sort())
        .toEqual(['work-session', 'work-sibling']);
      expect(home!.requests.filter(request => request.path === '/v2/usage/query'), 'Machine recovery keeps admitted accounting').toHaveLength(accountingReads);
      expect.soft(allowanceRequests(), 'Work Machine recovery leaves an unrelated account allowance admitted').toHaveLength(quotaReads);
      if (includeQuota) expect(slice()?.quota?.[0]?.current?.meters[0]?.usedPct).toBe(40);
    } finally { release(); }
  });

  it.each([false, true])('reopens settled Usage facts without walking or republishing them, and refreshes a change received while closed (quota: %s)', async connected => {
    let now = Date.UTC(2026, 10, 1, 12);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let eventCount = 1;
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'warm-reopen' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const record = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
      staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'weekly', label: 'Weekly', usedPct: 40, utilizationPct: 40, used: null, limit: null, unit: 'count', status: 'ok',
        resetsAt: now + 3_600_000, windowDurationMs: 7 * 86_400_000 }] });
    const captured = await context(request => {
      // Versioned empty catalogs are settled authority; an absent legacy row
      // would still require its own first-use migration/recovery on reopen.
      if (request.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1) return Response.json(ConnectedPresentationRowReadResponseV1Schema.parse({ status: 'deleted', revision: 1 }));
      if (request.path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1) return Response.json(ConnectedAcknowledgementsRowReadResponseV1Schema.parse({ status: 'deleted', revision: 1 }));
      if (request.path === '/v2/usage/query') return Response.json({ ...value, totals: { ...value.totals, eventCount } });
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({
        source, recordId: record.recordId, providerAccountId: ref.accountId, fetchedAt: record.fetchedAtMs, staleAfterMs: 600_000 });
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: record },
        metadata: { fetchedAt: record.fetchedAtMs, staleAfterMs: 600_000, status: 'ok' }, sources: [source] });
      return undefined;
    }, { connectedAccountsV4: connected ? [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] : [] });
    const query = normalizeUsageQuery({ period: { relative: '7days' }, includeSessionEvidence: false,
      includeWorkEvidence: false, includeComparison: false, includeQuotaHistory: false,
      includeActivity: false, includeModelTimeline: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const settle = async () => {
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entry.getSnapshot().value !== undefined && entry.getSnapshot().pending === 'idle').toBe(true);
      expect(entry.getSnapshot().error).toBeUndefined();
    };
    let release = entry.subscribe(() => {}, true);
    try {
      await settle(); release();
      const retained = entry.getSnapshot().value!;
      const tokens = decodeUsageQueryResource(retained).results[0]!.accounting!.totals.tokens;
      let factReads = 0;
      Object.defineProperty(tokens, 'total', { configurable: true, get() { factReads++; return 15; } });
      const initialPosts = home!.requests.filter(row => row.path === '/v2/usage/query').length;
      const initialHttpReads = home!.requests.length;
      for (let navigation = 0; navigation < 3; navigation++) {
        release = entry.subscribe(() => {}, true);
        await settle(); release();
        expect(entry.getSnapshot().value).toBe(retained);
      }
      expect(home!.requests.filter(row => row.path === '/v2/usage/query')).toHaveLength(initialPosts);
      expect(home!.requests.slice(initialHttpReads).map(request => request.path),
        'unchanged warm demand must not issue any HTTP reads').toEqual([]);
      expect(factReads, 'reopening an unchanged entry must consume its admitted bytes without walking its facts').toBe(0);
      eventCount = 2;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, [], { usageAccountingChange: { sessionId: null } });
      release = entry.subscribe(() => {}, true);
      await settle();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.accounting!.totals.eventCount).toBe(2);
      expect(home!.requests.filter(row => row.path === '/v2/usage/query')).toHaveLength(initialPosts + 1);
      if (connected) {
        const quota = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
        expect(quota().quota?.[0]?.pace[0]?.value.status).toBe('available');
        release();
        now += 600_001;
        release = entry.subscribe(() => {}, true);
        await settle();
        expect(quota().sources.find(state => state.source.startsWith('quota:'))?.status).toBe('stale');
        expect(quota().quota?.[0]?.pace[0]?.value.status, 'stale observations retain witnessed pace until the window ends').toBe('available');
        release();
        now += 3_000_000;
        release = entry.subscribe(() => {}, true);
        await settle();
        expect(quota().quota?.[0]?.pace[0]?.value.status, 'a closed view must not retain pre-reset pace after the window ends').toBe('unavailable');
        expect(home!.requests.filter(row => row.path === '/v2/usage/query'), 'quota aging must preserve admitted accounting').toHaveLength(initialPosts + 1);
      }
      release();
      now += 86_400_000;
      eventCount = 3;
      release = entry.subscribe(() => {}, true);
      await settle();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.accounting!.totals.eventCount).toBe(3);
      expect(home!.requests.filter(row => row.path === '/v2/usage/query')).toHaveLength(initialPosts + 2);
      release();
      eventCount = 4;
      const { invalidateAccountEncryptionModeCache } = await import('./apiAccountEncryptionMode');
      invalidateAccountEncryptionModeCache({ serverId: captured.accountLifetime.scope.serverId });
      release = entry.subscribe(() => {}, true);
      await settle();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.accounting!.totals.eventCount,
        'a withdrawal while closed must reach the existing Account admission').toBe(4);
      expect(home!.requests.filter(row => row.path === '/v2/usage/query')).toHaveLength(initialPosts + 3);
    } finally { release(); }
  });

  it('revisits the same resolved accounting demand without reads when only its presentation changes after an unrelated push', async () => {
    let now = Date.UTC(2026, 10, 12, 12);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    const query = normalizeUsageQuery({ period: { relative: '7days' }, session: 'retained-session',
      includeQuota: false, includeQuotaHistory: false, includeComparison: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
      includeActivity: false, includeModelTimeline: false });
    const store = getUsageQueryResourceStore(captured);
    const reads = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch').length;
    const visit = async (selected: typeof query) => {
      const entry = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [selected] }) });
      const release = entry.subscribe(() => {}, true);
      try {
        await flushHookEffects({ cycles: 20 });
        await expect.poll(() => entry.getSnapshot().value !== undefined && entry.getSnapshot().pending === 'idle').toBe(true);
        expect(entry.getSnapshot().error).toBeUndefined();
        return decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      } finally { release(); }
    };
    const first = await visit(query);
    expect(reads()).toBe(1);
    now += 1500;
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['other-session'], {
      changeKinds: ['session'], usageAccountingChange: { sessionId: 'other-session' },
    });
    const reopened = await visit(query);
    expect(reopened.accounting).toEqual(first.accounting);
    expect.soft(reads(), 'Reopening the same resolved request makes zero new accounting reads').toBe(1);
    for (const metric of ['cost', 'sessions', 'busy'] as const) {
      const presented = await visit(normalizeUsageQuery({ ...query, metric }));
      expect(presented.accounting).toEqual(first.accounting);
      expect.soft(reads(), 'Presentation-only metric changes retain the same accounting admission and instant').toBe(1);
    }
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['retained-session'], {
      changeKinds: ['session'], usageAccountingChange: { sessionId: 'retained-session' },
    });
    await visit(normalizeUsageQuery({ ...query, metric: 'cost' }));
    expect(reads(), 'A relevant accounting change still replaces the retained answer').toBe(2);
  });

  it('reuses accounting across Usage views with connected quota history until accounting changes or refresh is requested', async () => {
    let now = 1_900_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let eventCount = 1;
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'view-switch' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    let record = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
      staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
    const captured = await context(request => {
      if (request.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1) return Response.json(ConnectedPresentationRowReadResponseV1Schema.parse({ status: 'deleted', revision: 1 }));
      if (request.path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1) return Response.json(ConnectedAcknowledgementsRowReadResponseV1Schema.parse({ status: 'deleted', revision: 1 }));
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') return Response.json({ ...value, totals: { ...value.totals, eventCount } });
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({
        source, recordId: record.recordId, providerAccountId: ref.accountId, fetchedAt: record.fetchedAtMs, staleAfterMs: 600_000 });
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: record },
        metadata: { fetchedAt: record.fetchedAtMs, staleAfterMs: 600_000, status: 'ok' }, sources: [source] });
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') return Response.json({ entries: [], nextCursor: null });
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const query = normalizeUsageQuery({ period: { relative: '30days' }, includeSessionEvidence: false, includeWorkEvidence: false,
      includeActivity: false, includeModelTimeline: false });
    const sibling = normalizeUsageQuery({ ...query, includeTranscriptEvidence: !query.includeTranscriptEvidence });
    const store = getUsageQueryResourceStore(captured);
    const entryFor = (queries: readonly ReturnType<typeof normalizeUsageQuery>[]) => store.getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries }) });
    const posts = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
    const releases: (() => void)[] = [];
    const settle = async (entry: ReturnType<typeof entryFor>) => {
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entry.getSnapshot().value !== undefined && entry.getSnapshot().pending === 'idle').toBe(true);
      expect(entry.getSnapshot().error).toBeUndefined();
    };
    const observed = (entry: ReturnType<typeof entryFor>) => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    const initial = entryFor([query]);
    releases.push(initial.subscribe(() => {}, true));
    try {
      await settle(initial);
      expect(observed(initial).quota?.[0]?.current).toEqual(record);
      expect(observed(initial).quota?.[0]?.pageFacts?.historyStatus).toBe('complete');
      const initialReads = posts();
      expect(initialReads).toBe(2);
      const allowanceReads = () => home!.requests.filter(request =>
        request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve'
        || request.path === '/v4/connect/qualified/provider-account-usage/record').length;
      const settledAllowanceReads = allowanceReads();
      for (let index = 0; index < 20; index++) {
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, [`unrelated-session-${index}`], {
          changeKinds: ['session'], feedPageConsumed: true, usageQueryAffects: true, usageAccountingAffects: false,
        });
        await settle(initial);
      }
      expect(allowanceReads() - settledAllowanceReads,
        'A settled allowance makes zero source resolves or record reads per unrelated Session push').toBe(0);
      releases.pop()!();
      let active = initial;
      for (const queries of [[sibling], [query, sibling], [query]] as const) {
        now += 1500;
        active = entryFor(queries);
        releases.push(active.subscribe(() => {}, true));
        await settle(active);
        expect(observed(active).accounting?.totals.eventCount).toBe(1);
        expect(posts(), 'unchanged accounting inputs reuse Account facts while each view reads quota history').toBe(initialReads);
        releases.pop()!();
      }
      await active.refresh({ supersede: false });
      expect(posts(), 'ordinary acquisition must join admitted accounting; only manual Refresh replaces it').toBe(initialReads);
      // Mount the real provider reader after navigation has released its last
      // observer. Its HTTP result publishes through the shared producer cache.
      const publishProviderRead = async () => {
        const reads = home!.requests.filter(request => request.path === '/v4/connect/qualified/provider-account-usage/record').length;
        const hook = await renderHook(() => useProviderAccountUsageSnapshots([record.recordId]), {
          flushOptions: { cycles: 30 },
          wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials: captured.credentials, children }),
        });
        await flushHookEffects({ cycles: 30 });
        await expect.poll(async () => { await flushHookEffects({ cycles: 20 }); return hook.getCurrent().snapshotsByRecordId[record.recordId]; }).toEqual(record);
        expect(home!.requests.filter(request => request.path === '/v4/connect/qualified/provider-account-usage/record')).toHaveLength(reads + 1);
        await hook.unmount();
      };
      await publishProviderRead();
      releases.push(active.subscribe(() => {}, true));
      await settle(active);
      expect(posts(), 'provider publication must not replace admitted accounting').toBe(initialReads);
      releases.pop()!();
      const retained = active.getSnapshot().value!;
      const tokens = observed(active).accounting!.totals.tokens;
      let factReads = 0;
      Object.defineProperty(tokens, 'total', { configurable: true, get() { factReads++; return 15; } });
      await publishProviderRead();
      factReads = 0;
      const httpBeforeReopen = home!.requests.length;
      releases.push(active.subscribe(() => {}, true));
      await settle(active);
      expect(active.getSnapshot().value === retained, 'an identical producer publication retains admitted Resource bytes').toBe(true);
      expect(factReads, 'unchanged reopen must not walk admitted accounting').toBe(0);
      expect(home!.requests.slice(httpBeforeReopen).map(request => request.path)).toEqual([]);
      releases.pop()!();
      now += 1500;
      record = ProviderAccountUsageSnapshotV1Schema.parse({ ...record, observedAtMs: now, fetchedAtMs: now });
      await publishProviderRead();
      releases.push(active.subscribe(() => {}, true));
      await settle(active);
      expect(observed(active).quota?.[0]?.current).toEqual(record);
      expect(posts(), 'a changed provider observation must update allowance without replacing accounting').toBe(initialReads);
      eventCount = 2;
      const { EphemeralUpdateSchema } = await import('@happier-dev/protocol/updates');
      const { applyUsageSocketUpdate } = await import('@/sync/engine/socket/usageUpdates');
      applyUsageSocketUpdate(EphemeralUpdateSchema.parse({ type: 'usage', id: 'view-switch', key: 'codex:model',
        tokens: { total: 1 }, cost: { total: 0 }, timestamp: now, accountingChange: { sessionId: null } }) as Extract<ReturnType<typeof EphemeralUpdateSchema.parse>, { type: 'usage' }>,
        captured.accountLifetime.scope.serverId, captured.accountLifetime.scope.accountId);
      await expect.poll(() => observed(active).accounting?.totals.eventCount).toBe(2);
      await settle(active);
      expect(posts(), 'a real usage push replaces both admitted accounting periods').toBe(initialReads + 2);
      eventCount = 3;
      await active.refresh();
      await settle(active);
      expect(observed(active).accounting?.totals.eventCount).toBe(3);
      expect(posts(), 'explicit refresh requests both accounting periods again').toBe(initialReads + 4);
    } finally { releases.forEach(release => release()); }
  });

  it('reopens a closed Usage view after its sources go stale, or another record changes, without rereading unchanged allowance records', async () => {
    let now = 1_900_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'closed-return' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    let record = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
      staleAfterMs: 120_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
    const otherRecordId = buildProviderAccountUsageRecordId({ ...recordKey, accountSubjectId: 'another-account' });
    const captured = await context(request => {
      if (request.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1) return Response.json(ConnectedPresentationRowReadResponseV1Schema.parse({ status: 'deleted', revision: 1 }));
      if (request.path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1) return Response.json(ConnectedAcknowledgementsRowReadResponseV1Schema.parse({ status: 'deleted', revision: 1 }));
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({
        source, recordId: record.recordId, providerAccountId: ref.accountId, fetchedAt: record.fetchedAtMs, staleAfterMs: 120_000 });
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: record },
        metadata: { fetchedAt: record.fetchedAtMs, staleAfterMs: 120_000, status: 'ok' }, sources: [source] });
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') return Response.json({ entries: [], nextCursor: null });
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const query = normalizeUsageQuery({ period: { relative: '30days' }, includeSessionEvidence: false, includeWorkEvidence: false,
      includeActivity: false, includeModelTimeline: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const settle = async () => {
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entry.getSnapshot().value !== undefined && entry.getSnapshot().pending === 'idle').toBe(true);
      expect(entry.getSnapshot().error).toBeUndefined();
    };
    const allowanceReads = () => home!.requests.filter(request =>
      request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve'
      || request.path === '/v4/connect/qualified/provider-account-usage/record').length;
    const quotaState = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.sources.find(state => state.source.startsWith('quota:'))?.status;
    // A view opens, closes (the person leaves for another tab) and opens again.
    const reopen = async (whileClosed: () => void) => {
      const release = entry.subscribe(() => {}, true);
      await settle();
      release();
      whileClosed();
      const reads = allowanceReads();
      const again = entry.subscribe(() => {}, true);
      await settle();
      again();
      return allowanceReads() - reads;
    };
    expect(await reopen(() => { now += 1_000; })).toBe(0);
    expect(quotaState()).toBe('available');
    // Freshness is a presentation of the same record: the record a reread returns is the one
    // pushed changes deliver, so a closed view that crosses staleness reprojects it.
    expect({ reads: await reopen(() => { now += 121_000; }), state: quotaState() }).toEqual({ reads: 0, state: 'stale' });
    // A record-scoped push for another record while closed changes nothing this view holds.
    const publishRecordChange = (recordId: string) => publishHomeAccountChange(captured.accountLifetime.scope.serverId,
      [`provider-account-usage-record:${recordId}`], { changeKinds: ['account'], providerAccountUsageRecordIds: [recordId] });
    expect(await reopen(() => publishRecordChange(otherRecordId))).toBe(0);
    // Its own record changing while closed is read again.
    expect(await reopen(() => {
      now += 1_000;
      record = ProviderAccountUsageSnapshotV1Schema.parse({ ...record, observedAtMs: now, fetchedAtMs: now });
      publishRecordChange(record.recordId);
    })).toBeGreaterThan(0);
    expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.quota?.[0]?.current).toEqual(record);
  });

  it('keeps current-only allowance readings across navigation before history has ever settled', async () => {
    const now = Date.now();
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'current-only' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const record = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
      staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'weekly', label: 'Weekly', usedPct: 40, utilizationPct: 40, used: null, limit: null,
        unit: 'count', status: 'ok', resetsAt: now + 86_400_000, windowDurationMs: 7 * 86_400_000 }] });
    const history = createDeferred<void>();
    let currentReads = 0;
    const captured = await context(async request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({
        source, recordId: record.recordId, providerAccountId: ref.accountId, fetchedAt: now, staleAfterMs: 600_000 });
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
        currentReads++;
        if (currentReads > 1) await history.promise;
        return Response.json({ content: { t: 'plain', v: record },
          metadata: { fetchedAt: now, staleAfterMs: 600_000, status: 'ok' }, sources: [source] });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
        await history.promise;
        return Response.json({ entries: [], nextCursor: null });
      }
      return undefined;
    }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const store = getUsageQueryResourceStore(captured);
    const entryFor = (startMs: number) => store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
      queries: [normalizeUsageQuery({ period: { startMs, endMs: now }, includeSessionEvidence: false, includeWorkEvidence: false })] }) });
    const first = entryFor(1000);
    const stopFirst = first.subscribe(() => {}, false);
    const sliceOf = (entry: typeof first) => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    try {
      await expect.poll(() => first.getSnapshot().value && sliceOf(first).quota?.[0]?.current).toEqual(record);
      // The useful current reading does not wait for an unrelated historical backfill.
      expect(sliceOf(first).pending).toBe(true);
      expect(sliceOf(first).sources.find(state => state.source.startsWith('quota:'))?.status).toBe('pending');
      stopFirst();
      const returning = entryFor(2000);
      const stopReturning = returning.subscribe(() => {}, false);
      try {
        await expect.poll(() => returning.getSnapshot().value !== undefined).toBe(true);
        expect(sliceOf(returning).quota?.[0]?.current).toEqual(record);
        expect(projectUsagePlans(sliceOf(returning).quota, now, undefined, sliceOf(returning).sources).tightest?.window.remainingFraction).toBe(0.6);
        expect(sliceOf(returning).quota?.[0]?.pageFacts).toBeUndefined();
        history.resolve();
        await expect.poll(() => returning.getSnapshot().pending).toBe('idle');
        expect(sliceOf(returning).quota?.[0]?.current).toEqual(record);
        expect(sliceOf(returning).pending).toBe(false);
        expect(sliceOf(returning).sources.find(state => state.source.startsWith('quota:'))?.status).toBe('available');
      } finally { stopReturning(); }
    } finally { history.resolve(); stopFirst(); }
  });
  it('does not let an older pending batch erase the Account allowance settled by another batch', async () => {
    const now = Date.now();
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'retained' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const record = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
      staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'weekly', label: 'Weekly', usedPct: 40, utilizationPct: 40, used: null, limit: null,
        unit: 'count', status: 'ok', resetsAt: now + 86_400_000, windowDurationMs: 7 * 86_400_000 }] });
    const slowAccounting = createDeferred<void>();
    const slowHistory = createDeferred<void>();
    let holdAllHistory = false;
    const captured = await context(async request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') {
        const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
        if (query.dateRange?.startMs === 1000) await slowAccounting.promise;
        return Response.json(value);
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({
        source, recordId: record.recordId, providerAccountId: ref.accountId, fetchedAt: now, staleAfterMs: 600_000 });
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: record },
        metadata: { fetchedAt: now, staleAfterMs: 600_000, status: 'ok' }, sources: [source] });
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        if (!('projection' in query) && !('history' in query)) return undefined;
        const range = 'projection' in query ? query.projection.range : query.history.range;
        if (holdAllHistory || range.startAtMs === 1000) await slowHistory.promise;
        return Response.json({ entries: [], nextCursor: null });
      }
      return undefined;
    }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const store = getUsageQueryResourceStore(captured);
    const entryFor = (startMs: number) => store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
      queries: [normalizeUsageQuery({ period: { startMs, endMs: now }, includeSessionEvidence: false, includeWorkEvidence: false })] }) });
    const slow = entryFor(1000);
    const stopSlow = slow.subscribe(() => {}, false);
    const fast = entryFor(2000);
    const stopFast = fast.subscribe(() => {}, false);
    const sliceOf = (entry: typeof slow) => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    try {
      await expect.poll(() => slow.getSnapshot().value && sliceOf(slow).quota?.length).toBe(1);
      await expect.poll(() => fast.getSnapshot().pending).toBe('idle');
      expect(projectUsagePlans(sliceOf(fast).quota, now, undefined, sliceOf(fast).sources).tightest).not.toBeNull();
      slowAccounting.resolve();
      await expect.poll(() => slow.getSnapshot().value && sliceOf(slow).accounting?.totals.eventCount).toBe(1);
      holdAllHistory = true;
      const returning = entryFor(3000);
      const stopReturning = returning.subscribe(() => {}, false);
      try {
        await expect.poll(() => returning.getSnapshot().value !== undefined).toBe(true);
        const slice = sliceOf(returning);
        expect(projectUsagePlans(slice.quota, now, undefined, slice.sources).tightest?.window.remainingFraction).toBe(0.6);
      } finally { stopReturning(); }
    } finally { slowAccounting.resolve(); slowHistory.resolve(); stopSlow(); stopFast(); }
  });
  it.each(['session refusal', 'session failure', 'catalog failure', 'suppression failure',
    'fresh suppression failure with retained Activity', 'recovered suppression with retained Activity',
    'cold malformed suppression', 'cold unopenable suppression', 'same held suppression failure', 'suppression 503 with Activity replacement held'] as const)(
    'replays readable Coach evidence beside a %s', async scenario => {
    const unopenableSuppression = scenario === 'cold unopenable suppression';
    const secret = new Uint8Array(32).fill(7);
    const credentials = { token: createServedHomeAccountToken('account-a'), secret: Buffer.from(secret).toString('base64url') };
    const primary = 'coach-session';
    const secondary = 'coach-sibling';
    let changed = false;
    let suppressionUnavailable = false;
    let activityUnavailable = false;
    let holdSuppression = false;
    let holdActivity = false;
    const suppressionEntered = createDeferred<void>();
    const activityEntered = createDeferred<void>();
    const finishSuppression = createDeferred<void>();
    const finishActivity = createDeferred<void>();
    const state = createAccountKvHttpFixture();
    const composition = { v: 1, evidenceId: 'composition', sessionId: primary, turnId: 'turn', inputId: 'input',
      observedAtMs: 300, boundary: 'host_pre_dispatch', deliveryKind: 'newTurn', coverage: 'host_only',
      components: ['a', 'c'].map(source => ({ sourceId: source.repeat(64), digest: 'b'.repeat(64),
        kind: 'instructions', location: 'user', byteLength: 200, tokenCount: null, tokenizerId: null,
        cacheClass: 'unknown', overlap: 'none' })), nativePrefix: null, contextWindowTokens: null };
    const usage = UsageMcpBindingUsageSchema.parse({ v: 2, evidenceId: 'mcp-window', sessionId: primary, turnId: 'turn',
      observedAtMs: 500, window: { startMs: 400, endMs: 500 }, coverage: 'complete', bindings: [{ serverId: 'server',
        bindingId: 'rule', serverRevision: 10, bindingRevision: 20, catalogRevision: 40, toolCallCount: 0, schemaBytes: null }] });
    const encrypted = unopenableSuppression ? await (async () => {
      const [{ Encryption }, { sealEncryptedDataKeyEnvelopeV1 }] = await Promise.all([
        import('@/sync/encryption/encryption'), import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1'),
      ]);
      const sessionKey = new Uint8Array(32).fill(9);
      const encryption = await Encryption.create(secret);
      await encryption.initializeSessions(new Map([primary, secondary].map(id => [id, sessionKey])));
      const dataEncryptionKey = Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: sessionKey,
        recipientPublicKey: encryption.contentDataKey, randomBytes: length => new Uint8Array(length).fill(3) })).toString('base64');
      return { encryption, dataEncryptionKey };
    })() : undefined;
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: [primary, secondary]
        .map(id => ({ ...workContribution, id: 'cost-' + id, sessionId: id })) });
      const detail = /^\/v2\/sessions\/(coach-session|coach-sibling)$/.exec(request.path)?.[1];
      if (detail) {
        if (detail === secondary && holdActivity) {
          activityEntered.resolve();
          await finishActivity.promise;
          return Response.json({ error: 'forbidden' }, { status: 403 });
        }
        if (detail === secondary && changed && scenario === 'session refusal') return Response.json({ error: 'forbidden' }, { status: 403 });
        if (detail === secondary && (activityUnavailable || changed && scenario === 'session failure')) return Response.json({ error: 'unavailable' }, { status: 503 });
        const metadata = { name: 'Coach', path: '/workspace/project', host: 'host',
          runtimeDescriptorV1: { v: 1 as const, agentId: 'claude' as const, agent: {} } };
        const plain = createPlainSessionCurrentProjectionRecordFixture({ id: detail, createdAt: 1, updatedAt: 900,
          seq: 1, active: false, activeAt: 900, metadataVersion: 1, metadata, agentStateVersion: 1 });
        if (!encrypted) return Response.json({ session: plain });
        const { ownerMetadata: _owner, displayProjectionV1: _display, ...record } = plain;
        return Response.json({ session: { ...record, encryptionMode: 'e2ee', metadataLayoutVersion: 0, agentState: null,
          dataEncryptionKey: encrypted.dataEncryptionKey, metadata: await encrypted.encryption.getSessionEncryption(detail)!.encryptMetadata(metadata) } });
      }
      const turns = /^\/v1\/sessions\/(coach-session|coach-sibling)\/turns$/.exec(request.path)?.[1];
      if (turns) return Response.json({ v: 1, sessionId: turns, updatedAt: 900, turns: unopenableSuppression
        ? [{ turnId: 'turn', agentId: 'claude', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] : [] });
      if (unopenableSuppression && /^\/v1\/sessions\/(coach-session|coach-sibling)\/messages$/.test(request.path)) {
        return Response.json({ messages: [], hasMore: false });
      }
      if (request.path === '/v1/sessions/coach-session/messages') return Response.json({ messages: [
        { id: 'composition-row', seq: 1, localId: null, createdAt: 300,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: 'composition-event',
            data: { type: 'prompt-composition', composition } } } } },
        { id: 'mcp-row', seq: 2, localId: null, createdAt: 500,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: 'mcp-window',
            data: { type: 'mcp-binding-usage', usage } } } } },
      ], hasMore: false });
      if (request.path === '/v1/sessions/coach-sibling/messages') return Response.json({ messages: [], hasMore: false });
      if (request.method === 'PUT' && /^\/v2\/sessions\/(coach-session|coach-sibling)\/system-records$/.test(request.path)) {
        return successfulUsageFactWrite(request.body);
      }
      if (unopenableSuppression && request.path === '/v1/account/encryption/currentness') {
        return Response.json(createAccountEncryptionCurrentnessFixtureForCredentials(credentials));
      }
      if (request.path === '/v1/account/entity-rows/mcp') {
        if (unopenableSuppression) return Response.json({ status: 'absent' });
        if (changed && scenario === 'catalog failure') return Response.json({ error: 'unavailable' }, { status: 503 });
        return Response.json({ status: 'present', revision: 41, content: { t: 'plain', v: { v: 1,
          servers: [{ id: 'server', name: 'docs', transport: 'stdio', stdio: { command: 'docs', args: [] }, env: {}, createdAt: 1, updatedAt: 10 }],
          bindings: [{ id: 'rule', serverId: 'server', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 20 }],
        } } });
      }
      if (request.path === '/v1/kv/bulk'
        && Array.isArray((request.body as { keys?: unknown } | undefined)?.keys)
        && (request.body as { keys: string[] }).keys.includes(USAGE_COACH_SUPPRESSIONS_KV_KEY)) {
        if (scenario === 'cold malformed suppression' || unopenableSuppression) {
          const envelope = unopenableSuppression
            ? { t: 'encrypted', c: Buffer.alloc(64).toString('base64') }
            : { t: 'plain', v: { v: 1, suppressions: 'not an array' } };
          const value = Buffer.from(JSON.stringify(envelope)).toString('base64');
          return Response.json({ values: [{ key: USAGE_COACH_SUPPRESSIONS_KV_KEY, value, version: 0 }] });
        }
        if (holdSuppression) {
          suppressionEntered.resolve();
          await finishSuppression.promise;
        }
        if (suppressionUnavailable || changed && scenario === 'suppression failure') {
          return Response.json({ error: 'unavailable' }, { status: 503 });
        }
      }
      return await state.handleFetch(request.url, { method: request.method,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }) ?? undefined;
    }, undefined, undefined, unopenableSuppression ? { accountMode: 'e2ee', credentials,
      encryptionCurrentness: () => createAccountEncryptionCurrentnessFixtureForCredentials(credentials) } : undefined);
    const membership = [primary, secondary];
    storage.setState({ sessions: Object.fromEntries(membership.map(id => [id, createSessionFixture({ id, seq: 1,
      serverId: captured.accountLifetime.scope.serverId, encryptionMode: unopenableSuppression ? 'e2ee' : 'plain' })])) });
    const query = normalizeUsageQuery({ session: membership, period: { startMs: 0, endMs: 1000 },
      includeQuota: false, includeComparison: false, includeWorkEvidence: false });
    const store = getUsageQueryResourceStore(captured);
    const entryFor = (queries: (typeof query)[]) => store.getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries }) });
    const exact = entryFor([query]);
    const sibling = entryFor([query, normalizeUsageQuery({ ...query, metric: 'cost', includeCoach: false })]);
    const current = (entry: typeof exact) => {
      const snapshot = entry.getSnapshot();
      if (!snapshot.value) throw snapshot.error ?? new Error('Expected admitted Resource content');
      return decodeUsageQueryResource(snapshot.value).results.find(slice => slice.key === getUsageQueryKey(query))!;
    };
    const release = exact.subscribe(() => {}, false);
    let releaseSibling: (() => void) | undefined;
    try {
      const acquired = await exact.refresh();
      const suppressionPhase = (slice: ReturnType<typeof current>) =>
        slice.sources.filter(source => source.source === 'how_you_work:coach');
      const suppressionFailure = [{ source: 'how_you_work:coach', status: 'error', errorCode: 'http_error' }];
      const pendingSuppressionFailure = suppressionFailure.map(source => ({ ...source, status: 'pending' }));
      if (scenario === 'cold malformed suppression' || unopenableSuppression) {
        expect(acquired.error).toBeUndefined();
        const slice = current(exact);
        expect(slice.accounting?.totals.tokens.total).toBe(15);
        expect(slice.howYouWork?.sessionCoverage).toMatchObject({ selected: 2, admitted: 2 });
        expect(slice.coach?.findings ?? []).toEqual([]);
        expect(suppressionPhase(slice)).toEqual([{ source: 'how_you_work:coach', status: 'error', errorCode: unopenableSuppression ? 'account_kv_content_unreadable' : 'invalid_response' }]);
        expect(slice.sources.filter(source => source.status === 'error')).toEqual(suppressionPhase(slice));
        return;
      }
      const baseline = current(exact).coach?.findings ?? [];
      const binding = baseline.find(row => row.remedy?.kind === 'mcp_binding');
      const dismissed = baseline.find(row => row.detectorId === 'duplicated_instructions');
      expect(binding?.remedy).toMatchObject({ kind: 'mcp_binding', bindingId: 'rule', expectedRevision: 41 });
      expect(dismissed).toBeDefined();
      if (!binding || !dismissed) throw new Error('Expected both witnessed Coach findings');
      await createUiCoachSuppressionPort(captured).edit({ evidenceKey: dismissed.evidenceKey, dismissed: true });
      changed = true;
      if (scenario === 'same held suppression failure') {
        suppressionUnavailable = true;
        await exact.refresh();
        expect(suppressionPhase(current(exact))).toEqual(suppressionFailure);
        holdSuppression = true;
        activityUnavailable = true;
        const notices: string[][] = [];
        const stopObserving = exact.subscribe(() => {
          if (exact.getSnapshot().value) notices.push(suppressionPhase(current(exact)).flatMap(source => source.errorCode ?? []));
        }, false);
        try {
          publishHomeAccountChange(captured.accountLifetime.scope.serverId, [secondary], { changeKinds: ['session'], usageQueryAffects: true });
          const retry = exact.refresh({ failedOnly: true });
          await suppressionEntered.promise;
          await vi.waitFor(() => expect(current(exact).sources).toContainEqual(expect.objectContaining({
            source: 'how_you_work', status: 'stale', errorCode: 'http_error',
          })));
          expect(suppressionPhase(current(exact))).toEqual(pendingSuppressionFailure);
          const { readUsagePageFailure } = await import('@/components/settings/usage/widgets/usageBodyKit');
          expect(readUsagePageFailure([current(exact)])).toMatchObject({ retryable: true, quiet: false });
          finishSuppression.resolve();
          expect((await retry).error).toBeUndefined();
          expect(notices.length).toBeGreaterThan(0);
          expect(notices).toEqual(notices.map(() => ['http_error']));
          expect(suppressionPhase(current(exact))).toEqual(suppressionFailure);
        } finally { stopObserving(); }
        return;
      }
      if (scenario === 'suppression 503 with Activity replacement held') {
        holdActivity = true;
        suppressionUnavailable = true;
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, [secondary], { changeKinds: ['session'], usageQueryAffects: true });
        const replacement = exact.refresh();
        await activityEntered.promise;
        await vi.waitFor(() => expect(suppressionPhase(current(exact))).toEqual(pendingSuppressionFailure));
        const pending = current(exact);
        expect(pending.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'pending' }));
        expect(pending.accounting?.totals.tokens.total).toBe(15);
        expect(exact.getSnapshot().error).toBeUndefined();
        finishActivity.resolve();
        expect((await replacement).error).toBeUndefined();
        const settled = current(exact);
        expect(settled.howYouWork?.sessionCoverage).toMatchObject({ selected: 2, admitted: 1 });
        expect(settled.sources.find(source => source.source === 'how_you_work:sessions')?.errorCode).toBe('forbidden');
        expect(suppressionPhase(settled)).toEqual(suppressionFailure);
        return;
      }
      if (scenario === 'fresh suppression failure with retained Activity' || scenario === 'recovered suppression with retained Activity') {
        const { readUsagePageFailure } = await import('@/components/settings/usage/widgets/usageBodyKit');
        suppressionUnavailable = true;
        const recoveredSuppression = scenario === 'recovered suppression with retained Activity';
        const retriedEntry = recoveredSuppression ? sibling : exact;
        if (recoveredSuppression) {
          releaseSibling = sibling.subscribe(() => {}, false);
          await sibling.refresh({ supersede: false });
          const refusedPreferences = current(sibling);
          expect(refusedPreferences.howYouWork?.sessionCoverage).toMatchObject({ admitted: 2 });
          expect(suppressionPhase(refusedPreferences)).toEqual(suppressionFailure);
          expect(refusedPreferences.coach?.findings.find(row => row.evidenceKey === dismissed.evidenceKey)?.state.dismissed).toBe(true);
          suppressionUnavailable = false;
          // The remote preference has changed without publishing into this tab.
          state.reset();
        }
        activityUnavailable = true;
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, [secondary], { changeKinds: ['session'], usageQueryAffects: true });
        const retry = await retriedEntry.refresh({ failedOnly: true });
        expect(retry.error).toBeUndefined();
        const retained = current(retriedEntry);
        expect(retained.howYouWork?.sessionCoverage).toMatchObject({ selected: 2, admitted: 2 });
        expect(retained.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'stale', errorCode: 'http_error' }));
        if (suppressionUnavailable) {
          expect(suppressionPhase(retained)).toEqual(suppressionFailure);
          expect(readUsagePageFailure([retained])).toMatchObject({ retryable: true, quiet: false });
        } else expect(suppressionPhase(retained)).toEqual([{ source: 'how_you_work:coach', status: 'available' }]);
        expect(retained.coach?.findings.find(row => row.evidenceKey === dismissed.evidenceKey)?.state.dismissed)
          .toBe(suppressionUnavailable);
        return;
      }
      if (scenario === 'session refusal' || scenario === 'session failure') {
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, [secondary], { changeKinds: ['session'], usageQueryAffects: true });
      }
      releaseSibling = sibling.subscribe(() => {}, false);
      const result = await sibling.refresh({ supersede: false });
      expect(result.error).toBeUndefined();
      const slice = current(sibling);
      expect(slice.pending).toBe(false);
      expect(slice.accounting?.totals.tokens.total).toBe(15);
      const finding = slice.coach?.findings.find(row => row.detectorId === binding.detectorId);
      expect(finding?.state.dismissed).toBe(false);
      expect(slice.coach?.findings.find(row => row.evidenceKey === dismissed.evidenceKey)?.state.dismissed).toBe(true);
      if (scenario === 'catalog failure' || scenario === 'session failure') expect(finding?.remedy).toBeNull();
      if (scenario === 'suppression failure') {
        expect(slice.sources.filter(source => source.errorCode === 'http_error'))
          .toEqual([{ source: 'how_you_work:coach', status: 'error', errorCode: 'http_error' }]);
        const { readUsagePageFailure } = await import('@/components/settings/usage/widgets/usageBodyKit');
        expect(readUsagePageFailure([slice])).toMatchObject({ retryable: true, quiet: false });
      }
      if (scenario === 'session refusal' || scenario === 'suppression failure') {
        expect(finding?.remedy).toMatchObject({ kind: 'mcp_binding', bindingId: 'rule', expectedRevision: 41 });
      }
      if (scenario === 'session refusal') {
        expect(slice.howYouWork?.sessionCoverage).toMatchObject({ selected: 2, admitted: 1 });
        expect(slice.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'partial' }));
        expect(slice.sources.find(source => source.source === 'how_you_work:sessions')?.errorCode).toBe('forbidden');
      }
      if (scenario === 'session failure') {
        expect(slice.howYouWork?.sessionCoverage).toMatchObject({ selected: 2, admitted: 2 });
        expect(slice.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'stale', errorCode: 'http_error' }));
      }
    } finally {
      finishSuppression.resolve();
      finishActivity.resolve();
      releaseSibling?.();
      release();
    }
  });

  it('waits for current Coach evidence and its binding catalog before completing a coach-ready query', async () => {
    const privateSession = createDeferred<Response>();
    const catalogRead = createDeferred<Response>();
    const usage = UsageMcpBindingUsageSchema.parse({ v: 2, evidenceId: 'mcp-window', sessionId: 'coach-session', turnId: 'turn',
      observedAtMs: 500, window: { startMs: 400, endMs: 500 }, coverage: 'complete', bindings: [{ serverId: 'server',
        bindingId: 'rule', serverRevision: 10, bindingRevision: 20, catalogRevision: 40, toolCallCount: 0, schemaBytes: null }] });
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: [{ ...workContribution, sessionId: 'coach-session' }] });
      if (request.path === '/v2/sessions/coach-session') return privateSession.promise.then(response => response.clone());
      if (request.path === '/v1/sessions/coach-session/turns') return Response.json({ v: 1, sessionId: 'coach-session', updatedAt: 900, turns: [] });
      if (request.path === '/v1/account/entity-rows/mcp') return catalogRead.promise;
      if (request.path === '/v1/sessions/coach-session/messages') return Response.json({ messages: [{ id: 'mcp-row', seq: 1,
        localId: null, createdAt: 500, content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: 'mcp-window',
          data: { type: 'mcp-binding-usage', usage } } } } }], hasMore: false });
      return undefined;
    });
    const query = normalizeUsageQuery({ session: 'coach-session', period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false });
    const settled: ActionExecuteResult[] = [];
    const controller = new AbortController();
    const pending = createDefaultActionExecutor().execute('usage.query', { queries: [query] },
      { surface: 'ui', authority: 'present_user', serverId: captured.accountLifetime.scope.serverId,
        actionCaller: { kind: 'host' }, signal: controller.signal, usageQueryReadiness: 'coach_evidence' }).then(result => { settled.push(result); });
    try {
      await expect.poll(() => ({ requested: sessionRequests().some(request => request.path === '/v2/sessions/coach-session'), settled }))
        .toMatchObject({ requested: true });
      await flushHookEffects({ cycles: 30 });
      expect(settled).toEqual([]);
      privateSession.resolve(Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({
        id: 'coach-session', createdAt: 1, updatedAt: 900, seq: 1, active: false, activeAt: 900,
        metadataVersion: 1, metadata: { name: 'Coach', path: '/workspace/project', host: 'host',
          runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } }, agentStateVersion: 1,
      }) }));
      await expect.poll(() => ({ requested: home!.requests.some(request => request.path === '/v1/account/entity-rows/mcp'), settled }))
        .toMatchObject({ requested: true });
      await flushHookEffects({ cycles: 30 });
      expect(settled).toEqual([]);
      catalogRead.resolve(Response.json({ status: 'present', revision: 41, content: { t: 'plain', v: { v: 1,
        servers: [{ id: 'server', name: 'docs', transport: 'stdio', stdio: { command: 'docs', args: [] }, env: {}, createdAt: 1, updatedAt: 10 }],
        bindings: [{ id: 'rule', serverId: 'server', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 20 }],
      } } }));
      await pending;
      expect(settled[0]).toMatchObject({ ok: true, result: { results: [{ key: getUsageQueryKey(query) }] } });
      const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
      const result = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.coach!;
      expect(result.findings.map(row => row.remedy))
        .toContainEqual(expect.objectContaining({ kind: 'mcp_binding', bindingId: 'rule', expectedRevision: 41 }));
    } finally {
      privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
      catalogRead.resolve(Response.json({ status: 'absent' }));
      controller.abort();
      await pending;
    }
  });
  it.each(['mode', 'settings', 'refused-mode'] as const)('issues current quota reads before held %s and publishes before unrelated settles', async held => {
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'startup' };
    const source = { bindingKind: 'account' as const, ref };
    const now = Date.now();
    const recordKey = { providerId: 'codex', accountSubjectId: 'startup', subjectKind: 'account', quotaScope: 'account' } as const;
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'startup' }, observedAtMs: now,
      fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'window', label: 'Window', used: 40, limit: 100, usedPct: 40, utilizationPct: 40,
        unit: 'count', status: 'ok', resetAtMs: now + 3_600_000, resetsAt: now + 3_600_000, windowDurationMs: 18_000_000 }] });
    const gate = createDeferred<void>();
    const unrelated = createDeferred<void>();
    const events: string[] = [];
    const targets = [{ id: 'startup-target', scope: { kind: 'personal' as const }, utilizationFraction: 0.75 }];
    const captured = await context(async request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') { await unrelated.promise; return Response.json(value); }
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        events.push('source');
        return Response.json({ source, recordId: snapshot.recordId, providerAccountId: 'startup', fetchedAt: now, staleAfterMs: 60_000 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
        events.push('current');
        return Response.json({ content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') { await unrelated.promise; return Response.json({ entries: [], nextCursor: null }); }
      if (request.path === '/v2/pending/reset-starts/read') { await unrelated.promise; return Response.json({ entries: [] }); }
      return undefined;
    }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] },
    { usagePacingTargetsV1: targets });
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    // A cold Settings document is an external persistence/HTTP boundary. Keep
    // real Account admission, settings decoding, Action and Resource wiring.
    const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
    const { accountSettingsScopeKeySuffix } = await import('@/sync/domains/settings/scope/accountSettingsScope');
    const { loadAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
    getPersistenceStorage().delete(`account-settings:v2:${accountSettingsScopeKeySuffix(captured.accountLifetime.scope)}`);
    storage.setState({ settingsScope: null });
    expect(loadAccountSettings(captured.accountLifetime.scope).version).toBeNull();
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    const fetch = home!.fetch;
    setRuntimeFetch(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === (held === 'settings' ? '/v2/account/settings' : '/v1/account/encryption/currentness')) {
        events.push('held');
        await gate.promise;
        events.push('released');
        if (held === 'refused-mode') return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      return fetch(url, init);
    });
    if (held !== 'settings') {
      // Bootstrap already owns a settled Account identity. Model its real withdrawal
      // before holding the next identity read, rather than expecting a redundant probe.
      const { invalidateAccountEncryptionModeCache } = await import('./apiAccountEncryptionMode');
      invalidateAccountEncryptionModeCache({ serverId: captured.accountLifetime.scope.serverId });
    }
    const quotaAdmission = vi.spyOn(ConnectedServiceQuotaGetResultV1Schema, 'parse');
    const query = normalizeUsageQuery({ period: { startMs: now - 1000, endMs: now }, includeSessionEvidence: false, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const slice = () => entry.getSnapshot().value ? decodeUsageQueryResource(entry.getSnapshot().value!).results[0] : undefined;
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => events).toContain('current');
      expect(events).not.toContain('released');
      if (held !== 'settings') {
        expect(slice()?.quota).toBeUndefined(); // Mode still authorizes opening/disclosure.
        gate.resolve();
      }
      if (held === 'refused-mode') {
        unrelated.resolve();
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        expect(slice()?.quota).toBeUndefined();
        expect(slice()?.sources).toContainEqual(expect.objectContaining({ source: 'quota', status: 'error' }));
        return;
      }
      await expect.poll(() => slice()?.quota?.[0]?.current).toEqual(snapshot);
      expect(projectUsagePlans(slice()?.quota, now).accounts[0]?.headline?.remainingFraction).toBe(0.6);
      expect(entry.getSnapshot().pending).not.toBe('idle');
      gate.resolve();
      unrelated.resolve();
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(slice()?.quota?.[0]?.targets).toEqual(targets);
      expect(events.indexOf('current')).toBeLessThan(events.indexOf('released'));
      expect(quotaAdmission.mock.calls.length, 'the configuration Action admits the quota result once').toBe(1);
    } finally { gate.resolve(); unrelated.resolve(); await entry.refresh(); release(); quotaAdmission.mockRestore(); }
  });

  it.each([true, false])('keeps settled quota history through unrelated changes (accounting: %s)', async includeAccounting => {
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: 'provider-work', subjectKind: 'account', quotaScope: 'account' } as const;
    const now = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    let snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'provider-work' },
      observedAtMs: now, fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed',
      state: 'loaded_data', meters: [{ meterId: 'weekly', label: 'Weekly', used: 100, limit: 100, utilizationPct: 100,
        unit: 'requests', status: 'ok', resetsAt: now + 2 * 86_400_000 }] });
    let historyRequests = 0;
    let changedHistory = false;
    let quotaUnavailable = false;
    let accountingRequests = 0;
    let quotaResolves = 0;
    let quotaRecords = 0;
    const profile = { connectedAccountsV4: [{ ref, status: 'connected' as const, authenticationModeId: 'manual',
      revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
      configurationReady: false, configurationRevision: null, scopes: [] }] };
    const captured = await context(async request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') { accountingRequests++; return Response.json(value); }
      if (request.path === '/v4/connect/qualified/quotas') return quotaUnavailable
        ? Response.json({ error: 'unavailable' }, { status: 503 })
        : Response.json(QualifiedConnectedAccountQuotaResponseV4Schema.parse({ ref,
          sourceResolution: { source, recordId: snapshot.recordId, providerAccountId: 'provider-work',
            fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs },
          content: { t: 'plain', v: { v: 1, ref, activeAccountId: 'provider-work', fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs, planLabel: null, accountLabel: null, meters: snapshot.meters } },
          metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' },
        }));
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        quotaResolves++;
        return Response.json({ source, recordId: snapshot.recordId, providerAccountId: 'provider-work', fetchedAt: now, staleAfterMs: 60_000 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
        quotaRecords++;
        return Response.json({ content: { t: 'plain', v: snapshot },
          metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
        historyRequests++;
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        // The server withdraws the old materialization when this new history
        // arrives; the canonical reader then rebuilds it from the raw page.
        if (changedHistory && 'projection' in query) return Response.json({ projection: null, complete: false });
        return Response.json({ entries: changedHistory ? [{ id: 'mixed-page-history', observedAtMs: now - 500,
          record: { content: { t: 'plain', v: { ...snapshot, observedAtMs: now - 500, fetchedAtMs: now - 500 } },
            metadata: { fetchedAt: now - 500, staleAfterMs: 60_000, status: 'ok' }, sources: [source] } }] : [], nextCursor: null });
      }
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    }, profile);
    // The real Home harness starts Sync catch-up asynchronously. Its broad
    // Account wake legitimately rereads Usage; finish it before measuring
    // unchanged cache publications against a settled Resource baseline.
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const basis = getActiveServerSnapshot();
    const credentialsKey = resolveAuthCredentialsScopeKey(captured.credentials);
    const quotaContext = { credentials: captured.credentials, ref,
      serverBasis: { serverId: basis.serverId, generation: basis.generation },
      credentialScope: [basis.serverId, String(basis.generation), credentialsKey].join('\u0000') };
    const quotaKey = buildQualifiedQuotaSnapshotScopeKey(quotaContext);
    loadQualifiedQuotaSnapshotOnce(quotaKey, quotaContext);
    await expect.poll(() => getQualifiedQuotaSnapshotEntry(quotaKey).read).toBe(true);
    expect(getQualifiedQuotaSnapshotEntry(quotaKey).snapshot?.activeAccountId).toBe('provider-work');
    const providerScope = buildProviderAccountUsageScopeKey({ serverId: basis.serverId,
      generation: basis.generation, credentialScope: credentialsKey });
    updateProviderAccountUsageCacheEntries(providerScope, entries => ({ ...entries, [snapshot.recordId]: {
      snapshot, loading: false, hadError: false, nextFetchAtMs: now + 60_000 } }));
    const query = normalizeUsageQuery({ period: { startMs: now - 1000, endMs: now },
      includeAccounting, includeSessionEvidence: false, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    let resourcePublications = 0;
    const release = entry.subscribe(() => { resourcePublications++; }, true);
    try {
      await entry.refresh();
      // Retry can supersede the baseline while watch establishment is still
      // settling. Measure a quiet entry after that establishment resync too.
      await flushHookEffects({ cycles: 30 });
      expect(entry.getSnapshot().pending).toBe('idle');
      const settled = decodeUsageQueryResource(entry.getSnapshot().value!);
      expect(settled.results[0]?.sources).toContainEqual(expect.objectContaining({ source: 'quota', status: 'available' }));
      const before = { historyRequests, accountingRequests };
      const publicationsBefore = resourcePublications;
      for (let index = 0; index < 128; index++) storage.setState({ isDataReady: !storage.getState().isDataReady });
      for (let index = 0; index < 8; index++) {
        const state = storage.getState();
        storage.setState({ profile: { ...state.profile, connectedAccountsV4: structuredClone(state.profile.connectedAccountsV4),
          connectedAccountGroupsV4: structuredClone(state.profile.connectedAccountGroupsV4) },
          profileScope: { ...captured.accountLifetime.scope } });
      }
      await flushHookEffects();
      expect({ historyRequests, accountingRequests }).toEqual(before);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!)).toBe(settled);
      // Acquisition/presentation revisions are not new Usage evidence. A second
      // cache subscriber and an unchanged admission must not restart this batch.
      for (const loading of [true, false]) {
        updateProviderAccountUsageCacheEntries(providerScope, entries => ({ ...entries, [snapshot.recordId]: {
          ...entries[snapshot.recordId]!, snapshot: structuredClone(snapshot), loading, nextFetchAtMs: now + 120_000 } }));
        await flushHookEffects({ cycles: 30 });
      }
      expect({ historyRequests, accountingRequests }, 'loading-only provider rows must not wake the Resource').toEqual(before);
      await reloadQualifiedQuotaSnapshotAfterRecovery(quotaContext);
      await flushHookEffects({ cycles: 30 });
      expect({ historyRequests, accountingRequests }, 'unchanged cache evidence must not wake the Resource').toEqual(before);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!)).toBe(settled);
      expect(resourcePublications, 'unchanged store/provider ticks must publish nothing to Resource subscribers').toBe(publicationsBefore);
      const quotaBeforeWakes = { quotaResolves, quotaRecords };
      for (let index = 0; index < 12; index++) {
        publishHomeAccountChangeWake(captured.accountLifetime.scope.serverId, {
          t: 'account-change', changeKinds: [index % 2 === 0 ? 'machine' : 'automation'], entityIds: [`unrelated-${index}`],
        }, 'socket');
        await flushHookEffects({ cycles: 30 });
      }
      expect({ quotaResolves, quotaRecords }, 'unrelated socket wakes must not reread provider usage').toEqual(quotaBeforeWakes);
      expect({ historyRequests, accountingRequests }, 'the Home planner excludes unrelated query changes').toEqual(before);
      publishHomeAccountChangeWake(captured.accountLifetime.scope.serverId, {
        t: 'account-change', changeKinds: ['account'], entityIds: ['provider-account-usage'],
      }, 'socket');
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      await flushHookEffects({ cycles: 30 });
      expect({ quotaResolves, quotaRecords }, 'one relevant wake rereads each provider endpoint once').toEqual({
        quotaResolves: quotaBeforeWakes.quotaResolves + 1, quotaRecords: quotaBeforeWakes.quotaRecords + 1,
      });
      const afterRelevantWake = { historyRequests, accountingRequests };
      const publicationsAfterRelevantWake = resourcePublications;
      if (!includeAccounting) {
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['self', 'session-a', 'machine-a', 'approval-a'], {
          changeKinds: ['account', 'session', 'machine', 'artifact'], usageQueryAffects: true,
        });
        await flushHookEffects({ cycles: 30 });
        expect({ historyRequests, accountingRequests }, 'unrelated detailed Home changes must not reread Capacity').toEqual(afterRelevantWake);
        expect(resourcePublications).toBe(publicationsAfterRelevantWake);
        const sessions = storage.getState().sessions;
        storage.setState({ sessions: { ...sessions, 'unrelated-capacity-session': createSessionFixture({
          id: 'unrelated-capacity-session', serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain',
        }) } });
        await flushHookEffects({ cycles: 30 });
        storage.setState({ sessions });
        await flushHookEffects({ cycles: 30 });
        expect({ historyRequests, accountingRequests }, 'Session membership changes must not reread Capacity').toEqual(afterRelevantWake);
        expect(resourcePublications, 'Session membership must not publish a quota-only revision').toBe(publicationsAfterRelevantWake);
      }
      quotaUnavailable = true;
      await reloadQualifiedQuotaSnapshotAfterRecovery(quotaContext);
      await flushHookEffects({ cycles: 30 });
      expect(getQualifiedQuotaSnapshotEntry(quotaKey).error).not.toBeNull();
      const failedReads = { historyRequests, accountingRequests };
      const failedView = entry.getSnapshot().value;
      await reloadQualifiedQuotaSnapshotAfterRecovery(quotaContext);
      await flushHookEffects({ cycles: 30 });
      expect({ historyRequests, accountingRequests }, 'the same failed quota read is not new admission or recovery').toEqual(failedReads);
      expect(entry.getSnapshot().value).toBe(failedView);
      quotaUnavailable = false;
      await reloadQualifiedQuotaSnapshotAfterRecovery(quotaContext);
      await flushHookEffects({ cycles: 30 });
      expect(getQualifiedQuotaSnapshotEntry(quotaKey).error).toBeNull();
      // The rendered countdown uses minute precision. Crossing freshness in
      // the middle of that minute must not alternate cache-stale and read-ready
      // answers for exactly the same exhausted allowance.
      clock.mockReturnValue(now + 60_001);
      await entry.refresh();
      const aged = decodeUsageQueryResource(entry.getSnapshot().value!);
      expect(aged.results[0]?.sources.filter(source => source.source.startsWith('quota:')),
        'settling an unchanged provider read cannot renew its observation').toEqual([
        expect.objectContaining({ status: 'stale' }),
      ]);
      const agedQuota = aged.results[0]!.quota;
      const textStates = new Set<boolean>();
      const stopText = entry.subscribe(() => {
        const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
        textStates.add(projectUsagePlans(slice.quota, Math.floor(Date.now() / 60_000) * 60_000, slice.pools, slice.sources).accounts[0]!.stale);
      }, false);
      const agedReads = { quotaResolves, quotaRecords, historyRequests, accountingRequests };
      try {
        for (let index = 0; index < 12; index++) {
          publishHomeAccountChangeWake(captured.accountLifetime.scope.serverId, {
            t: 'account-change', changeKinds: [index % 2 === 0 ? 'machine' : 'automation'], entityIds: [`aged-unrelated-${index}`],
          }, 'socket');
          await flushHookEffects({ cycles: 5 });
        }
        expect({ quotaResolves, quotaRecords, historyRequests, accountingRequests }).toEqual(agedReads);
        expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.quota).toBe(agedQuota);
        expect(textStates.size, 'idle wakes do not change the cell presentation').toBe(0);
        await entry.refresh();
        expect([...textStates], 'same observed allowance stays stale through acquisition and settlement').toEqual([true]);
      } finally { stopText(); }
      const beforeMixedAccounting = accountingRequests;
      changedHistory = true;
      const changes: ApiChangeEntry[] = [
        { kind: 'account', entityId: 'provider-account-usage', cursor: 12, changedAt: 1 },
        { kind: 'machine', entityId: 'fixture-controller', cursor: 11, changedAt: 1 },
        { kind: 'automation', entityId: 'fixture-automation', cursor: 13, changedAt: 1 },
      ];
      const planned = planSyncActionsFromChanges(changes, { afterCursor: 10, isSessionListMember: () => false });
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, changes.map(change => change.entityId), {
        changeKinds: changes.map(change => change.kind), usageQueryAffects: plannedChangesAffectUsageQuery(planned),
        usageAccountingAffects: plannedChangesAffectUsageAccounting(planned),
      });
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]?.pageFacts?.resetWitness?.id)
        .toBe('mixed-page-history');
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(accountingRequests, 'A mixed quota page refreshes its material history without rereading accounting').toBe(beforeMixedAccounting);
      const beforePureQuota = historyRequests;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['provider-account-usage'], {
        changeKinds: ['account'], usageQueryAffects: true,
      });
      await expect.poll(() => historyRequests).toBeGreaterThan(beforePureQuota);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      await entry.refresh();
      expect(resourcePublications).toBeGreaterThan(publicationsBefore);
      expect(historyRequests).toBeGreaterThan(before.historyRequests);
      const beforeReplacement = historyRequests;
      updateProviderAccountUsageCacheEntries(providerScope, entries => ({ ...entries, [snapshot.recordId]: {
        ...entries[snapshot.recordId]!, snapshot: { ...snapshot, fetchedAtMs: now + 1, observedAtMs: now + 1 } } }));
      await expect.poll(() => historyRequests).toBeGreaterThan(beforeReplacement);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      snapshot = { ...snapshot, fetchedAtMs: Date.now(), observedAtMs: Date.now() };
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources).toContainEqual(
        expect.objectContaining({ status: 'available', asOfMs: snapshot.observedAtMs }));
    } finally { release(); clock.mockRestore(); }
  });

  it.each([
    'idle', 'unchanged', 'changed', 'resolve-503', 'record-503', 'slow', 'feed-after-read',
    'primary-observation-only', 'primary-content-change', 'secondary-observation-only', 'secondary-content-change',
    'primary-reconnect', 'secondary-reconnect', 'snapshot-recovery', 'explicit-refresh',
  ] as const)('counts mounted allowance requests over ten minutes (%s)', async scenario => {
    const start = Math.floor(Date.now() / 60_000) * 60_000;
    const minute = 60_000;
    const addressedWake = scenario.endsWith('-observation-only') || scenario.endsWith('-content-change');
    const contentChanged = scenario.endsWith('-content-change');
    const rows = Array.from({ length: 15 }, (_, index) => {
      const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: `quota-count-${index}` };
      const source = { bindingKind: 'account' as const, ref };
      const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
      const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'codex',
        accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: start, fetchedAtMs: start,
        staleAfterMs: minute, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
        subscription: { status: 'subscribed', renewal: 'on', observedAtMs: start, staleAfterMs: 2 * minute,
          currentPeriodStartAtMs: start, currentPeriodEndAtMs: start + 60 * minute,
          monetaryFacts: [{ kind: 'paid', currency: 'USD', amount: 20, effectiveAtMs: start, asOfMs: start,
            source: { kind: 'provider', id: 'fixture', version: '1' },
            period: { startAtMs: start, endAtMs: start + 60 * minute } }] },
        meters: [{ meterId: 'weekly', label: 'Weekly', used: 10, limit: 100, remaining: 90, utilizationPct: 10,
          unit: 'requests', status: 'ok', resetsAt: start + 2 * minute, details: {} }],
      });
      return { source, snapshot, resolves: 0, records: 0 };
    });
    const rowsByAccountId = new Map(rows.map(row => [row.source.ref.accountId, row]));
    const rowsByRecordId = new Map<string, typeof rows[number]>(rows.map(row => [row.snapshot.recordId, row]));
    let publish: (selected: typeof rows) => void = () => {};
    const captured = await context(async request => {
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        const source = JSON.parse(request.url.searchParams.get('source')!);
        const row = rowsByAccountId.get(source.ref.accountId)!;
        row.resolves++;
        if (scenario === 'slow') await new Promise<void>(resolve => setTimeout(resolve, 5_000));
        if (scenario === 'resolve-503') return Response.json({ error: 'storage_unavailable' }, { status: 503 });
        return Response.json({ source: row.source, recordId: row.snapshot.recordId,
          providerAccountId: row.source.ref.accountId, fetchedAt: row.snapshot.fetchedAtMs, staleAfterMs: minute });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
        const row = rowsByRecordId.get(request.url.searchParams.get('recordId')!)!;
        row.records++;
        if (scenario === 'slow') await new Promise<void>(resolve => setTimeout(resolve, 5_000));
        if (scenario === 'record-503') return Response.json({ error: 'storage_unavailable' }, { status: 503 });
        // Counterfactual transport: GET is read-only on the real server. Echo
        // just one key, with delay to measure repeated work over a finite span.
        if (scenario === 'feed-after-read' && row === rows[0]) setTimeout(() => publish([row]), 5_000);
        return Response.json({ content: { t: 'plain', v: row.snapshot },
          metadata: { fetchedAt: row.snapshot.fetchedAtMs, staleAfterMs: minute, status: 'ok' }, sources: [row.source] });
      }
      return undefined;
    }, { connectedAccountsV4: rows.map(({ source: { ref } }) => ({
      ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [],
    })) });
    publish = selected => {
      const recordIds = selected.map(row => row.snapshot.recordId);
      const { serverId } = captured.accountLifetime.scope;
      if (addressedWake || scenario === 'feed-after-read') {
        const entityIds = recordIds.flatMap(id => buildProviderAccountUsageMaterialChangesV1(id).map(change => change.entityId));
        if (scenario.startsWith('secondary')) {
          publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['account'], entityIds, sessionSystemRecords: [] }, 'socket');
        } else {
          publishHomeAccountChange(serverId, entityIds, { feedPageConsumed: true, changeKinds: ['account'],
            usageQueryAffects: true, usageAccountingAffects: false, providerAccountUsageRecordIds: recordIds });
        }
      } else {
        publishHomeAccountChange(serverId, ['provider-account-usage'], {
          changeKinds: ['account'], feedPageConsumed: true, usageQueryAffects: true, usageAccountingAffects: false });
      }
    };
    const query = normalizeUsageQuery({ includeQuotaHistory: false, includeAccounting: false, includeCoach: false,
      includeSessionEvidence: false, includeWorkEvidence: false });
    const store = getUsageQueryResourceStore(captured);
    const entries = (['sessions', 'tokens', 'cost'] as const).map(metric =>
      store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ ...query, metric }] }) }));
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const releases = entries.map(entry => entry.subscribe(() => {}, true));
    try {
      const readCounts = () => rows.map(({ resolves, records }) => [resolves, records]);
      const advance = async (ms: number) => {
        await vi.advanceTimersByTimeAsync(ms);
        await flushHookEffects({ cycles: 70 });
        await vi.advanceTimersByTimeAsync(0);
      };
      const beforeMountHttp = home!.requests.length;
      await advance(20_000);
      const mountRoutes = home!.requests.slice(beforeMountHttp).map(request => `${request.method} ${request.path}`);
      const cold = readCounts();
      const { serverId } = captured.accountLifetime.scope;
      if (scenario === 'primary-reconnect') {
        const { expireServerFeaturesSnapshotForReconnect } = await import('@/sync/api/capabilities/serverFeaturesClient');
        expireServerFeaturesSnapshotForReconnect({ serverId });
        publishHomeAccountChange(serverId, undefined, { source: 'connected', changesCatchUp: true });
      } else if (scenario === 'secondary-reconnect') {
        publishHomeAccountChange(serverId, undefined, { source: 'connected' });
      } else if (scenario === 'snapshot-recovery') {
        publishHomeAccountChange(serverId, undefined, { source: 'snapshot' });
      } else if (scenario === 'explicit-refresh') {
        await entries[0]!.refresh();
      }
      await advance(40_000);
      const feedScenarios = ['unchanged', 'changed', 'resolve-503', 'record-503', 'slow'];
      const hasPublication = addressedWake || feedScenarios.includes(scenario);
      const afterFirstMinute = readCounts();
      const recordsPerResolve = scenario === 'resolve-503' ? 0 : 1;
      const explicitWake = scenario === 'snapshot-recovery' || scenario === 'explicit-refresh';
      if (scenario !== 'feed-after-read') {
        expect(cold, 'one acquisition across all three mounted consumers')
          .toEqual(rows.map(() => [1, recordsPerResolve]));
        const attempts = explicitWake ? 2 : 1;
        expect(afterFirstMinute, 'only demand for a replacement reading causes another attempt')
          .toEqual(rows.map(() => [attempts, attempts * recordsPerResolve]));
      }
      const afterMountHttp = home!.requests.length;
      for (let tick = 1; tick < 10; tick++) {
        if (hasPublication) {
          const selected = contentChanged ? rows.slice(0, 1) : rows;
          for (const row of selected) {
            const time = start + tick * minute;
            row.snapshot = { ...row.snapshot, fetchedAtMs: time, observedAtMs: time,
              subscription: { ...row.snapshot.subscription!, observedAtMs: time },
              meters: scenario === 'changed' || contentChanged ? row.snapshot.meters.map(meter => ({
                ...meter, used: 10 + tick, remaining: 90 - tick, utilizationPct: 10 + tick,
              })) : row.snapshot.meters };
          }
          publish(selected);
        }
        await advance(minute);
      }
      const counts = readCounts();
      const summarize = (values: number[][]) => [...new Set(values.map(value => value.join('/')))];
      console.info('quota-cadence', scenario, JSON.stringify({
        cold: summarize(cold), mountRoutes: [...new Set(mountRoutes)].map(route => [route, mountRoutes.filter(value => value === route).length]), minuteOne: summarize(afterFirstMinute), tenMinutes: summarize(counts),
      }));
      if (scenario === 'feed-after-read') {
        expect(counts.slice(1)).toEqual(rows.slice(1).map(() => [1, 1]));
        expect(counts[0]![0]).toBe(1);
        expect(counts[0]![1]).toBeGreaterThan(2);
      } else if (addressedWake) {
        const routes = home!.requests.slice(afterMountHttp).map(request => `${request.method} ${request.path}`);
        const afterMount = counts.map(([resolves, records], index) => [resolves! - cold[index]![0]!, records! - cold[index]![1]!]);
        expect(routes).toEqual(Array.from({ length: contentChanged ? 9 : 135 }, () => 'GET /v4/connect/qualified/provider-account-usage/record'));
        for (const openUIs of [1, 16]) {
          expect(afterMount.map(count => count.map(requests => requests * openUIs)),
            `one addressed GET per publication for ${openUIs} independently mounted UIs`)
            .toEqual(rows.map((_, index) => [0, !contentChanged || index === 0 ? 9 * openUIs : 0]));
        }
      } else {
        const attempts = hasPublication ? 10 : explicitWake ? 2 : 1;
        expect(counts).toEqual(rows.map(() => [attempts, attempts * recordsPerResolve]));
      }
      if (addressedWake || scenario === 'unchanged' || scenario === 'changed' || scenario === 'slow') {
        for (const entry of entries) {
          expect(entry.getSnapshot().pending).toBe('idle');
          const quota = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.quota!;
          const projected = new Map(quota.map(row => [row.current?.recordId, row.current]));
          for (const { snapshot } of rows) {
            expect(projected.get(snapshot.recordId)?.fetchedAtMs).toBe(snapshot.fetchedAtMs);
            expect(projected.get(snapshot.recordId)?.subscription).toEqual(snapshot.subscription);
            expect(projected.get(snapshot.recordId)?.meters[0]?.used).toBe(snapshot.meters[0]?.used);
          }
        }
      }
    } finally {
      releases.forEach(release => release());
      vi.useRealTimers();
    }
  });

  const quotaDeliveries = [
    ['material then clocks', [0, 1]],
    ['clocks then material', [1, 0]],
    ['material lost', [1]],
    ['clocks lost', [0]],
    ['duplicated', [0, 0, 1, 1]],
    ['material in the middle', [2, 0, 1]],
  ] as const;

  it.each((['primary', 'secondary'] as const).flatMap(homeKind =>
    quotaDeliveries.map(([caseName, delivery]) => ({ homeKind, caseName, delivery }))),
  )('matches a cold quota read on $homeKind Home when $caseName', async ({ homeKind, delivery }) => {
    const start = Date.now();
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'delivery-account' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const sample = (tick: number, used: number) => ProviderAccountUsageSnapshotV1Schema.parse({
      v: 1, recordId, recordKey, providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId },
      observedAtMs: start + tick, fetchedAtMs: start + tick, staleAfterMs: 60_000,
      source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      subscription: { status: 'subscribed', renewal: 'on', observedAtMs: start + tick, staleAfterMs: 5_000,
        currentPeriodStartAtMs: start, currentPeriodEndAtMs: start + 60_000,
        monetaryFacts: [{ kind: 'paid', currency: 'USD', amount: 20, effectiveAtMs: start, asOfMs: start,
          source: { kind: 'provider', id: 'fixture', version: '1' }, period: { startAtMs: start, endAtMs: start + 60_000 } }] },
      meters: [{ meterId: 'weekly', label: 'Weekly', used, limit: 100, remaining: 100 - used, utilizationPct: used,
        unit: 'requests', status: 'ok', resetsAt: start + 60_000, details: {} }],
    });
    let reading = sample(0, 40);
    const recordResponse = () => ({
      content: { t: 'plain' as const, v: reading },
      metadata: { fetchedAt: reading.fetchedAtMs, staleAfterMs: reading.staleAfterMs, status: 'ok' as const },
      sources: [source],
    });
    const captured = await context(async request => {
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        return Response.json({ source, recordId, providerAccountId: ref.accountId,
          fetchedAt: reading.fetchedAtMs, staleAfterMs: reading.staleAfterMs });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
        expect(request.url.searchParams.get('recordId')).toBe(recordId);
        return Response.json(recordResponse());
      }
      return undefined;
    }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    const { openProviderAccountUsageRecordV4, projectProviderAccountUsageQuotaReadV1 } =
      await import('@happier-dev/protocol/connect/providerAccountUsageHistory');
    const { projectProviderAccountSubscriptionMonetaryFacts } = await import('@happier-dev/protocol/connect/accountSubscription');
    const query = normalizeUsageQuery({ includeQuotaHistory: false, includeAccounting: false, includeCoach: false,
      includeSessionEvidence: false, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const release = entry.subscribe(() => {}, true);
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(0);
      await flushHookEffects({ cycles: 100 });
      await vi.advanceTimersByTimeAsync(0);
    };
    try {
      await settle();
      const mounted = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.quota![0]!;
      expect(mounted().current?.meters[0]?.used).toBe(40);
      vi.setSystemTime(start + 3_100);
      reading = sample(3_000, 70);
      const entityIds = buildProviderAccountUsageMaterialChangesV1(recordId).map(row => row.entityId);
      const { serverId } = captured.accountLifetime.scope;
      for (const index of delivery) {
        const precedingRequests = home!.requests.length;
        if (homeKind === 'secondary') {
          publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['account'], entityIds, sessionSystemRecords: [] },
            'socket');
        } else {
          publishHomeAccountChange(serverId, entityIds, { feedPageConsumed: true, changeKinds: ['account'],
            usageQueryAffects: true, usageAccountingAffects: false, providerAccountUsageRecordIds: [recordId] });
        }
        await settle();
        const routes = home!.requests.slice(precedingRequests).map(request => `${request.method} ${request.path}`);
        expect(routes).toEqual(['GET /v4/connect/qualified/provider-account-usage/record']);
        if (index === 1) expect(mounted().current?.meters[0]?.used).toBe(70);
      }
      const current = openProviderAccountUsageRecordV4({ recordId, accountMode: 'plain', record: recordResponse() });
      const cold = projectProviderAccountUsageQuotaReadV1({ input: { source }, current, nowMs: Date.now() });
      expect(mounted().current).toEqual(cold.current);
      expect(mounted().pace).toEqual(cold.pace);
      const price = (read: typeof cold) => projectProviderAccountSubscriptionMonetaryFacts({
        subscription: read.current?.subscription, nowMs: start + 6_500,
      }).paid;
      expect(price(cold)).toMatchObject({ amount: 20, currency: 'USD' });
      expect(price(mounted())).toEqual(price(cold));
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it('keeps mounted exact-history Pace equal to cold after consecutive quota observations (J-A29)', async () => {
    const { buildProviderAccountUsagePageProjectionV1, packProviderAccountUsagePageProjectionV1 } =
      await import('@happier-dev/protocol/connect/providerAccountUsagePageProjection');
    const day = 86_400_000;
    const start = Date.UTC(2026, 10, 24, 12);
    const startOfDay = Math.floor(start / day) * day;
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'exact-pace-account' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const sample = (observedAtMs: number, resetsAt: number) => ProviderAccountUsageSnapshotV1Schema.parse({
      v: 1, recordId, recordKey, providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId },
      observedAtMs, fetchedAtMs: observedAtMs, staleAfterMs: 60_000,
      source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'live', label: 'Live', used: 40, limit: 100, remaining: 60, utilizationPct: 40,
        unit: 'requests', status: 'ok', resetsAt, windowDurationMs: 60_000, details: {} }],
    });
    let current = sample(start + 1_100, start + 60_000);
    const prior = sample(startOfDay - 30_000, startOfDay);
    const record = (snapshot: typeof current) => ({ content: { t: 'plain' as const, v: snapshot },
      metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, status: 'ok' as const }, sources: [source] });
    const frontier = { id: 'earlier-study-point', observedAtMs: prior.observedAtMs };
    let exactReads = 0;
    const captured = await context(request => {
      if (request.path.endsWith('/sources/resolve')) return Response.json({ source, recordId, providerAccountId: ref.accountId,
        fetchedAt: current.fetchedAtMs, staleAfterMs: current.staleAfterMs });
      if (request.path.endsWith('/record')) return Response.json(record(current));
      if (request.path.endsWith('/day-summaries')) return Response.json({ summaries: [], missingDays: [] });
      if (request.path.endsWith('/history')) {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        if (request.method === 'GET' && 'projection' in query) {
          exactReads++;
          const demand = query.projection;
          const projection = buildProviderAccountUsagePageProjectionV1({ recordId, range: demand.range,
            history: { entries: [{ ...frontier, snapshot: prior }], nextCursor: null } });
          return Response.json({ projection: { recordId, demand, frontier, observationCount: 1,
            content: { t: 'plain', v: packProviderAccountUsagePageProjectionV1(projection) } }, complete: true },
          { headers: { etag: '"settled-exact-pace"' } });
        }
      }
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    const query = normalizeUsageQuery({ period: { startMs: startOfDay - day, endMs: startOfDay }, includeQuota: true,
      includeQuotaHistory: true, includeQuotaExactHistory: true, includeAccounting: false, includeCoach: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const input = { queries: [query] };
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(input) });
    vi.useFakeTimers();
    vi.setSystemTime(start + 3_500);
    const release = entry.subscribe(() => {}, true);
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(0);
      await flushHookEffects({ cycles: 150 });
      await vi.advanceTimersByTimeAsync(0);
      expect(entry.getSnapshot().pending).toBe('idle');
    };
    try {
      await settle();
      const mounted = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.quota![0]!;
      expect(mounted().current?.observedAtMs).toBe(start + 1_100);
      expect(exactReads).toBeGreaterThan(0);
      expect(mounted().pace[0]?.value).toMatchObject({ status: 'available', elapsedFraction: 1_100 / 60_000 });
      const { serverId } = captured.accountLifetime.scope;
      const entityIds = buildProviderAccountUsageMaterialChangesV1(recordId).map(change => change.entityId);
      for (const at of [2_100, 3_100]) {
        const beforeWake = home!.requests.length;
        current = sample(start + at, start + 60_000);
        publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['account'], entityIds, sessionSystemRecords: [] },
          'socket');
        await settle();
        const routes = home!.requests.slice(beforeWake).map(request => `${request.method} ${request.path}`);
        expect(routes.filter(route => route.endsWith('/provider-account-usage/record')))
          .toEqual(['GET /v4/connect/qualified/provider-account-usage/record']);
        expect(routes).not.toContain('GET /v4/connect/qualified/provider-account-usage/sources/resolve');
        console.info('quota-exact-wake-routes', JSON.stringify(routes));
        expect(mounted().current?.observedAtMs).toBe(current.observedAtMs);
      }
      const cold = (await readUiUsageQueryBatch(captured, input)).results[0]!.quota![0]!;
      expect(cold.pace[0]?.value).toMatchObject({ status: 'available', elapsedFraction: 3_100 / 60_000 });
      expect(cold.current).toEqual(mounted().current);
      expect(mounted().pace).toEqual(cold.pace);
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it('projects an ended cycle after a service-binding wake with the same fixed range and head (J-A46)', async () => {
    const { buildProviderAccountUsagePageProjectionV1, packProviderAccountUsagePageProjectionV1 } =
      await import('@happier-dev/protocol/connect/providerAccountUsagePageProjection');
    const opening = Date.UTC(2026, 10, 25, 12);
    const resetAtMs = opening + 100;
    const range = { startAtMs: opening - 1_000, endAtMs: opening + 1_000 };
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'fixed-range' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const head = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId, recordKey,
      accountSubject: { kind: 'providerSubject', id: ref.accountId }, providerId: 'codex',
      observedAtMs: opening - 100, fetchedAtMs: opening - 100, staleAfterMs: 60_000, source: 'providerHttp',
      confidence: 'confirmed', state: 'loaded_data', meters: [{ meterId: 'quota', label: 'Quota', used: 40, limit: 100,
        utilizationPct: 40, unit: 'requests', status: 'ok', resetsAt: resetAtMs, windowDurationMs: 60_000, details: {} }] });
    const frontier = { id: 'fixed-observation', observedAtMs: head.fetchedAtMs };
    const demand = { range, resolution: 'accepted_observations' as const };
    const projection = buildProviderAccountUsagePageProjectionV1({ recordId, range,
      history: { entries: [{ ...frontier, snapshot: head }], nextCursor: null } });
    const metadata = { fetchedAt: head.fetchedAtMs, staleAfterMs: head.staleAfterMs, status: 'ok' };
    const captured = await context(request => {
      if (request.path.endsWith('/sources/resolve')) return Response.json({ source, recordId, providerAccountId: ref.accountId,
        fetchedAt: metadata.fetchedAt, staleAfterMs: metadata.staleAfterMs });
      if (request.path.endsWith('/record')) return Response.json({ content: { t: 'plain', v: head }, metadata, sources: [source] });
      if (request.path.endsWith('/day-summaries')) return Response.json({ summaries: [], missingDays: [] });
      if (request.path.endsWith('/history')) return Response.json({ projection: { recordId, demand, frontier, observationCount: 1,
        content: { t: 'plain', v: packProviderAccountUsagePageProjectionV1(projection) } }, complete: true });
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    const query = normalizeUsageQuery({ period: { startMs: range.startAtMs, endMs: range.endAtMs }, includeQuota: true,
      includeQuotaHistory: true, includeQuotaExactHistory: true, includeAccounting: false, includeCoach: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const input = { queries: [query] };
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(input) });
    vi.useFakeTimers();
    vi.setSystemTime(opening);
    const release = entry.subscribe(() => {}, true);
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(0);
      await flushHookEffects({ cycles: 150 });
      await vi.advanceTimersByTimeAsync(0);
      expect(entry.getSnapshot().pending).toBe('idle');
    };
    const mounted = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.quota![0]!;
    try {
      await settle();
      expect(mounted().pageFacts?.historyStatus).toBe('complete');
      expect(mounted().unusedCapacity?.windows).toEqual([]);
      expect(mounted().current?.fetchedAtMs).toBe(head.fetchedAtMs);
      vi.setSystemTime(resetAtMs + 100);
      const beforeWake = home!.requests.length;
      publishHomeAccountChangeWake(captured.accountLifetime.scope.serverId, { t: 'account-change', changeKinds: ['account'],
        entityIds: [buildConnectedServicesAccountChangeV1(ref.service).entityId], sessionSystemRecords: [] }, 'socket');
      await settle();
      const resolvedRoutes = home!.requests.slice(beforeWake).filter(request =>
        request.path.endsWith('/sources/resolve') || request.path.endsWith('/record')).map(request => request.path.split('/').at(-1));
      const cold = (await readUiUsageQueryBatch(captured, input)).results[0]!.quota![0]!;
      expect(cold.unusedCapacity?.windows.map(value => value.window.resetAtMs)).toEqual([resetAtMs]);
      expect.soft(mounted().unusedCapacity).toEqual(cold.unusedCapacity);
      expect.soft(resolvedRoutes).toEqual(['resolve', 'record']);
      expect(mounted().current?.fetchedAtMs).toBe(head.fetchedAtMs);
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it('reads only the changed allowance record and keeps unscoped recovery full', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    let changes: ApiChangeEntry[] = [];
    let cursor = 0;
    const refs = ['one', 'two', 'three'].map(accountId => ({
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId }));
    const sources = refs.map(ref => ({ bindingKind: 'account' as const, ref }));
    const snapshots = refs.map(ref => {
      const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
      return ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
        staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
        meters: [{ meterId: 'session', label: 'Session', used: 10, limit: 100, remaining: 90, utilizationPct: 10,
          unit: 'requests', status: 'ok', resetsAt: now + 1800_000, details: {} }] });
    });
    const initialRecordIds = snapshots.map(snapshot => snapshot.recordId);
    const captured = await context(async request => {
      if (request.path === '/v2/changes') return Response.json({ changes: changes.filter(row => row.cursor > Number(request.url.searchParams.get('after'))), nextCursor: cursor });
      if (request.path === '/v2/cursor') return Response.json({ cursor, changesFloor: 0 });
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v4/connect/qualified/quotas') {
        const index = refs.findIndex(ref => request.url.searchParams.get('ref')?.includes(ref.accountId));
        return Response.json({ ref: refs[index], sourceResolution: { source: sources[index], recordId: snapshots[index]!.recordId,
          providerAccountId: snapshots[index]!.recordKey.accountSubjectId, fetchedAt: now, staleAfterMs: 600_000 },
          content: { t: 'plain', v: { v: 1, ref: refs[index], activeAccountId: snapshots[index]!.recordKey.accountSubjectId,
            fetchedAt: now, staleAfterMs: 600_000, planLabel: null, accountLabel: null, meters: [] } },
          metadata: { fetchedAt: now, staleAfterMs: 600_000, status: 'ok' } });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        const source = JSON.parse(request.url.searchParams.get('source')!);
        const index = refs.findIndex(ref => ref.accountId === source.ref.accountId);
        return Response.json({ source: sources[index], recordId: snapshots[index]!.recordId,
          providerAccountId: snapshots[index]!.recordKey.accountSubjectId, fetchedAt: now, staleAfterMs: 600_000 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
        const index = snapshots.findIndex(snapshot => snapshot.recordId === request.url.searchParams.get('recordId'));
        return Response.json({ content: { t: 'plain', v: snapshots[index] },
          metadata: { fetchedAt: now, staleAfterMs: 600_000, status: 'ok' }, sources: [sources[index]] });
      }
      return undefined;
    }, { connectedAccountsV4: refs.map(ref => ({ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] })) });
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const basis = getActiveServerSnapshot();
    const credentialScope = resolveAuthCredentialsScopeKey(captured.credentials);
    const quotaContexts = refs.map(ref => ({ credentials: captured.credentials, ref,
      serverBasis: { serverId: basis.serverId, generation: basis.generation },
      credentialScope: [basis.serverId, String(basis.generation), credentialScope].join('\u0000') }));
    for (const quotaContext of quotaContexts) loadQualifiedQuotaSnapshotOnce(buildQualifiedQuotaSnapshotScopeKey(quotaContext), quotaContext);
    await expect.poll(() => quotaContexts.every(quotaContext => getQualifiedQuotaSnapshotEntry(buildQualifiedQuotaSnapshotScopeKey(quotaContext)).read)).toBe(true);
    const query = normalizeUsageQuery({ includeQuotaHistory: false, includeAccounting: false,
      includeSessionEvidence: false, includeWorkEvidence: false });
    const chartQuery = normalizeUsageQuery({ period: { startMs: now - 600_000, endMs: now }, includeQuota: false,
      includeSessionEvidence: false, includeWorkEvidence: false, includeComparison: false, includeCoach: false });
    const privateChartQuery = normalizeUsageQuery({ ...chartQuery, includeSessionEvidence: true });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query, chartQuery, privateChartQuery] }) });
    const chartKey = getUsageQueryKey(chartQuery);
    const privateChartKey = getUsageQueryKey(privateChartQuery);
    let chartChanges = 0;
    let privateChartChanges = 0;
    let shownChart: ReturnType<typeof decodeUsageQueryResource>['results'][number] | undefined;
    let shownPrivateChart: typeof shownChart;
    const release = entry.subscribe(() => {
      const content = entry.getSnapshot().value;
      if (!content) return;
      const slices = decodeUsageQueryResource(content).results;
      const chart = slices.find(slice => slice.key === chartKey);
      if (chart !== shownChart) { shownChart = chart; chartChanges++; }
      const privateChart = slices.find(slice => slice.key === privateChartKey);
      if (privateChart !== shownPrivateChart) { shownPrivateChart = privateChart; privateChartChanges++; }
    }, true);
    const counts = () => refs.map((ref, index) => ({
      resolves: home!.requests.filter(request => request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve'
        && JSON.parse(request.url.searchParams.get('source')!).ref.accountId === ref.accountId).length,
      records: home!.requests.filter(request => request.path === '/v4/connect/qualified/provider-account-usage/record'
        && [initialRecordIds[index], snapshots[index]!.recordId].includes(request.url.searchParams.get('recordId')!)).length,
    }));
    const quota = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.quota!;
    try {
      await entry.refresh();
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      let before = counts();
      snapshots[1] = { ...snapshots[1]!, meters: snapshots[1]!.meters.map(meter => ({ ...meter, used: 30, remaining: 70, utilizationPct: 30 })) };
      changes = [
        { kind: 'account', entityId: 'provider-account-usage', cursor: ++cursor, changedAt: now,
          hint: { providerAccountUsageRecordId: snapshots[1]!.recordId } },
        { kind: 'account', entityId: `provider-account-usage-record:${snapshots[1]!.recordId}`, cursor: ++cursor, changedAt: now },
      ];
      await sync.resumeSync('socket-reconnect');
      await expect.poll(() => quota().find(row => row.source.bindingKind === 'account' && row.source.ref.accountId === 'two')?.current?.meters[0]?.used).toBe(30);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(counts()).toEqual(before.map((count, index) => ({ resolves: count.resolves, records: count.records + (index === 1 ? 1 : 0) })));
      expect(quota()).toHaveLength(3);
      before = counts();
      const providerScope = buildProviderAccountUsageScopeKey({ serverId: basis.serverId,
        generation: basis.generation, credentialScope });
      // A concurrent provider surface publishes through the real shared cache.
      // Its known row change must retain the same scope as a focused Home push.
      chartChanges = 0;
      privateChartChanges = 0;
      clock.mockReturnValue(now + 1);
      snapshots[1] = { ...snapshots[1]!, observedAtMs: now + 1 };
      updateProviderAccountUsageCacheEntries(providerScope, entries => ({ ...entries, [snapshots[1]!.recordId]: {
        snapshot: snapshots[1]!, loading: false, hadError: false, nextFetchAtMs: now + 600_000,
      } }));
      await expect.poll(() => quota().find(row => row.source.bindingKind === 'account' && row.source.ref.accountId === 'two')?.current?.observedAtMs).toBe(now + 1);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(counts(), 'A local cache change reacquires only its admitted record').toEqual(before.map((count, index) => ({
        resolves: count.resolves, records: count.records + (index === 1 ? 1 : 0),
      })));
      expect(chartChanges, 'provider read status and observation clocks change no accounting chart facts').toBe(0);
      expect(privateChartChanges, 'an allowance read changes no admitted Session chart facts').toBe(0);
      before = counts();
      const remappedKey = { ...snapshots[1]!.recordKey, accountSubjectId: 'two-remapped' };
      snapshots[1] = ProviderAccountUsageSnapshotV1Schema.parse({ ...snapshots[1], recordKey: remappedKey,
        recordId: buildProviderAccountUsageRecordId(remappedKey), accountSubject: { kind: 'providerSubject', id: 'two-remapped' } });
      await reloadQualifiedQuotaSnapshotAfterRecovery(quotaContexts[1]!);
      await expect.poll(() => quota().find(row => row.source.bindingKind === 'account' && row.source.ref.accountId === 'two')?.current?.recordId).toBe(snapshots[1]!.recordId);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(counts(), 'A local admission remap preserves both record identities without reacquiring its siblings').toEqual(before.map((count, index) => ({
        resolves: count.resolves, records: count.records + (index === 1 ? 1 : 0),
      })));
      before = counts();
      for (const index of [0, 2]) snapshots[index] = { ...snapshots[index]!,
        meters: snapshots[index]!.meters.map(meter => ({ ...meter, used: 50, remaining: 50, utilizationPct: 50 })) };
      // The global row coalesces to the latest write; both record rows survive.
      changes = [
        { kind: 'account', entityId: `provider-account-usage-record:${snapshots[0]!.recordId}`, cursor: ++cursor, changedAt: now },
        { kind: 'account', entityId: 'provider-account-usage', cursor: ++cursor, changedAt: now,
          hint: { providerAccountUsageRecordId: snapshots[2]!.recordId } },
        { kind: 'account', entityId: `provider-account-usage-record:${snapshots[2]!.recordId}`, cursor: ++cursor, changedAt: now },
      ];
      await sync.resumeSync('socket-reconnect');
      await expect.poll(() => quota().filter(row => row.current?.meters[0]?.used === 50).length).toBe(2);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(counts()).toEqual(before.map((count, index) => ({ resolves: count.resolves, records: count.records + (index !== 1 ? 1 : 0) })));
      before = counts();
      for (let arrival = 0; arrival < 30; arrival++) publishHomeAccountChange(captured.accountLifetime.scope.serverId,
        ['unrelated-session'], { changeKinds: ['session'], usageAccountingAffects: false });
      await flushHookEffects({ cycles: 20 });
      expect(counts()).toEqual(before);
      for (const recovery of ['legacy', 'snapshot'] as const) {
        before = counts();
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, recovery === 'legacy' ? ['provider-account-usage'] : undefined,
          recovery === 'legacy' ? { changeKinds: ['account'] } : { source: 'snapshot' });
        await expect.poll(() => counts()).toEqual(before.map(count => ({ resolves: count.resolves + 1, records: count.records + 1 })));
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      }
    } finally { release(); }
  });

  it('reacquires only named quota sources on a record wake and reuses daily history across Source and period changes', async () => {
    const { buildProviderAccountUsageDaySummaryV1 } = await import('@happier-dev/protocol/connect/providerAccountUsageDaySummary');
    const now = Date.now();
    const day = 86_400_000;
    const olderDay = Math.floor(now / day) * day - 400 * day;
    const refs = Array.from({ length: 8 }, (_, index) => ({
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: `quota-${index}`,
    }));
    const sources = refs.map(ref => ({ bindingKind: 'account' as const, ref }));
    const snapshots = refs.map(ref => {
      const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account' as const, quotaScope: 'account' as const };
      return ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
        staleAfterMs: day, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
        meters: [{ meterId: 'daily', label: 'Daily', used: 10, limit: 100, remaining: 90, utilizationPct: 10,
          resetsAt: now + day / 2, windowDurationMs: day, unit: 'count', status: 'ok', details: {} }] });
    });
    const observations = (snapshot: typeof snapshots[number]) => [olderDay + 3_600_000, now - 3_600_000, now].map((observedAtMs, index) => {
      const used = index === 2 ? snapshot.meters[0]!.used! : 4;
      return { id: `quota-${observedAtMs}`, observedAtMs, snapshot: {
        ...snapshot, observedAtMs, fetchedAtMs: observedAtMs,
        meters: snapshot.meters.map(meter => ({ ...meter, used, remaining: 100 - used, utilizationPct: used,
          resetsAt: index === 0 ? olderDay + day : meter.resetsAt })),
      } };
    });
    const historyReads = new Map(snapshots.map(snapshot => [snapshot.recordId, 0]));
    const summaryReads = new Map(snapshots.map(snapshot => [snapshot.recordId, 0]));
    const captured = await context(async request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: { connectedServices: { enabled: true, quotas: { enabled: true } } } }));
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v4/connect/qualified/quotas') {
        const index = refs.findIndex(ref => request.url.searchParams.get('ref')?.includes(ref.accountId));
        return Response.json({ ref: refs[index], sourceResolution: { source: sources[index], recordId: snapshots[index]!.recordId,
          providerAccountId: refs[index]!.accountId, fetchedAt: now, staleAfterMs: day },
          content: { t: 'plain', v: { v: 1, ref: refs[index], activeAccountId: refs[index]!.accountId, fetchedAt: now,
            staleAfterMs: day, planLabel: null, accountLabel: null, meters: snapshots[index]!.meters } },
          metadata: { fetchedAt: now, staleAfterMs: day, status: 'ok' } });
      }
      if (request.path.endsWith('/sources/resolve')) {
        const source = JSON.parse(request.url.searchParams.get('source')!);
        const index = refs.findIndex(ref => ref.accountId === source.ref.accountId);
        return Response.json({ source: sources[index], recordId: snapshots[index]!.recordId, providerAccountId: refs[index]!.accountId, fetchedAt: now, staleAfterMs: day });
      }
      if (request.path.endsWith('/record')) {
        const recordId = request.url.searchParams.get('recordId')!;
        const index = snapshots.findIndex(snapshot => snapshot.recordId === recordId);
        return Response.json({ content: { t: 'plain', v: snapshots[index] }, metadata: { fetchedAt: now, staleAfterMs: day, status: 'ok' }, sources: [sources[index]] });
      }
      if (request.path.endsWith('/day-summaries')) {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(ProviderAccountUsageDaySummaryReadV1Schema,
          request.url.searchParams.get('query'));
        const recordId = query.recordId;
        summaryReads.set(recordId, (summaryReads.get(recordId) ?? 0) + 1);
        const rows = observations(snapshots.find(candidate => candidate.recordId === recordId)!);
        const summaries = [...new Set(rows.map(row => Math.floor(row.observedAtMs / day) * day))].map(dayStartAtMs => {
          const dayRows = rows.filter(row => row.observedAtMs >= dayStartAtMs && row.observedAtMs < dayStartAtMs + day);
          const frontier = dayRows.at(-1)!;
          return { dayStartAtMs, payload: { v: 1, coverage: { observationCount: dayRows.length,
            frontier: { id: frontier.id, observedAtMs: frontier.observedAtMs } },
            content: { t: 'plain', v: buildProviderAccountUsageDaySummaryV1({ recordId, dayStartAtMs, snapshots: dayRows.map(row => row.snapshot) }) } } };
        });
        const range = query.range;
        return Response.json({ summaries: range ? summaries.filter(({ dayStartAtMs }) =>
          dayStartAtMs < range.endAtMs && dayStartAtMs + day > range.startAtMs) : summaries, missingDays: [] });
      }
      if (request.path.endsWith('/history')) {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        const recordId = query.recordId;
        if (!('history' in query)) throw new Error('Unexpected projection request for daily quota');
        historyReads.set(recordId, (historyReads.get(recordId) ?? 0) + 1);
        const index = snapshots.findIndex(snapshot => snapshot.recordId === recordId);
        const { startAtMs, endAtMs } = query.history.range;
        const entries = observations(snapshots[index]!).filter(row => row.observedAtMs >= startAtMs && row.observedAtMs < endAtMs)
          .map(row => ({ id: row.id, observedAtMs: row.observedAtMs, record: { content: { t: 'plain', v: row.snapshot },
            metadata: { fetchedAt: row.observedAtMs, staleAfterMs: day, status: 'ok' }, sources: [sources[index]] } }));
        return new Response(JSON.stringify({ entries, nextCursor: null }) + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
      }
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    }, { connectedAccountsV4: refs.map(ref => ({ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] })) });
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const basis = getActiveServerSnapshot();
    const credentialScope = resolveAuthCredentialsScopeKey(captured.credentials);
    const quotaContexts = refs.map(ref => ({ credentials: captured.credentials, ref,
      serverBasis: { serverId: basis.serverId, generation: basis.generation }, credentialScope: [basis.serverId, String(basis.generation), credentialScope].join('\u0000') }));
    for (const quotaContext of quotaContexts) loadQualifiedQuotaSnapshotOnce(buildQualifiedQuotaSnapshotScopeKey(quotaContext), quotaContext);
    await expect.poll(() => quotaContexts.every(quotaContext => getQualifiedQuotaSnapshotEntry(buildQualifiedQuotaSnapshotScopeKey(quotaContext)).read)).toBe(true);
    const query = normalizeUsageQuery({ period: { relative: 'year' }, includeAccounting: true, includeQuota: true, includeQuotaHistory: true,
      includeQuotaExactHistory: false, includeComparison: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const store = getUsageQueryResourceStore(captured);
    const entryFor = (query: ReturnType<typeof normalizeUsageQuery>) => store.getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const entry = entryFor(query);
    const release = entry.subscribe(() => {}, true);
    const settledQuota = async (target: typeof entry) => {
      await expect.poll(() => target.getSnapshot().value !== undefined && target.getSnapshot().pending === 'idle').toBe(true);
      expect(target.getSnapshot().error).toBeUndefined();
      return decodeUsageQueryResource(target.getSnapshot().value!).results[0]?.quota?.[0];
    };
    const reads = () => snapshots.map(snapshot => ({ history: historyReads.get(snapshot.recordId)!, summaries: summaryReads.get(snapshot.recordId)! }));
    try {
      const year = await settledQuota(entry);
      expect(year?.current?.meters[0]?.used).toBe(10);
      expect(year?.pace[0]?.value).toMatchObject({ status: 'available', sampleCount: 2 });
      const yearDays = year?.pageFacts?.dayQuotaHistory?.map(day => day.dayStartAtMs) ?? [];
      expect(yearDays.length).toBeGreaterThan(0);
      expect(yearDays).not.toContain(olderDay);
      const acceptedReads = [...historyReads.values()];
      expect(acceptedReads.every(count => count > 0)).toBe(true);

      const selectedSource = normalizeUsageQuery({ ...query, sources: ['codex'] });
      const all = normalizeUsageQuery({ ...selectedSource, period: { relative: 'all' } });
      for (const [requested, days] of [[selectedSource, yearDays], [all, [olderDay, ...yearDays]]] as const) {
        const presented = entryFor(requested);
        const releasePresented = presented.subscribe(() => {}, true);
        try {
          const quota = await settledQuota(presented);
          expect.soft(quota?.pageFacts?.dayQuotaHistory?.map(day => day.dayStartAtMs)).toEqual(days);
          expect.soft(quota?.pace).toEqual(year?.pace);
          expect.soft([...historyReads.values()], 'An unchanged quota admission reuses its already accepted raw history').toEqual(acceptedReads);
        } finally { releasePresented(); }
      }
      await entry.refresh();
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const baseline = reads();
      // M68 quota traffic came from feed pages mixing an ordinary Team wake
      // with named record changes. A Team-only page must cost no allowance reads.
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1],
        { feedPageConsumed: true, changeKinds: ['account'], usageQueryAffects: true, usageAccountingAffects: false });
      await flushHookEffects({ cycles: 20 });
      expect(reads()).toEqual(baseline);
      for (const index of [0, 1, 2, 3]) {
        const snapshot = snapshots[index]!;
        snapshots[index] = { ...snapshot, meters: snapshot.meters.map(meter => ({ ...meter, used: 20 + index, remaining: 80 - index, utilizationPct: 20 + index })) };
        const page = buildProviderAccountUsageMaterialChangesV1(snapshots[index]!.recordId).map((change, offset) => ({ ...change, cursor: index * 2 + offset + 1 }));
        const changes = [
          ...page,
          ...(index === 0 ? [{ kind: 'account', entityId: TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1, cursor: 90 }] : []),
          { kind: 'account', entityId: 'home-governance', cursor: 100 + index },
          { kind: 'account', entityId: `c8e100dc-0565-4c09-9bc9-a02222cfbc${String(index).padStart(2, '0')}`, cursor: 200 + index },
          { kind: 'machine', entityId: `machine-${index}`, cursor: 300 + index },
        ];
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, changes.map(change => change.entityId),
          { feedPageConsumed: true, changeKinds: ['account', 'machine'], usageQueryAffects: true, usageAccountingAffects: false,
            providerAccountUsageRecordIds: readProviderAccountUsageChangedRecordIdsV1(changes) });
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      }
      const after = reads();
      expect(after.map((count, index) => ({ history: count.history - baseline[index]!.history, summaries: count.summaries - baseline[index]!.summaries })))
        .toEqual([{ history: 1, summaries: 1 }, { history: 1, summaries: 1 }, { history: 1, summaries: 1 }, { history: 1, summaries: 1 },
          { history: 0, summaries: 0 }, { history: 0, summaries: 0 }, { history: 0, summaries: 0 }, { history: 0, summaries: 0 }]);
    } finally { release(); }
  });

  it('keeps one Capacity and Usage allowance timeline across arrivals, navigation, rereads and failure', async () => {
    const { readPlanAccountsStatement, readPendingPlanAccountCount } = await import('@/components/settings/usage/widgets/plans/UsagePlanParts');
    const { useUsagePlans } = await import('@/components/settings/usage/widgets/plans/useUsagePlans');
    const { UsageCapacityWidget } = await import('@/components/settings/usage/widgets/UsageCapacityWidget');
    const { installConnectedAccountDescriptorProjection } = await import('@/sync/domains/connectedServices/connectedServiceRegistry');
    const now = Date.now();
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const refs = ['work', 'personal', 'unread'].map(accountId => ({ service, accountId }));
    const connectedRefs = [...refs, { service: { pluginId: 'acme.email', localId: 'email' }, accountId: 'mail' }];
    const sources = refs.map(ref => ({ bindingKind: 'account' as const, ref }));
    const gates = refs.map(() => createDeferred<void>());
    const records = refs.map((ref, index) => {
      const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
      return ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId },
        observedAtMs: index === 2 ? 0 : now, fetchedAtMs: index === 2 ? 0 : now, staleAfterMs: 600_000,
        source: 'providerHttp', confidence: 'confirmed', state: index === 2 ? 'not_loaded' : 'loaded_data',
        meters: index === 2 ? [] : [{ meterId: 'session', label: 'Session', used: 40 + index * 10, limit: 100,
          remaining: 60 - index * 10, utilizationPct: 40 + index * 10, unit: 'requests', status: 'ok',
          resetsAt: now + 1800_000, windowDurationMs: 3600_000, details: {} }] });
    });
    let holdHistory = false;
    let failHistory = false;
    let historyGate = createDeferred<void>();
    let historyHeld = 0;
    const captured = await context(async request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v4/connect/qualified/quotas') {
        const ref = refs[2]!, record = records[2]!;
        return Response.json(QualifiedConnectedAccountQuotaResponseV4Schema.parse({ ref,
          sourceResolution: { source: sources[2], recordId: record.recordId, providerAccountId: ref.accountId,
            fetchedAt: 0, staleAfterMs: 600_000 },
          content: { t: 'plain', v: { v: 1, ref, activeAccountId: ref.accountId, fetchedAt: 0,
            staleAfterMs: 600_000, planLabel: null, accountLabel: null, meters: [] } },
          metadata: { fetchedAt: 0, staleAfterMs: 600_000, status: 'unavailable' } }));
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        const raw = JSON.parse(request.url.searchParams.get('source')!);
        const index = refs.findIndex(ref => ref.accountId === raw.ref.accountId);
        await gates[index]!.promise;
        return Response.json({ source: sources[index], recordId: records[index]!.recordId,
          providerAccountId: refs[index]!.accountId, fetchedAt: now, staleAfterMs: 600_000 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
        const record = records.find(record => record.recordId === request.url.searchParams.get('recordId'))!;
        return Response.json({ content: { t: 'plain', v: record },
          metadata: { fetchedAt: record.fetchedAtMs, staleAfterMs: 600_000, status: 'ok' }, sources });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
        if (holdHistory) { historyHeld++; await historyGate.promise; }
        if (failHistory) return new Response('unavailable', { status: 404 });
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        const record = records.find(record => record.recordId === query.recordId)!;
        return Response.json({ entries: record.state === 'not_loaded' ? [] : [900_000, 600_000].map((age, index) => {
          const observedAtMs = now - age;
          return { id: `${record.recordKey.accountSubjectId}-${index}`, observedAtMs, record: {
            content: { t: 'plain', v: { ...record, observedAtMs, fetchedAtMs: observedAtMs,
              meters: record.meters.map(meter => ({ ...meter, used: 10 + index * 10, remaining: 90 - index * 10, utilizationPct: 10 + index * 10 })) } },
            metadata: { fetchedAt: observedAtMs, staleAfterMs: 600_000, status: 'ok' }, sources } };
        }), nextCursor: null });
      }
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    }, { connectedAccountsV4: connectedRefs.map(ref => ({ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] })) });
    storage.setState({ profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId,
      connectedAccountsV4: connectedRefs.map(ref => ({ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] })) }) });
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const query = normalizeUsageQuery({ period: { startMs: now - 86_400_000, endMs: now }, includeSessionEvidence: false, includeWorkEvidence: false });
    const store = getUsageQueryResourceStore(captured);
    const homeEntry = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const releaseHome = homeEntry.subscribe(() => {}, false);
    const sliceOf = (entry: typeof homeEntry) => decodeUsageQueryResource(entry.getSnapshot().value!).results.find(slice => slice.key === getUsageQueryKey(query))!;
    const projectionOf = (entry: typeof homeEntry) => { const slice = sliceOf(entry); return projectUsagePlans(slice.quota, now, slice.pools, slice.sources); };
    const renderBody = async (entry: typeof homeEntry) => {
      const slice = sliceOf(entry);
      const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null, freshness: 'fresh',
        updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
      return await renderScreen(React.createElement(InjectedAuthProvider, { credentials: captured.credentials,
        children: React.createElement(UsageCapacityWidget, { id: 'usage_capacity', model, slice, query,
          serverId: captured.accountLifetime.scope.serverId, testID: 'timeline' }) }));
    };
    try {
      await expect.poll(() => homeEntry.getSnapshot().value && projectionOf(homeEntry).accounts.length).toBe(3);
      expect(projectionOf(homeEntry).accounts.map(account => account.accountId)).toEqual(['work', 'personal', 'unread']);
      expect(projectionOf(homeEntry).readAccountCount).toBe(0);
      expect(readPendingPlanAccountCount(projectionOf(homeEntry).accounts)).toBe(3);
      const cold = await renderBody(homeEntry);
      expect(cold.findHostByTestId('timeline.reading')).not.toBeNull();
      refs.forEach(ref => expect(cold.findHostByTestId(`timeline.cell.${ref.accountId}`)).toBeNull());
      gates[0]!.resolve();
      await expect.poll(() => projectionOf(homeEntry).accounts[0]?.observedAtMs).toBe(now);
      expect(projectionOf(homeEntry).tightest).toMatchObject({ provisional: true, window: { remainingFraction: 0.6 } });
      expect(readPendingPlanAccountCount(projectionOf(homeEntry).accounts)).toBe(2);
      expect((await renderBody(homeEntry)).findHostByTestId('timeline.tightest')).not.toBeNull();
      gates[1]!.resolve();
      await expect.poll(() => projectionOf(homeEntry).accounts[1]?.observedAtMs).toBe(now);
      expect(readPendingPlanAccountCount(projectionOf(homeEntry).accounts)).toBe(1);
      // Live L22: current facts arrive before history; a Home rebind aborts
      // that read, then opens an unhydrated-cache revision before new HTTP
      // current/history pages. The unanswered usage-capable source must not disappear
      // and briefly fabricate a settled comparison between those revisions.
      holdHistory = true;
      gates[2]!.resolve(); // The host answers with an addressable placeholder; the vendor never observed this account.
      await expect.poll(() => historyHeld).toBe(1);
      await expect.poll(() => sliceOf(homeEntry).quota?.length).toBe(3);
      expect(projectionOf(homeEntry).tightest).toMatchObject({ provisional: true, window: { remainingFraction: 0.5 } });
      releaseHome();
      const resumedProjections: ReturnType<typeof projectionOf>[] = [];
      const releaseResumedHome = homeEntry.subscribe(() => {
        if (homeEntry.getSnapshot().value) resumedProjections.push(projectionOf(homeEntry));
      }, false);
      await expect.poll(() => historyHeld).toBeGreaterThan(1);
      expect(resumedProjections.length).toBeGreaterThan(0);
      for (const revision of resumedProjections) {
        expect.soft(revision.tightest, 'an unanswered source keeps the observed headline provisional during a Home rebind')
          .toMatchObject({ provisional: true, window: { remainingFraction: 0.5 } });
        expect.soft(readPendingPlanAccountCount(revision.accounts)).toBe(1);
      }
      releaseResumedHome();
      // Usage can hydrate the same cache with an addressable but unobserved
      // usage-capable placeholder. That is still no replacement for its pending read.
      const basis = getActiveServerSnapshot();
      const credentialsKey = resolveAuthCredentialsScopeKey(captured.credentials);
      const quotaContext = { credentials: captured.credentials, ref: refs[2]!,
        serverBasis: { serverId: basis.serverId, generation: basis.generation },
        credentialScope: [basis.serverId, String(basis.generation), credentialsKey].join('\u0000') };
      const quotaKey = buildQualifiedQuotaSnapshotScopeKey(quotaContext);
      loadQualifiedQuotaSnapshotOnce(quotaKey, quotaContext);
      await expect.poll(() => getQualifiedQuotaSnapshotEntry(quotaKey).usageRecordId).toBe(records[2]!.recordId);
      const providerScope = buildProviderAccountUsageScopeKey({ serverId: basis.serverId,
        generation: basis.generation, credentialScope: credentialsKey });
      updateProviderAccountUsageCacheEntries(providerScope, entries => ({ ...entries, [records[2]!.recordId]: {
        snapshot: records[2]!, loading: false, hadError: false, nextFetchAtMs: now + 600_000 } }));
      const placeholderProjections: typeof resumedProjections = [];
      const releasePlaceholderHome = homeEntry.subscribe(() => {
        if (homeEntry.getSnapshot().value) placeholderProjections.push(projectionOf(homeEntry));
      }, false);
      const heldBeforePlaceholder = historyHeld;
      await expect.poll(() => historyHeld).toBeGreaterThan(heldBeforePlaceholder);
      expect(placeholderProjections.length).toBeGreaterThan(0);
      for (const revision of placeholderProjections) {
        expect.soft(revision.tightest, 'an unobserved cache row cannot settle a pending Action read')
          .toMatchObject({ provisional: true, window: { remainingFraction: 0.5 } });
        expect.soft(readPendingPlanAccountCount(revision.accounts)).toBe(1);
      }
      holdHistory = false; historyGate.resolve();
      await expect.poll(() => homeEntry.getSnapshot().pending).toBe('idle');
      const settled = projectionOf(homeEntry);
      expect.soft(settled.tightest?.window.remainingFraction).toBe(0.5);
      const plans = await renderHook(() => useUsagePlans(sliceOf(homeEntry), async () => {}), {
        wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials: captured.credentials, children }),
      });
      expect.soft(readPlanAccountsStatement(settled.accounts, plans.getCurrent().nameOf)?.kind).toBe('partial');
      expect.soft(usageCoverageSummary(sliceOf(homeEntry), ['quota'])).toBe('Partial history');
      installConnectedAccountDescriptorProjection({ scopeKey: 'timeline', status: 'ready', conflicts: [], errorReason: null,
        descriptors: [{ id: 'email', serviceId: 'email', pluginId: 'acme.email', title: 'Email IMAP + SMTP', provenance: 'external',
          sourceKind: 'installed', authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual',
            outcomeReconciliation: 'none', fields: [] }] }, capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [] }] }, captured.accountLifetime);
      await plans.rerender();
      expect.soft(plans.getCurrent().projection.accounts.map(account => account.accountId)).toEqual(['work', 'personal', 'unread']);
      expect.soft(plans.getCurrent().projection.readAccountCount).toBe(2);
      expect.soft(plans.getCurrent().projection.unreadAccounts.map(account => account.accountId)).toEqual(['unread']);
      expect.soft((await renderBody(homeEntry)).findHostByTestId('timeline.state')).not.toBeNull();
      const paces = settled.accounts.map(account => account.windows.map(window => window.pace));
      expect(paces[0]?.[0]).not.toBeNull();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 600_001);
      try {
        await homeEntry.refresh();
        expect.soft(projectionOf(homeEntry).accounts[0]?.state.status).toBe('stale');
        expect.soft(projectionOf(homeEntry).accounts.map(account => account.windows.map(window => window.pace)),
          'aging the same observation must not erase its last settled projection before this window resets').toEqual(paces);
      } finally { clock.mockRestore(); }
      releasePlaceholderHome();
      // Usage's batch has different accounting demand, but exactly the same Account allowance sources.
      holdHistory = true;
      historyGate = createDeferred<void>();
      const usage = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query, { ...query, machines: ['other'] }] }) });
      const releaseUsage = usage.subscribe(() => {}, false);
      try {
        await expect.poll(() => historyHeld).toBeGreaterThan(0);
        await expect.poll(() => usage.getSnapshot().value !== undefined).toBe(true);
        expect.soft(projectionOf(usage).tightest?.window.remainingFraction).toBe(0.5);
        expect.soft(projectionOf(usage).accounts.map(account => account.windows.map(window => window.pace))).toEqual(paces);
        expect.soft((await renderBody(usage)).findHostByTestId('timeline.tightest')).not.toBeNull();
        holdHistory = false; historyGate.resolve();
        await expect.poll(() => usage.getSnapshot().pending).toBe('idle');
        failHistory = true;
        const refreshing = usage.refresh();
        await refreshing;
        expect.soft(projectionOf(usage).accounts.map(account => account.windows.map(window => window.pace))).toEqual(paces);
        expect.soft(projectionOf(usage).accounts[0]?.observedAtMs).toBe(now);
        expect.soft(projectionOf(usage).accounts[0]?.state.status).toBe('stale');
      } finally { releaseUsage(); }
      const returnHome = homeEntry.subscribe(() => {}, false);
      await homeEntry.refresh();
      expect.soft(projectionOf(homeEntry).tightest?.window.remainingFraction).toBe(0.5);
      failHistory = false;
      await homeEntry.refresh();
      expect.soft(projectionOf(homeEntry).accounts[0]?.state.status).toBe('available');
      expect.soft(usageCoverageSummary(sliceOf(homeEntry), ['quota'])).toBe('Partial history');
      returnHome();
      // The phone Home route mounts a new single-query batch after the main
      // pane has released every subscriber. It keeps the same Account owner.
      const phoneContext = captureUiUsageQueryAccountContext(captured.credentials)!;
      expect(getUsageQueryResourceStore(phoneContext)).toBe(store);
      const phoneQuery = normalizeUsageQuery({ ...query, granularity: 'hour' });
      const phone = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [phoneQuery] }) });
      holdHistory = true; historyGate = createDeferred<void>();
      const releasePhone = phone.subscribe(() => {}, false);
      const phoneProjection = () => {
        const slice = decodeUsageQueryResource(phone.getSnapshot().value!).results[0]!;
        return projectUsagePlans(slice.quota, now, slice.pools, slice.sources);
      };
      try {
        await expect.poll(() => phone.getSnapshot().value !== undefined).toBe(true);
        expect.soft(phoneProjection().tightest?.window.remainingFraction, 'settled / to /home keeps the first headline').toBe(0.5);
        expect.soft(readPendingPlanAccountCount(phoneProjection().accounts)).toBe(0);
        expect.soft(phoneProjection().accounts.slice(0, 2).map(account => account.observedAtMs)).toEqual([now, now]);
        holdHistory = false; historyGate.resolve();
        await expect.poll(() => phone.getSnapshot().pending).toBe('idle');
        // An addressable record with no witnessed replacement is not an
        // observation of zero, and cannot erase the previous last-read date.
        records[0] = ProviderAccountUsageSnapshotV1Schema.parse({ ...records[0], state: 'loaded_empty',
          observedAtMs: 0, fetchedAtMs: 0, meters: [] });
        await phone.refresh();
        expect.soft(phoneProjection().accounts[0]?.observedAtMs, 'unobserved replacement retains the last witnessed read').toBe(now);
        expect.soft(phoneProjection().accounts[0]?.windows.map(window => window.pace)).toEqual(paces[0]);
        holdHistory = true; historyGate = createDeferred<void>();
        const nextHome = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
          queries: [normalizeUsageQuery({ ...query, granularity: 'month' })] }) });
        const releaseNextHome = nextHome.subscribe(() => {}, false);
        try {
          await expect.poll(() => nextHome.getSnapshot().value !== undefined).toBe(true);
          const nextSlice = decodeUsageQueryResource(nextHome.getSnapshot().value!).results[0]!;
          const nextPlans = projectUsagePlans(nextSlice.quota, now, nextSlice.pools, nextSlice.sources);
          expect.soft(nextPlans.tightest?.window.remainingFraction, 'a later route inherits the witnessed allowance, not an unobserved replacement').toBe(0.5);
          expect.soft(readPendingPlanAccountCount(nextPlans.accounts)).toBe(0);
          expect.soft(nextPlans.accounts[0]?.observedAtMs).toBe(now);
        } finally { releaseNextHome(); holdHistory = false; historyGate.resolve(); }
      } finally { releasePhone(); }
    } finally { gates.forEach(gate => gate.resolve()); historyGate.resolve(); releaseHome(); }
  });
  it('exports selected calendar facts while the displayed Resource has accounting ready and quota pending', async () => {
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'calendar-work' };
    const source = { bindingKind: 'account' as const, ref };
    const now = Date.now();
    const resetAtMs = now + 86_400_000;
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account' as const, quotaScope: 'account' as const };
    const current = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now,
      fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'session', label: 'Session', used: null, limit: null, usedPct: 42, utilizationPct: 42,
        unit: 'count', status: 'ok', resetAtMs, resetsAt: resetAtMs }] });
    const quotaGate = createDeferred<void>();
    const captured = await context(async request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        await quotaGate.promise;
        return Response.json({ source, recordId: current.recordId, providerAccountId: ref.accountId, fetchedAt: now, staleAfterMs: 60_000 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: current },
        metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') return Response.json({ entries: [], nextCursor: null });
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    }, {
      connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const query = normalizeUsageQuery({ period: { relative: '7days' }, includeSessionEvidence: false, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, false);
    const account = await captureLazyActionAccountContext(captured.accountLifetime.scope.serverId);
    try {
      await expect.poll(() => {
        const content = entry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.accounting?.totals;
      }).toEqual(value.totals);
      const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      expect(slice.quota).toBeUndefined();
      expect(slice.sources).toContainEqual(expect.objectContaining({ source: 'quota', status: 'pending' }));
      const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
      const exporting = executor.execute('usage.calendar.export', { query, selectedEvents: [{ account: ref, kind: 'reset', meterId: 'session' }] },
        { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
      await flushHookEffects();
      quotaGate.resolve();
      const result = await exporting;
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const file = UsageFileResultSchema.parse(result.ok ? result.result : undefined);
      expect(file.mediaType).toBe('text/calendar');
      expect(new TextDecoder().decode(decodeBase64(file.base64))).toContain('BEGIN:VEVENT\r\n');
      expect(home!.requests.some(request => request.path.includes('refresh'))).toBe(false);
    } finally { quotaGate.resolve(); account.dispose(); release(); }
  });
  it('delivers JSON and CSV export bytes from the real client Resource and Action with authorized machine labels', async () => {
    const observed: UsageAnalyticsQueryResponse = { ...value, coverage: { status: 'partial', reasons: [], missingDimensions: [],
      range: { complete: false }, ranked: [], sources: [{ source: 'native-history', path: 'native', status: 'available',
        eventCount: 1, machineId: 'work-machine', captureKind: 'from_logs', asOfMs: 100 }] } };
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(observed) : undefined);
    const machine = createHydratedPlainMachineFixture({ id: 'work-machine', accountId: 'account-a', machine: { } });
    storage.getState().applyMachines([{ ...machine, metadata: { ...machine.metadata!, displayName: 'Private workstation', homeDir: '/private/home' } }]);
    const account = await captureLazyActionAccountContext(captured.accountLifetime.scope.serverId);
    try {
      const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
      const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeSessionEvidence: false, includeWorkEvidence: false });
      for (const format of ['json', 'csv'] as const) {
        const result = await executor.execute('usage.export', { query, format, fields: ['coverage'] },
          { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        const file = UsageFileResultSchema.parse(result.ok ? result.result : undefined);
        const content = new TextDecoder().decode(decodeBase64(file.base64));
        expect(content).toContain('Private workstation');
        expect(content).not.toContain('/private/home');
        expect(file.fields).toEqual(['coverage']);
        expect(file.mediaType).toBe(format === 'json' ? 'application/json' : 'text/csv');
      }
    } finally { account.dispose(); }
  });
  it('settles accounting-only demand without private Session or SCM acquisition', async () => {
    scmTransport.mockClear();
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json({ ...value,
      contributions: [workContribution] }) : undefined);
    storage.setState({ profileScope: captured.accountLifetime.scope,
      profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }),
      sessions: { 'work-session': createSessionFixture({ id: 'work-session', serverId: captured.accountLifetime.scope.serverId }) } });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [
      normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeSessionEvidence: false, includeWorkEvidence: false }),
    ] }) });
    const release = entry.subscribe(() => {}, true);
    try {
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(entry.getSnapshot().error?.code).toBeUndefined();
      const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      expect(slice.accounting?.totals).toMatchObject(value.totals);
      expect(slice.accounting?.contributions).toBeUndefined();
      expect(slice.accounting?.totals.eventCount).toBe(1);
      expect(slice.work).toBeUndefined();
      expect(slice.sources).toContainEqual({ source: 'work', status: 'not_loaded' });
      expect(slice.sources).toContainEqual({ source: 'how_you_work', status: 'not_loaded' });
      expect(slice.pending).toBe(false);
      // Home Sync has its own metadata/active-list bootstrap. Only exact Session
      // and transcript reads acquire the private evidence excluded by this query.
      expect(home!.requests.filter(request => /^\/v2\/sessions\/work-session(?:\/|$)/.test(request.path)
        || /^\/v1\/sessions\/[^/]+\/messages$/.test(request.path))).toEqual([]);
      expect(scmTransport).not.toHaveBeenCalled();
    } finally { release(); }
  });

  it('releases cached complete transport bytes while retaining admitted Usage content and facts', async () => {
    const { Session: InspectorSession } = await import('node:inspector');
    let eventCount = 1;
    const captured = await context(request => request.path === '/v2/usage/query'
      ? Response.json({ ...value, totals: { ...value.totals, eventCount } }) : undefined);
    const reference = { hostRead: 'usage.query' as const, input: projectNativeJsonValueForTransport({
      queries: [normalizeUsageQuery({ period: { relative: 'all' }, includeSessionEvidence: false, includeWorkEvidence: false })],
    }) };
    const store = getUsageQueryResourceStore(captured);
    const entry = store.getEntry(reference);
    const inspector = new InspectorSession();
    inspector.connect();
    try {
      await entry.refresh();
      const content = entry.getSnapshot().value!;
      const decoded = decodeUsageQueryResource(content);
      const slice = decoded.results[0]!;
      const text = new TextDecoder().decode(content.bytes);
      const bytes = new WeakRef(content.bytes);
      const release = entry.subscribe(() => {}, true);
      await flushHookEffects();
      release();
      // End the reader's weak-reference job before collecting. The Account
      // Resource and its decoded admission intentionally remain cached.
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
      expect(bytes.deref() === undefined, 'a cached decoded admission must not strongly retain its complete transport buffer').toBe(true);
      expect(store.getEntry(reference).getSnapshot()).toBe(entry.getSnapshot());
      expect(entry.getSnapshot().value).toBe(content);
      expect(decodeUsageQueryResource(content)).toBe(decoded);
      expect(decodeUsageQueryResource(content).results[0]).toBe(slice);
      expect(new TextDecoder().decode(content.bytes)).toBe(text);
      expect(content.bytes).toBe(content.bytes);
      eventCount = 2;
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.accounting!.totals.eventCount).toBe(2);
      // A later admission must not change an old content object's transport.
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
      expect(new TextDecoder().decode(content.bytes)).toBe(text);
      expect(decodeUsageQueryResource(content)).toBe(decoded);
    } finally { inspector.disconnect(); }
  });

  it('releases superseded Resource bytes while the replacement read is still pending', async () => {
    const { Session: InspectorSession } = await import('node:inspector');
    const gate = createDeferred<void>();
    let hold = false;
    const captured = await context(async request => {
      if (request.path !== '/v2/usage/query') return undefined;
      if (hold) await gate.promise;
      return Response.json(value);
    });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
      queries: [normalizeUsageQuery({ period: { relative: 'all' }, includeSessionEvidence: false, includeWorkEvidence: false })],
    }) });
    const release = entry.subscribe(() => {}, false);
    const inspector = new InspectorSession();
    inspector.connect();
    let refreshing: ReturnType<typeof entry.refresh> | undefined;
    try {
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const superseded = new WeakRef(entry.getSnapshot().value!);
      hold = true;
      refreshing = entry.refresh();
      await expect.poll(() => entry.getSnapshot().value !== superseded.deref()).toBe(true);
      expect(entry.getSnapshot().pending).not.toBe('idle');
      // End the weak dereference job, then collect through the same inspector
      // boundary used by the message-body retention regression below.
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
      expect(superseded.deref() === undefined, 'a refresh needs prior facts, not their superseded serialized bytes').toBe(true);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting).toMatchObject(value);
    } finally { gate.resolve(); await refreshing; release(); inspector.disconnect(); }
  });

  it('retains only current query admissions across twenty settled period switches', async () => {
    const { Session: InspectorSession } = await import('node:inspector');
    const population = usageQaAccountingFixture();
    let eventCount = 1;
    const captured = await context(request => request.path === '/v2/usage/query'
      ? Response.json({ ...population, totals: { ...population.totals, eventCount } }) : undefined);
    storage.setState({ machines: Object.fromEntries(Array.from({ length: 62 }, (_, index) => {
      const machine = createMachineFixture({ id: `retention-machine-${index}` });
      return [machine.id, machine];
    })) });
    const store = getUsageQueryResourceStore(captured);
    const queries = ['7days', '30days'].map(relative => normalizeUsageQuery({ period: { relative },
      includeContributions: true, includeQuota: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false }));
    const entries = queries.map(query => store.getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) }));
    const inspector = new InspectorSession();
    inspector.connect();
    try {
      const generations: WeakRef<object>[] = [];
      const batches: WeakRef<object>[] = [];
      const contents: WeakRef<object>[] = [];
      const observers: WeakRef<object>[] = [];
      for (eventCount = 1; eventCount <= 20; eventCount++) {
        const index = (eventCount - 1) % entries.length;
        const entry = entries[index]!;
        await entry.refresh();
        expect(entry.getSnapshot().pending).toBe('idle');
        expect(entry.getSnapshot().error).toBeUndefined();
        expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.key).toBe(getUsageQueryKey(queries[index]!));
        expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.accounting!.totals.eventCount).toBe(eventCount);
        generations.push(new WeakRef(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.accounting!.totals));
        batches.push(new WeakRef(decodeUsageQueryResource(entry.getSnapshot().value!)));
        contents.push(new WeakRef(entry.getSnapshot().value!));
        observers.push(await (async () => {
          const listener = () => {};
          const observer = new WeakRef(listener);
          const release = entry.subscribe(listener, true);
          await flushHookEffects();
          release();
          return observer;
        })());
      }
      // End the weak-reference job before asking the actual V8 collector.
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
      expect(generations.filter(generation => generation.deref() !== undefined).length,
        'twenty settled switches retain one current accounting generation per cached query').toBe(entries.length);
      expect(batches.filter(batch => batch.deref() !== undefined).length,
        'superseded query projections must be collectible').toBe(entries.length);
      expect(contents.filter(content => content.deref() !== undefined).length,
        'superseded Resource results must be collectible').toBe(entries.length);
      expect(observers.filter(observer => observer.deref() !== undefined).length,
        'retired period subscriptions must be collectible').toBe(0);
      expect(entries.map(entry => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.accounting!.totals.eventCount))
        .toEqual([19, 20]);
    } finally { inspector.disconnect(); }
  });

  it.each(['settled', 'cancelled'] as const)('releases private period projections across %s refreshes of the same two queries', async phase => {
    const { Session: InspectorSession } = await import('node:inspector');
    let nowMs = 1_710_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const id = 'private-period-retention';
    const startedAt = nowMs - 1000;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, sessionIds: [id] });
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })),
        results: [{ sessionId: id,
          detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, active: false }) } },
          turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: startedAt + 800,
            turns: [{ turnId: 'completed', status: 'completed', startedAt, terminalAt: startedAt + 600, updatedAt: startedAt + 800 }] } },
        }] } satisfies UsageSessionEvidenceResponse);
    });
    const queries = ['7days', '30days'].map(relative => normalizeUsageQuery({ period: { relative },
        includeQuota: false, includeComparison: false, includeCoach: false, includeWorkEvidence: false,
        includeSessionEvidence: true, includeTranscriptEvidence: false }));
    const current: Awaited<ReturnType<typeof readUiUsageQueryBatch>>[] = [];
    const projections: UsageQueryReprojection[] = [];
    const inspector = new InspectorSession();
    inspector.connect();
    const references: WeakRef<object>[] = [];
    try {
      for (let round = 0; round < 10; round++) {
        nowMs += 60_000;
        invalidateUsageQueryResources(captured.accountLifetime);
        for (const [index, query] of queries.entries()) {
          const controller = new AbortController();
          const reason = new DOMException('View left after private publication', 'AbortError');
          const reading = readUiUsageQueryBatch(captured, { queries: [query] }, controller.signal, current[index], {
            onProgress(project) {
              projections[index] = project;
              const batch = project();
              if (batch.results[0]?.pending === false) {
                current[index] = batch;
                if (phase === 'cancelled') controller.abort(reason);
              }
            },
          });
          if (phase === 'cancelled') await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
          else current[index] = await reading;
          const slice = current[index]!.results[0]!;
          expect(slice.pending).toBe(false);
          expect(slice.howYouWork?.sessionCoverage).toMatchObject({ selected: 1, admitted: 1 });
          references.push(new WeakRef(slice));
        }
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
      const expected = new Set<object>(current.map(batch => batch.results[0]!));
      const retained = new Set(references.flatMap(reference => {
        const slice = reference.deref();
        return slice ? [slice] : [];
      }));
      expect(retained.size, 'private generations retire with their replaced query admission').toBe(expected.size);
      expect([...retained].every(slice => expected.has(slice))).toBe(true);
      expect(projections.map(project => project().results[0]?.howYouWork?.sessionCoverage?.admitted)).toEqual([1, 1]);
    } finally { inspector.disconnect(); }
  });

  it('releases retired accounting generations when repeated failed reads retain current fallback facts', async () => {
    const { Session: InspectorSession } = await import('node:inspector');
    const population = usageQaAccountingFixture();
    let generation = 1;
    let failed = false;
    let failures = 0;
    const captured = await context(request => {
      // A schema-valid but incomplete HTTP batch fails the real accounting
      // admission after its initial fallback projection has been published.
      if (request.path === '/v2/usage/query-batch' && failed) {
        failures++;
        return Response.json({ v: 1, results: [] });
      }
      if (request.path === '/v2/usage/query') return Response.json({ ...population,
        // A corrected observation makes this array a distinct admitted fact,
        // so the positive control also proves retired row-array sensitivity.
        contributions: population.contributions!.map((row, index) => index === 0 ? { ...row, eventCount: generation } : row),
        totals: { ...population.totals, eventCount: generation }, priceCatalog: { ...population.priceCatalog!,
          provenance: { ...population.priceCatalog!.provenance, asOfMs: generation } } });
      return undefined;
    });
    const queries = ['7days', '30days'].map(relative => normalizeUsageQuery({ metric: 'cost', period: { relative },
      includeContributions: true, includeQuota: false, includeComparison: false, includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeWorkEvidence: false }));
    const entries = queries.map(query => getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) }));
    const accountingFor = (entry: typeof entries[number]) => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.accounting!;
    const families = (accounting: ReturnType<typeof accountingFor>) => ({ accounting, totals: accounting.totals,
      contributions: accounting.contributions!, catalog: accounting.priceCatalog! });
    const references: Record<keyof ReturnType<typeof families>, WeakRef<object>[]> = {
      accounting: [], totals: [], contributions: [], catalog: [],
    };
    const control: { accounting?: ReturnType<typeof accountingFor> } = {};
    const inspector = new InspectorSession();
    inspector.connect();
    const collect = async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
    };
    const retainedCounts = (withControl: boolean) => Object.fromEntries((Object.keys(references) as (keyof typeof references)[]).map(name => {
      const expected = new Set<object>(entries.map(entry => families(accountingFor(entry))[name]));
      if (withControl) expected.add(families(control.accounting!)[name]);
      const actual = new Set(references[name].flatMap(reference => { const object = reference.deref(); return object ? [object] : []; }));
      expect(actual.size, `${name}: only current fallback generations and explicit control remain`).toBe(expected.size);
      expect([...actual].every(object => expected.has(object)), `${name}: retired identities are collectible`).toBe(true);
      return [name, actual.size];
    }));
    try {
      for (let round = 0; round < 20; round++) for (const entry of entries) {
        failed = false;
        await entry.refresh();
        expect(entry.getSnapshot().error).toBeUndefined();
        expect(entry.getSnapshot().pending).toBe('idle');
        expect(accountingFor(entry).totals.eventCount).toBe(generation);
        if (generation === 1) control.accounting = accountingFor(entry);
        for (const [name, object] of Object.entries(families(accountingFor(entry)))) references[name as keyof typeof references].push(new WeakRef(object));
        failed = true;
        await entry.refresh();
        expect(entry.getSnapshot().pending).toBe('idle');
        expect(entry.getSnapshot().error).toBeDefined();
        const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
        expect(slice.pending).toBe(false);
        expect(slice.accounting!.totals.eventCount, 'failed admission preserves its current valid fallback').toBe(generation);
        generation++;
      }
      expect(failures).toBe(40);
      await collect();
      const withControl = retainedCounts(true);
      expect(references.accounting[0]!.deref()).toBe(control.accounting);
      delete control.accounting;
      await collect();
      const current = retainedCounts(false);
      expect(entries.map(entry => accountingFor(entry).totals.eventCount)).toEqual([39, 40]);
      console.info('usage-failed-read-retained-generation-counts', { withControl, current });
    } finally { inspector.disconnect(); }
  });

  it('releases retired rich quota generations across twenty settled two-scope round trips', async () => {
    const { Session: InspectorSession } = await import('node:inspector');
    const { encodeBase64 } = await import('@/encryption/base64');
    const { sealProviderAccountUsageSnapshot } = await import('@happier-dev/protocol/connect/accountUsage');
    const { buildProviderAccountUsagePageProjectionV1 } = await import('@happier-dev/protocol/connect/providerAccountUsagePageProjection');
    const { sealProviderAccountUsagePageProjectionV1 } = await import('@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto');
    const { bundledUsageModelPriceCatalog } = await import('@happier-dev/protocol/usage/usageModelPriceCatalog');
    const now = Date.UTC(2026, 10, 6, 12);
    const day = 86_400_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const secret = new Uint8Array(32).fill(7);
    const material = { type: 'legacy' as const, secret };
    const credentials = { token: createServedHomeAccountToken('account-a'), secret: encodeBase64(secret, 'base64url') };
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'quota-retention' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
      staleAfterMs: day, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'weekly', label: 'Weekly', used: 60, limit: 100, utilizationPct: 60, unit: 'requests',
        status: 'ok', resetsAt: now + day, resetAtMs: now + day, windowDurationMs: 7 * day, details: {} }] });
    const sealed = sealProviderAccountUsageSnapshot({ snapshot, material, randomBytes: length => new Uint8Array(length).fill(9) });
    let generation = 1;
    let projectionReads = 0;
    // Stable old observations plus an append-only live frontier. Both
    // coverage and sealed history describe the same accepted generation.
    const observations = () => [now - 2 * day, now - day, ...Array.from({ length: generation }, (_, index) => now - 100 + index)]
      .map(observedAtMs => ({ id: `observation-${observedAtMs}`, observedAtMs }));
    const captured = await context(request => {
      if (request.path === CONNECTED_PRESENTATION_ROWS_ROUTE_V1) return Response.json(ConnectedPresentationRowReadResponseV1Schema.parse({ status: 'deleted', revision: 1 }));
      if (request.path === CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1) return Response.json(ConnectedAcknowledgementsRowReadResponseV1Schema.parse({ status: 'deleted', revision: 1 }));
      if (request.path === '/v2/usage/query') return Response.json({ ...value,
        totals: { ...value.totals, eventCount: generation }, priceCatalog: { ...bundledUsageModelPriceCatalog,
          provenance: { ...bundledUsageModelPriceCatalog.provenance, asOfMs: now + generation } } });
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({ source,
        recordId: snapshot.recordId, providerAccountId: ref.accountId, fetchedAt: now, staleAfterMs: day });
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({
        content: { t: 'encrypted', c: sealed.ciphertext, recoveryCreditDetails: sealed.recoveryCreditDetails },
        metadata: { fetchedAt: now, staleAfterMs: day, status: 'ok' }, sources: [source] });
      if (request.path === '/v4/connect/qualified/provider-account-usage/day-summaries') {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(ProviderAccountUsageDaySummaryReadV1Schema,
          request.url.searchParams.get('query'));
        const byDay = new Map<number, ReturnType<typeof observations>>();
        for (const observation of observations()) {
          const dayStartAtMs = Math.floor(observation.observedAtMs / day) * day;
          if (query.range && (dayStartAtMs >= query.range.endAtMs || dayStartAtMs + day <= query.range.startAtMs)) continue;
          if (!byDay.has(dayStartAtMs)) byDay.set(dayStartAtMs, []);
          byDay.get(dayStartAtMs)!.push(observation);
        }
        return Response.json({ summaries: [], missingDays: query.includeCoverage ? [...byDay].map(([dayStartAtMs, entries]) => ({
          dayStartAtMs, coverage: { observationCount: entries.length, frontier: entries.at(-1)! },
        })) : [] });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        if (!('projection' in query)) throw new Error('Expected the real Resource projection read');
        projectionReads++;
        const range = query.projection.range;
        const entries = observations().filter(({ observedAtMs }) => observedAtMs >= range.startAtMs && observedAtMs < range.endAtMs)
          .map(entry => ({ ...entry, snapshot: { ...snapshot, observedAtMs: entry.observedAtMs, fetchedAtMs: entry.observedAtMs } }));
        const projection = buildProviderAccountUsagePageProjectionV1({ recordId: snapshot.recordId, range,
          history: { entries, nextCursor: null } });
        const frontier = entries.at(-1)!;
        return Response.json({ projection: { recordId: snapshot.recordId, demand: { range, resolution: 'accepted_observations' },
          observationCount: entries.length, frontier: { id: frontier.id, observedAtMs: frontier.observedAtMs },
          content: sealProviderAccountUsagePageProjectionV1({ projection, accountMode: 'e2ee', material,
            randomBytes: length => new Uint8Array(length).fill(9) }) }, complete: true },
        { headers: { etag: `"quota-generation-${generation}"` } });
      }
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] },
    undefined, { credentials, accountMode: 'e2ee',
      encryptionCurrentness: () => createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    const queries = ['7days', '30days'].map(relative => normalizeUsageQuery({ metric: 'cost', period: { relative }, includeQuota: true,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false }));
    const store = getUsageQueryResourceStore(captured);
    const entries = queries.map(query => store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) }));
    type Quota = NonNullable<ReturnType<typeof decodeUsageQueryResource>['results'][number]['quota']>[number];
    const families = (quota: Quota) => {
      const dayFact = quota.pageFacts!.dayQuotaHistory!.find(fact => fact.dayStartAtMs === Date.UTC(2026, 10, 4))!;
      expect(dayFact).toBeDefined();
      const window = dayFact.windows[0]!;
      expect(window.lastSnapshot.observedAtMs).toBe(now - 2 * day);
      return { quota, dayFact, window, historicalSnapshot: window.lastSnapshot };
    };
    const references: Record<keyof ReturnType<typeof families>, WeakRef<object>[]> = {
      quota: [], dayFact: [], window: [], historicalSnapshot: [],
    };
    const control: { quota?: Quota; catalog?: object } = {};
    const catalogs: WeakRef<object>[] = [];
    const retainedFacades: ReturnType<typeof store.getEntry>[] = [];
    const live = (rows: WeakRef<object>[]) => new Set(rows.flatMap(row => { const value = row.deref(); return value ? [value] : []; }));
    const inspector = new InspectorSession();
    inspector.connect();
    const collect = async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
    };
    const quotaFor = (entry: typeof entries[number]) => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.quota![0]!;
    const catalogFor = (entry: typeof entries[number]) => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.accounting!.priceCatalog!;
    const assertRetained = (withControl: boolean) => {
      const counts: Record<string, number> = {};
      for (const name of Object.keys(references) as (keyof typeof references)[]) {
        const expected = new Set<object>(entries.map(entry => families(quotaFor(entry))[name]));
        if (withControl) expected.add(families(control.quota!)[name]);
        const actual = live(references[name]);
        counts[name] = actual.size;
        expect(actual.size, `${name}: unique retained generations`).toBe(expected.size);
        expect([...actual].every(object => expected.has(object)), `${name}: only current scopes and explicit control remain`).toBe(true);
      }
      const expected = new Set<object>(entries.map(catalogFor));
      if (withControl) expected.add(control.catalog!);
      const actual = live(catalogs);
      counts.catalogs = actual.size;
      expect(actual.size, 'catalogs: unique retained generations').toBe(expected.size);
      expect([...actual].every(object => expected.has(object)), 'only current catalogs and explicit control remain').toBe(true);
      return counts;
    };
    try {
      for (let round = 0; round < 20; round++) for (let index = 0; index < entries.length; index++, generation++) {
        const entry = entries[index]!;
        await entry.refresh();
        expect(entry.getSnapshot().pending).toBe('idle');
        expect(entry.getSnapshot().error).toBeUndefined();
        const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
        expect(slice.key).toBe(getUsageQueryKey(queries[index]!));
        expect(slice.pending).toBe(false);
        const quota = quotaFor(entry);
        expect(catalogFor(entry).provenance.asOfMs).toBe(now + generation);
        catalogs.push(new WeakRef(catalogFor(entry)));
        const facade = store.getEntry({ hostRead: 'usage.query',
          input: projectNativeJsonValueForTransport({ queries: [queries[index]!] }) });
        expect(facade.isPresentationReady()).toBe(true);
        retainedFacades.push(facade);
        expect(quota.pageFacts?.historyStatus).toBe('complete');
        expect(quota.pageFacts?.resetWitness?.id).toBe(`observation-${now - 101 + generation}`);
        if (generation === 1) { control.quota = quota; control.catalog = catalogFor(entry); }
        for (const [name, object] of Object.entries(families(quota))) references[name as keyof typeof references].push(new WeakRef(object));
      }
      expect(projectionReads).toBeGreaterThanOrEqual(40);
      await collect();
      // Return from the assertion frame before collecting again: its temporary
      // expected/actual Sets are themselves strong retaining roots.
      const withControl = assertRetained(true);
      expect(references.quota[0]!.deref()).toBe(control.quota);
      expect(entries.every(entry => quotaFor(entry) !== control.quota)).toBe(true);
      delete control.quota;
      delete control.catalog;
      await collect();
      const current = assertRetained(false);
      expect(retainedFacades).toHaveLength(40);
      expect(retainedFacades.every(facade => facade.isPresentationReady())).toBe(true);
      console.info('usage-retained-generation-counts', { withControl, current });
    } finally { inspector.disconnect(); }
  });

  it('releases progress observers when cancelled finite reads keep their admitted projections', async () => {
    const { Session: InspectorSession } = await import('node:inspector');
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    const query = normalizeUsageQuery({ period: { relative: 'all' }, includeQuota: false,
      includeSessionEvidence: false, includeWorkEvidence: false });
    const retained = [];
    const observers = [];
    for (let generation = 0; generation < 4; generation++) {
      // The cached presentation remains useful after cancellation. Its finite
      // read's observer must end, even when a consumer keeps that presentation.
      const cancelled = await (async () => {
        const controller = new AbortController();
        // A reason created inside the observer would itself retain that
        // observer through V8's error stack, independently of the read owner.
        const reason = new DOMException('Cancelled finite read', 'AbortError');
        let projection: UsageQueryReprojection | undefined;
        const onProgress = (project: UsageQueryReprojection) => {
          projection = project;
          project();
          controller.abort(reason);
        };
        const observer = new WeakRef(onProgress);
        let aborted = false;
        try {
          // Callers own this readonly options object; retirement must not mutate it.
          await readUiUsageQueryBatch(captured, { queries: [query] }, controller.signal, undefined, Object.freeze({ onProgress }));
        } catch (error) {
          aborted = error instanceof Error && error.name === 'AbortError';
        }
        if (!projection) throw new Error('Expected a published projection before cancellation');
        return { projection, observer, aborted };
      })();
      expect(cancelled.aborted).toBe(true);
      retained.push(cancelled.projection);
      observers.push(cancelled.observer);
    }
    const inspector = new InspectorSession();
    inspector.connect();
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
      expect(observers.filter(observer => observer.deref() !== undefined).length,
        'four cancelled reads retain zero retired progress observers').toBe(0);
      expect(retained.map(project => project().results[0]?.key)).toEqual(Array(4).fill(getUsageQueryKey(query)));
    } finally { inspector.disconnect(); }
  });

  it('admits progressive and terminal typed content without preparing a transport digest', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    const submitted: string[] = [];
    const originalDigest = platformDigest.digest;
    vi.spyOn(platformDigest, 'digest').mockImplementation(async (algorithm, bytes) => {
      const text = new TextDecoder().decode(bytes);
      // Bootstrap also hashes unrelated Account material. This contract owns
      // only the queried Resource's progressive/terminal JSON representation.
      if (text.startsWith('{"v":1,"results":[')) {
        submitted.push(text);
      }
      return await originalDigest(algorithm, bytes);
    });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } })] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const admitted = entry.getSnapshot().value;
      expect(admitted).toBeDefined();
      expect(decodeUsageQueryResource(admitted!).results[0]?.accounting).toMatchObject(value);
      expect(entry.getSnapshot().error).toBeUndefined();
      expect(submitted).toHaveLength(0);
      expect(new TextDecoder().decode(admitted!.bytes)).toBe(JSON.stringify(decodeUsageQueryResource(admitted!)));
    } finally { release(); }
  });

  it('admits usage content without waiting for an unrelated asynchronous platform digest', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    storage.setState({ profileScope: captured.accountLifetime.scope,
      profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }) });
    const digestGate = createDeferred<void>();
    const originalDigest = platformDigest.digest;
    vi.spyOn(platformDigest, 'digest').mockImplementation(async (algorithm, bytes) => {
      await digestGate.promise;
      return await originalDigest(algorithm, bytes);
    });
    const entry = getUsageQueryResourceStore(captured)
      .getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ period: { relative: '7days' } }] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(entry.getSnapshot().value).toBeDefined();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting).toMatchObject(value);
    } finally { digestGate.resolve(); release(); }
  });

  it('publishes last-known admitted allowances on first mount while all refresh transports are held', async () => {
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'retained-l3' };
    const source = { bindingKind: 'account' as const, ref };
    const now = Date.now();
    const recordKey = { providerId: 'codex', accountSubjectId: 'retained-l3', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'retained-l3' }, observedAtMs: now,
      fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'weekly', label: 'Weekly', used: null, limit: null, usedPct: 42, utilizationPct: 42,
        unit: 'count', status: 'ok', resetAtMs: now + 86_400_000, resetsAt: now + 86_400_000 }] });
    const resolution = { source, recordId: snapshot.recordId, providerAccountId: 'retained-l3', fetchedAt: now, staleAfterMs: 60_000 };
    const gate = createDeferred<void>();
    let hold = false;
    const captured = await context(async request => {
      if (hold && request.path !== '/v1/features') await gate.promise;
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v4/connect/qualified/quotas') return Response.json({ ref, sourceResolution: resolution,
        content: { t: 'plain', v: { v: 1, ref, activeAccountId: 'retained-l3', fetchedAt: now, staleAfterMs: 60_000,
          planLabel: null, accountLabel: null, meters: [] } }, metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' } });
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json(resolution);
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: snapshot },
        metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') return Response.json({ entries: [], nextCursor: null });
      return undefined;
    }, {
      connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    const basis = getActiveServerSnapshot();
    await getServerFeaturesSnapshot({ serverId: basis.serverId, force: true });
    const readContext = { credentials: captured.credentials, ref,
      credentialScope: [captured.accountLifetime.scope.serverId, String(basis.generation), resolveAuthCredentialsScopeKey(captured.credentials)].join('\u0000'),
      serverBasis: { serverId: captured.accountLifetime.scope.serverId, generation: basis.generation },
      assertOperationAllowed: async () => { throw new Error('Passive read must not refresh a provider'); } };
    const key = buildQualifiedQuotaSnapshotScopeKey(readContext);
    loadQualifiedQuotaSnapshotOnce(key, readContext);
    await expect.poll(() => getQualifiedQuotaSnapshotEntry(key).usageRecordId).toBe(snapshot.recordId);
    const opened = await getProviderAccountUsageSnapshotPlain(captured.credentials, { recordId: snapshot.recordId }, { expectedActiveServer: readContext.serverBasis });
    const providerScope = buildProviderAccountUsageScopeKey({ serverId: captured.accountLifetime.scope.serverId,
      generation: basis.generation, credentialScope: resolveAuthCredentialsScopeKey(captured.credentials) });
    updateProviderAccountUsageCacheEntries(providerScope, () => ({ [snapshot.recordId]: {
      snapshot: opened, loading: true, hadError: false, nextFetchAtMs: now } }));
    hold = true;
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ period: { relative: '7days' } }] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => {
        const content = entry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.quota?.[0]?.current;
      }).toEqual(snapshot);
      expect(entry.getSnapshot().pending).toBe('initial');
    } finally { gate.resolve(); release(); }
  });

  it.each([
    { status: null, expected: { status: 'unsupported', errorCode: 'no_connected_accounts' } },
    { status: 'needs_reauth' as const, expected: { status: 'error', errorCode: 'connected_account_needs_reauth' } },
  ])('settles allowance reads without eligible accounts ($status)', async ({ status, expected }) => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    storage.setState({ profileScope: captured.accountLifetime.scope,
      profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId,
        connectedAccountsV4: status ? [{ ref: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
          accountId: 'reauth-account' }, status, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
          credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] : [] }) });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ period: { relative: '7days' } }] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      expect(slice.sources).toContainEqual(expect.objectContaining({ source: 'quota', ...expected }));
      expect(slice.pending).toBe(false);
      expect(home!.requests.some(request => request.path.includes('/provider-account-usage/'))).toBe(false);
    } finally { release(); }
  });
  it('adds opened machine locations to source coverage without sending names or private paths to accounting', async () => {
    const observed: UsageAnalyticsQueryResponse = { ...value, coverage: { status: 'partial', reasons: [], missingDimensions: [],
      range: { complete: false }, ranked: [], sources: [{ source: 'native-history', path: 'native', status: 'available',
        eventCount: 1, machineId: 'work-machine', captureKind: 'from_logs' }] } };
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(observed) : undefined);
    storage.setState({ profileScope: captured.accountLifetime.scope,
      profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }) });
    const machine = createHydratedPlainMachineFixture({ id: 'work-machine', accountId: 'account-a', machine: { } });
    storage.getState().applyMachines([{ ...machine, metadata: { ...machine.metadata!, displayName: 'Workstation',
      host: 'private-host', homeDir: '/private/home', happyHomeDir: '/private/logs' } }]);
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
    const first = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(first.results[0]?.accounting?.coverage?.sources[0]).toMatchObject({ machineId: 'work-machine',
      captureKind: 'from_logs', displayLocation: 'Workstation' });
    expect(JSON.stringify(first)).not.toContain('/private/');
    expect(JSON.stringify(home!.requests)).not.toContain('Workstation');
    storage.getState().applyMachines([{ ...machine, availability: { kind: 'locked', reason: 'decryption_failed' }, metadata: null }]);
    const locked = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, first);
    expect(locked.results[0]?.accounting?.coverage?.sources[0]).not.toHaveProperty('displayLocation');
    storage.getState().applyMachines([{ ...machine, metadata: { ...machine.metadata!, displayName: 'Foreign workstation' } }]);
    storage.setState({ profileScope: { ...captured.accountLifetime.scope, accountId: 'other-account' } });
    await expect(readUiUsageQueryBatch(captured, { queries: [query] }, undefined, first))
      .rejects.toMatchObject({ code: 'stale_surface' });
  });
  it('refreshes full-demand coverage names alongside quota-only demand while ignoring unrelated reachability', async () => {
    let observed: UsageAnalyticsQueryResponse = { ...value, coverage: { status: 'partial', reasons: [], missingDimensions: [],
      range: { complete: false }, ranked: [], sources: [{ source: 'native-history', path: 'native', status: 'available',
        eventCount: 1, machineId: 'labels-only', captureKind: 'from_logs' }] } };
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(observed) : undefined);
    const machine = createMachineFixture({ id: 'labels-only', activeAt: Date.now() });
    storage.setState({ machines: { [machine.id]: { ...machine, metadata: { ...machine.metadata!, displayName: 'Before' } } } });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const quotaEntry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ ...query, includeAccounting: false }] }) });
    const releaseQuota = quotaEntry.subscribe(() => {}, true);
    const release = entry.subscribe(() => {}, true);
    const slice = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    const acquisitions = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
    try {
      await expect.poll(() => entry.getSnapshot().subscription).toBe('live');
      await expect.poll(() => quotaEntry.getSnapshot().subscription).toBe('live');
      await entry.refresh();
      expect(slice().accounting?.coverage?.sources[0]?.displayLocation).toBe('Before');
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const beforeFlip = acquisitions();
      recordMachineRequestFailed({ ...captured.accountLifetime.scope, machineId: machine.id });
      await flushHookEffects();
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(acquisitions()).toBe(beforeFlip);
      storage.setState({ machines: { [machine.id]: { ...machine, metadata: { ...machine.metadata!, displayName: 'After' } } } });
      await expect.poll(() => slice().accounting?.coverage?.sources[0]?.displayLocation).toBe('After');
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(acquisitions()).toBe(beforeFlip);
      observed = { ...observed, totals: { ...observed.totals, eventCount: 9 } };
      publishHomeAccountChange(captured.accountLifetime.scope.serverId);
      await expect.poll(() => slice().accounting?.totals.eventCount).toBe(9);
      expect(acquisitions()).toBeGreaterThan(beforeFlip);
    } finally { release(); releaseQuota(); }
  });
  it('shares admitted hypothetical selector reads and never relabels a live response as a future comparison', async () => {
    const captured = await context(() => undefined);
    const input = { machineId: 'selected', group: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, groupId: 'work' },
      hypothetical: { strategy: 'manual' as const, atMs: 300 } };
    const response = { group: input.group, observedAtMs: 100, hypothetical: input.hypothetical,
      selection: { selected: null, reason: 'manual_strategy', excluded: [], decisionTrace: { activeProfileId: 'work',
        reason: 'manual_strategy', strategy: 'manual', selectionBasis: 'manual_strategy', sticky: false,
        orderedEligibleCandidates: [], candidates: [] } } };
    let acknowledged = true;
    scmTransport.mockImplementation(async (request: { payload: unknown }) => {
      expect(request.payload).toEqual(input);
      if (acknowledged) return response;
      const { hypothetical: _hypothetical, ...live } = response;
      return live;
    });
    const store = getUsageQueryResourceStore(captured);
    const entry = store.getEntry({ hostRead: 'connectedServices.pools.selection.get', input });
    const release = entry.subscribe(() => {}, false);
    try {
      const snapshot = await entry.refresh();
      expect(snapshot.error).toBeFalsy();
      expect(JSON.parse(new TextDecoder().decode(snapshot.value!.bytes))).toEqual(response);
      expect(store.getEntry({ hostRead: 'connectedServices.pools.selection.get', input: {
        hypothetical: { atMs: 300, strategy: 'manual' }, group: input.group, machineId: 'selected' } }).getSnapshot()).toBe(entry.getSnapshot());
      expect(store.getEntry({ hostRead: 'connectedServices.pools.selection.get', input: {
        machineId: 'selected', group: input.group } }).getSnapshot()).not.toBe(entry.getSnapshot());
      acknowledged = false;
      const unacknowledged = await entry.refresh();
      expect(unacknowledged.error?.code).toBe('connected_account_daemon_response_invalid');
      // A retained authorized value still answers the old acknowledged scenario; no fresh live value replaces it.
      if (unacknowledged.value) expect(JSON.parse(new TextDecoder().decode(unacknowledged.value.bytes))).toEqual(response);
      retireActiveServerAccountScopeLifetime();
      expect(entry.getSnapshot().value).toBeUndefined();
    } finally { release(); }
  });
  it('re-prices retained history when captured Account price settings change without altering reported costs', async () => {
    const tokens = { input: 1_000_000, output: 500_000, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_500_000 };
    const cost = { reportedUsd: 7, estimatedUsd: 3, currency: 'USD' };
    const historical: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1, tokens, cost }, contributions: [
      { ...workContribution, id: 'price-history', sessionId: null, modelId: 'private-model', tokens, cost },
    ] };
    const priceSettings = (inputUsdPerMillion: number) => settingsParse({ usageModelPriceOverridesV1: {
      'private-model': { kind: 'rates', inputUsdPerMillion, outputUsdPerMillion: 4 } } });
    const delivered: unknown[] = [];
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query-batch') return undefined;
      const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
      const compact = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
        results: input.queries.map(query => ({ query, value: historical })) },
        input, false));
      delivered.push(compact);
      return Response.json(compact);
    }, undefined, priceSettings(2));
    let settingsVersion = 1;
    const setPrice = (inputUsdPerMillion: number | null) => {
      const settings = inputUsdPerMillion === null ? settingsParse({ usageModelPriceOverridesV1: {} }) : priceSettings(inputUsdPerMillion);
      home!.replaceAccountSettings('a', { settings, version: ++settingsVersion });
      saveAccountSettings(captured.accountLifetime.scope, settings, settingsVersion);
      storage.setState({ settingsScope: captured.accountLifetime.scope, settings });
    };
    setPrice(2);
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 },
      includeWorkEvidence: false, includeSessionEvidence: false, includeTranscriptEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    const read = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    const accountingReads = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch');
    try {
      await entry.refresh();
      expect(read().accounting?.contributions).toBeUndefined();
      await expect.poll(() => read().costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(4);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(read().costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(4);
      expect(read().accounting?.totals.cost).toMatchObject(cost);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const beforePrice = accountingReads().length;
      expect(accountingReads().every(request => {
        const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
        return input.includeContributions === false && input.contributionQueries?.length === 0;
      })).toBe(true);
      setPrice(6);
      await expect.poll(() => read().costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(8);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(accountingReads()).toHaveLength(beforePrice);
      expect(read().accounting?.contributions).toBeUndefined();
      expect(accountingReads().every(request =>
        !JSON.stringify(request.body).includes('usageModelPriceOverridesV1'))).toBe(true);
      setPrice(null);
      await expect.poll(() => read().costFactTotals?.find(fact => fact.kind === 'api_equivalent')).toBeUndefined();
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(accountingReads()).toHaveLength(beforePrice);
      expect(read().accounting?.contributions).toBeUndefined();
      setPrice(6);
      await expect.poll(() => read().costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(8);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(accountingReads()).toHaveLength(beforePrice);
      expect(JSON.stringify(delivered)).not.toContain('contributionPages');
      storage.setState({ settingsScope: { serverId: 'foreign', accountId: 'other' },
        settings: settingsParse({ usageModelPriceOverridesV1: { 'private-model': { kind: 'rates', inputUsdPerMillion: 100, outputUsdPerMillion: 100 } } }) });
      await entry.refresh();
      // A different focused Account cannot supply its overrides. The captured
      // Account still has its own canonical persisted settings when unfocused.
      await expect.poll(() => read().costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(8);
      expect(read().accounting?.totals.cost).toMatchObject(cost);
    } finally { release(); }
  });
  it('shares qualified overlapping pools and selector revisions in the exact machine-scoped Resource', async () => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const group = (groupId: string, memberAccountIds: string[]) => QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId }, incarnation: 'incarnation',
      displayName: groupId, policy: { strategy: 'priority' }, activeConnectedAccountId: 'work', generation: 1,
      runtimeStateRevision: 1, state: {}, createdAt: 1, updatedAt: 1,
      members: memberAccountIds.map(connectedAccountId => ({ v: 1, connectedAccountId, priority: 1, enabled: true,
        state: {}, createdAt: 1, updatedAt: 1 })) });
    let machines = [createMachineFixture({ id: 'selected', activeAt: Date.now() }),
      createMachineFixture({ id: 'other', activeAt: Date.now() })];
    const machineRows = () => machines.map(machine => ({
      ...createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine }),
      revokedAt: machine.revokedAt ?? null, replacedByMachineId: machine.replacedByMachineId ?? null,
    }));
    const captured = await context(request => {
      // This case measures Pool admission, independently of the current-quota reader.
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
        features: { connectedServices: { quotas: { enabled: false } } },
      }));
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v1/machines') return Response.json(machineRows());
      if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body,
        machineId => machineRows().find(machine => machine.id === machineId) ?? null);
      return undefined;
    }, {
      connectedAccountsV4: ['work', 'personal', 'standalone'].map(accountId => ({ ref: { service, accountId }, status: 'connected',
        authenticationModeId: 'manual', revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
        configurationReady: false, configurationRevision: null, scopes: [] })),
      connectedAccountGroupsV4: [group('first', ['work', 'personal']), group('second', ['work'])] });
    expect(storage.getState().machines.selected).toBeDefined();
    const { sync } = await import('@/sync/sync');
    let selectedId = 'work';
    let denied = false;
    let unavailable = false;
    let timedOut = true;
    let deniedRpcReads = 0;
    let heldSecondSelection: ReturnType<typeof createDeferred<void>> | undefined;
    const selectionReads: string[] = [];
    scmTransport.mockImplementation(async (input: { machineId: string; payload: { group: { service: typeof service; groupId: string } } }) => {
      selectionReads.push(input.payload.group.groupId);
      if (timedOut) throw Object.assign(new Error('Selector timed out'), { code: 'MACHINE_RPC_TIMEOUT' });
      if (denied) { deniedRpcReads++; throw new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN); }
      if (unavailable) return { status: 'unavailable', code: 'connected_account_daemon_runtime_unavailable' };
      expect(input.machineId).toBe('selected');
      if (input.payload.group.groupId === 'second') await heldSecondSelection?.promise;
      const profileId = input.payload.group.groupId === 'first' ? selectedId : 'work';
      const excluded = input.payload.group.groupId === 'first'
        ? [{ profileId: profileId === 'work' ? 'personal' : 'work', reason: 'auth_invalid' as const }] : [];
      const selected = { profileId, priority: 1, createdAtMs: 1, enabled: true, leastLimitedScore: null };
      // The live U2 read has a sticky selection, invalid sibling credentials,
      // and no fresh quota. These are readable per-account facts, not a failed read.
      return ConnectedServicePoolSelectionGetResponseV1Schema.parse({ group: input.payload.group, observedAtMs: 100,
        selection: { selected, reason: 'selected', excluded,
        decisionTrace: { activeProfileId: profileId, reason: 'selected', strategy: 'priority', selectionBasis: 'active_stickiness',
          sticky: true, orderedEligibleCandidates: [selected], candidates: [
            { profileId, decision: 'selected', quotaEvidence: { status: 'stale_or_missing' } },
            ...excluded.map(candidate => ({ profileId: candidate.profileId, decision: 'excluded',
              exclusionReason: candidate.reason, quotaEvidence: { status: 'stale_or_missing' } })),
          ] } } });
    });
    const query = normalizeUsageQuery({ machines: ['selected'] });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    try {
      await expect.poll(() => entry.getSnapshot().subscription).toBe('live');
      await entry.refresh();
      const failed = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      expect(failed.pools?.every(pool => pool.selection.status === 'error' && pool.selection.errorCode === 'MACHINE_RPC_TIMEOUT')).toBe(true);
      expect(failed.sources.filter(source => source.source.startsWith('selection:')))
        .toEqual(expect.arrayContaining([expect.objectContaining({ status: 'error', errorCode: 'MACHINE_RPC_TIMEOUT' })]));
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      timedOut = false;
      // Observe the real device credential-store boundary, not the Account
      // capture helper: distinct pool targets share this finite read's bearer.
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      const credentialReads = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
      const beforeSelectionRead = selectionReads.length;
      heldSecondSelection = createDeferred<void>();
      const refreshing = entry.refresh();
      const readPoolStates = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools
        ?.map(pool => [pool.group.groupId, pool.selection.status]);
      try {
        await expect.poll(readPoolStates).toEqual([['first', 'available'], ['second', 'pending']]);
        expect(selectionReads.slice(beforeSelectionRead).sort()).toEqual(['first', 'second']);
      } finally {
        heldSecondSelection.resolve();
        await refreshing;
      }
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(readPoolStates()).toEqual([['first', 'available'], ['second', 'available']]);
      expect(selectionReads.slice(beforeSelectionRead).sort()).toEqual(['first', 'second']);
      expect(credentialReads.mock.calls).toHaveLength(1);
      credentialReads.mockRestore();
      const pools = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools;
      expect(pools).toMatchObject([{ group: { service, groupId: 'first' }, memberAccountIds: ['work', 'personal'],
        selection: { status: 'available', machineId: 'selected', value: { selection: { selected: { profileId: 'work' } } } } },
        { group: { service, groupId: 'second' }, memberAccountIds: ['work'] }]);
      expect(pools?.[0]?.selection.value).toMatchObject({ selection: {
        excluded: [{ profileId: 'personal', reason: 'auth_invalid' }], decisionTrace: {
          sticky: true, orderedEligibleCandidates: [{ profileId: 'work', leastLimitedScore: null }],
          candidates: [
            { profileId: 'work', decision: 'selected', quotaEvidence: { status: 'stale_or_missing' } },
            { profileId: 'personal', decision: 'excluded', exclusionReason: 'auth_invalid',
              quotaEvidence: { status: 'stale_or_missing' } },
          ],
        },
      } });
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources.filter(source => source.source.startsWith('selection:')))
        .toEqual(expect.arrayContaining([expect.objectContaining({ status: 'available', asOfMs: 100 })]));
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources.some(source => source.errorCode === 'MACHINE_RPC_TIMEOUT')).toBe(false);
      selectedId = 'personal';
      publishHomeAccountChange(captured.accountLifetime.scope.serverId);
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.[0]?.selection.value)
        .toMatchObject({ selection: { selected: { profileId: 'personal' } } });
      timedOut = true;
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.every(pool =>
        pool.selection.status === 'stale' && pool.selection.value !== undefined)).toBe(true);
      timedOut = false;
      denied = true;
      const beforeDenial = deniedRpcReads;
      await entry.refresh();
      expect(deniedRpcReads, 'The admitted Machine must actually answer with the RPC refusal').toBeGreaterThan(beforeDenial);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.map(pool => ({
        status: pool.selection.status, value: pool.selection.value, errorCode: pool.selection.errorCode,
      }))).toEqual([
        { status: 'error', value: undefined, errorCode: RPC_ERROR_CODES.FORBIDDEN },
        { status: 'error', value: undefined, errorCode: RPC_ERROR_CODES.FORBIDDEN },
      ]);
      denied = false;
      timedOut = true;
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.every(pool =>
        pool.selection.value === undefined)).toBe(true);
      timedOut = false;
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const ambiguousCredentialReads = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
      const ambiguous = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({})] });
      expect(ambiguous.results[0]?.pools?.every(pool => pool.selection.status === 'unknown' && pool.selection.machineId === undefined)).toBe(true);
      expect(ambiguousCredentialReads.mock.calls).toHaveLength(0);
      ambiguousCredentialReads.mockRestore();
      denied = false;
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      await entry.refresh();
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.[0]?.selection.value)
        .toMatchObject({ selection: { selected: { profileId: 'personal' } } });
      const acquisitions = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
      const beforeUnrelatedFlip = acquisitions();
      recordMachineRequestFailed({ ...captured.accountLifetime.scope, machineId: 'other' });
      await flushHookEffects();
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(acquisitions(), 'an unrelated machine must not re-acquire accounting').toBe(beforeUnrelatedFlip);
      const beforeSelectedFailure = scmTransport.mock.calls.length;
      recordMachineRequestFailed({ ...captured.accountLifetime.scope, machineId: 'selected' });
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.[0]?.selection)
        .toMatchObject({ status: 'stale', machineId: 'selected', errorCode: 'MACHINE_RPC_UNREACHABLE',
          value: { selection: { selected: { profileId: 'personal' } } } });
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(acquisitions(), 'selector reachability changes reproject B without rereading unchanged server accounting').toBe(beforeUnrelatedFlip);
      expect(scmTransport.mock.calls.length, 'failed admission must settle without another selector RPC').toBe(beforeSelectedFailure);
      recordMachineRequestSucceeded({ ...captured.accountLifetime.scope, machineId: 'selected' });
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.[0]?.selection.status).toBe('available');
      const beforeWithdrawal = scmTransport.mock.calls.length;
      withdrawMachinePresenceForScope(captured.accountLifetime.scope);
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.[0]?.selection)
        .toMatchObject({ status: 'available', machineId: 'selected',
          value: { selection: { selected: { profileId: 'personal' } } } });
      expect(scmTransport.mock.calls.length, 'socket withdrawal supplies no new Machine fact or selector retry').toBe(beforeWithdrawal);
      recordMachineRequestSucceeded({ ...captured.accountLifetime.scope, machineId: 'selected' });
      observeMachinePresenceForTest(captured.accountLifetime.scope, ['selected']);
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.[0]?.selection.status).toBe('available');
      unavailable = true;
      const terminal = await readUiUsageQueryBatch(captured, { queries: [query] });
      expect(terminal.results[0]?.pools?.map(pool => pool.selection)).toEqual([
        expect.objectContaining({ status: 'error', errorCode: 'connected_account_daemon_runtime_unavailable' }),
        expect.objectContaining({ status: 'error', errorCode: expect.any(String) }),
      ]);
      machines = [createMachineFixture({ id: 'selected', activeAt: Date.now(), revokedAt: Date.now() })];
      await sync.refreshMachines();
      const revoked = await readUiUsageQueryBatch(captured, { queries: [query] });
      expect(revoked.results[0]?.pools?.every(pool => pool.selection.status === 'unsupported'
        && pool.selection.errorCode === 'no_machine' && pool.selection.machineId === undefined)).toBe(true);
      machines = [createMachineFixture({ id: 'selected', activeAt: Date.now(), replacedByMachineId: 'new-machine' })];
      await sync.refreshMachines();
      const replaced = await readUiUsageQueryBatch(captured, { queries: [query] });
      expect(replaced.results[0]?.pools?.every(pool => pool.selection.status === 'unsupported'
        && pool.selection.errorCode === 'no_machine' && pool.selection.machineId === undefined)).toBe(true);
    } finally { release(); }
  });

  it('publishes a ready current slice before a held comparison and distinct query', async () => {
    const held = createDeferred<Response>();
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
      return query.dateRange?.startMs === 1000 && query.filters?.agentIds?.includes('claude') ? Response.json(value) : held.promise.then(response => response.clone());
    });
    const current = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 }, agents: ['claude'] });
    const other = normalizeUsageQuery({ ...current, agents: ['codex'] });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [current, other] }) });
    const startedAt = performance.now();
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => {
        const content = entry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results.find(slice => slice.key === getUsageQueryKey(current))?.accounting;
      }).toMatchObject(value);
      const firstUsefulMs = performance.now() - startedAt;
      const batch = decodeUsageQueryResource(entry.getSnapshot().value!);
      expect(batch.results.find(slice => slice.key === getUsageQueryKey(current))?.comparison?.source.status).toBe('pending');
      expect(batch.results.find(slice => slice.key === getUsageQueryKey(other))).toMatchObject({ pending: true,
        sources: expect.arrayContaining([{ source: 'accounting', status: 'pending' }]) });
      expect(batch.results.find(slice => slice.key === getUsageQueryKey(other))?.accounting).toBeUndefined();
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results
        .find(slice => slice.key === getUsageQueryKey(current))?.sources.find(source => source.source === 'work')?.status).toBe('unknown');
      held.resolve(Response.json(value));
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const settledMs = performance.now() - startedAt;
      expect(firstUsefulMs).toBeLessThan(settledMs);
      console.info(`Usage held-source timing: first useful ${firstUsefulMs.toFixed(1)}ms; settled ${settledMs.toFixed(1)}ms`);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results.every(slice => slice.accounting !== undefined)).toBe(true);
    } finally { held.resolve(Response.json(value)); release(); }
  });

  it.each(['outstanding', 'completed'] as const)('settles a malformed refresh when the comparison is %s and reacquires Accounting on an allowance wake', async completion => {
    const held = createDeferred<void>();
    const range = { startMs: 2000, endMs: 3000 };
    let generation = 1;
    let malformed = false;
    const captured = await context(async request => {
      if (request.path !== '/v2/usage/query-batch') return undefined;
      const { queries } = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
      const results = queries.map(query => ({ query, value: { ...value, totals: { ...value.totals,
        eventCount: generation + (query.dateRange?.startMs === range.startMs ? 0 : 10) } } }));
      if (!malformed) return Response.json({ v: 1, results });
      if (completion === 'outstanding') {
        await held.promise;
        return Response.json({ v: 1, results: [] });
      }
      const comparison = results.find(row => row.query.dateRange?.endMs === range.startMs)!;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ v: 1, results: [comparison] }) + '\n'));
        },
        async pull(controller) { await held.promise; controller.close(); },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    const query = normalizeUsageQuery({ period: range, includeComparison: true, includeQuota: true,
      includeQuotaHistory: false, includeCoach: false, includeWorkEvidence: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const slice = () => {
      const content = entry.getSnapshot().value;
      return content && decodeUsageQueryResource(content).results[0];
    };
    const reads = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch').length;
    const release = entry.subscribe(() => {}, true);
    let refresh: Promise<unknown> | undefined;
    try {
      await expect.poll(() => entry.getSnapshot().pending === 'idle' && entry.getSnapshot().subscription === 'live'
        && slice()?.comparison?.accounting?.totals.eventCount === 11).toBe(true);
      const before = reads();
      generation = 2;
      malformed = true;
      refresh = entry.refresh();
      await expect.poll(reads).toBe(before + 1);
      await expect.poll(() => slice()?.sources.find(source => source.source === 'accounting')?.status).toBe('pending');
      if (completion === 'completed') {
        await expect.poll(() => slice()?.comparison).toMatchObject({ source: { status: 'available' },
          accounting: { totals: { eventCount: 12 } } });
      } else {
        expect(slice()?.comparison?.source.status).toBe('pending');
      }
      held.resolve();
      await refresh;
      const code = 'usage_query_result_invalid';
      expect(entry.getSnapshot()).toMatchObject({ pending: 'idle', freshness: 'stale', error: { code } });
      expect.soft(slice()).toMatchObject({ pending: false, accounting: { totals: { eventCount: 1 } },
        sources: expect.arrayContaining([expect.objectContaining({ source: 'accounting', status: 'error', errorCode: code })]) });
      const expectedComparison = completion === 'completed'
        ? { source: { status: 'available' }, accounting: { totals: { eventCount: 12 } } }
        : { source: { status: 'error', errorCode: code }, accounting: { totals: { eventCount: 11 } } };
      expect.soft(slice()?.comparison).toMatchObject(expectedComparison);

      generation = 3;
      malformed = false;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['provider-account-usage'],
        { changeKinds: ['account'], usageQueryAffects: true, usageAccountingAffects: false });
      await expect.poll(reads).toBe(before + 2);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(entry.getSnapshot().error).toBeUndefined();
      expect(slice()).toMatchObject({ pending: false, accounting: { totals: { eventCount: 3 } },
        comparison: { source: { status: 'available' }, accounting: { totals: { eventCount: completion === 'completed' ? 12 : 13 } } } });
    } finally {
      held.resolve();
      await refresh;
      release();
    }
  });

  it('retains comparison facts when an exact query moves to another Resource batch', async () => {
    const held = createDeferred<Response>();
    let rereading = false;
    const captured = await context(request => request.path === '/v2/usage/query'
      ? rereading ? held.promise.then(response => response.clone()) : Response.json(value) : undefined);
    const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 }, includeSessionEvidence: false, includeWorkEvidence: false });
    const other = normalizeUsageQuery({ ...query, agents: ['codex'] });
    const store = getUsageQueryResourceStore(captured);
    const entryFor = (queries: typeof query[]) => store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries }) });
    const first = entryFor([query]);
    await first.refresh();
    expect(decodeUsageQueryResource(first.getSnapshot().value!).results[0]?.comparison?.accounting).toMatchObject(value);
    rereading = true;
    invalidateUsageQueryResources(captured.accountLifetime);
    const returning = entryFor([query, other]);
    const release = returning.subscribe(() => {}, false);
    try {
      await expect.poll(() => returning.getSnapshot().value !== undefined).toBe(true);
      const slice = decodeUsageQueryResource(returning.getSnapshot().value!).results.find(slice => slice.key === getUsageQueryKey(query))!;
      expect.soft(slice.accounting).toMatchObject(value);
      expect.soft(slice.comparison).toMatchObject({ accounting: value, source: { status: 'pending' } });
      held.resolve(Response.json({ ...value, totals: { ...value.totals, eventCount: 2 } }));
      await expect.poll(() => returning.getSnapshot().pending).toBe('idle');
      expect(decodeUsageQueryResource(returning.getSnapshot().value!).results[0]?.comparison?.accounting?.totals.eventCount).toBe(2);
    } finally { held.resolve(Response.json(value)); release(); }
  });

  it('keeps the witnessed rolling comparison outstanding while the next accounting window rereads', async () => {
    let now = Date.UTC(2026, 9, 16, 12);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const held = createDeferred<void>();
    let rereading = false;
    const captured = await context(async request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
      if (rereading) await held.promise;
      return Response.json({ ...value, coverage: { status: 'complete', reasons: [], missingDimensions: [], ranked: [], sources: [],
        range: { ...query.dateRange, complete: true } } });
    });
    const query = normalizeUsageQuery({ period: { relative: '7days' }, includeSessionEvidence: false, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    await entry.refresh();
    const previous = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    expect(previous.comparison?.accounting).toBeDefined();
    now += 30_000;
    rereading = true;
    const refreshing = entry.refresh();
    try {
      await expect.poll(() => entry.getSnapshot().value && decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources
        .find(source => source.source === 'accounting')?.status).toBe('pending');
      const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      expect.soft(slice.comparison).toMatchObject({ query: previous.comparison!.query,
        accounting: previous.comparison!.accounting, source: { status: 'pending' } });
    } finally { held.resolve(); await refreshing; }
    const replaced = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    expect(replaced.comparison?.query).not.toEqual(previous.comparison?.query);
    expect(replaced.comparison?.source.status).toBe('available');
  });

  it.each([true, false])('rejects late private evidence on Account retirement for explicit Session selection %s', async explicit => {
    let response: UsageAnalyticsQueryResponse = { ...value, contributions: [workContribution] };
    let held = false;
    const work = createDeferred<unknown>();
    const privateSession = createDeferred<Response>();
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(response)
      : request.path === '/v2/sessions/work-session' ? held ? privateSession.promise : Response.json({ error: 'unavailable' }, { status: 503 })
      : request.path === '/v1/account/encryption/currentness' ? Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) : undefined);
    storage.getState().applySessions([createSessionFixture({ id: 'work-session', active: true,
      serverId: captured.accountLifetime.scope.serverId, metadata: { machineId: 'work-machine', path: '/repo', host: 'test', homeDir: '/home/test' } })]);
    await publishMachineInventoryForTest(captured.accountLifetime.scope, [createHydratedPlainMachineFixture({ id: 'work-machine', accountId: 'account-a', machine: { activeAt: Date.now() } })]);
    scmTransport.mockImplementation(async request => held ? work.promise : workBatch(request, { status: 'unsupported' }));
    const query = normalizeUsageQuery({ ...(explicit ? { session: 'work-session' } : {}), period: { startMs: 0, endMs: 1000 } });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await entry.refresh();
      held = true;
      response = { ...response, totals: { ...value.totals, eventCount: 2 } };
      const refreshing = entry.refresh();
      await expect.poll(() => {
        const snapshot = entry.getSnapshot();
        expect(snapshot.error).toBeUndefined();
        const content = snapshot.value;
        return content && decodeUsageQueryResource(content).results[0]?.accounting?.totals.eventCount;
      }).toBe(2);
      expect(entry.getSnapshot().pending).toBe('refresh');
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual(expect.objectContaining({ source: 'work', status: 'pending' }));
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'pending' }));
      retireActiveServerAccountScopeLifetime();
      work.resolve(ScmWorkEvidenceReadResponseSchema.parse({ sessions: [{ sessionId: 'work-session', status: 'unsupported' }] }));
      privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
      await refreshing;
      await flushHookEffects();
      expect(entry.getSnapshot().value).toBeUndefined();
    } finally { work.resolve(ScmWorkEvidenceReadResponseSchema.parse({ sessions: [{ sessionId: 'work-session', status: 'unsupported' }] })); privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 })); release(); }
  });

  it('reads chosen Account night hours through the recorded activity query without inventing private busy duration', async () => {
    const accounting: UsageAnalyticsQueryResponse = { ...value, activity: {
      weekdayHourBuckets: [{ weekday: 5, hour: 0, eventCount: 7 }, { weekday: 5, hour: 12, eventCount: 3 }] } };
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
    storage.setState({ settings: settingsParse({ usageNightHoursV1: { startHour: 23, endHour: 7 } }), settingsScope: captured.accountLifetime.scope });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 86400000 }, timeZoneOffsetMinutes: 120 });
    const batch = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(batch.results[0]?.howYouWork?.nightShift).toEqual({ startHour: 23, endHour: 7, recordedActivityCount: 7, observedBusyMs: null });
    storage.setState({ settings: settingsParse({ usageNightHoursV1: { startHour: 9, endHour: 17 } }),
      settingsScope: { serverId: 'foreign-home', accountId: 'foreign-account' } });
    expect((await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.howYouWork?.nightShift)
      .not.toEqual(expect.objectContaining({ startHour: 9, endHour: 17 }));
    storage.setState({ settings: settingsParse({}), settingsScope: captured.accountLifetime.scope });
    expect((await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.howYouWork?.nightShift).toBeNull();
  });
  it('projects and refreshes chosen night hours while private Session evidence remains pending', async () => {
    const privateSession = createDeferred<Response>();
    const requestedPrivate = createDeferred<void>();
    const accounting: UsageAnalyticsQueryResponse = { ...value, contributions: [workContribution], activity: {
      weekdayHourBuckets: [{ weekday: 5, hour: 0, eventCount: 7 }, { weekday: 5, hour: 12, eventCount: 3 }] } };
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(accounting)
      : request.path === '/v2/sessions/work-session' ? (requestedPrivate.resolve(), privateSession.promise) : undefined,
      undefined, { usageNightHoursV1: { startHour: 22, endHour: 6 } });
    storage.setState({ settingsScope: captured.accountLifetime.scope,
      settings: settingsParse({ usageNightHoursV1: { startHour: 22, endHour: 6 } }) });
    const query = normalizeUsageQuery({ session: 'work-session', period: { startMs: 0, endMs: 86400000 }, timeZoneOffsetMinutes: 120 });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    const night = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.nightShift;
    const refreshing = entry.refresh();
    try {
      await requestedPrivate.promise;
      await expect.poll(night).toEqual({ startHour: 22, endHour: 6, recordedActivityCount: 7, observedBusyMs: null });
      expect(entry.getSnapshot().pending).not.toBe('idle');
      storage.setState({ settings: settingsParse({ usageNightHoursV1: { startHour: 9, endHour: 17 } }) });
      await expect.poll(night).toEqual({ startHour: 9, endHour: 17, recordedActivityCount: 3, observedBusyMs: null });
      storage.setState({ settings: settingsParse({ usageNightHoursV1: null }) });
      await expect.poll(night).toBeNull();
    } finally { privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 })); await refreshing; release(); }
  });
  it('keeps the mounted Account owner and its subscription through an identical exact-Home credential write', async () => {
    let response = value;
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(response) : undefined);
    const reference = { hostRead: 'usage.query' as const, input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({})] }) };
    const entry = getUsageQueryResourceStore(captured).getEntry(reference);
    const advanced = createDeferred<void>();
    const release = entry.subscribe(() => {
      const content = entry.getSnapshot().value;
      if (content && decodeUsageQueryResource(content).results[0]?.accounting?.totals.eventCount === 2) advanced.resolve();
    }, true);
    try {
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting).toMatchObject(value);
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      expect(await TokenStorage.setCredentialsForServerUrl(home!.homes.a!.serverUrl,
        { serverId: captured.accountLifetime.scope.serverId }, captured.credentials)).toBe(true);
      expect(captured.accountLifetime.isCurrent()).toBe(true);
      expect(entry.getSnapshot().value).toBeDefined();
      const replacement = captureUiUsageQueryAccountContext(captured.credentials);
      expect(replacement?.accountLifetime).toBe(captured.accountLifetime);
      if (!replacement) throw new Error('Expected unchanged Account owner');
      const nextEntry = getUsageQueryResourceStore(replacement).getEntry(reference);
      expect(nextEntry.getSnapshot()).toBe(entry.getSnapshot());
      response = { ...value, totals: { ...value.totals, eventCount: 2 } };
      publishHomeAccountChange(replacement.accountLifetime.scope.serverId);
      await advanced.promise;
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting).toMatchObject(response);
    } finally { release(); }
  });

  it('withdraws native opened provider facts on genuine authority loss but retains ordinary read failure', async () => {
    const recordKey = { providerId: 'codex', accountSubjectId: 'provider-native', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const now = Date.now();
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'provider-native' }, observedAtMs: now,
      fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
    let refusal = 0;
    const captured = await context(request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return refusal
        ? new Response('read refused', { status: refusal }) : Response.json({ content: { t: 'plain', v: snapshot },
          metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [] });
      return undefined;
    });
    const serverBasis = getActiveServerSnapshot();
    await getServerFeaturesSnapshot({ serverId: serverBasis.serverId, force: true });
    const providerScope = buildProviderAccountUsageScopeKey({ serverId: captured.accountLifetime.scope.serverId,
      generation: serverBasis.generation, credentialScope: resolveAuthCredentialsScopeKey(captured.credentials) });
    const hook = await renderHook(({ fetchPolicy }: { fetchPolicy: 'poll' | 'cache_only' }) =>
      useProviderAccountUsageSnapshots([snapshot.recordId], { fetchPolicy }), {
      initialProps: { fetchPolicy: 'poll' }, flushOptions: { cycles: 30 },
      wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials: captured.credentials, children }),
    });
    expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]).toEqual(snapshot);
    const reread = async (status: number) => {
      await hook.rerender({ fetchPolicy: 'cache_only' });
      refusal = status;
      await act(async () => { updateProviderAccountUsageCacheEntries(providerScope, entries => ({ ...entries,
        [snapshot.recordId]: { ...entries[snapshot.recordId]!, nextFetchAtMs: 0 } })); });
      await hook.rerender({ fetchPolicy: 'poll' });
      await flushHookEffects({ cycles: 30 });
    };
    await reread(400);
    expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]).toEqual(snapshot);
    await reread(403);
    expect(hook.getCurrent().snapshotsByRecordId[snapshot.recordId]).toBeNull();
  });

  it.each([false, true])('publishes each current account independently of held history and a failed sibling (failure first: %s)', async failureFirst => {
    let readStarted = 0;
    const timings: Partial<Record<'actionHttp' | 'currentResponse' | 'resourceCurrent' | 'resourceError' | 'settled', number>> = {};
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'ready' };
    const slowRef = { ...ref, accountId: 'slow' };
    const source = { bindingKind: 'account' as const, ref };
    const slowSource = { bindingKind: 'account' as const, ref: slowRef };
    const now = Date.now();
    const recordKey = { providerId: 'codex', accountSubjectId: 'ready', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const slowRecordId = buildProviderAccountUsageRecordId({ ...recordKey, accountSubjectId: 'slow' });
    let retrySlow = false;
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'ready' }, observedAtMs: now,
      fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'five_hour', label: 'Five hours', used: 40, limit: 100, usedPct: 40, utilizationPct: 40,
        unit: 'count', status: 'ok', resetAtMs: now + 3_600_000, resetsAt: now + 3_600_000, windowDurationMs: 18_000_000 }] });
    const history = createDeferred<Response>();
    const slow = createDeferred<Response>();
    const current = createDeferred<Response>();
    const accounting = createDeferred<Response>();
    const sourceStarted = createDeferred<void>();
    const slowSnapshot = ProviderAccountUsageSnapshotV1Schema.parse({ ...snapshot, recordId: slowRecordId,
      recordKey: { ...recordKey, accountSubjectId: 'slow' }, accountSubject: { kind: 'providerSubject', id: 'slow' } });
    const currentResponse = () => Response.json({ content: { t: 'plain', v: snapshot },
      metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return failureFirst ? accounting.promise.then(response => response.clone()) : Response.json(value);
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        timings.actionHttp ??= performance.now() - readStarted;
        return request.url.searchParams.get('source')?.includes('slow') ? Response.json({ source: slowSource,
          recordId: slowRecordId, providerAccountId: 'slow', fetchedAt: now, staleAfterMs: 60_000 }) : Response.json({ source,
          recordId: snapshot.recordId, providerAccountId: 'ready', fetchedAt: now, staleAfterMs: 60_000 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
        if (request.url.searchParams.get('recordId') === slowRecordId) {
          sourceStarted.resolve();
          return retrySlow ? Response.json({ content: { t: 'plain', v: slowSnapshot },
            metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [slowSource] }) : slow.promise;
        }
        return Promise.resolve(failureFirst ? current.promise : currentResponse())
          .then(response => { timings.currentResponse = performance.now() - readStarted; return response.clone(); });
      }
      // Every HTTP request has its own body, including the sibling and subsequent Retry read.
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        return 'projection' in query ? Response.json({ projection: null, complete: false })
          : history.promise.then(response => response.clone());
      }
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    }, {
      connectedAccountsV4: [ref, slowRef].map(ref => ({ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] })) });
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ period: { relative: '7days' } }] }) });
    const slice = () => { const content = entry.getSnapshot().value; return content ? decodeUsageQueryResource(content).results[0] : undefined; };
    const slowState = () => slice()?.sources.find(state => state.source.startsWith('quota:') && state.source.includes('slow'));
    readStarted = performance.now();
    const release = entry.subscribe(() => {
      if (slice()?.quota?.[0]?.current) timings.resourceCurrent ??= performance.now() - readStarted;
      if (slowState()?.status === 'error') timings.resourceError ??= performance.now() - readStarted;
      if (entry.getSnapshot().pending === 'idle') timings.settled ??= performance.now() - readStarted;
    }, false);
    try {
      if (failureFirst) {
        await sourceStarted.promise;
        slow.resolve(Response.json({ error: 'snapshot_read_failed' }, { status: 503 }));
        await expect.poll(slowState).toMatchObject({ status: 'error', errorCode: 'snapshot_read_failed' });
        expect(slice()?.sources).toContainEqual(expect.objectContaining({ source: 'quota', status: 'pending' }));
        expect(slice()?.quota).toBeUndefined();
        current.resolve(currentResponse());
      }
      await expect.poll(() => slice()?.quota?.[0]?.current).toEqual(snapshot);
      expect(projectUsagePlans(slice()?.quota, now).accounts[0]?.headline?.remainingFraction).toBe(0.6);
      expect(entry.getSnapshot().pending).toBe('initial');
      expect(slice()?.pending, 'the held quota history must still own pending').toBe(true);
      const historyDrains = () => home!.requests.filter(request => request.method === 'GET'
        && request.path === '/v4/connect/qualified/provider-account-usage/history'
        && 'history' in parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'))).length;
      await expect.poll(historyDrains).toBe(1);
      if (!failureFirst) {
        for (let index = 0; index < 3; index++) publishHomeAccountChange(captured.accountLifetime.scope.serverId,
          ['provider-account-usage'], { changeKinds: ['account'], usageQueryAffects: true });
        await flushHookEffects({ cycles: 20 });
      }
      if (!failureFirst) expect(slowState()).toMatchObject({ status: 'pending' });
      const { UsageCapacityWidget } = await import('@/components/settings/usage/widgets/UsageCapacityWidget');
      const { UsagePlanFitWidget } = await import('@/components/settings/usage/widgets/UsagePlanFitWidget');
      const body = () => {
        const shown = slice()!;
        const model = { requestedQuery: { query: shown.requestedQuery, authority: captured.accountLifetime.scope },
          shownQuery: { query: shown.shownQuery, authority: captured.accountLifetime.scope }, slice: shown,
          pending: shown.pending, error: null, freshness: 'fresh', updatingPreviousPeriod: false,
          refreshing: entry.getSnapshot().pending !== 'idle', refresh: async () => { await entry.refresh(); } } satisfies UsageWidgetBodyModel;
        const props = { model, slice: shown, query: shown.shownQuery, serverId: captured.accountLifetime.scope.serverId };
        return React.createElement(InjectedAuthProvider, { credentials: captured.credentials,
          children: React.createElement(React.Fragment, null,
            React.createElement(UsageCapacityWidget, { ...props, id: 'usage_capacity', testID: 'quota-capacity' }),
            React.createElement(UsagePlanFitWidget, { ...props, id: 'usage_plan_fit', testID: 'quota-fit' })) });
      };
      const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
      const screen = await renderMountedCurrentUiContext(body());
      expect(screen.findByTestId('quota-capacity.cell.ready')).toBeTruthy();
      if (failureFirst) {
        // The current Plans presentation collapses settled never-read accounts
        // into its unread line; the qualified failure and Retry remain visible.
        expect(screen.findByTestId('quota-capacity.cell.slow')).toBeNull();
        expect(screen.findByTestId('quota-capacity.unread')).toBeTruthy();
        expect(screen.findByTestId('quota-fit.plan.slow')).toBeNull();
        expect(slowState()).toMatchObject({ status: 'error', errorCode: 'snapshot_read_failed' });
      } else {
        expect(screen.findByTestId('quota-capacity.cell.slow')).toBeNull();
        expect(screen.findByTestId('quota-fit.plan.slow')).toBeNull();
      }
      if (!failureFirst) {
        expect(screen.findByTestId('quota-capacity.reading')).toBeTruthy();
        expect(screen.findHostByTestId('quota-capacity.state')).toBeNull();
      }
      slow.resolve(Response.json({ error: 'snapshot_read_failed' }, { status: 503 }));
      await expect.poll(slowState).toMatchObject({ status: 'error', errorCode: 'snapshot_read_failed' });
      await screen.update(body());
      expect(screen.findByTestId('quota-capacity.state-action')).toBeTruthy();
      expect(screen.findByTestId('quota-fit.state-action')).toBeTruthy();
      expect(screen.findByTestId('quota-capacity.cell.ready')?.props.accessibilityLabel).toContain('60%');
      expect(slice()?.quota?.[0]?.current).toEqual(snapshot);
      expect(entry.getSnapshot().pending).toBe('initial');
      expect(slice()?.pending, 'the held quota history must still own pending').toBe(true);
      history.resolve(Response.json({ entries: [], nextCursor: null }));
      accounting.resolve(Response.json(value));
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(slice()?.pending, 'terminal quota operands cannot keep the slice pending').toBe(false);
      if (!failureFirst) expect.soft(historyDrains(),
        'Quota arrivals age the admitted finite history read without starting replacement drains').toBe(1);
      expect(slowState()).toMatchObject({ status: 'error', errorCode: 'snapshot_read_failed' });
      expect(slice()?.quota?.[0]?.source).toEqual(source);
      expect(slice()?.quota?.some(read => read.source.ref.accountId === slowSource.ref.accountId)).toBe(false);
      retrySlow = true;
      await screen.pressByTestIdAsync('quota-capacity.state-action');
      await expect.poll(() => slice()?.quota?.find(read => read.source.ref.accountId === 'slow')?.current).toEqual(slowSnapshot);
      await expect.poll(slowState).toMatchObject({ status: 'available' });
      // Current allowance publishes before its history and any coalesced wake.
      // Assert the settled footer after that existing Resource read completes.
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      await screen.update(body());
      expect(screen.findHostByTestId('quota-capacity.state')).toBeNull();
      expect(screen.findHostByTestId('quota-fit.state')).toBeNull();
      expect(screen.findByTestId('quota-capacity.cell.slow')?.props.accessibilityLabel).toContain('60%');
      console.info('PERF-PLANS source hop timings', JSON.stringify({ failureFirst, ...timings }));
    } finally { accounting.resolve(Response.json(value)); current.resolve(currentResponse()); slow.resolve(Response.json({ error: 'snapshot_read_failed' }, { status: 503 }));
      history.resolve(Response.json({ entries: [], nextCursor: null })); release(); }
  });

  it.each([true, false])('refreshes accounting on unrelated arrivals without demanding unchanged quota inputs (complete=%s)', async initiallyComplete => {
    const now = Date.now();
    let catchUpRows: ApiChangeEntry[] = [];
    let catchUpCursor = 0;
    let cursorGone = false;
    let allSourcesAvailable = initiallyComplete;
    let heldAccounting: ReturnType<typeof createDeferred<void>> | null = null;
    const refs = ['one', 'two', 'three'].map(accountId => ({ service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId }));
    const sources = refs.map(ref => ({ bindingKind: 'account' as const, ref }));
    const profile: Parameters<typeof context>[1] = { connectedAccountsV4: refs.map(ref => ({ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] })) };
    const snapshots = refs.map(ref => {
      const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account' as const, quotaScope: 'account' as const };
      return ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
        staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
    });
    const captured = await context(async request => {
      if (request.path === '/v2/changes') {
        if (cursorGone) { cursorGone = false; return Response.json({ error: 'cursor-gone', currentCursor: catchUpCursor }, { status: 410 }); }
        return Response.json({ changes: catchUpRows.filter(row => row.cursor > Number(request.url.searchParams.get('after'))), nextCursor: catchUpCursor });
      }
      if (request.path === '/v2/cursor') return Response.json({ cursor: catchUpCursor, changesFloor: 0 });
      if (request.path === '/v2/sessions/catch-up-session') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'catch-up-session' }) });
      if (request.path === '/v1/artifacts/read') return createArtifactReadBatchHttpResponse(request.body, artifactId => ({ artifactId, ok: false,
        error: 'artifact_not_found', status: 404, retryable: false }));
      if (request.path === '/v1/machines') return Response.json([]);
      if (request.path === '/v2/sessions' || request.path === '/v2/sessions/active') return Response.json({ sessions: [], nextCursor: null, hasNext: false });
      if (request.path === '/v2/usage/query') { await heldAccounting?.promise; return Response.json(value); }
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        const source = JSON.parse(request.url.searchParams.get('source')!);
        const index = refs.findIndex(ref => ref.accountId === source.ref.accountId);
        if (!allSourcesAvailable && index === 2) return new Response('source unavailable', { status: 404 });
        return Response.json({ source: sources[index], recordId: snapshots[index]!.recordId, providerAccountId: refs[index]!.accountId,
          fetchedAt: now, staleAfterMs: 60_000 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
        const index = snapshots.findIndex(snapshot => snapshot.recordId === request.url.searchParams.get('recordId'));
        return Response.json({ content: { t: 'plain', v: snapshots[index] },
          metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [sources[index]] });
      }
      return undefined;
    }, profile);
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const query = normalizeUsageQuery({ period: { startMs: now - 1000, endMs: now + 1000 },
      includeQuotaHistory: false, includeSessionEvidence: false, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    const reads = (path: string) => home!.requests.filter(request => request.path === path).length;
    const sourcePath = '/v4/connect/qualified/provider-account-usage/sources/resolve';
    const recordPath = '/v4/connect/qualified/provider-account-usage/record';
    try {
      await entry.refresh();
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const sourcesBefore = reads(sourcePath);
      const recordsBefore = reads(recordPath);
      expect(sourcesBefore).toBeGreaterThanOrEqual(3);
      expect(recordsBefore).toBeGreaterThanOrEqual(initiallyComplete ? 3 : 2);
      allSourcesAvailable = true;
      const pricePath = '/v1/account/entity-rows/connected-metadata/presentation';
      const pricesBefore = reads(pricePath);
      const wakes: HomeAccountChangeEvent[] = [];
      const stopWakes = subscribeHomeAccountChange(event => wakes.push(event));
      try {
        for (let reconnect = 0; reconnect < 3; reconnect++) {
          catchUpRows = ['session', 'artifact', 'machine'].map(kind => ({ kind, entityId: kind === 'session' ? 'catch-up-session' : `catch-up-${kind}`,
            cursor: ++catchUpCursor, changedAt: now }));
          await sync.resumeSync('socket-reconnect');
          await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
          const accountingBeforeEmpty = reads('/v2/usage/query');
          catchUpRows = [];
          await sync.resumeSync('socket-reconnect');
          await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
          expect.soft(reads('/v2/usage/query'), 'An empty reconnect retains the settled accounting batch').toBe(accountingBeforeEmpty);
        }
        expect(wakes.filter(event => event.feedPageConsumed)).toHaveLength(3);
        expect(wakes.every(event => event.source === 'catch-up-pending' || event.feedPageConsumed === true), 'No fallback/reset was requested by the unrelated pages').toBe(true);
        expect.soft(reads(sourcePath), 'Real reconnect catch-up and empty pages do not change quota inputs').toBe(sourcesBefore);
        expect.soft(reads(recordPath)).toBe(recordsBefore);
        expect.soft(reads(pricePath), 'Transport withdrawal is not a monthly-price change').toBe(pricesBefore);
      } finally { stopWakes(); }
      for (const [kind, id] of [
        ['session', 'session-arrival'], ['artifact', 'artifact-arrival'], ['account', 'unrelated-account-fact'],
        ['artifact', 'artifact-arrival-2'], ['account', 'unrelated-account-fact-2'], ['session', 'session-arrival-2'],
      ]) {
        const accountingBefore = reads('/v2/usage/query');
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, [id!], { changeKinds: [kind!], usageQueryAffects: true });
        await expect.poll(() => reads('/v2/usage/query')).toBeGreaterThan(accountingBefore);
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      }
      expect.soft(reads(sourcePath), 'Unrelated arrivals do not demand quota, including incomplete/stale observations').toBe(sourcesBefore);
      expect.soft(reads(recordPath)).toBe(recordsBefore);
      expect.soft(reads(pricePath), 'Unrelated arrivals do not read monthly price').toBe(pricesBefore);
      const { handleEphemeralSocketUpdate } = await import('@/sync/engine/socket/socket');
      for (const type of ['usage', 'usage-sources-invalidated', 'usage'] as const) {
        const accountingBefore = reads('/v2/usage/query');
        await handleEphemeralSocketUpdate({ sourceServerId: captured.accountLifetime.scope.serverId,
          update: type === 'usage'
            ? { type, id: null, key: 'agent:model', tokens: { total: 1 }, cost: { total: 0 }, timestamp: now }
            : { type, machineId: 'machine', installationId: 'installation' },
          addActivityUpdate: () => {}, addMachineActivityUpdate: () => {}, getSessionEncryption: () => null, getSession: () => undefined, applyMessages: () => {},
        });
        if (type === 'usage-sources-invalidated') {
          await flushHookEffects({ cycles: 20 });
          expect(reads('/v2/usage/query'), 'Source status has its own topic and changes no accounting fact').toBe(accountingBefore);
        } else await expect.poll(() => reads('/v2/usage/query')).toBeGreaterThan(accountingBefore);
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      }
      expect.soft(reads(sourcePath), 'Real accounting socket arrivals do not claim Provider quota changed').toBe(sourcesBefore);
      expect.soft(reads(recordPath)).toBe(recordsBefore);
      expect.soft(reads(pricePath)).toBe(pricesBefore);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.filter(row => row.current)).toHaveLength(initiallyComplete ? 3 : 2);
      catchUpRows = [{ kind: 'account', entityId: 'provider-account-usage', cursor: ++catchUpCursor, changedAt: now }];
      await sync.resumeSync('changes-catch-up');
      catchUpRows = [];
      await expect.poll(() => reads(sourcePath)).toBe(sourcesBefore + 3);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(reads(recordPath)).toBe(recordsBefore + 3);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.filter(row => row.current)).toHaveLength(3);
      await entry.refresh();
      expect(reads(sourcePath), 'Explicit refresh requests one fresh read per source').toBe(sourcesBefore + 6);
      expect(reads(recordPath)).toBe(recordsBefore + 6);
      const beforeConfiguration = reads(sourcePath);
      storage.setState(state => ({ profile: { ...state.profile, connectedAccountsV4: state.profile.connectedAccountsV4.map(account =>
        account.revisionSemantics === 'revisioned' ? { ...account, configurationRevision: 'changed-quota-input' } : account) } }));
      // The fake Home retains the same deliberate configuration, including
      // when the genuine cursor-gap snapshot reads its Profile again.
      profile.connectedAccountsV4 = storage.getState().profile.connectedAccountsV4;
      await expect.poll(() => reads(sourcePath)).toBe(beforeConfiguration + 3);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const beforePreference = reads(sourcePath);
      const beforePreferenceAccounting = reads('/v2/usage/query');
      storage.setState(state => ({ settings: { ...state.settings, usageModelPriceOverridesV1: {
        ...state.settings.usageModelPriceOverridesV1, model: { kind: 'rates' as const, inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
      } } }));
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(reads('/v2/usage/query'), 'Accounting price preferences reproject admitted A').toBe(beforePreferenceAccounting);
      expect(reads(sourcePath), 'Accounting price preferences do not change subscription quota inputs').toBe(beforePreference);
      const { invalidateAccountEncryptionModeCache } = await import('./apiAccountEncryptionMode');
      const beforeModeChange = reads(sourcePath);
      invalidateAccountEncryptionModeCache({ serverId: captured.accountLifetime.scope.serverId });
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['session-arrival'], { changeKinds: ['session'], usageQueryAffects: true });
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(reads(sourcePath), 'An Account-mode withdrawal still requires fresh allowance admission').toBe(beforeModeChange + 3);
      const beforeCaughtMode = reads(sourcePath);
      catchUpRows = [{ kind: 'account', entityId: 'self', cursor: ++catchUpCursor, changedAt: now, hint: { encryptionMode: 'plain' } }];
      await sync.resumeSync('changes-catch-up');
      catchUpRows = [];
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect.soft(reads(sourcePath), 'A mode withdrawal discovered by durable catch-up also requires fresh allowance admission').toBe(beforeCaughtMode + 3);
      for (const wake of [
        () => publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['session-arrival'], { source: 'connected', changesCatchUp: true, changeKinds: ['session'], usageQueryAffects: true }),
      ]) {
        const beforeSources = reads(sourcePath);
        const beforeRecords = reads(recordPath);
        wake();
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        expect(reads(sourcePath), 'Connection hints alone are not quota changes; the catch-up rows own that demand').toBe(beforeSources);
        expect(reads(recordPath)).toBe(beforeRecords);
      }
      if (initiallyComplete) {
        const beforeQueuedSources = reads(sourcePath);
        const beforeQueuedRecords = reads(recordPath);
        const beforeQueuedAccounting = reads('/v2/usage/query');
        const gate = createDeferred<void>();
        heldAccounting = gate;
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['session-arrival'], { changeKinds: ['session'], usageQueryAffects: true });
        await expect.poll(() => reads('/v2/usage/query')).toBeGreaterThan(beforeQueuedAccounting);
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['session-arrival'], { changeKinds: ['session'], usageQueryAffects: true });
        const manual = entry.refresh();
        heldAccounting = null;
        gate.resolve();
        await manual;
        expect(reads(sourcePath), 'A manual refresh queued with Session invalidation still requests a fresh allowance').toBe(beforeQueuedSources + 3);
        expect(reads(recordPath)).toBe(beforeQueuedRecords + 3);
      }
      const beforeReset = reads(sourcePath);
      cursorGone = true;
      await sync.resumeSync('changes-catch-up');
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(reads(sourcePath), 'A true cursor gap requests one fresh acquisition per source').toBe(beforeReset + 3);
      for (let empty = 0; empty < 3; empty++) await sync.resumeSync('socket-reconnect');
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(reads(sourcePath), 'After reset recovery, empty reconnect catch-ups do not repeat quota acquisition').toBe(beforeReset + 3);
    } finally { heldAccounting?.resolve(); release(); }
  });

  it.each(['ready', 'partial'] as const)('recalculates plan fit from %s persisted prices across shared allowance reads without reacquiring A or B', async catalogStatus => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const refs = ['one', 'two'].map(accountId => ({ service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId }));
    const sources = refs.map(ref => ({ bindingKind: 'account' as const, ref }));
    const snapshots = refs.map(ref => {
      const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account' as const, quotaScope: 'account' as const };
      return ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: now, fetchedAtMs: now,
        staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [],
        subscription: { status: 'subscribed', renewal: 'on', observedAtMs: now, staleAfterMs: 60_000,
          currentPeriodStartAtMs: now - 86_400_000, currentPeriodEndAtMs: now + 86_400_000 } });
    });
    const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
    const accounting: UsageAnalyticsQueryResponse = { v: 1,
      totals: { eventCount: refs.length, tokens: { ...tokens, input: tokens.input * refs.length, total: tokens.total * refs.length },
        cost: { reportedUsd: 3, estimatedUsd: 0, currency: 'USD' } },
      contributions: refs.map((connectedAccount, index) => ({ id: `plan-value-${index}`, eventCount: 1, observedAtMs: now - 1,
        sessionId: null, turnId: null, agentId: 'codex', modelId: 'plan-fit-model', machineId: null,
        projectKey: null, workspaceId: null, source: 'native', tokens,
        cost: { reportedUsd: 1.5, estimatedUsd: 0, currency: 'USD' }, providerAttribution: 'known', connectedAccount })) };
    const catalog = createDeferred<void>();
    const catalogStarted = createDeferred<void>();
    let catalogActive = false;
    let enteredAmount: number | undefined = 17;
    let label = '';
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') return Response.json(accounting);
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        const index = request.url.searchParams.get('source')?.includes('two') ? 1 : 0;
        return Response.json({ source: sources[index], recordId: snapshots[index]!.recordId, providerAccountId: refs[index]!.accountId,
          fetchedAt: now, staleAfterMs: 60_000 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') {
        const index = snapshots.findIndex(snapshot => snapshot.recordId === request.url.searchParams.get('recordId'));
        return Response.json({ content: { t: 'plain', v: snapshots[index] },
          metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [sources[index]] });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') return Response.json({ entries: [], nextCursor: null });
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      if (request.path === '/v1/account/entity-rows/connected-metadata/acknowledgements') {
        return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, entries: [] } } });
      }
      if (request.path === '/v1/account/entity-rows/connected-metadata/presentation') {
        // The HTTP boundary admits only one live read. Separate Account
        // contexts otherwise issue identical GETs and lose one source's price.
        if (catalogActive) return Response.json({ error: 'duplicate_read' }, { status: 429 });
        catalogActive = true;
        catalogStarted.resolve();
        try {
          await catalog.promise;
          return Response.json({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1,
            entries: [...refs.map(account => ({ v: 1, label, subject: { kind: 'account', account },
              ...(enteredAmount === undefined ? {} : { subscriptionMonthlyPrice: { amount: enteredAmount, currency: 'USD', enteredAtMs: now } }) })),
              ...(catalogStatus === 'partial' ? [{ v: 1, label: 123 }] : [])] } } });
        } finally { catalogActive = false; }
      }
      return undefined;
    }, {
      connectedAccountsV4: refs.map(ref => ({ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] })) },
      { usageModelPriceOverridesV1: { 'plan-fit-model': { kind: 'rates', inputUsdPerMillion: 34, outputUsdPerMillion: 0 } } });
    // Settle the real bootstrap/catch-up before measuring an unrelated catalog
    // edit. Snapshot recovery is itself genuine quota demand, not label demand.
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const input = { queries: [normalizeUsageQuery({ period: { startMs: now - 1000, endMs: now + 1000 } })] };
    const reading = readUiUsageQueryBatch(captured, input);
    try {
      await catalogStarted.promise;
      await flushHookEffects({ cycles: 20 });
      catalog.resolve();
      const first = await reading;
      console.info('PERF-PLANS shared Account reader', JSON.stringify({ sources: refs.length,
        currentnessReads: home!.requests.filter(request => request.path === '/v1/account/encryption/currentness').length,
        presentationReads: home!.requests.filter(request => request.path === '/v1/account/entity-rows/connected-metadata/presentation').length }));
      expect(first.results[0]?.quota?.map(row => row.current?.subscription?.enteredMonthlyPrice?.amount)).toEqual([17, 17]);
      const planValues = (result: ReturnType<typeof decodeUsageQueryResource>) => result.results[0]?.planInsights?.accounts.map(account => account.value);
      expect(planValues(first)).toEqual(refs.map(() => expect.objectContaining({ status: 'available', kind: 'api_equivalent', amountUsd: 34,
        priceMultiple: expect.objectContaining({ status: 'available', multiple: 2, priceKind: 'entered', priceAmount: 17,
          priceSource: 'user:you-entered:1', method: 'observed_api_equivalent_divided_by_period_price' }) })));
      enteredAmount = 29;
      const fresh = await readUiUsageQueryBatch(captured, input);
      expect(fresh.results[0]?.quota?.map(row => row.current?.subscription?.enteredMonthlyPrice?.amount)).toEqual([29, 29]);
      expect(planValues(fresh)).toEqual(refs.map(() => expect.objectContaining({ amountUsd: 34,
        priceMultiple: expect.objectContaining({ status: 'available', multiple: 34 / 29, priceKind: 'entered', priceAmount: 29 }) })));
      const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(input) });
      const release = entry.subscribe(() => {}, true);
      const { getConnectedMetadataCatalog } = await import('@/sync/store/settings/connectedMetadataCatalogSnapshot');
      const sourceReads = () => home!.requests.filter(request => request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve').length;
      const priceWakes: HomeAccountChangeEvent[] = [];
      const stopPriceWakes = subscribeHomeAccountChange(event => priceWakes.push(event));
      try {
        await expect.poll(() => entry.getSnapshot().subscription).toBe('live');
        await expect.poll(() => getConnectedMetadataCatalog(captured.accountLifetime.scope).presentation.status).toBe(catalogStatus);
        // Finish the existing explicit Refresh after watch admission, including
        // its queued baseline resync, before starting the label count window.
        await entry.refresh();
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        const beforeLabel = sourceReads();
        const acquisitionReads = () => home!.requests.filter(request => request.path === '/v2/usage/query'
          || request.path.startsWith('/v4/connect/qualified/provider-account-usage/')).length;
        const beforePresentation = acquisitionReads();
        priceWakes.length = 0;
        label = 'Renamed account';
        const catalogChanged = () => publishHomeAccountChange(captured.accountLifetime.scope.serverId,
          [CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1], { changeKinds: ['account'], usageQueryAffects: true });
        catalogChanged();
        await expect.poll(() => Object.values(getConnectedMetadataCatalog(captured.accountLifetime.scope).labelsByKey))
          .toEqual([label, label]);
        await flushHookEffects({ cycles: 20 });
        expect(priceWakes.some(event => event.source === 'snapshot'), 'The label measurement must not overlap a genuine snapshot reset').toBe(false);
        expect(sourceReads(), `A catalog label change is not a monthly-price input; observed wakes: ${JSON.stringify(priceWakes)}`).toBe(beforeLabel);
        enteredAmount = 41;
        catalogChanged();
        await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.map(row => row.current?.subscription?.enteredMonthlyPrice?.amount))
          .toEqual([41, 41]);
        await expect.poll(() => planValues(decodeUsageQueryResource(entry.getSnapshot().value!))).toEqual(refs.map(() => expect.objectContaining({ amountUsd: 34,
          priceMultiple: expect.objectContaining({ status: 'available', multiple: 34 / 41, priceKind: 'entered', priceAmount: 41 }) })));
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        expect(acquisitionReads(), 'An admitted monthly-price change does not acquire A or B').toBe(beforePresentation);
        enteredAmount = undefined;
        catalogChanged();
        await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.map(row => row.current?.subscription?.enteredMonthlyPrice))
          .toEqual([undefined, undefined]);
        await expect.poll(() => planValues(decodeUsageQueryResource(entry.getSnapshot().value!))).toEqual(refs.map(() => expect.objectContaining({ amountUsd: 34,
          priceMultiple: { status: 'insufficient_basis', reason: 'period_price_unavailable' } })));
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        expect(acquisitionReads(), 'Clearing the entered price withdraws it without acquiring A or B').toBe(beforePresentation);
        const beforeManual = sourceReads();
        await entry.refresh();
        expect(sourceReads(), 'One explicit Refresh reads each quota source exactly once').toBe(beforeManual + refs.length);
      } finally { stopPriceWakes(); release(); }
    } finally { catalog.resolve(); await reading.catch(() => {}); }
  });

  it.each([
    ['year', 'ready'], ['all', 'ready'], ['year', 'exact failure'], ['year', 'shared failure'], ['year', 'current-only sibling'],
    ['year', 'unobserved sibling on exact upgrade'], ['all', 'unobserved sibling on exact upgrade'],
  ] as const)(
    'keeps %s daily quota demand independent of a shorter exact-curve query (%s)', async (relative, scenario) => {
    const { buildProviderAccountUsageDaySummaryV1 } = await import('@happier-dev/protocol/connect/providerAccountUsageDaySummary');
    const day = 86_400_000;
    const now = Date.UTC(2026, 9, 15, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'daily-quota-demand' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const sample = (at: number, used: number) => ProviderAccountUsageSnapshotV1Schema.parse({ v: 1,
      recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'codex',
      accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: at, fetchedAtMs: at,
      staleAfterMs: day, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'daily', label: 'Daily', used, limit: 100, utilizationPct: used, resetsAt: Math.ceil(at / day) * day,
        windowDurationMs: day, unit: 'count', status: 'ok', details: {} }] });
    const snapshots = [sample(now - 10 * day, 20), sample(now - 3 * day, 30), sample(now - 3_600_000, 35), sample(now, 40)];
    const current = snapshots.at(-1)!;
    const unreadRef = { ...ref, accountId: 'daily-quota-unobserved' };
    const unreadSource = { bindingKind: 'account' as const, ref: unreadRef };
    const unreadRecordKey = { ...recordKey, accountSubjectId: unreadRef.accountId };
    const unread = ProviderAccountUsageSnapshotV1Schema.parse({ ...current, recordKey: unreadRecordKey,
      recordId: buildProviderAccountUsageRecordId(unreadRecordKey), accountSubject: { kind: 'providerSubject', id: unreadRef.accountId },
      state: 'error_last_known_good', observedAtMs: 0, fetchedAtMs: 0, meters: [] });
    const entries = snapshots.map((snapshot, index) => ({ id: `daily-resource-${index}`, observedAtMs: snapshot.fetchedAtMs,
      record: { content: { t: 'plain' as const, v: snapshot },
        metadata: { fetchedAt: snapshot.fetchedAtMs, staleAfterMs: day, status: 'ok' }, sources: [source] } }));
    const days = [...new Set(snapshots.map(snapshot => Math.floor(snapshot.fetchedAtMs / day) * day))].map(dayStartAtMs => {
      const rows = snapshots.filter(snapshot => Math.floor(snapshot.fetchedAtMs / day) * day === dayStartAtMs);
      const last = entries.filter(entry => Math.floor(entry.observedAtMs / day) * day === dayStartAtMs).at(-1)!;
      return { dayStartAtMs, payload: { v: 1, coverage: { observationCount: rows.length, frontier: { id: last.id, observedAtMs: last.observedAtMs } },
        content: { t: 'plain', v: buildProviderAccountUsageDaySummaryV1({ recordId: current.recordId, dayStartAtMs, snapshots: rows }) } } };
    });
    const historyRanges: { startAtMs: number; endAtMs: number }[] = [];
    const exactRanges: typeof historyRanges = [];
    let exactProjectionResponse: Promise<Response> | undefined;
    let pendingWitnessResponse: Promise<Response> | undefined;
    let witnessRequested = false;
    const captured = await context(request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
        connectedServices: { enabled: true, quotas: { enabled: true } },
      } }));
      if (request.path.endsWith('/sources/resolve')) {
        const requested = JSON.parse(request.url.searchParams.get('source')!);
        const unavailable = requested.ref.accountId === unreadRef.accountId;
        return Response.json({ source: unavailable ? unreadSource : source, recordId: unavailable ? unread.recordId : current.recordId,
          providerAccountId: requested.ref.accountId, fetchedAt: unavailable ? 0 : now, staleAfterMs: day });
      }
      if (request.path.endsWith('/record')) {
        const unavailable = request.url.searchParams.get('recordId') === unread.recordId;
        return Response.json({ content: { t: 'plain', v: unavailable ? unread : current },
          metadata: { fetchedAt: unavailable ? 0 : now, staleAfterMs: day, status: unavailable ? 'unavailable' : 'ok' },
          sources: [unavailable ? unreadSource : source] });
      }
      if (request.path.endsWith('/day-summaries')) {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(ProviderAccountUsageDaySummaryReadV1Schema,
          request.url.searchParams.get('query'));
        return Response.json({ summaries: query.recordId === unread.recordId ? [] : days, missingDays: [] });
      }
      if (request.path.endsWith('/history')) {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        if (query.recordId === unread.recordId) return 'projection' in query ? Response.json({ projection: null, complete: false })
          : new Response(JSON.stringify({ entries: [], nextCursor: null }) + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
        if ('projection' in query) {
          exactRanges.push(query.projection.range);
          return exactProjectionResponse ?? Response.json({ projection: null, complete: false });
        }
        if ('witness' in query && pendingWitnessResponse) {
          witnessRequested = true;
          return pendingWitnessResponse;
        }
        if (!('history' in query)) throw new Error('Unexpected exact witness query');
        historyRanges.push(query.history.range);
        const page = { entries: entries.filter(entry => entry.observedAtMs >= query.history.range.startAtMs && entry.observedAtMs < query.history.range.endAtMs), nextCursor: null };
        return new Response(JSON.stringify(page) + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
      }
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: pendingWitnessResponse ? [{
        sessionId: 'queued-session', localId: 'queued-reset', authorityCurrent: true,
        reset: { source, recordId: current.recordId, meterId: 'daily', witness: { id: entries[0]!.id, observedAtMs: entries[0]!.observedAtMs } },
      }] : [] });
      return undefined;
    }, { connectedAccountsV4: (scenario === 'unobserved sibling on exact upgrade' ? [ref, unreadRef] : [ref]).map(ref =>
      ({ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] })) });
    const daily = normalizeUsageQuery({ period: { relative }, includeAccounting: false, includeQuota: true,
      includeQuotaHistory: true, includeQuotaExactHistory: false, includeComparison: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const exact = normalizeUsageQuery({ ...daily, period: { relative: '7days' }, includeQuotaExactHistory: true });
    type Batch = Awaited<ReturnType<typeof readUiUsageQueryBatch>>;
    const sliceFor = (batch: Batch | undefined, query: typeof daily) => batch?.results.find(slice => slice.key === getUsageQueryKey(query));
    const quotaFor = (batch: Batch | undefined, query: typeof daily) => sliceFor(batch, query)?.quota?.[0];

    if (scenario === 'unobserved sibling on exact upgrade') {
      const exactResponse = createDeferred<Response>();
      const store = getUsageQueryResourceStore(captured);
      const entryFor = (query: typeof daily) => store.getEntry({ hostRead: 'usage.query',
        input: projectNativeJsonValueForTransport({ queries: [query] }) });
      const readSlice = (entry: ReturnType<typeof entryFor>) => {
        const resource = entry.getSnapshot().value;
        return resource ? decodeUsageQueryResource(resource).results[0] : undefined;
      };
      const unreadState = (slice: Batch['results'][number] | undefined) =>
        slice?.sources.find(state => state.source === `quota:${createCanonicalJsonSigningInput(unreadSource)}`);
      const before = entryFor(daily);
      const details = entryFor(normalizeUsageQuery({ ...daily, includeQuotaExactHistory: true }));
      const releaseBefore = before.subscribe(() => {}, true);
      const readStates: (string | undefined)[] = [];
      let releaseDetails: (() => void) | undefined;
      try {
        await expect.poll(() => unreadState(readSlice(before))?.status).toBe('partial');
        expect(readSlice(before)?.quota?.find(row => row.source.ref.accountId === unreadRef.accountId)?.current?.state).toBe('error_last_known_good');
        exactProjectionResponse = exactResponse.promise;
        releaseDetails = details.subscribe(() => {
          const slice = readSlice(details);
          if (slice?.quota?.some(row => row.source.ref.accountId === ref.accountId && row.current)) {
            readStates.push(unreadState(slice)?.status);
          }
        }, true);
        await expect.poll(() => exactRanges.length).toBe(1);
        await expect.poll(() => readStates.length).toBeGreaterThan(0);
        expect.soft(readStates, 'settled unread account stays settled while exact history is requested').not.toContain('pending');
        expect.soft(readStates, 'a partial exact result retains the admitted sibling state').not.toContain(undefined);
        exactResponse.resolve(Response.json({ projection: null, complete: false }));
        await expect.poll(() => readSlice(details)?.quota?.find(row => row.source.ref.accountId === ref.accountId)
          ?.unusedCapacity?.windows.map(window => window.value.status)).toContain('available');
      } finally {
        exactResponse.resolve(Response.json({ projection: null, complete: false }));
        releaseDetails?.();
        releaseBefore();
      }
      return;
    }

    if (scenario !== 'ready') {
      const sibling = scenario === 'current-only sibling' ? normalizeUsageQuery({ ...daily, includeQuotaHistory: false }) : daily;
      const qualifiedState = (batch: Batch | undefined, query: typeof daily) => sliceFor(batch, query)
        ?.sources.find(state => state.source.startsWith('quota:'));
      const unavailable = () => Response.json({ error: 'provider_account_usage_read_failed' }, { status: 500 });
      const exactResponse = createDeferred<Response>();
      const witnessResponse = scenario === 'shared failure' ? createDeferred<Response>() : undefined;
      exactProjectionResponse = exactResponse.promise;
      pendingWitnessResponse = witnessResponse?.promise;
      let progress: Batch | undefined;
      const reading = readUiUsageQueryBatch(captured, { queries: [sibling, exact] }, undefined, undefined,
        { onProgress: reproject => { progress = reproject(); } });
      let failed: Batch;
      try {
        await expect.poll(() => exactRanges.length).toBe(1);
        expect(qualifiedState(progress, sibling)?.status).toBe('available');
        expect(quotaFor(progress, sibling)?.current).toEqual(current);
        expect(qualifiedState(progress, exact)?.status).toBe('pending');
        expect(quotaFor(progress, exact)?.current).toEqual(current);
        expect(sliceFor(progress, exact)?.pending).toBe(true);
        if (witnessResponse) {
          // A shared Pending witness fails with the same transport error while
          // the exact demand is still waiting.
          await expect.poll(() => witnessRequested).toBe(true);
          witnessResponse.resolve(unavailable());
        } else exactResponse.resolve(unavailable());
        failed = await reading;
      } finally {
        witnessResponse?.resolve(unavailable());
        exactResponse.resolve(Response.json({ projection: null, complete: false }));
        pendingWitnessResponse = exactProjectionResponse = undefined;
        await reading;
      }
      expect.soft(qualifiedState(failed, exact)).toMatchObject({ status: 'stale', errorCode: 'provider_account_usage_read_failed' });
      expect.soft(quotaFor(failed, exact)?.current).toEqual(current);
      expect.soft(sliceFor(failed, exact)?.pending).toBe(false);
      expect.soft(quotaFor(failed, sibling)?.current).toEqual(current);
      expect.soft(sliceFor(failed, sibling)?.pending).toBe(false);
      if (scenario === 'shared failure') {
        expect(qualifiedState(failed, sibling)).toMatchObject({ status: 'stale', errorCode: 'provider_account_usage_read_failed' });
      } else {
        expect.soft(qualifiedState(failed, sibling)?.status).toBe('available');
        expect.soft(qualifiedState(failed, sibling)?.errorCode).toBeUndefined();
        if (scenario === 'current-only sibling') {
          expect.soft(quotaFor(failed, sibling)?.current).toEqual(current);
          expect(quotaFor(failed, sibling)?.pageFacts).toBeUndefined();
          return;
        }
        expect.soft(quotaFor(failed, sibling)?.pageFacts?.dayQuotaHistory).toHaveLength(days.length);
        const recovered = await readUiUsageQueryBatch(captured, { queries: [sibling, exact] }, undefined, failed);
        expect.soft(qualifiedState(recovered, exact)?.status).toBe('available');
        expect.soft(qualifiedState(recovered, exact)?.errorCode).toBeUndefined();
        expect(quotaFor(recovered, exact)?.pageFacts?.historyStatus).toBe('complete');
      }
      return;
    }

    const first = await readUiUsageQueryBatch(captured, { queries: [daily] });
    expect.soft(first.results[0]?.quota?.[0]?.pageFacts?.dayQuotaHistory).toHaveLength(days.length);
    expect.soft(first.results[0]?.quota?.[0]?.pageFacts?.earlierCurves).toEqual([
      { meterId: 'daily', value: { status: 'unavailable', reason: 'not_loaded' } },
    ]);
    expect.soft(first.results[0]?.sources).toContainEqual(expect.objectContaining({ source: 'quota', status: 'available' }));
    expect.soft(historyRanges.length).toBeGreaterThan(0);
    expect.soft(historyRanges.every(range => range.startAtMs >= Math.floor(now / day) * day),
      'daily Year/All only reads the actual current quota window').toBe(true);
    expect.soft(exactRanges).toEqual([]);
    historyRanges.length = 0;
    const mixed = await readUiUsageQueryBatch(captured, { queries: [daily, exact] });
    expect.soft(quotaFor(mixed, daily)?.pageFacts?.dayQuotaHistory).toHaveLength(days.length);
    expect.soft(quotaFor(mixed, daily)?.unusedCapacity).toEqual({ historyStatus: 'not_loaded', windows: [] });
    expect.soft(quotaFor(mixed, exact)?.pageFacts?.dayQuotaHistory).toHaveLength(2);
    expect.soft(quotaFor(mixed, exact)?.unusedCapacity?.windows.map(window => window.value.status)).toEqual(['available']);
    expect.soft(historyRanges.length + exactRanges.length).toBeGreaterThan(0);
    expect([...historyRanges, ...exactRanges].every(range => range.startAtMs >= now - 7 * day),
      'a seven-day earlier-curve consumer must not widen the daily Year/All into exact history').toBe(true);

    if (relative === 'year') {
      const thirtyDays = normalizeUsageQuery({ ...exact, period: { relative: '30days' } });
      const sourceReads = () => home!.requests.filter(request => request.path.endsWith('/sources/resolve')).length;
      const before = sourceReads();
      exactRanges.length = 0;
      const mixedExact = await readUiUsageQueryBatch(captured, { queries: [exact, thirtyDays] });
      expect.soft(quotaFor(mixedExact, exact)?.unusedCapacity?.windows.map(window => window.value.status)).toEqual(['available']);
      expect.soft(quotaFor(mixedExact, thirtyDays)?.unusedCapacity?.windows.map(window => window.value.status)).toEqual(['available', 'available']);
      expect.soft(sourceReads() - before).toBe(1);
      expect(exactRanges).toHaveLength(1);
    }
  });

  it.each(['held', 'failed', 'complete', 'unobserved', 'no_sample', 'daily_partial', 'daily_stale'] as const)(
    'reports the same mounted Resets quota state in its single-query Action for %s coverage', async stage => {
      const now = Date.UTC(2026, 9, 12, 12);
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'resets' };
      const source = { bindingKind: 'account' as const, ref };
      const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
      const noSample = stage === 'no_sample';
      const missingSummary = stage === 'daily_partial' || stage === 'daily_stale';
      const dayStartAtMs = Date.UTC(2026, 9, 11);
      const observedAt = stage === 'unobserved' || noSample ? 0 : stage === 'daily_stale' ? now - 60_001 : now;
      const record = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey, providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId },
        observedAtMs: observedAt, fetchedAtMs: observedAt, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed',
        state: noSample ? 'not_loaded' : stage === 'unobserved' ? 'error_last_known_good' : 'loaded_empty', meters: [] });
      const history = createDeferred<void>();
      const captured = await context(async request => {
        if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (request.path === '/v2/usage/query') return Response.json(value);
        if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({
          source, recordId: record.recordId, providerAccountId: ref.accountId, fetchedAt: observedAt, staleAfterMs: 60_000 });
        if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({
          content: { t: 'plain', v: record }, metadata: { fetchedAt: observedAt, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
        if (missingSummary && request.path === '/v4/connect/qualified/provider-account-usage/day-summaries') {
          return Response.json({ summaries: [], missingDays: [{ dayStartAtMs,
            coverage: { observationCount: 1, frontier: { id: 'prior-day', observedAtMs: dayStartAtMs + 60_000 } } }] });
        }
        if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
          const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
            request.url.searchParams.get('query'));
          if (stage === 'failed' && ('history' in query || 'projection' in query)) {
            return Response.json({ error: 'provider_account_usage_read_failed' }, { status: 500 });
          }
          if ('projection' in query) return Response.json({ projection: null, complete: false });
          if ('history' in query && stage === 'held') await history.promise;
          return Response.json({ entries: [], nextCursor: null });
        }
        if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
        return undefined;
      }, { connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
      await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
      const query = normalizeUsageQuery({
        period: missingSummary ? { relative: 'all' } : { startMs: now - 86_400_000, endMs: now },
        session: 'saved-resets', includeAccounting: false, includeQuota: true, includeQuotaHistory: !noSample,
        includeQuotaExactHistory: !noSample && !missingSummary, includeSessionEvidence: false, includeWorkEvidence: false,
        includeTranscriptEvidence: false, includeActivity: false, includeComparison: false,
      });
      const sibling = normalizeUsageQuery({ ...query, includeAccounting: true, includeQuota: false, includeQuotaHistory: false, includeQuotaExactHistory: false });
      const store = getUsageQueryResourceStore(captured);
      const entry = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query, sibling] }) });
      const readPage = () => {
        const content = entry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results.find(slice => slice.key === getUsageQueryKey(query));
      };
      const readQuota = (slice: ReturnType<typeof readPage>) => slice?.sources.find(source => source.source === 'quota')?.status;
      const account = await captureLazyActionAccountContext(captured.accountLifetime.scope.serverId);
      const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
      const release = entry.subscribe(() => {}, false);
      try {
        await expect.poll(() => readPage()?.quota?.[0]?.current).toEqual(record);
        if (stage !== 'held') await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        const expectedStatus = stage === 'failed' || stage === 'daily_stale' ? 'stale'
          : stage === 'complete' || noSample ? 'available' : 'partial';
        if (missingSummary) expect(readPage()?.quota?.[0]?.pageFacts).toMatchObject({
          historyStatus: 'partial', historyCoverageCause: 'provider_account_usage_day_summary_pending',
        });
        expect(readQuota(readPage())).toBe(expectedStatus);
        const response = await executor.execute('usage.query', { queries: [query] },
          { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        if (!response.ok) throw new Error(response.errorCode);
        const action = UsageQueryBatchResultSchema.parse(response.result).results[0];
        expect(action?.key).toBe(readPage()?.key);
        expect(action?.quota?.[0]?.current).toEqual(record);
        const coverage = (slice: ReturnType<typeof readPage>) => ({
          aggregate: readQuota(slice),
          qualified: slice?.sources.filter(source => source.source.startsWith('quota:')).map(({ status }) => status),
          pending: slice?.pending,
        });
        expect(coverage(action), 'page and Action project the same admitted quota coverage').toEqual(coverage(readPage()));
        if (missingSummary) expect(coverage(action)).toMatchObject({
          aggregate: expectedStatus, qualified: [expectedStatus], pending: false,
        });
      } finally { history.resolve(); release(); account.dispose(); }
    });

  it('keeps warm exact Resets partial when one history fails before its sibling settles', async () => {
    const now = Date.UTC(2026, 9, 12, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const day = 86_400_000;
    const refs = ['resets-a', 'resets-b'].map(accountId => ({
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId,
    }));
    const sources = refs.map(ref => ({ bindingKind: 'account' as const, ref }));
    const sample = (index: number, observedAtMs: number) => {
      const ref = refs[index]!;
      const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
      return ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'codex',
        accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs, fetchedAtMs: observedAtMs,
        staleAfterMs: day, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [],
      });
    };
    const initial = [sample(0, now - 6000), sample(1, now - 4000)];
    const heads = [...initial];
    const hold = createDeferred<void>();
    const failure = 'provider_account_usage_read_failed';
    const replacementHistory = new Set<string>();
    let replacing = false;
    const observations = (index: number) => {
      const observed = initial[index]!.observedAtMs;
      return (replacing ? [observed - 100, heads[index]!.observedAtMs] : [observed]).map(observedAtMs =>
        ({ id: `observation-${observedAtMs}`, observedAtMs }));
    };
    const captured = await context(async request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path.endsWith('/sources/resolve')) {
        const { ref } = JSON.parse(request.url.searchParams.get('source')!);
        const index = refs.findIndex(candidate => candidate.accountId === ref.accountId);
        return Response.json({ source: sources[index], recordId: heads[index]!.recordId,
          providerAccountId: ref.accountId, fetchedAt: heads[index]!.fetchedAtMs, staleAfterMs: day });
      }
      if (request.path.endsWith('/record')) {
        const index = heads.findIndex(head => head.recordId === request.url.searchParams.get('recordId'));
        const record = heads[index]!;
        return Response.json({ content: { t: 'plain', v: record },
          metadata: { fetchedAt: record.fetchedAtMs, staleAfterMs: day, status: 'ok' }, sources: [sources[index]] });
      }
      if (request.path.endsWith('/day-summaries')) {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(ProviderAccountUsageDaySummaryReadV1Schema,
          request.url.searchParams.get('query'));
        const index = heads.findIndex(head => head.recordId === query.recordId);
        const history = observations(index);
        return Response.json({ summaries: [], missingDays: [{ dayStartAtMs: now - day / 2,
          coverage: { observationCount: history.length, frontier: history.at(-1) } }] });
      }
      if (request.path.endsWith('/history')) {
        if (request.method === 'PUT') return Response.json({ ok: true });
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        if (replacing) {
          replacementHistory.add(query.recordId);
          if (query.recordId === heads[0]!.recordId) return Response.json({ error: failure }, { status: 503 });
          await hold.promise;
        }
        if ('projection' in query) return Response.json({ projection: null, complete: false });
        const index = heads.findIndex(head => head.recordId === query.recordId);
        return Response.json({ entries: observations(index).map(observation => ({
          ...observation, record: { content: { t: 'plain', v: sample(index, observation.observedAtMs) },
            metadata: { fetchedAt: observation.observedAtMs, staleAfterMs: day, status: 'ok' }, sources: [sources[index]] },
        })), nextCursor: null });
      }
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    }, { connectedAccountsV4: refs.map(ref => ({ ref, status: 'connected', authenticationModeId: 'manual',
      revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
      configurationReady: false, configurationRevision: null, scopes: [] })) });
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const query = normalizeUsageQuery({ period: { startMs: now - day, endMs: now }, session: 'saved-resets',
      includeAccounting: false, includeQuota: true, includeQuotaHistory: true, includeQuotaExactHistory: true,
      includeSessionEvidence: false, includeWorkEvidence: false, includeTranscriptEvidence: false,
      includeActivity: false, includeComparison: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const readPage = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    const qualified = (index: number) => `quota:${createCanonicalJsonSigningInput(sources[index]!)}`;
    const state = (source: string) => readPage().sources.find(candidate => candidate.source === source);
    const stop = entry.subscribe(() => {}, true);
    try {
      await expect.poll(() => entry.getSnapshot().value && state('quota')?.status).toBe('available');
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(readPage().quota?.map(row => row.current)).toEqual(initial);
      replacing = true;
      heads[1] = sample(1, now - 1000);
      const beforeWake = home!.requests.length;
      publishHomeAccountChangeWake(captured.accountLifetime.scope.serverId, { t: 'account-change', changeKinds: ['account'],
        entityIds: [buildConnectedServicesAccountChangeV1(refs[0]!.service).entityId], sessionSystemRecords: [] }, 'socket');
      try {
        await expect.poll(() => ({
          histories: replacementHistory.size,
          requests: home!.requests.slice(beforeWake).map(request => request.path.split('/').at(-1)),
        })).toMatchObject({ histories: 2 });
        await expect.poll(() => state(qualified(0))?.errorCode).toBe(failure);
        expect(state('quota')).toMatchObject({ status: 'partial', asOfMs: initial[0]!.fetchedAtMs });
        expect(state(qualified(0))).toMatchObject({ status: 'stale', errorCode: failure, asOfMs: initial[0]!.fetchedAtMs });
        expect(state(qualified(1))).toMatchObject({ status: 'available', asOfMs: initial[1]!.fetchedAtMs });
        expect(state(qualified(1))?.errorCode).toBeUndefined();
        expect(readPage().quota?.map(row => row.current)).toEqual(initial);
      } finally { hold.resolve(); }
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(state('quota')).toMatchObject({ status: 'stale', asOfMs: initial[0]!.fetchedAtMs });
      expect(state(qualified(0))).toMatchObject({ status: 'stale', errorCode: failure, asOfMs: initial[0]!.fetchedAtMs });
      expect(state(qualified(1))).toMatchObject({ status: 'available', asOfMs: heads[1]!.fetchedAtMs });
      expect(state(qualified(1))?.errorCode).toBeUndefined();
      expect(readPage().quota?.map(row => row.current)).toEqual(heads);
    } finally { stop(); }
  });


  it('opens first-use B without cache hydration and admits its lossless projection only after the backfill completes', async () => {
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'first-use' };
    const source = { bindingKind: 'account' as const, ref };
    const now = Date.parse('2026-10-11T21:30:05.321Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const historyRanges: { startAtMs: number; endAtMs: number }[] = [];
    const recordKey = { providerId: 'codex', accountSubjectId: 'first-use', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'first-use' }, observedAtMs: now,
      fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
    const later = createDeferred<Response>();
    const pending = createDeferred<Response>();
    let sourceRefusal = 0;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return sourceRefusal
        ? new Response('missing', { status: sourceRefusal }) : Response.json({ source, recordId: snapshot.recordId,
          providerAccountId: 'first-use', fetchedAt: now, staleAfterMs: 60_000 });
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: snapshot },
        metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        if ('history' in query && query.history.range) historyRanges.push(query.history.range);
        if ('history' in query && query.history.cursor) return later.promise.then(response => response.clone());
        return Response.json({ entries: [{ id: 'first-use-page', observedAtMs: now - 1, record: {
          content: { t: 'plain', v: { ...snapshot, observedAtMs: now - 1, fetchedAtMs: now - 1 } },
          metadata: { fetchedAt: now - 1, staleAfterMs: 60_000, status: 'ok' }, sources: [source] } }],
          nextCursor: { id: 'first-use-page', observedAtMs: now - 1 } });
      }
      if (request.path === '/v2/pending/reset-starts/read') return pending.promise.then(response => response.clone());
      return undefined;
    }, {
      connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    await getServerFeaturesSnapshot({ serverId: captured.accountLifetime.scope.serverId, force: true });
    const providerScope = buildProviderAccountUsageScopeKey({ serverId: captured.accountLifetime.scope.serverId,
      generation: getActiveServerSnapshot().generation, credentialScope: resolveAuthCredentialsScopeKey(captured.credentials) });
    expect(getProviderAccountUsageCacheState().entriesByCredentialScope[providerScope]?.[snapshot.recordId]?.snapshot).toBeUndefined();
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ period: { relative: '7days' } }] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => {
        const content = entry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.quota?.[0]?.current;
      }).toEqual(snapshot);
      await expect.poll(() => historyRanges.length).toBeGreaterThan(1);
      expect(historyRanges[0]).toEqual({ startAtMs: Date.parse('2026-10-05T00:00:00Z'), endAtMs: now });
      expect(entry.getSnapshot().pending).toBe('initial');
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]).toMatchObject({ accounting: value, pending: true,
        quota: [{ source, current: snapshot, unusedCapacity: { historyStatus: 'not_loaded' } }] });
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]?.pageProjection).toBeUndefined();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual(expect.objectContaining({ source: expect.stringMatching(/^quota:/), status: 'pending' }));
      later.resolve(Response.json({ entries: [], nextCursor: null }));
      // Capacity history has answered even while the independent Pending-work
      // facet is still outstanding. It cannot keep every account "Still reading".
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources
        .find(source => source.source.startsWith('quota:'))?.status).toBe('available');
      const projected = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0];
      expect(projected?.current).toEqual(snapshot);
      expect(projected?.history).toBeUndefined();
      expect(projected?.pageProjection).toBeUndefined();
      expect(projected?.pageFacts).toMatchObject({ historyStatus: 'complete',
        resetWitness: { id: 'first-use-page', observedAtMs: now - 1,
          snapshot: { ...snapshot, observedAtMs: now - 1, fetchedAtMs: now - 1 } } });
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual(expect.objectContaining({ source: 'quota', status: 'available' }));
      pending.resolve(Response.json({ entries: [] }));
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const settled = decodeUsageQueryResource(entry.getSnapshot().value!).results[0];
      expect(settled).toMatchObject({ pending: false, quota: [{ current: snapshot }] });
      expect(settled?.sources)
        .toContainEqual(expect.objectContaining({ source: expect.stringMatching(/^quota:/), status: 'available' }));
      sourceRefusal = 500;
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]?.current).toEqual(snapshot);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual(expect.objectContaining({ source: 'quota', status: 'stale' }));
      sourceRefusal = 404;
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]?.current).toBeNull();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual(expect.objectContaining({ source: expect.stringMatching(/^quota:/), status: 'partial' }));
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual(expect.objectContaining({ source: 'quota', status: 'partial' }));
      await entry.refresh();
      expect(entry.getSnapshot().error).toBeUndefined();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]?.current).toBeNull();
    } finally { pending.resolve(Response.json({ entries: [] })); later.resolve(Response.json({ entries: [], nextCursor: null })); release(); }
  });

  it('publishes A and admitted B independently of cache hydration and advances history without vendor refresh', async () => {
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
    const source = { bindingKind: 'account' as const, ref };
    let quotaEnabled = true;
    let quotaRefusal = 0;
    let historyUnavailable = false;
    let laterHistoryUnavailable = false;
    let laterHistoryDenied = false;
    let holdLaterHistory = false;
    let heldSource: ReturnType<typeof createDeferred<void>> | null = null;
    let admittedRecordId: string | null = null;
    let accountingResponse = value;
    const laterHistory = createDeferred<Response>();
    let heldHistoryResponse: Response | undefined;
    const recordKey = { providerId: 'codex', accountSubjectId: 'provider-work', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const snapshot = { v: 1 as const, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject' as const, id: 'provider-work' },
      observedAtMs: now, fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp' as const,
      confidence: 'confirmed' as const, state: 'loaded_data' as const, meters: [{ meterId: 'current', label: 'Current',
        used: 40, limit: 100, remaining: 60, utilizationPct: 40, unit: 'requests', status: 'ok' as const,
        resetsAt: now + 1000, windowDurationMs: 1000, details: {} }] };
    const quota = { v: 1, ref, activeAccountId: 'provider-work', fetchedAt: now, staleAfterMs: 60_000,
      planLabel: null, accountLabel: null, meters: [] };
    ProviderAccountUsageSnapshotV1Schema.parse(snapshot);
    const quotaResponse = QualifiedConnectedAccountQuotaResponseV4Schema.parse({ ref,
      sourceResolution: { source, recordId: snapshot.recordId, providerAccountId: 'provider-work', fetchedAt: now, staleAfterMs: 60_000 },
      content: { t: 'plain', v: quota }, metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' } });
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') return Response.json(accountingResponse);
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
        connectedServices: { enabled: true, quotas: { enabled: quotaEnabled } },
      } }));
      if (request.path === '/v4/connect/qualified/quotas') return quotaRefusal
        ? new Response('read refused', { status: quotaRefusal }) : Response.json({ ...quotaResponse,
          sourceResolution: { ...quotaResponse.sourceResolution, recordId: admittedRecordId ?? snapshot.recordId } });
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({
        content: { t: 'plain', v: admittedRecordId ? { ...snapshot, recordId: admittedRecordId,
          recordKey: { ...recordKey, accountSubjectId: 'replacement-work' } } : snapshot },
        metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        if (heldSource) await heldSource.promise;
        return quotaRefusal === 403 ? new Response('source refused', { status: 403 }) : Response.json({ source, recordId: admittedRecordId ?? snapshot.recordId,
          providerAccountId: 'provider-work', fetchedAt: now, staleAfterMs: 60_000 });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') {
        const query = parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema,
          request.url.searchParams.get('query'));
        // Rebuild an explicitly absent projection to exercise held backfill,
        // failure and refusal. Persisted reuse has the producer/HTTP suite.
        if ('projection' in query) return historyUnavailable ? new Response('history unavailable', { status: 404 })
          : Response.json({ projection: null, complete: false });
        const later = 'history' in query && query.history.cursor !== undefined;
        if (historyUnavailable || later && laterHistoryUnavailable) return new Response('history unavailable', { status: 404 });
        if (later && laterHistoryDenied) return new Response('history refused', { status: 403 });
        const id = later ? 'second' : 'first';
        const observedAtMs = now - (later ? 200 : 700);
        const used = later ? 70 : 20;
        const historical = { ...snapshot, ...(admittedRecordId ? { recordId: admittedRecordId,
          recordKey: { ...recordKey, accountSubjectId: 'replacement-work' } } : {}), observedAtMs, fetchedAtMs: observedAtMs, state: 'loaded_data',
          meters: [{ meterId: 'ended', label: 'Ended', used, remaining: 100 - used, limit: 100, unit: 'requests',
            utilizationPct: used, resetsAt: now - 200, windowDurationMs: 1000, status: 'ok', details: {} }] };
        const response = Response.json({ entries: [{ id, observedAtMs, record: {
          content: { t: 'plain', v: historical },
          metadata: { fetchedAt: observedAtMs, staleAfterMs: 60_000, status: 'ok' }, sources: [source] } }],
          nextCursor: later ? null : { id, observedAtMs } });
        if (later && holdLaterHistory) { heldHistoryResponse = response; return laterHistory.promise.then(page => page.clone()); }
        return response;
      }
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    }, {
      connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }] });
    const serverBasis = getActiveServerSnapshot();
    expect((await getServerFeaturesSnapshot({ serverId: serverBasis.serverId, force: true })).status).toBe('ready');
    // A Usage Action can settle before any legacy quota-cache consumer mounts.
    // Its next read starts with identity/pending progress, not cache hydration.
    const unhydratedQuery = normalizeUsageQuery({});
    const unhydratedSettled = await readUiUsageQueryBatch(captured, { queries: [unhydratedQuery] });
    const unhydratedSlice = unhydratedSettled.results[0]!;
    const unhydratedPlans = projectUsagePlans(unhydratedSlice.quota ?? [], now, unhydratedSlice.pools, unhydratedSlice.sources);
    expect(unhydratedPlans.tightest?.window.remainingFraction).toBe(0.6);
    expect(unhydratedSlice.quota?.[0]?.pageFacts).toMatchObject({ historyStatus: 'complete', resetWitness: { id: 'second' } });
    const unhydratedRevisions: typeof unhydratedSettled[] = [];
    await readUiUsageQueryBatch(captured, { queries: [unhydratedQuery] }, undefined, unhydratedSettled,
      { onProgress: project => { unhydratedRevisions.push(project()); } });
    expect(unhydratedRevisions.length).toBeGreaterThan(0);
    for (const revision of unhydratedRevisions) {
      const slice = revision.results[0]!;
      const plans = projectUsagePlans(slice.quota ?? [], now, slice.pools, slice.sources);
      expect.soft(plans.tightest).toEqual(unhydratedPlans.tightest);
      expect.soft(plans.accounts[0]?.observedAtMs).toBe(now);
      expect.soft(usageCoverageSummary(slice, ['quota'])).toBe(usageCoverageSummary(unhydratedSlice, ['quota']));
      expect.soft(slice.quota?.[0]?.pageFacts).toEqual(unhydratedSlice.quota?.[0]?.pageFacts);
    }
    const credentialScope = [captured.accountLifetime.scope.serverId, String(serverBasis.generation), resolveAuthCredentialsScopeKey(captured.credentials)].join('\u0000');
    const readContext = { credentials: captured.credentials, credentialScope, ref,
      serverBasis: { serverId: captured.accountLifetime.scope.serverId, generation: serverBasis.generation },
      assertOperationAllowed: async () => { throw new Error('Passive hydration must not refresh a provider'); } };
    const qualifiedKey = buildQualifiedQuotaSnapshotScopeKey(readContext);
    const qualifiedReady = createDeferred<void>();
    const unwatchQualified = subscribeQualifiedQuotaSnapshotEntry(qualifiedKey, () => {
      if (getQualifiedQuotaSnapshotEntry(qualifiedKey).read) qualifiedReady.resolve();
    });
    loadQualifiedQuotaSnapshotOnce(qualifiedKey, readContext);
    await qualifiedReady.promise;
    expect(getQualifiedQuotaSnapshotEntry(qualifiedKey)).toMatchObject({ supported: true, usageRecordId: snapshot.recordId });
    const providerScope = buildProviderAccountUsageScopeKey({ serverId: captured.accountLifetime.scope.serverId,
      generation: serverBasis.generation, credentialScope: resolveAuthCredentialsScopeKey(captured.credentials) });
    updateProviderAccountUsageCacheEntries(providerScope, () => ({ [snapshot.recordId]: {
      snapshot: null, loading: true, hadError: false, nextFetchAtMs: now } }));
    const query = normalizeUsageQuery({});
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const advanced = createDeferred<void>();
    const release = entry.subscribe(() => {
      const content = entry.getSnapshot().value;
      if (content && decodeUsageQueryResource(content).results[0]?.quota?.[0]?.current?.recordId === snapshot.recordId) advanced.resolve();
    }, true);
    try {
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]).toMatchObject({ accounting: value,
        quota: [{ current: snapshot }], sources: expect.arrayContaining([{ source: 'quota', status: 'available', asOfMs: now }]) });
      const opened = await getProviderAccountUsageSnapshotPlain(captured.credentials, { recordId: snapshot.recordId },
        { expectedActiveServer: readContext.serverBasis });
      updateProviderAccountUsageCacheEntries(providerScope, entries => ({ ...entries, [snapshot.recordId]: {
        snapshot: opened, loading: false, hadError: false, nextFetchAtMs: now + 60_000 } }));
      await advanced.promise;
      // Cache hydration can start another progressive read. Observe identity and
      // waiting work together in one revision, after its Pending read answers.
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]).toMatchObject({ source,
        current: snapshot, waitingWork: { status: 'available', entries: [] } });
      const fullRead = (await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.quota?.[0];
      expect(fullRead?.history).toBeUndefined();
      expect(fullRead?.pageProjection).toBeUndefined();
      expect(fullRead?.pageFacts).toMatchObject({ historyStatus: 'complete', resetWitness: { id: 'second' } });
      expect(fullRead?.unusedCapacity).toMatchObject({ historyStatus: 'returned_page', windows: [{ value: {
        status: 'available', method: 'terminal_observation', qualification: 'confirmed', sampleCount: 2 } }] });
      expect(fullRead?.unusedCapacity?.windows[0]?.value).toHaveProperty('unusedAmount', expect.closeTo(30));
      const settledSlice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      const settledPlans = projectUsagePlans(settledSlice.quota ?? [], now, settledSlice.pools, settledSlice.sources);
      expect(settledPlans.tightest?.window.remainingFraction).toBe(0.6);
      // The Usage page's vendor reread marks the admitted cache row loading
      // before the history reader answers. Every published revision, including
      // the initial cache observation, must retain the settled allowance.
      updateProviderAccountUsageCacheEntries(providerScope, entries => ({ ...entries, [snapshot.recordId]: {
        ...entries[snapshot.recordId]!, loading: true } }));
      const revisions: Awaited<ReturnType<typeof readUiUsageQueryBatch>>[] = [];
      const settledBatch = decodeUsageQueryResource(entry.getSnapshot().value!);
      await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, settledBatch,
        { onProgress: project => { revisions.push(project()); } });
      expect(revisions.length).toBeGreaterThan(0);
      for (const revision of revisions) {
        const slice = revision.results[0]!;
        expect.soft(projectUsagePlans(slice.quota ?? [], now, slice.pools, slice.sources).tightest).toEqual(settledPlans.tightest);
        expect.soft(slice.quota?.[0]?.pageFacts).toEqual(settledSlice.quota?.[0]?.pageFacts);
      }
      // Usage can acquire a new batch entry while Home's single-query entry is
      // warm. The admitted cache reading is still settled for that new entry.
      const newlyBatchedRevisions: typeof revisions = [];
      await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, undefined,
        { onProgress: project => { newlyBatchedRevisions.push(project()); } });
      for (const revision of newlyBatchedRevisions) {
        const slice = revision.results[0]!;
        expect.soft(projectUsagePlans(slice.quota ?? [], now, slice.pools, slice.sources).tightest?.window.remainingFraction).toBe(0.6);
      }
      updateProviderAccountUsageCacheEntries(providerScope, entries => ({ ...entries, [snapshot.recordId]: {
        ...entries[snapshot.recordId]!, loading: false } }));
      holdLaterHistory = true;
      accountingResponse = { ...value, totals: { ...value.totals, eventCount: 2 } };
      const refreshingHistory = entry.refresh();
      await expect.poll(() => {
        const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0];
        return slice?.accounting?.totals.eventCount === 2 && heldHistoryResponse !== undefined;
      }).toBe(true);
      expect(entry.getSnapshot().pending).toBe('refresh');
      const refreshingSlice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      expect.soft(refreshingSlice.sources.filter(state => state.source.startsWith('quota')))
        .toEqual(settledSlice.sources.filter(state => state.source.startsWith('quota')));
      expect.soft(projectUsagePlans(refreshingSlice.quota ?? [], now, refreshingSlice.pools, refreshingSlice.sources).tightest)
        .toEqual(settledPlans.tightest);
      expect.soft(usageCoverageSummary(refreshingSlice, ['quota'])).toBe(usageCoverageSummary(settledSlice, ['quota']));
      expect(refreshingSlice.quota?.[0]).toEqual(settledSlice.quota?.[0]);
      holdLaterHistory = false;
      laterHistory.resolve(heldHistoryResponse!);
      await refreshingHistory;
      const refreshedQuota = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0];
      expect(refreshedQuota?.pageFacts).toMatchObject({ historyStatus: 'complete', resetWitness: { id: 'second' } });
      laterHistoryUnavailable = true;
      const partialRead = (await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.quota?.[0];
      expect(partialRead).toMatchObject({
        current: snapshot, unusedCapacity: { historyStatus: 'unavailable', windows: [] } });
      // AR-5 never admits an incomplete prefix as the complete page document.
      expect(partialRead?.pageProjection).toBeUndefined();
      expect(partialRead?.history).toBeUndefined();
      const beforeIncomplete = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      await entry.refresh();
      const afterIncomplete = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      expect.soft(afterIncomplete.quota?.[0]?.pageFacts, 'an incomplete reread must retain the last complete pace/history')
        .toEqual(beforeIncomplete.quota?.[0]?.pageFacts);
      expect.soft(afterIncomplete.sources).toContainEqual(expect.objectContaining({ source: 'quota', status: 'stale' }));
      laterHistoryUnavailable = false;
      laterHistoryDenied = true;
      expect((await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.quota?.[0]).toBeUndefined();
      laterHistoryDenied = false;
      historyUnavailable = true;
      expect((await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.quota?.[0]).toMatchObject({
        current: snapshot, unusedCapacity: { historyStatus: 'unavailable', windows: [] } });
      historyUnavailable = false;
      await flushHookEffects({ cycles: 30 });
      const connectedProfile = storage.getState().profile;
      storage.setState({ profile: { ...connectedProfile, connectedAccountsV4: [] } });
      await flushHookEffects({ cycles: 30 });
      expect.soft(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota).toBeUndefined();
      storage.setState({ profile: connectedProfile });
      quotaRefusal = 400;
      await reloadQualifiedQuotaSnapshotAfterRecovery({ ref, serverBasis: readContext.serverBasis });
      const offline = (await readUiUsageQueryBatch(captured, { queries: [query] })).results[0];
      expect(offline?.quota?.[0]?.current).toEqual(snapshot);
      // A refused legacy cache read cannot override an admitted fresh record Action.
      expect.soft(offline?.sources).toContainEqual({ source: 'quota', status: 'available', asOfMs: now });
      quotaEnabled = false;
      await getServerFeaturesSnapshot({ serverId: serverBasis.serverId, force: true });
      const ownSettingsScope = storage.getState().settingsScope;
      storage.setState({ settingsScope: { serverId: 'foreign-home', accountId: 'foreign-account' } });
      expect.soft((await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.quota).toBeUndefined();
      storage.setState({ settingsScope: ownSettingsScope });
      quotaEnabled = true;
      await getServerFeaturesSnapshot({ serverId: serverBasis.serverId, force: true });
      quotaRefusal = 403;
      await reloadQualifiedQuotaSnapshotAfterRecovery({ ref, serverBasis: readContext.serverBasis });
      expect.soft(getQualifiedQuotaSnapshotEntry(qualifiedKey)).toMatchObject({ supported: false, snapshot: null, usageRecordId: null });
      expect.soft((await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.quota).toBeUndefined();
      // R4A-01: a held replacement cannot reseed protected previous facts
      // after either explicit refusal or an admitted different record.
      for (const transition of ['refusal', 'replacement'] as const) {
        quotaRefusal = transition === 'refusal' ? 403 : 0;
        admittedRecordId = transition === 'replacement'
          ? buildProviderAccountUsageRecordId({ ...recordKey, accountSubjectId: 'replacement-work' }) : null;
        await reloadQualifiedQuotaSnapshotAfterRecovery({ ref, serverBasis: readContext.serverBasis });
        expect(getQualifiedQuotaSnapshotEntry(qualifiedKey)).toMatchObject(transition === 'refusal'
          ? { supported: false } : { usageRecordId: admittedRecordId });
        heldSource = createDeferred<void>();
        const protectedRevisions: typeof revisions = [];
        const reads = [query, normalizeUsageQuery({ ...query, granularity: 'hour' })].map(nextQuery =>
          readUiUsageQueryBatch(captured, { queries: [nextQuery] }, undefined, settledBatch,
            { onProgress: project => { protectedRevisions.push(project()); } }));
        try {
          await expect.poll(() => protectedRevisions.length).toBeGreaterThanOrEqual(2);
          await flushHookEffects({ cycles: 20 });
          for (const revision of protectedRevisions) {
            expect.soft(revision.results.flatMap(slice => slice.quota ?? [])
              .some(read => read.current?.recordId === snapshot.recordId), `${transition} never republishes old protected facts`).toBe(false);
          }
        } finally {
          heldSource.resolve();
          const completed = await Promise.all(reads);
          heldSource = null;
          for (const revision of [...protectedRevisions, ...completed]) {
            expect.soft(revision.results.flatMap(slice => slice.quota ?? [])
              .some(read => read.current?.recordId === snapshot.recordId), `${transition} cannot restore protected facts at settle`).toBe(false);
          }
        }
      }
      expect(home!.requests.some(request => request.path.endsWith('/refresh'))).toBe(false);
    } finally { heldSource?.resolve(); laterHistory.resolve(heldHistoryResponse ?? Response.json({ error: 'not_found' }, { status: 404 })); release(); unwatchQualified(); }
  });

  it('opens the quota host read through the captured plain Account and retires late provider facts', async () => {
    const source = { bindingKind: 'account' as const, ref: {
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' } };
    const delayed = createDeferred<Response>();
    const issued = createDeferred<void>();
    let held = false;
    let denied = false;
    const captured = await context(request => {
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') {
        if (denied) return new Response('forbidden', { status: 403 });
        if (held) { issued.resolve(); return delayed.promise; }
        return Response.json({ error: 'not_found' }, { status: 404 });
      }
      if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
      return undefined;
    });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'connectedServices.quota.get', input: { source } });
    const release = entry.subscribe(() => {}, false);
    try {
      const admitted = await entry.refresh();
      expect(admitted.value).toBeDefined();
      expect(JSON.parse(new TextDecoder().decode(admitted.value!.bytes))).toMatchObject({ source, current: null,
        pace: [], targets: [], waitingWork: { status: 'available', entries: [] } });
      expect(home!.requests.filter(request => request.path.includes('/provider-account-usage/'))
        .every(request => request.method === 'GET')).toBe(true);
      expect(getUsageQueryResourceStore(captured).getEntry({ hostRead: 'connectedServices.quota.get', input: {
        source: { ref: { accountId: 'work', service: { localId: 'openai-codex', pluginId: 'happier.agent.codex' } }, bindingKind: 'account' },
      } }).getSnapshot()).toBe(entry.getSnapshot());
      denied = true;
      expect((await entry.refresh()).value).toBeUndefined();
      denied = false;
      expect((await entry.refresh()).value).toBeDefined();
      held = true;
      const refreshing = entry.refresh();
      await issued.promise;
      retireActiveServerAccountScopeLifetime();
      delayed.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
      await refreshing;
      expect(entry.getSnapshot().value).toBeUndefined();
    } finally { release(); }
  });

  it('advances a non-live Resource from useful A through slow private detail without establishing a watch', async () => {
    const session = createDeferred<Response>();
    const work = createDeferred<unknown>();
    const accounting = { ...value, contributions: [{ ...workContribution, sessionId: 'staged-session' }] };
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(accounting);
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v2/sessions/staged-session') return session.promise.then(response => response.clone());
      if (request.path === '/v1/sessions/staged-session/turns') return Response.json({ v: 1, sessionId: 'staged-session', updatedAt: 900, turns: [] });
      if (request.path === '/v1/sessions/staged-session/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.getState().applySessions([createSessionFixture({ id: 'staged-session', active: true,
      serverId: captured.accountLifetime.scope.serverId, metadata: { machineId: 'work-machine', path: '/repo', host: 'test', homeDir: '/home/test' } })]);
    await publishMachineInventoryForTest(captured.accountLifetime.scope, [createHydratedPlainMachineFixture({ id: 'work-machine', accountId: 'account-a', machine: { activeAt: Date.now() } })]);
    scmTransport.mockImplementation(() => work.promise);
    const query = normalizeUsageQuery({ session: 'staged-session', period: { startMs: 0, endMs: 1000 } });
    const entry = getUsageQueryResourceStore(captured)
      .getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const detailCompleted = createDeferred<void>();
    const release = entry.subscribe(() => {
      const content = entry.getSnapshot().value;
      if (content && decodeUsageQueryResource(content).results[0]?.sources.some(source =>
        source.source === 'how_you_work' && source.status !== 'pending')) {
        detailCompleted.resolve();
      }
    }, false);
    try {
      await flushHookEffects({ cycles: 30 });
      const initial = entry.getSnapshot().value;
      expect(initial).toBeDefined();
      expect(decodeUsageQueryResource(initial!).results[0]).toMatchObject({ accounting,
        sources: expect.arrayContaining([{ source: 'work', status: 'pending' }, { source: 'how_you_work', status: 'pending' }]),
      });
      work.resolve(ScmWorkEvidenceReadResponseSchema.parse({ sessions: [{ sessionId: 'staged-session', status: 'unsupported' }] }));
      session.resolve(Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'staged-session',
        createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
        metadataVersion: 1, metadata: { machineId: 'work-machine', path: '/repo', host: 'test', name: 'Opened' }, agentStateVersion: 1 }) }));
      await detailCompleted.promise;
      const completed = decodeUsageQueryResource(entry.getSnapshot().value!).results[0];
      expect(completed?.accounting).toMatchObject(accounting);
      expect(completed?.sources).toContainEqual({ source: 'work', status: 'unsupported', asOfMs: expect.any(Number) });
      expect(completed?.howYouWork?.detailStatus).toBe('partial');
      expect(completed?.sources.some(source => source.source === 'how_you_work' && source.status === 'pending')).toBe(false);
    } finally { release(); }
  });

  it('reads witnessed collaboration through HTTP and retains content-free facts without refetching the opened page', async () => {
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/collaboration') return Response.json({ session: {
        ...createPlainSessionCurrentProjectionRecordFixture({ id: 'collaboration', createdAt: 1, updatedAt: 900, seq: 1,
          active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1,
          metadata: { path: '/private', host: 'fixture.local', flavor: 'codex' } }),
      } });
      if (request.path === '/v1/sessions/collaboration/turns') return Response.json({ v: 1, sessionId: 'collaboration', updatedAt: 900,
        turns: [{ turnId: 'old', agentId: 'claude', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 400 },
          { turnId: 'new', agentId: 'codex', status: 'completed', startedAt: 600, terminalAt: 800, updatedAt: 800 }] });
      if (request.path === '/v1/sessions/collaboration/messages') return Response.json({ hasMore: false, messages: [
        { id: 'run', seq: 1, createdAt: 200, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: {
          type: 'codex', data: { type: 'tool-call', callId: 'run-call', name: 'SubAgentRun', input: {
            runId: 'run-review', sidechainId: 'review-side', intent: 'review', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            launchOrigin: { kind: 'session', sessionId: 'collaboration' }, instructions: 'private instructions',
          } },
        } } } },
      ] });
      return undefined;
    });
    const query = normalizeUsageQuery({ session: 'collaboration', period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false });
    const first = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(first.results[0]?.howYouWork?.collaboration).toMatchObject({ coverage: 'partial', edges: [
      { sourceAgentId: 'claude', targetAgentId: 'codex', relation: 'review', count: 1 },
    ] });
    const reads = sessionRequests().filter(request => request.path.endsWith('/messages')).length;
    const second = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(second.results[0]?.howYouWork?.collaboration).toEqual(first.results[0]?.howYouWork?.collaboration);
    expect(sessionRequests().filter(request => request.path.endsWith('/messages'))).toHaveLength(reads);
    expect(JSON.stringify(second)).not.toContain('private instructions');
    expect(JSON.stringify(second)).not.toContain('review-side');
  });

  it('keeps same-scope approval waits consistent across Coach and Human loop while empty turn history stays unknown', async () => {
    const nowMs = Date.now();
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/truth') return Response.json({ session: { ...createPlainSessionCurrentProjectionRecordFixture({ id: 'truth',
        createdAt: 1, updatedAt: nowMs, seq: 1, active: true, activeAt: nowMs, metadataVersion: 1, agentStateVersion: 1 }),
        agentState: JSON.stringify({ completedRequests: { approval: { tool: 'Bash', arguments: {},
          createdAt: nowMs - 1000, completedAt: nowMs - 500, status: 'approved' } } }) } });
      if (request.path === '/v1/sessions/truth/turns') return Response.json({ v: 1, sessionId: 'truth', updatedAt: nowMs, turns: [] });
      if (request.path === '/v1/sessions/truth/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: { truth: createSessionFixture({ id: 'truth', seq: 1,
      serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' }) } });
    const parallel = normalizeUsageQuery({ period: { relative: '7days' }, includeWorkEvidence: false, includeTranscriptEvidence: false });
    const humanLoop = normalizeUsageQuery({ ...parallel, includeTranscriptEvidence: true });
    const batch = await readUiUsageQueryBatch(captured, { queries: [parallel, humanLoop] });
    for (const slice of batch.results) {
      expect(slice.accounting?.totals.tokens.total).toBe(value.totals.tokens.total);
      expect(slice.howYouWork?.todayInParallel, 'empty retained turn history cannot establish no runs today').toBeNull();
      expect(slice.howYouWork?.permissions).toMatchObject({ pairedDecisionCount: 1, decisionLatencyMs: 500 });
      const finding = slice.coach?.findings.find(row => row.detectorId === 'approval_friction');
      expect(finding?.measurements).toEqual(expect.arrayContaining([
        expect.objectContaining({ metric: 'permission_wait', value: 500 }),
        expect.objectContaining({ metric: 'permission_requests', value: 1 }),
      ]));
    }
  });

  it.each(['refused', 'unreadable-session', 'unreadable-transcript', 'transcript-timeout'] as const)('settles partial reading with one readable and one %s Session', async outcome => {
    const transcript = createDeferred<Response>();
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/unreadable' && outcome === 'refused') return Response.json({ error: 'denied' }, { status: 403 });
      if (request.path === '/v2/sessions/unreadable' && outcome === 'unreadable-session') return Response.json({ error: 'unavailable' }, { status: 503 });
      const id = /^\/v2\/sessions\/(readable|unreadable)$/.exec(request.path)?.[1];
      if (id) return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id,
        createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1 }) });
      const turnsId = /^\/v1\/sessions\/(readable|unreadable)\/turns$/.exec(request.path)?.[1];
      if (turnsId) return Response.json({ v: 1, sessionId: turnsId, updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] });
      if (request.path === '/v1/sessions/readable/messages') return transcript.promise;
      if (request.path === '/v1/sessions/unreadable/messages' && outcome === 'transcript-timeout') {
        return Response.json({ error: 'database_transaction_timeout' }, { status: 503 });
      }
      if (request.path === '/v1/sessions/unreadable/messages') return Response.json({ messages: [{
        id: 'unopened', seq: 1, createdAt: 200, content: { t: 'encrypted', c: 'unavailable' },
      }], hasMore: false });
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: Object.fromEntries(
      ['readable', 'unreadable'].map(id => [id, createSessionFixture({ id, seq: 1,
        serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' })]),
    ) });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, false);
    const slice = () => entry.getSnapshot().value ? decodeUsageQueryResource(entry.getSnapshot().value!).results[0] : undefined;
    const reading = entry.refresh();
    try {
      await expect.poll(() => sessionRequests().some(request => request.path === '/v1/sessions/readable/messages')).toBe(true);
      expect(slice()?.pending).toBe(true);
      expect(slice()?.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'pending' }));
      transcript.resolve(Response.json({ messages: [], hasMore: false }));
      await reading;
      expect(entry.getSnapshot().pending).toBe('idle');
      expect(slice()?.pending).toBe(false);
      expect(slice()?.howYouWork?.detailStatus).toBe('partial');
      const bothSummariesAdmitted = outcome === 'unreadable-transcript' || outcome === 'transcript-timeout';
      expect(slice()?.howYouWork?.sessionCoverage).toEqual({ selected: 2, admitted: bothSummariesAdmitted ? 2 : 1,
        notRead: bothSummariesAdmitted ? 2 : 1 });
      expect(slice()?.howYouWork?.intervals?.agentTimeMs).toBe(bothSummariesAdmitted ? 600 : 300);
      expect(slice()?.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'partial' }));
      expect(slice()?.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work:transcripts', status: 'partial',
        ...(outcome === 'refused' ? { errorCode: 'forbidden' }
          : outcome === 'transcript-timeout' ? { errorCode: 'database_transaction_timeout' } : {}) }));
      expect(slice()?.sources.some(source => source.source.startsWith('how_you_work') && source.status === 'pending')).toBe(false);
    } finally { transcript.resolve(Response.json({ messages: [], hasMore: false })); await reading; release(); }
  });

  it.each(['summary', 'transcript'] as const)('settles admitted Session evidence while a streaming sibling advances during %s', async phase => {
    const changing = createDeferred<void>();
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      const id = /^\/v2\/sessions\/(healthy|changing)$/.exec(request.path)?.[1];
      if (id) {
        if (id === 'changing' && phase === 'summary') await changing.promise;
        return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id,
          createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1 }) });
      }
      const turnsId = /^\/v1\/sessions\/(healthy|changing)\/turns$/.exec(request.path)?.[1];
      if (turnsId) return Response.json({ v: 1, sessionId: turnsId, updatedAt: 900, turns: [
        { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
      ] });
      if (request.path.endsWith('/messages')) {
        if (request.path === '/v1/sessions/changing/messages' && phase === 'transcript') await changing.promise;
        return Response.json({ messages: [], hasMore: false });
      }
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: Object.fromEntries(
      ['healthy', 'changing'].map(id => [id, createSessionFixture({ id, seq: 1,
        serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' })]),
    ) });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false });
    const reading = readUiUsageQueryBatch(captured, { queries: [query] });
    try {
      await expect.poll(() => sessionRequests().some(request => request.path === (phase === 'summary'
        ? '/v2/sessions/changing' : '/v1/sessions/changing/messages'))).toBe(true);
      storage.setState({ sessions: { ...storage.getState().sessions,
        changing: { ...storage.getState().sessions.changing!, seq: 2 } } });
      changing.resolve();
      const result = (await reading).results[0]!;
      expect(result.pending).toBe(false);
      expect(result.howYouWork).toMatchObject({
        sessionCoverage: { selected: 2, admitted: 2 },
        intervals: { agentTimeMs: 600 }, runLengths: { sampleCount: 2 } });
      expect(result.sources.some(source => source.source.startsWith('how_you_work') && source.status === 'pending')).toBe(false);
      expect(result.sources.some(source => source.errorCode === 'usage_session_evidence_changed')).toBe(false);
      expect(sessionRequests().some(request => request.path === '/v1/sessions/healthy/messages')).toBe(true);
      expect(sessionRequests().some(request => request.path === '/v1/sessions/changing/messages')).toBe(true);
    } finally { changing.resolve(); await reading; }
  });

  it('settles progress and completion from an admitted Session read after its next read replaces the entry', async () => {
    const captured = await context(() => undefined);
    const session = createSessionFixture({ id: 'streaming', seq: 1,
      serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: { streaming: session } });
    const controller = new AbortController();
    const inputs = createUsageQuerySessionInputs({ lifetime: captured.accountLifetime, signal: controller.signal,
      assertCurrent: () => { if (!captured.accountLifetime.isCurrent()) throw new Error('Account retired'); } });
    const evidence = { session: projectUsageSessionInput(session), callerDataKeyEnvelope: null,
      detail: projectSessionUsageWorkEvidence(session), completeMessageCoverage: true };
    const progress = createDeferred<void>();
    const completion = createDeferred<void>();
    const published: SessionInputEvidence[] = [];
    const first = inputs.read(session.id, true, async (assertCurrent, _signal, _retained, publish) => {
      await progress.promise;
      assertCurrent();
      publish(evidence);
      await completion.promise;
      assertCurrent();
      return evidence;
    }, value => published.push(value));
    // Observe rejection immediately so a failed progress callback is also a
    // deciding outcome, rather than an unhandled test-process rejection.
    const firstOutcome = Promise.resolve(first).then(value => ({ value }), error => ({ error }));
    try {
      const nextSession = { ...session, seq: 2 };
      storage.setState({ sessions: { streaming: nextSession } });
      inputs.reconcile();
      const replacement = { ...evidence, session: projectUsageSessionInput(nextSession) };
      expect(await inputs.read(session.id, true, async () => replacement)).toBe(replacement);
      progress.resolve();
      await flushHookEffects();
      completion.resolve();
      expect(await firstOutcome).toEqual({ value: evidence });
      expect(published).toEqual([evidence]);
      expect(await inputs.read(session.id, true, async () => { throw new Error('Unchanged admission must reuse the next read'); }))
        .toBe(replacement);
    } finally { progress.resolve(); completion.resolve(); await firstOutcome; inputs.dispose(); }
  });

  it('keeps shared discovery alive when one equivalent Resource consumer retires', async () => {
    const entered = createDeferred<void>();
    const releaseResponse = createDeferred<void>();
    const id = 'shared-discovery-retirement';
    const captured = await context(async request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      entered.resolve();
      await releaseResponse.promise;
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })), results: [{ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
        ] } }, ...(input.requests[0]!.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
      }] } satisfies UsageSessionEvidenceResponse);
    });
    const store = getUsageQueryResourceStore(captured);
    const entry = (metric: 'tokens' | 'cost') => store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [
      normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, metric, includeWorkEvidence: false, includeTranscriptEvidence: false }),
    ] }) });
    const first = entry('tokens');
    const second = entry('cost');
    const releaseFirst = first.subscribe(() => {}, true);
    let releaseSecond = () => {};
    try {
      await entered.promise;
      releaseSecond = second.subscribe(() => {}, true);
      await expect.poll(() => second.getSnapshot().value
        && decodeUsageQueryResource(second.getSnapshot().value!).results[0]?.accounting?.totals.tokens.total).toBe(15);
      await flushHookEffects({ cycles: 20 });
      releaseFirst();
      releaseResponse.resolve();
      await expect.poll(() => second.getSnapshot().pending).toBe('idle');
      expect(decodeUsageQueryResource(second.getSnapshot().value!).results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
      const demands = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
        .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
      expect(demands.filter(demand => !demand.query.includeTranscriptEvidence)).toHaveLength(1);
      expect(demands.filter(demand => demand.query.includeTranscriptEvidence)).toHaveLength(1);
    } finally { releaseResponse.resolve(); releaseFirst(); releaseSecond(); }
  });

  it('reads only the unconverted seven-day Session for Coach and a Session drill', async () => {
    const nowMs = 1_710_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const id = 'coach-unconverted';
    let transcriptBytes = 0;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const demand = UsageSessionEvidenceRequestSchema.parse(request.body).requests[0]!;
      const response = { requests: [{ query: demand.query, sessionIds: [id] }], results: [{ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: nowMs - 100, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: nowMs - 900, terminalAt: nowMs - 600, updatedAt: nowMs - 100 },
        ] } }, ...(demand.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [{ inputId: 'input', workId: JSON.stringify([id, 'turn']),
          acceptedAtMs: nowMs - 800, deliveryKind: 'steer', turnId: 'turn' }] }, messagesComplete: true } : {}),
      }] } satisfies UsageSessionEvidenceResponse;
      if (demand.query.includeTranscriptEvidence) transcriptBytes += JSON.stringify(response).length;
      return Response.json(response);
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: { [id]: createSessionFixture({ id, seq: 1,
      serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' }) } });
    const transcriptReads = () => home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH
      && UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => demand.query.includeTranscriptEvidence)).length;
    // Overview and the Coach view both demand the seven-day Coach query.
    const coach = normalizeUsageQuery({ period: { relative: '7days' }, includeComparison: false, includeWorkEvidence: false });
    const overview = await readUiUsageQueryBatch(captured, { queries: [coach] });
    expect(transcriptReads(), 'Coach on Overview reads only the unconverted Session').toBe(1);
    expect(transcriptBytes).toBeGreaterThan(0);
    expect(overview.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ selected: 1, notRead: 1 });
    expect(overview.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
    const drill = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ ...coach, session: id })] });
    expect(transcriptReads(), 'without a persisted fact, the drill reads only its unconverted Session').toBe(2);
    expect(drill.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 1 });
  });

  it('ends shared discovery and transcript evidence reads once the last Usage consumer leaves', async () => {
    const id = 'leaving-member';
    let discovery = createDeferred<void>();
    const transcript = createDeferred<void>();
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const demand = UsageSessionEvidenceRequestSchema.parse(request.body).requests[0]!;
      await (demand.query.includeTranscriptEvidence ? transcript : discovery).promise;
      const selected = demand.sessionIds ?? [id];
      return Response.json({ requests: [{ query: demand.query, sessionIds: selected }], results: selected.map(sessionId => ({ sessionId,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, seq: 1 }) } },
        turns: { status: 200, body: { v: 1, sessionId, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
        ] } }, ...(demand.query.includeTranscriptEvidence ? { messageEvidence: {}, messagesComplete: true } : {}),
      })) } satisfies UsageSessionEvidenceResponse);
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: { [id]: createSessionFixture({ id, seq: 1,
      serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' }) } });
    // Coach demands transcript evidence over the same window as its summary.
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [
      normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeComparison: false, includeWorkEvidence: false }),
    ] }) });
    const evidenceReads = () => home!.httpRequests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH);
    const isTranscript = (request: ReturnType<typeof evidenceReads>[number]) =>
      UsageSessionEvidenceRequestSchema.parse(request.body).requests[0]!.query.includeTranscriptEvidence;
    // Only the deferred phase is still being answered; settled reads are not open.
    const openReads = (phase: 'discovery' | 'transcript') => evidenceReads()
      .filter(request => !request.signal?.aborted && isTranscript(request) === (phase === 'transcript')).length;
    let release = entry.subscribe(() => {}, true);
    try {
      await vi.waitFor(() => expect(evidenceReads()).toHaveLength(1));
      release();
      await flushHookEffects({ cycles: 20 });
      expect(openReads('discovery'), 'leaving the page ends the held window discovery').toBe(0);
      discovery.resolve();
      discovery = createDeferred<void>();
      discovery.resolve();

      const before = evidenceReads().length;
      release = entry.subscribe(() => {}, true);
      await vi.waitFor(() => expect(evidenceReads().slice(before).some(isTranscript)).toBe(true));
      release();
      await flushHookEffects({ cycles: 20 });
      expect(openReads('transcript'), 'leaving the page ends the held transcript phase').toBe(0);
      transcript.resolve();
      await flushHookEffects({ cycles: 20 });
      const settled = evidenceReads().length;
      await flushHookEffects({ cycles: 20 });
      expect(evidenceReads().length, 'no evidence read starts after the last consumer left').toBe(settled);
    } finally { discovery.resolve(); transcript.resolve(); release(); }
  });

  it('loads only the newly selected Session transcript when a Usage evidence cohort grows', async () => {
    let ids = ['existing'];
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: undefined, sessionIds: [] });
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      const demand = input.requests[0]!;
      const selected = demand.sessionIds ?? ids;
      return Response.json({ requests: [{ query: demand.query, sessionIds: selected }], results: selected.map(id => ({ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
        ] } }, ...(demand.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [{ inputId: `input-${id}`,
          workId: JSON.stringify([id, 'turn']), acceptedAtMs: 200, deliveryKind: 'steer', turnId: 'turn' }] }, messagesComplete: true } : {}),
      })) } satisfies UsageSessionEvidenceResponse);
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: { existing: createSessionFixture({ id: 'existing', seq: 1,
      serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' }) } });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeComparison: false, includeWorkEvidence: false });
    const first = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(first.results[0]?.howYouWork?.inputs?.acceptedCount).toBe(1);
    home!.requests.length = 0;
    ids = ['existing', 'arriving'];
    storage.setState({ sessions: { ...storage.getState().sessions, arriving: createSessionFixture({ id: 'arriving', seq: 1,
      serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' }) } });
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['arriving'], { changeKinds: ['session'], usageQueryAffects: true });
    const next = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, first);
    expect(next.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ selected: 2, admitted: 2 });
    expect(next.results[0]?.howYouWork?.inputs?.acceptedCount).toBe(2);
    expect(next.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(600);
    const transcriptDemands = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests)
      .filter(demand => demand.query.includeTranscriptEvidence);
    expect(transcriptDemands.flatMap(demand => demand.sessionIds ?? []), 'unchanged complete histories survive unrelated cohort arrivals')
      .toEqual(['arriving']);
  });

  it('reads one discovery cohort for equivalent seven-day evidence projections while preserving distinct windows and subjects', async () => {
    const nowMs = 1_710_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const id = 'shared-discovery';
    const captured = await context(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })), results: [{ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1,
          metadata: { path: '/repo', host: 'usage-test', machineId: 'machine-a' } }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: nowMs - 100, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: nowMs - 900, terminalAt: nowMs - 600, updatedAt: nowMs - 100 },
        ] } }, ...(input.requests[0]!.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
      }] } satisfies UsageSessionEvidenceResponse);
    });
    const summary = normalizeUsageQuery({ period: { relative: '7days' }, includeComparison: false,
      includeWorkEvidence: false, includeTranscriptEvidence: false, workProjection: 'summary' });
    const detail = normalizeUsageQuery({ ...summary, includeComparison: true, includeWorkEvidence: true, workProjection: 'detail' });
    const otherWindow = normalizeUsageQuery({ ...summary, period: { relative: '30days' } });
    const otherSubject = normalizeUsageQuery({ ...summary, machines: ['machine-a'] });
    const queries = [summary, detail, otherWindow, otherSubject];
    const result = await readUiUsageQueryBatch(captured, { queries });
    const posts = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH
      && !UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => demand.query.includeTranscriptEvidence));
    expect(posts, 'equivalent discovery is one HTTP acquisition; distinct windows and subjects remain separate').toHaveLength(3);
    const requests = posts.flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
    expect(requests).toHaveLength(3);
    expect(requests.every(request => request.sessionIds === undefined && !request.query.includeTranscriptEvidence)).toBe(true);
    for (const query of queries) {
      const slice = result.results.find(row => row.key === getUsageQueryKey(query));
      expect(slice?.requestedQuery).toEqual(query);
      expect(slice?.howYouWork?.intervals?.agentTimeMs).toBe(300);
      expect(slice?.sources).toContainEqual({ source: 'how_you_work:transcripts', status: 'not_loaded' });
    }
  });

  it('keeps one seven-day discovery cohort across member wakes and asks only about a changed Session outside it', async () => {
    const nowMs = 1_710_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const member = 'cohort-member';
    let held: ReturnType<typeof createDeferred<void>> | null = createDeferred<void>();
    const entered = createDeferred<void>();
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      entered.resolve();
      await held?.promise;
      const ids = input.requests[0]!.sessionIds ?? input.requests[0]!.candidateSessionIds ?? [member];
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: ids })), results: ids.map(id => ({ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: nowMs - 100, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: nowMs - 900, terminalAt: nowMs - 600, updatedAt: nowMs - 100 },
        ] } },
      })) } satisfies UsageSessionEvidenceResponse);
    });
    const summary = normalizeUsageQuery({ period: { relative: '7days' }, includeComparison: false,
      includeWorkEvidence: false, includeTranscriptEvidence: false, workProjection: 'detail' });
    const periodSummary = normalizeUsageQuery({ ...summary, includeComparison: true, includeWorkEvidence: true, workProjection: 'summary' });
    const evidenceDemands = () => home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .map(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
    const discoveries = () => evidenceDemands().filter(demands => demands.every(demand =>
      demand.sessionIds === undefined && demand.candidateSessionIds === undefined));
    const windowQuestions = () => evidenceDemands().flatMap(demands => demands.flatMap(demand => demand.candidateSessionIds ?? []));
    const wake = (ids: string[]) => publishHomeAccountChange(captured.accountLifetime.scope.serverId, ids,
      { changeKinds: ['session'], usageQueryAffects: true });
    // A member's own turn wake arrives while the cohort is still being read; a
    // second consumer of the same window joins that read instead of re-reading it.
    const first = readUiUsageQueryBatch(captured, { queries: [summary] });
    await entered.promise;
    wake([member]);
    const second = readUiUsageQueryBatch(captured, { queries: [periodSummary] });
    await flushHookEffects({ cycles: 10 });
    held.resolve(); held = null;
    await Promise.all([first, second]);
    expect(discoveries(), 'a member wake during the read does not start a second cohort read').toHaveLength(1);
    wake([member]);
    const third = await readUiUsageQueryBatch(captured, { queries: [summary] });
    expect(third.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
    expect(discoveries(), 'a settled cohort survives its member wake; only that member is re-admitted').toHaveLength(1);
    wake(['arriving']);
    const grown = await readUiUsageQueryBatch(captured, { queries: [summary] });
    expect(discoveries(), 'a changed Session outside the cohort does not re-read the window').toHaveLength(1);
    expect(windowQuestions(), 'only that Session is asked about').toEqual(['arriving']);
    expect(grown.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ selected: 2, admitted: 2 });
    expect(grown.results[0]?.howYouWork?.intervals?.agentTimeMs, 'the joining row adds to the admitted cohort').toBe(600);
  });

  it('settles a summary slice while a sibling transcript in the same batch is held or fails', async () => {
    const transcript = createDeferred<Response>();
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/summary') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'summary',
        createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1 }) });
      if (request.path === '/v1/sessions/summary/turns') return Response.json({ v: 1, sessionId: 'summary', updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] });
      if (request.path === '/v1/sessions/summary/messages') return transcript.promise;
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: { summary: createSessionFixture({ id: 'summary', seq: 1,
      serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' }) } });
    const summary = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false, includeTranscriptEvidence: false });
    const detail = normalizeUsageQuery({ ...summary, includeTranscriptEvidence: true });
    let progress: Awaited<ReturnType<typeof readUiUsageQueryBatch>> | undefined;
    const reading = readUiUsageQueryBatch(captured, { queries: [summary, detail] }, undefined, undefined,
      { onProgress: project => { progress = project(); } });
    const slice = (query: typeof summary) => progress?.results.find(row => row.key === getUsageQueryKey(query));
    try {
      await expect.poll(() => sessionRequests().some(request => request.path.endsWith('/messages'))).toBe(true);
      await expect.poll(() => slice(summary)?.sources.find(source => source.source === 'how_you_work')?.status).toBe('partial');
      expect(sessionRequests().filter(request => request.path.endsWith('/messages')), 'summary and detail share one automatic conversion').toHaveLength(1);
      expect(slice(summary)?.pending, 'finished summary evidence cannot inherit a sibling transcript read').toBe(false);
      expect(slice(summary)?.howYouWork?.intervals?.agentTimeMs).toBe(300);
      expect(slice(summary)?.sources).toContainEqual({ source: 'how_you_work:transcripts', status: 'not_loaded' });
      expect(slice(detail)?.pending).toBe(true);
      expect(slice(detail)?.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'pending' }));
    } finally { transcript.resolve(Response.json({ error: 'unavailable' }, { status: 500 })); await reading; }
    for (const query of [summary, detail]) {
      expect(slice(query)?.pending, 'a terminal transcript transport failure cannot leave evidence reading').toBe(false);
      expect(slice(query)?.sources.some(source => source.source.startsWith('how_you_work') && source.status === 'pending')).toBe(false);
    }
    expect(slice(detail)?.sources).toContainEqual({ source: 'how_you_work:transcripts', status: 'partial' });
    expect(slice(detail)?.howYouWork?.inputs).toBeNull();
  });

  it('settles summary demand independently of a held transcript and admits later transcript demand', async () => {
    const transcript = createDeferred<Response>();
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/summary') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'summary',
        createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1 }) });
      if (request.path === '/v1/sessions/summary/turns') return Response.json({ v: 1, sessionId: 'summary', updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] });
      if (request.path === '/v1/sessions/summary/messages') return transcript.promise;
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: { summary: createSessionFixture({ id: 'summary', seq: 1,
      serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' }) } });
    const store = getUsageQueryResourceStore(captured);
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false, includeTranscriptEvidence: false });
    const reference = (input: typeof query) => ({ hostRead: 'usage.query' as const, input: projectNativeJsonValueForTransport({ queries: [input] }) });
    const summary = store.getEntry(reference(query));
    const detail = store.getEntry(reference(normalizeUsageQuery({ ...query, includeTranscriptEvidence: true })));
    const slice = (entry: typeof summary) => entry.getSnapshot().value ? decodeUsageQueryResource(entry.getSnapshot().value!).results[0] : undefined;
    const release = summary.subscribe(() => {}, false);
    let releaseDetail: (() => void) | undefined;
    const summaryRead = summary.refresh();
    try {
      await expect.poll(() => slice(summary)?.pending).toBe(false);
      expect(slice(summary)?.pending).toBe(false);
      expect(slice(summary)?.howYouWork?.intervals?.agentTimeMs).toBe(300);
      expect(slice(summary)?.howYouWork?.inputs).toBeNull();
      expect(slice(summary)?.sources).toContainEqual({ source: 'how_you_work:transcripts', status: 'not_loaded' });
      await expect.poll(() => sessionRequests().filter(request => request.path.endsWith('/messages')).length).toBe(1);
      releaseDetail = detail.subscribe(() => {}, false);
      const detailRead = detail.refresh();
      await expect.poll(() => sessionRequests().some(request => request.path.endsWith('/messages'))).toBe(true);
      await expect.poll(() => slice(detail)?.pending).toBe(true);
      expect(slice(summary)?.pending).toBe(false);
      expect(sessionRequests().filter(request => request.path.endsWith('/messages')), 'later detail joins the admitted automatic conversion').toHaveLength(1);
      transcript.resolve(Response.json({ messages: [], hasMore: false }));
      await Promise.all([summaryRead, detailRead]);
      expect(slice(detail)?.howYouWork?.inputs?.acceptedCount).toBe(0);
      expect(slice(detail)?.sources).toContainEqual({ source: 'how_you_work:transcripts', status: 'available' });
      await summary.refresh();
      expect(sessionRequests().filter(request => request.path.endsWith('/messages'))).toHaveLength(1);
    } finally { transcript.resolve(Response.json({ messages: [], hasMore: false })); await summaryRead; releaseDetail?.(); release(); }
  });

  it.each(['two exact views', 'retained census', 'census replacement 503', 'ordinary 503'] as const)(
    'replaces published private Activity on a Session refusal edge (%s)', async scenario => {
    const retiredId = 'previously-shared';
    const otherId = 'viewer-owned';
    const reads = new Map<number, number>();
    const transcripts = new Map<number, number>();
    let deny = false;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const demand = UsageSessionEvidenceRequestSchema.parse(request.body).requests[0]!;
      const start = 'startMs' in demand.query.period ? demand.query.period.startMs ?? 0 : 0;
      const phase = demand.query.includeTranscriptEvidence ? transcripts : reads;
      const count = (phase.get(start) ?? 0) + 1;
      phase.set(start, count);
      if (deny && (scenario === 'ordinary 503' && start === 30
        || scenario === 'census replacement 503' && start === 20)) return new Response(null, { status: 503 });
      if (count > 4) throw new Error('Unexpected repeating Session acquisition');
      const ids = demand.sessionIds ?? (demand.query.session === null
        ? (deny ? [otherId] : [retiredId, otherId])
        : typeof demand.query.session === 'string' ? [demand.query.session] : demand.query.session);
      return Response.json({ requests: [{ query: demand.query, sessionIds: ids }], results: ids.map(id => {
        if (deny && id === retiredId) return { sessionId: id, detail: { status: 403, body: { error: 'forbidden' } } };
        const startedAt = id === retiredId ? 100 : 500;
        return { sessionId: id,
          detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id,
            createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
            metadata: { name: id, machineId: 'shared-fixture-machine', path: '/fixture', host: 'test' } }) } },
          turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
            { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt, terminalAt: startedAt + 300, updatedAt: 900 },
          ] } },
          ...(demand.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
        };
      }) });
    });
    const store = getUsageQueryResourceStore(captured);
    const entryFor = (startMs: number, session: string[] | null) => store.getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({
        session, period: { startMs, endMs: 1000 }, includeQuota: false, includeComparison: false,
        includeSessionEvidence: true, includeTranscriptEvidence: false, includeWorkEvidence: false, includeCoach: false,
      })] }) });
    const slice = (entry: ReturnType<typeof entryFor>) => {
      const value = entry.getSnapshot().value;
      return value && decodeUsageQueryResource(value).results[0];
    };
    const time = (entry: ReturnType<typeof entryFor>) => slice(entry)?.howYouWork?.intervals?.agentTimeMs;
    const cause = (entry: ReturnType<typeof entryFor>) =>
      slice(entry)?.sources.find(source => source.source === 'how_you_work:sessions')?.errorCode;
    const first = entryFor(10, [retiredId, otherId]);
    const census = scenario === 'retained census' || scenario === 'census replacement 503';
    const second = entryFor(20, census ? null : [retiredId]);
    const settled = (entry: ReturnType<typeof entryFor>, expected: number | undefined) => {
      expect(entry.getSnapshot().pending).toBe('idle');
      expect(time(entry)).toBe(expected);
    };
    const pending = [false, false];
    const stops = [first, second].map((entry, index) => entry.subscribe(() => {
      if (deny && entry.getSnapshot().pending === 'refresh') pending[index] = true;
    }, true));
    try {
      await vi.waitFor(() => {
        settled(first, 600);
        settled(second, census ? 600 : 300);
      });
      const aged = scenario === 'two exact views' ? entryFor(19, [retiredId]) : undefined;
      await aged?.refresh({ supersede: false });
      if (aged) settled(aged, 300);
      const agedReads = reads.get(19);
      const counts = [reads.get(10)!, reads.get(20)!];
      const ownTranscriptReads = transcripts.get(10);
      deny = true;
      const refusing = entryFor(30, [retiredId]);
      await refusing.refresh({ supersede: false });
      if (scenario === 'ordinary 503') {
        expect(cause(refusing)).toBe('http_error');
        settled(first, 600);
        settled(second, 300);
        expect([reads.get(10), reads.get(20)]).toEqual(counts);
        expect(pending).toEqual([false, false]);
        return;
      }
      const expectReplacement = () => {
        expect([reads.get(10), reads.get(20)], 'one Home acquisition per affected settled entry')
          .toEqual(counts.map(count => count + 1));
        expect(pending).toEqual([true, true]);
        expect(transcripts.get(10), 'unaffected converted evidence is retained').toBe(ownTranscriptReads);
        settled(first, 300);
        expect(cause(first)).toBe('forbidden');
        settled(second, census ? 300 : undefined);
        expect(cause(second)).toBe(scenario === 'retained census' ? undefined : 'forbidden');
      };
      await vi.waitFor(expectReplacement);
      if (aged) {
        expect(reads.get(19)).toBe(agedReads);
        const stopAged = aged.subscribe(() => {}, true);
        try {
          await vi.waitFor(() => { settled(aged, undefined); expect(cause(aged)).toBe('forbidden'); });
          expect(reads.get(19)).toBe(agedReads! + 1);
        } finally { stopAged(); }
      }
      await entryFor(31, [retiredId]).refresh({ supersede: false });
      expectReplacement();
      deny = false;
      const recovered = entryFor(32, [retiredId]);
      const stopRecovery = recovered.subscribe(() => {}, true);
      try {
        await vi.waitFor(() => { settled(recovered, 300); expect(cause(recovered)).toBeUndefined(); });
        const before = reads.get(32)!;
        deny = true;
        await entryFor(33, [retiredId]).refresh({ supersede: false });
        await vi.waitFor(() => { settled(recovered, undefined); expect(cause(recovered)).toBe('forbidden'); });
        expect(reads.get(32)).toBe(before + 1);
        expectReplacement();
      } finally { stopRecovery(); }
    } finally { for (const stop of stops) stop(); }
  });

  it.each(['settled', 'mixed Accounting read held'] as const)(
    'reacquires overlapping exact Activity widgets after a singleton Accounting refusal (%s)', async readOrder => {
    const shared = 'previously-shared';
    const own = 'viewer-owned';
    const now = Date.UTC(2026, 10, 27, 12);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const ownStart = now - 1000;
    let revoked = false;
    let replacementReads = 0;
    const heldReplacement = createDeferred<void>();
    const heldMixedAccounting = createDeferred<void>();
    let mixedAccountingIssued = false;
    let holdNextMixedAccounting = false;
    let mixedRead: Promise<unknown> | undefined;
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') {
        const ids = (request.body as { filters?: { sessionIds?: string[] } }).filters?.sessionIds;
        if (holdNextMixedAccounting && ids?.length === 2) {
          holdNextMixedAccounting = false;
          mixedAccountingIssued = true;
          await heldMixedAccounting.promise;
          return Response.json(value);
        }
        return revoked && ids?.includes(shared)
          ? Response.json({ error: 'not_found' }, { status: 404 })
          : Response.json(value);
      }
      if (request.method === 'PUT' && request.path.endsWith('/system-records')) return successfulUsageFactWrite(request.body);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const { requests } = UsageSessionEvidenceRequestSchema.parse(request.body);
      const ids = [...new Set(requests.flatMap(demand => demand.sessionIds ?? []))];
      if (revoked) {
        replacementReads++;
        await heldReplacement.promise;
      }
      return Response.json({ requests: requests.map(demand => ({ query: demand.query, sessionIds: demand.sessionIds ?? [] })),
        results: ids.map(id => {
          if (revoked && id === shared) return { sessionId: id, detail: { status: 404, body: { error: 'not_found' } } };
          const startedAt = id === shared ? now - 2_000 : ownStart;
          return { sessionId: id, detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({
            id, createdAt: startedAt - 100, updatedAt: now, seq: 1, active: true, activeAt: now,
            metadata: { name: id, machineId: 'proof-machine', path: '/fixture', host: 'test' },
          }) } }, turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: now,
            turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt,
              terminalAt: startedAt + 300, updatedAt: now }],
          } }, ...(requests.some(demand => demand.query.includeTranscriptEvidence)
            ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}) };
        }) });
    });
    const store = getUsageQueryResourceStore(captured);
    const activity = normalizeUsageQuery({ session: [shared, own], period: { relative: '7days' },
      includeQuota: false, includeComparison: false, includeSessionEvidence: true,
      includeTranscriptEvidence: false, includeWorkEvidence: false, includeCoach: false, includeActivity: true });
    const humanLoop = normalizeUsageQuery({ ...activity, includeActivity: false, includeTranscriptEvidence: true });
    const entryFor = (query: typeof activity) => store.getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const entries = [activity, humanLoop].map(entryFor);
    const unaffected = entryFor(normalizeUsageQuery({ ...activity, session: own }));
    const shown = (entry: typeof entries[number]) => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    const refreshes = [0, 0, 0];
    const firstWithdrawn = new Map<number, ReturnType<typeof shown>>();
    const framesAfterWithdrawal: Array<{ entry: number; slice: ReturnType<typeof shown> }> = [];
    const stop = [...entries, unaffected].map((entry, index) => {
      let refreshing = false;
      return entry.subscribe(() => {
        const next = entry.getSnapshot().pending === 'refresh';
        if (revoked && index < entries.length && entry.getSnapshot().value) {
          const frame = shown(entry);
          if (!firstWithdrawn.has(index) && frame.sources.some(source => source.source === 'accounting' && source.errorCode === 'denied')) {
            firstWithdrawn.set(index, frame);
          }
          if (firstWithdrawn.has(index)) framesAfterWithdrawal.push({ entry: index, slice: frame });
        }
        if (revoked && next && !refreshing) refreshes[index]!++;
        refreshing = next;
      }, true);
    });
    try {
      await vi.waitFor(() => {
        for (const entry of entries) {
          expect(entry.getSnapshot().pending).toBe('idle');
          expect(entry.getSnapshot().value).toBeDefined();
          expect(shown(entry).howYouWork?.intervals?.agentTimeMs).toBe(600);
        }
      });
      await vi.waitFor(() => {
        expect(unaffected.getSnapshot().pending).toBe('idle');
        expect(shown(unaffected).howYouWork?.intervals?.agentTimeMs).toBe(300);
      });
      const ownBefore = shown(unaffected);
      const ownLanes = entries.map(entry => shown(entry).howYouWork?.intervals?.lanes
        .filter(lane => lane.busy.some(segment => segment.startMs === ownStart)));
      expect(ownLanes.every(lanes => lanes?.length === 1)).toBe(true);
      if (readOrder === 'mixed Accounting read held') {
        holdNextMixedAccounting = true;
        mixedRead = entries[0]!.refresh();
        void mixedRead.catch(() => {});
        await vi.waitFor(() => expect(mixedAccountingIssued, 'the mixed Accounting read started before refusal').toBe(true));
      }
      revoked = true;
      clock.mockReturnValue(now + 1000);
      const trigger = entryFor(normalizeUsageQuery({ ...activity, session: shared, includeWorkEvidence: true }));
      await trigger.refresh({ supersede: false });
      expect(shown(trigger).sources).toContainEqual({ source: 'accounting', status: 'error', errorCode: 'denied' });
      await vi.waitFor(() => expect(firstWithdrawn.size).toBe(2));
      entries.forEach((entry, index) => {
        const first = firstWithdrawn.get(index)!;
        expect(first.howYouWork?.intervals?.agentTimeMs, 'the first withdrawal frame excludes the refused Session').toBe(300);
        expect(first.howYouWork?.intervals?.lanes).toEqual(ownLanes[index]);
        const reopened = entryFor([activity, humanLoop][index]!);
        expect(shown(reopened).howYouWork?.intervals?.agentTimeMs, 'the warm reopen cannot revive the refused Session').toBe(300);
        expect(shown(reopened).howYouWork?.intervals?.lanes).toEqual(ownLanes[index]);
        expect(entry.getSnapshot().pending).not.toBe('idle');
      });
      heldMixedAccounting.resolve();
      await vi.waitFor(() => expect(replacementReads).toBe(1));
      await flushHookEffects();
      heldReplacement.resolve();
      await mixedRead;
      await vi.waitFor(() => {
        entries.forEach((entry, index) => {
          expect(entry.getSnapshot().pending).toBe('idle');
          const slice = shown(entry);
          expect(slice.howYouWork?.intervals?.agentTimeMs).toBe(300);
          expect(slice.howYouWork?.intervals?.lanes).toEqual(ownLanes[index]);
          expect(slice.sources.find(source => source.source === 'how_you_work:sessions')).toMatchObject({
            status: 'partial', errorCode: 'not_found',
          });
          expect(slice.accounting).toBeUndefined();
        });
        if (readOrder === 'settled') expect(refreshes).toEqual([1, 1, 0]);
        else expect(refreshes[2]).toBe(0);
        expect(shown(unaffected)).toEqual(ownBefore);
        expect(replacementReads, 'the widgets share one physical re-read of Session evidence').toBe(1);
      });
      await flushHookEffects();
      expect(replacementReads).toBe(1);
      for (const { entry, slice } of framesAfterWithdrawal) {
        expect(slice.howYouWork?.intervals?.agentTimeMs, 'a later publication cannot restore refused Activity').toBe(300);
        expect(slice.howYouWork?.intervals?.lanes).toEqual(ownLanes[entry]);
      }
    } finally {
      heldMixedAccounting.resolve();
      heldReplacement.resolve();
      stop.forEach(unsubscribe => unsubscribe());
      clock.mockRestore();
    }
  });

  const fallbackWindows = ['fixed', 'rolling same day', 'rolling next day'] as const;
  const fallbackFailures = ['Session evidence 503', 'thrown batch', 'census 503'] as const;
  it.each([
    ...fallbackWindows.flatMap(window => fallbackFailures.flatMap(failure =>
      [true, false].map(refused => ({ window, failure, refused, advancingAccounting: false })))),
    { window: 'fixed', failure: 'thrown batch', refused: true, advancingAccounting: true } as const,
  ])(
    'retains the admitted Activity window after a failed replacement ($window; $failure; refusal=$refused; advancing Accounting=$advancingAccounting)',
    async ({ window, failure, refused, advancingAccounting }) => {
      const retiredId = 'revoked-activity';
      const otherId = 'remaining-activity';
      const beforeMidnight = Date.UTC(2026, 10, 25, 23, 59);
      const afterMidnight = beforeMidnight + 120_000;
      const turnDay = advancingAccounting ? Date.UTC(2026, 10, 18) : beforeMidnight - 60_000;
      const period = advancingAccounting ? { startMs: Date.UTC(2026, 10, 16), endMs: Date.UTC(2026, 10, 23) }
        : window === 'fixed' ? { startMs: turnDay - 1000, endMs: afterMidnight + 1000 }
          : { relative: '7days' as const };
      const exact = failure === 'Session evidence 503';
      const enclosing = failure === 'thrown batch';
      const clock = vi.spyOn(Date, 'now').mockReturnValue(beforeMidnight);
      const kv = createAccountKvHttpFixture();
      const replacementEntered = createDeferred<void>();
      const releaseActivity = createDeferred<void>();
      const releaseSiblingFailure = createDeferred<void>();
      let failing = false;
      let replacements = 0;
      const captured = await context(async request => {
        if (request.path === '/v2/usage/query') {
          if (!advancingAccounting) return Response.json(value);
          const eventCount = failing ? 2 : 1;
          return Response.json({ ...value, totals: { ...value.totals, eventCount },
            activity: { calendarDays: [{ date: '2026-11-18', eventCount }] } });
        }
        if (request.path === '/v1/kv/bulk' && failing && failure === 'thrown batch') {
          await releaseSiblingFailure.promise;
          throw new Error('Unexpected independent read failure');
        }
        if (request.path === '/v1/kv/bulk') return await kv.handleFetch(request.url, { method: request.method,
          body: JSON.stringify(request.body) }) ?? undefined;
        if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
        const demand = UsageSessionEvidenceRequestSchema.parse(request.body).requests[0]!;
        const ids = demand.sessionIds ?? (demand.query.session === null ? [retiredId, otherId]
          : typeof demand.query.session === 'string' ? [demand.query.session] : demand.query.session);
        const sibling = demand.query.session !== null && ids.length === 1 && ids[0] === retiredId;
        if (failing && !sibling) {
          replacements++;
          replacementEntered.resolve();
          if (enclosing) await releaseActivity.promise;
          return new Response(null, { status: 503 });
        }
        return Response.json({ requests: [{ query: demand.query, sessionIds: ids }], results: ids.map(id => {
          if (failing && refused && id === retiredId) return { sessionId: id, detail: { status: 403, body: { error: 'forbidden' } } };
          const startedAt = turnDay + (id === retiredId ? 100 : 500);
          return { sessionId: id, detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({
            id, createdAt: turnDay, updatedAt: turnDay + 900, seq: 1, active: true, activeAt: turnDay + 900,
            metadata: { name: id, machineId: 'shared-fixture-machine', path: '/fixture', host: 'test' },
          }) } }, turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: turnDay + 900, turns: [
            { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt, terminalAt: startedAt + 300, updatedAt: turnDay + 900 },
          ] } } };
        }) });
      });
      const store = getUsageQueryResourceStore(captured);
      const view = (selectedPeriod: typeof period, session: string[] | null, includeCoach: boolean) => store.getEntry({
        hostRead: 'usage.query',
        input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({ session, period: selectedPeriod,
          timeZoneOffsetMinutes: 0, includeQuota: false, includeComparison: false, includeSessionEvidence: true,
          includeTranscriptEvidence: false, includeWorkEvidence: false, includeCoach, includeActivity: advancingAccounting })] }),
      });
      const affected = view(period, exact ? [retiredId, otherId] : null, enclosing);
      const show = () => decodeUsageQueryResource(affected.getSnapshot().value!).results[0]!;
      const activityDate = () => show().sources.find(source => source.source === 'how_you_work')?.asOfMs;
      let stop = affected.subscribe(() => {}, true);
      try {
        await vi.waitFor(() => {
          expect(affected.getSnapshot().pending).toBe('idle');
          expect(affected.getSnapshot().error).toBeUndefined();
          expect(show().howYouWork?.intervals?.agentTimeMs).toBe(600);
        });
        expect(activityDate()).toBe(beforeMidnight);
        const prior = affected.getSnapshot().value!;
        clock.mockReturnValue(window === 'rolling next day' ? afterMidnight : beforeMidnight + 20_000);
        failing = true;
        if (advancingAccounting) {
          // Age the recorded week while this view is closed so reopening
          // acquires both the new Accounting and the refusal replacement once.
          stop();
          invalidateUsageQueryResources(captured.accountLifetime);
        }
        if (refused) await view({ startMs: turnDay - 500, endMs: afterMidnight + 1000 }, [retiredId], false)
          .refresh({ supersede: false });
        else if (enclosing) {
          // Keep the summary acquisition itself held. A reused summary can
          // settle Activity while the separate conversion request is outstanding.
          publishHomeAccountChange(captured.accountLifetime.scope.serverId, [retiredId, otherId],
            { changeKinds: ['session'], usageQueryAffects: true });
        } else invalidateUsageQueryResources(captured.accountLifetime);
        if (advancingAccounting) stop = affected.subscribe(() => {}, true);
        await expect.poll(() => replacements).toBe(1);
        await replacementEntered.promise;
        if (enclosing) {
          await vi.waitFor(() => {
            expect(show().sources.find(source => source.source === 'how_you_work')?.status).toBe('pending');
            if (advancingAccounting) {
              expect(show().accounting?.totals.eventCount).toBe(2);
              expect(show().planInsights?.recordedWeek).toMatchObject({ status: 'available', recordedEvents: 2 });
            }
          });
          releaseSiblingFailure.resolve();
        }
        await vi.waitFor(() => expect(affected.getSnapshot().pending).toBe('idle'));
        const decoder = new TextDecoder();
        const publication = JSON.parse(decoder.decode(affected.getSnapshot().value!.bytes));
        const transported = UsageQueryBatchResultSchema.parse(publication);
        if (advancingAccounting) {
          expect(transported.results[0]?.accounting?.totals.eventCount).toBe(2);
          expect(transported.results[0]?.planInsights?.recordedWeek).toMatchObject({
            status: 'available', recordedEvents: 2, observedBusyMs: 300,
          });
        } else {
          const previous = UsageQueryBatchResultSchema.parse(JSON.parse(decoder.decode(prior.bytes)));
          expect(transported.results[0]?.accounting).toEqual(previous.results[0]?.accounting);
        }
        if (refused) {
          expect.soft(show().howYouWork?.intervals?.agentTimeMs).toBe(300);
          expect.soft(show().sources.find(source => source.source === 'how_you_work:sessions')).toMatchObject({
            status: 'partial', errorCode: 'forbidden',
          });
          expect.soft(activityDate()).toBe(beforeMidnight);
        } else {
          const previous = JSON.parse(decoder.decode(prior.bytes));
          expect.soft(JSON.stringify(publication.results[0]?.howYouWork)).toBe(JSON.stringify(previous.results[0]?.howYouWork));
          expect.soft(activityDate()).toBe(beforeMidnight);
        }
        releaseActivity.resolve();
        await vi.waitFor(() => expect(affected.getSnapshot().pending).toBe('idle'));
        expect(replacements).toBe(1);
      } finally {
        releaseSiblingFailure.resolve();
        releaseActivity.resolve();
        stop();
        clock.mockRestore();
      }
    },
  );

  const settledBeforeFailure = ['fresh Activity', 'Session-detail refusal', 'Accounting refusal'] as const;
  it.each(fallbackWindows.flatMap(window => settledBeforeFailure.map(state => ({ window, state }))))(
    'keeps the last settled Activity publication after an independent failure ($window; $state)',
    async ({ window, state }) => {
      const subject = 'activity-subject';
      const unrelated = 'activity-independent';
      const original = Date.UTC(2026, 10, 25, 23, 59);
      const updated = original + (window === 'rolling next day' ? 120_000 : 20_000);
      const started = original - 60_000;
      const period = window === 'fixed' ? { startMs: started - 1000, endMs: updated + 1000 }
        : { relative: '7days' as const };
      const clock = vi.spyOn(Date, 'now').mockReturnValue(original);
      const siblingEntered = createDeferred<void>();
      const failSibling = createDeferred<void>();
      let replacing = false;
      let requests = 0;
      const captured = await context(async request => {
        if (request.path === '/v2/usage/query') {
          const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
          if (replacing && query.filters?.sessionIds?.includes(subject)) {
            requests++;
            if (state === 'Accounting refusal') return new Response(null, { status: 404 });
            return Response.json({ ...value, totals: { ...value.totals, eventCount: 2 } });
          }
          return Response.json(value);
        }
        if (request.path === '/v1/kv/bulk' && replacing && request.body && typeof request.body === 'object'
          && 'keys' in request.body && Array.isArray(request.body.keys) && request.body.keys.includes(USAGE_COACH_SUPPRESSIONS_KV_KEY)) {
          siblingEntered.resolve();
          await failSibling.promise;
          throw new Error('Independent acquisition failed');
        }
        if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
        const { requests: demands } = UsageSessionEvidenceRequestSchema.parse(request.body);
        const selected = demands.map(demand => {
          const session = demand.query.session;
          return { query: demand.query, sessionIds: demand.sessionIds ?? (typeof session === 'string' ? [session] : session ?? []) };
        });
        return Response.json({ requests: selected, results: [...new Set(selected.flatMap(demand => demand.sessionIds))].map(id => {
          if (replacing && id === subject && state === 'Session-detail refusal') {
            return { sessionId: id, detail: { status: 403, body: { error: 'forbidden' } } };
          }
          return { sessionId: id, detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({
            id, createdAt: started, updatedAt: replacing ? updated : original, seq: replacing ? 2 : 1,
          }) } }, turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: replacing ? updated : original, turns: [
            { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: started,
              terminalAt: started + (replacing ? 700 : 300), updatedAt: replacing ? updated : original },
          ] } } };
        }) });
      });
      const query = (session: string, includeCoach: boolean) => normalizeUsageQuery({ session, period, includeCoach,
        timeZoneOffsetMinutes: 0, includeQuota: false, includeComparison: false, includeSessionEvidence: true,
        includeTranscriptEvidence: false, includeWorkEvidence: false });
      const primary = query(subject, false);
      const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
        input: projectNativeJsonValueForTransport({ queries: [primary, query(unrelated, true)] }) });
      const shown = () => decodeUsageQueryResource(entry.getSnapshot().value!).results.find(slice => slice.key === getUsageQueryKey(primary))!;
      const phase = (source: string) => shown().sources.find(item => item.source === source);
      const unsubscribe = entry.subscribe(() => {}, false);
      try {
        await entry.refresh();
        expect(shown().howYouWork?.intervals?.agentTimeMs).toBe(300);
        expect(phase('how_you_work')?.asOfMs).toBe(original);
        replacing = true;
        clock.mockReturnValue(updated);
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, [subject], { changeKinds: ['session'], usageQueryAffects: true });
        const renewal = entry.refresh({ supersede: false });
        await siblingEntered.promise;
        await vi.waitFor(() => {
          if (state === 'fresh Activity') {
            expect(shown().howYouWork?.intervals?.agentTimeMs).toBe(700);
            expect(phase('how_you_work')?.asOfMs).toBe(updated);
          } else if (state === 'Session-detail refusal') {
            expect(phase('how_you_work:sessions')?.errorCode).toBe('forbidden');
            expect(shown().howYouWork?.intervals?.agentTimeMs).toBeUndefined();
          } else {
            expect(phase('accounting')).toMatchObject({ status: 'error', errorCode: 'denied' });
            expect(shown().howYouWork).toBeUndefined();
          }
          expect(shown().pending).toBe(false);
        });
        const settled = shown();
        failSibling.resolve();
        await renewal;
        expect(entry.getSnapshot().pending).toBe('idle');
        expect(entry.getSnapshot().error).toBeDefined();
        expect(shown()).toEqual(settled);
        expect(requests).toBe(1);
      } finally {
        failSibling.resolve();
        unsubscribe();
        clock.mockRestore();
      }
    },
  );

  it.each(['stable refusal', 'unwatch and revisit', 'replacement 503'] as const)(
    'publishes admitted Activity and schedules one terminal replacement (%s)', async scenario => {
    const id = 'previously-shared';
    const entered = createDeferred<void>();
    const held = createDeferred<void>();
    const replacementEntered = createDeferred<void>();
    const replacement = createDeferred<void>();
    let warmingWatch = true;
    let deny = false;
    let exactRequests = 0;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({
        ...value, coverage: { status: 'complete', reasons: [], missingDimensions: [], ranked: [], sources: [],
          range: { startMs: 0, endMs: 1000, complete: true } },
      });
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      const exact = input.requests[0]?.query.period.relative === 'all';
      if (exact && warmingWatch) return new Response(null, { status: 503 });
      const response = Response.json({
        requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })),
        results: deny ? [{ sessionId: id, detail: { status: 403, body: { error: 'forbidden' } } }] : [{
          sessionId: id,
          detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id,
            createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
            metadata: { name: 'Restricted fixture title', machineId: 'shared-fixture-machine', path: '/fixture', host: 'test' } }) } },
          turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
            { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
          ] } },
        }],
      });
      if (!exact) return response;
      exactRequests++;
      if (exactRequests === 1) {
        entered.resolve();
        return held.promise.then(() => response);
      }
      if (exactRequests === 2) {
        replacementEntered.resolve();
        return replacement.promise.then(() => scenario === 'replacement 503' ? new Response(null, { status: 503 }) : response);
      }
      if (scenario === 'unwatch and revisit' && exactRequests === 3) return response;
      throw new Error('Unexpected repeating Session acquisition');
    });
    const query = normalizeUsageQuery({ session: [id], period: { relative: 'all' },
      includeQuota: false, includeQuotaHistory: scenario !== 'replacement 503', includeComparison: false,
      includeSessionEvidence: true, includeTranscriptEvidence: scenario === 'replacement 503',
      includeWorkEvidence: false, includeCoach: false,
      ...(scenario === 'replacement 503' ? {
        breakdown: [], workProjection: 'detail', includeSeries: false, includeContributions: false,
        includeInsights: false, includeActivity: false, includeLeaders: false, includeModelTimeline: false, includeMessageStats: false,
      } : {}) });
    const store = getUsageQueryResourceStore(captured);
    const referenceFor = (operand: typeof query) => ({ hostRead: 'usage.query' as const,
      input: projectNativeJsonValueForTransport({ queries: [operand] }) });
    const reference = referenceFor(query);
    const original = store.getEntry(reference);
    const known = (startMs: number) => store.getEntry(referenceFor(normalizeUsageQuery({ ...query, period: { startMs, endMs: 999 } })));
    const activity = (item: unknown) => UsageQueryBatchResultSchema.parse(item).results[0]!;
    const shown = (entry: typeof original) => {
      const value = entry.getSnapshot().value;
      return value ? activity(decodeUsageQueryResource(value)) : undefined;
    };
    const published: number[] = [];
    const observe = () => {
      const duration = shown(original)?.howYouWork?.intervals?.agentTimeMs;
      if (duration !== undefined) published.push(duration);
    };
    const account = await captureLazyActionAccountContext(captured.accountLifetime.scope.serverId);
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
    const readForRecap = () => executor.execute(USAGE_PRIVATE_RECAP_ACTION_IDS.compose, {
      query, selectedFields: ['tokens', 'parallel'],
    }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
    let stop = original.subscribe(observe, true);
    let stopLate: (() => void) | undefined;
    let stopPlugin: (() => void) | undefined;
    let heldRead: Promise<unknown> | undefined;
    let outward: ReturnType<typeof readForRecap> | undefined;
    const admissionLifetime = new AbortController();
    const host = createPluginSurfaceHostReadStore({
      admit: async next => store.getEntry(next),
      lifetimeSignal: admissionLifetime.signal, isCurrent: captured.accountLifetime.isCurrent,
    });
    try {
      await vi.waitFor(() => {
        expect(original.getSnapshot().subscription).toBe('live');
        expect(original.getSnapshot().pending).toBe('idle');
        expect(original.getSnapshot().value !== undefined || original.getSnapshot().error !== undefined).toBe(true);
      });
      await known(1).refresh({ supersede: false });
      expect(shown(known(1))?.howYouWork?.intervals?.agentTimeMs).toBe(300);
      warmingWatch = false;
      heldRead = original.refresh({ supersede: false });
      await entered.promise;
      deny = true;
      await known(2).refresh({ supersede: false });
      held.resolve();
      await vi.waitFor(() => expect(published).toContain(300));
      await vi.waitFor(() => expect(exactRequests, 'the held completion needs exactly one replacement').toBe(2));
      await replacementEntered.promise;
      if (scenario === 'unwatch and revisit') {
        stop();
        stop = () => {};
        replacement.resolve();
        await heldRead;
        expect(exactRequests).toBe(2);
        stop = original.subscribe(observe, true);
      }
      if (scenario === 'stable refusal') {
        stopLate = original.subscribe(() => {}, true);
        const selected = host.getEntry(reference).select({ decode: decodeUsageQueryResource }, snapshot =>
          snapshot.value?.results[0]?.howYouWork?.intervals?.agentTimeMs);
        stopPlugin = selected.subscribe(() => {}, true);
        await vi.waitFor(() => expect(selected.getSnapshot()).toBe(300));
        expect(exactRequests).toBe(2);
      }
      if (scenario === 'replacement 503') {
        let completed = false;
        outward = readForRecap().finally(() => { completed = true; });
        await flushHookEffects();
        expect(completed, 'a new outward invocation cannot read the pending display').toBe(false);
        stop();
        stop = () => {};
      }
      replacement.resolve();
      if (outward) {
        const answer = await outward;
        if (!answer.ok) throw new Error(answer.errorCode);
        expect(UsageRecapComposeResultSchema.parse(answer.result)).toMatchObject({
          kind: 'composed', unavailableFields: ['parallel'],
        });
      }
      await vi.waitFor(() => {
        if (!outward) expect(original.getSnapshot().pending).toBe('idle');
        expect(shown(original)?.pending).toBe(false);
        expect(shown(original)?.howYouWork?.intervals?.agentTimeMs).toBeUndefined();
        expect(shown(original)?.sources.find(source => source.source === 'how_you_work:sessions')?.errorCode).toBe('forbidden');
        expect(exactRequests).toBe(scenario === 'unwatch and revisit' ? 3 : 2);
      });
      await flushHookEffects();
      expect(exactRequests).toBe(scenario === 'unwatch and revisit' ? 3 : 2);
    } finally {
      held.resolve();
      replacement.resolve();
      await Promise.allSettled([heldRead, outward]);
      stopPlugin?.();
      admissionLifetime.abort();
      host.dispose();
      stopLate?.();
      stop();
      account.dispose();
    }
  });

  it('publishes admitted intervals while shared transcript detail is held, and keeps the readable subset partial on refusal', async () => {
    const secondAdmission = createDeferred<void>();
    const transcript = createDeferred<Response>();
    let holdTranscript = true;
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      const id = request.path === '/v2/sessions/first' ? 'first'
        : request.path === '/v2/sessions/second' ? 'second' : null;
      if (id) {
        if (id === 'second') await secondAdmission.promise;
        return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id,
          createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
          metadataVersion: 1, agentStateVersion: 1 }) });
      }
      if (request.path === '/v1/sessions/first/turns' || request.path === '/v1/sessions/second/turns') {
        const id = request.path.split('/')[3]!;
        return Response.json({ v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100,
            terminalAt: id === 'first' ? 400 : 700, updatedAt: 900 },
        ] });
      }
      if (request.path === '/v1/sessions/first/messages' && holdTranscript) return (await transcript.promise).clone();
      if (request.path.endsWith('/messages')) return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: Object.fromEntries(
      ['first', 'second'].map(id => [id, createSessionFixture({ id, seq: 1,
        serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' })]),
    ) });
    const store = getUsageQueryResourceStore(captured);
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false });
    const broad = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const pinned = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [
      normalizeUsageQuery({ ...query, session: 'first' }),
    ] }) });
    const slice = (entry: typeof broad) => entry.getSnapshot().value
      ? decodeUsageQueryResource(entry.getSnapshot().value!).results[0] : undefined;
    const release = broad.subscribe(() => {}, false);
    let releasePinned: (() => void) | undefined;
    const refreshing = broad.refresh();
    try {
      await expect.poll(() => sessionRequests().some(request => request.path === '/v2/sessions/second')).toBe(true);
      expect(slice(broad)?.howYouWork?.intervals).toBeNull();
      secondAdmission.resolve();
      await expect.poll(() => sessionRequests().some(request => request.path === '/v1/sessions/first/messages')).toBe(true);
      await expect.poll(() => slice(broad)?.howYouWork?.intervals?.agentTimeMs).toBe(900);
      expect(slice(broad)?.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'how_you_work', status: 'pending' }),
        expect.objectContaining({ source: 'how_you_work:sessions', status: 'available' }),
        expect.objectContaining({ source: 'how_you_work:transcripts', status: 'pending' }),
      ]));
      // Different selected populations have independent demand admissions;
      // neither private read may hold the other's witnessed interval phase.
      releasePinned = pinned.subscribe(() => {}, false);
      const pinnedRefresh = pinned.refresh();
      await expect.poll(() => slice(pinned)?.howYouWork?.intervals?.agentTimeMs).toBe(300);
      expect(home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
        .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests)
        .filter(demand => demand.query.includeTranscriptEvidence).map(demand => demand.sessionIds)).toEqual([
          ['first', 'second'], ['first'],
        ]);
      transcript.resolve(Response.json({ error: 'denied' }, { status: 403 }));
      await Promise.all([refreshing, pinnedRefresh]);
      expect(slice(broad)?.howYouWork).toMatchObject({ detailStatus: 'partial',
        sessionCoverage: { selected: 2, admitted: 1 }, intervals: { agentTimeMs: 600,
          lanes: [{ workId: '["second","turn"]' }] },
        runLengths: { coverage: 'partial', sampleCount: 1, byAgent: [{ agentId: 'codex', durationsMs: [600] }] } });
      expect(slice(broad)?.sources).toContainEqual({ source: 'how_you_work:sessions', status: 'partial', errorCode: 'forbidden' });
      expect(slice(pinned)?.howYouWork?.intervals).toBeNull();
      expect(slice(pinned)?.howYouWork?.runLengths).toBeNull();
      expect(slice(broad)?.sources.some(source => source.source.startsWith('how_you_work') && source.status === 'pending')).toBe(false);
      holdTranscript = false;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['first'], { changeKinds: ['session'], usageQueryAffects: true });
      await broad.refresh();
      expect(slice(broad)?.howYouWork?.intervals?.agentTimeMs).toBe(900);
    } finally {
      secondAdmission.resolve();
      transcript.resolve(Response.json({ messages: [], hasMore: false }));
      await refreshing;
      releasePinned?.();
      release();
    }
  });

  it.each([{}, { projects: ['project'] }, { sources: ['runtime'] }])('opens aggregate composition and accepted delivery within scope %j', async filters => {
    const suppressionsKv = createAccountKvHttpFixture();
    const suppressionReadStarted = createDeferred<void>();
    const releaseSuppressionRead = createDeferred<void>();
    let holdSuppressionRead = false;
    let olderRead: ReturnType<typeof readUiUsageQueryBatch> | undefined;
    const coachSession = createPlainSessionCurrentProjectionRecordFixture({
      id: 'coach-session', createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
      metadataVersion: 1, metadata: { name: 'Opened', path: '/workspace/project', host: 'host', machineId: 'machine',
        runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} } },
      agentStateVersion: 1,
    });
    // This fixture exercises Coach preferences. The exact Home target can
    // also be opened for Work, where this daemon does not support SCM evidence.
    scmTransport.mockImplementation(async request => workBatch(request, { status: 'unsupported' }));
    const composition = { v: 1, evidenceId: 'composition', sessionId: 'coach-session', turnId: 'turn', inputId: 'input',
      observedAtMs: 300, boundary: 'host_pre_dispatch', deliveryKind: 'newTurn', coverage: 'host_only',
      components: ['a', 'c'].map(source => ({ sourceId: source.repeat(64), digest: 'b'.repeat(64),
        kind: 'instructions', location: 'user', byteLength: 200, tokenCount: null, tokenizerId: null,
        cacheClass: 'unknown', overlap: 'none' })), nativePrefix: null, contextWindowTokens: null };
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: [
        { ...workContribution, sessionId: 'coach-session', projectKey: 'project', source: 'runtime' },
      ] });
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v2/sessions/coach-session') return Response.json({ session: coachSession });
      if (request.path === '/v1/sessions/coach-session/turns') return Response.json({ v: 1, sessionId: 'coach-session', updatedAt: 900, turns: [] });
      if (request.path === '/v1/sessions/coach-session/messages') {
        // Real role filtering is the HTTP boundary: a user-only read cannot see host events.
        const admitted = request.url.searchParams.get('roles')?.split(',').includes('event');
        return Response.json({ messages: admitted ? [{ id: 'composition-row', seq: 1, localId: null, createdAt: 300,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: 'composition-event',
            data: { type: 'prompt-composition', composition } } } },
        }, { id: 'accepted-row', seq: 2, localId: 'input', createdAt: 300,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private aggregate prompt' } } },
          deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
            v: 1, acceptedAtMs: 500, delivery: { kind: 'steer', turnId: 'turn' },
          } } },
        }, { id: 'foreign-turn-row', seq: 3, localId: 'foreign-input', createdAt: 400,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private foreign turn' } } },
          deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
            v: 1, acceptedAtMs: 600, delivery: { kind: 'steer', turnId: 'foreign-turn' },
          } } },
        }, ...(request.url.searchParams.get('roles')?.split(',').includes('agent') ? [{ id: 'mixed-claude-tool', seq: 4,
          localId: null, createdAt: 450, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: {
            type: 'output', data: { type: 'assistant', message: { role: 'assistant', content: [
              { type: 'text', text: 'private mixed Claude prose' },
              { type: 'tool_use', id: 'mixed-read', name: 'Read', input: { file_path: '/private/mixed' } },
            ] } },
          } } } }] : [])] : [], hasMore: false });
      }
      const kvResponse = await suppressionsKv.handleFetch(request.url, { method: request.method,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
      if (kvResponse && holdSuppressionRead && request.path === '/v1/kv/bulk'
        && request.body !== null && typeof request.body === 'object' && 'keys' in request.body
        && Array.isArray(request.body.keys) && request.body.keys.includes(USAGE_COACH_SUPPRESSIONS_KV_KEY)) {
        holdSuppressionRead = false;
        suppressionReadStarted.resolve();
        await releaseSuppressionRead.promise;
      }
      return kvResponse ?? undefined;
    });
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({
      ...filters, period: { startMs: 0, endMs: 1000 },
    })] });
    expect(result.results[0]).toHaveProperty('coach.findings', expect.arrayContaining([
      expect.objectContaining({ detectorId: 'duplicated_instructions', coverage: 'partial' }),
    ]));
    expect(result.results[0]).toHaveProperty('coach.evaluations', expect.arrayContaining([
      expect.objectContaining({ detectorId: 'cache_busting_prompt_changes', status: 'insufficient_evidence' }),
    ]));
    expect(JSON.stringify(result)).not.toContain('Opened');
    expect(JSON.stringify(result)).not.toContain('private aggregate prompt');
    expect(JSON.stringify(result)).not.toContain('private foreign turn');
    expect(JSON.stringify(result)).not.toContain('private mixed Claude prose');
    expect(JSON.stringify(result)).not.toContain('/private/mixed');
    if (Object.keys(filters).length === 0) expect(result.results[0]?.howYouWork?.autopsy?.events)
      .toContainEqual({ evidenceId: 'mixed-read', sessionId: 'coach-session', turnId: null, observedAtMs: 450,
        kind: 'read', method: 'tool_classification' });
    expect(result.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: Object.keys(filters).length ? 1 : 2 });
    const finding = result.results[0]?.coach?.findings.find(row => row.detectorId === 'duplicated_instructions');
    expect(finding).toMatchObject({ remedy: { kind: 'prepared_session', input: {
      executionTarget: { serverId: captured.accountLifetime.scope.serverId, machineId: 'machine' },
      directory: { kind: 'path', path: '/workspace/project' },
    } }, action: { actionId: 'usage.coach.apply' } });
    if (!finding) throw new Error('Expected witnessed Coach finding');
    await createUiCoachSuppressionPort(captured).edit({ evidenceKey: finding.evidenceKey, dismissed: true });
    const reread = await readUiUsageQueryBatch(captured, { queries: [result.results[0]!.requestedQuery] });
    expect(reread.results[0]?.coach?.findings.find(row => row.evidenceKey === finding.evidenceKey)?.state.dismissed).toBe(true);
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [result.results[0]!.requestedQuery] }) });
    const release = entry.subscribe(() => {}, true);
    const sibling = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [result.results[0]!.requestedQuery,
        normalizeUsageQuery({ ...result.results[0]!.requestedQuery, metric: 'cost' })] }) });
    const releaseSibling = sibling.subscribe(() => {}, true);
    try {
      await entry.refresh();
      await sibling.refresh({ supersede: false });
      await flushHookEffects({ cycles: 30 });
      const mountedFinding = () => {
        const content = entry.getSnapshot().value;
        return content ? decodeUsageQueryResource(content).results[0]?.coach?.findings
          .find(row => row.evidenceKey === finding.evidenceKey) : undefined;
      };
      try {
        await expect.poll(() => mountedFinding()?.state.dismissed).toBe(true);
      } catch (error) {
        const content = entry.getSnapshot().value;
        const slice = content ? decodeUsageQueryResource(content).results[0] : undefined;
        throw new Error(JSON.stringify({ pending: entry.getSnapshot().pending,
          coach: slice?.coach, sources: slice?.sources }), { cause: error });
      }
      const staticQueries = [normalizeUsageQuery({ ...result.results[0]!.requestedQuery, metric: 'cost' }), result.results[0]!.requestedQuery];
      const staticEntry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
        input: projectNativeJsonValueForTransport({ queries: staticQueries }) });
      await staticEntry.refresh({ supersede: false });
      expect(decodeUsageQueryResource(staticEntry.getSnapshot().value!).results[1]?.coach?.findings
        .find(row => row.evidenceKey === finding.evidenceKey)?.state.dismissed).toBe(true);
      const workTargetReads = () => home!.httpRequests.filter(request => request.path === '/v2/sessions/read-batch'
        && SessionReadBatchRequestV1Schema.safeParse(request.body).data?.includeTurns === false).length;
      const workTargetReadsBeforeOlderRead = workTargetReads();
      holdSuppressionRead = true;
      olderRead = readUiUsageQueryBatch(captured, { queries: [result.results[0]!.requestedQuery] });
      await suppressionReadStarted.promise;
      // The intentionally older read has one independent Work target request.
      // Count it before verifying that the suppression edits add no reads.
      await expect.poll(workTargetReads).toBe(workTargetReadsBeforeOlderRead + 1);
      await flushHookEffects({ cycles: 30 });
      const beforeProjection = home!.httpRequests.length;
      const projectionAccountingReads = () => home!.httpRequests.slice(beforeProjection)
        .filter(request => request.path === '/v2/usage/query' || request.path === '/v2/usage/query-batch');
      const preferencesBeforeRestore = storage.getState().settings.usageCoachPreferencesV1;
      const sourceReadsBeforeRestore = () => home!.httpRequests.filter(request => /^\/v[12]\/sessions\//.test(request.path)
        || request.path.startsWith('/v4/connect/') || request.path.startsWith('/v2/usage/')).length;
      const sourceReads = sourceReadsBeforeRestore();
      const suppressionReads = () => home!.requests.filter(request => {
        const body = request.body;
        return request.path === '/v1/kv/bulk' && body !== null && typeof body === 'object' && 'keys' in body
          && Array.isArray(body.keys) && body.keys.includes(USAGE_COACH_SUPPRESSIONS_KV_KEY);
      }).length;
      const suppressionReadsBefore = suppressionReads();
      const siblingFinding = () => {
        const content = sibling.getSnapshot().value;
        return content ? decodeUsageQueryResource(content).results.find(slice => slice.key === result.results[0]!.key)?.coach?.findings
          .find(row => row.evidenceKey === finding.evidenceKey) : undefined;
      };
      await expect.poll(() => siblingFinding()?.state.dismissed).toBe(true);
      await expect.poll(() => entry.getSnapshot().subscription).toBe('live');
      await expect.poll(() => sibling.getSnapshot().subscription).toBe('live');
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      await expect.poll(() => sibling.getSnapshot().pending).toBe('idle');
      const account = await captureLazyActionAccountContext(captured.accountLifetime.scope.serverId);
      try {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
        const query = result.results[0]!.requestedQuery;
        const actionContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        const restore = await executor.execute('usage.coach.dismiss', { query, evidenceKey: finding.evidenceKey, dismissed: false }, actionContext);
        expect(restore.ok, JSON.stringify(restore)).toBe(true);
        const restored = await executor.execute('usage.query', { queries: [query] }, actionContext);
        expect(restored.ok, JSON.stringify(restored)).toBe(true);
        expect.soft(UsageQueryBatchResultSchema.parse(restored.ok ? restored.result : undefined).results[0]?.coach?.findings
          .find(row => row.evidenceKey === finding.evidenceKey)?.state.dismissed).toBe(false);
        const staticRestored = await executor.execute('usage.query', { queries: staticQueries }, actionContext);
        expect(staticRestored.ok, JSON.stringify(staticRestored)).toBe(true);
        expect.soft(UsageQueryBatchResultSchema.parse(staticRestored.ok ? staticRestored.result : undefined).results[1]?.coach?.findings
          .find(row => row.evidenceKey === finding.evidenceKey)?.state.dismissed).toBe(false);
        await expect.poll(() => [mountedFinding()?.state.dismissed, siblingFinding()?.state.dismissed]).toEqual([false, false]);
        releaseSuppressionRead.resolve();
        expect.soft((await olderRead).results[0]?.coach?.findings.find(row => row.evidenceKey === finding.evidenceKey)?.state.dismissed,
          'an older source read cannot replace the acknowledged suppression operand').toBe(false);
        const untilMs = Date.now() + 60_000;
        const snooze = await executor.execute('usage.coach.snooze', { query, evidenceKey: finding.evidenceKey, untilMs }, actionContext);
        expect(snooze.ok, JSON.stringify(snooze)).toBe(true);
        const snoozed = await executor.execute('usage.query', { queries: [query] }, actionContext);
        expect(snoozed.ok, JSON.stringify(snoozed)).toBe(true);
        expect(UsageQueryBatchResultSchema.parse(snoozed.ok ? snoozed.result : undefined).results[0]?.coach?.findings
          .find(row => row.evidenceKey === finding.evidenceKey)?.state.snoozedUntilMs).toBe(untilMs);
        await expect.poll(() => siblingFinding()?.state.snoozedUntilMs).toBe(untilMs);
        const unsnooze = await executor.execute('usage.coach.snooze', { query, evidenceKey: finding.evidenceKey, untilMs: null }, actionContext);
        expect(unsnooze.ok, JSON.stringify(unsnooze)).toBe(true);
        const unsnoozed = await executor.execute('usage.query', { queries: [query] }, actionContext);
        expect(unsnoozed.ok, JSON.stringify(unsnoozed)).toBe(true);
        expect(UsageQueryBatchResultSchema.parse(unsnoozed.ok ? unsnoozed.result : undefined).results[0]?.coach?.findings
          .find(row => row.evidenceKey === finding.evidenceKey)?.state).toMatchObject({ dismissed: false, snoozedUntilMs: null });
        await expect.poll(() => siblingFinding()?.state.snoozedUntilMs).toBe(null);
        expect(suppressionReads(), 'each edit reads once at admission; Resource projections consume the acknowledged value').toBe(suppressionReadsBefore + 3);
      } finally { account.dispose(); }
      const changes: ApiChangeEntry[] = [{ kind: 'kv', entityId: USAGE_COACH_SUPPRESSIONS_KV_KEY, cursor: 2, changedAt: 1 }];
      const planned = planSyncActionsFromChanges(changes, { afterCursor: 1, isSessionListMember: () => false });
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, changes.map(change => change.entityId), {
        changeKinds: ['kv'], usageQueryAffects: plannedChangesAffectUsageQuery(planned),
        usageAccountingAffects: plannedChangesAffectUsageAccounting(planned),
      });
      await flushHookEffects({ cycles: 30 });
      await expect.poll(() => mountedFinding()?.state.dismissed).toBe(false);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      await expect.poll(() => sibling.getSnapshot().pending).toBe('idle');
      expect(sourceReadsBeforeRestore()).toBe(sourceReads);
      expect(storage.getState().settings.usageCoachPreferencesV1).toEqual(preferencesBeforeRestore);
      expect(projectionAccountingReads(), 'restoring a finding reprojects admitted facts without reacquiring accounting').toEqual([]);
      const preferenceAccount = await captureLazyActionAccountContext(captured.accountLifetime.scope.serverId);
      try {
        const preferenceExecutor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(preferenceAccount) }));
        for (const disabled of [true, false]) {
          storage.getState().applySettingsLocal({ usageCoachPreferencesV1: {
            ...preferencesBeforeRestore, disabledChecks: disabled ? ['duplicated_instructions'] : preferencesBeforeRestore.disabledChecks,
          } });
          for (const queries of [[result.results[0]!.requestedQuery], staticQueries]) {
            const answer = await preferenceExecutor.execute('usage.query', { queries },
              { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
            expect(answer.ok, JSON.stringify(answer)).toBe(true);
            expect(UsageQueryBatchResultSchema.parse(answer.ok ? answer.result : undefined).results
              .find(slice => slice.key === result.results[0]!.key)?.coach?.evaluations
              .find(row => row.detectorId === 'duplicated_instructions')?.status).toBe(disabled ? 'disabled' : 'finding');
          }
          await expect.poll(() => mountedFinding()?.state.dismissed).toBe(disabled ? undefined : false);
          await expect.poll(() => siblingFinding()?.state.dismissed).toBe(disabled ? undefined : false);
          await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
          await expect.poll(() => sibling.getSnapshot().pending).toBe('idle');
        }
      } finally { preferenceAccount.dispose(); }
      expect(projectionAccountingReads(), 'changing Coach preferences must not acquire accounting').toEqual([]);
      expect(sourceReadsBeforeRestore(), 'Coach preference projections retain admitted private evidence and quota').toBe(sourceReads);
      const privateReads = () => sessionRequests().filter(request => /^\/v[12]\/sessions\//.test(request.path)).length;
      const privateBefore = privateReads();
      const slice = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      const admittedPeriod = slice().coach?.period;
      const admittedAsOf = slice().sources;
      storage.getState().applySettingsLocal({ usageNightHoursV1: { startHour: 23, endHour: 7 } });
      await expect.poll(() => slice().howYouWork?.nightShift?.startHour).toBe(23);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      storage.getState().applySettingsLocal({ usageNightHoursV1: null });
      await expect.poll(() => slice().howYouWork?.nightShift).toBeNull();
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(projectionAccountingReads(), 'Night-hour edits and clearing reproject admitted A').toEqual([]);
      expect(privateReads(), 'Presentation changes do not reacquire private Session evidence').toBe(privateBefore);
      expect(slice().coach?.period).toEqual(admittedPeriod);
      expect(slice().sources).toEqual(admittedAsOf);
      const beforeAuthority = home!.requests.filter(request => request.path === '/v2/usage/query').length;
      const { invalidateAccountEncryptionModeCache } = await import('./apiAccountEncryptionMode');
      invalidateAccountEncryptionModeCache({ serverId: captured.accountLifetime.scope.serverId });
      storage.getState().applySettingsLocal({ usageNightHoursV1: { startHour: 21, endHour: 6 } });
      await expect.poll(() => home!.requests.filter(request => request.path === '/v2/usage/query').length).toBeGreaterThan(beforeAuthority);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(privateReads(), 'Authority withdrawal still reacquires Session admission').toBeGreaterThan(privateBefore);
      releaseSibling();
      release();
      await staticEntry.refresh({ supersede: false });
      const closedRequests = home!.httpRequests.length;
      const closedAccount = await captureLazyActionAccountContext(captured.accountLifetime.scope.serverId);
      try {
        const closedExecutor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(closedAccount) }));
        for (const disabled of [true, false]) {
          storage.getState().applySettingsLocal({ usageCoachPreferencesV1: {
            ...preferencesBeforeRestore, disabledChecks: disabled ? ['duplicated_instructions'] : preferencesBeforeRestore.disabledChecks,
          } });
          const answer = await closedExecutor.execute('usage.query', { queries: staticQueries },
            { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
          expect(answer.ok, JSON.stringify(answer)).toBe(true);
          expect.soft(UsageQueryBatchResultSchema.parse(answer.ok ? answer.result : undefined).results
            .find(row => row.key === result.results[0]!.key)?.coach?.evaluations
            .find(row => row.detectorId === 'duplicated_instructions')?.status).toBe(disabled ? 'disabled' : 'finding');
        }
      } finally { closedAccount.dispose(); }
      expect(home!.httpRequests.length, 'closed Action preference admission reprojects without HTTP').toBe(closedRequests);
    } finally {
      releaseSuppressionRead.resolve();
      if (olderRead) await Promise.allSettled([olderRead]);
      releaseSibling(); release();
    }
  });
  it('keeps a failed pinned slice independent from available accounting in the same page batch', async () => {
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const body = request.body;
      const filtered = body && typeof body === 'object' && 'filters' in body && body.filters
        && typeof body.filters === 'object' && 'machineIds' in body.filters;
      return filtered ? Response.json({ error: 'refused' }, { status: 400 }) : Response.json(value);
    });
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({}), normalizeUsageQuery({ machines: ['bad'] })] });
    const available = result.results.find(slice => slice.requestedQuery.machines.length === 0);
    const failed = result.results.find(slice => slice.requestedQuery.machines.includes('bad'));
    expect(available?.accounting).toMatchObject(value);
    expect(failed?.accounting).toBeUndefined();
    expect(failed?.sources).toContainEqual({ source: 'accounting', status: 'error', errorCode: 'usage_query_failed' });
  });

  it.each([true, false])('respects a denied transcript capability for explicit Session selection %s', async explicit => {
    const deniedAccess = createSessionAccessFixture('view', { readTranscript: false });
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: [
        { ...workContribution, sessionId: 'denied-session' },
      ] });
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v1/sessions/denied-session/turns') return Response.json({ v: 1, sessionId: 'denied-session', updatedAt: 900, turns: [] });
      if (request.path === '/v2/sessions/denied-session') return Response.json({ session: {
        ...ownerSessionAccess,
        effectiveAccess: { v: 1, level: deniedAccess.level, sources: [{ kind: 'direct', shareId: 'denied-share' }],
          capabilities: deniedAccess.capabilities },
        id: 'denied-session', createdAt: 1, updatedAt: 900, seq: 2, active: true, activeAt: 900,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ name: 'Denied' }), agentStateVersion: 1,
        agentState: JSON.stringify({ completedRequests: { request: { tool: 'Bash', arguments: {},
          turnId: 'turn', createdAt: 200, completedAt: 400, status: 'approved' } } }), share: null,
      } });
      if (request.path === '/v1/sessions/denied-session/messages') return Response.json({ messages: [{
        id: 'accepted-row', seq: 2, localId: 'accepted-input', createdAt: 300,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'denied private input' } } },
        deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
          v: 1, acceptedAtMs: 500, delivery: { kind: 'steer', turnId: 'turn' },
        } } },
      }], hasMore: false });
      return undefined;
    });
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({
      ...(explicit ? { session: 'denied-session' } : {}), period: { startMs: 0, endMs: 1000 },
    })] });
    expect(result.results[0]?.accounting).toMatchObject(value);
    expect(result.results[0]?.howYouWork).toMatchObject({ detailStatus: 'unknown', intervals: null,
      inputs: null, permissions: null });
    expect(sessionRequests().some(request => request.path === '/v1/sessions/denied-session/messages')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('denied private input');
  });

  it('opens retained accepted delivery through the selected Session reader and keeps unseen history partial', async () => {
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v2/sessions/fresh-session') return Response.json({ session: {
        ...ownerSessionAccess,
        id: 'fresh-session', createdAt: 1, updatedAt: 900, seq: 2, active: true, activeAt: 900,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ name: 'Opened' }),
        agentStateVersion: 1, agentState: null, share: null,
      } });
      if (request.path === '/v1/sessions/fresh-session/turns') return Response.json({ v: 1, sessionId: 'fresh-session', updatedAt: 900, turns: [] });
      if (request.path === '/v1/sessions/fresh-session/messages') return Response.json({ messages: [{
        id: 'accepted-row', seq: 2, localId: 'accepted-input', createdAt: 300,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private prompt text' } } },
        deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
          v: 1, acceptedAtMs: 500, delivery: { kind: 'steer', turnId: 'turn' },
        } } },
      }], hasMore: true, nextBeforeSeq: 2 });
      return undefined;
    });
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({
      session: 'fresh-session', period: { startMs: 0, endMs: 1000 },
    })] });
    expect(result.results[0]?.howYouWork).toMatchObject({
      detailStatus: 'partial', inputs: { acceptedCount: 1, steeringCount: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('private prompt text');
  });

  it.each([503, 403, 404])('retains fresh authorized Session facts only for ordinary input-page failure %s', async status => {
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: [
        { ...workContribution, sessionId: 'failed-inputs' },
      ] });
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v2/sessions/failed-inputs') return Response.json({ session: {
        ...ownerSessionAccess,
        id: 'failed-inputs', createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ name: 'Opened' }), agentStateVersion: 1,
        agentState: JSON.stringify({ completedRequests: { request: { tool: 'Bash',
          arguments: { private: 'fresh-private-argument' }, turnId: 'turn', createdAt: 300, completedAt: 500,
          status: 'approved', answeringClientCategory: 'ios' } } }), share: null,
      } });
      if (request.path === '/v1/sessions/failed-inputs/turns') return Response.json({ v: 1,
        sessionId: 'failed-inputs', updatedAt: 900, turns: [{ turnId: 'turn', agentId: 'codex',
          status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 }] });
      if (request.path === '/v1/sessions/failed-inputs/messages') return Response.json({ error: 'unavailable' }, { status });
      return undefined;
    });
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({
      period: { startMs: 0, endMs: 1000 },
    })] });
    expect(result.results[0]?.howYouWork).toMatchObject(status === 503 ? {
      detailStatus: 'partial', intervals: { agentTimeMs: 600 }, inputs: null,
      permissions: { pairedDecisionCount: 1, decisionLatencyMs: 200, byAnsweringClient: { ios: 1 } },
    } : { detailStatus: 'unknown', intervals: null, inputs: null, permissions: null });
    expect(JSON.stringify(result)).not.toContain('fresh-private-argument');
  });

  it('distinguishes unopened nonempty input pages from observed empty pages and retains opened subsets', async () => {
    let pageKind: 'unopened' | 'legacy' | 'empty' | 'partial' = 'unopened';
    let seq = 3;
    const unopenedRows = [
      { id: 'mode-mismatch', seq: 1, localId: null, createdAt: 100, content: { t: 'encrypted', c: 'unavailable' } },
      { id: 'invalid-record', seq: 2, localId: null, createdAt: 200, content: { t: 'plain', v: { unavailable: true } } },
    ];
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v2/sessions/page-session') return Response.json({ session: {
        ...ownerSessionAccess,
        id: 'page-session', createdAt: 1, updatedAt: 900, seq, active: true, activeAt: 900,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ name: 'Opened' }), agentStateVersion: 1,
        agentState: JSON.stringify({ completedRequests: { request: { tool: 'Bash', arguments: {},
          turnId: 'turn', createdAt: 200, completedAt: 400, status: 'approved' } } }), share: null,
      } });
      if (request.path === '/v1/sessions/page-session/turns') return Response.json({ v: 1, sessionId: 'page-session', updatedAt: 900, turns: [] });
      if (request.path === '/v1/sessions/page-session/messages') return Response.json({ messages:
        pageKind === 'empty' ? [] : pageKind === 'unopened' ? unopenedRows : pageKind === 'legacy' ? [{
          id: 'legacy-row', seq: 3, localId: 'legacy-input', createdAt: 500,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private legacy input' } } },
        }] : [...unopenedRows, {
          id: 'opened-row', seq: 3, localId: 'accepted-input', createdAt: 500,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private input' } } },
          deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
            v: 1, acceptedAtMs: 500, delivery: { kind: 'steer', turnId: 'turn' },
          } } },
        }], hasMore: false });
      return undefined;
    });
    const input = { queries: [normalizeUsageQuery({ session: 'page-session', period: { startMs: 0, endMs: 1000 } })] };
    const unopened = await readUiUsageQueryBatch(captured, input);
    expect(unopened.results[0]?.howYouWork).toMatchObject({ detailStatus: 'partial', inputs: null,
      permissions: { pairedDecisionCount: 1, decisionLatencyMs: 200 } });
    pageKind = 'legacy';
    seq++;
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['page-session'], { changeKinds: ['session'] });
    const legacy = await readUiUsageQueryBatch(captured, input);
    expect(legacy.results[0]?.howYouWork).toMatchObject({ detailStatus: 'partial', inputs: null,
      permissions: { pairedDecisionCount: 1, decisionLatencyMs: 200 } });
    expect(JSON.stringify(legacy)).not.toContain('private legacy input');
    pageKind = 'empty';
    seq++;
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['page-session'], { changeKinds: ['session'] });
    const empty = await readUiUsageQueryBatch(captured, input);
    expect(empty.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 0, steeringCount: 0 });
    pageKind = 'partial';
    seq++;
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['page-session'], { changeKinds: ['session'] });
    const partial = await readUiUsageQueryBatch(captured, input);
    expect(partial.results[0]?.howYouWork).toMatchObject({ detailStatus: 'partial',
      inputs: { acceptedCount: 1, steeringCount: 1 }, permissions: { pairedDecisionCount: 1 } });
    expect(JSON.stringify(partial)).not.toContain('private input');
  });

  it.each([404, 403, 410].flatMap(status => ['summary', 'messages'].map(phase => ({ status, phase }))))(
    'settles read-batch HTTP $status ($phase) across demand wakes and reopens at supported recovery boundaries', async ({ status, phase }) => {
    const ids = ['terminal-one', 'terminal-two', 'terminal-three'];
    let failed = true;
    const captured = await context(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === USAGE_SESSION_EVIDENCE_PATH && failed
        && (phase === 'summary' || UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => demand.query.includeTranscriptEvidence))) {
        return Response.json({ error: 'refused' }, { status });
      }
      for (const id of ids) {
        if (request.path === `/v2/sessions/${id}`) return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: storage.getState().sessions[id]?.seq ?? 1 }) });
        if (request.path === `/v1/sessions/${id}/turns`) return Response.json({ v: 1, sessionId: id, updatedAt: 900,
          turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 }] });
        if (request.path === `/v1/sessions/${id}/messages`) return Response.json({ messages: [], hasMore: false });
      }
      return undefined;
    });
    storage.setState({ sessions: Object.fromEntries(ids.map(id => [id, createSessionFixture({ id,
      serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' })])) });
    const queries = ids.map(session => normalizeUsageQuery({ session, period: { startMs: 0, endMs: 1000 },
      includeWorkEvidence: false, includeTranscriptEvidence: phase === 'messages' }));
    const store = getUsageQueryResourceStore(captured);
    const entries = queries.map(query => store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) }));
    const releases: Array<() => void> = [];
    const reads = () => home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH
      && UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => demand.query.includeTranscriptEvidence === (phase === 'messages'))).length;
    try {
      for (const entry of entries) {
        releases.push(entry.subscribe(() => {}, true));
        await expect.poll(() => entry.getSnapshot().pending === 'idle' && entry.getSnapshot().value !== undefined).toBe(true);
      }
      expect(reads(), 'N independent failed reads issue exactly N physical batches').toBe(ids.length);
      const sibling = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [
        normalizeUsageQuery({ ...queries[0], granularity: 'hour' }),
      ] }) });
      releases.push(sibling.subscribe(() => {}, true));
      for (let wake = 0; wake < 4; wake++) {
        invalidateUsageQueryResources(captured.accountLifetime);
        await flushHookEffects({ cycles: 30 });
        await expect.poll(() => [...entries, sibling].every(entry => entry.getSnapshot().pending === 'idle'
          && entry.getSnapshot().value !== undefined)).toBe(true);
      }
      expect(reads(), 'settled failures survive automatic demand and presentation-only siblings reuse the same admission').toBe(ids.length);
      for (const entry of [...entries, sibling]) {
        const slice = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
        expect(slice.accounting?.totals.tokens.total).toBe(15);
        expect(slice.howYouWork?.intervals?.agentTimeMs ?? null).toBeNull();
        if (status === 404) expect(slice.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work',
          errorCode: 'update_required', updateRequired: expect.objectContaining({ component: 'server', reason: 'usage_session_evidence_unsupported' }) }));
      }
      await entries[0]!.refresh();
      const lastingRefusal = status === 403 || status === 404;
      expect(reads(), 'Retry reopens retryable failures while lasting coverage waits for changed Session inputs')
        .toBe(ids.length + (lastingRefusal ? 0 : 1));
      if (lastingRefusal) {
        storage.getState().applySessions([{ ...storage.getState().sessions[ids[0]!]!, seq: 2 }]);
        await expect.poll(reads).toBe(ids.length + 1);
        await expect.poll(() => entries[0]!.getSnapshot().pending).toBe('idle');
      }
      storage.getState().applySessions([{ ...storage.getState().sessions[ids[1]!]!, seq: 2 }]);
      await flushHookEffects({ cycles: 30 });
      await expect.poll(reads).toBe(ids.length + 2);
      await expect.poll(() => entries.every(entry => entry.getSnapshot().pending === 'idle')).toBe(true);
      expect(reads(), 'a real Session advance reopens only the changed input').toBe(ids.length + 2);
      failed = false;
      if (lastingRefusal) {
        storage.getState().applySessions([{ ...storage.getState().sessions[ids[0]!]!, seq: 3 }]);
        await expect.poll(reads).toBe(ids.length + 3);
        await expect.poll(() => entries[0]!.getSnapshot().pending).toBe('idle');
      } else await entries[0]!.refresh();
      expect(reads()).toBe(ids.length + 3);
      const recovered = decodeUsageQueryResource(entries[0]!.getSnapshot().value!).results[0]!;
      expect(recovered.howYouWork?.intervals?.agentTimeMs).toBe(800);
      expect(recovered.sources.every(source => source.updateRequired === undefined)).toBe(true);
    } finally { for (const release of releases) release(); }
  });

  it('reports that private detail needs a newer server only for a missing Usage evidence route and clears it on recovery', async () => {
    let missingRoute = true;
    let missingSession = false;
    const captured = await context(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === USAGE_SESSION_EVIDENCE_PATH && missingRoute) return Response.json({ error: 'not_found' }, { status: 404 });
      if (request.path === '/v2/sessions/upgrade-session') return missingSession
        ? Response.json({ error: 'not_found' }, { status: 404 })
        : Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'upgrade-session' }) });
      if (request.path === '/v1/sessions/upgrade-session/turns') return Response.json({ v: 1, sessionId: 'upgrade-session', updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 }] });
      if (request.path === '/v1/sessions/upgrade-session/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: {
      'upgrade-session': createSessionFixture({ id: 'upgrade-session', serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' }),
    } });
    const input = { queries: [normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false,
      includeTranscriptEvidence: false })] };
    const unsupported = await readUiUsageQueryBatch(captured, input);
    expect(unsupported.results[0]?.accounting?.totals.tokens.total).toBe(15);
    expect(unsupported.results[0]?.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work',
      errorCode: 'update_required', updateRequired: { kind: 'update_required', operation: 'usage.query', component: 'server',
        reason: 'usage_session_evidence_unsupported' } }));
    expect(home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)).toHaveLength(1);
    expect(home!.requests.some(request => request.path === '/v2/sessions/upgrade-session')).toBe(false);
    missingRoute = false;
    missingSession = true;
    const retry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(input) });
    const unavailable = decodeUsageQueryResource((await retry.refresh()).value!);
    expect(unavailable.results[0]?.sources.every(source => source.updateRequired === undefined)).toBe(true);
    missingSession = false;
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['upgrade-session'], { changeKinds: ['session'], usageQueryAffects: true });
    const recovered = await readUiUsageQueryBatch(captured, input, undefined, unavailable);
    expect(recovered.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(800);
    expect(recovered.results[0]?.sources.every(source => source.updateRequired === undefined)).toBe(true);
  });

  it.each(['detail', 'turns', 'messages'] as const)('preserves a Session %s update requirement alongside readable sibling evidence', async part => {
    const updateRequired = { kind: 'update_required', operation: 'session.detail', component: 'client', reason: 'access_projection_version_unsupported' };
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      const failedPath = part === 'detail' ? '/v2/sessions/failed' : `/v1/sessions/failed/${part}`;
      if (request.path === failedPath) return Response.json(updateRequired, { status: 426 });
      for (const id of ['failed', 'readable']) {
        if (request.path === `/v2/sessions/${id}`) return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id }) });
        if (request.path === `/v1/sessions/${id}/turns`) return Response.json({ v: 1, sessionId: id, updatedAt: 900,
          turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 }] });
        if (request.path === `/v1/sessions/${id}/messages`) return Response.json({ messages: [], hasMore: false });
      }
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: Object.fromEntries(['failed', 'readable'].map(id => [id,
      createSessionFixture({ id, serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' })])) });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false });
    const sibling = normalizeUsageQuery({ ...query, session: 'readable' });
    const result = await readUiUsageQueryBatch(captured, { queries: [query, sibling] });
    const aggregate = result.results.find(result => result.key === getUsageQueryKey(query));
    const readable = result.results.find(result => result.key === getUsageQueryKey(sibling));
    expect(aggregate?.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', errorCode: 'update_required', updateRequired }));
    expect(aggregate?.accounting?.totals.tokens.total).toBe(15);
    expect(aggregate?.howYouWork?.intervals?.agentTimeMs).toBe(800);
    expect(readable?.sources.every(source => source.updateRequired === undefined)).toBe(true);
    expect(readable?.howYouWork?.intervals?.agentTimeMs).toBe(800);
    expect(home!.requests.some(request => request.path === '/v2/sessions/read-batch'
      || /^\/v[12]\/sessions\/(failed|readable)(\/|$)/.test(request.path)
        && !(request.method === 'PUT' && /^\/v2\/sessions\/(failed|readable)\/system-records$/.test(request.path)))).toBe(false);
  });

  it('excludes loaded Session candidates while the storage projection belongs to another Account', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    storage.setState({ profileScope: { ...captured.accountLifetime.scope, accountId: 'foreign-account' }, sessions: {
      foreign: createSessionFixture({ id: 'foreign', serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain',
        sessionTurns: { v: 1, sessionId: 'foreign', updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 },
        ] } }),
    } });
    await expect(readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } })] }))
      .rejects.toMatchObject({ code: 'stale_surface' });
    expect(sessionRequests().some(request => request.path === '/v2/sessions/foreign')).toBe(false);
  });

  it('projects only the opened active Account subset as partial private evidence without exporting request arguments', async () => {
    const turns = { v: 1, sessionId: 'loaded-session', updatedAt: 900, turns: [
      { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 },
    ] };
    const agentState = { completedRequests: { request: {
      tool: 'Bash', arguments: { secret: 'never-export-this' }, turnId: 'turn',
      createdAt: 300, completedAt: 500, status: 'approved', answeringClientCategory: 'ios',
    } } };
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path === '/v2/sessions/loaded-session') return Response.json({ session: { ...ownerSessionAccess,
        id: 'loaded-session', createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
        metadataVersion: 1, metadata: JSON.stringify({ name: 'Opened' }), agentStateVersion: 1, agentState: JSON.stringify(agentState), share: null,
      } });
      if (request.path === '/v1/sessions/loaded-session/turns') return Response.json(turns);
      if (request.path === '/v1/sessions/loaded-session/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.getState().applySessions([{
      id: 'loaded-session', serverId: captured.accountLifetime.scope.serverId,
      seq: 1, createdAt: 1, updatedAt: 900, active: true, activeAt: 900,
      encryptionMode: 'plain', metadata: null, metadataVersion: 0, agentStateVersion: 1,
      thinking: false, thinkingAt: 900,
      sessionTurns: { v: 1, sessionId: 'loaded-session', updatedAt: 900, turns: [
        { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 },
      ] },
      agentState: { completedRequests: { request: {
        tool: 'Bash', arguments: { secret: 'never-export-this' }, turnId: 'turn',
        createdAt: 300, completedAt: 500, status: 'approved', answeringClientCategory: 'ios',
      } } },
    }]);
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 } })] });
    expect(result.results[0]?.howYouWork).toMatchObject({
      detailStatus: 'partial', intervals: { agentTimeMs: 600 },
      permissions: { pairedDecisionCount: 1, decisionLatencyMs: 200, byAnsweringClient: { ios: 1 } },
    });
    expect(JSON.stringify(result)).not.toContain('never-export-this');
  });

  it.each([
    { status: 403, retainQuery: true, batchFailure: false },
    { status: 503, retainQuery: true, batchFailure: false },
    { status: 503, retainQuery: false, batchFailure: false },
    { status: 503, retainQuery: true, batchFailure: true },
    { status: 503, retainQuery: false, batchFailure: true },
  ])('keeps admitted Agent-time partial after refusal and retains stale facts after ordinary failure ($status, retained query: $retainQuery, batch failure: $batchFailure)', async ({ status, retainQuery, batchFailure }) => {
    let failing = false;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (failing && batchFailure && request.path === USAGE_SESSION_EVIDENCE_PATH) {
        return Response.json({ error: 'unavailable' }, { status: 503 });
      }
      const sessionId = request.path === '/v2/sessions/shared' ? 'shared'
        : request.path === '/v2/sessions/other' ? 'other' : null;
      if (sessionId) return failing && sessionId === 'shared'
        ? Response.json({ error: 'unavailable' }, { status })
        : Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId,
          createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
          metadataVersion: 1, agentStateVersion: 1 }) });
      if (request.path === '/v1/sessions/shared/turns' || request.path === '/v1/sessions/other/turns') {
        const id = request.path.split('/')[3]!;
        return Response.json({ v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100,
            terminalAt: id === 'shared' ? 400 : 700, updatedAt: 900 },
        ] });
      }
      if (request.path.endsWith('/messages')) return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: Object.fromEntries(
      ['shared', 'other'].map(id => [id, createSessionFixture({ id,
        serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' })]),
    ) });
    const input = { queries: [normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false })] };
    const settled = await readUiUsageQueryBatch(captured, input);
    expect(settled.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(900);
    // Coach and How share Session input demand, but a first How query has no
    // admitted aggregate whose complete population it can retain on failure.
    const nextInput = retainQuery ? input : { queries: [normalizeUsageQuery({ ...input.queries[0], includeCoach: false })] };
    failing = true;
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['shared'], { changeKinds: ['session'], usageQueryAffects: true });
    const replacement = await readUiUsageQueryBatch(captured, nextInput, undefined, settled);
    if (batchFailure && !retainQuery) {
      expect(replacement.results[0]?.howYouWork).toMatchObject({ detailStatus: 'unknown', intervals: null });
      expect(replacement.results[0]?.sources).toContainEqual(expect.objectContaining({
        source: 'how_you_work', status: 'error', errorCode: 'http_error',
      }));
    } else if (status === 503 && retainQuery) {
      expect(replacement.results[0]?.howYouWork?.intervals, 'retain the complete admitted population, never only the surviving Session')
        .toEqual(settled.results[0]?.howYouWork?.intervals);
      expect(replacement.results[0]?.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'how_you_work', status: 'stale', errorCode: 'http_error' }),
      ]));
    } else {
      expect(replacement.results[0]?.howYouWork).toMatchObject({ detailStatus: 'partial',
        sessionCoverage: { selected: 2, admitted: 1 }, intervals: { agentTimeMs: 600,
          lanes: [{ workId: '["other","turn"]' }] },
        runLengths: { coverage: 'partial', sampleCount: 1, byAgent: [{ agentId: 'codex', durationsMs: [600] }] } });
      expect(replacement.results[0]?.sources).toContainEqual({ source: 'how_you_work:sessions', status: 'partial',
        errorCode: status === 403 ? 'forbidden' : 'http_error' });
    }
    failing = false;
    if (status === 403) publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['shared'], { changeKinds: ['session'], usageQueryAffects: true });
    const recovered = status === 403
      ? await readUiUsageQueryBatch(captured, nextInput, undefined, replacement)
      : decodeUsageQueryResource((await getUsageQueryResourceStore(captured).getEntry({
        hostRead: 'usage.query', input: projectNativeJsonValueForTransport(nextInput),
      }).refresh()).value!);
    expect(recovered.results[0]?.howYouWork?.intervals).toEqual(settled.results[0]?.howYouWork?.intervals);
    expect(recovered.results[0]?.sources.find(source => source.source === 'how_you_work')?.errorCode).toBeUndefined();
  });

  it('reuses each private Usage demand while seq is unchanged and isolates consumer retirement', async () => {
    let detailGate = createDeferred<void>();
    let permissionCompletedAt = 200;
    let sharedSeq = 1;
    const captured = await context(async request => {
      if (request.path === '/v2/usage/query') {
        const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
        const contributions = ['shared', 'other'].filter(id => !query.filters?.sessionIds || query.filters.sessionIds.includes(id))
          .map(id => ({ ...workContribution, id: `usage-${id}`, sessionId: id, eventCount: 1 }));
        return Response.json({ ...value, contributions, totals: { eventCount: contributions.length,
          tokens: Object.fromEntries(Object.entries(value.totals.tokens).map(([key, count]) => [key, typeof count === 'number' ? count * contributions.length : count])),
          cost: { reportedUsd: contributions.length, estimatedUsd: 0, currency: 'USD' } } });
      }
      const sessionId = request.path === '/v2/sessions/shared' ? 'shared'
        : request.path === '/v2/sessions/other' ? 'other' : null;
      if (sessionId) {
        const completedAt = permissionCompletedAt;
        const seq = sessionId === 'shared' ? sharedSeq : 1;
        if (sessionId === 'shared') await detailGate.promise;
        return Response.json({ session: { ...createPlainSessionCurrentProjectionRecordFixture({ id: sessionId,
          createdAt: 1, updatedAt: 900, seq, active: true, activeAt: 900,
          metadataVersion: 1, metadata: { path: '/repo', host: 'usage-test', name: sessionId }, agentStateVersion: seq }),
          agentState: JSON.stringify({ completedRequests: { request: {
            tool: 'Bash', arguments: {}, turnId: 'turn', createdAt: 100, completedAt, status: 'approved',
          } } }) } });
      }
      if (request.path === '/v1/sessions/shared/turns' || request.path === '/v1/sessions/other/turns') {
        const id = request.path.split('/')[3]!;
        return Response.json({ v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100,
            terminalAt: id === 'shared' ? (permissionCompletedAt === 200 ? 400 : 900) : 700, updatedAt: 900 },
        ] });
      }
      if (request.path === '/v1/sessions/shared/messages' || request.path === '/v1/sessions/other/messages') {
        return Response.json({ messages: [], hasMore: false });
      }
      return undefined;
    });
    // Home bootstrap/resume legitimately re-admits private evidence. Finish
    // that owner operation before measuring reuse under an unchanged Session.
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: Object.fromEntries(
      ['shared', 'other'].map(id => [id, createSessionFixture({ id,
        serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' })]),
    ) });
    const store = getUsageQueryResourceStore(captured);
    const broad = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({
      period: { startMs: 0, endMs: 1000 },
    })] }) });
    const pinned = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({
      period: { startMs: 0, endMs: 1000 }, session: 'shared', metric: 'cost',
    })] }) });
    // Count the real Usage HTTP admissions for the pinned demand separately
    // from the broad population, whose selected membership is different.
    const countReads = (path: string) => home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests)
      .filter(demand => path.includes('/other') ? demand.query.session === null && !demand.query.includeTranscriptEvidence
        : Array.isArray(demand.query.session) && demand.query.session.length === 1 && demand.query.session[0] === 'shared'
          && demand.query.includeTranscriptEvidence === path.endsWith('/messages')).length;
    const observedAgentTimes: (number | null)[] = [];
    const observeBroadIntervals = () => {
      const content = broad.getSnapshot().value;
      const intervals = content && decodeUsageQueryResource(content).results[0]?.howYouWork?.intervals;
      if (content) observedAgentTimes.push(intervals?.agentTimeMs ?? null);
    };
    const ready = async (entry: typeof broad) => {
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      const content = entry.getSnapshot().value;
      expect(content).toBeDefined();
      return decodeUsageQueryResource(content!).results[0]!;
    };
    let releaseBroad = broad.subscribe(() => {}, true);
    const releasePinned = pinned.subscribe(() => {}, true);
    try {
      await expect.poll(() => countReads('/v2/sessions/other')).toBe(1);
      // Both consumers expose useful accounting while private evidence for
      // their distinct selected populations is held.
      await expect.poll(() => [broad, pinned].map(entry => {
        const content = entry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.accounting?.totals.eventCount;
      })).toEqual([2, 1]);
      await flushHookEffects({ cycles: 20 });
      expect(countReads('/v2/sessions/shared')).toBe(1);
      detailGate.resolve();
      const [all, selected] = await Promise.all([ready(broad), ready(pinned)]);
      // The witnessed 100ms approval wait is subtracted from each busy lane.
      expect(all.howYouWork?.intervals?.agentTimeMs).toBe(700);
      expect(selected.howYouWork?.intervals?.agentTimeMs).toBe(200);
      expect(countReads('/v1/sessions/shared/messages')).toBe(1);

      await pinned.refresh();
      expect((await ready(pinned)).howYouWork?.intervals?.agentTimeMs).toBe(200);
      // Let the just-settled Resource drain its completion microtasks before
      // changing the evidence basis for the next, independently tested read.
      await flushHookEffects({ cycles: 20 });
      expect(countReads('/v2/sessions/shared')).toBe(1);
      expect(countReads('/v1/sessions/shared/messages')).toBe(1);

      // A changed sequence starts one new operation per demand. Detaching one
      // Resource cancels only its observation, preserving the other consumer.
      detailGate = createDeferred<void>();
      sharedSeq = 2;
      storage.setState({ sessions: { ...storage.getState().sessions,
        shared: { ...storage.getState().sessions.shared!, seq: sharedSeq } } });
      const broadRefresh = broad.refresh();
      const pinnedRefresh = pinned.refresh();
      await expect.poll(() => countReads('/v2/sessions/shared')).toBe(2);
      await expect.poll(() => [broad, pinned].every(entry => entry.getSnapshot().pending !== 'idle')).toBe(true);
      await flushHookEffects({ cycles: 20 });
      releaseBroad();
      detailGate.resolve();
      await Promise.all([broadRefresh, pinnedRefresh]);
      expect((await ready(pinned)).howYouWork?.intervals?.agentTimeMs).toBe(200);
      expect(countReads('/v2/sessions/shared')).toBe(2);
      expect(countReads('/v1/sessions/shared/messages')).toBe(2);

      // A genuine Session wake admits the next version independently while
      // the finite read already admitted at the prior version finishes.
      detailGate = createDeferred<void>();
      const staleGate = detailGate;
      sharedSeq = 3;
      storage.setState({ sessions: { ...storage.getState().sessions,
        shared: { ...storage.getState().sessions.shared!, seq: sharedSeq } } });
      releaseBroad = broad.subscribe(observeBroadIntervals, true);
      const staleRefresh = pinned.refresh();
      await expect.poll(() => countReads('/v2/sessions/shared')).toBe(3);
      detailGate = createDeferred<void>();
      sharedSeq = 4;
      storage.setState({ sessions: { ...storage.getState().sessions,
        shared: { ...storage.getState().sessions.shared!, seq: sharedSeq } } });
      permissionCompletedAt = 600;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['shared'], {
        changeKinds: ['session'], usageQueryAffects: true,
      });
      staleGate.resolve();
      // Keep replacement admission held while the earlier read and its
      // progress publications drain. It must retain the complete population.
      await flushHookEffects({ cycles: 20 });
      expect(observedAgentTimes).not.toContain(500);
      expect(observedAgentTimes, 'remounting the same query must retain witnessed intervals while newer admission is pending').not.toContain(null);
      detailGate.resolve();
      await staleRefresh;
      await expect.poll(() => {
        const content = pinned.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.howYouWork?.permissions?.decisionLatencyMs;
      }).toBe(500);
      expect(countReads('/v2/sessions/shared')).toBe(4);
      await ready(pinned);
      expect((await ready(broad)).howYouWork?.intervals?.agentTimeMs).toBe(800);
      // Both admitted reads retain the complete witnessed population, never
      // the surviving Session's 500ms subtotal or missing data.
      expect(observedAgentTimes).not.toContain(500);
      expect(observedAgentTimes).not.toContain(null);

      detailGate = createDeferred<void>();
      sharedSeq = 5;
      storage.setState({ sessions: { ...storage.getState().sessions,
        shared: { ...storage.getState().sessions.shared!, seq: sharedSeq } } });
      const retiredRefresh = pinned.refresh();
      await expect.poll(() => countReads('/v2/sessions/shared')).toBe(5);
      retireActiveServerAccountScopeLifetime();
      detailGate.resolve();
      await retiredRefresh;
      expect(broad.getSnapshot().value).toBeUndefined();
      expect(pinned.getSnapshot().value).toBeUndefined();
    } finally {
      detailGate.resolve();
      releaseBroad();
      releasePinned();
    }
  });

  it('reconciles consumed Session revisions before a closed Action reuses its admitted Usage answer', async () => {
    let seq = 1;
    const captured = await context(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/finite') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'finite', seq }) });
      if (request.path === '/v1/sessions/finite/turns') return Response.json({ v: 1, sessionId: 'finite', updatedAt: seq,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: seq === 1 ? 400 : 700, updatedAt: seq }] });
      if (request.path === '/v1/sessions/finite/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    const scope = captured.accountLifetime.scope;
    storage.getState().applySessions([createSessionFixture({ id: 'finite', seq, serverId: scope.serverId }),
      createSessionFixture({ id: 'unconsumed', seq: 1, serverId: scope.serverId })]);
    const query = normalizeUsageQuery({ session: 'finite', period: { startMs: 0, endMs: 1000 }, includeQuota: false,
      includeQuotaHistory: false, includeTranscriptEvidence: false, includeWorkEvidence: false, includeComparison: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const account = await captureLazyActionAccountContext(scope.serverId);
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
    const read = async () => {
      const response = await executor.execute('usage.query', { queries: [query] }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, usageQueryReadiness: 'public_profile' });
      expect(response).toMatchObject({ ok: true });
      if (!response.ok) throw new Error(response.errorCode);
      return UsageQueryBatchResultSchema.parse(response.result).results[0]!;
    };
    const evidenceReads = () => home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH).length;
    const accountingReads = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch').length;
    let release = entry.subscribe(() => {}, true);
    try {
      await entry.refresh({ supersede: false });
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
      release(); release = () => {};
      const beforeEvidence = evidenceReads(), beforeAccounting = accountingReads();
      storage.getState().applySessions([{ ...storage.getState().sessions.unconsumed!, seq: 2 }]);
      expect((await read()).howYouWork?.intervals?.agentTimeMs).toBe(300);
      expect(evidenceReads(), 'an unconsumed Session does not reacquire private evidence').toBe(beforeEvidence);
      seq = 2;
      storage.getState().applySessions([{ ...storage.getState().sessions.finite!, seq }]);
      expect((await read()).howYouWork?.intervals?.agentTimeMs, 'closed static admission consumes the selected Session advance').toBe(600);
      expect(evidenceReads()).toBe(beforeEvidence + 1);
      expect(accountingReads(), 'private changes reuse the admitted accounting answer').toBe(beforeAccounting);
      const afterEvidence = evidenceReads();
      expect((await read()).howYouWork?.intervals?.agentTimeMs).toBe(600);
      expect(evidenceReads(), 'the unchanged closed return reads no private evidence').toBe(afterEvidence);
      expect(accountingReads(), 'the unchanged closed return posts no accounting query').toBe(beforeAccounting);
    } finally { release(); account.dispose(); }
  });

  it('retains admitted Session intervals through transport withdrawal and reads a real Session advance', async () => {
    let seq = 1;
    let refused = false;
    const captured = await context(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/finite') return refused ? Response.json({ error: 'denied' }, { status: 403 })
        : Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'finite', seq }) });
      if (request.path === '/v1/sessions/finite/turns') return Response.json({ v: 1, sessionId: 'finite', updatedAt: seq,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: seq === 1 ? 400 : 700, updatedAt: seq }] });
      if (request.path === '/v1/sessions/finite/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    const sessions = () => ({ finite: createSessionFixture({ id: 'finite', seq, serverId: captured.accountLifetime.scope.serverId }) });
    storage.setState({ sessions: sessions() });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({
      session: 'finite', period: { startMs: 0, endMs: 1000 }, includeTranscriptEvidence: false, includeWorkEvidence: false,
    })] }) });
    const interval = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.intervals?.agentTimeMs;
    const reads = () => home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH
      && UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => !demand.query.includeTranscriptEvidence)).length;
    await entry.refresh();
    expect(interval()).toBe(300);
    const before = reads();
    const { invalidateAccountEncryptionModeCache } = await import('./apiAccountEncryptionMode');
    invalidateAccountEncryptionModeCache({ serverId: captured.accountLifetime.scope.serverId, reason: 'transport-withdrawal' });
    await entry.refresh();
    expect(reads(), 'transport withdrawal must not reacquire unchanged Session evidence').toBe(before);
    expect(interval()).toBe(300);
    seq++;
    storage.setState({ sessions: sessions() });
    await entry.refresh();
    expect(interval()).toBe(600);
    expect(reads()).toBe(before + 1);
    refused = true;
    invalidateAccountEncryptionModeCache({ serverId: captured.accountLifetime.scope.serverId });
    await entry.refresh();
    expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.intervals ?? null,
      'an actual identity withdrawal re-admits access and removes refused evidence').toBeNull();
    expect(reads()).toBe(before + 2);
  });

  it('refreshes same-seq Session metadata through fresh admission while reusing opened input evidence', async () => {
    let completedAt = 200;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/work') return Response.json({ session: { ...createPlainSessionCurrentProjectionRecordFixture({ id: 'work',
        createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
        metadataVersion: 1, metadata: { name: 'work', path: '/repo', host: 'usage-test' }, agentStateVersion: completedAt === 200 ? 1 : 2 }),
        agentState: JSON.stringify({ completedRequests: { request: { tool: 'Bash', arguments: {}, turnId: 'turn',
          createdAt: 100, completedAt, status: 'approved' } } }), share: null } });
      if (request.path === '/v1/sessions/work/turns') return Response.json({ v: 1, sessionId: 'work', updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 }] });
      if (request.path === '/v1/sessions/work/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: {
      work: createSessionFixture({ id: 'work', serverId: captured.accountLifetime.scope.serverId }) } });
    const query = normalizeUsageQuery({ session: 'work', period: { startMs: 0, endMs: 1000 } });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    const evidenceRequests = () => home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
    const summaryDemand = { query: normalizeUsageQuery({ ...query, includeTranscriptEvidence: false }), sessionIds: ['work'] };
    const transcriptDemand = { query, sessionIds: ['work'] };
    const latency = () => entry.getSnapshot().value
      && decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.permissions?.decisionLatencyMs;
    try {
      await expect.poll(latency).toBe(100);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(evidenceRequests()).toEqual([summaryDemand, transcriptDemand]);
      completedAt = 600;
      storage.setState({ sessions: { work: { ...storage.getState().sessions.work!, agentStateVersion: 2 } } });
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['work'], { changeKinds: ['session'], usageQueryAffects: true });
      await expect.poll(latency).toBe(500);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(evidenceRequests(), 'metadata refresh replaces the summary and reuses its opened transcript evidence')
        .toEqual([summaryDemand, transcriptDemand, summaryDemand]);
      completedAt = 800;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['work']);
      await entry.refresh();
      expect(latency(), 'a named Session wake still re-admits access when domain tags are absent').toBe(700);
      expect(evidenceRequests(), 'an untagged named wake also replaces only the summary')
        .toEqual([summaryDemand, transcriptDemand, summaryDemand, summaryDemand]);
    } finally { release(); }
  });

  it.each([false, true])('updates demanded Session membership when the loaded list admits or removes a candidate (sibling opened: %s)', async siblingOpened => {
    const record = createPlainSessionCurrentProjectionRecordFixture({
      id: 'new-candidate', createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1,
    });
    const turns = { v: 1 as const, sessionId: 'new-candidate', updatedAt: 900,
      turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed' as const, startedAt: 100, terminalAt: 400, updatedAt: 900 }] };
    const captured = await context(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/new-candidate') return Response.json({ session: record });
      if (request.path === '/v1/sessions/new-candidate/turns') return Response.json(turns);
      if (request.path === '/v1/sessions/new-candidate/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: {} });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
      queries: [normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeTranscriptEvidence: false, includeWorkEvidence: false })],
    }) });
    const release = entry.subscribe(() => {}, true);
    let releaseSibling: (() => void) | undefined;
    const agentTime = () => entry.getSnapshot().value && decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.intervals?.agentTimeMs;
    try {
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      if (siblingOpened) {
        const sibling = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
          queries: [normalizeUsageQuery({ session: 'new-candidate', period: { startMs: 0, endMs: 1000 },
            includeTranscriptEvidence: false, includeWorkEvidence: false })],
        }) });
        releaseSibling = sibling.subscribe(() => {}, true);
        await expect.poll(() => sibling.getSnapshot().value && decodeUsageQueryResource(sibling.getSnapshot().value!).results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
        expect(agentTime()).toBeUndefined();
      }
      const { normalizeSessionAccessProjection } = await import('@/sync/engine/sessions/normalizeSessionAccessProjection');
      storage.getState().applySessions([createSessionFixture({ id: 'new-candidate', seq: 1,
        serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain', updatedAt: record.updatedAt,
        metadataVersion: record.metadataVersion, agentStateVersion: record.agentStateVersion,
        metadataLayoutVersion: record.metadataLayoutVersion, access: normalizeSessionAccessProjection(record) ?? undefined,
        sessionTurns: turns })]);
      await expect.poll(agentTime).toBe(300);
      storage.getState().deleteSession('new-candidate', captured.accountLifetime.scope.serverId);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      await expect.poll(agentTime).toBeUndefined();
    } finally { releaseSibling?.(); release(); }
  });

  it.each(['accounting', 'sessions', 'turns'] as const)('keeps Account Coach membership on a failed %s refresh and isolates a Session-scoped sibling', async failureSource => {
    vi.spyOn(Date, 'now').mockReturnValue(900);
    const ids = ['first', 'second', 'third'];
    let membership = ids;
    let failing = false;
    const captured = await context(request => {
      if (failing && failureSource === 'sessions' && request.path === '/v2/sessions/read-batch') {
        return Response.json({ error: 'unavailable' }, { status: 503 });
      }
      if (request.path === '/v2/usage/query') {
        const pinned = UsageAnalyticsQueryRequestSchema.parse(request.body).filters?.sessionIds;
        if (failing && failureSource === 'accounting' && !pinned?.length) return Response.json({ error: 'unavailable' }, { status: 503 });
        return Response.json({ ...value, contributions: membership.filter(id => !pinned?.length || pinned.includes(id))
          .map(id => ({ ...workContribution, id, sessionId: id, turnId: null })) });
      }
      const detail = /^\/v2\/sessions\/(first|second|third)$/.exec(request.path);
      if (detail) return Response.json({ session: { ...createPlainSessionCurrentProjectionRecordFixture({ id: detail[1]!,
        seq: 1, updatedAt: 900, agentStateVersion: 1 }), agentState: JSON.stringify({ completedRequests: {
          approval: { tool: 'Bash', arguments: {}, turnId: 'turn', createdAt: 100, completedAt: 200, status: 'approved' },
        } }) } });
      const turns = /^\/v1\/sessions\/(first|second|third)\/turns$/.exec(request.path);
      if (failing && failureSource === 'turns' && turns?.[1] === 'third') return Response.json({ error: 'unavailable' }, { status: 503 });
      if (turns) return Response.json({ v: 1, sessionId: turns[1]!, updatedAt: 900, turns: turns[1] === 'first' ? [
        { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
      ] : [] });
      if (request.path.endsWith('/messages')) return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    const serverId = captured.accountLifetime.scope.serverId;
    // Accounting admits historical Sessions independently of the small hydrated detail cache.
    storage.setState({ sessions: { first: createSessionFixture({ id: 'first', serverId, encryptionMode: 'plain' }) } });
    const store = getUsageQueryResourceStore(captured);
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false });
    const broad = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const pinned = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
      queries: [normalizeUsageQuery({ ...query, session: 'first' })],
    }) });
    const coach = (entry: typeof broad) => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.coach!;
    await broad.refresh();
    await pinned.refresh();
    expect(coach(broad).sessionCoverage).toEqual({ selected: 3, admitted: 3, notRead: 3 });
    const finding = coach(broad).findings.find(row => row.detectorId === 'approval_friction')!;
    expect(finding.measurements.find(row => row.metric === 'permission_requests')?.value).toBe(3);
    const observations: ReturnType<typeof decodeUsageQueryResource>['results'][number][] = [];
    const release = broad.subscribe(() => {
      if (broad.getSnapshot().value) observations.push(decodeUsageQueryResource(broad.getSnapshot().value!).results[0]!);
    }, false);
    // Failed A retains the same displayed accounting; private evidence must use that same population.
    // Alternate success/failure and a scoped sibling as periodic background reads do.
    try {
      for (let pass = 0; pass < 2; pass++) {
        await pinned.refresh();
        failing = true;
        if (failureSource !== 'accounting') publishHomeAccountChange(serverId);
        await broad.refresh();
        expect.soft(coach(pinned).sessionCoverage).toEqual({ selected: 1, admitted: 1, notRead: 1 });
        expect.soft(coach(broad).sessionCoverage).toEqual({ selected: 3, admitted: 3, notRead: 3 });
        expect.soft(coach(broad).findings.find(row => row.detectorId === 'approval_friction')?.evidenceKey).toBe(finding.evidenceKey);
        const failed = decodeUsageQueryResource(broad.getSnapshot().value!);
        if (failureSource === 'accounting') expect(failed.results[0]!.sources).toContainEqual(expect.objectContaining({ source: 'accounting', status: 'error' }));
        else {
          expect.soft(failed.results[0]!.pending, 'failed evidence has settled, rather than reading forever').toBe(false);
          expect.soft(failed.results[0]!.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'stale',
            errorCode: 'http_error' }));
        }
        expect(UsageQueryBatchResultSchema.safeParse(failed).success).toBe(true);
        if (failureSource !== 'accounting') {
          await broad.refresh();
          expect.soft(coach(broad).sessionCoverage, 'a repeated failed replacement keeps the same admitted evidence').toEqual({ selected: 3, admitted: 3, notRead: 3 });
          expect.soft(coach(broad).findings.find(row => row.detectorId === 'approval_friction')?.evidenceKey).toBe(finding.evidenceKey);
          const rebatched = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
            queries: [query, normalizeUsageQuery({ ...query, agents: ['codex'] })],
          }) });
          await rebatched.refresh();
          const moved = decodeUsageQueryResource(rebatched.getSnapshot().value!).results.find(slice => slice.key === getUsageQueryKey(query))!;
          expect.soft(moved.coach?.sessionCoverage, 'batch membership does not retire this exact query admission').toEqual({ selected: 3, admitted: 3, notRead: 3 });
          expect.soft(moved.coach?.findings.find(row => row.detectorId === 'approval_friction')?.evidenceKey).toBe(finding.evidenceKey);
          expect.soft(moved.pending).toBe(false);
          expect(UsageQueryBatchResultSchema.safeParse(decodeUsageQueryResource(rebatched.getSnapshot().value!)).success).toBe(true);
        }
        failing = false;
        await broad.refresh();
        expect.soft(coach(broad).sessionCoverage).toEqual({ selected: 3, admitted: 3, notRead: 3 });
        expect.soft(coach(broad).findings.find(row => row.detectorId === 'approval_friction')?.evidenceKey).toBe(finding.evidenceKey);
      }
    } finally { release(); }
    expect(observations.every(slice => slice.coach?.sessionCoverage?.admitted === 3)).toBe(true);
    expect(observations.map(slice => slice.coach?.findings.find(row => row.detectorId === 'approval_friction'))
      .filter(row => row?.evidenceKey !== finding.evidenceKey)).toEqual([]);
    expect(observations.every(slice => slice.howYouWork?.todayInParallel?.agentTimeMs === 200)).toBe(true);
    membership = ['first'];
    await broad.refresh();
    await expect.poll(() => coach(broad).sessionCoverage).toEqual({ selected: 1, admitted: 1, notRead: 1 });
    expect(coach(broad).findings.find(row => row.detectorId === 'approval_friction')?.evidenceKey).not.toBe(finding.evidenceKey);
  });

  it('reuses a list-only Session marker and refreshes it when that row advances', async () => {
    let seq = 1;
    const captured = await context(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/list-only') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({
        id: 'list-only', createdAt: 1, updatedAt: 900, seq, active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1,
      }) });
      if (request.path === '/v1/sessions/list-only/turns') return Response.json({ v: 1, sessionId: 'list-only', updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: seq === 1 ? 400 : 700, updatedAt: 900 }] });
      if (request.path === '/v1/sessions/list-only/messages') return Response.json({ messages: [], hasMore: false });
      return undefined;
    });
    const serverId = captured.accountLifetime.scope.serverId;
    const rows = () => ({ [serverId]: { 'list-only': createSessionListRenderableSessionFixture({ id: 'list-only', seq }) } });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: {}, sessionListRowsByServerId: rows() });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
      queries: [normalizeUsageQuery({ session: 'list-only', period: { startMs: 0, endMs: 1000 }, includeTranscriptEvidence: false, includeWorkEvidence: false })],
    }) });
    const release = entry.subscribe(() => {}, true);
    const summaryReads = () => home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH
      && UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => !demand.query.includeTranscriptEvidence));
    const agentTime = () => entry.getSnapshot().value && decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.intervals?.agentTimeMs;
    try {
      await expect.poll(agentTime).toBe(300);
      publishHomeAccountChange(serverId);
      await entry.refresh();
      expect(summaryReads()).toHaveLength(1);
      seq++;
      storage.getState().applyServerScopedSessionListRows(serverId, Object.values(rows()[serverId]!), {
        source: 'rowOnly', mode: 'append',
      });
      await expect.poll(agentTime).toBe(600);
      expect(summaryReads()).toHaveLength(2);
    } finally { release(); }
  });

  it('releases opened message bodies while the Account retains Coach evidence across refreshes', async () => {
    const { Session: InspectorSession } = await import('node:inspector');
    const stored = await import('@/sync/runtime/readStoredSessionContent');
    const read = stored.readStoredSessionMessage;
    const bodies: WeakRef<object>[] = [];
    // Retention instrumentation only: execute the actual opener and keep weak
    // handles, then remove the spy's own strong call/result history before GC.
    const observation = vi.spyOn(stored, 'readStoredSessionMessage').mockImplementation(async (...args) => {
      const result = await read(...args);
      if (result) bodies.push(new WeakRef(result));
      return result;
    });
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/released') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({
        id: 'released', createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
        metadataVersion: 1, agentStateVersion: 1,
      }) });
      if (request.path === '/v1/sessions/released/turns') return Response.json({ v: 1, sessionId: 'released', updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 }] });
      if (request.path === '/v1/sessions/released/messages') return Response.json({ messages: [{
        id: 'message', seq: 1, localId: 'input', createdAt: 300,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private body '.repeat(1024) } } },
        deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
          v: 1, acceptedAtMs: 300, delivery: { kind: 'steer', turnId: 'turn' },
        } } },
      }], hasMore: false });
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: {
      released: createSessionFixture({ id: 'released', seq: 1, serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' }),
    } });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
      queries: [normalizeUsageQuery({ session: 'released', period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false })],
    }) });
    const inspector = new InspectorSession();
    inspector.connect();
    try {
      await entry.refresh();
      for (let pass = 0; pass < 3; pass++) await entry.refresh();
      expect(bodies.length).toBeGreaterThan(0);
      observation.mockRestore();
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
      const retained = bodies.filter(body => body.deref() !== undefined).length;
      console.info('USAGE-SESSION-EVIDENCE retained message bodies', JSON.stringify({ opened: bodies.length, retained }));
      expect(retained, 'the live Account map must retain facts rather than decrypted bodies').toBe(0);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 1, steeringCount: 1 });
    } finally { observation.mockRestore(); inspector.disconnect(); }
  });

  it.each(['json', 'buffered-ndjson'] as const)('reads a visible page once with deduplicated slices and no private evidence (%s)', async delivery => {
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query-batch') return undefined;
      const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
      const queries = [...new Map(input.queries.map(query => [getUsageAnalyticsQueryRequestKey(query), query])).values()];
      const batch = { v: 1, results: queries.map(query => ({ query, value })) };
      if (delivery === 'json') return Response.json(batch);
      const response = new Response(batch.results.map(result => JSON.stringify({ v: 1, results: [result] })).join('\n'),
        { headers: { 'Content-Type': 'application/x-ndjson' } });
      // Native XHR fetch owns a complete body but does not expose getReader.
      Object.defineProperty(response, 'body', { value: undefined });
      return response;
    });
    const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 },
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const other = normalizeUsageQuery({ ...query, costBasis: 'api_equivalent', metric: 'cost', breakdown: ['model'] });
    const result = await readUiUsageQueryBatch(captured, { queries: [query, other, query] });
    expect(result.results).toHaveLength(2);
    expect(result.results.every(slice => slice.accounting?.totals.tokens.total === 15)).toBe(true);
    const calls = home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch');
    expect(calls, 'one physical acquisition for the visible page').toHaveLength(1);
    const admitted = UsageAnalyticsQueryBatchRequestSchema.parse(calls[0]!.body).queries;
    expect(new Set(admitted.map(getUsageAnalyticsQueryRequestKey)).size).toBe(admitted.length);
    expect(home!.httpRequests.filter(request => request.path === '/v2/usage/query'
      || request.path === '/v2/sessions/read-batch' || request.path.endsWith('/messages'))).toEqual([]);
  });

  it('cancels unconsumed accounting after the final caller detaches and on Account retirement', async () => {
    let held = createDeferred<void>();
    const captured = await context(async request => {
      if (request.path !== '/v2/usage/query') return undefined;
      await held.promise;
      return Response.json(value);
    });
    const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 },
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const first = new AbortController(), last = new AbortController();
    let detached = false;
    const departed = readUiUsageQueryBatch(captured, { queries: [query] }, first.signal).catch(() => null)
      .finally(() => { detached = true; });
    const pending: Array<Promise<unknown>> = [departed];
    const accountingRequests = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch');
    try {
      await vi.waitFor(() => expect(accountingRequests().length).toBeGreaterThan(0));
      await flushHookEffects({ cycles: 20 });
      const initial = [...accountingRequests()];
      expect(captured.accountLifetime.isCurrent()).toBe(true);
      expect(initial.map(request => request.signal?.aborted)).toEqual(initial.map(() => false));
      first.abort();
      await vi.waitFor(() => expect(detached).toBe(true));
      expect(await departed).toBeNull();
      // L2: an abandoned physical read must not survive a superseding Retry.
      await vi.waitFor(() => expect(initial.map(request => request.signal?.aborted)).toEqual(initial.map(() => true)));
      const reborrowed = readUiUsageQueryBatch(captured, { queries: [query] });
      pending.push(reborrowed);
      await vi.waitFor(() => expect(accountingRequests().length).toBeGreaterThan(initial.length));
      held.resolve();
      expect((await reborrowed).results[0]?.accounting?.totals).toEqual(value.totals);
      const completed = accountingRequests().length;

      held = createDeferred<void>();
      invalidateUsageQueryResources(captured.accountLifetime);
      const retiringRead = readUiUsageQueryBatch(captured, { queries: [query] }, last.signal).catch(() => null);
      pending.push(retiringRead);
      await vi.waitFor(() => expect(accountingRequests().length).toBeGreaterThan(completed));
      await flushHookEffects({ cycles: 20 });
      const retiring = accountingRequests().slice(completed);
      expect(retiring.map(request => request.signal?.aborted)).toEqual(retiring.map(() => false));
      retireActiveServerAccountScopeLifetime();
      expect(await retiringRead).toBeNull();
      await vi.waitFor(() => expect(retiring.map(request => request.signal?.aborted)).toEqual(retiring.map(() => true)));
    } finally {
      held.resolve(); first.abort(); last.abort();
      await Promise.allSettled(pending);
    }
  });

  it('shares accounting across distinct batches while cancellation and a later fresh read stay independent', async () => {
    const held = createDeferred<void>();
    const captured = await context(async request => {
      if (request.path !== '/v2/usage/query') return undefined;
      await held.promise;
      return Response.json(value);
    });
    const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 },
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const controller = new AbortController();
    const departed = readUiUsageQueryBatch(captured, { queries: [query] }, controller.signal).catch(() => null);
    const live = readUiUsageQueryBatch(captured, { queries: [{ ...query, metric: 'cost' }] });
    const accountingRequests = () => home!.requests.filter(request => request.path === '/v2/usage/query');
    try {
      await vi.waitFor(() => expect(accountingRequests().length).toBeGreaterThan(0));
      await flushHookEffects({ cycles: 20 });
      const descriptors = new Set(accountingRequests().map(request => JSON.stringify(request.body)));
      expect(accountingRequests()).toHaveLength(descriptors.size);
      controller.abort();
      held.resolve();
      expect(await departed).toBeNull();
      expect((await live).results[0]?.accounting?.totals.tokens.total).toBe(15);
      expect(accountingRequests().every(request => !request.signal?.aborted)).toBe(true);
      const completed = accountingRequests().length;
      invalidateUsageQueryResources(captured.accountLifetime);
      await readUiUsageQueryBatch(captured, { queries: [query] });
      expect(accountingRequests().length).toBeGreaterThan(completed);
    } finally { held.resolve(); await Promise.allSettled([departed, live]); }
  });

  it('never joins accounting begun before the Account Resource was invalidated', async () => {
    const held = createDeferred<void>();
    let total = 15;
    const captured = await context(async request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const observed = total;
      await held.promise;
      return Response.json({ ...value, totals: { ...value.totals, tokens: { ...value.totals.tokens, total: observed } } });
    });
    const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 },
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const old = readUiUsageQueryBatch(captured, { queries: [query] });
    await vi.waitFor(() => expect(home!.requests.some(request => request.path === '/v2/usage/query')).toBe(true));
    total = 30;
    invalidateUsageQueryResources(captured.accountLifetime);
    const fresh = readUiUsageQueryBatch(captured, { queries: [{ ...query, metric: 'cost' }] });
    await flushHookEffects({ cycles: 20 });
    held.resolve();
    expect((await fresh).results[0]?.accounting?.totals.tokens.total).toBe(30);
    expect((await old).results[0]?.accounting?.totals.tokens.total).toBe(15);
  });

  it('keeps failed accounting slices on the Account wake lifecycle instead of separate batch retry timers', async () => {
    let failed = true;
    const captured = await context(request => request.path === '/v2/usage/query'
      ? failed ? Response.json({ error: 'storage_unavailable' }, { status: 503 }) : Response.json(value) : undefined);
    const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 },
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const store = getUsageQueryResourceStore(captured);
    const first = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const second = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ ...query, metric: 'cost' }] }) });
    vi.useFakeTimers();
    const releases: (() => void)[] = [];
    try {
      releases.push(first.subscribe(() => {}, true));
      await vi.advanceTimersByTimeAsync(50);
      releases.push(second.subscribe(() => {}, true));
      await Promise.all([first.refresh(), second.refresh()]);
      const reads = () => home!.requests.filter(request => request.path === '/v2/usage/query').length;
      const settled = reads();
      await vi.runOnlyPendingTimersAsync();
      expect(reads()).toBe(settled);
      failed = false;
      const recovered = [first, second].map(entry => new Promise<void>(resolve => {
        const inspect = () => {
          const content = entry.getSnapshot().value;
          if (content && decodeUsageQueryResource(content).results[0]?.accounting?.totals.tokens.total === 15) resolve();
        };
        releases.push(entry.subscribe(inspect, false));
        inspect();
      }));
      publishHomeAccountChange(captured.accountLifetime.scope.serverId);
      await Promise.all(recovered);
      expect(reads()).toBeGreaterThan(settled);
      const resumed = home!.requests.filter(request => request.path === '/v2/usage/query').slice(settled);
      expect(resumed).toHaveLength(new Set(resumed.map(request => JSON.stringify(request.body))).size);
    } finally { releases.forEach(release => release()); vi.useRealTimers(); }
  });

  it('batches equivalent resolved inputs and preserves distinct scopes as independent slices', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    const query = normalizeUsageQuery({ agents: ['b', 'a'], period: { startMs: 1000, endMs: 2000 } });
    const equivalent = normalizeUsageQuery({ ...query, agents: ['a', 'b', 'a'] });
    const pinned = normalizeUsageQuery({ ...query, machines: ['machine-other'] });
    const result = await readUiUsageQueryBatch(captured, { queries: [query, equivalent, pinned] });
    expect(result.results).toHaveLength(2);
    expect(result.results.map(slice => slice.requestedQuery.machines).sort()).toEqual([[], ['machine-other']].sort());
    expect(result.results.every(slice => slice.accounting?.totals.tokens.total === 15)).toBe(true);
    expect(result.results[0]?.comparison?.accounting?.totals.tokens.total).toBe(15);
    const store = getUsageQueryResourceStore(captured);
    const first = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const second = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [equivalent] }) });
    const release = first.subscribe(() => {}, false);
    await first.refresh();
    expect(second.getSnapshot()).toBe(first.getSnapshot());
    release();
  });

  it('publishes available A while a producer is pending and advances only on its own Home wake', async () => {
    let pending = true;
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json({ ...value,
      coverage: { status: 'partial', reasons: [], sources: [{ source: 'native-history', path: 'native',
        status: pending ? 'pending' : 'available', eventCount: 1 }], missingDimensions: [],
        range: { complete: false }, ranked: [] },
    }) : undefined);
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{}] }) });
    const release = entry.subscribe(() => {}, true);
    try {
      await entry.refresh();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]).toMatchObject({
        accounting: value, sources: expect.arrayContaining([{ source: 'native-history', status: 'pending' }]), pending: true,
      });
      pending = false;
      const readsBeforeUnrelatedWake = home!.requests.filter(request => request.path === '/v2/usage/query').length;
      const workflowPlan = planSyncActionsFromChanges([{ cursor: 1, kind: 'account', entityId: 'workflow-run:run-42', changedAt: 1, hint: null }]);
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['workflow-run:run-42'], {
        changeKinds: ['account'], usageQueryAffects: plannedChangesAffectUsageQuery(workflowPlan),
      });
      await flushHookEffects({ cycles: 20 });
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'native-history', status: 'pending' });
      expect(home!.requests.filter(request => request.path === '/v2/usage/query')).toHaveLength(readsBeforeUnrelatedWake);
      publishHomeAccountChange('a-different-home');
      await flushHookEffects();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'native-history', status: 'pending' });
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['machine-a'], { usageQueryAffects: false });
      await flushHookEffects({ cycles: 20 });
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'native-history', status: 'pending' });
      // Machine-name projection does not acquire unrelated pending accounting.
      const machine = createMachineFixture({ id: 'usage-source-machine' });
      storage.setState({ machines: { [machine.id]: machine } });
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(home!.requests.filter(request => request.path === '/v2/usage/query')).toHaveLength(readsBeforeUnrelatedWake);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'native-history', status: 'pending' });
      // An actual accounting producer wake replaces that admitted observation.
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['session-a'], { usageQueryAffects: true });
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'native-history', status: 'available' });
      pending = true;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['session-a'], { usageQueryAffects: true });
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'native-history', status: 'pending' });
      pending = false;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId);
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual({ source: 'native-history', status: 'available' });
    } finally { release(); }
  });

  it('refuses a richer unsupported server read without falling back to an unfiltered legacy report', async () => {
    const captured = await context(request => request.path === '/v2/usage/query-batch'
      ? Response.json({ error: 'not_found' }, { status: 404 })
      : request.path === '/v1/usage/query' ? Response.json({ usage: [] }) : undefined);
    const result = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ machines: ['specific'] })] });
    expect(result.results[0]?.accounting).toBeUndefined();
    expect(result.results[0]?.sources).toContainEqual({ source: 'accounting', status: 'error', errorCode: 'unsupported' });
    expect(home!.requests.filter(request => request.path === '/v1/usage/query')).toEqual([]);
  });
});

describe('usage query Work composition', () => {
  it('publishes admitted Work before one replacement even when the replacement cannot run', async () => {
    const machineId = 'work-machine';
    const contribution = { ...workContribution, machineId };
    const captured = await context(request => request.path === '/v2/usage/query'
      ? Response.json({ ...value, contributions: [contribution] }) : undefined);
    const scope = captured.accountLifetime.scope;
    storage.getState().applySessions([createSessionFixture({ id: contribution.sessionId, serverId: scope.serverId,
      metadata: { machineId, path: '/repo', host: 'test', homeDir: '/home/test' } })]);
    await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({
      id: machineId, accountId: 'account-a', machine: { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 },
    })]);
    const checkpoint = { sessionId: contribution.sessionId, turnId: contribution.turnId, repositoryKey: 'repo',
      checkpointRef: 'checkpoint/turn', checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed' as const };
    const ready = createDeferred<void>();
    const releaseHeld = createDeferred<void>();
    const releaseUnavailable = createDeferred<void>();
    const linked = (request: { payload: ScmWorkEvidenceReadRequest }) => workBatch(request, {
      status: 'partial', evidence: [], pullRequestsRead: true,
      branchEvidence: [{ ...checkpoint, branch: { ref: 'refs/heads/work', headSha: checkpoint.commitSha } }],
    });
    scmTransport.mockImplementationOnce(async request => linked(request));
    scmTransport.mockImplementationOnce(async request => {
      ready.resolve();
      await releaseHeld.promise;
      return linked(request);
    });
    scmTransport.mockImplementationOnce(async () => {
      throw createRpcCallError({ error: 'Work refused', errorCode: RPC_ERROR_CODES.FORBIDDEN });
    });
    scmTransport.mockImplementation(async () => {
      await releaseUnavailable.promise;
      throw new RetryableServerResponseError(503, 'Unavailable');
    });
    const store = getUsageQueryResourceStore(captured);
    const entryAt = (startMs: number) => store.getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({
        session: [contribution.sessionId], period: { startMs, endMs: 1000 },
        includeQuota: false, includeQuotaHistory: false, includeComparison: false, includeSessionEvidence: false,
        includeTranscriptEvidence: false, includeWorkEvidence: true, includeCoach: false, workProjection: 'detail',
      })] }) });
    const first = entryAt(0);
    const held = entryAt(1);
    const refused = entryAt(2);
    const read = (entry: typeof held) => {
      const value = entry.getSnapshot().value;
      return value && decodeUsageQueryResource(value).results[0];
    };
    await first.refresh({ supersede: false });
    const publishes: number[] = [];
    const stop = held.subscribe(() => publishes.push(read(held)?.work?.branches.length ?? 0), false);
    try {
      await ready.promise;
      await refused.refresh({ supersede: false });
      releaseHeld.resolve();
      await expect.poll(() => scmTransport.mock.calls.length).toBe(4);
      expect(publishes).toContain(1);
      releaseUnavailable.resolve();
      await expect.poll(() => held.getSnapshot().pending).toBe('idle');
      expect(read(held)?.work?.branches ?? []).toEqual([]);
      expect(read(held)?.sources.find(state => state.source === 'work')).toMatchObject({
        status: 'error', unreadSessions: { not_entitled: 1 },
      });
      expect(scmTransport).toHaveBeenCalledTimes(4);
    } finally {
      releaseHeld.resolve();
      releaseUnavailable.resolve();
      stop();
    }
  });

  it.each(['refused', 'failed', 'recovered on Action', 'recovered on wake'] as const)(
    'handles a %s batch Work read in the exact-query entry', async state => {
    const machineId = 'work-machine';
    const contribution = { ...workContribution, machineId };
    const captured = await context(request => request.path === '/v2/usage/query'
      ? Response.json({ ...value, contributions: [contribution] }) : undefined);
    const scope = captured.accountLifetime.scope;
    storage.getState().applySessions([createSessionFixture({ id: contribution.sessionId, serverId: scope.serverId,
      metadata: { machineId, path: '/repo', host: 'test', homeDir: '/home/test' } })]);
    await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({
      id: machineId, accountId: 'account-a', machine: { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 },
    })]);
    const checkpoint = { sessionId: contribution.sessionId, turnId: contribution.turnId, repositoryKey: 'repo',
      checkpointRef: 'checkpoint/turn', checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed' as const };
    const evidence: UsageWorkEvidence = { ...checkpoint,
      pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
        nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Linked', url: 'https://github.com/owner/repo/pull/1',
        baseBranch: 'main', headBranch: 'work', state: 'merged' },
    };
    const readLinkedWork = async (request: { payload: ScmWorkEvidenceReadRequest }) => workBatch(request, {
      status: 'partial', pullRequestsRead: true, evidence: [evidence],
      branchEvidence: [{ ...checkpoint, branch: { ref: 'refs/heads/work', headSha: checkpoint.commitSha } }],
    });
    scmTransport.mockImplementationOnce(readLinkedWork);
    const query = normalizeUsageQuery({ session: [contribution.sessionId], period: { startMs: 0, endMs: 1000 },
      includeQuota: false, includeQuotaHistory: false, includeComparison: false, includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeWorkEvidence: true, includeCoach: false, workProjection: 'detail' });
    const exact = { queries: [query] };
    const combined = { queries: [query,
      normalizeUsageQuery({ ...query, includeWorkEvidence: false }),
      normalizeUsageQuery({ ...query, includeWorkEvidence: false, metric: 'cost' })] };
    const store = getUsageQueryResourceStore(captured);
    const entry = (input: typeof exact) => store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(input) });
    const single = entry(exact);
    const batch = entry(combined);
    const read = (resource: typeof single) => decodeUsageQueryResource(resource.getSnapshot().value!).results
      .find(slice => slice.key === getUsageQueryKey(query))!;
    const workSource = (slice: ReturnType<typeof read>) => slice.sources.find(source => source.source === 'work');
    const assertRetained = (slice: ReturnType<typeof read>, date: number | undefined) => {
      expect(slice.work?.outcomes).toHaveLength(1);
      expect(slice.work?.branches).toHaveLength(1);
      expect(workSource(slice)?.asOfMs).toBe(date);
    };
    const stop = single.subscribe(() => {}, true);
    try {
      await expect.poll(() => single.getSnapshot().pending).toBe('idle');
      const prior = read(single);
      const firstReadAt = workSource(prior)?.asOfMs;
      expect(firstReadAt).toEqual(expect.any(Number));
      assertRetained(prior, firstReadAt);
      expect(scmTransport).toHaveBeenCalledTimes(1);
      const ownReplacement = createDeferred<void>();
      const refused = async () => { throw createRpcCallError({ error: 'Work refused', errorCode: RPC_ERROR_CODES.FORBIDDEN }); };
      if (state === 'failed') {
        scmTransport.mockImplementation(async () => { throw new RetryableServerResponseError(503, 'Unavailable'); });
      } else {
        scmTransport.mockImplementationOnce(refused);
        scmTransport.mockImplementation(state === 'recovered on Action' ? async request => {
          await ownReplacement.promise;
          return readLinkedWork(request);
        } : refused);
      }
      try {
        // Equal admissions ordinarily share the first Work answer. Refresh
        // deliberately asks the Machine again to exercise withdrawal.
        await batch.refresh();
        expect(batch.getSnapshot().pending).toBe('idle');
        await expect.poll(() => scmTransport.mock.calls.length).toBe(state === 'failed' ? 2 : 3);
        expect(workSource(read(batch))?.unreadSessions).toEqual(state === 'failed' ? { failed: 1 } : { not_entitled: 1 });
        expect(read(batch).accounting?.totals).toEqual(prior.accounting?.totals);
        expect(read(single).accounting?.totals).toEqual(prior.accounting?.totals);
        const assertWithdrawn = (slice: ReturnType<typeof read>) => {
          expect(slice.work?.outcomes ?? []).toEqual([]);
          expect(slice.work?.branches ?? []).toEqual([]);
          expect(workSource(slice)?.asOfMs).toBeUndefined();
          expect(workSource(slice)?.unreadSessions).toEqual({ not_entitled: 1 });
        };
        if (state === 'failed') assertRetained(read(single), firstReadAt);
        else if (state === 'recovered on Action') {
          expect(single.getSnapshot().pending).toBe('refresh');
          expect(read(single).work?.outcomes ?? []).toEqual([]);
        } else {
          await expect.poll(() => single.getSnapshot().pending).toBe('idle');
          assertWithdrawn(read(single));
        }

        const recovered = state === 'recovered on Action' || state === 'recovered on wake';
        if (state === 'recovered on wake') {
          scmTransport.mockImplementation(readLinkedWork);
          // A resolved checkout change genuinely reopens Work admission.
          storage.getState().applySessions([createSessionFixture({ id: contribution.sessionId, serverId: scope.serverId,
            seq: 2, metadata: { machineId, path: '/repo-next', host: 'test', homeDir: '/home/test' } })]);
          publishHomeAccountChange(scope.serverId, [contribution.sessionId], {
            changeKinds: ['session'], usageAccountingAffects: false,
            sessionReadinessChanges: { sessionIds: [contribution.sessionId], machineIds: [] },
          });
          await expect.poll(() => read(single).work?.outcomes).toHaveLength(1);
          await expect.poll(() => single.getSnapshot().pending).toBe('idle');
          expect(scmTransport).toHaveBeenCalledTimes(4);
        }
        const account = await captureLazyActionAccountContext(scope.serverId);
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
        const pendingAction = executor.execute('usage.query', exact, { surface: 'ui', authority: 'present_user',
          actionCaller: { kind: 'host' }, usageQueryReadiness: 'public_profile' });
        ownReplacement.resolve();
        const response = await pendingAction;
        if (!response.ok) throw new Error(response.errorCode);
        const action = UsageQueryBatchResultSchema.parse(response.result).results[0]!;
        expect(action.accounting?.totals).toMatchObject(value.totals);
        if (state === 'refused') {
          // The sibling has already acquired its own refusal. The exact
          // Action can now reuse that settled answer.
          assertWithdrawn(action);
        } else if (recovered) {
          expect(action.work?.outcomes).toHaveLength(1);
          expect(action.work?.branches).toHaveLength(1);
          expect(workSource(action)?.asOfMs).toEqual(expect.any(Number));
          expect(workSource(action)?.unreadSessions).toBeUndefined();
        } else {
          assertRetained(action, firstReadAt);
        }
        expect(scmTransport).toHaveBeenCalledTimes(state === 'failed' ? 2 : state === 'recovered on wake' ? 4 : 3);
      } finally { ownReplacement.resolve(); }
    } finally { stop(); }
  });

  it('keeps mounted Week links and does no Work RPC for accounting-only pages with the same selectors', async () => {
    const machineIds = Array.from({ length: 15 }, (_, i) => `week-machine-${i}`);
    const sessions = Array.from({ length: 1_300 }, (_, i) => ({
      id: `week-session-${i}`, machineId: machineIds[i < 16 ? 0 : 1 + i % 14]!,
    }));
    const added = { id: 'week-session-added', machineId: machineIds[0]! };
    const all = [...sessions, added];
    const reachable = sessions.slice(0, 16).map(session => session.id);
    let page = 0;
    let membership = sessions;
    const captured = await context(request => request.path === '/v1/machines/read-batch'
      ? createMachineReadBatchResponseFixture(request.body, id => createPlainMachineRowFixture({
        id, accountId: 'account-a', machine: createMachineFixture({
          id, active: id === machineIds[0], activeAt: Date.now(), presenceProtocolVersion: 1,
        }),
      }))
      : request.path === '/v2/usage/query' ? Response.json({
      ...value, totals: { ...value.totals, eventCount: membership.length + page },
      contributions: [...membership.map(session => ({ ...workContribution, id: `cost-${session.id}`,
        sessionId: session.id, machineId: session.machineId })),
      ...Array.from({ length: page }, (_, i) => ({ ...workContribution, id: `append-${i}`,
        sessionId: sessions[0]!.id, machineId: sessions[0]!.machineId }))],
    }) : undefined);
    const scope = captured.accountLifetime.scope;
    storage.getState().applySessions(all.map(session => createSessionFixture({ id: session.id, serverId: scope.serverId,
      metadata: { machineId: session.machineId, path: '/repo', host: 'test', homeDir: '/home/test' },
    })));
    await publishMachineInventoryForTest(scope, machineIds.map((id, index) => createHydratedPlainMachineFixture({
      id, accountId: 'account-a', machine: { active: index === 0, activeAt: Date.now(), presenceProtocolVersion: 1 },
    })));
    const evidence = { sessionId: sessions[0]!.id, turnId: workContribution.turnId, repositoryKey: 'work-ledger',
      checkpointRef: 'checkpoint/turn', checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed', pullRequest: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Linked', url: 'https://github.com/owner/repo/pull/1',
        baseBranch: 'main', headBranch: 'feature', state: 'merged',
      } } satisfies UsageWorkEvidence;
    const held = createDeferred<void>();
    let hold = false;
    scmTransport.mockImplementation(async (request: { payload: ScmWorkEvidenceReadRequest }) => {
      if (hold) await held.promise;
      return ScmWorkEvidenceReadResponseSchema.parse({ sessions: request.payload.sessions.map(session => ({
        sessionId: session.sessionId, status: 'partial', pullRequestsRead: true,
        evidence: session.sessionId === evidence.sessionId ? [evidence] : [],
      })) });
    });
    const query = normalizeUsageQuery({ period: { relative: '7days' }, includeQuota: false, includeQuotaHistory: false,
      includeComparison: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: true,
      includeCoach: false, workProjection: 'detail' });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const read = () => {
      const content = entry.getSnapshot().value;
      return content && decodeUsageQueryResource(content).results[0];
    };
    const counts: number[] = [];
    const stop = entry.subscribe(() => {
      const slice = read();
      if (slice) counts.push(slice.work?.outcomes.length ?? 0);
    }, true);
    const waitForPage = async () => {
      const expected = membership.length + page;
      await expect.poll(() => read()?.accounting?.totals.eventCount).toBe(expected);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
    };
    const advance = (kind: 'push' | 'account-page' | 'session-page' = 'push') => {
      const readiness = { sessionIds: [], machineIds: [] };
      if (kind === 'push') {
        publishHomeAccountChange(scope.serverId, [], { changeKinds: ['account'],
          usageAccountingChange: { sessionId: null }, sessionReadinessChanges: readiness });
      } else {
        const session = kind === 'session-page';
        publishHomeAccountChange(scope.serverId, [session ? sessions[0]!.id : 'self'], {
          feedPageConsumed: true, usageAccountingAffects: true, changeKinds: [session ? 'session' : 'account'],
          sessionReadinessChanges: readiness,
        });
      }
    };
    const attemptedSessions = () => scmTransport.mock.calls.map(([request]) =>
      (request.payload as ScmWorkEvidenceReadRequest).sessions.map(session => session.sessionId));
    try {
      await waitForPage();
      expect(read()?.sources.find(source => source.source === 'work')).toMatchObject({
        status: 'partial', errorCode: 'machine_offline', unreadSessions: { machine_unavailable: 1_284 },
      });
      expect(read()?.work?.outcomes).toHaveLength(1);
      expect(attemptedSessions()).toEqual([reachable]);
      scmTransport.mockClear();
      counts.length = 0;
      for (const kind of ['push', 'account-page', 'session-page'] as const) {
        page++;
        membership = page === 2 ? [...sessions].reverse() : sessions;
        advance(kind);
        await waitForPage();
      }
      expect.soft(attemptedSessions(), 'three accounting-only pages, zero Work RPCs').toHaveLength(0);
      const admittedWork = read()?.sources.find(source => source.source === 'work');
      expect(admittedWork?.asOfMs).toEqual(expect.any(Number));
      // The consumed Basis S Home pages carried these exact routing shapes.
      const wakes = [
        { changeKinds: ['account', 'discussion'], sessionReadinessChanges: 'all' },
        { changeKinds: ['account', 'automation', 'pluginDomain'], sessionReadinessChanges: { sessionIds: [], machineIds: [] } },
        { changeKinds: ['machine'], sessionReadinessChanges: { sessionIds: [], machineIds: ['outside-the-visit'] } },
      ] as const;
      for (const wake of wakes) {
        scmTransport.mockClear();
        publishHomeAccountChange(scope.serverId, [], { ...wake, feedPageConsumed: true, usageAccountingAffects: false });
        await flushHookEffects({ cycles: 30 });
        await waitForPage();
        const why = wake.changeKinds.join(', ');
        expect.soft(attemptedSessions(), `${why}: equal admitted targets and selectors send no Work RPC`).toEqual([]);
        expect.soft(read()?.sources.find(source => source.source === 'work')?.asOfMs, `${why}: retain the Work read time`)
          .toBe(admittedWork?.asOfMs);
        expect(read()?.work?.outcomes).toHaveLength(1);
      }
      scmTransport.mockClear();
      membership = all;
      hold = true;
      advance();
      await expect.poll(() => scmTransport.mock.calls.length).toBe(1);
      await expect.poll(() => read()?.sources.find(source => source.source === 'work')?.status).toBe('pending');
      expect(read()?.work?.outcomes).toHaveLength(1);
      expect(attemptedSessions()).toEqual([[...reachable, added.id]]);
      held.resolve();
      await waitForPage();
      expect(counts).not.toContain(0);

      scmTransport.mockClear();
      await entry.refresh();
      expect(attemptedSessions()).toEqual([[...reachable, added.id]]);
    } finally {
      held.resolve();
      stop();
    }
  });

  it.each(['answers', 'drops a Session', 'refuses'] as const)(
  'keeps the readable Week Work answer while late targets resolve and the replacement %s', async replacement => {
    const firstReadAt = Date.UTC(2026, 10, 25, 13);
    let now = firstReadAt;
    const machineId = 'week-work-machine';
    const rows = Array.from({ length: 17 }, (_, index) => ({
      ...workContribution, id: `week-event-${index}`, sessionId: `week-session-${index}`,
      turnId: `week-turn-${index}`, machineId, observedAtMs: firstReadAt - 1_000,
    }));
    let contributions = rows;
    let targetsReady = false;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({
        ...value, totals: { ...value.totals, eventCount: contributions.length }, contributions,
      });
      const index = rows.findIndex(row => request.path === `/v2/sessions/${row.sessionId}`);
      if (index < 0) return undefined;
      return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: rows[index]!.sessionId,
        active: true, metadata: { ...(targetsReady || index < 14 ? { machineId } : {}), path: '/repo', host: 'test' },
      }) });
    });
    const scope = captured.accountLifetime.scope;
    const publishSessions = (selected: typeof rows) => storage.getState().applySessions(selected.map(row =>
      createSessionFixture({ id: row.sessionId, active: true, serverId: scope.serverId,
        metadata: { machineId, path: '/repo', host: 'test', homeDir: '/home/test' } })));
    publishSessions(rows.slice(0, 14));
    await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({
      id: machineId, accountId: 'account-a', machine: { active: true, activeAt: firstReadAt, presenceProtocolVersion: 1 },
    })]);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const held = createDeferred<void>();
    let replacing = false;
    const witness = (row: typeof rows[number], number: number) => ({
      sessionId: row.sessionId, turnId: row.turnId, repositoryKey: 'week-repo', checkpointRef: 'checkpoint/turn',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
      pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
        nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number, title: 'Linked', url: `https://github.com/owner/repo/pull/${number}`,
        baseBranch: 'main', headBranch: `work-${number}`, state: 'open' },
    }) satisfies UsageWorkEvidence;
    scmTransport.mockImplementation(async (request: { payload: ScmWorkEvidenceReadRequest }) => {
      const pending = replacing;
      if (pending) await held.promise;
      if (pending && replacement === 'refuses') {
        return workBatch(request, { status: 'error', evidence: [], branchEvidence: [], errorCode: RPC_ERROR_CODES.FORBIDDEN });
      }
      return ScmWorkEvidenceReadResponseSchema.parse({ sessions: request.payload.sessions.map(({ sessionId }) => {
        const index = rows.findIndex(row => row.sessionId === sessionId);
        if (!pending && index === 13) return { sessionId, status: 'error', errorCode: 'BACKEND_UNAVAILABLE' };
        const number = pending ? (index === 16 ? 17 : undefined) : (index < 9 ? index + 1 : undefined);
        const linked = number === undefined ? undefined : witness(rows[index]!, number);
        if (!linked) return { sessionId, status: 'partial', pullRequestsRead: true, evidence: [], branchEvidence: [] };
        const { pullRequest, ...checkpoint } = linked;
        return { sessionId, status: 'partial', pullRequestsRead: true, evidence: [{ ...checkpoint, pullRequest }],
          branchEvidence: [{ ...checkpoint, branch: { ref: `refs/heads/work-${number}`, headSha: checkpoint.commitSha } }] };
      }) });
    });
    const query = normalizeUsageQuery({ period: { startMs: firstReadAt - 7 * 86_400_000, endMs: firstReadAt + 1 },
      includeQuota: false, includeQuotaHistory: false, includeComparison: false, includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeWorkEvidence: true, includeCoach: false, workProjection: 'detail' });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const readPage = () => {
      const content = entry.getSnapshot().value;
      return content && decodeUsageQueryResource(content).results[0];
    };
    const workSource = (slice: ReturnType<typeof readPage>) => slice?.sources.find(source => source.source === 'work');
    const links = (slice: ReturnType<typeof readPage>) => (slice?.work?.outcomes ?? []).map(row => row.pullRequest.number).sort((a, b) => a - b);
    const branches = (slice: ReturnType<typeof readPage>) => (slice?.work?.branches ?? []).map(row => row.branch.ref).sort();
    const nineLinks = Array.from({ length: 9 }, (_, index) => index + 1);
    const stop = entry.subscribe(() => {}, true);
    try {
      await expect.poll(() => [entry.getSnapshot().pending, links(readPage()).length]).toEqual(['idle', 9]);
      expect(workSource(readPage())).toMatchObject({ status: 'partial', asOfMs: firstReadAt, unreadSessions: { failed: 1 } });
      expect(scmTransport.mock.lastCall?.[0].payload.sessions).toHaveLength(14);
      scmTransport.mockClear();
      now += 1_000;
      replacing = true;
      targetsReady = true;
      if (replacement === 'drops a Session') contributions = rows.slice(1);
      publishSessions(rows.slice(14));
      publishHomeAccountChange(scope.serverId, [], { changeKinds: ['account', 'automation', 'machine', 'pluginDomain', 'session'],
        usageAccountingChange: { sessionId: null }, sessionReadinessChanges: 'all' });
      await expect.poll(() => scmTransport.mock.calls.length).toBe(1);
      const selectors = scmTransport.mock.lastCall?.[0].payload.sessions ?? [];
      expect(selectors.map(({ sessionId, turnIds }: ScmWorkEvidenceReadRequest['sessions'][number]) => ({ sessionId, turnIds })))
        .toEqual(expect.arrayContaining(contributions.map(({ sessionId, turnId }) => ({ sessionId, turnIds: [turnId] }))));
      expect(selectors).toHaveLength(contributions.length);
      await expect.poll(() => workSource(readPage())?.status).toBe('pending');
      const retained = replacement === 'drops a Session' ? nineLinks.slice(1) : nineLinks;
      const pending = readPage();
      expect.soft(UsageQueryBatchResultSchema.safeParse({ v: 1, results: [pending] }).success).toBe(true);
      expect.soft(workSource(pending)).toEqual({ source: 'work', status: 'pending', asOfMs: firstReadAt });
      expect.soft(pending?.pending).toBe(true);
      expect.soft(links(pending)).toEqual(retained);
      expect.soft(branches(pending)).toEqual(retained.map(number => `refs/heads/work-${number}`));
      expect.soft(pending?.workSummary?.pullRequestsRead).toBeUndefined();
      expect.soft(pending?.workSummary?.mergedPrCount).toBeUndefined();
      expect.soft(pending?.workSummary?.mergedSessionCount).toBeUndefined();
      expect.soft(pending?.mergedOutcomes).toBeUndefined();
      now += 500;
      held.resolve();
      const expected = replacement === 'refuses' ? [] : [17];
      await expect.poll(() => [entry.getSnapshot().pending, links(readPage())]).toEqual(['idle', expected]);
      const settled = readPage();
      expect(branches(settled)).toEqual(expected.map(number => `refs/heads/work-${number}`));
      if (replacement === 'refuses') {
        expect(workSource(settled)).toMatchObject({ status: 'error', unreadSessions: { not_entitled: 17 } });
        expect(workSource(settled)?.asOfMs).toBeUndefined();
        expect(settled?.workSummary?.mergedPrCount).toBeUndefined();
      } else {
        expect(workSource(settled)).toMatchObject({ status: 'partial', asOfMs: now });
        expect(settled?.workSummary).toMatchObject({ pullRequestsRead: true, mergedPrCount: 0 });
      }
    } finally { held.resolve(); stop(); clock.mockRestore(); }
  });

  it.each(['growth', 'replacement', 'growth with an event on the retained turn', 'explicit Refresh', 'Refresh after unsupported'] as const)(
  'keeps the mounted page and Usage Action Work answer dated and valid during %s', async change => {
    const wasUnsupported = change === 'Refresh after unsupported';
    const refresh = change === 'explicit Refresh' || wasUnsupported;
    const keepsFirstSession = change !== 'replacement';
    const testsReuse = change === 'growth';
    const firstReadAt = Date.UTC(2026, 9, 12, 12);
    let now = firstReadAt;
    const machineId = 'work-currentness-machine';
    const first = { ...workContribution, machineId };
    const added = { ...first, id: 'more-work', sessionId: 'more-work-session' };
    let contributions = [first];
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json({
      ...value, totals: { ...value.totals, eventCount: contributions.length }, contributions,
      coverage: { status: 'complete', reasons: [], missingDimensions: [], ranked: [],
        sources: [{ source: 'runtime', path: 'runtime', status: 'available', asOfMs: now, eventCount: contributions.length }],
        range: { startMs: 0, endMs: 1000, complete: true } },
    }) : undefined);
    const scope = captured.accountLifetime.scope;
    const metadata = { machineId, path: '/repo', host: 'test', homeDir: '/home/test' };
    storage.getState().applySessions([first, added].map(row => createSessionFixture({ id: row.sessionId, active: true,
      serverId: scope.serverId, metadata })));
    await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({
      id: machineId, accountId: 'account-a', machine: { active: true, activeAt: firstReadAt, presenceProtocolVersion: 1 },
    })]);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const linked = {
      sessionId: first.sessionId, turnId: first.turnId, repositoryKey: 'repo', checkpointRef: 'checkpoint/turn',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
      pullRequest: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Linked', url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'open',
      },
    } satisfies UsageWorkEvidence;
    const held = createDeferred<void>();
    let merged = !testsReuse && !refresh;
    let hold = false;
    let unavailable = false;
    scmTransport.mockImplementation(async (request: { payload: ScmWorkEvidenceReadRequest }) => {
      if (hold) await held.promise;
      if (wasUnsupported && !hold) return workBatch(request, { status: 'unsupported' });
      if (unavailable) throw new RetryableServerResponseError(503, 'Unavailable');
      return ScmWorkEvidenceReadResponseSchema.parse({ sessions: request.payload.sessions.map(({ sessionId }) => ({
        sessionId, status: 'partial', pullRequestsRead: true,
        evidence: sessionId === first.sessionId
          ? [{ ...linked, pullRequest: { ...linked.pullRequest, state: merged ? 'merged' : 'open' } }]
          : !keepsFirstSession && sessionId === added.sessionId
            ? [{ ...linked, sessionId, pullRequest: { ...linked.pullRequest, number: 2, url: 'https://github.com/owner/repo/pull/2' } }]
            : [],
      })) });
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeQuota: false, includeQuotaHistory: false,
      includeComparison: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: true,
      includeCoach: false, workProjection: 'detail' });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const account = await captureLazyActionAccountContext(scope.serverId);
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
    const readAction = async () => {
      const response = await executor.execute('usage.query', { queries: [query] }, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      });
      if (!response.ok) throw new Error(response.errorCode);
      return UsageQueryBatchResultSchema.parse(response.result).results[0]!;
    };
    const readPage = () => {
      const content = entry.getSnapshot().value;
      return content && decodeUsageQueryResource(content).results[0];
    };
    const workSource = (slice: ReturnType<typeof readPage>) => slice?.sources.find(source => source.source === 'work');
    const expectSettledWork = (slice: ReturnType<typeof readPage>, asOfMs: number, mergedPrCount: number) => {
      expect(workSource(slice)).toMatchObject({ status: 'partial', asOfMs });
      expect(slice?.workSummary).toMatchObject({ pullRequestsRead: true, mergedPrCount });
      expect(slice?.mergedOutcomes?.linkedMergedCount).toBe(mergedPrCount);
      expect(slice?.work?.outcomes.map(row => row.pullRequest.state)).toEqual([mergedPrCount ? 'merged' : 'open']);
    };
    const waitForPage = async () => {
      await expect.poll(() => readPage()?.accounting?.totals.eventCount).toBe(contributions.length);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
    };
    const pushAccounting = () => publishHomeAccountChange(scope.serverId, [], { changeKinds: ['account'],
      usageAccountingChange: { sessionId: null }, sessionReadinessChanges: { sessionIds: [], machineIds: [] } });
    const release = entry.subscribe(() => {}, true);
    try {
      await waitForPage();
      expect(scmTransport, 'a cold mount acquires Work once').toHaveBeenCalledTimes(1);
      for (const slice of [readPage(), await readAction()]) {
        if (wasUnsupported) expect(workSource(slice)).toEqual({ source: 'work', status: 'unsupported', asOfMs: firstReadAt });
        else expectSettledWork(slice, firstReadAt, merged ? 1 : 0);
      }

      if (testsReuse) {
        merged = true;
        for (const offset of [1_100, 2_200, 3_300]) {
          now = firstReadAt + offset;
          contributions = [...contributions, { ...first, id: `event-${offset}` }];
          pushAccounting();
          await waitForPage();
          for (const slice of [readPage(), await readAction()]) {
            expect(slice?.sources.find(source => source.source === 'accounting')?.asOfMs).toBe(now);
            expectSettledWork(slice, firstReadAt, 0);
          }
          expect(readUsageAccountingReadAtMs(readPage()!)).toBe(now);
        }
        expect(scmTransport, 'a forge merge plus accounting-only changes never reacquires Work').toHaveBeenCalledTimes(1);
      }

      now += 1_100;
      if (!refresh) contributions = keepsFirstSession ? [...contributions, added] : [added];
      if (change === 'growth with an event on the retained turn') {
        contributions.push({ ...first, id: 'one-new-event-on-the-old-turn' });
      }
      hold = true;
      const refreshing = refresh ? entry.refresh() : undefined;
      if (!refresh) pushAccounting();
      await expect.poll(() => scmTransport.mock.calls.length).toBe(2);
      await expect.poll(() => readPage()?.accounting?.totals.eventCount).toBe(contributions.length);
      await expect.poll(() => workSource(readPage())?.status).toBe('pending');
      expect(scmTransport.mock.lastCall?.[0].payload.sessions.map((row: { sessionId: string }) => row.sessionId).sort())
        .toEqual(refresh ? [first.sessionId] : keepsFirstSession ? [first.sessionId, added.sessionId].sort() : [added.sessionId]);
      const expectPending = (slice: ReturnType<typeof readPage>) => {
        if (wasUnsupported) expect.soft(workSource(slice)).toEqual({ source: 'work', status: 'pending' });
        else expect.soft(workSource(slice)).toMatchObject({ status: 'pending', asOfMs: firstReadAt });
        expect.soft(slice?.workSummary?.pullRequestsRead).toBeUndefined();
        expect.soft(slice?.workSummary?.mergedPrCount).toBeUndefined();
        expect.soft(slice?.workSummary?.mergedSessionCount).toBeUndefined();
        expect.soft(slice?.work?.outcomes.map(row => row.pullRequest.number)).toEqual(keepsFirstSession && !wasUnsupported ? [1] : []);
        if (change === 'growth with an event on the retained turn') {
          expect.soft(slice?.work?.allocations.filter(row => row.outcome?.pullRequest.number === 1)).toHaveLength(2);
          expect.soft(slice?.mergedOutcomes?.linkedMergedCount).toBe(1);
        } else {
          expect.soft(slice?.mergedOutcomes).toBeUndefined();
        }
      };
      expectPending(readPage());
      expectPending(await readAction());
      // The Work clock must record the answer, even if Accounting and RPC issuance used another instant.
      now += 600;
      held.resolve();
      await refreshing;
      await waitForPage();
      for (const slice of [readPage(), await readAction()]) {
        expectSettledWork(slice, now, keepsFirstSession && merged ? 1 : 0);
        expect(slice?.work?.outcomes.map(row => row.pullRequest.number)).toEqual(keepsFirstSession ? [1] : [2]);
      }
      if (!testsReuse) return;

      now += 1_100;
      contributions = [...contributions, { ...first, id: 'new-turn-event', turnId: 'next-turn' }];
      pushAccounting();
      await waitForPage();
      expect(scmTransport, 'a new turn on an already admitted Session reacquires Work').toHaveBeenCalledTimes(3);
      const selector = scmTransport.mock.lastCall?.[0].payload.sessions.find((row: { sessionId: string }) => row.sessionId === first.sessionId);
      expect(selector?.turnIds).toHaveLength(2);
      expect(selector?.turnIds).toEqual(expect.arrayContaining(['next-turn', first.turnId]));

      now += 1_100;
      unavailable = true;
      await entry.refresh();
      expect(scmTransport, 'explicit Refresh reacquires unchanged selectors').toHaveBeenCalledTimes(4);
      expect(workSource(readPage())?.status).toBe('stale');
      unavailable = false;
      now += 1_100;
      await entry.refresh({ failedOnly: true });
      expect(scmTransport, 'explicit Retry reacquires failed Work').toHaveBeenCalledTimes(5);
      expectSettledWork(readPage(), now, 1);
    } finally {
      held.resolve();
      release();
      account.dispose();
      clock.mockRestore();
    }
  });

  it.each([false, true])('reuses the settled page Work in an equal mounted exact Action (failed: %s)', async workFailed => {
    const machineId = 'work-exact-action-machine';
    const contribution = { ...workContribution, machineId };
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json({
      ...value, contributions: [contribution],
    }) : undefined);
    const scope = captured.accountLifetime.scope;
    const { sessionId, turnId } = contribution;
    storage.getState().applySessions([createSessionFixture({ id: sessionId, active: true, serverId: scope.serverId,
      metadata: { machineId, path: '/repo', host: 'test', homeDir: '/home/test' },
    })]);
    const firstReadAt = Date.now();
    await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({
      id: machineId, accountId: 'account-a', machine: { active: true, activeAt: firstReadAt, presenceProtocolVersion: 1 },
    })]);
    let now = firstReadAt;
    let pullRequestNumber = 1;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const checkpoint = { sessionId, turnId, repositoryKey: 'repo', checkpointRef: 'checkpoint/turn',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed' as const };
    scmTransport.mockImplementation(async request => workBatch(request, {
      status: 'partial', pullRequestsRead: true,
      evidence: [{ ...checkpoint, pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge',
        baseUrl: 'https://github.com', nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
      number: pullRequestNumber, title: 'Linked', url: `https://github.com/owner/repo/pull/${pullRequestNumber}`, baseBranch: 'main', headBranch: 'feature', state: 'open' } }],
      branchEvidence: [{ ...checkpoint, branch: { ref: 'refs/heads/feature', headSha: checkpoint.commitSha } }],
    }));
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, session: sessionId,
      includeQuota: false, includeQuotaHistory: false, includeComparison: false, includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeWorkEvidence: true, includeCoach: false, workProjection: 'detail' });
    const queries = [query, normalizeUsageQuery({ ...query, includeWorkEvidence: false })];
    const page = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries }) });
    const stop = page.subscribe(() => {}, true);
    const account = await captureLazyActionAccountContext(scope.serverId);
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
    const pageSlice = () => {
      const content = page.getSnapshot().value;
      return content && decodeUsageQueryResource(content).results.find(slice => slice.key === getUsageQueryKey(query));
    };
    const workDate = (slice: ReturnType<typeof pageSlice>) => slice?.sources.find(source => source.source === 'work')?.asOfMs;
    try {
      await expect.poll(() => [page.getSnapshot().subscription, page.getSnapshot().pending, workDate(pageSlice())])
        .toEqual(['live', 'idle', firstReadAt]);
      expect(scmTransport).toHaveBeenCalledTimes(1);
      now += 500;
      const response = await executor.execute('usage.query', { queries: [query] }, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, usageQueryReadiness: 'public_profile',
      });
      if (!response.ok) throw new Error(response.errorCode);
      const action = UsageQueryBatchResultSchema.parse(response.result).results[0];
      expect(action.key).toEqual(pageSlice()?.key);
      expect(action.work?.outcomes.map(row => row.pullRequest.number)).toEqual([1]);
      expect(action.work?.outcomes).toEqual(pageSlice()?.work?.outcomes);
      expect(action.accounting?.totals.tokens.total).toBe(pageSlice()?.accounting?.totals.tokens.total);
      expect(action.accounting?.totals.eventCount).toBe(pageSlice()?.accounting?.totals.eventCount);
      expect([scmTransport.mock.calls.length, workDate(action), workDate(pageSlice())])
        .toEqual([1, firstReadAt, firstReadAt]);
      if (workFailed) {
        // The page reads a different link before its next refresh fails.
        pullRequestNumber = 2;
        now += 500;
        const secondReadAt = now;
        await page.refresh();
        expect(pageSlice()?.work?.outcomes.map(row => row.pullRequest.number)).toEqual([2]);
        expect(workDate(pageSlice())).toBe(secondReadAt);
        now += 500;
        scmTransport.mockRejectedValue(new RetryableServerResponseError(503, 'Unavailable'));
        await page.refresh();
        const retained = pageSlice();
        const pageWork = retained?.sources.find(source => source.source === 'work');
        expect(retained?.work?.outcomes.map(row => row.pullRequest.number)).toEqual([2]);
        expect(pageWork).toMatchObject({ status: 'stale', errorCode: 'work_evidence_failed', asOfMs: secondReadAt });
        const reply = await executor.execute('usage.query', { queries: [query] }, {
          surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        });
        if (!reply.ok) throw new Error(reply.errorCode);
        const mounted = UsageQueryBatchResultSchema.parse(reply.result).results[0]!;
        expect(mounted.pending).toBe(false);
        expect.soft(mounted.sources.find(source => source.source === 'work')).toEqual(pageWork);
        expect.soft(mounted.work?.outcomes).toEqual(retained?.work?.outcomes);
        expect(mounted.accounting?.totals).toMatchObject(value.totals);
        expect(scmTransport).toHaveBeenCalledTimes(3);
        return;
      }
      const sameKey = await executor.execute('usage.query', { queries }, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, usageQueryReadiness: 'public_profile',
      });
      if (!sameKey.ok) throw new Error(sameKey.errorCode);
      const sameSlice = UsageQueryBatchResultSchema.parse(sameKey.result).results.find(slice => slice.key === getUsageQueryKey(query));
      expect([scmTransport.mock.calls.length, workDate(sameSlice)]).toEqual([1, firstReadAt]);
      const unequal = await executor.execute('usage.query', {
        queries: [normalizeUsageQuery({ ...query, period: { startMs: 0, endMs: 1100 } })],
      }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, usageQueryReadiness: 'public_profile' });
      if (!unequal.ok) throw new Error(unequal.errorCode);
      const unequalSlice = UsageQueryBatchResultSchema.parse(unequal.result).results[0];
      expect([scmTransport.mock.calls.length, workDate(unequalSlice)]).toEqual([2, firstReadAt + 500]);
    } finally { stop(); account.dispose(); clock.mockRestore(); }
  });

  it.each(['unavailable', 'refused'] as const)('keeps the mounted Work count unknown when a refresh returns %s', async failure => {
    const machineId = 'work-refresh-machine';
    const sessionId = workContribution.sessionId;
    const metadata = { machineId, path: '/repo', host: 'test', homeDir: '/home/test' };
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: [workContribution] });
      if (request.path === `/v2/sessions/${sessionId}`) return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({
        id: sessionId, createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900, metadata,
      }) });
      return undefined;
    });
    const scope = captured.accountLifetime.scope;
    storage.getState().applySessions([createSessionFixture({ id: sessionId, active: true, serverId: scope.serverId,
      metadata,
    })]);
    await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({
      id: machineId, accountId: 'account-a', machine: { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 },
    })]);
    const checkpoint = { sessionId, turnId: workContribution.turnId, repositoryKey: 'repo', checkpointRef: 'checkpoint/turn',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed' as const };
    const linked = { ...checkpoint, pullRequest: { provider: { id: 'forge', kind: 'github' as const, displayName: 'Forge',
      baseUrl: 'https://github.com', nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
    number: 1, title: 'Linked', url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'open' as const } };
    const held = createDeferred<void>();
    let phase: 'read' | 'fail' | 'hold' = 'read';
    scmTransport.mockImplementation(async request => {
      const current = phase;
      if (current === 'read') return workBatch(request, { status: 'partial', pullRequestsRead: true, evidence: [linked],
        branchEvidence: [{ ...checkpoint, branch: { ref: 'refs/heads/feature', headSha: checkpoint.commitSha } }],
      });
      if (current === 'hold') await held.promise;
      if (failure === 'refused') return workBatch(request, { status: 'error', evidence: [], branchEvidence: [], errorCode: RPC_ERROR_CODES.FORBIDDEN });
      return workBatch(request, { status: 'error', errorCode: 'BACKEND_UNAVAILABLE' });
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, session: sessionId, includeQuota: false, includeQuotaHistory: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: true, includeCoach: false,
      includeComparison: false, workProjection: 'detail' });
    const pageQueries = [query, normalizeUsageQuery({ ...query, includeWorkEvidence: false })];
    const store = getUsageQueryResourceStore(captured);
    const entryFor = (queries: typeof pageQueries) => store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries }) });
    const pageEntry = entryFor(pageQueries);
    const actionEntry = entryFor([query]);
    const account = await captureLazyActionAccountContext(scope.serverId);
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
    const readAction = async (settled = false) => {
      const response = await executor.execute('usage.query', { queries: [query] }, {
        surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        ...(settled ? { usageQueryReadiness: 'public_profile' as const } : {}),
      });
      if (!response.ok) throw new Error(response.errorCode);
      return UsageQueryBatchResultSchema.parse(response.result).results[0]!;
    };
    const key = getUsageQueryKey(query);
    const readPage = () => decodeUsageQueryResource(pageEntry.getSnapshot().value!).results.find(slice => slice.key === key)!;
    const outcomes = (slice: ReturnType<typeof readPage>) => slice.work?.outcomes.map(row => row.pullRequest.number) ?? [];
    const workStatus = (slice: ReturnType<typeof readPage>) => slice.sources.find(source => source.source === 'work')?.status;
    const stopPage = pageEntry.subscribe(() => {}, true);
    const stopAction = actionEntry.subscribe(() => {}, false);
    try {
      await pageEntry.refresh();
      const baseline = await readAction(true);
      expect(baseline.workSummary).toMatchObject({ pullRequestsRead: true, mergedPrCount: 0 });
      expect(outcomes(baseline)).toEqual([1]);
      expect(baseline.accounting?.totals.eventCount).toBe(1);
      await expect.poll(() => readPage().workSummary).toMatchObject({ pullRequestsRead: true, mergedPrCount: 0 });

      const retained = failure === 'unavailable' ? [1] : [];
      const terminal = failure === 'unavailable' ? 'stale' : 'error';
      const checkFailedPage = async () => {
        phase = 'fail';
        await pageEntry.refresh();
        await expect.poll(() => workStatus(readPage())).toBe(terminal);
        const failedPage = readPage();
        expect(outcomes(failedPage)).toEqual(retained);
        expect(failedPage.workSummary?.mergedPrCount).toBeUndefined();
        expect(failedPage.workSummary?.pullRequestsRead).toBeUndefined();
        expect(failedPage.accounting?.totals).toMatchObject(baseline.accounting!.totals);
      };
      if (failure === 'unavailable') {
        // The failed page refresh must retain the page's last successful read.
        const lastPageWorkRead = readPage().sources.find(source => source.source === 'work')?.asOfMs;
        expect(lastPageWorkRead).toEqual(expect.any(Number));
        await checkFailedPage();
        const failedPage = readPage();
        const reads = scmTransport.mock.calls.length;
        const exact = await readAction();
        const workSource = (slice: typeof failedPage) => slice.sources.find(source => source.source === 'work');
        expect(exact.pending).toBe(false);
        expect(workSource(exact)).toEqual(workSource(failedPage));
        expect(workSource(exact)).toMatchObject({
          status: 'stale', errorCode: 'work_evidence_failed', asOfMs: lastPageWorkRead,
        });
        expect(outcomes(exact)).toEqual(retained);
        expect(exact.workSummary).toEqual(failedPage.workSummary);
        expect(exact.accounting?.totals).toEqual(baseline.accounting?.totals);
        expect(scmTransport).toHaveBeenCalledTimes(reads);
      }

      phase = 'hold';
      const replacement = actionEntry.refresh();
      try {
        const interim = await readAction();
        expect(workStatus(interim)).toBe('pending');
        expect(outcomes(interim)).toEqual([1]);
        expect.soft(interim.workSummary?.mergedPrCount).toBeUndefined();
        expect.soft(interim.workSummary?.pullRequestsRead).toBeUndefined();
        expect(interim.key).toBe(key);
        expect(interim.accounting?.totals).toEqual(baseline.accounting?.totals);
      } finally { held.resolve(); await replacement; }
      const settledAction = await readAction(true);
      expect(outcomes(settledAction)).toEqual(retained);
      expect(workStatus(settledAction)).toBe(terminal);
      expect(settledAction.workSummary?.mergedPrCount).toBeUndefined();
      expect(settledAction.workSummary?.pullRequestsRead).toBeUndefined();
      if (failure === 'refused') await checkFailedPage();

      phase = 'read';
      await actionEntry.refresh();
      const recovered = await readAction(true);
      expect(recovered.workSummary).toMatchObject({ pullRequestsRead: true, mergedPrCount: 0 });
      expect(outcomes(recovered)).toEqual([1]);
    } finally { held.resolve(); stopAction(); stopPage(); account.dispose(); }
  });

  it.each([
    { first: 'read', second: 'read', state: 'partial', counts: undefined, links: 2, merged: 2 },
    { first: 'read', second: 'offline', priorRouteFailure: true, state: 'partial', counts: { machine_unavailable: 1 }, links: 1 },
    { first: 'read', second: 'offline', state: 'partial', counts: { machine_unavailable: 1 }, links: 1 },
    { first: 'read', second: 'timeout', state: 'partial', counts: { timed_out: 1 }, links: 1 },
    { first: 'offline', second: 'offline', state: 'unknown', counts: { machine_unavailable: 2 }, links: 0 },
    { first: 'timeout', second: 'timeout', state: 'error', counts: { timed_out: 2 }, links: 0 },
    { first: 'read', second: 'denied', state: 'partial', counts: { not_entitled: 1 }, links: 1 },
    { first: 'read', second: 'backend', state: 'partial', counts: { failed: 1 }, links: 1 },
  ])('delivers Work evidence through the mounted reader ($first, $second, earlier request failure: $priorRouteFailure)', async ({ first, second, state, counts, links, merged, priorRouteFailure }) => {
    const sessions = [first, second].map((answer, index) => ({
      answer, sessionId: `work-session-${index}`, machineId: `work-machine-${index}`, pr: index + 1,
    }));
    const captured = await context(request => request.path === '/v1/machines/read-batch'
      ? createMachineReadBatchResponseFixture(request.body, id => createPlainMachineRowFixture({
        id, accountId: 'account-a', machine: createMachineFixture({
          id, active: sessions.find(target => target.machineId === id)?.answer !== 'offline',
          activeAt: Date.now(), presenceProtocolVersion: 1,
        }),
      }))
      : request.path === '/v2/usage/query' ? Response.json({
      ...value, contributions: sessions.map(target => ({ ...workContribution, id: `cost-${target.sessionId}`,
        sessionId: target.sessionId, machineId: target.machineId, projectKey: 'project' })),
    }) : undefined);
    const scope = captured.accountLifetime.scope;
    storage.getState().applySessions(sessions.map(target => createSessionFixture({ id: target.sessionId, active: true,
      serverId: scope.serverId, metadata: { machineId: target.machineId, path: '/repo', host: 'test', homeDir: '/home/test' } })));
    await publishMachineInventoryForTest(scope, sessions.map(target => createHydratedPlainMachineFixture({
      id: target.machineId, accountId: 'account-a', machine: { active: target.answer !== 'offline',
        activeAt: Date.now(), presenceProtocolVersion: 1 },
    })));
    if (priorRouteFailure) recordMachineRequestFailed({ ...scope, machineId: sessions[0].machineId });
    scmTransport.mockImplementation(async request => {
      const target = sessions.find(candidate => candidate.machineId === request.machineId)!;
      if (target.answer === 'timeout') throw createRpcCallError({ error: 'Deadline', errorCode: 'MACHINE_RPC_TIMEOUT' });
      if (target.answer === 'denied') throw createRpcCallError({ error: 'Denied', errorCode: RPC_ERROR_CODES.FORBIDDEN });
      if (target.answer === 'backend') return workBatch(request, { status: 'error', errorCode: 'BACKEND_UNAVAILABLE' });
      const checkpoint = { sessionId: target.sessionId, turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint/turn',
        checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed' as const };
      return workBatch(request, { status: 'partial', pullRequestsRead: true,
        branchEvidence: [{ ...checkpoint, branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) } }],
        evidence: [{ ...checkpoint, pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge',
          baseUrl: 'https://github.com', nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
          number: target.pr, title: 'Linked', url: `https://github.com/owner/repo/pull/${target.pr}`,
          baseBranch: 'main', headBranch: 'feature', state: 'merged' } }],
      });
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeQuota: false, includeQuotaHistory: false,
      includeComparison: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: true });
    const slice = (await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]!;
    const work = slice.sources.find(source => source.source === 'work');
    expect.soft(work?.status).toBe(state);
    expect.soft(work?.unreadSessions).toEqual(counts);
    expect.soft(work?.errorCode === 'machine_offline').toBe(sessions.some(target => target.answer === 'offline'));
    expect.soft(slice.work?.outcomes.length ?? 0).toBe(links);
    expect.soft(slice.work?.branchAllocations.filter(allocation => allocation.branch !== null).length ?? 0).toBe(links);
    expect.soft(slice.workSummary?.mergedPrCount).toBe(merged);
    expect(scmTransport.mock.calls.map(([request]) => request.machineId).sort()).toEqual(
      sessions.filter(target => target.answer !== 'offline').map(target => target.machineId));
  });

  it('updates the Work cause when inventory confirms a route-failed Machine offline', async () => {
    const machineId = 'route-failed-work-machine';
    const contribution = { ...workContribution, sessionId: 'route-failed-work-session' };
    let homeActive = true;
    const captured = await context(request => request.path === '/v2/usage/query'
      ? Response.json({ ...value, contributions: [contribution] })
      : createPlainMachineReadHttpResponseFixture(request.path, {
        method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      }, 'account-a', { active: homeActive, activeAt: Date.now(), presenceProtocolVersion: 1 }) ?? undefined);
    const scope = captured.accountLifetime.scope;
    storage.getState().applySessions([createSessionFixture({ id: contribution.sessionId, active: true,
      serverId: scope.serverId, metadata: { machineId, path: '/repo', host: 'test', homeDir: '/home/test' } })]);
    const activeAt = Date.now();
    const publishPresence = (active: boolean) => publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({
      id: machineId, accountId: 'account-a', machine: { active, activeAt, presenceProtocolVersion: 1 },
    })]);
    await publishPresence(true);
    recordMachineRequestFailed({ ...scope, machineId });
    scmTransport.mockRejectedValue(createRpcCallError({ error: 'Machine unavailable', errorCode: 'target_unavailable' }));
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeQuota: false, includeQuotaHistory: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: true, includeComparison: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const readWork = () => {
      const content = entry.getSnapshot().value;
      return content && decodeUsageQueryResource(content).results[0]?.sources.find(source => source.source === 'work');
    };
    const release = entry.subscribe(() => {}, true);
    try {
      await expect.poll(() => readWork()?.status).toBe('unknown');
      expect(readWork()).toMatchObject({ unreadSessions: { machine_unavailable: 1 } });
      expect(readWork()).not.toHaveProperty('errorCode');
      expect(scmTransport).toHaveBeenCalledTimes(1);
      scmTransport.mockClear();

      homeActive = false;
      await publishPresence(false);
      publishHomeAccountChange(scope.serverId, [], {
        changeKinds: ['account', 'automation', 'pluginDomain'], sessionReadinessChanges: { sessionIds: [], machineIds: [] },
        feedPageConsumed: true, usageAccountingAffects: false,
      });
      const fresh = await readUiUsageQueryBatch(captured, { queries: [query] });
      const expected = { status: 'unknown', errorCode: 'machine_offline', unreadSessions: { machine_unavailable: 1 } };
      expect(fresh.results[0]?.sources.find(source => source.source === 'work')).toMatchObject(expected);
      await expect.poll(() => readWork()?.errorCode).toBe('machine_offline');
      expect(readWork()).toMatchObject(expected);

      const account = await captureLazyActionAccountContext(scope.serverId);
      try {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
        const response = await executor.execute('usage.query', { queries: [query] }, {
          surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, usageQueryReadiness: 'public_profile',
        });
        if (!response.ok) throw new Error(response.errorCode);
        const action = UsageQueryBatchResultSchema.parse(response.result);
        expect(action.results[0]?.sources.find(source => source.source === 'work')).toMatchObject(expected);
      } finally { account.dispose(); }
      expect(scmTransport).not.toHaveBeenCalled();
    } finally {
      release();
      clearMachineRequestReachabilityForMachine(scope, machineId);
    }
  });

  it.each(['readable', 'refused'] as const)(
    'retries failed Work without replaying its %s slice in the same batch', async sibling => {
      const sessionIds = { failed: 'retry-work-failed', settled: 'retry-work-settled' };
      const machineId = 'retry-work-machine';
      const captured = await context(request => {
        if (request.path !== '/v2/usage/query') return undefined;
        const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
        const id = query.filters?.sessionIds?.[0]!;
        return Response.json({ ...value, contributions: [{ ...workContribution, id: `usage-${id}`, sessionId: id, machineId }] });
      });
      const scope = captured.accountLifetime.scope;
      storage.getState().applySessions(Object.values(sessionIds).map(id => createSessionFixture({ id, serverId: scope.serverId,
        metadata: { machineId, path: '/repo', host: 'test', homeDir: '/home/test' },
      })));
      await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({
        id: machineId, accountId: scope.accountId, machine: { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 },
      })]);
      const attempts: string[][] = [];
      let retry = false;
      scmTransport.mockImplementation(async (request: { payload: ScmWorkEvidenceReadRequest }) => {
        const ids = request.payload.sessions.map(session => session.sessionId);
        attempts.push(ids);
        if (ids.includes(sessionIds.failed) && !retry) return workBatch(request, { status: 'error', errorCode: 'read_failed' });
        if (ids.includes(sessionIds.settled) && sibling === 'refused') return workBatch(request, { status: 'error', errorCode: RPC_ERROR_CODES.FORBIDDEN });
        return workBatch(request, { status: 'partial', evidence: [], pullRequestsRead: true });
      });
      const queryFor = (id: string) => normalizeUsageQuery({ session: [id], period: { startMs: 0, endMs: 1000 },
        includeQuota: false, includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false,
        includeComparison: false, includeWorkEvidence: true, includeCoach: false, workProjection: 'detail' });
      const failed = queryFor(sessionIds.failed);
      const settled = queryFor(sessionIds.settled);
      const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
        input: projectNativeJsonValueForTransport({ queries: [failed, settled] }) });
      const workState = (query: typeof failed) => decodeUsageQueryResource(entry.getSnapshot().value!).results
        .find(slice => slice.key === getUsageQueryKey(query))?.sources.find(source => source.source === 'work');
      const stop = entry.subscribe(() => {}, true);
      try {
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        expect(new Set(attempts.flat())).toEqual(new Set(Object.values(sessionIds)));
        expect(workState(failed)).toMatchObject({ status: 'error', unreadSessions: { failed: 1 } });
        const prior = workState(settled);
        expect(prior).toMatchObject(sibling === 'refused'
          ? { status: 'error', unreadSessions: { not_entitled: 1 } }
          : { status: 'partial', asOfMs: expect.any(Number) });
        attempts.length = 0;
        retry = true;
        await entry.refresh({ failedOnly: true });
        expect.soft(attempts).toEqual([[sessionIds.failed]]);
        expect.soft(workState(settled)).toEqual(prior);
        expect(workState(failed)).toMatchObject({ status: 'partial' });
      } finally { stop(); }
    });

  it('shares an unavailable Machine verdict across concurrent disjoint Work slices without reusing Session results', async () => {
    const sessionIds = ['cold-work-a', 'cold-work-b', 'cold-work-c'];
    const laterAccounting = createDeferred<void>();
    let holdLaterAccounting = false;
    let homePresence: boolean | undefined;
    const captured = await context(async request => {
      if (request.path !== '/v2/usage/query') {
        return createPlainMachineReadHttpResponseFixture(request.path, {
          method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        }, 'account-a', homePresence === undefined ? undefined
          : { active: homePresence, activeAt: Date.now(), presenceProtocolVersion: 1 }) ?? undefined;
      }
      const input = UsageAnalyticsQueryRequestSchema.parse(request.body);
      const agent = input.filters?.agentIds?.[0];
      if (agent === 'third' && holdLaterAccounting) await laterAccounting.promise;
      const id = agent === 'third' ? sessionIds[2]! : agent === 'second' ? sessionIds[1]! : sessionIds[0]!;
      return Response.json({ ...value, contributions: [{ ...workContribution, id: `cost-${id}`, sessionId: id }] });
    });
    const scope = captured.accountLifetime.scope;
    storage.getState().applySessions(sessionIds.map(id => createSessionFixture({ id, active: true, serverId: scope.serverId,
      metadata: { machineId: 'cold-work-machine', path: '/repo', host: 'test', homeDir: '/home/test' } })));
    // No answered inventory exists. Metadata still permits the first real
    // Machine attempt; hold its network reply while both slices are admitted.
    const refusal = createDeferred<ReturnType<typeof ScmWorkEvidenceReadResponseSchema.parse>>();
    let unavailable = true;
    scmTransport.mockImplementation(async request => unavailable ? refusal.promise : workBatch(request, { status: 'partial', evidence: [] }));
    const first = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeQuota: false, includeQuotaHistory: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: true, includeComparison: false });
    const second = normalizeUsageQuery({ ...first, agents: ['second'] });
    const reading = readUiUsageQueryBatch(captured, { queries: [first, second] });
    await expect.poll(() => scmTransport.mock.calls.length > 0).toBe(true);
    await flushHookEffects({ cycles: 20 });
    expect.soft(scmTransport, 'concurrent disjoint Session selectors share the first Machine availability answer').toHaveBeenCalledTimes(1);
    refusal.reject(createRpcCallError({ error: 'Machine unavailable', errorCode: 'target_unavailable' }));
    const result = await reading;
    expect.soft(scmTransport, 'one unavailable Machine receives at most one SocketRPC CALL in the finite read').toHaveBeenCalledTimes(1);
    const workSources = (batch: typeof result) => batch.results.map(slice => slice.sources.find(source => source.source === 'work'));
    for (const source of workSources(result)) {
      expect(source).toMatchObject({ status: 'unknown', unreadSessions: { machine_unavailable: 1 } });
      expect(source).not.toHaveProperty('errorCode');
    }
    // The previous route verdict is scoped to its acquisition; current Home presence is still unanswered.
    await publishMachineInventoryForTest(scope, []);
    scmTransport.mockClear();
    const knownUnavailable = await readUiUsageQueryBatch(captured, { queries: [first, second] });
    expect.soft(scmTransport, 'one current route verdict covers the new finite read').toHaveBeenCalledTimes(1);
    for (const source of workSources(knownUnavailable)) {
      expect(source).toMatchObject({ status: 'unknown', unreadSessions: { machine_unavailable: 1 } });
      expect(source).not.toHaveProperty('errorCode');
    }

    homePresence = false;
    await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({ id: 'cold-work-machine', accountId: 'account-a',
      machine: { active: false, activeAt: 1, presenceProtocolVersion: 1 } })]);
    scmTransport.mockClear();
    const knownOffline = await readUiUsageQueryBatch(captured, { queries: [first, second] });
    expect.soft(scmTransport, 'answered offline presence blocks both disjoint Work slices before RPC').not.toHaveBeenCalled();
    expect(workSources(knownOffline)).toHaveLength(2);
    for (const source of workSources(knownOffline)) expect.soft(source).toMatchObject({
      status: 'unknown', errorCode: 'machine_offline', unreadSessions: { machine_unavailable: 1 },
    });

    unavailable = false;
    homePresence = true;
    await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({ id: 'cold-work-machine', accountId: 'account-a',
      machine: { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 } })]);
    clearMachineRequestReachabilityForMachine(scope, 'cold-work-machine');
    scmTransport.mockClear();
    const recovered = await readUiUsageQueryBatch(captured, { queries: [first, second] });
    expect(scmTransport, 'reachable disjoint slices keep each Session-specific selector').toHaveBeenCalledTimes(2);
    expect(scmTransport.mock.calls.map(([request]) => request.payload.sessions.map((session: { sessionId: string }) => session.sessionId)))
      .toEqual(expect.arrayContaining([[sessionIds[0]], [sessionIds[1]]]));
    for (const slice of recovered.results) expect(slice.sources).toContainEqual(expect.objectContaining({ source: 'work', status: 'partial' }));
    // A later typed Home Machine-admission refusal stops work whose accounting has not arrived yet.
    let attempts = 0;
    scmTransport.mockClear();
    scmTransport.mockImplementation(async request => {
      if (++attempts === 2) throw createRpcCallError({
        error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN,
        failureCause: { phase: 'rpc.admission.machine', errorClass: 'Error', errorCode: 'machine_unavailable', httpStatus: 403 },
      });
      return workBatch(request, { status: 'partial', evidence: [] });
    });
    holdLaterAccounting = true;
    const third = normalizeUsageQuery({ ...first, agents: ['third'] });
    const disappearing = readUiUsageQueryBatch(captured, { queries: [first, second, third] });
    await expect.poll(() => scmTransport.mock.calls.length).toBe(2);
    laterAccounting.resolve();
    const departed = await disappearing;
    expect.soft(scmTransport, 'a typed Machine admission refusal stops the delayed slice before RPC').toHaveBeenCalledTimes(2);
    expect(workSources(departed)).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'partial' })]));
    const unavailableSources = workSources(departed).filter(source => source?.status === 'unknown');
    expect(unavailableSources).toHaveLength(2);
    for (const source of unavailableSources) {
      expect(source).toMatchObject({ unreadSessions: { machine_unavailable: 1 } });
      expect(source).not.toHaveProperty('errorCode');
    }
    const delayedWork = departed.results.find(slice => slice.key === getUsageQueryKey(third))?.sources.find(source => source.source === 'work');
    expect(delayedWork).toMatchObject({ status: 'unknown', unreadSessions: { machine_unavailable: 1 } });
  });

  const workRouteBehaviors = ['healthy fast', 'healthy slow reply', 'fails at setup', 'fails at dispatch'] as const;
  const workSliceSchedules = ['one', 'three sequential', 'three overlapping'] as const;

  it.each(workRouteBehaviors.flatMap(behavior => workSliceSchedules.map(schedule => ({ behavior, schedule }))))(
    'scopes the Work route verdict to one read ($behavior, $schedule)', async ({ behavior, schedule }) => {
      const agents = ['route-first', 'route-second', 'route-third'].slice(0, schedule === 'one' ? 1 : 3);
      const machineId = 'matrix-work-machine';
      const accounting = agents.map(() => createDeferred<void>());
      const releaseSetup = createDeferred<void>();
      const releaseReply = createDeferred<void>();
      const failedSetup = behavior === 'fails at setup';
      const failedDispatch = behavior === 'fails at dispatch';
      const slowReply = behavior === 'healthy slow reply';
      const heldReplyIndex = agents.length === 1 ? 0 : 1;
      let recovered = false;
      let setupAttempts = 0;
      const captured = await context(async request => {
        if (request.path === '/v1/machines/read-batch' &&
          (request.body as { machineIds?: string[] })?.machineIds?.includes(machineId)) {
          setupAttempts++;
          if (failedSetup && !recovered) {
            await releaseSetup.promise;
            return Response.json({}, { status: 503 });
          }
        }
        if (request.path !== '/v2/usage/query') return undefined;
        const agent = UsageAnalyticsQueryRequestSchema.parse(request.body).filters?.agentIds?.[0]!;
        await accounting[agents.indexOf(agent)]!.promise;
        return Response.json({ ...value, contributions: [{ ...workContribution, id: agent, sessionId: agent }] });
      });
      const scope = captured.accountLifetime.scope;
      storage.getState().applySessions(agents.map(id => createSessionFixture({ id, active: true, serverId: scope.serverId,
        metadata: { machineId, path: '/repo', host: 'test', homeDir: '/home/test' } })));
      if (!failedSetup) await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({
        id: machineId, accountId: 'account-a', machine: { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 },
      })]);
      const dispatches: string[] = [];
      scmTransport.mockImplementation(async request => {
        const id = request.payload.sessions[0]!.sessionId;
        dispatches.push(id);
        if (!recovered && failedDispatch) {
          await releaseReply.promise;
          throw createRpcCallError({ error: 'Machine unavailable', errorCode: 'target_unavailable' });
        }
        if (!recovered && slowReply && id === agents[heldReplyIndex]) await releaseReply.promise;
        return workBatch(request, { status: 'partial', evidence: [] });
      });
      const queries = agents.map(agent => normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, agents: [agent],
        includeQuota: false, includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false,
        includeWorkEvidence: true, includeComparison: false, includeCoach: false }));
      const { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS: setupTimeout } = await import(
        '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes');
      const tick = async () => {
        await vi.advanceTimersByTimeAsync(0);
        await flushHookEffects({ cycles: 30 });
      };
      const workSources = (result: Awaited<ReturnType<typeof readUiUsageQueryBatch>>) =>
        result.results.map(row => row.sources.find(source => source.source === 'work'));
      vi.useFakeTimers();
      const started = Date.now();
      let settled = false;
      const reading = readUiUsageQueryBatch(captured, { queries }, undefined, undefined, { onProgress: project => { project(); } })
        .then(result => { settled = true; return result; });
      try {
        accounting[0]!.resolve();
        await tick();
        if (failedSetup || failedDispatch) {
          if (schedule === 'three overlapping') {
            accounting.slice(1).forEach(release => release.resolve());
            await tick();
          }
          if (failedSetup) await vi.advanceTimersByTimeAsync(setupTimeout);
          else releaseReply.resolve();
          await tick();
        }
        if (schedule === 'three overlapping' && !failedSetup && !failedDispatch) {
          accounting.slice(1).forEach(release => release.resolve());
          await tick();
          expect.soft(dispatches).toEqual(agents);
          if (slowReply) expect.soft(settled).toBe(false);
        }
        if (schedule === 'three sequential') {
          for (const [index, release] of accounting.entries()) {
            if (index === 0) continue;
            release.resolve();
            await tick();
            if (slowReply && index === heldReplyIndex) {
              expect.soft(dispatches).toEqual(agents.slice(0, index + 1));
              releaseReply.resolve();
              await tick();
            }
          }
        }
        if (slowReply) releaseReply.resolve();
        await tick();
        expect.soft(dispatches).toEqual(failedSetup ? [] : failedDispatch ? agents.slice(0, 1) : agents);
        if (failedSetup) expect.soft(setupAttempts).toBe(1);
        expect.soft(settled).toBe(true);
        expect.soft(Date.now() - started).toBe(failedSetup ? setupTimeout : 0);
      } finally {
        accounting.forEach(release => release.resolve());
        releaseSetup.resolve();
        releaseReply.resolve();
        await vi.advanceTimersByTimeAsync(setupTimeout * queries.length);
        await reading;
        vi.useRealTimers();
      }
      const rows = workSources(await reading);
      if (failedSetup || failedDispatch) for (const row of rows) {
        expect.soft(row?.unreadSessions).toEqual(failedSetup ? { timed_out: 1 } : { machine_unavailable: 1 });
      } else expect.soft(rows.every(row => row?.status === 'partial')).toBe(true);
      dispatches.length = 0;
      recovered = true;
      await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({
        id: machineId, accountId: 'account-a', machine: { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 },
      })]);
      const nextRead = await readUiUsageQueryBatch(captured, { queries });
      expect.soft([...dispatches].sort()).toEqual([...agents].sort());
      expect(workSources(nextRead).every(row => row?.status === 'partial' && row.unreadSessions === undefined)).toBe(true);
    },
  );

  it('publishes a healthy Machine’s Work while another Machine in the same slice waits', async () => {
    const slow = createDeferred<void>();
    const accountingHeld = createDeferred<void>();
    const replacementSlow = createDeferred<void>();
    let replacing = false;
    let replacementAccountingStarted = false;
    const fastSession = 'work-progress-fast';
    const slowSession = 'work-progress-slow';
    const failedSession = 'work-progress-failed';
    const sessions = [fastSession, slowSession, failedSession];
    const captured = await context(async request => {
      if (request.path !== '/v2/usage/query') return undefined;
      if (replacing) {
        replacementAccountingStarted = true;
        await accountingHeld.promise;
      }
      return Response.json({
        ...value, contributions: sessions.map(sessionId => ({ ...workContribution, id: 'cost-' + sessionId, sessionId })),
      });
    });
    const scope = captured.accountLifetime.scope;
    storage.getState().applySessions(sessions.map(id => createSessionFixture({ id, active: true, serverId: scope.serverId,
      metadata: { machineId: id, path: '/repo', host: 'test', homeDir: '/home/test' } })));
    await publishMachineInventoryForTest(scope, sessions.map(id => createHydratedPlainMachineFixture({
      id, accountId: 'account-a', machine: { active: true, activeAt: Date.now(), presenceProtocolVersion: 1 },
    })));
    const checkpoint = { sessionId: fastSession, turnId: workContribution.turnId, repositoryKey: 'repo', checkpointRef: 'checkpoint/turn',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed' as const };
    const linked = { ...checkpoint, pullRequest: { provider: { id: 'forge', kind: 'github' as const, displayName: 'Forge',
      baseUrl: 'https://github.com', nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
    number: 1, title: 'Linked', url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'merged' as const } };
    scmTransport.mockImplementation(async request => {
      if (request.machineId === slowSession) {
        await (replacing ? replacementSlow : slow).promise;
        if (replacing) return workBatch(request, { status: 'partial', evidence: [], pullRequestsRead: true });
      }
      if (request.machineId !== fastSession) {
        if (replacing) await accountingHeld.promise;
        return workBatch(request, { status: 'error', errorCode: 'BACKEND_UNAVAILABLE' });
      }
      return workBatch(request, { status: 'partial', pullRequestsRead: true, evidence: [linked],
        branchEvidence: [{ ...checkpoint, branch: { ref: 'refs/heads/feature', headSha: checkpoint.commitSha } }],
      });
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 },
      includeQuota: false, includeQuotaHistory: false, includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeWorkEvidence: true, includeComparison: false, workProjection: 'detail' });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const read = () => {
      const value = entry.getSnapshot().value;
      return value && decodeUsageQueryResource(value).results[0];
    };
    const stop = entry.subscribe(() => {}, true);
    const readLinks = () => read()?.work?.outcomes.map(outcome => outcome.pullRequest.number);
    const readSource = () => read()?.sources.find(source => source.source === 'work');
    try {
      await expect.poll(() => scmTransport.mock.calls.length).toBe(3);
      try {
        await expect.poll(readLinks).toEqual([1]);
        expect(readSource()).toMatchObject({ status: 'pending', errorCode: 'work_evidence_failed', unreadSessions: { failed: 1 } });
        expect(read()?.work?.branches).toHaveLength(1);
        expect(read()?.workSummary?.mergedPrCount).toBeUndefined();
        expect(read()?.workSummary?.pullRequestsRead).not.toBe(true);
      } finally { slow.resolve(); }
      await expect.poll(readSource).toMatchObject({ status: 'partial', errorCode: 'work_evidence_failed', unreadSessions: { failed: 2 } });
      expect(readLinks()).toEqual([1]);
      expect(read()?.workSummary?.mergedPrCount).toBeUndefined();
      const previousDate = readSource()!.asOfMs;
      expect(previousDate).toBeDefined();
      replacing = true;
      publishHomeAccountChange(scope.serverId, [], { changeKinds: ['account'],
        usageAccountingChange: { sessionId: null }, sessionReadinessChanges: { sessionIds: [], machineIds: [] } });
      const refresh = entry.refresh();
      try {
        await expect.poll(() => replacementAccountingStarted).toBe(true);
        await expect.poll(() => readSource()?.status).toBe('pending');
        expect.soft(readSource()?.asOfMs).toBe(previousDate);
        expect.soft(readSource()?.unreadSessions).toBeUndefined();
        expect.soft(readLinks()).toEqual([1]);
        accountingHeld.resolve();
        await expect.poll(readSource).toMatchObject({ status: 'pending', unreadSessions: { failed: 1 } });
        expect.soft(readLinks()).toEqual([1]);
      } finally {
        accountingHeld.resolve();
        replacementSlow.resolve();
        await refresh;
      }
      expect(readSource()).toMatchObject({ status: 'partial', unreadSessions: { failed: 1 } });
      expect(readLinks()).toEqual([1]);
    } finally { slow.resolve(); accountingHeld.resolve(); replacementSlow.resolve(); stop(); }
  });

  it.each([
    { name: 'mapped Work path', localActive: true, homeActive: true, mapped: true, legacy: false },
    { name: 'Home online overrides stale local presence', localActive: false, homeActive: true, mapped: false, legacy: false },
    { name: 'Home offline overrides stale local presence', localActive: true, homeActive: false, mapped: false, legacy: false },
    { name: 'host-only legacy rows have no Work destination', localActive: true, homeActive: true, mapped: false, legacy: true },
    { name: 'cold scoped route acquires its Home Machine once', localActive: null, homeActive: true, mapped: false, legacy: false, scoped: true },
    { name: 'cold scoped route preserves concealed Machine refusal', localActive: null, homeActive: true, mapped: false, legacy: false, scoped: true, concealed: true },
  ])('uses exact Home evidence for a cold Session: $name', async ({ localActive, homeActive, mapped, legacy, scoped, concealed }) => {
    const { sessionId, turnId } = workContribution;
    const machineId = 'archived-work-machine';
    const agentPath = '/agent/archived-checkout';
    const cwd = mapped ? '/home/test/archived-checkout' : agentPath;
    const readable = homeActive && !legacy && !concealed;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: [workContribution] });
      if (request.path === `/v2/sessions/${sessionId}`) return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({
        id: sessionId, active: false, metadata: { ...(!legacy ? { machineId } : {}), path: agentPath, host: 'test', homeDir: '/home/test',
          ...(mapped ? { sessionWorkspaceLocationV1: { v: 1, machineId, agentPath, machinePath: cwd } } : {}) },
      }) });
      if (concealed && request.path === '/v1/machines/read-batch') {
        return createMachineReadBatchResponseFixture(request.body, () => null);
      }
      return createPlainMachineReadHttpResponseFixture(request.path, {
        method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      }, 'account-a', { active: homeActive, activeAt: Date.now(), presenceProtocolVersion: 1 }) ?? undefined;
    });
    const scope = captured.accountLifetime.scope;
    if (localActive !== null) {
      await publishMachineInventoryForTest(scope, [createHydratedPlainMachineFixture({
        id: machineId, accountId: scope.accountId, machine: { active: localActive, activeAt: Date.now(), presenceProtocolVersion: 1, metadata: createMachineMetadataFixture({ host: 'test' }) },
      })]);
    }
    if (scoped) {
      // The Home and Account are still current while their applied socket is
      // unavailable. The real transport must take the unbound scoped path.
      const { apiSocket } = await import('@/sync/api/session/apiSocket');
      apiSocket.initialize({ endpoint: home!.homes.a!.serverUrl, serverId: scope.serverId,
        token: captured.credentials.token, isCurrent: () => false }, null);
      expect(apiSocket.getMachineRequestScope()).toBeNull();
      expect(captured.accountLifetime.isCurrent()).toBe(true);
      expect(storage.getState().machines[machineId]).toBeUndefined();
    }
    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    scmTransport.mockImplementation(async request => workBatch(request, {
      status: 'partial', pullRequestsRead: true, evidence: [{ sessionId, turnId, repositoryKey: 'repo', checkpointRef: 'checkpoint',
        checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
        pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } }, number: 1, title: 'Linked',
          url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'work', state: 'merged' } }],
    }));
    const query = normalizeUsageQuery({ session: [sessionId], period: { startMs: 0, endMs: 1000 }, includeQuota: false,
      includeQuotaHistory: false, includeComparison: false, includeSessionEvidence: false, includeTranscriptEvidence: false,
      includeWorkEvidence: true, includeCoach: false, workProjection: 'detail' });
    const input = { queries: [query] };
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(input) });
    await entry.refresh({ supersede: false });
    const page = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    expect.soft(page.workSummary?.mergedPrCount).toBe(readable ? 1 : undefined);
    expect.soft(page.work?.outcomes.length ?? 0).toBe(readable ? 1 : 0);
    if (readable) {
      expect.soft(scmTransport).toHaveBeenCalledWith(expect.objectContaining({ machineId, payload: { sessions: [{ sessionId, cwd, turnIds: [turnId] }] } }));
    } else {
      expect.soft(page.sources).toContainEqual(expect.objectContaining(concealed
        ? { source: 'work', status: 'error', unreadSessions: { not_entitled: 1 } }
        : { source: 'work', status: 'unknown', ...(!legacy ? { errorCode: 'machine_offline' } : {}),
          unreadSessions: { machine_unavailable: 1 } }));
    }

    const account = await captureLazyActionAccountContext(scope.serverId);
    try {
      const executor = createActionExecutor(createActionExecutorBoundaryFixture({ usageActions: createUiUsageActionPorts(account) }));
      const reply = await executor.execute('usage.query', input, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' } });
      if (!reply.ok) throw new Error(reply.errorCode);
      const action = UsageQueryBatchResultSchema.parse(reply.result).results[0]!;
      expect.soft(action.sources.find(source => source.source === 'work')).toEqual(page.sources.find(source => source.source === 'work'));
      expect.soft(action.workSummary?.mergedPrCount).toBe(readable ? 1 : undefined);
      expect(action.work?.outcomes).toEqual(page.work?.outcomes);
      expect(scmTransport).toHaveBeenCalledTimes(readable ? 1 : 0);
      expect(home!.httpRequests.filter(request => request.path === '/v1/machines/read-batch'
        && (request.body as { machineIds?: string[] } | null)?.machineIds?.includes(machineId))).toHaveLength(legacy ? 0 : 1);
      if (!homeActive) {
        const { readMachineRequestReachabilityObservation } = await import('@/sync/domains/machines/reachability/machineReachability');
        // Home withheld this Work RPC. No failed transport observation should outlive the read.
        expect(readMachineRequestReachabilityObservation(scope, machineId)).toBeNull();
      }
      const reads = home!.httpRequests.filter(request => request.path === '/v2/sessions/read-batch')
        .map(request => SessionReadBatchRequestV1Schema.parse(request.body));
      expect(reads).toEqual([expect.objectContaining({
        sessionIds: [sessionId], includeSnapshot: true, includeTurns: false, includeMessages: false,
      })]);
      expect(storage.getState().sessions[sessionId]).toBeUndefined();
    } finally { account.dispose(); }
  });

  it.each(['available', 'unresolved'] as const)('keeps unresolved Session Machine control distinct from failed Work evidence (%s)', async target => {
    const captured = await context(request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const input = UsageAnalyticsQueryRequestSchema.parse(request.body);
      return Response.json({ ...value, contributions: [workContribution],
        coverage: { status: 'complete', reasons: [], missingDimensions: [], ranked: [], sources: [],
          range: { ...input.dateRange, complete: true } } });
    });
    storage.getState().applySessions([createSessionFixture({ id: workContribution.sessionId, active: true,
      serverId: captured.accountLifetime.scope.serverId, metadata: {
        ...(target === 'available' ? { machineId: 'work-machine' } : {}), path: '/repo', host: 'test', homeDir: '/home/test',
      } })]);
    if (target === 'available') await publishMachineInventoryForTest(captured.accountLifetime.scope,
      [createHydratedPlainMachineFixture({ id: 'work-machine', accountId: 'account-a', machine: { activeAt: Date.now() } })]);
    // Only the daemon acknowledgement is substituted; Resource, Session target,
    // SCM failure normalization and shared Work collection remain real.
    scmTransport.mockImplementation(async request => workBatch(request, { status: 'partial', evidence: [] }));
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 600 },
      includeSessionEvidence: false, includeWorkEvidence: true });
    const result = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(result.results[0]?.accounting?.totals.tokens.total).toBe(15);
    const work = result.results[0]?.sources.find(source => source.source === 'work');
    if (target === 'available') {
      expect(work).toMatchObject({ source: 'work', status: 'partial' });
      expect(work?.unreadSessions).toBeUndefined();
      expect(scmTransport).toHaveBeenCalled();
    } else {
      expect(work).toMatchObject({ source: 'work', status: 'unknown', unreadSessions: { machine_unavailable: 1 } });
      expect(work).not.toHaveProperty('errorCode');
      expect(scmTransport).not.toHaveBeenCalled();
    }
  });

  it('exposes admitted SCM snapshots through the real accounting read without relabelling another query', async () => {
    const tokens = { input: 10, output: 5, total: 15, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    const contribution = { id: 'cost', observedAtMs: 150, sessionId: 'session', turnId: 'turn', agentId: null,
      modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null, tokens,
      cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } };
    const captured = await context(request => {
        if (request.path === '/v2/usage/query') {
          const input = UsageAnalyticsQueryRequestSchema.parse(request.body);
          return Response.json({ v: 1, totals: { eventCount: 1, tokens, cost: contribution.cost },
            contributions: [{ ...contribution,
              ...(input.filters?.agentIds?.includes('different') ? { turnId: 'other-turn' } : {}) }],
            coverage: { status: 'complete', reasons: [], missingDimensions: [], ranked: [], sources: [],
              range: { ...input.dateRange, complete: true } },
          });
        }
        if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        if (request.path === '/v2/sessions/session') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'session',
          createdAt: 1, updatedAt: 200, seq: 1, active: true, activeAt: 200,
          metadataVersion: 1, metadata: { machineId: 'work-machine', path: '/repo', host: 'test', name: 'work' }, agentStateVersion: 1 }) });
        if (request.path === '/v1/sessions/session/turns') return Response.json({ v: 1, sessionId: 'session', updatedAt: 200,
          turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 200, updatedAt: 200 }] });
        if (request.path === '/v1/sessions/session/messages') return Response.json({ messages: [], hasMore: false });
        return undefined;
      });
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const other = normalizeUsageQuery({ ...query, agents: ['different'] });
    const workOnly = normalizeUsageQuery({ ...query, includeSessionEvidence: false, includeWorkEvidence: true });
    const accountingOnly = normalizeUsageQuery({ ...query, includeSessionEvidence: false, includeWorkEvidence: false });
    const witness: UsageWorkEvidence = { sessionId: 'session', turnId: 'turn', repositoryKey: 'repo',
      checkpointRef: 'checkpoint', checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed', pullRequest: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Work', url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'open' } };
    storage.getState().applySessions([createSessionFixture({ id: 'session', active: true,
      serverId: captured.accountLifetime.scope.serverId, metadata: {
        machineId: 'work-machine', path: '/repo', host: 'test', homeDir: '/home/test',
      } })]);
    await publishMachineInventoryForTest(captured.accountLifetime.scope, [createHydratedPlainMachineFixture({ id: 'work-machine', accountId: 'account-a', machine: { activeAt: Date.now() } })]);
    scmTransport.mockImplementation(async request => workBatch(request, { status: 'partial', evidence: [witness] }));
    storage.setState({ settings: { ...storage.getState().settings, scmGitRepoPreferredBackend: 'sapling' } });
    const result = await readUiUsageQueryBatch(captured, { queries: [query, other, workOnly, accountingOnly] });
    expect(scmTransport).toHaveBeenCalledTimes(2);
    expect(scmTransport).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'work-machine', method: 'scm.workEvidence.read',
      payload: { sessions: [{ sessionId: 'session', cwd: '/repo', turnIds: ['turn'] }], backendPreference: { kind: 'prefer', backendId: 'sapling' } },
      authorization: { kind: 'scm.workEvidence', sessionIds: ['session'] },
      serverUrl: home!.homes.a!.serverUrl,
    }));
    const evidenceDemands = () => home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
    const transcriptDemands = () => evidenceDemands().filter(demand => demand.query.includeTranscriptEvidence);
    expect(evidenceDemands()).toHaveLength(4);
    expect(evidenceDemands().filter(demand => !demand.query.includeTranscriptEvidence).map(demand => demand.query))
      .toEqual(expect.arrayContaining([query, other].map(query => normalizeUsageQuery({ ...query, includeTranscriptEvidence: false }))));
    expect(transcriptDemands()).toHaveLength(2);
    expect(transcriptDemands()).toEqual(expect.arrayContaining([query, other].map(query => ({ query, sessionIds: ['session'] }))));
    const accountingRequests = home!.requests.filter(request => request.path === '/v2/usage/query');
    expect(accountingRequests.filter(request => {
      const input = UsageAnalyticsQueryRequestSchema.parse(request.body);
      return input.dateRange?.startMs === 100 && input.dateRange.endMs === 200
        && !input.filters?.agentIds?.length;
    })).toHaveLength(1);
    // Only the actual preceding range and distinct Agent filter add reads.
    expect(accountingRequests).toHaveLength(4);
    const relative = normalizeUsageQuery({ ...query, period: { relative: '7days' },
      includeSessionEvidence: false, includeWorkEvidence: false });
    let readClock = Date.UTC(2026, 9, 12, 12);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => readClock++);
    try {
      const start = home!.requests.length;
      const relativeBatch = await readUiUsageQueryBatch(captured, { queries: [relative,
        normalizeUsageQuery({ ...relative, includeSessionEvidence: true })] });
      expect(relativeBatch.results).toHaveLength(2);
      // One read clock resolves identical relative intent despite independent
      // projection work advancing the environment clock between consumers.
      // The current range and its preceding comparison are distinct reads;
      // evidence demand must not duplicate either one.
      const relativeRequests = home!.requests.slice(start).filter(request => request.path === '/v2/usage/query');
      expect(relativeRequests).toHaveLength(2);
      const [currentPeriod, precedingPeriod] = relativeRequests.map(request => UsageAnalyticsQueryRequestSchema.parse(request.body).dateRange!);
      expect(currentPeriod.startMs).toBeDefined();
      expect(currentPeriod.endMs).toBeDefined();
      expect(precedingPeriod).toEqual({
        startMs: currentPeriod.startMs! - (currentPeriod.endMs! - currentPeriod.startMs!),
        endMs: currentPeriod.startMs,
      });
      for (const slice of relativeBatch.results) expect(slice.comparison?.query.period).toEqual(precedingPeriod);
    } finally { clock.mockRestore(); }
    const shown = result.results.find(slice => slice.key === getUsageQueryKey(query))!;
    expect(shown.work?.allocations).toMatchObject([{ reason: 'allocated', contributionId: contribution.id, outcome: { repositoryKey: 'repo' } }]);
    expect(result.results.find(slice => slice.key === getUsageQueryKey(other))?.work?.allocations)
      .toMatchObject([{ reason: 'missing_evidence', outcome: null }]);
    expect(shown.sources).toContainEqual({ source: 'work', status: 'partial', asOfMs: expect.any(Number) });
    expect(shown.howYouWork?.intervals?.agentTimeMs).toBe(100);
    const workSlice = result.results.find(slice => slice.key === getUsageQueryKey(workOnly))!;
    expect(workSlice.work?.allocations[0]?.reason).toBe('allocated');
    expect(workSlice.howYouWork?.intervals).toBeNull();
    expect(workSlice.sources).toContainEqual({ source: 'how_you_work', status: 'not_loaded' });
    const accountingSlice = result.results.find(slice => slice.key === getUsageQueryKey(accountingOnly))!;
    expect(accountingSlice.accounting?.totals.tokens.total).toBe(15);
    expect(accountingSlice.work).toBeUndefined();
    expect(accountingSlice.sources).toContainEqual({ source: 'work', status: 'not_loaded' });
    // Private evidence belongs to its admitted window and filters. A new
    // relative window gets its own projection; the original two stay reusable.
    expect(evidenceDemands()).toHaveLength(6);
    const admittedTranscripts = [query, other, normalizeUsageQuery({ ...relative, includeSessionEvidence: true })]
      .map(query => ({ query, sessionIds: ['session'] }));
    expect(transcriptDemands()).toHaveLength(admittedTranscripts.length);
    expect(transcriptDemands()).toEqual(expect.arrayContaining(admittedTranscripts));
    const machine = createHydratedPlainMachineFixture({ id: 'work-machine', accountId: 'account-a', machine: { activeAt: Date.now() } });
    await publishMachineInventoryForTest(captured.accountLifetime.scope, [machine]);
    const hostEntry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [workOnly] }) });
    const release = hostEntry.subscribe(() => {}, true);
    try {
      await hostEntry.refresh();
      await expect.poll(() => hostEntry.getSnapshot().pending).toBe('idle');
      expect(decodeUsageQueryResource(hostEntry.getSnapshot().value!).results[0]?.work?.allocations[0]?.reason).toBe('allocated');
      const beforeHostFlip = home!.requests.filter(request => request.path === '/v2/usage/query').length;
      scmTransport.mockClear();
      // The same Work admission observes the current RPC outcome after a route change.
      let routeAvailable = false;
      scmTransport.mockImplementation(async request => {
        if (!routeAvailable) throw createRpcCallError({ error: 'Machine unavailable', errorCode: 'target_unavailable' });
        return workBatch(request, { status: 'partial', evidence: [] });
      });
      const scope = captured.accountLifetime.scope;
      const projectLookup = vi.spyOn(storage.getState(), 'getProjectForSession');
      const projectReads = () => projectLookup.mock.calls.filter(([sessionId, serverId]) =>
        sessionId === contribution.sessionId && serverId === scope.serverId).length;
      try {
        recordMachineRequestFailed({ ...scope, serverId: 'foreign-home', machineId: machine.id });
        expect.soft(projectReads(), 'foreign Home reachability does no Work Session project reads').toBe(0);
        recordMachineRequestFailed({ ...scope, accountId: 'foreign-account', machineId: machine.id });
        expect.soft(projectReads(), 'foreign Account reachability does no Work Session project reads').toBe(0);
        projectLookup.mockClear();
        // Only this admitted Session makes the Machine a consumer.
        recordMachineRequestFailed({ ...scope, machineId: machine.id });
        expect.soft(projectReads(), 'the admitted Home target requires no store project lookups').toBe(0);
      } finally {
        projectLookup.mockRestore();
      }
      await flushHookEffects();
      await expect.poll(() => {
        const content = hostEntry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.sources.find(source => source.source === 'work')?.status;
      }).toBe('unknown');
      await expect.poll(() => hostEntry.getSnapshot().pending).toBe('idle');
      expect(scmTransport, 'the finite acquisition records one current Work route failure').toHaveBeenCalledTimes(1);
      routeAvailable = true;
      clearMachineRequestReachabilityForMachine(scope, machine.id);
      await expect.poll(() => {
        const content = hostEntry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.sources.find(source => source.source === 'work')?.status;
      }).toBe('partial');
      await expect.poll(() => {
        const content = hostEntry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.work?.allocations[0]?.reason;
      }).toBe('missing_evidence');
      await expect.poll(() => hostEntry.getSnapshot().pending).toBe('idle');
      expect(scmTransport, 'canonical recovery reacquires this admitted Work consumer once').toHaveBeenCalledTimes(2);
      expect(home!.requests.filter(request => request.path === '/v2/usage/query').length,
        'Machine reachability changes Work evidence, not the Account accounting answer').toBe(beforeHostFlip);
    } finally { release(); recordMachineRequestSucceeded({ ...captured.accountLifetime.scope, machineId: machine.id }); }
    const merged = { ...witness, pullRequest: { ...witness.pullRequest, state: 'merged' as const } };
    scmTransport.mockImplementation(async request => workBatch(request, { status: 'partial', evidence: [merged] }));
    const native = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(transcriptDemands(), 'repeating the original window reuses its admitted private projection')
      .toHaveLength(admittedTranscripts.length);
    expect(transcriptDemands()).toEqual(expect.arrayContaining(admittedTranscripts));
    expect(native.results[0]?.work?.allocations[0]).toMatchObject({ reason: 'allocated',
      outcome: { repositoryKey: 'repo', pullRequest: { state: 'merged' } } });
    // The Machine batch boundary preserves failures for the shared Work retention owner.
    scmTransport.mockRejectedValue(new RetryableServerResponseError(503, 'Unavailable'));
    const outage = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, native);
    expect(outage.results[0]?.work?.allocations[0]?.reason).toBe('allocated');
    expect(outage.results[0]?.sources).toContainEqual(expect.objectContaining({ source: 'work', status: 'stale' }));
    for (const transportRefusal of [true, false]) {
      scmTransport.mockImplementation(async request => {
        if (transportRefusal) throw new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN);
        return workBatch(request, { status: 'error', evidence: [], branchEvidence: [], errorCode: RPC_ERROR_CODES.FORBIDDEN });
      });
      const refused = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, outage);
      expect(refused.results[0]?.work?.allocations[0]).toMatchObject({ reason: 'missing_evidence', outcome: null, evidence: [] });
      expect(refused.results[0]?.work?.outcomes).toEqual([]);
      scmTransport.mockRejectedValue(new RetryableServerResponseError(503, 'Unavailable'));
      const laterOutage = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, refused);
      expect(laterOutage.results[0]?.work?.allocations[0]?.reason).toBe('missing_evidence');
    }
    const { pullRequest: _pullRequest, ...checkpoint } = witness;
    const branchWitness = { ...checkpoint, branch: { ref: 'refs/heads/standalone', headSha: 'b'.repeat(40) } };
    scmTransport.mockImplementation(async request => workBatch(request, { status: 'partial', evidence: [], branchEvidence: [branchWitness] }));
    const standalone = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(standalone.results[0]?.work?.branchAllocations[0]).toMatchObject({ reason: 'allocated', contributionId: contribution.id,
      branch: { repositoryKey: 'repo', branch: { ref: 'refs/heads/standalone' } } });
    expect(standalone.results[0]?.work?.branchAllocations[0]?.branch).not.toHaveProperty('contributionIds');
    expect(standalone.results[0]?.work?.branches).toEqual([expect.objectContaining({
      repositoryKey: 'repo', branch: { ref: 'refs/heads/standalone', headSha: 'b'.repeat(40) }, contributionIds: ['cost'],
    })]);
    expect(standalone.results[0]?.work?.outcomes).toEqual([]);
    // A local branch remains readable without a remote. Unsupported hosting
    // does not become a failed Work read or poison its exact branch evidence.
    expect(standalone.results[0]?.sources).toContainEqual({ source: 'work', status: 'partial', asOfMs: expect.any(Number) });
    scmTransport.mockImplementation(async request => workBatch(request, { status: 'partial', evidence: [merged], errorCode: 'COMMAND_FAILED' }));
    const partial = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(partial.results[0]?.sources).toContainEqual({ source: 'work', status: 'partial', asOfMs: expect.any(Number),
      unreadSessions: { failed: 1 } });
    expect(partial.results[0]?.work?.allocations[0]?.reason).toBe('allocated');
    scmTransport.mockRejectedValue(new RetryableServerResponseError(503, 'Unavailable'));
    const partialFailure = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, partial);
    const observedWork = partialFailure.results[0]!.sources.find(source => source.source === 'work')!;
    expect(observedWork).toMatchObject({ status: 'stale', errorCode: 'work_evidence_failed' });
    const workProgress: typeof observedWork[] = [];
    const retried = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, partialFailure,
      { onProgress: project => { workProgress.push(project().results[0]!.sources.find(source => source.source === 'work')!); } });
    expect(workProgress.length).toBeGreaterThan(0);
    expect(workProgress).toContainEqual({ source: 'work', status: 'pending', asOfMs: observedWork.asOfMs });
    expect(workProgress.every(source => source.asOfMs === observedWork.asOfMs),
      'a replacement pending after failure keeps the readable answer dated').toBe(true);
    expect(retried.results[0]!.sources.find(source => source.source === 'work')).toBe(observedWork);
    scmTransport.mockImplementation(async request => workBatch(request, { status: 'unsupported' }));
    const unsupported = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(unsupported.results[0]?.sources).toContainEqual({ source: 'work', status: 'unsupported', asOfMs: expect.any(Number) });
    expect(unsupported.results[0]?.work?.allocations[0]).toMatchObject({ reason: 'missing_evidence', outcome: null, evidence: [] });
    scmTransport.mockImplementation(async request => workBatch(request, { status: 'unsupported', errorCode: 'FEATURE_UNSUPPORTED' }));
    const unavailableBackend = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(unavailableBackend.results[0]?.sources).toContainEqual({ source: 'work', status: 'unsupported',
      asOfMs: expect.any(Number), unreadSessions: { failed: 1 } });
    scmTransport.mockImplementation(async request => workBatch(request, { status: 'error', evidence: [], branchEvidence: [], errorCode: 'INVALID_REQUEST' }));
    const denied = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(denied.results[0]?.work?.outcomes).toEqual([]);
    expect(denied.results[0]?.work?.allocations[0]?.evidence).toEqual([]);
    const detail = createDeferred<unknown>();
    scmTransport.mockImplementation(() => detail.promise);
    const store = getUsageQueryResourceStore(captured);
    const entry = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const observed: Array<{ pending: boolean; accounting: boolean; allocated: boolean }> = [];
    const unsubscribe = entry.subscribe(() => {
      const value = entry.getSnapshot().value;
      if (!value) return;
      const slice = decodeUsageQueryResource(value).results[0]!;
      observed.push({ pending: slice.sources.some(source => source.source === 'work' && source.status === 'pending'),
        accounting: !!slice.accounting, allocated: slice.work?.allocations.some(row => row.reason === 'allocated') ?? false });
    }, true);
    await flushHookEffects({ cycles: 30 });
    expect(observed).toContainEqual({ pending: true, accounting: true, allocated: false });
    detail.resolve(ScmWorkEvidenceReadResponseSchema.parse({ sessions: [{ sessionId: 'session', status: 'partial', evidence: [witness] }] }));
    await flushHookEffects({ cycles: 30 });
    expect(observed.at(-1)).toEqual({ pending: false, accounting: true, allocated: true });
    unsubscribe();
    store.dispose();
    const retired = { ...captured, accountLifetime: { ...captured.accountLifetime, isCurrent: () => false } };
    await expect(readUiUsageQueryBatch(retired, { queries: [query] })).rejects.toMatchObject({ code: 'stale_surface' });
  });
});


describe('Usage compact fact publication', () => {
  it.each(['socket', 'scoped'] as const)('returns from Work 7D with retained accounting and re-admits named compact facts without reading transcripts (%s)', async delivery => {
    const [{ createUsageSessionWorkFactsV1, USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS },
      { buildSessionSystemRecordChangeV1 }] = await Promise.all([
      import('@happier-dev/protocol/usage/usageWorkEvidence'),
      import('@happier-dev/protocol/sessions/board/changeHint'),
    ]);
    let nowMs = 1_710_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const id = 'published-compact-session';
    const session = projectUsageSessionInput(createSessionFixture({ id, seq: 1, active: false,
      encryptionMode: 'plain', createdAt: nowMs - 1000, updatedAt: nowMs - 100 }));
    const fact = createUsageSessionWorkFactsV1(session,
      projectSessionUsageWorkEvidence(session, [], { messagesComplete: true }));
    let converted = false;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })),
        results: [{ sessionId: id, workFacts: { session: { id, seq: 1, active: false,
          createdAt: nowMs - 1000, updatedAt: nowMs - 100,
          metadataVersion: session.metadataVersion ?? 0, agentStateVersion: session.agentStateVersion ?? 0,
          metadataLayoutVersion: session.metadataLayoutVersion ?? 0, encryptionMode: 'plain', dataEncryptionKey: null,
          viewerRole: 'owner', access: ownerSessionAccess.effectiveAccess },
          records: [{ kind: 'work', content: converted ? { t: 'plain', v: projectNativeJsonValueForTransport(fact) } : null }] },
          turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: nowMs - 100, turns: [] } } }],
      } satisfies UsageSessionEvidenceResponse);
    });
    const requestStart = home!.requests.length;
    const query = normalizeUsageQuery({ period: { relative: '90days' }, includeComparison: false, includeCoach: false, includeWorkEvidence: false });
    const store = getUsageQueryResourceStore(captured);
    const entry = store.getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    let publications = 0;
    const observe = () => { publications++; };
    let release = entry.subscribe(observe, true);
    const read = async () => {
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => entry.getSnapshot().pending === 'idle' && entry.getSnapshot().value != null).toBe(true);
      return decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.howYouWork;
    };
    const accountingReads = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch').length;
    const demands = () => home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
    const publish = (sessionId: string) => {
      const change = buildSessionSystemRecordChangeV1('published-compact-record', {
        sessionId, address: USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS,
      });
      const detail = { changeKinds: [change.kind], sessionSystemRecords: [change.hint.sessionRecords] };
      if (delivery === 'scoped') {
        // A typed producer fact is the Usage consumer's boundary. The socket
        // case above it also exercises that fact's real producer classification.
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, [change.entityId], {
          ...detail, usageAccountingAffects: false,
        });
      } else publishHomeAccountChangeWake(captured.accountLifetime.scope.serverId, {
        t: 'account-change', ...detail, entityIds: [change.entityId],
      }, 'socket');
    };
    try {
      expect((await read())?.sessionCoverage).toMatchObject({ selected: 1, admitted: 1, notRead: 1 });
      const admittedAccounting = accountingReads();
      expect(admittedAccounting, 'One resolved request admits one accounting batch').toBe(1);
      release();
      const work = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [
        normalizeUsageQuery({ ...query, period: { relative: '7days' }, includeSessionEvidence: false, includeWorkEvidence: true }),
      ] }) });
      release = work.subscribe(() => {}, true);
      await flushHookEffects({ cycles: 20 });
      await expect.poll(() => work.getSnapshot().pending === 'idle' && work.getSnapshot().value != null).toBe(true);
      expect(accountingReads(), 'Work admits its distinct seven-day request once').toBe(admittedAccounting + 1);
      nowMs += 5 * 60_000;
      converted = true;
      publish(id);
      await flushHookEffects({ cycles: 20 });
      release();
      release = entry.subscribe(observe, true);
      expect((await read())?.sessionCoverage).toMatchObject({ selected: 1, admitted: 1, notRead: 0 });
      expect.soft(accountingReads(), 'Returning to Overview after a private fact wake keeps both resolved accounting admissions')
        .toBe(admittedAccounting + 1);
      converted = false;
      publish(id);
      expect((await read())?.sessionCoverage).toMatchObject({ selected: 1, admitted: 1, notRead: 1 });
      const initialReads = demands().length;
      const beforeUnrelated = publications;
      publish('another-compact-session');
      expect((await read())?.sessionCoverage).toMatchObject({ notRead: 1 });
      expect(demands()).toHaveLength(initialReads);
      expect.soft(publications - beforeUnrelated, 'An unconsumed compact record changes no Overview fact or read activity').toBe(0);
      converted = true;
      publish(id);
      expect((await read())?.sessionCoverage).toMatchObject({ selected: 1, admitted: 1, notRead: 0 });
      expect(demands().length).toBeGreaterThan(initialReads);
      expect(publications).toBeGreaterThan(beforeUnrelated);
      converted = false;
      publish(id);
      expect((await read())?.sessionCoverage).toMatchObject({ selected: 1, admitted: 1, notRead: 1 });
      expect(demands().filter(demand => demand.query.includeTranscriptEvidence)).toEqual([]);
      expect(home!.requests.slice(requestStart).filter(request => request.path === '/v2/sessions/read-batch'
        || request.method === 'GET' && /^\/v2\/sessions\//.test(request.path))).toEqual([]);
      expect(accountingReads() - admittedAccounting - 1,
        'Private compact-fact publications refresh evidence without replacing accounting').toBe(0);
    } finally { release(); }
  });
});


describe('Usage projected batch settlement', () => {
  it('leaves unread history retryable after a request-level 503 without failing every selected Session', async () => {
    const nowMs = Date.UTC(2026, 10, 9);
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const ids = ['request-unread-a', 'request-unread-b', 'request-unread-c'];
    const deniedId = 'request-lasting-gap';
    let unavailable = true;
    const transcriptRequests: string[][] = [];
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const demand = UsageSessionEvidenceRequestSchema.parse(request.body).requests[0]!;
      const requested = demand.sessionIds ?? [...ids, deniedId];
      if (demand.query.includeTranscriptEvidence) {
        transcriptRequests.push([...requested]);
        if (unavailable) return Response.json({ error: 'database_transaction_timeout' }, { status: 503 });
      }
      return Response.json({ requests: [{ query: demand.query, sessionIds: requested }], results: requested.map(id => ({ sessionId: id,
        detail: id === deniedId ? { status: 403, body: { error: 'forbidden' } }
          : { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1, active: false,
            createdAt: nowMs - 1000, updatedAt: nowMs - 100 }) } },
        turns: { status: 200, body: { v: 1 as const, sessionId: id, updatedAt: nowMs - 100, turns: [] } },
        ...(demand.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
      })) } satisfies UsageSessionEvidenceResponse);
    });
    const query = normalizeUsageQuery({ period: { relative: '90days' }, includeWorkEvidence: false, includeComparison: false });
    const { readUiUsageHistory } = await import('./usageQueryResource');
    const { describeUsageHistoryRead } = await import('@/components/settings/usage/widgets/usageBodyKit');
    await readUiUsageQueryBatch(captured, { queries: [query] });
    const interrupted = await readUiUsageHistory(captured, { query });
    expect.soft(interrupted).toMatchObject({ status: 'partial',
      errorCode: 'database_transaction_timeout', progress: { selected: 4, notRead: 3, completed: 0, failed: 0 } });
    expect.soft(describeUsageHistoryRead(interrupted)).toMatchObject({ operation: 'read', failed: true });
    unavailable = false;
    const recovered = await readUiUsageHistory(captured, { query });
    expect(recovered).toMatchObject({ status: 'partial', errorCode: 'forbidden',
      progress: { selected: 4, notRead: 0, completed: 3, failed: 0 } });
    expect(describeUsageHistoryRead(recovered)).toBeNull();
    expect(transcriptRequests).toEqual([ids, ids]);
  });

  it.each(['detail-forbidden', 'transcript-forbidden', 'unavailable-detail', 'transient-detail'] as const)(
    'settles per-Session history coverage with its typed reason and retries only transient failure (%s)', async failure => {
      const nowMs = Date.UTC(2026, 10, 6);
      vi.spyOn(Date, 'now').mockReturnValue(nowMs);
      const id = 'classified-history-session';
      let fail = true;
      let transcriptReads = 0;
      let detailReads = 0;
      const captured = await context(request => {
        if (request.path === '/v2/usage/query') return Response.json(value);
        if (request.method === 'PUT' && request.path === `/v2/sessions/${id}/system-records`) return successfulUsageFactWrite(request.body);
        if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
        const demand = UsageSessionEvidenceRequestSchema.parse(request.body).requests[0]!;
        if (demand.query.includeTranscriptEvidence) transcriptReads++; else detailReads++;
        const detail: UsageSessionEvidenceResponse['results'][number]['detail'] = fail && failure === 'detail-forbidden'
          ? { status: 403, body: { error: 'forbidden' } }
          : fail && failure === 'transient-detail' ? { status: 503, body: { error: 'unavailable' } }
            : { status: 200, body: { session: { ...createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1, active: false,
                createdAt: nowMs - 1000, updatedAt: nowMs - 100 }),
              ...(fail && failure === 'unavailable-detail' ? { metadata: JSON.stringify([]) } : {}) } } };
        return Response.json({ requests: [{ query: demand.query, sessionIds: [id] }], results: [{ sessionId: id, detail,
          turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: nowMs - 100, turns: [] } },
          ...(demand.query.includeTranscriptEvidence ? fail && failure === 'transcript-forbidden'
            ? { messages: { status: 403, body: { error: 'forbidden' } } }
            : { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
        }] } satisfies UsageSessionEvidenceResponse);
      });
      const query = normalizeUsageQuery({ period: { relative: '7days' }, includeWorkEvidence: false, includeComparison: false });
      const { getUiUsageHistoryState } = await import('./usageQueryResource');
      const { describeUsageHistoryRead } = await import('@/components/settings/usage/widgets/usageBodyKit');
      const read = () => readUiUsageQueryBatch(captured, { queries: [query] });
      await read();
      const lasting = failure !== 'transient-detail';
      const state = getUiUsageHistoryState(captured, query);
      expect.soft(state).toMatchObject({ status: 'partial', errorCode: failure === 'unavailable-detail' ? 'metadata_unavailable'
        : lasting ? 'forbidden' : 'http_error', progress: { ...(lasting ? { selected: 1 } : {}), failed: lasting ? 0 : 1, notRead: 0 } });
      expect.soft(describeUsageHistoryRead(state)?.failed ?? false).toBe(!lasting);
      const before = { detailReads, transcriptReads };
      await read();
      if (lasting) expect.soft({ detailReads, transcriptReads }, 'settled refusal does not reread unchanged Session input').toEqual(before);
      fail = false;
      publishHomeAccountChangeWake(captured.accountLifetime.scope.serverId,
        { t: 'account-change', changeKinds: ['session'], entityIds: [id] }, 'socket');
      await read();
      expect(getUiUsageHistoryState(captured, query)).toMatchObject({ status: 'complete', progress: { failed: 0, notRead: 0 } });
      expect(transcriptReads).toBeGreaterThan(before.transcriptReads);
    });

  it('keeps a failed history selection partial without inventing failed Sessions', async () => {
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === USAGE_SESSION_EVIDENCE_PATH) return Response.json({ error: 'database_transaction_timeout' }, { status: 503 });
      return undefined;
    });
    const query = normalizeUsageQuery({ period: { relative: '90days' }, includeWorkEvidence: false, includeComparison: false });
    const { readUiUsageHistory } = await import('./usageQueryResource');
    expect(await readUiUsageHistory(captured, { query })).toMatchObject({ status: 'partial',
      errorCode: 'database_transaction_timeout', progress: { failed: 0 } });
  });

  it.each([{ body: { error: 'credential_scope_denied' }, code: 'credential_scope_denied' },
    { body: {}, code: 'forbidden' }])('settles a refused history selection without Retry ($code)', async ({ body, code }) => {
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === USAGE_SESSION_EVIDENCE_PATH) return Response.json(body, { status: 403 });
      return undefined;
    });
    const query = normalizeUsageQuery({ period: { relative: '90days' }, includeWorkEvidence: false, includeComparison: false });
    const { readUiUsageHistory } = await import('./usageQueryResource');
    const { getUsageHistoryReadOperation } = await import('./usageHistoryReadState');
    const state = await readUiUsageHistory(captured, { query });
    expect.soft(state).toMatchObject({ status: 'partial', errorCode: code, progress: { failed: 0 } });
    expect(getUsageHistoryReadOperation(state)).toBeNull();
  });

  it('counts one failed Session across two failed reads and removes it after a successful read', async () => {
    const nowMs = Date.UTC(2026, 10, 6);
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const id = 'retry-distinct-session';
    let failWrite = true;
    let writeAttempts = 0;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.method === 'PUT' && request.path === `/v2/sessions/${id}/system-records`) {
        writeAttempts++;
        return failWrite ? Response.json({ error: 'storage_unavailable' }, { status: 503 })
          : successfulUsageFactWrite(request.body);
      }
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const demand = UsageSessionEvidenceRequestSchema.parse(request.body).requests[0]!;
      return Response.json({ requests: [{ query: demand.query, sessionIds: [id] }], results: [{ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1, active: false,
          createdAt: nowMs - 1000, updatedAt: nowMs - 100 }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: nowMs - 100, turns: [] } },
        ...(demand.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
      }] } satisfies UsageSessionEvidenceResponse);
    });
    const query = normalizeUsageQuery({ period: { relative: '7days' }, includeWorkEvidence: false, includeComparison: false });
    const { getUiUsageHistoryState } = await import('./usageQueryResource');
    for (let attempt = 1; attempt <= 2; attempt++) {
      await readUiUsageQueryBatch(captured, { queries: [query] });
      expect(writeAttempts).toBe(attempt);
      expect.soft(getUiUsageHistoryState(captured, query)).toMatchObject({ status: 'partial', progress: { failed: 1 } });
    }
    failWrite = false;
    await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(getUiUsageHistoryState(captured, query)).toMatchObject({ status: 'complete', progress: { failed: 0 } });
  });

  it.each(['90days', '7days'] as const)('publishes %s conversion progress before a held sibling and keeps automatic failures non-actionable', async relative => {
    const nowMs = Date.UTC(2026, 10, 6);
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const ids = ['progress-converted', 'progress-held'];
    const saved = createDeferred<void>();
    const release = createDeferred<void>();
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) {
        saved.resolve();
        return successfulUsageFactWrite(request.body);
      }
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      const demand = input.requests[0]!;
      const results: UsageSessionEvidenceResponse['results'] = (demand.sessionIds ?? ids).map(id => ({ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1, active: false,
          createdAt: nowMs - 1000, updatedAt: nowMs - 100 }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: nowMs - 100, turns: [] } },
        ...(demand.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
      }));
      const requests = [{ query: demand.query, sessionIds: demand.sessionIds ?? ids }];
      if (!demand.query.includeTranscriptEvidence) return Response.json({ requests, results } satisfies UsageSessionEvidenceResponse);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode([JSON.stringify({ requests }), JSON.stringify(results[0]), ''].join('\n'))); },
        async pull(controller) { await release.promise; controller.error(new TypeError('Network request failed')); },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    const query = normalizeUsageQuery({ period: { relative }, includeWorkEvidence: false, includeComparison: false });
    const { readUiUsageHistory, getUiUsageHistoryState } = await import('./usageQueryResource');
    if (relative === '90days') await readUiUsageQueryBatch(captured, { queries: [query] });
    const pending = relative === '90days' ? readUiUsageHistory(captured, { query })
      : readUiUsageQueryBatch(captured, { queries: [query] });
    try {
      await saved.promise;
      if (relative === '90days') await expect.poll(() => getUiUsageHistoryState(captured, query)).toMatchObject({
        status: 'reading', progress: { completed: 1, notRead: 1 } });
      else expect(getUiUsageHistoryState(captured, query).progress.notRead).toBe(0);
    } finally { release.resolve(); await pending; }
    // Preserve the transport's typed cause rather than the former generic read failure.
    expect(getUiUsageHistoryState(captured, query)).toMatchObject({ status: 'partial',
      errorCode: 'network_error', progress: { completed: relative === '90days' ? 1 : 0,
        notRead: relative === '90days' ? 1 : 0, failed: 1 } });
  });

  it.each(['transport', 'invalid-row'] as const)('retains converted Session facts when a later sibling interrupts the projected stream (%s)', async failure => {
    const nowMs = Date.UTC(2026, 10, 6);
    const baseMs = nowMs - 1000;
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const ids = ['converted-before-interruption', 'unfinished-after-interruption'];
    const saved = createDeferred<void>();
    const writes: { path: string; kind: string }[] = [];
    let interrupted = false;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) {
        const { content } = SessionSystemRecordStoredUpsertRequestSchema.parse(request.body);
        const fact = usageWorkEvidence.UsageSessionFactRecordV1Schema.parse(content.t === 'plain' ? content.v : null);
        writes.push({ path: request.path, kind: fact.kind });
        saved.resolve();
        return successfulUsageFactWrite(request.body);
      }
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      const demand = input.requests[0]!;
      const results: UsageSessionEvidenceResponse['results'] = (demand.sessionIds ?? ids).map(id => ({ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1, active: false, createdAt: baseMs, updatedAt: baseMs + 900 }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: baseMs + 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: baseMs + 100, terminalAt: baseMs + 400, updatedAt: baseMs + 900 },
        ] } }, ...(demand.query.includeTranscriptEvidence ? { messageEvidence: { acceptedInputs: [{
          inputId: 'accepted', workId: JSON.stringify([id, 'turn']), acceptedAtMs: baseMs + 200, deliveryKind: 'steer', turnId: 'turn',
        }] }, messagesComplete: true } : {}),
      }));
      const requests = [{ query: demand.query, sessionIds: demand.sessionIds ?? ids }];
      if (!demand.query.includeTranscriptEvidence) return Response.json({ requests, results } satisfies UsageSessionEvidenceResponse);
      if (interrupted) return Response.json({ requests, results } satisfies UsageSessionEvidenceResponse);
      interrupted = true;
      if (failure === 'invalid-row') return new Response([JSON.stringify({ requests }), JSON.stringify(results[0]),
        JSON.stringify({ sessionId: ids[1], detail: { status: 200, body: { session: null } } }), ''].join('\n'),
        { headers: { 'Content-Type': 'application/x-ndjson' } });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([JSON.stringify({ requests }), JSON.stringify(results[0]), ''].join('\n')));
        },
        async pull(controller) { await saved.promise; controller.error(new TypeError('Network request failed')); },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    const query = normalizeUsageQuery({ period: { relative: '90days' }, includeWorkEvidence: false, includeComparison: false });
    const { readUiUsageHistory } = await import('./usageQueryResource');
    expect((await readUiUsageQueryBatch(captured, { queries: [query] })).results[0]?.howYouWork?.sessionCoverage)
      .toMatchObject({ selected: 2, admitted: 2, notRead: 2 });
    const result = await readUiUsageHistory(captured, { query });
    expect(writes).toEqual(['coach', 'work'].map(kind => ({ path: `/v2/sessions/${ids[0]}/system-records`, kind })));
    expect(result).toMatchObject({ status: 'partial', progress: { selected: 2, notRead: 1, completed: 1, failed: 1 } });
    const reopened = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(reopened.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ selected: 2, admitted: 2, notRead: 1 });
    expect(reopened.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 1, steeringCount: 1 });
    expect(home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests)
      .filter(demand => demand.query.includeTranscriptEvidence)).toHaveLength(1);
    const retried = await readUiUsageHistory(captured, { query });
    expect(retried).toMatchObject({ status: 'complete', progress: { selected: 2, notRead: 0, completed: 1, failed: 0 } });
    expect(writes).toEqual(ids.flatMap(id => ['coach', 'work'].map(kind => ({ path: `/v2/sessions/${id}/system-records`, kind }))));
    const transcriptDemands = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests)
      .filter(demand => demand.query.includeTranscriptEvidence);
    expect(transcriptDemands.map(demand => demand.sessionIds)).toEqual([ids, [ids[1]]]);
  });
});
