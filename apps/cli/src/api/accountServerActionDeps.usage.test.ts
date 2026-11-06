import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1, createActionExecutor, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { UsageFileResultSchema } from '@happier-dev/protocol/usage/usageExport';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, createAvailableSessionSpawnMachineSnapshot } from '@/testkit/backends/apiSessionSocketHarness';
import { ScmPullRequestWorkEvidenceSchema } from '@happier-dev/protocol/scm';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { handleActionsCommand } from '@/cli/commands/actions';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliSettingsDeclarationAction } from '@/session/actions/settingsDeclarationAction';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { McpServerCatalogRowMutationV1Schema, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { UsageCoachApplyResultSchema } from '@happier-dev/protocol/usage/coach/coachActions';
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

const socketBoundary = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: socketBoundary }));

const response = { v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); socketBoundary.mockReset(); resetActiveAccountSettingsSnapshotForTests(); process.exitCode = undefined; });

describe('CLI and MCP personal usage Account transport', () => {
  it('distinguishes a missing Session from a missing Usage operation without re-polling or retaining values', async () => {
    const app = fastify();
    let state: 'available' | 'not_found' | 'Session not found' | 'missing_operation' = 'available';
    let reads = 0;
    app.post('/v2/usage/query', async (_request, reply) => {
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
    socketBoundary.mockImplementation(() => createApiSessionSocketStub({ emitWithAck: (event, payload) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error('Unexpected socket event');
      const packet = z.object({ method: z.string(), params: z.object({ cwd: z.string(), workEvidence: z.object({ sessionId: z.string() }),
        state: z.optional(z.string()) }), authorization: z.optional(z.unknown()) }).parse(payload);
      expect(packet.params).toMatchObject({ cwd: '/repo', workEvidence: { sessionId } });
      expect(packet.authorization).toMatchObject({ kind: 'session.write', sessionId });
      return { ok: true, result: packet.method.endsWith('scm.branch.list')
        ? { success: true, branches: [], branchEvidenceStatus: 'partial', branchEvidence: [{ ...checkpoint,
          branch: { ref: 'refs/heads/feature', headSha: 'b'.repeat(40) } }] }
        : { success: true, pullRequests: [], workEvidenceStatus: 'partial', workEvidence: packet.params.state === 'merged' ? [witness] : [] } };
    } }));
    const accounting = { ...response, contributions: [{ id: 'turn-cost', observedAtMs: 150, sessionId,
      turnId: 'turn', agentId: 'claude', modelId: null, machineId: 'machine', projectKey: null, workspaceId: null,
      source: 'session', tokens: response.totals.tokens, cost: response.totals.cost }] };
    app.post('/v2/usage/query', async (request, reply) => {
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
    app.get('/v2/sessions', async () => ({ sessions: [createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', share: null })], hasNext: false }));
    app.get('/v2/sessions/archived', async () => ({ sessions: [], hasNext: false }));
    app.get(`/v2/sessions/${sessionId}`, async () => {
      sessionReads += 1;
      return { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
        ...(detail === 'summary' ? { agentState: JSON.stringify({ completedRequests: { permission: { tool: 'Read', arguments: {},
          turnId: 'turn', createdAt: 100, completedAt: 110, status: 'approved', answeringClientCategory: 'web' } } }) } : {}),
        metadata: JSON.stringify({ path: '/repo', machineId: 'machine', agent: 'claude' }), share: null }) };
    });
    app.get(`/v1/sessions/${sessionId}/turns`, async () => ({ v: 1, sessionId, updatedAt: 180,
      turns: [{ turnId: 'turn', agentId: 'claude', status: 'completed', startedAt: 120, terminalAt: 180, updatedAt: 180 }] }));
    app.get(`/v1/sessions/${sessionId}/messages`, async request => {
      if (malformed) return { messages: [{ content: 'invalid' }], hasMore: false };
      const roles = String((request.query as { roles?: string }).roles).split(',');
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
    if (detail === 'summary') {
      expect(opened.howYouWork).toMatchObject({ intervals: { agentTimeMs: 60, elapsedWaitMs: 10 }, detailStatus: 'partial',
        permissions: { requestCount: 1, pairedDecisionCount: 1, decisionLatencyMs: 10, byAnsweringClient: { web: 1 } } });
      expect(opened.howYouWork?.autopsy).toBeUndefined();
      expect(opened.howYouWork?.inputs).toBeNull();
      expect(opened.work?.allocations[0]?.reason).toBe('allocated');
      expect(reads).toContain(`/v1/sessions/${sessionId}/turns`);
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
  it('composes retained quota/history/targets and dismisses witnessed native findings through the real settings CAS owner', async () => {
    const app = fastify();
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const source = { bindingKind: 'account' as const, ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'work' } };
    const key = { providerId: 'test', accountSubjectId: 'subject', subjectKind: 'account' as const, quotaScope: 'account' as const };
    const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(key), recordKey: key,
      providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'subject' }, observedAtMs: 150, fetchedAtMs: 150,
      staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] });
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
    let raw: Record<string, unknown> = { usageCoachPreferencesV1: { v: 1, digestCadence: 'off', suppressions: [] }, usagePacingTargetsV1: targets };
    let version = 1;
    let mode: 'plain' | 'e2ee' = 'plain';
    let denied = false;
    let includeUnavailableAccount = false;
    let quotaUnavailable = false;
    let pagedHistory = true;
    let rangeHistoryReads = 0;
    const cursor = { id: 'history', observedAtMs: 150 };
    const historyRequest = { range: { startAtMs: 100, endAtMs: 200 }, pageSize: 100 };
    let releaseContinuation!: () => void;
    const heldContinuation = new Promise<void>(resolve => { releaseContinuation = resolve; });
    let enteredContinuation!: () => void;
    const continuationEntered = new Promise<void>(resolve => { enteredContinuation = resolve; });
    const unavailableSource = { ...source, ref: { ...source.ref, accountId: 'unavailable' } };
    app.addHook('preHandler', async request => { expect(request.headers.authorization).toBe('Bearer owner-token'); });
    app.post('/v2/usage/query', async () => native);
    app.get('/v1/account/profile', async (_request, reply) => denied ? reply.code(403).send({ error: 'denied' }) : ({ id: 'account', connectedAccountsV4: [{
      ref: source.ref, status: 'connected', authenticationModeId: null, revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: true, configurationRevision: '1', scopes: [],
    }, ...(includeUnavailableAccount ? [{ ref: unavailableSource.ref, status: 'connected', authenticationModeId: null,
      revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: true,
      configurationRevision: '1', scopes: [] }] : [])], connectedAccountGroupsV4: [group] }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode, version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/encryption', async () => ({ mode, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: raw }, version }));
    app.post('/v2/account/settings', async (request, reply) => {
      const mutation = AccountSettingsV2UpdateRequestSchema.parse(request.body);
      if (mutation.expectedVersion !== version) return reply.code(409).send({ success: false, error: 'version-mismatch', currentVersion: version,
        currentContent: { t: 'plain', v: raw } });
      expect(mutation.content?.t).toBe('plain');
      if (mutation.content?.t === 'plain') raw = mutation.content.v;
      return { success: true, version: ++version };
    });
    app.get('/v4/connect/qualified/provider-account-usage/sources/resolve', async (request, reply) => {
      const requested = QualifiedConnectedServiceUsageSourceV4Schema.parse(JSON.parse(z.object({ source: z.string() }).parse(request.query).source));
      return quotaUnavailable || requested.ref.accountId === unavailableSource.ref.accountId
        ? reply.code(503).send({ error: 'provider_account_usage_read_failed' })
        : { source, recordId: snapshot.recordId, providerAccountId: 'subject', fetchedAt: 150, staleAfterMs: 1000 };
    });
    const record = { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 150, staleAfterMs: 1000, status: 'ok' }, sources: [source] };
    app.get('/v4/connect/qualified/provider-account-usage/record', async () => record);
    app.get('/v4/connect/qualified/provider-account-usage/history', async request => {
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
      expect(requested).toEqual({ recordId: snapshot.recordId, history: historyRequest });
      return { entries: [{ id: 'history', observedAtMs: 150, record }], nextCursor: pagedHistory ? cursor : null };
    });
    app.post('/v2/pending/reset-starts/read', async () => ({ entries: [] }));
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const credentials = { token: 'owner-token', encryption: null };
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({ token: credentials.token, credentials,
      serverId: 'home', serverHttpBaseUrl: 'http://usage.test' }),
      settingsDeclarationAction: createCliSettingsDeclarationAction({ credentials, serverHttpBaseUrl: 'http://usage.test' }),
      connectedServiceAction: createCliConnectedServiceAction({ credentials, serverId: 'home', serverHttpBaseUrl: 'http://usage.test',
        resolveHeaders: () => ({ Authorization: 'Bearer owner-token' }),
        callMachineAction: async () => { throw new Error('Quota reads have no Machine effect'); },
      }),
      isActionApprovalRequired: () => false,
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
    const slice = await read();
    expect(slice.pending).toBe(false);
    expect(slice.quota).toMatchObject([{ current: snapshot, history: { entries: [{ id: 'history' }], nextCursor: null }, targets }]);
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
    expect(slice.pools).toMatchObject([{ group: group.ref, memberAccountIds: ['work'], activeAccountId: 'work',
      selection: { status: 'unsupported', errorCode: 'machine_context_unavailable' } }]);
    expect(slice.sources).toEqual(expect.arrayContaining([{ source: 'accounting', status: 'available', asOfMs: 180 },
      expect.objectContaining({ source: 'work', status: 'unknown' })]));
    const finding = slice.coach!.findings.find(row => row.detectorId === 'outside_usage')!;
    expect(finding.currentness).toBe('current');
    const dismissed = await executor.execute('usage.coach.dismiss', { query, evidenceKey: finding.evidenceKey, dismissed: true },
      { surface: 'cli', serverId: 'home', authority: 'present_user' });
    expect(dismissed, JSON.stringify(dismissed)).toMatchObject({ ok: true, result: { kind: 'preference_updated' } });
    expect((await read()).coach!.findings.find(row => row.evidenceKey === finding.evidenceKey)?.state.dismissed).toBe(true);
    const preferenceRead = await executor.execute('settings.get', { anchor: 'usage.coachPreferences', includeVersion: true },
      { surface: 'cli', serverId: 'home' });
    expect(preferenceRead).toMatchObject({ ok: true, result: { value: { disabledChecks: [], modelSuggestion: 'suggest_with_estimates' } } });
    const configured = await executor.execute('settings.set', { anchor: 'usage.coachPreferences',
      value: { v: 1, suppressions: [{ kind: 'dismissed', evidenceKey: finding.evidenceKey }], disabledChecks: ['outside_usage'], modelSuggestion: 'off' },
      expectedSettingsVersion: version }, { surface: 'cli', serverId: 'home', authority: 'present_user' });
    expect(configured).toMatchObject({ ok: true });
    expect((await read()).coach!.evaluations.find(row => row.detectorId === 'outside_usage')?.status).toBe('disabled');
    expect((await read()).coach!.findings).toEqual([]);
    expect(await executor.execute('settings.set', { anchor: 'usage.coachPreferences', value: { v: 1, suppressions: [], disabledChecks: [], modelSuggestion: 'off' },
      expectedSettingsVersion: 1 }, { surface: 'cli', serverId: 'home', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'account_settings_conflict' });
    expect((await read()).coach!.findings).toEqual([]);
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
    let state: 'current' | 'denied' | 'retired' | 'cancelled' = 'current';
    const controller = new AbortController();
    let current = true;
    const source = { bindingKind: 'account' as const, ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'work' } };
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
      .parse(await handlers.get('usage_calendar_export')?.(input));
    expect(output.isError, output.content.map(part => part.text).join('\n')).toBe(false);
    const file = UsageFileResultSchema.parse(JSON.parse(output.content[0]!.text));
    const text = new TextDecoder().decode(decodeBase64(file.base64));
    expect(text).toContain('DTSTART:20261010T043000Z\r\n');
    expect(text).toContain('DTSTART:20261011T043000Z\r\n');
    expect(paths.filter(path => path.endsWith('/sources/resolve'))).toHaveLength(1);
    const beforeUnadmitted = paths.length;
    expect(await executor.execute('usage.calendar.export', input, { surface: 'mcp', serverId: 'home',
      externalActionCredential: { accountId: 'account', principalId: 'principal', credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 } }))
      .toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    expect(paths).toHaveLength(beforeUnadmitted);
    for (const next of ['denied', 'retired', 'cancelled'] as const) {
      state = next;
      const result = await executor.execute('usage.calendar.export', input, { surface: 'mcp', serverId: 'home',
        ...(next === 'cancelled' ? { signal: controller.signal } : {}) });
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('result');
      if (next === 'retired') expect(result).toMatchObject({ errorCode: 'credential_scope_retired' });
      if (next === 'cancelled') expect(result).toMatchObject({ errorCode: 'cancelled' });
      current = true;
    }
    expect(paths).not.toContain('/v2/usage/query');
    expect(paths.every(path => !path.includes('refresh'))).toBe(true);
    await app.close();
  });
  it('queries independent slices through the canonical batch Action without dropping filters', async () => {
    const app = fastify();
    const admitted: unknown[] = [];
    app.post('/v2/usage/query', async request => {
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
    const invokeQuery = handlers.get('usage_query');
    expect(invokeQuery).toBeDefined();
    const mcpOutput = z.object({ isError: z.literal(false), content: z.array(z.object({ type: z.literal('text'), text: z.string() })) })
      .parse(await invokeQuery?.({ queries }));
    const mcpResult = UsageQueryBatchResultSchema.parse(JSON.parse(mcpOutput.content[0]!.text));
    for (const result of [cliResult, mcpResult]) {
      expect(result).toMatchObject({ results: expect.arrayContaining([
        expect.objectContaining({ accounting: response, requestedQuery: expect.objectContaining({ agents: ['a', 'b'] }) }),
        expect.objectContaining({ accounting: response, requestedQuery: expect.objectContaining({ period: { startMs: 100, endMs: 200 } }) }),
      ]) });
      expect(result.results.every(slice =>
        slice.sources.find(source => source.source === 'accounting')?.asOfMs === undefined)).toBe(true);
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
    app.post('/v2/usage/query', async () => { current = false; return response; });
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
    app.post('/v2/usage/query', async () => { disclosed = true; return response; });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const deps = createAccountServerActionDeps({ token: 'daemon-token-must-not-cross', serverId: 'home',
      serverHttpBaseUrl: 'http://usage.test' });
    expect(await deps.usageActions!.query({ queries: [normalizeUsageQuery({})] }, { surface: 'api',
      externalActionCredential: { accountId: 'account', principalId: 'principal', credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 } }))
      .toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    expect(disclosed).toBe(false);
    await app.close();
  });
  it('signs the exact query effect and body while preserving a Home admission refusal', async () => {
    const app = fastify();
    const signer = tweetnacl.sign.keyPair();
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-minted-invocation', binding: {
      serverIdentityId: 'home', accountId: 'account', principalId: 'principal', credentialId: 'credential',
      custodianAccountId: 'account', installationId: 'installation',
      grant: API_TOKEN_FULL_GRANT_V1, machineId: 'machine', actionId: 'usage.query', requestId: 'request',
      requestEnvelopeDigest: 'A'.repeat(43), target,
    } });
    app.post('/v2/usage/query', async (request, reply) => {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe('usage.query');
      const signature = request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
      expect(typeof signature === 'string' && verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
        effectActionId: 'usage.query', target, installationId: 'installation', requestId: 'request', method: 'POST',
        path: '/v2/usage/query', body: request.body, publicKey: signer.publicKey, signature })).toBe(true);
      expect(UsageAnalyticsQueryRequestSchema.parse(request.body).filters?.machineIds).toEqual(['selected']);
      return reply.code(403).send({ error: 'credential_scope_denied' });
    });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const deps = createAccountServerActionDeps({ token: 'daemon-token-must-not-cross', serverId: 'home',
      serverIdentityId: 'home', serverHttpBaseUrl: 'http://usage.test', externalActionMachineRequestPrivateKey: signer.secretKey,
      externalActionMachineInstallationId: 'installation' });
    const query = normalizeUsageQuery({ machines: ['selected'] });
    const result = UsageQueryBatchResultSchema.parse(await deps.usageActions!.query({ queries: [query] }, { surface: 'api',
      externalActionTarget: target, externalActionExecutionAuthorization: authorization }));
    expect(result.results).toMatchObject([{
      key: getUsageQueryKey(query), requestedQuery: { machines: ['selected'] },
      sources: expect.arrayContaining([{ source: 'accounting', status: 'error', errorCode: 'credential_scope_denied' }]),
    }]);
    expect(result.results[0]?.accounting).toBeUndefined();
    await app.close();
  });
});
