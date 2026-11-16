import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { PublicProfileOwnerReadV1Schema, PublicProfilePublishBodyV1Schema, DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, PublicProfilePolicyV1Schema } from '@happier-dev/protocol/account/publicProfile';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountServerActionDeps } from './accountServerActionDeps';

let app: FastifyInstance;
let restore: () => void;
beforeEach(() => {
  app = fastify();
  restore = installAxiosFastifyAdapter({ app, origin: 'http://profile-home.test' });
});
afterEach(async () => { restore(); await app.close(); });

describe('public-profile CLI captured Account binding', () => {
  it('computes and dispatches a public snapshot through the real CLI query and prepared HTTP owners', async () => {
    const startMs = Date.parse('2026-10-20T00:00:00Z');
    const endMs = startMs + 86_400_000;
    const policy = PublicProfilePolicyV1Schema.parse({ indexable: false, fields: Object.fromEntries(
      Object.keys(DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields).map(field => [field, field === 'tokens'])) });
    const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'absent', context: { handle: 'ada', identity: {},
      service: { displayName: 'Home', publicBaseUrl: 'http://profile-home.test' }, urls: {
        page: 'http://profile-home.test/@ada', json: 'http://profile-home.test/@ada/json',
        badgeBase: 'http://profile-home.test/@ada/badge', card: 'http://profile-home.test/@ada/card.svg',
        og: 'http://profile-home.test/@ada/og.png', report: 'mailto:operator@profile-home.test',
      } } });
    const tokens = { input: 8, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
    const cost = { reportedUsd: 98765, estimatedUsd: 87654, currency: 'USD' };
    const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1, tokens, cost },
      contributions: [{ id: 'private-request', observedAtMs: startMs + 1, sessionId: 'private-session', turnId: 'private-turn',
        agentId: 'codex', modelId: null, machineId: null, projectKey: 'private-project', workspaceId: null,
        source: 'runtime', eventCount: 1, sourceContext: { path: 'runtime', execution: 'happier' }, tokens, cost }],
      coverage: { status: 'partial', reasons: ['incomplete_history'], sources: [{ source: 'runtime', path: 'runtime', status: 'available',
        eventCount: 1, asOfMs: endMs, historyComplete: false }], missingDimensions: [], ranked: [], range: { startMs, endMs, complete: false } },
    });
    app.get('/v1/account/public-profile', async () => owner);
    app.post('/v2/usage/query', async request => {
      expect(request.body).toMatchObject({ population: 'public_eligible_personal' });
      return accounting;
    });
    const published: unknown[] = [];
    app.post('/v1/account/public-profile/publish', async request => {
      const body = PublicProfilePublishBodyV1Schema.parse(request.body);
      published.push(body);
      return { kind: 'updated', record: null };
    });
    let actionsSettings = ActionsSettingsV1Schema.parse({ v: 1 });
    const executor = createActionExecutor({ ...createAccountServerActionDeps({ token: 'captured', serverId: 'home',
      serverHttpBaseUrl: 'http://profile-home.test', isCredentialCurrent: async () => true }),
      readActionsSettings: () => actionsSettings,
    } as ActionExecutorDeps);
    const candidate = { policy, metadataSelection: {}, query: normalizeUsageQuery({ period: { startMs, endMs },
      includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false, includeQuotaHistory: false }),
      layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1 };
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home' };
    await expect(executor.execute('account.public_profile.preview', candidate, context)).resolves.toMatchObject({ ok: true,
      result: { kind: 'ready', view: { snapshot: { facts: { tokens: 10 } } } } });
    expect(published).toEqual([]);
    // A human CLI caller still needs the ordinary Action approval. This thin
    // transport has no approval host, so the default must fail before a write.
    await expect(executor.execute('account.public_profile.publish', { ...candidate, intent: 'publish' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(published).toEqual([]);
    actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'account.public_profile.publish': ['cli'] } });
    await expect(executor.execute('account.public_profile.publish', { ...candidate, intent: 'publish' }, context))
      .resolves.toMatchObject({ ok: true, result: { kind: 'updated' } });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ query: { population: 'public_eligible_personal' }, snapshot: { facts: { tokens: 10 } } });
    expect(JSON.stringify(published)).not.toMatch(/private-request|private-session|private-turn|private-project|98765|87654/);
  });

  it.each(['restrict', 'restore'] as const)('requires consent for operator %s and never turns a waiver into Home privilege', async operation => {
    const actionId = ActionIdSchema.parse(`home.public_profiles.${operation}`);
    const received: unknown[] = [];
    let permitted = false;
    app.post(`/v1/home/public-profiles/:accountId/${operation}`, async (request, reply) => {
      expect(request.headers.authorization).toBe('Bearer captured');
      received.push({ params: request.params, body: request.body });
      return permitted ? { kind: 'updated', record: null }
        : reply.code(403).send({ error: 'home_governance_forbidden' });
    });
    const deps = createAccountServerActionDeps({ token: 'captured', serverId: 'home', serverHttpBaseUrl: 'http://profile-home.test',
      isCredentialCurrent: async () => true });
    const executor = createActionExecutor({ ...deps, readActionsSettings: (context) => context.actionsSettings ?? ActionsSettingsV1Schema.parse({ v: 1 }),
    } as ActionExecutorDeps);
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home' };
    const input = { accountId: 'account/target', reason: '  Reviewed operator reason  ' };
    await expect(executor.execute(actionId, input, context)).resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(received).toEqual([]);
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { [actionId]: ['cli'] } });
    await expect(executor.execute(actionId, { ...input, isAdmin: true }, { ...context, actionsSettings }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    await expect(executor.execute(actionId, { ...input, reason: ' ' }, { ...context, actionsSettings }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(received).toEqual([]);
    await expect(executor.execute(actionId, input, { ...context, actionsSettings }))
      .resolves.toMatchObject({ ok: false, errorCode: 'home_governance_forbidden' });
    expect(received).toEqual([{ params: { accountId: 'account/target' }, body: { reason: 'Reviewed operator reason' } }]);
    // Only the answering Home can change this authorization outcome.
    permitted = true;
    await expect(executor.execute(actionId, input, { ...context, actionsSettings }))
      .resolves.toEqual({ ok: true, result: { kind: 'updated', record: null } });
  });

  it('runs layout-only Apply through shared preparation and the exact declared HTTP effect', async () => {
    const layout = { v: 1, items: [] } as const;
    const owner = PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context: { handle: 'ada', identity: {},
      service: null, urls: null }, record: { state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1,
      metadata: {}, projectSelections: [], query: normalizeUsageQuery({}), snapshot: null, layout,
      appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, updatedAtMs: 1, publishedAtMs: 1, restriction: null,
    } });
    const requests: unknown[] = [];
    app.get('/v1/account/public-profile', async () => owner);
    app.put('/v1/account/public-profile/policy', async request => {
      expect(request.headers.authorization).toBe('Bearer captured');
      requests.push(request.body);
      return { kind: 'updated', record: owner.kind === 'ready' ? owner.record : null };
    });
    const deps = createAccountServerActionDeps({ token: 'captured', serverId: 'home', serverHttpBaseUrl: 'http://profile-home.test',
      isCredentialCurrent: async () => true });
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'account.public_profile.update': ['cli'], 'account.public_profile.refresh': ['cli'] } });
    const executor = createActionExecutor({ ...deps, readActionsSettings: () => actionsSettings,
    } as ActionExecutorDeps);
    await expect(executor.execute('account.public_profile.update', { layout }, {
      surface: 'cli', authority: 'present_user', serverId: 'home',
    })).resolves.toMatchObject({ ok: true, result: { kind: 'updated', refresh: 'not_needed' } });
    expect(requests).toEqual([{ layout }]);
    await expect(executor.execute('account.public_profile.refresh', {}, {
      surface: 'cli', authority: 'present_user', serverId: 'home',
    })).resolves.toMatchObject({ ok: false, errorCode: 'public_profile_preparation_unavailable' });
    expect(requests).toHaveLength(1);
  });
});
