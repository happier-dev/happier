import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServedHomeAccountToken, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageWorkEvidence } from '@happier-dev/protocol/usage/usageOutcomeAllocation';
import { collectUsageWorkSources } from '@happier-dev/protocol/usage/usageWorkSources';
import { collectUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery, resolveEffectiveUsageCostUsd } from '@happier-dev/protocol/usage/usageCost';
import { aggregateUsageContributionCosts } from '@happier-dev/protocol/usage/usageAggregation';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { scmFallbackError } from '@/sync/ops/scm/scmRpcFailure';
import { RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore, invalidateUsageQueryResources, readUiUsageQueryBatch } from './usageQueryResource';
import { storage } from '@/sync/domains/state/storage';
import { publishHomeAccountChange, publishHomeAccountChangeWake, subscribeHomeAccountChange, type HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { buildConnectedAccountCatalogPhysicalKeyV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { ApiChangeEntry } from '@/sync/api/types/apiTypes';
import { createArtifactReadBatchHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { planSyncActionsFromChanges, plannedChangesAffectUsageQuery, plannedChangesAffectUsageAccounting } from '@/sync/runtime/orchestration/changesPlanner';
// These source-adapter tests do not register unrelated Settings surfaces.
// Keep the canonical helpers without the presentation harness barrel graph.
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { QualifiedConnectedAccountGroupV4Schema} from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryBatchResponseSchema, getUsageAnalyticsQueryRequestKey } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { createSessionAccessFixture, createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainSessionWithDisplayRecordFixture as createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { QualifiedConnectedAccountQuotaResponseV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { QualifiedProviderAccountUsageHistoryRequestV4Schema, ProviderAccountUsagePageProjectionReadV1Schema, ProviderAccountUsagePageProjectionWriteV1Schema, ConnectedServiceQuotaGetResultV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
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
import { createUsageQuerySessionInputs, type SessionInputEvidence } from './usageQuerySessionInputs';
import { projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { projectUsageSessionInput } from '@/sync/domains/usage/usageWorkEvidence';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, UsageSessionStateEvidenceSchema,
  type UsageSessionEvidenceResponse } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { projectSessionUsageWorkEvidence as projectOpenedSessionUsageWorkEvidence,
  projectUsageSessionStateEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { parsePlainSessionMetadata, parsePlainSessionAgentStateResult } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import * as machineRpcBoundary from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { buildUsageBreakdownList } from '@happier-dev/protocol/usage/usageLeaderProjection';
import { formatUsageCost } from '@happier-dev/protocol/usage/usageFormatting';
import { summarizeUsageWork } from '@/components/settings/usage/widgets/usageWorkPresentation';
import { buildUsagePriceEditorModel } from '@/sync/domains/usage/usagePriceEditorModel';
import { resolveUsageShownCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
import { createUiCoachSuppressionPort } from './usageCoachSuppressions';
import { USAGE_COACH_SUPPRESSIONS_KV_KEY } from '@happier-dev/protocol/usage/coach/coachActions';

const scmTransport = vi.hoisted(() => vi.fn());
// These Homes are served at the HTTP boundary; prevent real Engine.IO dials
// from withdrawing their admitted Machine presence during Resource reads.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
// Vitest 3.2.4's manual factory can bypass a mock during concurrent lazy
// imports. Automatic spy registration keeps every RPC on this same boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', { spy: true });
beforeEach(() => { vi.spyOn(machineRpcBoundary, 'machineRpcWithServerScope').mockImplementation(scmTransport); });

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
let homeSequence = 0;
let sessionBatchBoundary: ReturnType<typeof createSessionReadBatchHttpBoundary> | undefined;
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
const workContribution = { id: 'cost', observedAtMs: 500, sessionId: 'work-session', turnId: 'turn', agentId: null,
  modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
  tokens: value.totals.tokens, cost: value.totals.cost };

const ownerSessionAccess = {
  effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
    capabilities: createSessionAccessFixture().capabilities },
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
  sessionBatchBoundary = createSessionReadBatchHttpBoundary(route);
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: `https://usage-batch-${++homeSequence}.test`, accountId: 'account-a', profile, settings, ...homeOptions }],
    route: async request => {
      if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
        const explicit = await route(request);
        if (explicit) return explicit;
        // Reuse external Session source fixtures behind the new Usage HTTP
        // wire. Production still executes the actual parser, admission, cache
        // and client E2EE opening; no internal reader is mocked.
        const input = UsageSessionEvidenceRequestSchema.parse(request.body);
        const selections = input.requests.map(demand => ({ query: demand.query,
          sessionIds: demand.sessionIds ?? (demand.query.session === null ? Object.keys(storage.getState().sessions)
            : typeof demand.query.session === 'string' ? [demand.query.session] : demand.query.session) }));
        const results: UsageSessionEvidenceResponse['results'] = [];
        for (const selection of selections) {
          const batchRequest = { ...request, path: '/v2/sessions/read-batch', url: new URL('/v2/sessions/read-batch', request.url),
            body: { sessionIds: selection.sessionIds, includeSnapshot: true, includeTurns: true,
              includeMessages: selection.query.includeTranscriptEvidence, accessProjectionVersion: 1 } };
          const response = (await sessionBatchBoundary!.handle(batchRequest))!;
          if (!response.ok) return response;
          const payload: unknown = await response.json();
          const parsed = SessionReadBatchResponseV1Schema.safeParse(payload);
          if (!parsed.success) return Response.json({ requests: selections,
            results: payload && typeof payload === 'object' && 'results' in payload ? payload.results : null });
          for (const row of parsed.data.results) {
            if (row.detail?.status !== 200 || row.detail.body.session.encryptionMode !== 'plain') {
              results.push(row);
              continue;
            }
            const record = row.detail.body.session;
            const metadata = record.metadataLayoutVersion === 1 && record.ownerMetadata?.t === 'plain'
              ? projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(record.metadata), ownerMetadata: record.ownerMetadata.v })
              : parsePlainSessionMetadata(record.metadata, record.metadataLayoutVersion);
            const state = parsePlainSessionAgentStateResult(record.agentState);
            const stateEvidence = state.status === 'available' ? UsageSessionStateEvidenceSchema.parse(projectUsageSessionStateEvidence({ id: row.sessionId,
              metadata: metadata ? { machineId: metadata.machineId ?? undefined, actionConfirmationsV1: metadata.actionConfirmationsV1 } : null,
              agentState: state.value, ...(row.turns?.status === 200 ? { sessionTurns: row.turns.body } : {}) })) : undefined;
            const { actionConfirmationsV1: _confirmations, ...safeMetadata } = record.metadataLayoutVersion === 1
              ? JSON.parse(record.metadata) : metadata ?? {};
            const projected = { ...row, detail: { ...row.detail, body: { ...row.detail.body,
              session: { ...record, agentState: null, metadata: JSON.stringify(safeMetadata) } } },
              ...(stateEvidence ? { stateEvidence } : {}) };
            if (row.messages?.status !== 200) { results.push(projected); continue; }
            const messages = await Promise.all(row.messages.body.messages.map(message => readStoredSessionMessage({ message, sessionEncryptionMode: 'plain' })));
            const opened = messages.filter((message): message is NonNullable<typeof message> => message !== null && message.content !== null);
            const complete = !row.messages.body.hasMore && opened.length === messages.length;
            const { messages: _messages, ...parts } = projected;
            if (messages.length > 0 && opened.length === 0) { results.push(parts); continue; }
            const detail = projectOpenedSessionUsageWorkEvidence({ id: row.sessionId, metadata: null, agentState: null,
              ...(row.turns?.status === 200 ? { sessionTurns: row.turns.body } : {}) }, opened,
              { messagesComplete: complete });
            results.push({ ...parts, messageEvidence: { acceptedInputs: detail.acceptedInputs, phaseEvents: detail.phaseEvents,
              coach: detail.coach, collaboration: detail.collaboration }, messagesComplete: complete });
          }
        }
        return Response.json({ requests: selections, results });
      }
      if (request.path === '/v4/connect/qualified/provider-account-usage/history' && request.method === 'PUT') {
        const projection = ProviderAccountUsagePageProjectionWriteV1Schema.parse(request.body);
        projections.set(projection.recordId, projection);
        return Response.json({ success: true });
      }
      const response = await sessionBatchBoundary!.handle(request);
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
  it.each(['http', 'detail', 'turns', 'messages'] as const)('retains accounting when projected historical Usage evidence admission is refused (%s)', async component => {
    const id = 'refused-historical';
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json({ ...value, contributions: undefined,
        sessionIds: [id], sessionMembership: { turns: [{ sessionId: id, turnId: 'turn', executions: ['happier'] }] } });
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      if (input.requests[0]!.sessionIds === undefined) return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [] })), results: [] });
      if (component === 'http') return Response.json({ error: 'forbidden' }, { status: 403 });
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
      errorCode: 'usage_session_evidence_read_failed' }));
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
    const result = await readUiUsageQueryBatch(captured, { queries: [query] });
    const demands = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
      .flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
    expect(demands.filter(demand => demand.sessionIds === undefined)).toHaveLength(1);
    expect(demands.filter(demand => !demand.query.includeTranscriptEvidence && demand.sessionIds !== undefined)
      .flatMap(demand => demand.sessionIds!).sort()).toEqual([historicalId, nullTurnId].sort());
    expect(demands.filter(demand => demand.query.includeTranscriptEvidence).flatMap(demand => demand.sessionIds ?? []).sort()).toEqual([...selectedIds].sort());
    expect(demands.every(demand => demand.sessionIds?.every(id => selectedIds.includes(id)) ?? true)).toBe(true);
    expect(result.results[0]?.howYouWork?.sessionCoverage).toMatchObject({ selected: 3, admitted: 3 });
    expect(result.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(600);
    expect(result.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 2 });
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

  it.each(['json', 'stream'] as const)('opens opaque Usage evidence only on the authorized E2EE client and releases transcript bodies after projection (%s)', async transport => {
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
    const metadata = await sessionEncryption.encryptMetadata(createSessionFixture({ id }).metadata!);
    const body = 'private body stays on the authorized client';
    const ciphertext = await sessionEncryption.encryptRawRecord({ role: 'user', content: { type: 'text', text: body } });
    const [delivery] = await new AES256Encryption(sessionKey).encrypt([{ v: 1, acceptedAtMs: 200,
      delivery: { kind: 'steer', turnId: 'turn' } }]);
    const { ownerMetadata: _owner, displayProjectionV1: _display, ...base } = createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 });
    const record = { ...base, metadataLayoutVersion: 0, encryptionMode: 'e2ee' as const, dataEncryptionKey, metadata, agentState: null };
    const credentials = { token: createServedHomeAccountToken('account-a'), secret: encodeBase64(secret, 'base64url') };
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      const response = { requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })), results: [{ sessionId: id,
        detail: { status: 200, body: { session: record } }, turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900,
          turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] } },
        ...(input.requests[0]!.query.includeTranscriptEvidence ? { messages: { status: 200, body: { messages: [
          { id: 'opaque', localId: 'accepted', seq: 1, createdAt: 200, updatedAt: 200, content: { t: 'encrypted', c: ciphertext },
            deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'encrypted', c: encodeBase64(delivery!, 'base64') } } },
        ], hasMore: false } } } : {}),
      }] } satisfies UsageSessionEvidenceResponse;
      return transport === 'json' ? Response.json(response) : new Response([
        JSON.stringify({ requests: response.requests }), ...response.results.map(result => JSON.stringify(result)),
      ].join('\n'), { headers: { 'Content-Type': 'application/x-ndjson' } });
    }, undefined, undefined, { credentials, accountMode: 'e2ee',
      encryptionCurrentness: () => createAccountEncryptionCurrentnessFixtureForCredentials(credentials) });
    const before = home!.requests.length;
    const batch = await readUiUsageQueryBatch(captured, { queries: [normalizeUsageQuery({ session: id,
      period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false })] });
    expect(batch.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(300);
    expect(batch.results[0]?.howYouWork?.inputs).toMatchObject({ acceptedCount: 1, steeringCount: 1 });
    expect(JSON.stringify(batch)).not.toContain(body);
    expect(JSON.stringify(batch)).not.toContain(ciphertext);
    expect(home!.requests.slice(before).filter(request => request.path === '/v2/sessions/read-batch'
      || /^\/v[12]\/sessions\/[^/]+(?:\/|$)/.test(request.path) && request.method === 'GET')).toEqual([]);
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
      || /^\/v[12]\/sessions\/[^/]+(?:\/|$)/.test(request.path))).toEqual([]);
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
    } finally { release(); }
  });

  it('retries one failed Usage window without reopening a failed sibling for the same Session', async () => {
    const id = 'projected-retry';
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === USAGE_SESSION_EVIDENCE_PATH) return Response.json({ error: 'denied' }, { status: 403 });
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
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/idle-evidence') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({
        id: 'idle-evidence', createdAt: 1, updatedAt: 900, seq: 1, metadataVersion: 1, agentStateVersion: 1 }) });
      if (request.path === '/v1/sessions/idle-evidence/turns') return Response.json({ v: 1, sessionId: 'idle-evidence', updatedAt: 900,
        turns: [{ turnId: 'idle-turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] });
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
      expect(money(typed)).toEqual([0, 3]);
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
      expect(worked?.work?.allocations.map(row => row.contribution)).toEqual(worked?.accounting?.contributions);
      expect(summarizeUsageWork(worked!.work!, { metric: 'cost', costBasis: 'auto' }).total).toBe(count);
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
        expected.set(selected, selected);
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
      if (request.path === '/v2/usage/query') return Response.json({ ...value, totals: { ...value.totals, eventCount: revision } });
      if (request.path === '/v2/sessions/status-session') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({
        id: 'status-session', createdAt: 1, updatedAt: 900 + revision, seq: 1, active: true, activeAt: 900,
        metadataVersion: 1, agentStateVersion: revision }) });
      if (request.path === '/v1/sessions/status-session/turns') return Response.json({ v: 1, sessionId: 'status-session', updatedAt: 900 + revision,
        turns: [{ turnId: 'status-turn', agentId: 'codex', status: 'completed', startedAt: 100,
          terminalAt: 100 + 300 * revision, updatedAt: 900 + revision }] });
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

  it('retains accounting through captured mixed catalog, managed-policy and allowance pages, and reads real or unknown changes', async () => {
    let revision = 1;
    const captured = await context(request => request.path === '/v2/usage/query'
      ? Response.json({ ...value, totals: { ...value.totals, eventCount: revision } }) : undefined);
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeComparison: false,
      includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
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
      expect.soft(reads() - before, 'Catalog configuration, Machine policy and allowance changes contain no accounting events').toBe(0);
      revision = 2;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, [], { changeKinds: ['account'], usageQueryAffects: true,
        usageAccountingChange: { sessionId: null } });
      await settle();
      expect.soft(reads() - before).toBe(1);
      expect.soft(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals.eventCount).toBe(2);
      revision = 3;
      publishPage([{ kind: 'account', entityId: 'unknown-account-fixture', cursor: 7, changedAt: 1 }, machine]);
      await settle();
      expect.soft(reads() - before, 'An unknown Account row remains conservative even on a mixed page').toBe(2);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals.eventCount).toBe(3);
    } finally { release(); }
  });

  it('keeps admitted accounting quiet through provider quota Home publications and still reads a real accounting change', async () => {
    let revision = 1;
    const captured = await context(request => request.path === '/v2/usage/query'
      ? Response.json({ ...value, totals: { ...value.totals, eventCount: revision } }) : undefined);
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
      revision = 2;
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, [], {
        changeKinds: ['account'], usageQueryAffects: true, usageAccountingChange: { sessionId: null },
      });
      await settle();
      expect.soft(reads() - before, 'The accounting producer still replaces its admitted answer once').toBe(1);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals.eventCount).toBe(2);
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
    storage.getState().applyMachines([createMachineFixture({ id: 'work-machine', activeAt: Date.now() })]);
    const witness: UsageWorkEvidence = { sessionId: 'work-session', turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
      pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
        nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } }, number: 1, title: 'Merged',
        url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'merged' } };
    scmTransport.mockResolvedValue({ success: true, branches: [], branchEvidence: [], branchEvidenceStatus: 'partial',
      pullRequests: [witness.pullRequest], workEvidence: [witness, witness], workEvidenceStatus: 'partial' });
    const summary = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, projects: ['historical-project'], includeWorkEvidence: true, workProjection: 'summary',
      includeSessionEvidence: true, includeTranscriptEvidence, includeQuotaHistory: false, includeActivity: true,
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
    expect(ordinary.workSummary).toEqual({ mergedPrCount: 1 });
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
    expect(retained.results.find(slice => slice.key === getUsageQueryKey(summary))?.workSummary).toEqual({ mergedPrCount: 1 });
    const retainedProfile = retained.results.find(slice => slice.key === getUsageQueryKey(profile))!;
    expect(retainedProfile.publicProfileEvidence?.facts).toMatchObject({ agentTimeMs: 300, mergedPrs: 1 });
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
    expect(detailed.results[0]?.work?.allocations.map(row => row.contribution.id)).toEqual(contributions.map(row => row.id));
    const amount = summarizeUsageWork(detailed.results[0]!.work!, { metric: 'cost', costBasis: 'api_equivalent' }).total;
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
      expect.soft(reads() - beforeBurst, 'Ten ingests during an active read demand only one fresh follow-up').toBe(2);
      expect.soft(decodeUsageQueryResource(relevant.getSnapshot().value!).results[0]?.accounting?.totals.tokens.total).toBe(4);

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
      includeWorkEvidence: false, includeSessionEvidence: false, includeTranscriptEvidence: false });
    const detail = normalizeUsageQuery({ ...summary, includeSessionEvidence: true });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [summary, detail] }) });
    const release = entry.subscribe(() => {}, false);
    const slice = (query: typeof summary) => {
      const content = entry.getSnapshot().value;
      return content ? decodeUsageQueryResource(content).results.find(row => row.key === getUsageQueryKey(query)) : undefined;
    };
    try {
      await expect.poll(() => sessionRequests().some(request => request.path === '/v2/sessions/work-session')).toBe(true);
      await expect.poll(() => slice(summary)?.howYouWork?.agentCalendar?.periodSummary.totals.tokens).toBe(15);
      expect(slice(summary)?.pending).toBe(false);
      expect(slice(detail)?.pending).toBe(true);
      session.resolve(Response.json({ error: 'denied' }, { status: 403 }));
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(slice(summary)?.howYouWork?.agentCalendar?.periodSummary.totals.tokens).toBe(15);
      expect(slice(detail)?.howYouWork?.agentCalendar?.periodSummary.totals.busyMs).toBeNull();
      expect(slice(detail)?.pending).toBe(false);
      expect(entry.getSnapshot().error).toBeUndefined();
    } finally { session.resolve(Response.json({ error: 'denied' }, { status: 403 })); release(); }
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

  it('retains Work after repeated HTTP failures while real SCM failure normalization still quarantines denial', async () => {
    let status = 200;
    let hasEvidence = true;
    const branchEvidence = { sessionId: 'work-session', turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint',
      checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed',
      branch: { ref: 'refs/heads/work', headSha: 'b'.repeat(40) } };
    const captured = await context(request => {
      if (!request.path.startsWith('/test/work/')) return undefined;
      if (status !== 200) return Response.json({ error: status === 403 ? 'denied' : 'unavailable' }, { status });
      return request.path.endsWith('/scm.branch.list')
        ? Response.json({ success: true, branches: [], branchEvidence: hasEvidence ? [branchEvidence] : [], branchEvidenceStatus: 'partial' })
        : Response.json({ success: true, pullRequests: [], workEvidence: [], workEvidenceStatus: 'partial' });
    });
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 }, includeSessionEvidence: false });
    const accounting = [{ query, value: { ...value, contributions: [workContribution] }, status: 'available' as const }];
    const read = async (previous?: ReturnType<typeof resolveUsagePageAggregation>) => {
      const work = await collectUsageWorkSources({ queries: [query], accounting, assertCurrent: () => {
        if (!captured.accountLifetime.isCurrent()) throw new Error('retired');
      }, readSession: async () => async (method, input) => {
        try {
          const response = await captured.request(`/test/work/${method}`, { method: 'POST', body: JSON.stringify(input) });
          if (response.status >= 500) throw new RetryableServerResponseError(response.status, 'unavailable');
          if (!response.ok) throw new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN);
          return await response.json();
        } catch (error) { return scmFallbackError(error, { method, request: {} }); }
      } });
      return resolveUsagePageAggregation({ queries: [query], accounting, work, previous });
    };
    const first = await read();
    expect(first.results[0]?.work?.branchAllocations[0]?.reason).toBe('allocated');
    status = 503;
    let previous = first;
    for (let attempt = 0; attempt < 2; attempt++) {
      previous = await read(previous);
      expect.soft(previous.results[0]?.work?.branchAllocations[0]?.reason).toBe('allocated');
      expect.soft(previous.results[0]?.sources).toContainEqual({ source: 'work', status: 'stale', errorCode: 'work_evidence_failed' });
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
      return undefined;
    });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: Object.fromEntries(ids.map(id => [id,
      createSessionFixture({ id, seq: 1, serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' }),
    ])) });
    const query = normalizeUsageQuery({ period: relative ? { relative: 'all' } : { startMs: 0, endMs: 1000 },
      includeWorkEvidence: false, includeTranscriptEvidence: false });
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
      expect(slice().howYouWork?.sessionCoverage).toEqual({ selected: 5, admitted: scenario === 'recovery' ? 3 : 5 });
      expect(slice().coach?.sessionCoverage).toEqual(slice().howYouWork?.sessionCoverage);
      if (scenario === 'recovery') {
        expect(slice().sources).toContainEqual({ source: 'how_you_work:sessions', status: 'partial' });
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
      const attemptsBeforeRetry = sessionRequests().filter(request => request.path === '/v1/sessions/retry-turns/turns').length;
      const postsBeforeRetry = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH).length;
      failedTurns = false;
      nowMs = 2000;
      // No Session/store marker changes: Retry must reacquire only failed evidence.
      await entry.refresh();
      expect(slice().howYouWork?.intervals?.agentTimeMs).toBe(scenario === 'recovery' ? 1200 : 600);
      expect(slice().howYouWork?.sessionCoverage).toEqual({ selected: 5, admitted: 5 });
      expect(slice().coach?.sessionCoverage).toEqual({ selected: 5, admitted: 5 });
      expect(slice().sources).toContainEqual({ source: 'how_you_work:sessions', status: 'available' });
      expect(sessionRequests().filter(request => request.path === '/v1/sessions/healthy-turns/turns')).toHaveLength(1);
      expect(sessionRequests().filter(request => request.path === '/v1/sessions/retry-turns/turns'))
        .toHaveLength(attemptsBeforeRetry + (scenario === 'recovery' ? 1 : 0));
      const retryDemands = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)
        .slice(postsBeforeRetry).flatMap(request => UsageSessionEvidenceRequestSchema.parse(request.body).requests);
      expect(retryDemands.map(demand => demand.sessionIds?.toSorted()), 'Retry hydrates failed inputs through the retained complete cohort')
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
    expect(home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)).toHaveLength(1);
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
      expect(metric('batch-coach.summary.sessions')?.value).toBe(2);
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
      expect(sliceOf(first).sources.find(state => state.source.startsWith('quota:'))?.status).toBe('stale');
      stopFirst();
      const returning = entryFor(2000);
      const stopReturning = returning.subscribe(() => {}, false);
      try {
        await expect.poll(() => returning.getSnapshot().value !== undefined).toBe(true);
        expect(sliceOf(returning).quota?.[0]?.current).toEqual(record);
        expect(projectUsagePlans(sliceOf(returning).quota, now, undefined, sliceOf(returning).sources).tightest?.window.remainingFraction).toBe(0.6);
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
      if (path === (held === 'settings' ? '/v2/account/settings' : '/v1/account/encryption')) {
        events.push('held');
        await gate.promise;
        events.push('released');
        if (held === 'refused-mode') return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      return fetch(url, init);
    });
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
    const now = Date.now();
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'provider-work' },
      observedAtMs: now, fetchedAtMs: now, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed',
      state: 'loaded_data', meters: [] });
    let historyRequests = 0;
    let changedHistory = false;
    let accountingRequests = 0;
    const profile = { connectedAccountsV4: [{ ref, status: 'connected' as const, authenticationModeId: 'manual',
      revisionSemantics: 'revisioned' as const, credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
      configurationReady: false, configurationRevision: null, scopes: [] }] };
    const captured = await context(async request => {
      if (request.path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
      if (request.path === '/v2/usage/query') { accountingRequests++; return Response.json(value); }
      if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({ source,
        recordId: snapshot.recordId, providerAccountId: 'provider-work', fetchedAt: now, staleAfterMs: 60_000 });
      if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: snapshot },
        metadata: { fetchedAt: now, staleAfterMs: 60_000, status: 'ok' }, sources: [source] });
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
      if (!includeAccounting) {
        publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['self', 'session-a', 'machine-a', 'approval-a'], {
          changeKinds: ['account', 'session', 'machine', 'artifact'], usageQueryAffects: true,
        });
        await flushHookEffects({ cycles: 30 });
        expect({ historyRequests, accountingRequests }, 'unrelated detailed Home changes must not reread Capacity').toEqual(before);
        expect(resourcePublications).toBe(publicationsBefore);
        const sessions = storage.getState().sessions;
        storage.setState({ sessions: { ...sessions, 'unrelated-capacity-session': createSessionFixture({
          id: 'unrelated-capacity-session', serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain',
        }) } });
        await flushHookEffects({ cycles: 30 });
        storage.setState({ sessions });
        await flushHookEffects({ cycles: 30 });
        expect({ historyRequests, accountingRequests }, 'Session membership changes must not reread Capacity').toEqual(before);
        expect(resourcePublications, 'Session membership must not publish a quota-only revision').toBe(publicationsBefore);
      }
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
      expect(accountingRequests, 'A mixed quota page refreshes its material history without rereading accounting').toBe(before.accountingRequests);
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
      refs.forEach(ref => expect(cold.findHostByTestId(`timeline.cell.${ref.accountId}`)).not.toBeNull());
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
        records[0] = ProviderAccountUsageSnapshotV1Schema.parse({ ...records[0], state: 'not_loaded',
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
    const machine = createMachineFixture({ id: 'work-machine' });
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

  it('releases superseded read facts while the same Resource keeps its newest admission', async () => {
    const { Session: InspectorSession } = await import('node:inspector');
    let eventCount = 1;
    const captured = await context(request => request.path === '/v2/usage/query'
      ? Response.json({ ...value, totals: { ...value.totals, eventCount } }) : undefined);
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
      queries: [normalizeUsageQuery({ period: { relative: 'all' }, includeSessionEvidence: false, includeWorkEvidence: false })],
    }) });
    const inspector = new InspectorSession();
    inspector.connect();
    try {
      await entry.refresh();
      const superseded = new WeakRef(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.accounting!.totals);
      for (eventCount = 2; eventCount <= 4; eventCount++) {
        await entry.refresh();
        expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.accounting!.totals.eventCount).toBe(eventCount);
        const release = entry.subscribe(() => {}, true);
        await flushHookEffects();
        release();
      }
      // End the weak-reference job before asking the actual V8 collector.
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
      expect(superseded.deref() === undefined, 'a live Resource must release superseded accounting facts').toBe(true);
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!.accounting!.totals.eventCount).toBe(4);
    } finally { inspector.disconnect(); }
  });

  it('does not re-encode identical progressive and terminal content', async () => {
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
      // This system boundary sees every byte submitted for SHA-256. The
      // terminal snapshot must reuse an identical admitted progress value.
      expect(submitted.length).toBeGreaterThan(0);
      expect(new Set(submitted).size).toBe(submitted.length);
    } finally { release(); }
  });

  it('admits usage content only after the asynchronous platform digest completes', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    storage.setState({ profileScope: captured.accountLifetime.scope,
      profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }) });
    const digestGate = createDeferred<void>();
    const originalDigest = platformDigest.digest;
    const digest = vi.spyOn(platformDigest, 'digest').mockImplementation(async (algorithm, bytes) => {
      await digestGate.promise;
      return await originalDigest(algorithm, bytes);
    });
    const entry = getUsageQueryResourceStore(captured)
      .getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ period: { relative: '7days' } }] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => digest.mock.calls.length).toBeGreaterThan(0);
      expect(entry.getSnapshot().value).toBeUndefined();
      digestGate.resolve();
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(entry.getSnapshot().value).toBeDefined();
    } finally { digestGate.resolve(); release(); }
  });

  it('coalesces superseded progress while an asynchronous digest is pending', async () => {
    const captured = await context(request => request.path === '/v2/usage/query' ? Response.json(value) : undefined);
    storage.setState({ profileScope: captured.accountLifetime.scope,
      profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }) });
    const digestGate = createDeferred<void>();
    const originalDigest = platformDigest.digest;
    const submitted: string[] = [];
    vi.spyOn(platformDigest, 'digest').mockImplementation(async (algorithm, bytes) => {
      const text = new TextDecoder().decode(bytes);
      // Bootstrap shares the crypto boundary; only this Resource's revisions
      // belong to the coalescing contract (as in the adjacent digest test).
      if (text.startsWith('{"v":1,"results":[')) {
        submitted.push(text);
        if (submitted.length === 1) await digestGate.promise;
      }
      return await originalDigest(algorithm, bytes);
    });
    const entry = getUsageQueryResourceStore(captured)
      .getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [{ period: { relative: '7days' } }] }) });
    const release = entry.subscribe(() => {}, false);
    try {
      await expect.poll(() => submitted.length).toBe(1);
      await flushHookEffects();
      digestGate.resolve();
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(submitted).toHaveLength(2);
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
    const machine = createMachineFixture({ id: 'work-machine' });
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
    scmTransport.mockImplementation(async (input: { machineId: string; payload: { group: { service: typeof service; groupId: string } } }) => {
      if (timedOut) throw Object.assign(new Error('Selector timed out'), { code: 'MACHINE_RPC_TIMEOUT' });
      if (denied) { deniedRpcReads++; throw new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN); }
      if (unavailable) return { status: 'unavailable', code: 'connected_account_daemon_runtime_unavailable' };
      expect(input.machineId).toBe('selected');
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
      await entry.refresh();
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
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
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.pools?.[0]?.selection)
        .toMatchObject({ status: 'stale', machineId: 'selected', errorCode: 'MACHINE_RPC_UNREACHABLE',
          value: { selection: { selected: { profileId: 'personal' } } } });
      expect(scmTransport.mock.calls.length, 'withdrawn presence must not retry a selector before recovery').toBe(beforeWithdrawal);
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
      : request.path === '/v2/sessions/work-session' ? held ? privateSession.promise : Response.json({ error: 'not_found' }, { status: 404 })
      : request.path === '/v1/account/encryption/currentness' ? Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) : undefined);
    storage.getState().applySessions([createSessionFixture({ id: 'work-session', active: true,
      serverId: captured.accountLifetime.scope.serverId, metadata: { machineId: 'work-machine', path: '/repo', host: 'test', homeDir: '/home/test' } })]);
    storage.getState().applyMachines([createMachineFixture({ id: 'work-machine' })]);
    scmTransport.mockImplementation(() => held ? work.promise : Promise.resolve({ success: true, pullRequests: [] }));
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
      work.resolve({ success: true, pullRequests: [] });
      privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
      await refreshing;
      await flushHookEffects();
      expect(entry.getSnapshot().value).toBeUndefined();
    } finally { work.resolve({ success: true, pullRequests: [] }); privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 })); release(); }
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
      if (request.path === '/v4/connect/qualified/provider-account-usage/history') return history.promise.then(response => response.clone());
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
      const screen = await renderScreen(body());
      expect(screen.findByTestId('quota-capacity.cell.ready')).toBeTruthy();
      if (failureFirst) {
        // The current Plans presentation collapses settled never-read accounts
        // into its unread line; the qualified failure and Retry remain visible.
        expect(screen.findByTestId('quota-capacity.cell.slow')).toBeNull();
        expect(screen.findByTestId('quota-capacity.unread')).toBeTruthy();
        expect(screen.findByTestId('quota-fit.plan.slow')).toBeNull();
        expect(slowState()).toMatchObject({ status: 'error', errorCode: 'snapshot_read_failed' });
      } else {
        expect(screen.findByTestId('quota-capacity.cell.slow')).toBeTruthy();
        expect(screen.findByTestId('quota-fit.plan.slow')).toBeTruthy();
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
      history.resolve(Response.json({ entries: [], nextCursor: null }));
      accounting.resolve(Response.json(value));
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
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
          catchUpRows = [];
          await sync.resumeSync('socket-reconnect');
          await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
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
        () => publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['session-arrival'], { source: 'connected', changeKinds: ['session'], usageQueryAffects: true }),
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

  it('recalculates plan fit from persisted prices across shared allowance reads without reacquiring A or B', async () => {
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
            entries: refs.map(account => ({ v: 1, label, subject: { kind: 'account', account },
              ...(enteredAmount === undefined ? {} : { subscriptionMonthlyPrice: { amount: enteredAmount, currency: 'USD', enteredAtMs: now } }) })) } } });
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
        await expect.poll(() => getConnectedMetadataCatalog(captured.accountLifetime.scope).presentation.status).toBe('ready');
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
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]).toMatchObject({ accounting: value,
        quota: [{ source, current: snapshot, unusedCapacity: { historyStatus: 'not_loaded' } }] });
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0]?.pageProjection).toBeUndefined();
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual(expect.objectContaining({ source: expect.stringMatching(/^quota:/), status: 'stale' }));
      later.resolve(Response.json({ entries: [], nextCursor: null }));
      // Capacity history has answered even while the independent Pending-work
      // facet is still outstanding. It cannot keep every account "Still reading".
      await expect.poll(() => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources
        .find(source => source.source.startsWith('quota:'))?.status).toBe('available');
      const projected = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.quota?.[0];
      expect(projected?.history).toBeUndefined();
      expect(projected?.pageProjection).toBeUndefined();
      expect(projected?.pageFacts).toMatchObject({ historyStatus: 'complete',
        resetWitness: { id: 'first-use-page', observedAtMs: now - 1,
          snapshot: { ...snapshot, observedAtMs: now - 1, fetchedAtMs: now - 1 } } });
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
        .toContainEqual(expect.objectContaining({ source: 'quota', status: 'available' }));
      pending.resolve(Response.json({ entries: [] }));
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.sources)
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
    storage.getState().applyMachines([createMachineFixture({ id: 'work-machine' })]);
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
      work.resolve({ success: true, pullRequests: [] });
      session.resolve(Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'staged-session',
        createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
        metadataVersion: 1, metadata: { path: '', host: '', name: 'Opened' }, agentStateVersion: 1 }) }));
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

  it.each(['refused', 'unreadable-session', 'unreadable-transcript'] as const)('settles partial reading with one readable and one %s Session', async outcome => {
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
      expect(slice()?.howYouWork?.sessionCoverage).toEqual({ selected: 2, admitted: outcome === 'unreadable-transcript' ? 2 : 1 });
      expect(slice()?.howYouWork?.intervals?.agentTimeMs).toBe(outcome === 'unreadable-transcript' ? 600 : 300);
      expect(slice()?.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'partial' }));
      expect(slice()?.sources).toContainEqual({ source: 'how_you_work:transcripts', status: 'partial' });
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
    const firstOutcome = first.then(value => ({ value }), error => ({ error }));
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
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      entered.resolve();
      await releaseResponse.promise;
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })), results: [{ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1 }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: 900, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
        ] } },
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
      expect(home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH)).toHaveLength(1);
    } finally { releaseResponse.resolve(); releaseFirst(); releaseSecond(); }
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
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const input = UsageSessionEvidenceRequestSchema.parse(request.body);
      return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: [id] })), results: [{ sessionId: id,
        detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id, seq: 1,
          metadata: { path: '/repo', host: 'usage-test', machineId: 'machine-a' } }) } },
        turns: { status: 200, body: { v: 1, sessionId: id, updatedAt: nowMs - 100, turns: [
          { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: nowMs - 900, terminalAt: nowMs - 600, updatedAt: nowMs - 100 },
        ] } },
      }] } satisfies UsageSessionEvidenceResponse);
    });
    const summary = normalizeUsageQuery({ period: { relative: '7days' }, includeComparison: false,
      includeWorkEvidence: false, includeTranscriptEvidence: false, workProjection: 'summary' });
    const detail = normalizeUsageQuery({ ...summary, includeComparison: true, includeWorkEvidence: true, workProjection: 'detail' });
    const otherWindow = normalizeUsageQuery({ ...summary, period: { relative: '30days' } });
    const otherSubject = normalizeUsageQuery({ ...summary, machines: ['machine-a'] });
    const queries = [summary, detail, otherWindow, otherSubject];
    const result = await readUiUsageQueryBatch(captured, { queries });
    const posts = home!.requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH);
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
      await summaryRead;
      expect(slice(summary)?.pending).toBe(false);
      expect(slice(summary)?.howYouWork?.intervals?.agentTimeMs).toBe(300);
      expect(slice(summary)?.howYouWork?.inputs).toBeNull();
      expect(slice(summary)?.sources).toContainEqual({ source: 'how_you_work:transcripts', status: 'not_loaded' });
      expect(sessionRequests().filter(request => request.path.endsWith('/messages'))).toHaveLength(0);
      releaseDetail = detail.subscribe(() => {}, false);
      const detailRead = detail.refresh();
      await expect.poll(() => sessionRequests().some(request => request.path.endsWith('/messages'))).toBe(true);
      expect(slice(detail)?.pending).toBe(true);
      expect(slice(summary)?.pending).toBe(false);
      transcript.resolve(Response.json({ messages: [], hasMore: false }));
      await detailRead;
      expect(slice(detail)?.howYouWork?.inputs?.acceptedCount).toBe(0);
      expect(slice(detail)?.sources).toContainEqual({ source: 'how_you_work:transcripts', status: 'available' });
      await summary.refresh();
      expect(sessionRequests().filter(request => request.path.endsWith('/messages'))).toHaveLength(1);
    } finally { transcript.resolve(Response.json({ messages: [], hasMore: false })); await summaryRead; releaseDetail?.(); release(); }
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
      expect(slice(broad)?.sources).toContainEqual({ source: 'how_you_work:sessions', status: 'partial' });
      expect(slice(pinned)?.howYouWork?.intervals).toBeNull();
      expect(slice(pinned)?.howYouWork?.runLengths).toBeNull();
      expect(slice(broad)?.sources.some(source => source.source.startsWith('how_you_work') && source.status === 'pending')).toBe(false);
      holdTranscript = false;
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
    const coachSession = createPlainSessionCurrentProjectionRecordFixture({
      id: 'coach-session', createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
      metadataVersion: 1, metadata: { name: 'Opened', path: '/workspace/project', host: 'host', machineId: 'machine',
        runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} } },
      agentStateVersion: 1,
    });
    const composition = { v: 1, evidenceId: 'composition', sessionId: 'coach-session', turnId: 'turn', inputId: 'input',
      observedAtMs: 300, boundary: 'host_pre_dispatch', deliveryKind: 'newTurn', coverage: 'host_only',
      components: ['a', 'c'].map(source => ({ sourceId: source.repeat(64), digest: 'b'.repeat(64),
        kind: 'instructions', location: 'user', byteLength: 200, tokenCount: null, tokenizerId: null,
        cacheClass: 'unknown', overlap: 'none' })), nativePrefix: null, contextWindowTokens: null };
    const captured = await context(request => {
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
      return undefined;
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
    await storage.getState().activateSettingsScope(captured.accountLifetime.scope);
    storage.getState().applySettingsLocal({ usageCoachPreferencesV1: {
      ...storage.getState().settings.usageCoachPreferencesV1, suppressions: [{ kind: 'dismissed', evidenceKey: finding.evidenceKey }],
    } });
    expect(storage.getState().settings.usageCoachPreferencesV1.suppressions)
      .toContainEqual({ kind: 'dismissed', evidenceKey: finding.evidenceKey });
    const reread = await readUiUsageQueryBatch(captured, { queries: [result.results[0]!.requestedQuery] });
    expect(reread.results[0]?.coach?.findings.find(row => row.evidenceKey === finding.evidenceKey)?.state.dismissed).toBe(true);
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [result.results[0]!.requestedQuery] }) });
    const release = entry.subscribe(() => {}, true);
    try {
      await entry.refresh();
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
      const beforeProjection = home!.httpRequests.length;
      const projectionAccountingReads = () => home!.httpRequests.slice(beforeProjection)
        .filter(request => request.path === '/v2/usage/query' || request.path === '/v2/usage/query-batch');
      const preferencesBeforeRestore = storage.getState().settings.usageCoachPreferencesV1;
      await createUiCoachSuppressionPort(captured).edit({ evidenceKey: finding.evidenceKey, dismissed: false });
      const changes: ApiChangeEntry[] = [{ kind: 'kv', entityId: USAGE_COACH_SUPPRESSIONS_KV_KEY, cursor: 2, changedAt: 1 }];
      const planned = planSyncActionsFromChanges(changes, { afterCursor: 1, isSessionListMember: () => false });
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, changes.map(change => change.entityId), {
        changeKinds: ['kv'], usageQueryAffects: plannedChangesAffectUsageQuery(planned),
        usageAccountingAffects: plannedChangesAffectUsageAccounting(planned),
      });
      await flushHookEffects({ cycles: 30 });
      await expect.poll(() => mountedFinding()?.state.dismissed).toBe(false);
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(storage.getState().settings.usageCoachPreferencesV1).toEqual(preferencesBeforeRestore);
      expect(projectionAccountingReads(), 'restoring a finding reprojects admitted facts without reacquiring accounting').toEqual([]);
      storage.getState().applySettingsLocal({ usageCoachPreferencesV1: {
        ...storage.getState().settings.usageCoachPreferencesV1, disabledChecks: ['duplicated_instructions'],
      } });
      await expect.poll(() => mountedFinding()).toBeUndefined();
      await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
      expect(projectionAccountingReads(), 'changing Coach preferences must not acquire accounting').toEqual([]);
      const configured = entry.getSnapshot().value;
      expect(configured && decodeUsageQueryResource(configured).results[0]?.coach?.evaluations
        .find(row => row.detectorId === 'duplicated_instructions')?.status).toBe('disabled');
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
    } finally { release(); }
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
    'settles read-batch HTTP $status ($phase) across demand wakes and sibling borrowers until Retry or a Session change', async ({ status, phase }) => {
    const ids = ['terminal-one', 'terminal-two', 'terminal-three'];
    let failed = true;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === USAGE_SESSION_EVIDENCE_PATH && failed
        && (phase === 'summary' || UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => demand.query.includeTranscriptEvidence))) {
        return Response.json({ error: 'refused' }, { status });
      }
      for (const id of ids) {
        if (request.path === `/v2/sessions/${id}`) return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id }) });
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
      && (phase === 'summary' || UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => demand.query.includeTranscriptEvidence))).length;
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
      expect(reads(), 'user Retry opens exactly one fresh failed read').toBe(ids.length + 1);
      storage.getState().applySessions([{ ...storage.getState().sessions[ids[1]!]!, seq: 2 }]);
      await flushHookEffects({ cycles: 30 });
      await expect.poll(reads).toBe(ids.length + 2);
      await expect.poll(() => entries.every(entry => entry.getSnapshot().pending === 'idle')).toBe(true);
      expect(reads(), 'a real Session advance reopens only the changed input').toBe(ids.length + 2);
      failed = false;
      await entries[0]!.refresh();
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
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === USAGE_SESSION_EVIDENCE_PATH && missingRoute) return Response.json({ error: 'not_found' }, { status: 404 });
      if (request.path === '/v2/sessions/upgrade-session') return missingSession
        ? Response.json({ error: 'not_found' }, { status: 404 })
        : Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'upgrade-session' }) });
      if (request.path === '/v1/sessions/upgrade-session/turns') return Response.json({ v: 1, sessionId: 'upgrade-session', updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 900, updatedAt: 900 }] });
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
    expect(home!.requests.some(request => /^\/v[12]\/sessions\/(failed|readable)(\/|$)/.test(request.path))).toBe(false);
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

  it.each([403, 503])('keeps admitted Agent-time partial after refusal and retains stale facts after ordinary failure (%s)', async status => {
    let failing = false;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
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
    failing = true;
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['shared'], { changeKinds: ['session'], usageQueryAffects: true });
    const replacement = await readUiUsageQueryBatch(captured, input, undefined, settled);
    if (status === 503) {
      expect(replacement.results[0]?.howYouWork?.intervals, 'retain the complete admitted population, never only the surviving Session')
        .toEqual(settled.results[0]?.howYouWork?.intervals);
      expect(replacement.results[0]?.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'how_you_work', status: 'stale', errorCode: 'usage_session_evidence_read_failed' }),
      ]));
    } else {
      expect(replacement.results[0]?.howYouWork).toMatchObject({ detailStatus: 'partial',
        sessionCoverage: { selected: 2, admitted: 1 }, intervals: { agentTimeMs: 600,
          lanes: [{ workId: '["other","turn"]' }] },
        runLengths: { coverage: 'partial', sampleCount: 1, byAgent: [{ agentId: 'codex', durationsMs: [600] }] } });
      expect(replacement.results[0]?.sources).toContainEqual({ source: 'how_you_work:sessions', status: 'partial' });
    }
    failing = false;
    const recovered = await readUiUsageQueryBatch(captured, input, undefined, replacement);
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
          tokens: Object.fromEntries(Object.entries(value.totals.tokens).map(([key, count]) => [key, count * contributions.length])),
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

  it('retains admitted Session intervals through transport withdrawal and reads a real Session advance', async () => {
    let seq = 1;
    let refused = false;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/finite') return refused ? Response.json({ error: 'denied' }, { status: 403 })
        : Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'finite', seq }) });
      if (request.path === '/v1/sessions/finite/turns') return Response.json({ v: 1, sessionId: 'finite', updatedAt: seq,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: seq === 1 ? 400 : 700, updatedAt: seq }] });
      return undefined;
    });
    const sessions = () => ({ finite: createSessionFixture({ id: 'finite', seq, serverId: captured.accountLifetime.scope.serverId }) });
    storage.setState({ sessions: sessions() });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({
      session: 'finite', period: { startMs: 0, endMs: 1000 }, includeTranscriptEvidence: false, includeWorkEvidence: false,
    })] }) });
    const interval = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.intervals?.agentTimeMs;
    const reads = () => sessionRequests().filter(request => request.path === '/v2/sessions/finite').length;
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
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/new-candidate') return Response.json({ session: record });
      if (request.path === '/v1/sessions/new-candidate/turns') return Response.json(turns);
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
    expect(coach(broad).sessionCoverage).toEqual({ selected: 3, admitted: 3 });
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
        expect.soft(coach(pinned).sessionCoverage).toEqual({ selected: 1, admitted: 1 });
        expect.soft(coach(broad).sessionCoverage).toEqual({ selected: 3, admitted: 3 });
        expect.soft(coach(broad).findings.find(row => row.detectorId === 'approval_friction')?.evidenceKey).toBe(finding.evidenceKey);
        const failed = decodeUsageQueryResource(broad.getSnapshot().value!);
        if (failureSource === 'accounting') expect(failed.results[0]!.sources).toContainEqual(expect.objectContaining({ source: 'accounting', status: 'error' }));
        else {
          expect.soft(failed.results[0]!.pending, 'failed evidence has settled, rather than reading forever').toBe(false);
          expect.soft(failed.results[0]!.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'stale', errorCode: 'usage_session_evidence_read_failed' }));
        }
        expect(UsageQueryBatchResultSchema.safeParse(failed).success).toBe(true);
        if (failureSource !== 'accounting') {
          await broad.refresh();
          expect.soft(coach(broad).sessionCoverage, 'a repeated failed replacement keeps the same admitted evidence').toEqual({ selected: 3, admitted: 3 });
          expect.soft(coach(broad).findings.find(row => row.detectorId === 'approval_friction')?.evidenceKey).toBe(finding.evidenceKey);
          const rebatched = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
            queries: [query, normalizeUsageQuery({ ...query, agents: ['codex'] })],
          }) });
          await rebatched.refresh();
          const moved = decodeUsageQueryResource(rebatched.getSnapshot().value!).results.find(slice => slice.key === getUsageQueryKey(query))!;
          expect.soft(moved.coach?.sessionCoverage, 'batch membership does not retire this exact query admission').toEqual({ selected: 3, admitted: 3 });
          expect.soft(moved.coach?.findings.find(row => row.detectorId === 'approval_friction')?.evidenceKey).toBe(finding.evidenceKey);
          expect.soft(moved.pending).toBe(false);
          expect(UsageQueryBatchResultSchema.safeParse(decodeUsageQueryResource(rebatched.getSnapshot().value!)).success).toBe(true);
        }
        failing = false;
        await broad.refresh();
        expect.soft(coach(broad).sessionCoverage).toEqual({ selected: 3, admitted: 3 });
        expect.soft(coach(broad).findings.find(row => row.detectorId === 'approval_friction')?.evidenceKey).toBe(finding.evidenceKey);
      }
    } finally { release(); }
    expect(observations.every(slice => slice.coach?.sessionCoverage?.admitted === 3)).toBe(true);
    expect(observations.map(slice => slice.coach?.findings.find(row => row.detectorId === 'approval_friction'))
      .filter(row => row?.evidenceKey !== finding.evidenceKey)).toEqual([]);
    expect(observations.every(slice => slice.howYouWork?.todayInParallel?.agentTimeMs === 200)).toBe(true);
    membership = ['first'];
    await broad.refresh();
    await expect.poll(() => coach(broad).sessionCoverage).toEqual({ selected: 1, admitted: 1 });
    expect(coach(broad).findings.find(row => row.detectorId === 'approval_friction')?.evidenceKey).not.toBe(finding.evidenceKey);
  });

  it('reuses a list-only Session marker and refreshes it when that row advances', async () => {
    let seq = 1;
    const captured = await context(request => {
      if (request.path === '/v2/usage/query') return Response.json(value);
      if (request.path === '/v2/sessions/list-only') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({
        id: 'list-only', createdAt: 1, updatedAt: 900, seq, active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1,
      }) });
      if (request.path === '/v1/sessions/list-only/turns') return Response.json({ v: 1, sessionId: 'list-only', updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: seq === 1 ? 400 : 700, updatedAt: 900 }] });
      return undefined;
    });
    const serverId = captured.accountLifetime.scope.serverId;
    const rows = () => ({ [serverId]: { 'list-only': createSessionListRenderableSessionFixture({ id: 'list-only', seq }) } });
    storage.setState({ profileScope: captured.accountLifetime.scope, sessions: {}, sessionListRowsByServerId: rows() });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
      queries: [normalizeUsageQuery({ session: 'list-only', period: { startMs: 0, endMs: 1000 }, includeTranscriptEvidence: false, includeWorkEvidence: false })],
    }) });
    const release = entry.subscribe(() => {}, true);
    const agentTime = () => entry.getSnapshot().value && decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.howYouWork?.intervals?.agentTimeMs;
    try {
      await expect.poll(agentTime).toBe(300);
      publishHomeAccountChange(serverId);
      await entry.refresh();
      expect(sessionRequests().filter(request => request.path === '/v2/sessions/list-only')).toHaveLength(1);
      seq++;
      storage.getState().applyServerScopedSessionListRows(serverId, Object.values(rows()[serverId]!), {
        source: 'rowOnly', mode: 'append',
      });
      await expect.poll(agentTime).toBe(600);
      expect(sessionRequests().filter(request => request.path === '/v2/sessions/list-only')).toHaveLength(2);
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
  it('exposes admitted SCM snapshots through the real accounting read without relabelling another query', async () => {
    const tokens = { input: 10, output: 5, total: 15, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    const contribution = { id: 'cost', observedAtMs: 150, sessionId: 'session', turnId: 'turn', agentId: null,
      modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null, tokens,
      cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } };
    const captured = await context(request => {
        if (request.path === '/v2/usage/query') return Response.json({ v: 1, totals: {
          eventCount: 1, tokens, cost: contribution.cost }, contributions: [{ ...contribution,
            ...(UsageAnalyticsQueryRequestSchema.parse(request.body).filters?.agentIds?.includes('different') ? { turnId: 'other-turn' } : {}) }] });
        if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        if (request.path === '/v2/sessions/session') return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'session',
          createdAt: 1, updatedAt: 200, seq: 1, active: true, activeAt: 200,
          metadataVersion: 1, metadata: { path: '', host: '', name: 'work' }, agentStateVersion: 1 }) });
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
    storage.getState().applyMachines([createMachineFixture({ id: 'work-machine' })]);
    scmTransport.mockImplementation(async (request: { payload: { state?: string } }) => ({ success: true,
      pullRequests: request.payload.state === 'open' ? [witness.pullRequest] : [],
      workEvidence: request.payload.state === 'open' ? [witness] : [], workEvidenceStatus: 'partial' }));
    const result = await readUiUsageQueryBatch(captured, { queries: [query, other, workOnly, accountingOnly] });
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
    expect(shown.work?.allocations).toMatchObject([{ reason: 'allocated', contribution, outcome: { repositoryKey: 'repo' } }]);
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
    const machine = createMachineFixture({ id: 'work-machine', activeAt: Date.now() });
    storage.setState({ machines: { [machine.id]: machine } });
    const hostEntry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
      input: projectNativeJsonValueForTransport({ queries: [workOnly] }) });
    const release = hostEntry.subscribe(() => {}, true);
    try {
      await hostEntry.refresh();
      const beforeHostFlip = home!.requests.filter(request => request.path === '/v2/usage/query').length;
      // The next native read answers a changed partial inventory, so this
      // proves Machine invalidation reaches Work without re-reading accounting.
      scmTransport.mockResolvedValue({ success: true, pullRequests: [], workEvidence: [], workEvidenceStatus: 'partial' });
      // No pool is open. Only this admitted Session makes its Machine a consumer.
      recordMachineRequestFailed({ ...captured.accountLifetime.scope, machineId: machine.id });
      await flushHookEffects();
      await expect.poll(() => {
        const content = hostEntry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.sources.find(source => source.source === 'work')?.status;
      }).toBe('partial');
      await expect.poll(() => {
        const content = hostEntry.getSnapshot().value;
        return content && decodeUsageQueryResource(content).results[0]?.work?.allocations[0]?.reason;
      }).toBe('missing_evidence');
      await expect.poll(() => hostEntry.getSnapshot().pending).toBe('idle');
      expect(home!.requests.filter(request => request.path === '/v2/usage/query').length,
        'Machine reachability changes Work evidence, not the Account accounting answer').toBe(beforeHostFlip);
    } finally { release(); recordMachineRequestSucceeded({ ...captured.accountLifetime.scope, machineId: machine.id }); }
    const merged = { ...witness, pullRequest: { ...witness.pullRequest, state: 'merged' as const } };
    scmTransport.mockImplementation(async (request: { payload: { state?: string } }) => ({ success: true,
      pullRequests: request.payload.state === 'merged' ? [merged.pullRequest] : [],
      workEvidence: request.payload.state === 'merged' ? [merged] : [], workEvidenceStatus: 'partial' }));
    const native = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(transcriptDemands(), 'repeating the original window reuses its admitted private projection')
      .toHaveLength(admittedTranscripts.length);
    expect(transcriptDemands()).toEqual(expect.arrayContaining(admittedTranscripts));
    expect(native.results[0]?.work?.allocations[0]).toMatchObject({ reason: 'allocated',
      outcome: { repositoryKey: 'repo', pullRequest: { state: 'merged' } } });
    // Exercise the real Session → Machine SCM transport normalizer before Work's
    // quarantine/retention owner; only the actual RPC boundary rejects here.
    scmTransport.mockRejectedValue(new RetryableServerResponseError(503, 'Unavailable'));
    const outage = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, native);
    expect(outage.results[0]?.work?.allocations[0]?.reason).toBe('allocated');
    expect(outage.results[0]?.sources).toContainEqual(expect.objectContaining({ source: 'work', status: 'stale' }));
    for (const allReadsRefused of [true, false]) {
      scmTransport.mockImplementation(async (request: { payload: { state?: string } }) => {
        if (allReadsRefused || request.payload.state === 'closed') throw new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN);
        return request.payload.state === undefined
          ? { success: true, branches: [], branchEvidence: [], branchEvidenceStatus: 'partial' }
          : { success: true, pullRequests: [merged.pullRequest], workEvidence: [merged], workEvidenceStatus: 'partial' };
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
    scmTransport.mockImplementation(async (request: { payload: { state?: string } }) => request.payload.state === undefined
      ? { success: true, branches: [], branchEvidence: [branchWitness], branchEvidenceStatus: 'partial' }
      : { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'No hosting provider for this local repository' });
    const standalone = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(standalone.results[0]?.work?.branchAllocations[0]).toMatchObject({ reason: 'allocated', contribution,
      branch: { repositoryKey: 'repo', branch: { ref: 'refs/heads/standalone' }, contributionIds: ['cost'] } });
    expect(standalone.results[0]?.work?.outcomes).toEqual([]);
    // A local branch remains readable without a remote. Unsupported hosting
    // does not become a failed Work read or poison its exact branch evidence.
    expect(standalone.results[0]?.sources).toContainEqual({ source: 'work', status: 'partial', asOfMs: expect.any(Number) });
    scmTransport.mockImplementation(async (request: { payload: { state?: string } }) => request.payload.state === 'closed'
      ? { success: false, errorCode: 'COMMAND_FAILED', error: 'Native hosting read failed' }
      : { success: true, pullRequests: [merged.pullRequest], workEvidence: [merged], workEvidenceStatus: 'partial' });
    const partial = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(partial.results[0]?.sources).toContainEqual({ source: 'work', status: 'partial', asOfMs: expect.any(Number) });
    expect(partial.results[0]?.work?.allocations[0]?.reason).toBe('allocated');
    scmTransport.mockRejectedValue(new RetryableServerResponseError(503, 'Unavailable'));
    const partialFailure = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, partial);
    const observedWork = partialFailure.results[0]!.sources.find(source => source.source === 'work')!;
    expect(observedWork).toMatchObject({ status: 'stale', errorCode: 'work_evidence_failed' });
    const workProgress: typeof observedWork[] = [];
    const retried = await readUiUsageQueryBatch(captured, { queries: [query] }, undefined, partialFailure,
      { onProgress: project => { workProgress.push(project().results[0]!.sources.find(source => source.source === 'work')!); } });
    expect(workProgress.length).toBeGreaterThan(0);
    expect(workProgress.every(source => source === observedWork), 'equal Work rereads never clear and republish the failure').toBe(true);
    expect(retried.results[0]!.sources.find(source => source.source === 'work')).toBe(observedWork);
    scmTransport.mockResolvedValue({ success: true, pullRequests: [witness.pullRequest] });
    const unsupported = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(unsupported.results[0]?.sources).toContainEqual({ source: 'work', status: 'unsupported', asOfMs: expect.any(Number) });
    expect(unsupported.results[0]?.work?.allocations[0]).toMatchObject({ reason: 'missing_evidence', outcome: null, evidence: [] });
    scmTransport.mockResolvedValue({ success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'No supported backend' });
    const unavailableBackend = await readUiUsageQueryBatch(captured, { queries: [query] });
    expect(unavailableBackend.results[0]?.sources).toContainEqual({ source: 'work', status: 'unsupported', asOfMs: expect.any(Number) });
    scmTransport.mockImplementation(async (request: { payload: { state?: string } }) => request.payload.state === 'closed'
      ? { success: false, errorCode: 'INVALID_REQUEST', workEvidence: [merged] }
      : { success: true, pullRequests: [merged.pullRequest], workEvidence: [merged], workEvidenceStatus: 'partial' });
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
    detail.resolve({ success: true, pullRequests: [witness.pullRequest], workEvidence: [witness], workEvidenceStatus: 'partial' });
    await flushHookEffects({ cycles: 30 });
    expect(observed.at(-1)).toEqual({ pending: false, accounting: true, allocated: true });
    unsubscribe();
    store.dispose();
    const retired = { ...captured, accountLifetime: { ...captured.accountLifetime, isCurrent: () => false } };
    await expect(readUiUsageQueryBatch(retired, { queries: [query] })).rejects.toMatchObject({ code: 'stale_surface' });
  });
});
