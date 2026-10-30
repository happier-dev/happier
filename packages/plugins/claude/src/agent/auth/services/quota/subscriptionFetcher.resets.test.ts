import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { createClaudeSubscriptionQuotaFetcher } from './subscriptionFetcher.js';
import { claudeSubscriptionConnectedAccountRuntime } from '../../../../connectedAccounts/claudeSubscriptionRuntime.js';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { PLUGIN_MANIFEST } from '../../../../manifest.js';
import { PluginError } from '@happier-dev/plugin-sdk';

const now = Date.parse('2026-10-11T12:00:00Z');
const signal = new AbortController().signal;
const record = buildConnectedServiceCredentialRecord({ now, serviceId: 'claude-subscription', profileId: 'work', kind: 'oauth', expiresAt: now + 60000,
 oauth: { accessToken: 'test-token', refreshToken: 'refresh', idToken: null, scope: 'user:inference user:profile user:sessions:claude_code', tokenType: null, providerAccountId: 'account-not-organization', providerEmail: null, raw: null } });
function usage(overrides: Record<string, unknown> = {}) {
 return { five_hour: { utilization: 100 }, cedar_ember: { eligible: true, next_grant_id: 'promo', cooldown_until: null, grants: [{ id: 'promo', resets_left: 2, resets_total: 3, starts_at: '2026-01-01T00:00:00Z', ends_at: '2027-01-01T00:00:00Z', usable_now: true, paused: false, clears: ['five_hour', 'seven_day'] }] }, juniper_tide: { eligible: false }, ...overrides };
}
function network(payload = usage(), post: unknown = { result: 'reset' }, profile: unknown = { account: { uuid: 'account-not-organization' }, organization: { uuid: 'organization-123' } }) {
 const requests: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
 const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const request = { url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
  requests.push(request);
  if (request.method === 'POST') { if (post instanceof Error) throw post; if (post instanceof Response) return post.clone(); return new Response(JSON.stringify(post), { status: 200 }); }
  if (request.url.endsWith('/profile')) return new Response(JSON.stringify(profile), { status: 200 });
  return new Response(JSON.stringify(request.url.includes('cedar_ember=1') ? payload : { five_hour: { utilization: 70 }, extra_usage: { is_enabled: true, used_credits: 20, monthly_limit: 100 } }), { status: 200 });
 });
 vi.stubGlobal('fetch', fetch);
 return { requests, fetch };
}
beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(now));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Claude reset HTTP vertical', () => {
 it('discovers saved grants alongside ordinary meters in the legacy adapter', async () => {
  const { requests } = network();
  const fetcher = createClaudeSubscriptionQuotaFetcher({ userAgent: 'claude-cli/2.1.296 (external, cli)' });
  const snapshot = await fetcher.loadQuota({ record, now, signal });
  expect(snapshot?.meters.find(m => m.meterId === 'extra_usage')?.used).toBe(20);
  expect(snapshot?.recoveryCredits).toMatchObject({ availableCount: 2, totalCount: 3, credits: [{ id: 'promo', status: 'available' }] });
  expect(snapshot?.recoveryCreditDetails?.promo).toEqual({ remainingCount: 2, appliesToProviderLimitIds: ['five_hour', 'seven_day'] });
  expect(requests[1]).toMatchObject({ method: 'GET', url: 'https://api.anthropic.com/api/oauth/usage?cedar_ember=1&at_wall=1&skip_spend=1' });
 });
 it('redeems the freshly selected provider grant using the organization and stable UUID', async () => {
  const { requests } = network();
  const fetcher = createClaudeSubscriptionQuotaFetcher({ userAgent: 'claude-cli/2.1.296 (external, cli)' });
  expect(fetcher.consumeRecoveryCredit).toBeTypeOf('function');
  await expect(fetcher.consumeRecoveryCredit({ record, now, signal, idempotencyKey: 'account-scoped-operation', providerCreditId: 'promo' })).resolves.toBe('consumed');
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(1);
  expect(requests.at(-1)).toMatchObject({ url: 'https://api.anthropic.com/api/organizations/organization-123/reset_rate_limits', body: { program: 'cedar_ember', grant_id: 'promo', request_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) } });
 });
});

function context(identity?: Readonly<{ accountId: string; organizationId: string }>) {
 const values = new Map([['accessToken', 'test-token'], ['scopes', JSON.stringify(['user:inference', 'user:sessions:claude_code'])],
  ...(identity ? [['providerAccountId', identity.accountId], ['organizationUuid', identity.organizationId]] : [])]);
 const account = { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'work' };
 // Public host service/credential boundaries are supplied; all provider logic remains real.
 return { account, configuration: { target: { kind: 'account', account, modeId: 'oauth' }, revision: 'r1', values: {}, async getSecret() { return null; } }, signal,
 credentials: { async get(key: string) { return values.get(key) ?? null; }, async set() {}, async delete() {} },
 services: { exec: { agentCli: { async checkReadiness() { return { launchable: [{ agentId: 'claude', version: '2.1.296' }] }; } } }, http: { async request(request: { url: string; method?: string; headers?: Record<string,string>; body?: Uint8Array }, options?: { signal?: AbortSignal }) {
  const response = await globalThis.fetch(request.url, { method: request.method, headers: request.headers, body: request.body ? new TextDecoder().decode(request.body) : undefined, signal: options?.signal });
  return { status: response.status, finalUrl: request.url, headers: Object.fromEntries(response.headers.entries()), body: new Uint8Array(await response.arrayBuffer()) };
 } } } } as Parameters<NonNullable<ConnectedAccountRuntime['quota']>>[0];
}
function adapter(kind: 'legacy' | 'qualified') {
 const provider = createClaudeSubscriptionQuotaFetcher({ userAgent: 'claude-cli/2.1.296 (external, cli)' });
 return {
  async consume(providerCreditId = 'promo', providerLimitIds?: readonly string[]) {
   const request = { idempotencyKey: 'account-scoped-operation', providerCreditId, providerLimitIds };
   return kind === 'legacy' ? provider.consumeRecoveryCredit({ ...request, record, now, signal })
     : (await claudeSubscriptionConnectedAccountRuntime.recoveryCredits!.consume(request, context())).status;
  },
  async read() { return kind === 'legacy' ? (await provider.loadQuota({ record, now, signal }))?.recoveryCredits
    : claudeSubscriptionConnectedAccountRuntime.recoveryCredits!.read(context()); },
 };
}
describe.each(['legacy', 'qualified'] as const)('%s real HTTP reset adapter', kind => {
 it.each([{ target: 'provider-seven-day', expected: 'consumed', posts: 1 }, { target: 'seven_day', expected: 'not_available', posts: 0 }])('uses provider identity for $target', async ({target, expected, posts}) => {
  const payload = usage({ five_hour: null, seven_day: { utilization: 100, provider_limit_id: 'provider-seven-day' } });
  payload.cedar_ember.grants[0].clears = [target];
  const { requests } = network(payload);
  expect(await adapter(kind).consume('promo', [target])).toBe(expected);
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(posts);
 });
 it.each([{ targets: [] }, { targets: ['five_hour'] }])('does not automatically spend without fresh matching exhaustion $targets', async ({ targets }) => {
  const { requests } = network(usage({ five_hour: { utilization: 70 } }));
  expect(await adapter(kind).consume('promo', targets)).toBe('not_available');
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
 });
 it('keeps saved but unusable units outside available balance', async () => {
  const payload = usage(); payload.cedar_ember.grants[0].usable_now = false;
  network(payload);
  const observed = await adapter(kind).read();
  expect(observed).toMatchObject({ availableCount: 0, credits: [{ status: 'unknown' }] });
  if (kind === 'qualified') expect(observed).toMatchObject({ recoveryCreditDetails: { promo: { remainingCount: 2, unavailableReason: 'provider_unavailable' } } });
 });
 it('does not debit another organization for the same selected user', async () => {
  const { requests } = network(usage(), { result: 'reset' }, {
   account: { uuid: 'account-not-organization' }, organization: { uuid: 'another-organization' },
  });
  if (record.kind !== 'oauth') throw new Error('Expected OAuth record');
  const selected = { ...record, oauth: { ...record.oauth,
   raw: { claudeAiOauth: { organizationUuid: 'selected-organization' } },
  } };
  const request = { idempotencyKey: 'organization-bound-reset', providerCreditId: 'promo' };
  const operation = kind === 'legacy'
   ? createClaudeSubscriptionQuotaFetcher().consumeRecoveryCredit({ ...request, record: selected, now, signal })
   : claudeSubscriptionConnectedAccountRuntime.recoveryCredits!.consume(request,
     context({ accountId: 'account-not-organization', organizationId: 'selected-organization' }));
  await expect(operation).rejects.toMatchObject({ recoveryCreditConsumeOutcomeUnknown: false });
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);
 });
 it('requires profile organization identity before any POST', async () => {
  const { requests } = network(usage(), { result: 'reset' }, { account: { uuid: 'account-not-organization' } });
  await expect(adapter(kind).consume()).rejects.toMatchObject({ recoveryCreditConsumeOutcomeUnknown: false });
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
 });
 it('never substitutes a different selected grant', async () => {
  const { requests } = network();
  expect(await adapter(kind).consume('unknown-grant')).toBe('not_available');
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(0);
 });
 it('uses only the authoritative Juniper available reset arm', async () => {
  const { requests } = network(usage({ cedar_ember: null, juniper_tide: { eligible: true, arm: 'reset', available: true, resets_per_week: 99 } }));
  expect(await adapter(kind).read()).toMatchObject({ availableCount: 1 });
  expect(await adapter(kind).consume('juniper_tide')).toBe('consumed');
  expect(requests.at(-1)?.body).toEqual({ program: 'juniper_tide' });
 });
 it.each([['already_used','already_consumed'],['not_limited','nothing_to_reset'],['ineligible','not_available'],['unavailable','not_available'],['cooldown','not_available']] as const)('maps %s', async (result, expected) => {
  network(usage(), { result }); expect(await adapter(kind).consume()).toBe(expected);
 });
 it.each([{ label: 'transport', post: new Error('lost') }, { label: 'malformed', post: {} }, { label: 'server', post: new Response('{}', { status: 503 }) }])('holds uncertain $label outcomes without retry', async ({ post }) => {
  const { requests } = network(usage(), post);
  await expect(adapter(kind).consume()).rejects.toMatchObject({ recoveryCreditConsumeOutcomeUnknown: true });
  expect(requests.filter(r => r.method === 'POST')).toHaveLength(1);
 });
});
it('declares the admitted recovery facet and exact reset POST origin', () => {
 const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(d => d.id === 'claude-subscription');
 expect(descriptor?.recoveryCredits).toEqual({ supported: true });
 expect(PLUGIN_MANIFEST.hostAccess.required).toContainEqual(expect.objectContaining({ capability: 'network',
  scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://api.anthropic.com' }], methods: ['POST'] } }));
});

it('keeps ordinary meters and a visible diagnostic when ancillary legacy discovery fails', async () => {
 const { fetch } = network();
 vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).includes('cedar_ember=1')) throw new Error('read unavailable');
  return fetch(url, init);
 });
 const snapshot = await createClaudeSubscriptionQuotaFetcher().loadQuota({ record, now, signal });
 expect(snapshot?.meters.find(m => m.meterId === 'extra_usage')?.used).toBe(20);
 expect(snapshot?.recoveryCredits).toBeUndefined();
 expect(snapshot?.diagnostics).toContainEqual(expect.objectContaining({ code: 'claude_reset_discovery_failed' }));
});
it('never discovers or consumes resets for setup-token accounts', async () => {
 const { requests } = network();
 const configured = context();
 const setup = { ...configured, configuration: { ...configured.configuration,
  target: { ...configured.configuration.target, modeId: 'setup-token' } } };
 expect(await claudeSubscriptionConnectedAccountRuntime.recoveryCredits!.read(setup)).toMatchObject({ availableCount: 0, credits: [] });
 expect(await claudeSubscriptionConnectedAccountRuntime.recoveryCredits!.consume({ idempotencyKey: 'setup' }, setup)).toEqual({ status: 'not_available' });
 expect(requests).toHaveLength(0);
});

it('uses the managed launch version in qualified discovery identity', async () => {
 const { requests } = network();
 await claudeSubscriptionConnectedAccountRuntime.recoveryCredits!.read(context());
 expect(requests[0].headers.get('User-Agent')).toBe('claude-cli/2.1.296 (external, cli)');
});

it.each(['plugin_exec_agent_cli_version_unavailable', 'plugin_exec_agent_cli_version_failed', 'plugin_exec_system_tool_denied', 'plugin_exec_system_tool_unavailable', 'plugin_exec_argument_denied',
 'plugin_host_access_resource_not_selected', 'plugin_service_unavailable', 'plugin_host_access_declaration_missing'])('retains ordinary usage and reports unavailable native identity %s', async code => {
 const { requests } = network(); const warn = vi.fn(); const configured = context();
 const unavailable = { ...configured, services: { ...configured.services, logger: { warn },
  exec: { agentCli: { async checkReadiness() { throw new PluginError({ code, message: 'private host detail', details: { serviceId: 'exec' } }); } } } } } as typeof configured;
 const quota = await claudeSubscriptionConnectedAccountRuntime.quota!(unavailable);
 expect(quota.limits).toContainEqual(expect.objectContaining({ id: 'extra_usage', used: 20 }));
 expect(requests[0].headers.get('User-Agent')).toBe('claude-cli/0.0.0 (external, cli)');
 expect(warn).toHaveBeenCalledWith(expect.any(String), { code });
 expect(JSON.stringify(warn.mock.calls)).not.toContain('private host detail');
});
it('propagates native identity cancellation without a provider request', async () => {
 const { requests } = network(); const configured = context(); const controller = new AbortController(); const warn = vi.fn();
 const canceled = { ...configured, signal: controller.signal, services: { ...configured.services, logger: { warn },
  exec: { agentCli: { async checkReadiness() { controller.abort(new Error('canceled')); throw new PluginError({ code: 'plugin_exec_agent_cli_version_failed' }); } } } } } as typeof configured;
 await expect(claudeSubscriptionConnectedAccountRuntime.quota!(canceled)).rejects.toThrow();
 expect(requests).toHaveLength(0); expect(warn).not.toHaveBeenCalled();
});
it('propagates stale invocation failures without a provider request', async () => {
 const { requests } = network(); const configured = context(); const warn = vi.fn();
 const retired = { ...configured, services: { ...configured.services, logger: { warn },
  exec: { agentCli: { async checkReadiness() { throw new PluginError({ code: 'plugin_invocation_not_current' }); } } } } } as typeof configured;
 await expect(claudeSubscriptionConnectedAccountRuntime.quota!(retired)).rejects.toMatchObject({ code: 'plugin_invocation_not_current' });
 expect(requests).toHaveLength(0); expect(warn).not.toHaveBeenCalled();
});

it('does not publish an authoritative empty balance for unevaluated reset programs', async () => {
 network(usage({ cedar_ember: null, juniper_tide: null }));
 await expect(claudeSubscriptionConnectedAccountRuntime.recoveryCredits!.read(context())).rejects.toMatchObject({
  code: 'plugin_connected_account_claude_reset_inventory_unavailable',
 });
});
