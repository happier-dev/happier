import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { API_TOKEN_FULL_GRANT_V1, createActionExecutor, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, verifyExternalActionMachineRequestV1, type ActionExecutorDeps } from '@happier-dev/protocol';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { UsageFileResultSchema } from '@happier-dev/protocol/usage/usageExport';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { handleActionsCommand } from '@/cli/commands/actions';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliSettingsDeclarationAction } from '@/session/actions/settingsDeclarationAction';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';

const response = { v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); process.exitCode = undefined; });

describe('CLI and MCP personal usage Account transport', () => {
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
        machineId: 'machine', projectKey: null, workspaceId: null, source: 'native', tokens: response.totals.tokens, cost: response.totals.cost },
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
    app.addHook('preHandler', async request => { expect(request.headers.authorization).toBe('Bearer owner-token'); });
    app.post('/v2/usage/query', async () => native);
    app.get('/v1/profile', async (_request, reply) => denied ? reply.code(403).send({ error: 'denied' }) : ({ id: 'account', connectedAccountsV4: [{
      ref: source.ref, status: 'connected', authenticationModeId: null, revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: true, configurationRevision: '1', scopes: [],
    }], connectedAccountGroupsV4: [group] }));
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
    app.get('/v4/connect/qualified/provider-account-usage/sources/resolve', async () => ({ source, recordId: snapshot.recordId,
      providerAccountId: 'subject', fetchedAt: 150, staleAfterMs: 1000 }));
    const record = { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: 150, staleAfterMs: 1000, status: 'ok' }, sources: [source] };
    app.get('/v4/connect/qualified/provider-account-usage/record', async () => record);
    app.get('/v4/connect/qualified/provider-account-usage/history', async () => ({ entries: [{ id: 'history', observedAtMs: 150, record }], nextCursor: null }));
    app.post('/v2/pending/reset-starts/read', async () => ({ entries: [] }));
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const credentials = { token: 'owner-token', encryption: null };
    const executor = createActionExecutor({ ...createAccountServerActionDeps({ token: credentials.token, credentials,
      serverId: 'home', serverHttpBaseUrl: 'http://usage.test' }),
      settingsDeclarationAction: createCliSettingsDeclarationAction({ credentials, serverHttpBaseUrl: 'http://usage.test' }),
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);
    const read = async () => {
      const result = await executor.execute('usage.query', { queries: [query] }, { surface: 'cli', serverId: 'home' });
      expect(result.ok).toBe(true);
      return UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results[0]!;
    };
    const slice = await read();
    expect(slice.pending).toBe(false);
    expect(slice.quota).toMatchObject([{ current: snapshot, history: { entries: [{ id: 'history' }], nextCursor: null }, targets }]);
    expect(slice.pools).toMatchObject([{ group: group.ref, memberAccountIds: ['work'], activeAccountId: 'work',
      selection: { status: 'unsupported', errorCode: 'machine_context_unavailable' } }]);
    expect(slice.sources).toEqual(expect.arrayContaining([{ source: 'accounting', status: 'available', asOfMs: 180 },
      expect.objectContaining({ source: 'work', status: 'unsupported' })]));
    const finding = slice.coach!.findings.find(row => row.detectorId === 'outside_usage')!;
    expect(finding.currentness).toBe('current');
    const dismissed = await executor.execute('usage.coach.dismiss', { query, evidenceKey: finding.evidenceKey, dismissed: true },
      { surface: 'cli', serverId: 'home', authority: 'present_user' });
    expect(dismissed, JSON.stringify(dismissed)).toMatchObject({ ok: true, result: { kind: 'preference_updated' } });
    expect((await read()).coach!.findings.find(row => row.evidenceKey === finding.evidenceKey)?.state.dismissed).toBe(true);
    expect(await executor.execute('settings.set', { anchor: 'usage.coachPreferences', value: { v: 1, digestCadence: 'off', suppressions: [] },
      expectedSettingsVersion: 1 }, { surface: 'cli', serverId: 'home', authority: 'present_user' }))
      .toMatchObject({ ok: false, errorCode: 'account_settings_conflict' });
    expect((await read()).coach!.findings.find(row => row.evidenceKey === finding.evidenceKey)?.state.dismissed).toBe(true);
    mode = 'e2ee';
    const locked = await read();
    expect(locked.quota).toBeUndefined();
    expect(locked.sources.find(row => row.source === 'quota')).toMatchObject({ status: 'unknown' });
    expect(locked.pending).toBe(false);
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
    const executor = createActionExecutor(createAccountServerActionDeps({ token: 'owner-token', credentials: { token: 'owner-token', encryption: null },
      serverId: 'home', serverHttpBaseUrl: 'http://usage.test', isCredentialCurrent: () => current }) as ActionExecutorDeps);
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
    const executor = createActionExecutor(deps as ActionExecutorDeps);
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
    const executor = createActionExecutor(deps as ActionExecutorDeps);
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
    const executor = createActionExecutor(createAccountServerActionDeps({ token: 'owner-token', serverId: 'home',
      serverHttpBaseUrl: 'http://usage.test', isCredentialCurrent: () => current }) as ActionExecutorDeps);
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
    expect(await deps.usageActions!.query({ queries: [normalizeUsageQuery({ machines: ['selected'] })] }, { surface: 'api',
      externalActionTarget: target, externalActionExecutionAuthorization: authorization }))
      .toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    await app.close();
  });
});
