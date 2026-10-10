import { afterEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { createCliSettingsDeclarationAction } from '@/session/actions/settingsDeclarationAction';

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

describe('CLI and MCP model prices through captured Account Actions', () => {
  it('gets and refreshes public prices through captured Account Actions and refuses denied or retired results', async () => {
    const app = fastify();
    const catalog = { v: 1, models: { reference: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } },
      provenance: { source: 'litellm', origin: 'bundled', asOfMs: 100, revision: 'test', fetchStatus: 'ready' } };
    let current = true;
    let denied = false;
    let retireOnRead = false;
    app.get('/v1/account/usage/prices', async (_request, reply) => {
      if (retireOnRead) current = false;
      return denied ? reply.code(403).send({ error: 'denied' }) : catalog;
    });
    app.post('/v1/account/usage/prices/refresh', async request => {
      expect(request.body).toEqual({});
      return { ...catalog, provenance: { ...catalog.provenance, revision: 'refreshed' } };
    });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const executor = createActionExecutor({ ...createAccountServerActionDeps({ token: 'owner-token', serverId: 'home',
      serverHttpBaseUrl: 'http://usage.test', isCredentialCurrent: () => current }), isActionApprovalRequired: () => false } as ActionExecutorDeps);
    const initial = await executor.execute('usage.prices.get', {}, { surface: 'mcp', serverId: 'home' });
    expect(initial, JSON.stringify(initial))
      .toMatchObject({ ok: true, result: { provenance: catalog.provenance } });
    expect(await executor.execute('usage.prices.refresh', {}, { surface: 'cli', serverId: 'home', authority: 'present_user' }))
      .toMatchObject({ ok: true, result: { provenance: { revision: 'refreshed' } } });
    denied = true;
    expect(await executor.execute('usage.prices.get', {}, { surface: 'mcp', serverId: 'home' })).toMatchObject({ ok: false });
    denied = false; retireOnRead = true;
    expect(await executor.execute('usage.prices.get', {}, { surface: 'mcp', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_retired' });
    await app.close();
  });
  it('re-prices historical usage through ordinary model-price settings Actions and keeps vendor facts unchanged', async () => {
    const app = fastify();
    const tokens = { input: 1_000_000, output: 500_000, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_500_000 };
    const cost = { reportedUsd: 7, estimatedUsd: 3, currency: 'USD' };
    const history = { v: 1, totals: { eventCount: 1, tokens, cost }, contributions: [{ id: 'history', observedAtMs: 150,
      sessionId: null, turnId: null, agentId: null, modelId: 'private-model', machineId: null, projectKey: null,
      workspaceId: null, source: null, tokens, cost }] };
    let raw: Record<string, unknown> = {};
    let version = 1;
    let current = true;
    app.post('/v2/usage/query', async request => { expect(JSON.stringify(request.body)).not.toContain('private-model'); return history; });
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v1/profile', async () => ({ id: 'account', connectedAccountsV4: [], connectedAccountGroupsV4: [] }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: raw }, version }));
    app.post('/v2/account/settings', async (request, reply) => {
      const mutation = AccountSettingsV2UpdateRequestSchema.parse(request.body);
      if (mutation.expectedVersion !== version) return reply.code(409).send({ success: false, error: 'version-mismatch',
        currentVersion: version, currentContent: { t: 'plain', v: raw } });
      if (mutation.content?.t !== 'plain') throw new Error('Expected canonical plain Account envelope');
      raw = mutation.content.v;
      return { success: true, version: ++version };
    });
    cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage.test' });
    const credentials = { token: 'owner-token', encryption: null };
    const executor = createActionExecutor({ ...createAccountServerActionDeps({ token: credentials.token, credentials,
      serverId: 'home', serverHttpBaseUrl: 'http://usage.test', isCredentialCurrent: () => current }),
      settingsDeclarationAction: createCliSettingsDeclarationAction({ credentials, serverHttpBaseUrl: 'http://usage.test' }),
      isActionApprovalRequired: () => false,
    } as ActionExecutorDeps);
    const query = { queries: [normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } })] };
    const read = async () => {
      const result = await executor.execute('usage.query', query, { surface: 'mcp', serverId: 'home' });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      return UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results[0]!;
    };
    const overrides = { 'private-model': { kind: 'rates', inputUsdPerMillion: 2, outputUsdPerMillion: 4 } };
    expect(await executor.execute('settings.set', { anchor: 'usage.modelPrices', value: overrides },
      { surface: 'cli', serverId: 'home', authority: 'present_user' })).toMatchObject({ ok: true });
    expect(await executor.execute('settings.get', { anchor: 'usage.modelPrices' }, { surface: 'mcp', serverId: 'home' }))
      .toMatchObject({ ok: true, result: { value: overrides } });
    expect((await read()).costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(4);
    expect((await read()).accounting?.totals.cost).toMatchObject(cost);
    expect(await executor.execute('settings.set', { anchor: 'usage.modelPrices', value: {
      'private-model': { kind: 'map', modelId: 'reference-model' },
      'reference-model': { kind: 'rates', inputUsdPerMillion: 6, outputUsdPerMillion: 4 },
    } }, { surface: 'cli', serverId: 'home', authority: 'present_user' })).toMatchObject({ ok: true });
    expect((await read()).costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(8);
    expect((await read()).accounting?.contributions?.[0]?.cost).toMatchObject(cost);
    const mapped = { 'private-model': { kind: 'map', modelId: 'reference-model' },
      'reference-model': { kind: 'rates', inputUsdPerMillion: 6, outputUsdPerMillion: 4 } };
    expect(await executor.execute('settings.get', { anchor: 'usage.modelPrices' }, { surface: 'mcp', serverId: 'home' }))
      .toMatchObject({ ok: true, result: { value: mapped } });
    expect(await executor.execute('settings.set', { anchor: 'usage.modelPrices', value: {
      'private-model': { kind: 'map', modelId: 'reference-model' }, 'reference-model': { kind: 'map', modelId: 'private-model' },
    } }, { surface: 'cli', serverId: 'home', authority: 'present_user' })).toMatchObject({ ok: false });
    expect(await executor.execute('settings.get', { anchor: 'usage.modelPrices' }, { surface: 'mcp', serverId: 'home' }))
      .toMatchObject({ ok: true, result: { value: mapped } });
    current = false;
    expect(await executor.execute('usage.query', query, { surface: 'mcp', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_retired' });
    await app.close();
  });
});
