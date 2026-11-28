import { randomBytes } from 'node:crypto';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { sealAccountSettingsV2RawContent } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import tweetnacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema, createActionExecutor, EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol';
import { UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { enforceExternalActionResponseEnvelopeLimitV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { projectUsageAccountingSessionIds, projectUsageAccountingSessionMembership } from '@happier-dev/protocol/usage/usageAccountingMembership';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { usageAppCallsSourceId } from '@happier-dev/plugin-sdk/usage';
import { USAGE_PRICE_ACTION_IDS, USAGE_PRIVATE_RECAP_ACTION_IDS, USAGE_PUBLIC_RECAP_ACTION_IDS, USAGE_QUERY_ACTION_ID_V1 } from '@happier-dev/protocol/usage/usageActionIdsV1';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, UsageSessionEvidenceResponseSchema } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { UsageFileResultSchema } from '@happier-dev/protocol/usage/usageExport';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { mintExternalActionExecutionAuthorization } from './externalActionAuthorizationHttp';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountEncryptionCurrentnessFixture, createCompactSessionListRowFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, createAvailableSessionSpawnMachineSnapshot } from '@/testkit/backends/apiSessionSocketHarness';
import { decodeExternalActionHttpBodyV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ScmPullRequestWorkEvidenceSchema, ScmWorkEvidenceReadResponseSchema } from '@happier-dev/protocol/scm';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { handleActionsCommand } from '@/cli/commands/actions';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliSettingsDeclarationAction } from '@/session/actions/settingsDeclarationAction';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { McpServerCatalogRowMutationV1Schema, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { UsageCoachApplyResultSchema, UsageCoachSuppressionStateV1Schema, USAGE_COACH_SUPPRESSIONS_KV_KEY } from '@happier-dev/protocol/usage/coach/coachActions';
import { StoredJsonContentEnvelopeSchema } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { UsageMcpBindingUsageSchema } from '@happier-dev/protocol/usage/coach/usageMcpBindingUsage';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createCliMcpServerActionExecuteV1 } from '@/session/actions/cliActionDeps/createCliMcpServerActionDeps';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { QualifiedConnectedServiceUsageSourceV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { ConnectedServiceQuotaGetResultV1Schema, QualifiedProviderAccountUsageHistoryRequestV4Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { createCliConnectedServiceAction } from '@/session/actions/connectedServiceActionDeps';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';

const socketBoundary = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: socketBoundary }));

const response = { v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); socketBoundary.mockReset(); resetActiveAccountSettingsSnapshotForTests(); process.exitCode = undefined; });

/** The HTTP boundary serves the same fixture facts through scalar and batch contracts. */
function registerAccountingRoutes(app: FastifyInstance,
  handler: (request: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>) {
  const read = async (request: FastifyRequest, reply: FastifyReply) => {
    const value = await handler(request, reply);
    if (reply.sent || reply.statusCode >= 400) return value;
    const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
    const parsed = UsageAnalyticsQueryResponseSchema.parse(value);
    // Home's accounting boundary publishes admission separately from raw row delivery.
    const membership = parsed.contributions ? {
      sessionIds: parsed.sessionIds ?? projectUsageAccountingSessionIds(parsed.contributions),
      sessionMembership: parsed.sessionMembership ?? projectUsageAccountingSessionMembership(parsed.contributions),
    } : {};
    return { ...parsed, ...membership, coverage: parsed.coverage ?? { status: 'complete', reasons: [],
      sources: [{ source: 'runtime', path: 'runtime', status: 'available', eventCount: parsed.totals.eventCount,
        ...(query.dateRange?.endMs === undefined ? {} : { asOfMs: query.dateRange.endMs }) }],
      missingDimensions: [], range: { ...query.dateRange, complete: true }, ranked: [] } };
  };
  app.post('/v2/usage/query', read);
  app.post('/v2/usage/query-batch', async (request, reply) => {
    const body = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
    const results = [];
    for (const query of body.queries) {
      const value = await read({ ...request, headers: request.headers, body: query }, reply);
      if (reply.sent || reply.statusCode >= 400) return value;
      results.push({ query, value: UsageAnalyticsQueryResponseSchema.parse(value) });
    }
    return { v: 1, priceCatalog: results.find(row => row.value.priceCatalog)?.value.priceCatalog,
      results: results.map(({ query, value: { priceCatalog: _catalog, ...facts } }) => ({ query, value: facts })) };
  });
}

describe('CLI and MCP personal usage Account transport', () => {
  it('returns only granted App calls when an Environment API token asks for quota, Work and Session evidence', async () => {
    const app = fastify();
    const ref = { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'work' };
    const group = QualifiedConnectedAccountGroupV4Schema.parse({
      v: 1, ref: { service: ref.service, groupId: 'private-pool' }, incarnation: 'pool-lifetime', displayName: null,
      policy: {}, activeConnectedAccountId: ref.accountId, generation: 1, runtimeStateRevision: 1, state: {},
      createdAt: 100, updatedAt: 150, members: [{ v: 1, connectedAccountId: ref.accountId, state: {}, createdAt: 100, updatedAt: 150 }],
    });
    const requests: string[] = [];
    app.addHook('onRequest', async request => { requests.push(request.url.split('?')[0]!); });
    // The signed HTTP transport sends logical GETs as framed POSTs.
    app.post('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
    app.post('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.post('/v1/account/profile', async () => ({
      id: 'account', connectedAccountGroupsV4: [group], connectedAccountsV4: [{
        ref, status: 'connected', authenticationModeId: null, revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: true, configurationRevision: '1', scopes: [],
      }],
    }));
    app.post('/v1/account/usage/prices', async () => bundledUsageModelPriceCatalog);
    const refusals = [
      { status: 403, body: { error: 'credential_scope_denied', authorizationRefusal: 'credential_action_admission', details: { reason: 'target_not_granted' } } },
      { status: 403, body: { error: 'credential_scope_denied', authorizationRefusal: 'credential_action_admission', details: { reason: 'environment_not_granted' } } },
      { status: 401, body: { error: 'invalid_token', authorizationRefusal: 'principal' } },
    ] as const;
    let homeRefusal: (typeof refusals)[number] | undefined;
    app.post(bindExternalActionExecutionAuthorizationHttpPathV1(ACTION_INVOKE_ACTION_ID_V1), async (_request, reply) => {
      if (!homeRefusal) throw new Error('Expected a collector refusal');
      return reply.code(homeRefusal.status).send(homeRefusal.body);
    });
    registerAccountingRoutes(app, async () => response);
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });

    const target = { kind: 'machine' as const, machineId: 'collector' };
    const grant = ApiTokenGrantV1Schema.parse({
      ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: ['usage'], ids: [] },
      targets: { sessions: [], machines: [target.machineId], environments: ['staging'] },
    });
    const externalActionCredential = { accountId: 'account', principalId: 'principal', credentialId: 'credential', grant };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1, token: 'home-minted-invocation', binding: {
        ...externalActionCredential, serverIdentityId: 'home', custodianAccountId: 'account',
        installationId: 'installation', machineId: target.machineId, actionId: USAGE_QUERY_ACTION_ID_V1,
        requestId: 'request', requestEnvelopeDigest: 'A'.repeat(43), target,
      },
    });
    const accountAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({
      ...authorization, token: 'home-minted-account-usage-invocation',
      binding: { ...authorization.binding, grant: { ...grant, targets: null } },
    });
    const ownedEnvironmentCalls = new Map([['staging', 3], ['production', 5]]);
    let collectorMachineId = target.machineId;
    const listEnvironments = vi.fn(async (environmentIds: string[]) => ({ ok: true as const, nextCursor: null,
      items: environmentIds.filter(id => ownedEnvironmentCalls.has(id)).map(id =>
        createDeploymentEnvironmentHeaderV1({ id, serverId: 'home', telemetryMachineId: collectorMachineId })) }));
    const keys = tweetnacl.sign.keyPair();
    app.post('/v1/deployments/environments', async request => {
      const framed = decodeExternalActionHttpBodyV1(request.body);
      if (!framed) throw new Error('The signed Environment request must be framed');
      const path = new URL(request.url, 'http://usage.test');
      expect(path.searchParams.get('serverId')).toBe('home');
      const signedAuthorization = framed.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === accountAuthorization.token
        ? accountAuthorization : authorization;
      expect(framed.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe(DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1);
      expect(framed.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(signedAuthorization.token);
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: signedAuthorization.token,
        effectActionId: DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1, requestId: signedAuthorization.binding.requestId,
        target, installationId: 'installation', method: 'GET', path: request.url,
        signature: String(framed.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: keys.publicKey })).toBe(true);
      return listEnvironments(path.searchParams.getAll('environmentIds'));
    });
    const deploymentDeps = createCliActionDeps({
      token: 'daemon-token', credentials: { token: 'daemon-token', encryption: null },
      sessionId: 'test-session', mode: 'plain', ctx: null,
      serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'http://usage.test',
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: 'installation',
    });
    const routeCollector = vi.fn();
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      ...createAccountServerActionDeps({
        token: 'daemon-token', serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'http://usage.test',
        externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair().secretKey,
        externalActionMachineInstallationId: 'installation',
      }),
      deploymentAction: deploymentDeps.deploymentAction,
      deploymentReadArtifactHeaders: deploymentDeps.deploymentReadArtifactHeaders,
      routeHostChildAction: async ({ input, context }) => {
        routeCollector(input);
        expect(context.externalActionTarget).toEqual({ kind: 'machine', machineId: collectorMachineId });
        const { input: { source, since, until } } = z.object({ input: z.object({
          source: z.object({ kind: z.literal('environment'), serverId: z.literal('home'), environmentId: z.string() }),
          since: z.literal(100), until: z.literal(200),
        }) }).parse(input);
        const callCount = ownedEnvironmentCalls.get(source.environmentId);
        if (!callCount) throw new Error('Expected an Account-owned Environment');
        if (homeRefusal) {
          const minted = await mintExternalActionExecutionAuthorization({
            actionId: ACTION_INVOKE_ACTION_ID_V1, serverHttpBaseUrl: 'http://usage.test',
            signRequest: async () => ({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token }),
            machineId: collectorMachineId,
            envelope: { v: 1, requestId: context.actionRequestId!, target: { kind: 'machine', machineId: collectorMachineId },
              input: null },
          });
          if (minted.ok) throw new Error('Expected Home to refuse the collector');
          return { ok: false, errorCode: minted.code, error: minted.code, details: minted.details };
        }
        return { ok: true, result: { ok: true, source, since, until,
          items: [{ bucketStartMs: 0, provider: null, modelId: null, requestedModel: null, operation: null, callCount,
            tokens: response.totals.tokens, tokenCategories: response.totals.tokens, reportedCost: { amount: 3, currency: 'USD' },
            firstSeenMs: 150, lastSeenMs: 150 }],
          coverage: { callCount, tokenCategoryCallCount: callCount, reportedCostCallCount: callCount, lostObservations: 0, reason: null },
        } };
      },
    });
    const requested = {
      period: { startMs: 100, endMs: 200 }, sources: [], includeComparison: false,
      includeQuota: true, includeQuotaHistory: true, includeSessionEvidence: true, includeWorkEvidence: true, includeActivity: true,
    };
    try {
      const context = {
        surface: 'api' as const, serverId: 'home', externalActionTarget: target, externalActionCredential,
        externalActionExecutionAuthorization: authorization,
      };
      const result = await executor.execute(USAGE_QUERY_ACTION_ID_V1, { queries: [requested] }, context);
      if (!result.ok) throw new Error(JSON.stringify(result));
      const { results } = UsageQueryBatchResultSchema.parse(result.result);
      expect(results).toHaveLength(1);
      const slice = results[0]!;
      expect(slice, JSON.stringify({ sources: slice.sources, requests })).toMatchObject({
        shownQuery: { sources: [usageAppCallsSourceId('staging')] },
        accounting: { totals: { eventCount: 3 } },
      });
      for (const key of ['quota', 'pools', 'work', 'workSummary', 'mergedOutcomes', 'coach'] as const) {
        expect(slice[key], key).toBeUndefined();
      }
      // The footprint can derive from App accounting alone. Session facts cannot.
      if (slice.howYouWork) {
        expect(slice.howYouWork).toMatchObject({
          activity: null, collaboration: null, inputs: null, intervals: null, nightShift: null,
          permissions: null, runLengths: null, steering: null, todayInParallel: null,
        });
      }
      expect(slice.accounting?.activity).toBeUndefined();
      expect(slice.accounting?.messageStats).toBeUndefined();
      expect(slice.accounting?.sessionIds).toBeUndefined();
      expect(slice.accounting?.sessionMembership).toBeUndefined();
      expect(slice.sources.filter(row => row.source === 'work' || row.source === 'how_you_work')).toEqual([
        { source: 'work', status: 'not_loaded' }, { source: 'how_you_work', status: 'not_loaded' },
      ]);
      expect(slice.sources.filter(row => /^(quota|selection)(:|$)/.test(row.source))).toEqual([]);
      // The Account profile supplies a pool and quota source. Only the App accounting path may run.
      expect(requests).toContain('/v1/account/profile');
      expect(requests.filter(path => path === USAGE_SESSION_EVIDENCE_PATH || path.startsWith('/v2/usage/')
        || path.includes('/provider-account-usage/'))).toEqual([]);
      expect(socketBoundary).not.toHaveBeenCalled();
      const recapAction = USAGE_PRIVATE_RECAP_ACTION_IDS.compose;
      const recapContext = { ...context, externalActionExecutionAuthorization: {
        ...authorization, binding: { ...authorization.binding, actionId: recapAction },
      } };
      expect(await executor.execute(recapAction, { query: normalizeUsageQuery(requested), selectedFields: ['tokens'] }, recapContext))
        .toMatchObject({ ok: true, result: { kind: 'composed', facts: { tokens: { total: 12 } } } });
      const foreign = { ...requested, sources: [usageAppCallsSourceId('production')] };
      const outOfScope = { ok: false, errorCode: 'credential_scope_denied', details: { reason: 'environment_not_granted' } };
      expect(await executor.execute(USAGE_QUERY_ACTION_ID_V1, { queries: [foreign] }, context)).toMatchObject(outOfScope);
      expect(await executor.execute(recapAction, { query: normalizeUsageQuery(foreign), selectedFields: ['tokens'] }, recapContext))
        .toMatchObject(outOfScope);
      expect(listEnvironments.mock.calls).toEqual([[['staging']], [['staging']]]);
      expect(requests).not.toContain('/v1/artifacts/read');
      const accountContext = { ...context,
        externalActionCredential: { ...externalActionCredential, grant: { ...grant, targets: null } },
        externalActionExecutionAuthorization: accountAuthorization,
      };
      const accountQuery = normalizeUsageQuery({
        ...requested, sources: [...ownedEnvironmentCalls.keys()].map(usageAppCallsSourceId),
        includeQuota: false, includeQuotaHistory: false, includeSessionEvidence: false, includeWorkEvidence: false,
      });
      const accountResult = await executor.execute(USAGE_QUERY_ACTION_ID_V1, { queries: [accountQuery] }, accountContext);
      expect(accountResult).toMatchObject({ ok: true, result: { results: [{
        shownQuery: { sources: accountQuery.sources },
        accounting: { totals: { eventCount: [...ownedEnvironmentCalls.values()].reduce((sum, calls) => sum + calls, 0) } },
      }] } });
      expect(requests).not.toContain('/v1/artifacts/read');
      const before = routeCollector.mock.calls.length;
      for (const refusal of refusals) {
        collectorMachineId = refusal === refusals[0] ? 'foreign-machine' : target.machineId;
        homeRefusal = refusal;
        const result = await executor.execute(USAGE_QUERY_ACTION_ID_V1, { queries: [requested] }, context);
        expect.soft(result).toMatchObject({ ok: true, result: { results: [{ sources: expect.arrayContaining([
          expect.objectContaining({ source: 'accounting', status: 'error', errorCode: refusal.body.error,
            details: 'details' in refusal.body ? refusal.body.details : refusal.body }),
        ]) }] } });
      }
      expect(routeCollector).toHaveBeenCalledTimes(before + refusals.length);
      expect(await executor.execute('deployments.environments.list', { serverId: 'home' }, context))
        .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    } finally { await app.close(); }
  });

  it.each([
    { state: 'absent', encryption: null },
    { state: 'invalid', encryption: { type: 'legacy' as const, secret: new Uint8Array(1) } },
    { state: 'inconsistent', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(3) } },
  ])('returns the typed Account Activity refusal for $state local material without reading private evidence', async ({ encryption }) => {
    const app = fastify();
    const credentials = { token: 'owner-token', encryption };
    const accounting = { ...response, contributions: [{
      id: 'contribution', observedAtMs: 150, sessionId: 'session', turnId: 'turn', agentId: 'codex',
      modelId: null, machineId: 'machine', projectKey: 'project', workspaceId: null, source: 'session',
      tokens: response.totals.tokens, cost: response.totals.cost,
    }] };
    registerAccountingRoutes(app, async () => accounting);
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({
      mode: 'e2ee', signingKeyFingerprint: 'signing-current', contentKeyFingerprint: 'current',
    }));
    const readPrivateEvidence = vi.fn(async () => ({ results: [] }));
    app.post(USAGE_SESSION_EVIDENCE_PATH, readPrivateEvidence);
    const origin = 'http://usage-account-crypto.test';
    cleanup = installAxiosFastifyAdapter({ app, origin });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
      token: credentials.token, credentials, serverId: 'home', serverHttpBaseUrl: origin,
    }) });
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, includeQuota: false,
      includeQuotaHistory: false, includeComparison: false, includeSessionEvidence: true, includeWorkEvidence: true });
    try {
      const result = await executor.execute('usage.query', { queries: [query] }, { surface: 'cli', serverId: 'home' });
      expect(result.ok).toBe(true);
      const slice = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results[0]!;
      expect.soft(slice.accounting?.totals).toEqual(response.totals);
      expect.soft(slice.sources).toContainEqual(expect.objectContaining({
        source: 'work', status: 'unknown', unreadSessions: { failed: 1 },
      }));
      expect.soft(slice.workSummary?.mergedPrCount).toBeUndefined();
      expect.soft(slice.howYouWork?.intervals).toBeNull();
      expect.soft(readPrivateEvidence).not.toHaveBeenCalled();
      expect(slice.sources).toContainEqual(expect.objectContaining({
        source: 'how_you_work', status: 'error', errorCode: 'account_storage_currentness_unavailable',
      }));
    } finally { await app.close(); }
  });

  it('distinguishes a missing Session from a missing Usage operation without re-polling or retaining values', async () => {
    const app = fastify();
    let state: 'available' | 'not_found' | 'Session not found' | 'missing_operation' = 'available';
    let reads = 0;
    registerAccountingRoutes(app, async (_request, reply) => {
      reads += 1;
      if (state === 'available') return response;
      return reply.code(404).send(state === 'missing_operation'
        ? { message: 'Route POST:/v2/usage/query not found', error: 'Not Found', statusCode: 404 }
        : { error: state });
    });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage-retired-session.test' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
      token: 'owner-token', serverId: 'home', serverHttpBaseUrl: 'http://usage-retired-session.test' }) });
    const read = async () => {
      const result = await executor.execute('usage.query', { queries: [{ session: ['owned-session'],
        includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false }] },
      { surface: 'cli', serverId: 'home' });
      expect(result.ok).toBe(true);
      return UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results[0]!;
    };
    try {
      expect((await read()).accounting?.totals.tokens.total).toBe(12);
      for (const next of ['not_found', 'Session not found', 'missing_operation'] as const) {
        state = next;
        const before = reads;
        const slice = await read();
        expect(slice.sources.find(source => source.source === 'accounting')).toMatchObject(next === 'missing_operation'
          ? { status: 'unsupported', errorCode: 'unsupported' } : { status: 'error', errorCode: 'denied' });
        expect(slice.accounting).toBeUndefined();
        expect(slice.pending).toBe(false);
        expect(reads - before).toBe(1);
      }
    } finally { await app.close(); }
  });
  it.each([
    { status: null, expected: { status: 'unsupported', errorCode: 'no_connected_accounts' } },
    { status: 'needs_reauth' as const, expected: { status: 'error', errorCode: 'connected_account_needs_reauth' } },
    { status: 'connected' as const, expected: { status: 'unsupported', errorCode: 'no_quota_capable_accounts' } },
  ])('reports the Account quota availability through standalone Usage ($status)', async ({ status, expected }) => {
    const app = fastify();
    const keys = tweetnacl.box.keyPair();
    const credentials = { token: 'owner-token', encryption: {
      type: 'dataKey' as const, machineKey: keys.secretKey, publicKey: keys.publicKey,
    } };
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({
      mode: 'e2ee', contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(keys.publicKey),
    }));
    app.get('/v2/account/settings', async () => ({ version: 1, content: sealAccountSettingsV2RawContent({
      credentials, raw: {}, envelopeKind: 'encrypted', randomBytes,
    }) }));
    app.get('/v1/account/profile', async () => ({ id: 'account', connectedAccountsV4: status ? [{
      ref: { service: status === 'connected'
        ? { pluginId: 'happier.review.coderabbit', localId: 'coderabbit-account' }
        : { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'fixture-account' },
      status, authenticationModeId: status === 'connected' ? 'native-login' : 'oauth', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [],
    }] : [] }));
    let quotaResolutions = 0;
    app.get('/v4/connect/qualified/provider-account-usage/sources/resolve', async (_request, reply) => {
      quotaResolutions++;
      return reply.code(404).send({ error: 'not_found' });
    });
    registerAccountingRoutes(app, async () => response);
    const serverHttpBaseUrl = 'http://usage-quota-availability.test';
    cleanup = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
      token: credentials.token, credentials, serverId: 'home', serverHttpBaseUrl,
    }) });
    const period = { relative: 'today' } as const;
    try {
      const control = await executor.execute(USAGE_QUERY_ACTION_ID_V1, { queries: [{ period,
        includeQuota: false, includeComparison: false, includeSessionEvidence: false,
        includeTranscriptEvidence: false, includeWorkEvidence: false, includeCoach: false,
      }] }, { surface: 'cli', serverId: 'home' });
      expect(UsageQueryBatchResultSchema.parse(control.ok ? control.result : undefined).results[0]?.accounting?.totals)
        .toEqual(response.totals);

      const query = normalizeUsageQuery({ period, includeAccounting: false, includeComparison: false,
        includeQuota: true, includeQuotaHistory: status !== 'connected', includeQuotaExactHistory: false, includeSessionEvidence: false,
        includeTranscriptEvidence: false, includeWorkEvidence: false, includeCoach: false });
      const result = await executor.execute(USAGE_QUERY_ACTION_ID_V1, { queries: [query] }, { surface: 'cli', serverId: 'home' });
      const slice = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results[0]!;
      expect(slice.key).toBe(getUsageQueryKey(query));
      expect(slice.sources.find(source => source.source === 'quota')).toEqual({ source: 'quota', ...expected });
      expect(slice.quota).toBeUndefined();
      expect(slice.pending).toBe(false);
      expect(quotaResolutions).toBe(0);
    } finally { await app.close(); }
  });

  it('keeps the Profile authority refusal on Usage quota while Accounting still lands', async () => {
    const app = fastify();
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.get('/v1/account/profile', async (_request, reply) => reply.code(403).send({ error: 'present_user_required' }));
    registerAccountingRoutes(app, async () => response);
    const serverHttpBaseUrl = 'http://usage-quota-profile-refusal.test';
    cleanup = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
      token: 'owner-token', serverId: 'home', serverHttpBaseUrl }) });
    try {
      const result = await executor.execute(USAGE_QUERY_ACTION_ID_V1, { queries: [{
        includeQuota: true, includeQuotaHistory: false, includeComparison: false, includeSessionEvidence: false,
        includeTranscriptEvidence: false, includeWorkEvidence: false,
      }] }, { surface: 'cli', serverId: 'home' });
      const slice = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results[0]!;
      expect(slice.accounting?.totals).toEqual(response.totals);
      expect(slice.sources).toContainEqual(expect.objectContaining({ source: 'quota', errorCode: 'present_user_required' }));
    } finally { await app.close(); }
  });

  it('surfaces a typed scalar Usage server failure instead of collapsing it to usage_query_failed', async () => {
    const app = fastify();
    registerAccountingRoutes(app, async (_request, reply) => reply.code(503).send({
      error: 'database_transaction_timeout', statusCode: 503,
    }));
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage-typed-failure.test' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
      token: 'owner-token', serverId: 'home', serverHttpBaseUrl: 'http://usage-typed-failure.test' }) });
    try {
      const result = await executor.execute('usage.query', { queries: [{ session: ['owned-session'],
        includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false }] },
      { surface: 'cli', serverId: 'home' });
      expect(result.ok).toBe(true);
      const slice = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results[0]!;
      expect(slice.sources.find(source => source.source === 'accounting')).toMatchObject({
        status: 'error', errorCode: 'database_transaction_timeout',
      });
    } finally { await app.close(); }
  });
  it.each(['scope', 'present-user', 'database', 'eligibility-unavailable', 'expired-bearer', 'bare'] as const)('keeps whole-response Home refusals in Usage Actions (%s)', async refusal => {
    const cases = {
      scope: { status: 403, body: { error: 'credential_scope_denied', details: { reason: 'environment_not_granted' } } },
      'present-user': { status: 403, body: { error: 'present_user_required' } },
      database: { status: 503, body: { error: 'database_transaction_timeout', statusCode: 503 } },
      'eligibility-unavailable': { status: 503, body: { error: 'upstream_error' } },
      'expired-bearer': { status: 401, body: { error: 'invalid_token' } },
      bare: { status: 403, body: {} },
    };
    const { status, body } = cases[refusal];
    const app = fastify();
    const refuse = async (_request: FastifyRequest, reply: FastifyReply) => reply.code(status).send(body);
    app.get('/v1/account/usage/prices', refuse);
    app.post('/v1/account/usage/prices/refresh', refuse);
    app.get('/v1/account/public-profile/view', refuse);
    app.post('/v2/usage/query', refuse);
    app.post('/v2/usage/query-batch', refuse);
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage-whole-http.test' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
      token: 'owner-token', serverId: 'home', serverHttpBaseUrl: 'http://usage-whole-http.test',
    }) });
    const caller = { surface: 'cli', serverId: 'home' } as const;
    const authenticationFailed = status === 401 || refusal === 'bare';
    const expected = status !== 401 && 'error' in body ? body.error : 'not_authenticated';
    const metadata = 'details' in body ? { details: body.details } : {};
    try {
      for (const actionId of Object.values(USAGE_PRICE_ACTION_IDS)) {
        expect.soft(await executor.execute(actionId, {}, caller)).toMatchObject({ ok: false, errorCode: expected, ...metadata });
      }
      expect.soft(await executor.execute(USAGE_PUBLIC_RECAP_ACTION_IDS.compose, { source: { kind: 'public_profile' } }, caller))
        .toMatchObject({ ok: false, errorCode: expected, ...metadata });
      const query = { includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false,
        includeWorkEvidence: false, includeComparison: false };
      for (const queries of [[query], [{ ...query, period: { startMs: 100, endMs: 200 } },
        { ...query, period: { startMs: 200, endMs: 300 } }]]) {
        const result = await executor.execute(USAGE_QUERY_ACTION_ID_V1, { queries }, caller);
        if (authenticationFailed) expect.soft(result).toMatchObject({ ok: false, errorCode: expected });
        else {
          expect(result.ok).toBe(true);
          if (!result.ok) continue;
          const slices = UsageQueryBatchResultSchema.parse(result.result).results;
          expect(slices).toHaveLength(queries.length);
          for (const slice of slices) {
            expect.soft(slice.sources.find(source => source.source === 'accounting'))
              .toMatchObject({ status: 'error', errorCode: expected, ...metadata });
            expect(slice.accounting).toBeUndefined();
          }
        }
      }
    } finally { await app.close(); }
  });

  it('acquires 51 accounting slices through one Usage batch request', async () => {
    const app = fastify();
    let scalarReads = 0;
    let batchReads = 0;
    let saturated = false;
    app.post('/v2/usage/query', async () => { scalarReads += 1; return response; });
    app.post('/v2/usage/query-batch', async (request, reply) => {
      batchReads += 1;
      if (saturated) return reply.code(503).send({ error: 'database_transaction_timeout', statusCode: 503 });
      const body = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
      return { v: 1, results: body.queries.map(query => ({ query, value: response })) };
    });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage-batch-count.test' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
      token: 'owner-token', serverId: 'home', serverHttpBaseUrl: 'http://usage-batch-count.test' }) });
    const query = (startMs: number) => ({ period: { startMs, endMs: startMs + 100 }, session: ['owned-session'],
      includeAccounting: true, includeComparison: false, includeQuotaHistory: false, includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeWorkEvidence: false });
    try {
      const result = await executor.execute('usage.query', { queries: Array.from({ length: 51 }, (_, index) => query(index * 100)) },
        { surface: 'cli', serverId: 'home' });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results).toHaveLength(51);
      expect({ batchReads, scalarReads }).toEqual({ batchReads: 1, scalarReads: 0 });
      const slices = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results;
      expect(slices.every(slice => slice.accounting?.totals.tokens.total === response.totals.tokens.total)).toBe(true);
      saturated = true;
      const failure = await executor.execute('usage.query', { queries: Array.from({ length: 51 }, (_, index) => query(index * 100)) },
        { surface: 'mcp', serverId: 'home' });
      expect(failure.ok).toBe(true);
      const failedSlices = UsageQueryBatchResultSchema.parse(failure.ok ? failure.result : undefined).results;
      expect(failedSlices).toHaveLength(51);
      expect(failedSlices.every(slice => slice.accounting === undefined && slice.sources.some(source =>
        source.source === 'accounting' && source.errorCode === 'database_transaction_timeout'))).toBe(true);
      expect({ batchReads, scalarReads }).toEqual({ batchReads: 2, scalarReads: 0 });
      const empty = await executor.execute('usage.query', { queries: [{ ...query(0), includeAccounting: false }] },
        { surface: 'cli', serverId: 'home' });
      expect(empty.ok).toBe(true);
      expect({ batchReads, scalarReads }).toEqual({ batchReads: 2, scalarReads: 0 });
    } finally { await app.close(); }
  });
  it('settles the QA-ACCT exact empty model/Machine filter shape as zero through the canonical query Action', async () => {
    // Exact clauses from qa-usage-acct-1030/fixture-query-input.json; the
    // authenticated HTTP owner returns its valid empty accounting projection.
    const machine = 'ae694c29-6fe7-4324-b7d3-0bff5a8961e0';
    const common = { machines: [machine], breakdown: ['model'], includeQuotaHistory: false,
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false, timeZoneOffsetMinutes: 0 };
    const counters = ['qa-usage-acct-1030-counter-a', 'qa-usage-acct-1030-counter-b'];
    const input = { queries: [{ ...common, period: { relative: 'today' }, modelIds: counters },
      { ...common, period: {}, modelIds: counters },
      { ...common, period: { relative: 'today' }, modelIds: ['qa-usage-acct-1030-model-a', 'qa-usage-acct-1030-model-b'] }] };
    const app = fastify();
    const paths: string[] = [];
    app.addHook('onRequest', async request => { paths.push(request.url.split('?')[0]!); });
    registerAccountingRoutes(app, async request => {
      const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
      expect(query.filters?.machineIds).toEqual([machine]);
      expect(query.filters?.modelIds).toHaveLength(2);
      return UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, series: [], breakdowns: { model: [] },
        contributions: [], priceCatalog: bundledUsageModelPriceCatalog });
    });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage-empty-filter.test' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
      token: 'owner-token', serverId: 'home', serverHttpBaseUrl: 'http://usage-empty-filter.test' }) });
    try {
      const result = await executor.execute('usage.query', input, { surface: 'cli', serverId: 'home' });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const batch = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined);
      expect(batch.results).toHaveLength(3);
      for (const slice of batch.results) {
        expect(slice.accounting?.totals).toMatchObject({ eventCount: 0, tokens: { total: 0 } });
        expect(slice.sources.find(source => source.source === 'accounting')).toMatchObject({ status: 'available' });
      }
      expect(paths.some(path => path.includes('/sessions'))).toBe(false);
    } finally { await app.close(); }
  });

  it('delivers only grouped accounting for evidence-free Usage slices without copying raw populations or the tariff inventory', async () => {
    // EXPORT-C observed 20 accounting contributions and a complete tariff
    // inventory even on empty comparison reads. Keep that boundary shape.
    const count = 20;
    const now = Date.UTC(2026, 9, 30, 12);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const contributions = Array.from({ length: count }, (_, index) => ({ id: `cost-${index}`, observedAtMs: now - 1000,
      sessionId: `session-${index}`, turnId: `turn-${index}`, agentId: 'codex', modelId: 'model', machineId: null,
      projectKey: null, workspaceId: null, source: 'runtime', tokens: response.totals.tokens, cost: response.totals.cost }));
    const catalog = { ...bundledUsageModelPriceCatalog, models: { ...bundledUsageModelPriceCatalog.models,
      model: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } };
    const app = fastify();
    const paths: string[] = [];
    app.addHook('onRequest', async request => { paths.push(request.url.split('?')[0]!); });
    registerAccountingRoutes(app, async request => {
      const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
      const rows = contributions.filter(row => row.observedAtMs >= (query.dateRange?.startMs ?? 0)
        && row.observedAtMs <= (query.dateRange?.endMs ?? now));
      const totals = { eventCount: rows.length, tokens: { input: rows.length * 10, output: rows.length * 2,
        reasoning: 0, cacheRead: 0, cacheWrite: 0, total: rows.length * 12 },
        cost: { reportedUsd: rows.length, estimatedUsd: 0, currency: 'USD' } };
      return UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals, contributions: rows, priceCatalog: catalog,
        breakdowns: Object.fromEntries((query.breakdowns ?? []).map(dimension => [dimension,
          rows.length ? [{ key: dimension === 'agent' ? 'codex' : 'model', ...totals }] : []])) });
    });
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.get('/v1/account/profile', async () => ({ id: 'account', connectedAccountsV4: [], connectedAccountGroupsV4: [] }));
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage-grouped.test' });
    const credentials = { token: 'owner-token', encryption: null };
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
      token: credentials.token, credentials, serverId: 'home', serverHttpBaseUrl: 'http://usage-grouped.test' }) });
    const noEvidence = { includeQuotaHistory: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false };
    const today = { period: { relative: 'today' }, costBasis: 'auto', metric: 'tokens', breakdown: ['agent'], ...noEvidence };
    try {
      const result = await executor.execute('usage.query', { queries: [today,
        { period: { relative: '7days' }, costBasis: 'api_equivalent', metric: 'cost', breakdown: ['model'], ...noEvidence }, today,
      ] }, { surface: 'cli', serverId: 'home' });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const batch = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined);
      const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
      console.info('USAGE-A03 delivery composition', JSON.stringify({ bytes: bytes(batch), slices: batch.results.map(slice => ({
        metric: slice.requestedQuery.metric, accountingBytes: bytes(slice.accounting),
        rows: slice.accounting?.contributions?.length ?? 0, rowBytes: bytes(slice.accounting?.contributions),
        catalogBytes: bytes(slice.accounting?.priceCatalog), factsBytes: bytes(slice.accounting?.costFacts),
        comparisonBytes: bytes(slice.comparison?.accounting), comparisonCatalogBytes: bytes(slice.comparison?.accounting?.priceCatalog),
      })) }));
      expect(batch.results).toHaveLength(2);
      expect(enforceExternalActionResponseEnvelopeLimitV1({ v: 1, actionId: 'usage.query', requestId: 'grouped-read', execution: result }))
        .toMatchObject({ execution: { ok: true } });
      for (const slice of batch.results) {
        expect(slice.accounting?.totals.tokens.total).toBe(count * 12);
        expect(slice.accounting?.breakdowns?.[slice.requestedQuery.breakdown[0]!]).toHaveLength(1);
        expect(slice.costFactTotals?.length).toBeGreaterThan(0);
        for (const accounting of [slice.accounting, slice.comparison?.accounting]) {
          expect(accounting).toBeDefined();
          expect(accounting).not.toHaveProperty('contributions');
          expect(accounting).not.toHaveProperty('priceCatalog');
        }
      }
      expect(bytes(batch)).toBeLessThan(bytes(catalog));
      expect(paths.some(path => path === '/v2/sessions/read-batch' || path.endsWith('/messages'))).toBe(false);
    } finally { cleanup?.(); cleanup = undefined; await app.close(); }
  });

  it.each([true, false])('keeps a missing Usage Session evidence update requirement on public Usage detail (Session evidence=%s)', async includeSessionEvidence => {
    const app = fastify();
    const paths: string[] = [];
    app.addHook('onRequest', async request => { paths.push(request.url.split('?')[0]!); });
    const sessionId = 'old-server-session';
    const accounting = { ...response, contributions: [{ id: 'turn-cost', observedAtMs: 150, sessionId,
      turnId: 'turn', agentId: 'claude', modelId: null, machineId: 'machine', projectKey: null, workspaceId: null,
      source: 'session', tokens: response.totals.tokens, cost: response.totals.cost }] };
    registerAccountingRoutes(app, async () => accounting);
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.get('/v1/account/profile', async () => ({ id: 'account', connectedAccountsV4: [], connectedAccountGroupsV4: [] }));
    // No batch route: exercise Fastify's real missing-route response, not a domain stub.
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage-old-server.test' });
    const credentials = { token: 'owner-token', encryption: null };
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
      token: credentials.token, credentials, serverId: 'home', serverHttpBaseUrl: 'http://usage-old-server.test' }) });
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, session: sessionId,
      includeQuotaHistory: false, includeSessionEvidence, includeWorkEvidence: true });
    try {
      const result = await executor.execute('usage.query', { queries: [query] }, { surface: 'cli', serverId: 'home' });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const slice = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results[0]!;
      expect(slice.accounting?.totals).toMatchObject(accounting.totals);
      expect(paths.filter(path => path === USAGE_SESSION_EVIDENCE_PATH)).toHaveLength(1);
      expect(paths).not.toContain('/v2/sessions/read-batch');
      expect(paths.some(path => /^\/v[12]\/sessions\/[^/]+(?:\/(?:turns|messages))?$/.test(path)
        && path !== '/v2/sessions/read-batch')).toBe(false);
      const requirement = { kind: 'update_required', operation: 'usage.query', component: 'server', reason: 'usage_session_evidence_unsupported' };
      expect(slice.sources).toContainEqual(expect.objectContaining({ source: 'work', errorCode: 'update_required', updateRequired: requirement }));
      if (includeSessionEvidence) expect(slice.sources).toContainEqual(expect.objectContaining({
        source: 'how_you_work', errorCode: 'update_required', updateRequired: requirement }));
      const before = paths.length;
      const unaffected = await executor.execute('usage.query', { queries: [{ ...query,
        includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false }] }, { surface: 'cli', serverId: 'home' });
      expect(unaffected.ok, JSON.stringify(unaffected)).toBe(true);
      expect(UsageQueryBatchResultSchema.parse(unaffected.ok ? unaffected.result : undefined).results[0]?.accounting?.totals)
        .toMatchObject(accounting.totals);
      expect(paths.slice(before)).not.toContain('/v2/sessions/read-batch');
    } finally { cleanup?.(); cleanup = undefined; await app.close(); }
  });

  it.each([
    { first: 'read', second: 'read', state: 'partial', counts: undefined, links: 2, merged: 2 },
    { first: 'read', second: 'offline', state: 'partial', counts: { machine_unavailable: 1 }, links: 1 },
    { first: 'read', second: 'timeout', state: 'partial', counts: { timed_out: 1 }, links: 1 },
    { first: 'offline', second: 'offline', state: 'unknown', counts: { machine_unavailable: 2 }, links: 0 },
    { first: 'timeout', second: 'timeout', state: 'error', counts: { timed_out: 2 }, links: 0 },
    { first: 'read', second: 'denied', state: 'partial', counts: { not_entitled: 1 }, links: 1 },
    { first: 'read', second: 'backend', state: 'partial', counts: { failed: 1 }, links: 1 },
  ])('delivers Work evidence through the standalone Action ($first, $second)', async ({ first, second, state, counts, links, merged }) => {
    const app = fastify();
    const sessions = [first, second].map((answer, index) => ({
      answer, sessionId: `work-session-${index}`, machineId: `work-machine-${index}`, pr: index + 1,
    }));
    const calls: string[] = [];
    const accounting = { ...response, contributions: sessions.map(target => ({
      id: `contribution-${target.sessionId}`, observedAtMs: 150, sessionId: target.sessionId,
      turnId: 'turn', agentId: 'codex', modelId: null, machineId: target.machineId,
      projectKey: 'project', workspaceId: null, source: 'session', tokens: response.totals.tokens, cost: response.totals.cost,
    })) };
    registerAccountingRoutes(app, async () => accounting);
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.get('/v1/account/profile', async () => ({ id: 'account', connectedAccountsV4: [], connectedAccountGroupsV4: [] }));
    app.post(USAGE_SESSION_EVIDENCE_PATH, async request => {
      const body = UsageSessionEvidenceRequestSchema.parse(request.body);
      return UsageSessionEvidenceResponseSchema.parse({ requests: body.requests.map(read => ({
        query: read.query, sessionIds: read.sessionIds ?? sessions.map(target => target.sessionId),
      })), results: sessions.map(target => ({ sessionId: target.sessionId,
        detail: { status: 200, body: { session: createSessionRecordFixture({ id: target.sessionId, encryptionMode: 'plain',
          metadata: JSON.stringify({ path: '/repo', machineId: target.machineId, agent: 'codex' }), share: null }) } },
      })) });
    });
    app.get<{ Params: { id: string } }>('/v1/machines/:id', async request => {
      const target = sessions.find(candidate => candidate.machineId === request.params.id)!;
      return { machine: { ...createAvailableSessionSpawnMachineSnapshot(target.machineId), storageMode: 'plain',
        active: target.answer !== 'offline', activeAt: Date.now(), presenceProtocolVersion: 1 } };
    });
    socketBoundary.mockImplementation(() => createApiSessionSocketStub({ emitWithAck: (event, payload) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error('Unexpected socket event');
      const packet = z.object({ method: z.string() }).parse(payload);
      const target = sessions.find(candidate => packet.method.startsWith(`${candidate.machineId}:`))!;
      calls.push(target.machineId);
      if (target.answer === 'offline') return { ok: false, error: 'No target', errorCode: 'target_unavailable' };
      if (target.answer === 'timeout') return { ok: false, error: 'Deadline', errorCode: 'MACHINE_RPC_TIMEOUT' };
      if (target.answer === 'denied') return { ok: false, error: 'Denied', errorCode: 'RPC_FORBIDDEN' };
      if (target.answer === 'backend') return { ok: true, result: { sessions: [{
        sessionId: target.sessionId, status: 'error', errorCode: 'BACKEND_UNAVAILABLE',
      }] } };
      const checkpoint = { sessionId: target.sessionId, turnId: 'turn', repositoryKey: 'repo', checkpointRef: 'checkpoint/turn',
        checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40), attributionScope: 'no_happier_checkpoint_overlap_observed' };
      return { ok: true, result: ScmWorkEvidenceReadResponseSchema.parse({ sessions: [{
        sessionId: target.sessionId, status: 'partial', pullRequestsRead: true,
        branchEvidence: [{ ...checkpoint, branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) } }],
        evidence: [{ ...checkpoint, pullRequest: { provider: { id: 'forge', kind: 'github', displayName: 'Forge',
          baseUrl: 'https://github.com', nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
          number: target.pr, title: 'Linked', url: `https://github.com/owner/repo/pull/${target.pr}`, baseBranch: 'main',
          headBranch: 'feature', state: 'merged' } }],
      }] }) };
    } }));
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage-work.test' });
    const credentials = { token: 'owner-token', encryption: null };
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
      token: credentials.token, credentials, serverId: 'home', serverHttpBaseUrl: 'http://usage-work.test' }) });
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, includeQuota: false, includeQuotaHistory: false,
      includeComparison: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: true });
    try {
      const result = await executor.execute('usage.query', { queries: [query] }, { surface: 'cli', serverId: 'home' });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const slice = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results[0]!;
      const work = slice.sources.find(source => source.source === 'work');
      expect.soft(work?.status).toBe(state);
      expect.soft(work?.unreadSessions).toEqual(counts);
      expect.soft(work?.errorCode === 'machine_offline').toBe(sessions.some(target => target.answer === 'offline'));
      expect.soft(slice.work?.outcomes.length ?? 0).toBe(links);
      expect.soft(slice.workSummary?.mergedPrCount).toBe(merged);
      expect(calls.sort()).toEqual(sessions.filter(target => target.answer !== 'offline').map(target => target.machineId));
    } finally {
      cleanup?.();
      cleanup = undefined;
      await app.close();
    }
  });

  it('reads the captured Account public view without private Usage and refuses a retired result', async () => {
    const app = fastify();
    let current = true;
    let retireOnRead = false;
    let reads = 0;
    app.get('/v1/account/public-profile/view', async () => {
      reads += 1;
      if (retireOnRead) current = false;
      return { kind: 'unavailable' };
    });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      ...createAccountServerActionDeps({ token: 'owner-token', serverId: 'home', serverHttpBaseUrl: 'http://usage.test',
        isCredentialCurrent: async () => current }),
    });
    const request = { source: { kind: 'public_profile' } };
    expect(await executor.execute('usage.recap.compose', request, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'public_profile_unavailable' } });
    expect(reads).toBe(1);
    retireOnRead = true;
    expect(await executor.execute('usage.recap.compose', request, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_retired' });
  });
  it.each(['full', 'summary'] as const)('opens admitted Session intervals and mixed Claude tools through the real HTTP owners and denies keyless E2EE (%s)', async detail => {
    const app = fastify();
    const sessionId = 'c111111111111111111111111';
    let mode: 'plain' | 'e2ee' = 'plain';
    let sessionReads = 0;
    let malformed = false;
    let accountingAvailable = true;
    const reads: string[] = [];
    app.addHook('preHandler', async request => { reads.push(request.url.split('?')[0]!); });
    const witness = ScmPullRequestWorkEvidenceSchema.parse({ sessionId, turnId: 'turn', repositoryKey: 'repo',
      checkpointRef: 'checkpoint/session/turn', checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed', pullRequest: { provider: { id: 'forge', kind: 'github',
        displayName: 'Forge', baseUrl: 'https://github.com', nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 7, title: 'Observed outcome', url: 'https://github.com/owner/repo/pull/7', baseBranch: 'main', headBranch: 'feature', state: 'merged' } });
    const { pullRequest: _pullRequest, ...checkpoint } = witness;
    const mcpUsage = UsageMcpBindingUsageSchema.parse({ v: 2, evidenceId: 'mcp-window', sessionId, turnId: 'turn', observedAtMs: 150,
      window: { startMs: 100, endMs: 150 }, coverage: 'complete', bindings: [{ serverId: 'docs', bindingId: 'docs-binding',
        serverRevision: 10, bindingRevision: 20, catalogRevision: 40, toolCallCount: 0, schemaBytes: null }] });
    const composition = { v: 1, evidenceId: 'composition', sessionId, turnId: 'turn', inputId: 'input', observedAtMs: 150,
      boundary: 'host_pre_dispatch', deliveryKind: 'newTurn', coverage: 'host_only', components: ['a', 'c'].map(source => ({
        sourceId: source.repeat(64), digest: 'b'.repeat(64), kind: 'instructions', location: 'user', byteLength: 200,
        tokenCount: null, tokenizerId: null, cacheClass: 'unknown', overlap: 'none' })), nativePrefix: null, contextWindowTokens: null };
    const workPackets: unknown[] = [];
    socketBoundary.mockImplementation(() => createApiSessionSocketStub({ emitWithAck: (event, payload) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error('Unexpected socket event');
      workPackets.push(payload);
      const packet = z.object({ method: z.string(), params: z.unknown(), authorization: z.optional(z.unknown()) }).parse(payload);
      expect(packet.method).toBe('machine:scm.workEvidence.read');
      expect(packet.params).toEqual({ sessions: [{ sessionId, cwd: '/repo', turnIds: ['turn'] }] });
      expect(packet.authorization).toEqual({ kind: 'scm.workEvidence', sessionIds: [sessionId] });
      return { ok: true, result: ScmWorkEvidenceReadResponseSchema.parse({ sessions: [{ sessionId, status: 'partial', evidence: [witness],
        branchEvidence: [{ ...checkpoint, branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) } }] }] }) };
    } }));
    const accounting = { ...response, contributions: [{ id: 'turn-cost', observedAtMs: 150, sessionId,
      turnId: 'turn', agentId: 'claude', modelId: null, machineId: 'machine', projectKey: null, workspaceId: null,
      source: 'session', tokens: response.totals.tokens, cost: response.totals.cost }] };
    registerAccountingRoutes(app, async (request, reply) => {
      UsageAnalyticsQueryRequestSchema.parse(request.body);
      return accountingAvailable ? accounting : reply.code(503).send({ error: 'unavailable' });
    });
    app.get('/v1/account/encryption/currentness', async () => ({ mode, version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.get('/v1/account/profile', async () => ({ id: 'account', connectedAccountsV4: [], connectedAccountGroupsV4: [] }));
    let revision = 40;
    let catalog: McpServerCatalogV1 = { v: 1, servers: [{ id: 'docs', name: 'docs', transport: 'stdio', stdio: { command: 'docs', args: [] },
        env: {}, createdAt: 1, updatedAt: 10 }], bindings: [{ id: 'docs-binding', serverId: 'docs', enabled: true,
        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 20 }] };
    app.get('/v1/account/entity-rows/mcp', async () => ({ status: 'present', revision, content: { t: 'plain', v: catalog } }));
    app.post('/v1/account/entity-rows/mcp', async (request, reply) => {
      const mutation = McpServerCatalogRowMutationV1Schema.parse(request.body);
      if (mutation.expectedRevision !== revision) return reply.code(409).send({ status: 'conflict', revision });
      if (mutation.content?.t !== 'plain') throw new Error('Expected plain Account catalog');
      catalog = mutation.content.v;
      return { status: 'updated', revision: ++revision, cursor: revision };
    });
    app.get('/v1/account/entity-rows/profiles/transfer', async () => ({ status: 'absent' }));
    app.get('/v2/account/settings/history', async () => ({ snapshots: [] }));
    app.get('/v1/machines/machine', async () => ({ machine: { ...createAvailableSessionSpawnMachineSnapshot('machine'), storageMode: 'plain' } }));
    app.get('/v2/sessions', async () => ({ sessions: [createCompactSessionListRowFixture(
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', share: null }))], hasNext: false }));
    app.get('/v2/sessions/archived', async () => ({ sessions: [], hasNext: false }));
    const readSession = () => {
      sessionReads += 1;
      return { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
        ...(detail === 'summary' ? { agentState: JSON.stringify({ completedRequests: { permission: { tool: 'Read', arguments: {},
          turnId: 'turn', createdAt: 100, completedAt: 110, status: 'approved', answeringClientCategory: 'web' } } }) } : {}),
        metadata: JSON.stringify({ path: '/repo', machineId: 'machine', agent: 'claude' }), share: null }) };
    };
    app.get(`/v2/sessions/${sessionId}`, async () => readSession());
    const readTurns = () => ({ v: 1, sessionId, updatedAt: 180,
      turns: [{ turnId: 'turn', agentId: 'claude', status: 'completed', startedAt: 120, terminalAt: 180, updatedAt: 180 }] });
    app.get(`/v1/sessions/${sessionId}/turns`, async () => readTurns());
    const readMessages = (roles: readonly string[]) => {
      if (malformed) return { messages: [{ content: 'invalid' }], hasMore: false };
      return { hasMore: false, messages: roles.includes('agent') ? [{ id: 'mixed', seq: 1, createdAt: 140,
        messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: { type: 'output',
          data: { type: 'assistant', message: { role: 'assistant', content: [
            { type: 'text', text: 'private prose must never be disclosed' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/secret' } },
            { type: 'tool_use', id: 'review-call', name: 'SubAgentRun', input: { runId: 'run-review', sidechainId: 'review-side', intent: 'review',
              backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, launchOrigin: { kind: 'session', sessionId }, label: 'private reviewer' } },
          ] } } } } } }, { id: 'mcp', seq: 2, createdAt: 150, messageRole: 'event', content: { t: 'plain', v: {
            role: 'agent', content: { type: 'event', id: 'mcp-event', data: { type: 'mcp-binding-usage', usage: mcpUsage } },
          } } }, { id: 'composition', seq: 3, createdAt: 150, messageRole: 'event', content: { t: 'plain', v: {
            role: 'agent', content: { type: 'event', id: 'composition-event', data: { type: 'prompt-composition', composition } },
          } } }] : [] };
    };
    app.get(`/v1/sessions/${sessionId}/messages`, async request => readMessages(String((request.query as { roles?: string }).roles).split(',')));
    app.post(USAGE_SESSION_EVIDENCE_PATH, async request => {
      const body = UsageSessionEvidenceRequestSchema.parse(request.body);
      // The Home fixture's Session census also serves accounting-unavailable discovery.
      const requests = body.requests.map(read => ({ query: read.query, sessionIds: read.sessionIds ?? [sessionId] }));
      const ids = [...new Set(requests.flatMap(read => read.sessionIds))];
      return UsageSessionEvidenceResponseSchema.parse({ requests,
        results: ids.map(id => ({ sessionId: id, detail: { status: 200, body: readSession() },
          ...(body.requests.some(read => read.query.includeSessionEvidence) ? { turns: { status: 200, body: readTurns() } } : {}),
          ...(body.requests.some(read => read.query.includeSessionEvidence && read.query.includeTranscriptEvidence)
            ? { messages: { status: 200, body: readMessages(['user', 'agent', 'event']) } } : {}),
        })),
      });
    });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`, encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({ token: credentials.token, credentials,
      serverId: 'home', serverHttpBaseUrl: 'http://usage.test' }),
      mcpServerAction: createCliMcpServerActionExecuteV1({ credentials, serverId: 'home', serverHttpBaseUrl: 'http://usage.test',
        callMachineAction: async () => { throw new Error('Binding mutation has no Machine effect'); } }),
    });
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, session: sessionId,
      ...(detail === 'summary' ? { includeTranscriptEvidence: false } : {}) });
    const read = async (selected = query) => {
      const result = await executor.execute('usage.query', { queries: [selected] }, { surface: 'cli', serverId: 'home' });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results[0]!;
    };
    const opened = await read();
    expect(workPackets).toHaveLength(1);
    if (detail === 'summary') {
      expect(opened.howYouWork).toMatchObject({ intervals: { agentTimeMs: 60, elapsedWaitMs: 10 }, detailStatus: 'partial',
        permissions: { requestCount: 1, pairedDecisionCount: 1, decisionLatencyMs: 10, byAnsweringClient: { web: 1 } } });
      expect(opened.howYouWork?.autopsy).toBeUndefined();
      expect(opened.howYouWork?.inputs).toBeNull();
      expect(opened.work?.allocations[0]?.reason).toBe('allocated');
      expect(reads).toContain(USAGE_SESSION_EVIDENCE_PATH);
      expect(reads).not.toContain('/v2/sessions/read-batch');
      expect(reads).not.toContain(`/v1/sessions/${sessionId}/messages`);
      const fullQuery = { ...query, includeTranscriptEvidence: true };
      const mixed = await executor.execute('usage.query', { queries: [query, fullQuery] }, { surface: 'cli', serverId: 'home' });
      expect(mixed.ok, JSON.stringify(mixed)).toBe(true);
      const slices = UsageQueryBatchResultSchema.parse(mixed.ok ? mixed.result : undefined).results;
      expect(slices.find(slice => slice.key === getUsageQueryKey(query))?.howYouWork?.autopsy).toBeUndefined();
      expect(slices.find(slice => slice.key === getUsageQueryKey(fullQuery))?.howYouWork?.autopsy?.events)
        .toEqual(expect.arrayContaining([expect.objectContaining({ evidenceId: 'read' })]));
      reads.length = 0;
      expect((await read({ ...query, includeSessionEvidence: false })).work?.allocations[0]?.reason).toBe('allocated');
      expect(reads).not.toContain(`/v1/sessions/${sessionId}/turns`);
      expect(reads).not.toContain(`/v1/sessions/${sessionId}/messages`);
      mode = 'e2ee';
      const denied = await read();
      expect(denied.howYouWork?.detailStatus).toBe('unknown');
      expect(denied.howYouWork?.intervals).toBeNull();
      await app.close();
      return;
    }
    expect(opened.howYouWork).toMatchObject({ intervals: { agentTimeMs: 60 },
      collaboration: { edges: [{ sourceAgentId: 'claude', targetAgentId: 'codex', relation: 'review', count: 1 }] },
      autopsy: { events: expect.arrayContaining([expect.objectContaining({ sessionId, kind: 'read', evidenceId: 'read' })]) } });
    expect(opened.work, JSON.stringify({ sources: opened.sources, socketReads: socketBoundary.mock.calls.length, reads })).toMatchObject({ allocations: [{ reason: 'allocated', outcome: { pullRequest: { number: 7 } } }],
      branchAllocations: [{ reason: 'allocated', branch: { branch: { ref: 'refs/heads/feature' } } }] });
    expect(opened.coach?.findings.find(finding => finding.detectorId === 'mcp_overhead')).toMatchObject({
      remedy: { kind: 'mcp_binding', bindingId: 'docs-binding', serverId: 'docs', target: { t: 'allMachines' }, enabled: false, expectedRevision: 40 },
      action: { actionId: 'usage.coach.apply' },
    });
    expect(opened.coach?.findings.find(finding => finding.detectorId === 'duplicated_instructions')).toMatchObject({
      remedy: { kind: 'prepared_session', input: { executionTarget: { serverId: 'home', machineId: 'machine' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } },
      action: { actionId: 'usage.coach.apply' },
    });
    const finding = opened.coach!.findings.find(finding => finding.detectorId === 'mcp_overhead')!;
    const actionContext = { surface: 'cli', serverId: 'home', authority: 'present_user', actionCaller: { kind: 'host' },
      actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
        'usage.coach.apply': ['cli'], 'usage.coach.undo': ['cli'], 'mcp.rules.set': ['cli'],
      } }) } as const;
    const applied = await executor.execute('usage.coach.apply', { query, evidenceKey: finding.evidenceKey }, actionContext);
    expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true, result: { kind: 'applied', reversal: { kind: 'mcp_binding',
      owner: { rules: [{ enabled: false }], previous: [{ enabled: true }] } } } });
    expect(catalog.bindings[0]?.enabled).toBe(false);
    const receipt = UsageCoachApplyResultSchema.parse(applied.ok ? applied.result : undefined);
    expect(await executor.execute('usage.coach.undo', { query, evidenceKey: finding.evidenceKey, reversal: receipt.reversal }, actionContext))
      .toMatchObject({ ok: true, result: { kind: 'undone' } });
    expect(catalog.bindings[0]?.enabled).toBe(true);
    expect(JSON.stringify(opened)).not.toContain('private prose');
    expect(JSON.stringify(opened)).not.toContain('/secret');
    expect(JSON.stringify(opened)).not.toContain('private reviewer');
    expect(sessionReads).toBeGreaterThan(0);
    reads.length = 0;
    expect((await read({ ...query, includeSessionEvidence: false })).work?.allocations[0]?.reason).toBe('allocated');
    expect(reads).not.toContain(`/v1/sessions/${sessionId}/messages`);
    expect(reads).not.toContain(`/v1/sessions/${sessionId}/turns`);
    const beforeScm = socketBoundary.mock.calls.length;
    expect((await read({ ...query, includeWorkEvidence: false })).howYouWork?.intervals?.agentTimeMs).toBe(60);
    expect(socketBoundary.mock.calls.length).toBe(beforeScm);
    accountingAvailable = false;
    expect((await read({ ...query, session: null, includeWorkEvidence: false })).howYouWork?.intervals?.agentTimeMs).toBe(60);
    accountingAvailable = true;
    malformed = true;
    expect((await read()).howYouWork?.detailStatus).toBe('unknown');
    malformed = false;
    mode = 'e2ee';
    const denied = await read();
    expect(denied.howYouWork?.detailStatus).toBe('unknown');
    expect(denied.howYouWork?.autopsy).toBeUndefined();
    await app.close();
  });
  it.each([
    { pluginId: 'happier.agent.cursor', localId: 'cursor-account' },
    { pluginId: 'acme.sleeping', localId: 'usage' },
  ])('composes retained quota/history/targets for $pluginId and persists Coach suppressions through Account KV', async service => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const app = fastify();
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const source = { bindingKind: 'account' as const, ref: { service, accountId: 'work' } };
    const key = { providerId: 'test', accountSubjectId: 'subject', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(key), recordKey: key,
      providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'subject' }, observedAtMs: 150, fetchedAtMs: 150,
      staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [
        { meterId: 'weekly', label: 'Weekly', used: 20, limit: 100, unit: 'requests', utilizationPct: 20,
          resetsAt: null, status: 'ok', details: {} },
      ] });
    const native = { ...response, coverage: { status: 'complete', reasons: [], sources: [
      { source: 'native', path: 'native', status: 'available', asOfMs: 180, eventCount: 1, historyComplete: true },
    ], missingDimensions: [], range: { startMs: 100, endMs: 200, complete: true }, ranked: [] }, contributions: [
      { id: 'native-cost', observedAtMs: 150, sessionId: null, turnId: null, agentId: null, modelId: null,
        machineId: 'machine', projectKey: null, workspaceId: null, source: 'native',
        sourceContext: { path: 'native', execution: 'outside' }, tokens: response.totals.tokens, cost: response.totals.cost },
    ] };
    const targets = [{ id: 'personal', scope: { kind: 'personal' }, utilizationFraction: 0.5 }];
    const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service: source.ref.service, groupId: 'shared' },
      incarnation: 'pool-lifetime', displayName: null, policy: {}, activeConnectedAccountId: 'work', generation: 1,
      runtimeStateRevision: 1, state: {}, createdAt: 100, updatedAt: 150,
      members: [{ v: 1, connectedAccountId: 'work', state: {}, createdAt: 100, updatedAt: 150 }] });
    const retainedSuppression = { kind: 'dismissed', evidenceKey: 'previous-native-finding' };
    let raw: Record<string, unknown> = { usageCoachPreferencesV1: { v: 1 }, usagePacingTargetsV1: targets };
    let version = 1;
    let settingsWrites = 0;
    const kvRows = new Map<string, { key: string; value: string; version: number }>();
    kvRows.set(USAGE_COACH_SUPPRESSIONS_KV_KEY, { key: USAGE_COACH_SUPPRESSIONS_KV_KEY, version: 0,
      value: encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: { v: 1, suppressions: [retainedSuppression] } }))) });
    let failCoachKv = false;
    // Opaque HTTP persistence is the boundary; encryption, CAS client and Coach owner stay real.
    app.get('/v1/kv/:key', async (request, reply) => {
      const { key } = z.object({ key: z.string() }).parse(request.params);
      if (key === USAGE_COACH_SUPPRESSIONS_KV_KEY && failCoachKv) return reply.code(503).send({ error: 'unavailable' });
      return kvRows.get(key) ?? reply.code(404).send({ error: 'not_found' });
    });
    app.post('/v1/kv', async (request, reply) => {
      const { mutations } = z.strictObject({ mutations: z.array(z.strictObject({
        key: z.string(), value: z.nullable(z.string()), version: z.number().check(z.int()),
      })) }).parse(request.body);
      const errors = mutations.flatMap(mutation => {
        const row = kvRows.get(mutation.key);
        return mutation.version === (row?.version ?? -1) ? [] : [{ key: mutation.key, error: 'version-mismatch',
          version: row?.version ?? -1, value: row?.value ?? null }];
      });
      if (errors.length) return reply.code(409).send({ success: false, errors });
      return { success: true, results: mutations.map(mutation => {
        const version = (kvRows.get(mutation.key)?.version ?? -1) + 1;
        if (mutation.value === null) kvRows.delete(mutation.key);
        else kvRows.set(mutation.key, { key: mutation.key, value: mutation.value, version });
        return { key: mutation.key, version };
      }) };
    });
    const suppressions = () => {
      const row = kvRows.get(USAGE_COACH_SUPPRESSIONS_KV_KEY);
      expect(row).toBeDefined();
      const envelope = StoredJsonContentEnvelopeSchema.parse(JSON.parse(new TextDecoder().decode(decodeBase64(row!.value))));
      if (envelope.t !== 'plain') throw new Error('Expected plain Account KV envelope');
      return UsageCoachSuppressionStateV1Schema.parse(envelope.v).suppressions;
    };
    let mode: 'plain' | 'e2ee' = 'plain';
    let denied = false;
    let includeUnavailableAccount = false;
    let includeHealthyAccount = false;
    let quotaUnavailable = false;
    let ownershipRefusal: 'resolve' | 'record' | 'history' | null = null;
    let noUsageObserved = false;
    let pagedHistory = true;
    let rangeHistoryReads = 0;
    const cursor = { id: 'history', observedAtMs: 150 };
    const historyRequest = { range: { startAtMs: 100, endAtMs: 200 }, pageSize: 100 };
    let expectedHistoryRequest = historyRequest;
    const accountingRequests: ReturnType<typeof UsageAnalyticsQueryRequestSchema.parse>[] = [];
    let releaseContinuation!: () => void;
    const heldContinuation = new Promise<void>(resolve => { releaseContinuation = resolve; });
    let enteredContinuation!: () => void;
    const continuationEntered = new Promise<void>(resolve => { enteredContinuation = resolve; });
    const unavailableSource = { ...source, ref: { ...source.ref, accountId: 'unavailable' } };
    const healthySource = { ...source, ref: { ...source.ref, accountId: 'healthy' } };
    app.addHook('preHandler', async request => { expect(request.headers.authorization).toBe('Bearer owner-token'); });
    registerAccountingRoutes(app, async request => {
      accountingRequests.push(UsageAnalyticsQueryRequestSchema.parse(request.body));
      return native;
    });
    app.post(USAGE_SESSION_EVIDENCE_PATH, async request => {
      const body = UsageSessionEvidenceRequestSchema.parse(request.body);
      // This native-only fixture has no retained Happier Sessions to open.
      return UsageSessionEvidenceResponseSchema.parse({ requests: body.requests.map(({ query }) => ({ query, sessionIds: [] })), results: [] });
    });
    app.get('/v1/account/profile', async (_request, reply) => denied ? reply.code(403).send({ error: 'denied' }) : ({ id: 'account', connectedAccountsV4: [{
      ref: source.ref, status: 'connected', authenticationModeId: null, revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: true, configurationRevision: '1', scopes: [],
    }, ...(includeUnavailableAccount ? [{ ref: unavailableSource.ref, status: 'connected', authenticationModeId: null,
      revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: true,
      configurationRevision: '1', scopes: [] }] : []), ...(includeHealthyAccount ? [{ ref: healthySource.ref,
      status: 'connected', authenticationModeId: null, revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: true, configurationRevision: '1', scopes: [] }] : [])],
      connectedAccountGroupsV4: [group] }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode, version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/encryption', async () => ({ mode, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: raw }, version }));
    app.post('/v2/account/settings', async (request, reply) => {
      settingsWrites += 1;
      const mutation = AccountSettingsV2UpdateRequestSchema.parse(request.body);
      if (mutation.expectedVersion !== version) return reply.code(409).send({ success: false, error: 'version-mismatch', currentVersion: version,
        currentContent: { t: 'plain', v: raw } });
      expect(mutation.content?.t).toBe('plain');
      if (mutation.content?.t === 'plain') raw = mutation.content.v;
      return { success: true, version: ++version };
    });
    app.get('/v4/connect/qualified/provider-account-usage/sources/resolve', async (request, reply) => {
      if (noUsageObserved) return reply.code(404).send({ error: 'provider_account_usage_source_not_found' });
      const requested = QualifiedConnectedServiceUsageSourceV4Schema.parse(JSON.parse(z.object({ source: z.string() }).parse(request.query).source));
      if (ownershipRefusal === 'resolve' && requested.ref.accountId === source.ref.accountId) {
        return reply.code(409).send({ error: 'ownership_unproven' });
      }
      return quotaUnavailable || requested.ref.accountId === unavailableSource.ref.accountId
        ? reply.code(503).send({ error: 'provider_account_usage_read_failed' })
        : { source: requested, recordId: snapshot.recordId, providerAccountId: 'subject', fetchedAt: record.metadata.fetchedAt, staleAfterMs: 1000 };
    });
    const record = { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 150, staleAfterMs: 1000, status: 'ok' }, sources: [source, healthySource] };
    app.get('/v4/connect/qualified/provider-account-usage/record', async (_request, reply) =>
      ownershipRefusal === 'record' ? reply.code(409).send({ error: 'ownership_unproven' }) : record);
    app.get('/v4/connect/qualified/provider-account-usage/history', async (request, reply) => {
      if (ownershipRefusal === 'history') return reply.code(409).send({ error: 'ownership_unproven' });
      const requested = QualifiedProviderAccountUsageHistoryRequestV4Schema.parse(JSON.parse(z.object({ query: z.string() }).parse(request.query).query));
      if (!('history' in requested)) throw new Error('Expected a range history read');
      rangeHistoryReads += 1;
      if (requested.history.cursor) {
        expect(requested).toEqual({ recordId: snapshot.recordId, history: { ...historyRequest, cursor } });
        enteredContinuation();
        await heldContinuation;
        return { entries: [{ id: 'next-history', observedAtMs: 175, record: { ...record,
          metadata: { ...record.metadata, fetchedAt: 175 },
          content: { t: 'plain', v: { ...snapshot, observedAtMs: 175, fetchedAtMs: 175 } } } }], nextCursor: null };
      }
      expect(requested).toEqual({ recordId: snapshot.recordId, history: expectedHistoryRequest });
      return { entries: [{ id: 'history', observedAtMs: 150, record }], nextCursor: pagedHistory ? cursor : null };
    });
    app.post('/v2/pending/reset-starts/read', async () => ({ entries: [] }));
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const credentials = { token: 'owner-token', encryption: null };
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"usage.query": Object.keys(ActionSurfaceSchema.shape), "connectedServices.quota.get": Object.keys(ActionSurfaceSchema.shape), "usage.coach.dismiss": Object.keys(ActionSurfaceSchema.shape), "settings.get": Object.keys(ActionSurfaceSchema.shape), "settings.set": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({ token: credentials.token, credentials,
      serverId: 'home', serverHttpBaseUrl: 'http://usage.test' }),
      settingsDeclarationAction: createCliSettingsDeclarationAction({ credentials, serverHttpBaseUrl: 'http://usage.test' }),
      connectedServiceAction: createCliConnectedServiceAction({ credentials, serverId: 'home', serverHttpBaseUrl: 'http://usage.test',
        resolveHeaders: () => ({ Authorization: 'Bearer owner-token' }),
        callMachineAction: async () => { throw new Error('Quota reads have no Machine effect'); },
      }),

    });
    const read = async (selected = query) => {
      const result = await executor.execute('usage.query', { queries: [selected] }, { surface: 'cli', serverId: 'home' });
      expect(result.ok).toBe(true);
      return UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results[0]!;
    };
    const snapshotRead = read();
    try {
      const first = await Promise.race([
        snapshotRead.then(slice => ({ kind: 'snapshot' as const, slice })),
        continuationEntered.then(() => ({ kind: 'continuation_before_snapshot' as const })),
      ]);
      expect(first.kind).toBe('snapshot');
      if (first.kind !== 'snapshot') throw new Error('Usage withheld its current snapshot behind historical continuation');
      expect(first.slice.pending).toBe(false);
      expect(first.slice.quota).toMatchObject([{ source, current: snapshot,
        history: { entries: [{ id: 'history' }], nextCursor: cursor }, unusedCapacity: { historyStatus: 'partial' }, targets }]);
      expect(first.slice.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'quota', status: 'partial' }),
        expect.objectContaining({ source: `quota:${createCanonicalJsonSigningInput(source)}`, status: 'partial' }),
      ]));
      const quota = first.slice.quota![0]!;
      const continuation = executor.execute('connectedServices.quota.get', { source: quota.source,
        history: { ...historyRequest, cursor: quota.history!.nextCursor! } }, { surface: 'cli', serverId: 'home' });
      await continuationEntered;
      releaseContinuation();
      const next = await continuation;
      expect(next.ok, JSON.stringify(next)).toBe(true);
      expect(ConnectedServiceQuotaGetResultV1Schema.parse(next.ok ? next.result : undefined)).toMatchObject({ source,
        current: snapshot, history: { entries: [{ id: 'next-history', snapshot: { observedAtMs: 175 } }], nextCursor: null },
        unusedCapacity: { historyStatus: 'returned_page' }, targets });
    } finally { releaseContinuation(); await snapshotRead; pagedHistory = false; }
    const savedContent = record.content;
    record.content = { t: 'plain', v: { ...snapshot, state: 'not_loaded', observedAtMs: 0, fetchedAtMs: 0, meters: [] } };
    const savedFetchedAt = record.metadata.fetchedAt;
    record.metadata.fetchedAt = 0;
    for (const missingRecord of [true, false]) {
      noUsageObserved = missingRecord;
      const noSample = await read(normalizeUsageQuery({ ...query, includeQuotaHistory: false }));
      if (missingRecord) {
        expect(noSample.quota, JSON.stringify(noSample.sources)).toBeUndefined();
      } else {
        expect(noSample.quota, JSON.stringify(noSample.sources)).toMatchObject([
          { current: { state: 'not_loaded', observedAtMs: 0 } },
        ]);
      }
      const expectedStatus = missingRecord ? 'unsupported' : 'available';
      expect(noSample.sources.filter(row => row.source === 'quota' || row.source.startsWith('quota:')))
        .toEqual([expect.objectContaining({ status: expectedStatus }), expect.objectContaining({ status: expectedStatus })]);
      expect(noSample.sources.filter(row => row.source === 'quota' || row.source.startsWith('quota:')))
        .toEqual([expect.not.objectContaining({ asOfMs: expect.any(Number) }), expect.not.objectContaining({ asOfMs: expect.any(Number) })]);
    }
    noUsageObserved = false;
    record.content = savedContent;
    record.metadata.fetchedAt = savedFetchedAt;
    const slice = await read();
    expect(slice.pending).toBe(false);
    expect(slice.quota).toMatchObject([{ current: snapshot, history: { entries: [{ id: 'history' }], nextCursor: null }, targets }]);
    expect(slice.sources.filter(row => row.source === 'quota' || row.source.startsWith('quota:')))
      .toEqual([expect.objectContaining({ asOfMs: 150 }), expect.objectContaining({ asOfMs: 150 })]);
    const beforeHead = rangeHistoryReads;
    const head = await read(normalizeUsageQuery({ ...query, includeQuotaHistory: false }));
    expect(rangeHistoryReads).toBe(beforeHead);
    expect(head.key).not.toBe(slice.key);
    expect(head.quota).toMatchObject([{ current: snapshot, unusedCapacity: { historyStatus: 'not_loaded' }, targets }]);
    expect(head.quota?.[0]?.history).toBeUndefined();
    expect(head.quota?.[0]?.pageFacts).toBeUndefined();
    expect((await read()).quota).toMatchObject([{ history: { entries: [{ id: 'history' }], nextCursor: null } }]);
    expect(rangeHistoryReads).toBe(beforeHead + 1);
    // A head-only sibling neither suppresses the later full clause nor widens
    // its history range (the real HTTP route above requires exactly 100–200).
    const mixed = await executor.execute('usage.query', { queries: [
      normalizeUsageQuery({ ...query, period: { startMs: 0, endMs: 300 }, includeQuotaHistory: false }), query,
    ] }, { surface: 'cli', serverId: 'home' });
    expect(mixed.ok).toBe(true);
    expect(UsageQueryBatchResultSchema.parse(mixed.ok ? mixed.result : undefined).results
      .find(result => result.key === slice.key)?.quota).toMatchObject([{ history: { entries: [{ id: 'history' }], nextCursor: null } }]);
    expect(rangeHistoryReads).toBe(beforeHead + 2);
    // Named All has an open accounting start; quota history still spans all
    // retained observations through its existing numeric range contract.
    try {
      expectedHistoryRequest = { range: { startAtMs: 0, endAtMs: 1_000 }, pageSize: 100 };
      const beforeAll = rangeHistoryReads;
      const all = await read(normalizeUsageQuery({ ...query, period: { relative: 'all' } }));
      expect(accountingRequests.at(-1)?.dateRange).toEqual({ endMs: 1_000 });
      expect(all.quota).toMatchObject([{ history: { entries: [{ id: 'history' }], nextCursor: null } }]);
      expect(rangeHistoryReads).toBe(beforeAll + 1);
    } finally { expectedHistoryRequest = historyRequest; }
    expect(slice.pools).toMatchObject([{ group: group.ref, memberAccountIds: ['work'], activeAccountId: 'work',
      selection: { status: 'unsupported', errorCode: 'machine_context_unavailable' } }]);
    expect(slice.sources).toEqual(expect.arrayContaining([{ source: 'accounting', status: 'available', asOfMs: 180 },
      expect.objectContaining({ source: 'work', status: 'unknown' })]));
    const finding = slice.coach!.findings.find(row => row.detectorId === 'outside_usage')!;
    expect(finding.currentness).toBe('current');
    const preferencesBefore = structuredClone(raw.usageCoachPreferencesV1);
    const dismissed = await executor.execute('usage.coach.dismiss', { query, evidenceKey: finding.evidenceKey, dismissed: true },
      { surface: 'cli', serverId: 'home', authority: 'present_user' });
    expect(dismissed, JSON.stringify(dismissed)).toMatchObject({ ok: true, result: { kind: 'preference_updated' } });
    expect((await read()).coach!.findings.find(row => row.evidenceKey === finding.evidenceKey)?.state.dismissed).toBe(true);
    expect(suppressions()).toEqual([retainedSuppression, { kind: 'dismissed', evidenceKey: finding.evidenceKey }]);
    failCoachKv = true;
    try {
      const failedCoach = await read();
      expect.soft(failedCoach.quota).toMatchObject([{ source, current: snapshot }]);
      expect.soft(failedCoach.sources).toContainEqual(expect.objectContaining({
        source: 'how_you_work:coach', status: 'error', errorCode: 'account_kv_unavailable',
      }));
      expect.soft(failedCoach.coach).toBeUndefined();
      const withoutCoach = await read(normalizeUsageQuery({ ...query, includeCoach: false }));
      expect.soft(withoutCoach.quota).toMatchObject([{ source, current: snapshot }]);
      expect.soft(withoutCoach.sources).not.toContainEqual(expect.objectContaining({ source: 'how_you_work:coach' }));
    } finally {
      failCoachKv = false;
    }
    expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey: finding.evidenceKey, dismissed: false },
      { surface: 'cli', serverId: 'home', authority: 'present_user' })).toMatchObject({ ok: true });
    expect((await read()).coach!.findings.find(row => row.evidenceKey === finding.evidenceKey)?.state.dismissed).toBe(false);
    expect(suppressions()).toEqual([retainedSuppression]);
    expect(await executor.execute('usage.coach.dismiss', { query, evidenceKey: finding.evidenceKey, dismissed: true },
      { surface: 'cli', serverId: 'home', authority: 'present_user' })).toMatchObject({ ok: true });
    expect(settingsWrites).toBe(0);
    expect(raw.usageCoachPreferencesV1).toEqual(preferencesBefore);
    const preferenceRead = await executor.execute('settings.get', { anchor: 'usage.coachPreferences', includeVersion: true },
      { surface: 'cli', serverId: 'home' });
    expect(preferenceRead).toMatchObject({ ok: true, result: { value: { disabledChecks: [], modelSuggestion: 'suggest_with_estimates' } } });
    const configured = await executor.execute('settings.set', { anchor: 'usage.coachPreferences',
      value: { v: 1, disabledChecks: ['outside_usage'], modelSuggestion: 'off' },
      expectedSettingsVersion: version }, { surface: 'cli', serverId: 'home', authority: 'present_user' });
    expect(configured).toMatchObject({ ok: true });
    expect(suppressions()).toEqual([retainedSuppression, { kind: 'dismissed', evidenceKey: finding.evidenceKey }]);
    expect(raw.usageCoachPreferencesV1).toEqual({ v: 1, disabledChecks: ['outside_usage'], modelSuggestion: 'off' });
    expect((await read()).coach!.evaluations.find(row => row.detectorId === 'outside_usage')?.status).toBe('disabled');
    expect((await read()).coach!.findings).toEqual([]);
    expect(await executor.execute('settings.set', { anchor: 'usage.coachPreferences', value: { v: 1, disabledChecks: [], modelSuggestion: 'off' },
      expectedSettingsVersion: 1 }, { surface: 'cli', serverId: 'home', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'account_settings_conflict' });
    expect((await read()).coach!.findings).toEqual([]);
    for (const boundary of ['resolve', 'record', 'history'] as const) {
      record.content = { t: 'plain', v: snapshot };
      includeHealthyAccount = boundary === 'resolve';
      const warm = await read();
      expect(warm.quota?.[0]?.current?.meters[0]?.used).toBe(20);
      if (includeHealthyAccount) expect(warm.quota).toEqual(expect.arrayContaining([
        expect.objectContaining({ source, current: snapshot }), expect.objectContaining({ source: healthySource, current: snapshot }),
      ]));
      ownershipRefusal = boundary;
      const refused = await read();
      if (includeHealthyAccount) {
        expect(refused.quota).toMatchObject([{ source: healthySource, current: snapshot }]);
        expect(refused.sources.find(row => row.source === `quota:${createCanonicalJsonSigningInput(healthySource)}`))
          .toMatchObject({ status: 'available' });
      } else expect(refused.quota).toBeUndefined();
      expect(refused.quota?.some(row => createCanonicalJsonSigningInput(row.source) === createCanonicalJsonSigningInput(source)) ?? false).toBe(false);
      expect(refused.pending).toBe(false);
      expect(refused.sources.find(row => row.source === `quota:${createCanonicalJsonSigningInput(source)}`))
        .toMatchObject({ status: 'error', errorCode: 'ownership_unproven' });
      ownershipRefusal = null;
      includeHealthyAccount = false;
      record.content = { t: 'plain', v: { ...snapshot, meters: [{ ...snapshot.meters[0]!, used: 45, utilizationPct: 45 }] } };
      expect((await read()).quota).toMatchObject([{ source, current: { meters: [{ used: 45, utilizationPct: 45 }] } }]);
    }
    record.content = { t: 'plain', v: snapshot };
    includeUnavailableAccount = true;
    const partial = await read();
    expect(partial.quota).toEqual(slice.quota);
    expect(partial.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: `quota:${createCanonicalJsonSigningInput(source)}`, status: 'available', asOfMs: 150 }),
      expect.objectContaining({ source: `quota:${createCanonicalJsonSigningInput(unavailableSource)}`, status: 'error', errorCode: expect.any(String) }),
    ]));
    quotaUnavailable = true;
    const failed = await read();
    expect(failed.quota).toBeUndefined();
    expect(failed.pending).toBe(false);
    expect(failed.sources.filter(row => row.source.startsWith('quota:'))).toEqual([
      expect.objectContaining({ source: `quota:${createCanonicalJsonSigningInput(source)}`, status: 'error', errorCode: expect.any(String) }),
      expect.objectContaining({ source: `quota:${createCanonicalJsonSigningInput(unavailableSource)}`, status: 'error', errorCode: expect.any(String) }),
    ]);
    quotaUnavailable = false; includeUnavailableAccount = false;
    mode = 'e2ee';
    const locked = await read();
    expect(locked.quota).toBeUndefined();
    expect(locked.sources.find(row => row.source === 'quota')).toMatchObject({ status: 'unknown' });
    expect(locked.pending).toBe(false);
    expect(locked.coach!.findings).toEqual([]);
    expect(locked.coach!.evaluations.every(row => row.status === 'insufficient_evidence')).toBe(true);
    mode = 'plain'; denied = true;
    expect((await read()).quota).toBeUndefined();
    await app.close();
  });
  it('exports selected retained quota dates through the real MCP calendar Action without accounting or provider refresh', async () => {
    const app = fastify();
    let state: 'current' | 'unpublished' | 'denied' | 'retired' | 'cancelled' = 'current';
    const controller = new AbortController();
    let current = true;
    const source = { bindingKind: 'account' as const, ref: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'work' } };
    const recordKey = { providerId: 'test', accountSubjectId: 'subject', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'subject' }, observedAtMs: 100, fetchedAtMs: 100,
      staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
      meters: [{ meterId: 'week', label: 'Weekly', used: 20, limit: 100, utilizationPct: 20, unit: 'requests', status: 'ok',
        resetsAt: Date.UTC(2026, 9, 10, 4, 30) }],
      subscription: { status: 'subscribed', observedAtMs: 100, staleAfterMs: 1000, renewal: 'on', currentPeriodEndAtMs: Date.UTC(2026, 9, 11, 4, 30) } });
    const paths: string[] = [];
    app.addHook('preHandler', async request => { expect(request.headers.authorization).toBe('Bearer owner-token'); paths.push(request.url.split('?')[0]!); });
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.get('/v4/connect/qualified/provider-account-usage/sources/resolve', async (_request, reply) => {
      if (state === 'unpublished') return reply.code(404).send({ error: 'provider_account_usage_source_not_found' });
      if (state === 'denied') return reply.code(403).send({ error: 'denied' });
      if (state === 'retired') current = false;
      if (state === 'cancelled') controller.abort();
      return { source, recordId: snapshot.recordId, providerAccountId: 'subject', fetchedAt: 100, staleAfterMs: 1000 };
    });
    app.get('/v4/connect/qualified/provider-account-usage/record', async () => ({ content: { t: 'plain', v: snapshot },
      metadata: { fetchedAt: 100, staleAfterMs: 1000, status: 'ok' }, sources: [source] }));
    app.post('/v2/pending/reset-starts/read', async () => ({ entries: [] }));
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({ token: 'owner-token', credentials: { token: 'owner-token', encryption: null },
      serverId: 'home', serverHttpBaseUrl: 'http://usage.test', isCredentialCurrent: () => current }) });
    const input = { query: normalizeUsageQuery({}), selectedEvents: [
      { account: source.ref, kind: 'reset', meterId: 'week' }, { account: source.ref, kind: 'renewal' },
    ] };
    const bridge = createActionToolExecutorBridge({ executor, surface: 'mcp' });
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    registerHappierMcpBuiltInTools({ registerTool: (name, _meta, handler) => { handlers.set(name, handler); } }, {
      sessionId: '', surface: 'mcp', deps: { executeActionByToolName: bridge.executeActionByToolName,
        changeTitle: async () => { throw new Error('Calendar cannot change a Session'); } },
    });
    const output = z.object({ isError: z.boolean(), content: z.array(z.object({ type: z.literal('text'), text: z.string() })) })
      .parse(await handlers.get('action_execute')?.({ actionId: 'usage.calendar.export', input }));
    expect(output.isError, output.content.map(part => part.text).join('\n')).toBe(false);
    const file = UsageFileResultSchema.parse(JSON.parse(output.content[0]!.text));
    const text = new TextDecoder().decode(decodeBase64(file.base64));
    expect(text).toContain('DTSTART:20261010T043000Z\r\n');
    expect(text).toContain('DTSTART:20261011T043000Z\r\n');
    expect(paths.filter(path => path.endsWith('/sources/resolve'))).toHaveLength(1);
    const beforeUnadmitted = paths.length;
    expect(await executor.execute('usage.calendar.export', input, { surface: 'mcp', serverId: 'home',
      externalActionCredential: { accountId: 'account', principalId: 'principal', credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 } }))
      .toMatchObject({ ok: false, errorCode: 'action_failed', effectAttempted: false,
        details: { authorizationRefusalReason: 'external_credential_without_authorization' },
        failureCause: { phase: 'execution_authorization' } });
    expect(paths).toHaveLength(beforeUnadmitted);
    for (const next of ['unpublished', 'denied', 'retired', 'cancelled'] as const) {
      state = next;
      const result = await executor.execute('usage.calendar.export', input, { surface: 'mcp', serverId: 'home',
        ...(next === 'cancelled' ? { signal: controller.signal } : {}) });
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('result');
      if (next === 'unpublished') expect(result).toMatchObject({ errorCode: 'usage_calendar_fact_unavailable' });
      if (next === 'retired') expect(result).toMatchObject({ errorCode: 'credential_scope_retired' });
      if (next === 'cancelled') expect(result).toMatchObject({ errorCode: 'cancelled' });
      current = true;
    }
    expect(paths).not.toContain('/v2/usage/query');
    expect(paths.every(path => !path.includes('refresh'))).toBe(true);
    await app.close();
  });
  it('asks for every key a grouped Project\'s usage may carry, from one census read (owner 11-08)', async () => {
    const app = fastify();
    const admitted: unknown[] = [];
    // "member" joined "project" after its usage was stamped with its own id.
    const ref = (id: string) => ({ id, serverId: 'home', machineId: `machine-${id}`, rootPath: '/repo', projectKey: 'project', createdAtMs: 1 });
    const row = (value: ReturnType<typeof ref>) => {
      const key = { kind: 'workspace-ref', serverId: 'home', id: value.id };
      return { key, revision: 1, content: { t: 'plain', v: { key, value } } };
    };
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
    app.post('/v1/account/project-rows/list', async () => ({ status: 'listed', coverage: 'complete', rows: [row(ref('project')), row(ref('member'))] }));
    registerAccountingRoutes(app, async request => {
      admitted.push(UsageAnalyticsQueryRequestSchema.parse(request.body));
      return response;
    });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage-project-scope.test' });
    const deps = createAccountServerActionDeps({ token: 'owner-token', serverId: 'home', serverHttpBaseUrl: 'http://usage-project-scope.test' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
    const query = normalizeUsageQuery({ projects: ['project'] });
    expect((await executor.execute('usage.query', { queries: [query] }, { surface: 'mcp', serverId: 'home' })).ok).toBe(true);
    expect(admitted.map(request => [...((request as { filters?: { projectKeys?: string[] } }).filters?.projectKeys ?? [])].sort()))
      .toEqual([['member', 'project']]);
    await app.close();
  });

  it('queries independent slices through the canonical batch Action without dropping filters', async () => {
    const app = fastify();
    const admitted: unknown[] = [];
    registerAccountingRoutes(app, async request => {
      expect(request.headers.authorization).toBe('Bearer owner-token');
      admitted.push(UsageAnalyticsQueryRequestSchema.parse(request.body));
      return response;
    });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const deps = createAccountServerActionDeps({ token: 'owner-token', serverId: 'home', serverHttpBaseUrl: 'http://usage.test' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
    const query = normalizeUsageQuery({ agents: ['b', 'a'], machines: ['machine'], projects: ['project'],
      sources: ['native'], session: ['s2', 's1'], costBasis: 'estimated', breakdown: ['machine'], includeInsights: true });
    const queries = [query, { ...query, agents: ['a', 'b', 'a'] }, { ...query, period: { startMs: 100, endMs: 200 } }];
    let output = '';
    // Credential storage, stdout, HTTP and the MCP SDK registrar are system boundaries.
    // CLI field compilation, tool catalogs, dispatch and the Action executor remain real.
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    await handleActionsCommand(['invoke', 'usage.query', '--queries-json', JSON.stringify(queries), '--json'], {
      readCredentialsFn: async () => ({ token: 'owner-token', encryption: null }),
      createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
        serverId: 'home', serverApiUrl: 'http://usage.test',
        actionsSettingsProvider: createActionSettingsProvider({ scopeKey: 'usage-test' }),
      }),
    });
    expect(process.exitCode).toBe(0);
    const cliResult = z.object({ ok: z.literal(true), data: UsageQueryBatchResultSchema }).parse(JSON.parse(output)).data;
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const bridge = createActionToolExecutorBridge({ executor, surface: 'mcp' });
    registerHappierMcpBuiltInTools({ registerTool: (name, _meta, handler) => { handlers.set(name, handler); } }, {
      sessionId: '', surface: 'mcp', deps: { executeActionByToolName: bridge.executeActionByToolName,
        changeTitle: async () => { throw new Error('Usage read must not change a Session'); } },
    });
    const invokeQuery = handlers.get('action_execute');
    expect(invokeQuery).toBeDefined();
    const mcpOutput = z.object({ isError: z.literal(false), content: z.array(z.object({ type: z.literal('text'), text: z.string() })) })
      .parse(await invokeQuery?.({ actionId: 'usage.query', input: { queries } }));
    const mcpResult = UsageQueryBatchResultSchema.parse(JSON.parse(mcpOutput.content[0]!.text));
    for (const result of [cliResult, mcpResult]) {
      expect(result).toMatchObject({ results: expect.arrayContaining([
        expect.objectContaining({ accounting: expect.objectContaining(response), requestedQuery: expect.objectContaining({ agents: ['a', 'b'] }) }),
        expect.objectContaining({ accounting: expect.objectContaining(response), requestedQuery: expect.objectContaining({ period: { startMs: 100, endMs: 200 } }) }),
      ]) });
      expect(result.results.every(slice =>
        slice.sources.find(source => source.source === 'accounting')?.asOfMs === slice.accounting?.coverage?.range.endMs)).toBe(true);
    }
    expect(admitted).toHaveLength(6);
    expect(admitted).toEqual(expect.arrayContaining([expect.objectContaining({ costMode: 'estimated', breakdowns: ['machine'], includeInsights: true,
      filters: expect.objectContaining({ agentIds: ['a', 'b'], machineIds: ['machine'], projectKeys: ['project'], sources: ['native'], sessionIds: ['s1', 's2'] }) })]));
    await app.close();
  });
  it('refuses a retired credential and a different Home before private snapshot disclosure', async () => {
    const deps = createAccountServerActionDeps({ token: 'owner-token', serverId: 'home', serverHttpBaseUrl: 'http://usage.test',
      isCredentialCurrent: () => false });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
    expect(await executor.execute('usage.query', { queries: [{}] }, { surface: 'mcp', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_retired' });
    expect(await executor.execute('usage.query', { queries: [{}] }, { surface: 'cli', serverId: 'other' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
  });
  it('drops returned private facts when the captured credential retires during the HTTP read', async () => {
    const app = fastify();
    let current = true;
    registerAccountingRoutes(app, async () => { current = false; return response; });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({ token: 'owner-token', serverId: 'home',
      serverHttpBaseUrl: 'http://usage.test', isCredentialCurrent: () => current }) });
    expect(await executor.execute('usage.query', { queries: [{}] }, { surface: 'mcp', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_retired' });
    await app.close();
  });
  it('never substitutes the daemon bearer for an external invocation without its signed Home admission', async () => {
    const app = fastify();
    let disclosed = false;
    registerAccountingRoutes(app, async () => { disclosed = true; return response; });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const deps = createAccountServerActionDeps({ token: 'daemon-token-must-not-cross', serverId: 'home',
      serverHttpBaseUrl: 'http://usage.test' });
    expect(await deps.usageActions!.query({ queries: [normalizeUsageQuery({})] }, { surface: 'api',
      externalActionCredential: { accountId: 'account', principalId: 'principal', credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 } }))
      .toMatchObject({ ok: false, errorCode: 'action_failed', effectAttempted: false,
        details: { authorizationRefusalReason: 'external_credential_without_authorization' } });
    expect(disclosed).toBe(false);
    await app.close();
  });
  it.each([1, 51])('signs the exact query effect and body and preserves an unmarked Home scope denial (%s slices)', async count => {
    const app = fastify();
    const signer = tweetnacl.sign.keyPair();
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-minted-invocation', binding: {
      serverIdentityId: 'home', accountId: 'account', principalId: 'principal', credentialId: 'credential',
      custodianAccountId: 'account', installationId: 'installation',
      grant: API_TOKEN_FULL_GRANT_V1, machineId: 'machine', actionId: 'usage.query', requestId: 'request',
      requestEnvelopeDigest: 'A'.repeat(43), target,
    } });
    const path = count === 1 ? '/v2/usage/query' : '/v2/usage/query-batch';
    app.post(path, async (request, reply) => {
      expect(request.headers.authorization).toBeUndefined();
      const framed = decodeExternalActionHttpBodyV1(request.body);
      expect(framed).not.toBeNull();
      const headers = framed!.headers;
      const body = framed!.body;
      expect(headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe('usage.query');
      const signature = headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
      expect(typeof signature === 'string' && verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
        effectActionId: 'usage.query', target, installationId: 'installation', requestId: 'request', method: 'POST',
        path, body, publicKey: signer.publicKey, signature })).toBe(true);
      const queries = count === 1 ? [UsageAnalyticsQueryRequestSchema.parse(body)]
        : UsageAnalyticsQueryBatchRequestSchema.parse(body).queries;
      expect(queries).toHaveLength(count);
      expect(queries.every(query => query.filters?.machineIds?.[0] === 'selected')).toBe(true);
      return reply.code(403).send({ error: 'credential_scope_denied' });
    });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const deps = createAccountServerActionDeps({ token: 'daemon-token-must-not-cross', serverId: 'home',
      serverIdentityId: 'home', serverHttpBaseUrl: 'http://usage.test', externalActionMachineRequestPrivateKey: signer.secretKey,
      externalActionMachineInstallationId: 'installation' });
    const query = normalizeUsageQuery({ machines: ['selected'], includeComparison: false });
    const result = UsageQueryBatchResultSchema.parse(await deps.usageActions!.query({ queries: Array.from({ length: count }, (_, index) => normalizeUsageQuery({ ...query, period: { startMs: index, endMs: index + 100 } })) }, { surface: 'api',
      externalActionTarget: target, externalActionExecutionAuthorization: authorization }));
    expect(result.results).toHaveLength(count);
    for (const slice of result.results) {
      expect(slice).toMatchObject({
        requestedQuery: { machines: ['selected'] },
        sources: expect.arrayContaining([{ source: 'accounting', status: 'error', errorCode: 'credential_scope_denied' }]),
      });
      expect(slice.accounting).toBeUndefined();
    }
    await app.close();
  });
});
