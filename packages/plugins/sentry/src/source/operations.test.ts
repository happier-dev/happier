import { activate as activateAccount } from '../accountRuntime.js';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
} from '@happier-dev/plugin-sdk/actions';
import {
  TriageGetResultV1Schema,
  TriageListInstancesResultV1Schema,
  TriageListScopeUnitsResultV1Schema,
  TriageScanResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';
import { activate } from '../accountRuntime.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { SENTRY_PLUGIN } from '../manifest.js';
import { SENTRY_ACTION_IDS } from '../sentryContracts.js';
import { TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';

import issueDetail from '../fixtures/issueDetail.json' with { type: 'json' };
import issuesListPage1 from '../fixtures/issuesListPage1.json' with { type: 'json' };
import organizationsCloudPage from '../fixtures/organizationsCloudPage.json' with { type: 'json' };

import {
  SENTRY_CONNECTED_ACCOUNT_PURPOSE,
  SENTRY_FAILURE_CODES,
  SENTRY_ORGANIZATIONS_PAGE_SIZE,
  SENTRY_SCOPE_SEPARATOR,
} from '../sentryContracts.js';
import { encodeSentryInstanceConfiguration } from '../instances/sentryInstanceConfiguration.js';

import {
  getSentrySourceEntry,
  listSentryInstances,
  scanSentrySource,
} from './operations.js';

const ACCOUNT = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.sentry', localId: 'sentry-account' }),
  accountId: 'account-1',
});

const ORGANIZATION_ID = '7701';

type RecordedResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}>;

/**
 * Rewrites a recorded US Cloud capture onto another deployment origin. Only the
 * declared route changes; every provider field the parsers read is preserved.
 */
function onOrigin(recorded: RecordedResponse, origin: string): RecordedResponse {
  const rewritten = JSON.parse(
    JSON.stringify({ headers: recorded.headers, body: recorded.body })
      .split('https://us.sentry.io')
      .join(origin),
  ) as Readonly<{ headers: Readonly<Record<string, string>>; body: unknown }>;
  return { status: recorded.status, headers: rewritten.headers, body: rewritten.body };
}

function host(options: Readonly<{
  origins?: readonly string[];
  listStatus?: 'complete' | 'truncated';
  responses?: readonly RecordedResponse[];
  binding?: unknown;
}> = {}) {
  const responses = options.responses ?? [];
  let call = 0;
  const listAccounts = vi.fn(async () => ({
    status: options.listStatus ?? ('complete' as const),
    accounts: [{
      account: ACCOUNT,
      displayName: 'Sentry · de.sentry.io',
      state: 'connected' as const,
      connectedAccountOrigins: options.origins ?? ['https://de.sentry.io'],
      connectedAccountBases: options.origins ?? ['https://de.sentry.io'],
    }],
  }));
  const materializeListedAccount = vi.fn(async () => ({
    kind: 'httpHeaders' as const,
    headers: { authorization: 'Bearer test-token-value' },
  }));
  // The host answers the same authorized-target read two ways: `listAccounts` throws
  // for a purpose it holds no selection for, and `getBinding` answers `null` there.
  const getBinding = vi.fn(async () => options.binding ?? null);
  const request = vi.fn(async (input: Readonly<{ url: string }>) => {
    const recorded = responses[call++];
    if (recorded === undefined) throw new Error(`unexpected request ${input.url}`);
    return {
      status: recorded.status,
      finalUrl: input.url,
      headers: recorded.headers,
      body: new TextEncoder().encode(JSON.stringify(recorded.body)),
    };
  });
  return {
    context: {
      signal: new AbortController().signal,
      services: {
        connectedAccounts: { listAccounts, materializeListedAccount, getBinding },
        http: { request },
      },
    } as unknown as PluginInvocationContext,
    listAccounts,
    materializeListedAccount,
    getBinding,
    request,
  };
}

function configuredInstance(origin: string) {
  const token = encodeSentryInstanceConfiguration({
    v: 1,
    organizationId: ORGANIZATION_ID,
    projectScope: { kind: 'allAccessible' },
    environmentScope: { kind: 'all' },
  });
  return {
    v: 1 as const,
    instance: {
      source: { pluginId: 'happier.sentry', localId: 'sentry-issues' },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
    localInstanceKey: `${origin}${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`,
    configuration: { v: 1 as const, token },
  };
}

describe('Sentry Triage source operations', () => {
    it('executes the Account scan through registration and HTTP without a Machine', async () => {
        const h = host({ responses: [onOrigin(issuesListPage1, 'https://us.sentry.io')] });
        const kit = await createPluginTestkit({ manifest: SENTRY_PLUGIN.manifest,
            module: { activate: SENTRY_PLUGIN.activate, activateAccount }, services: h.context.services });
        try {
            expect(await kit.invokeAction(SENTRY_ACTION_IDS.scan, { v: 1, instance: configuredInstance('https://us.sentry.io'), page: { kind: 'initial', limit: 3 } }))
                .toMatchObject({ kind: 'page', observations: expect.arrayContaining([
                    expect.objectContaining({ kind: 'present', snapshot: expect.objectContaining({ title: issuesListPage1.body[0]!.title }) }),
                ]) });
            expect(h.request).toHaveBeenCalledTimes(1);
        } finally { await kit.dispose(); }
    });
  it('keeps valid project choices with explicit partial evidence and does not render provider refusal as emptiness', async () => {
    const register = vi.fn();
    await activate({ actions: { register }, connectedAccounts: { register: vi.fn() }, composerReferences: { register: vi.fn() } } as never);
    const list = register.mock.calls.find(([id]) => id === 'sentry/list-projects')?.[1];
    expect(list).toBeTypeOf('function');
    const current = configuredInstance('https://us.sentry.io');
    const draft = { v: 1, binding: current.binding, localInstanceKey: current.localInstanceKey,
      keyStability: 'locatorDerived', configuration: current.configuration };
    const partialHost = host({ responses: [{ status: 200, headers: {}, body: [
      { id: '9001', name: 'Checkout' }, { id: 'mutable-slug', name: 'Unreadable project' },
    ] }] });
    expect(TriageListScopeUnitsResultV1Schema.parse(await list({ v: 1, draft }, partialHost.context)))
      .toMatchObject({ kind: 'page', status: 'partial', units: [{ id: '9001', label: 'Checkout' }], failure: { class: 'unsupportedContract' } });
    const refusedHost = host({ responses: [{ status: 403, headers: {}, body: {} }] });
    expect(TriageListScopeUnitsResultV1Schema.parse(await list({ v: 1, draft }, refusedHost.context)))
      .toMatchObject({ kind: 'failed', failure: { class: 'permission' } });
  });

  it('exposes searchable project pages and provider-silent configured selection through the registered Action', async () => {
    const harness = host({ responses: [{
      status: 200,
      headers: { link: '<https://us.sentry.io/api/0/organizations/7701/projects/?cursor=next>; rel="next"; results="true"; cursor="next"' },
      body: [{ id: '9001', name: 'Checkout', slug: 'checkout', hasAccess: true }],
    }, {
      status: 200,
      headers: { link: '<https://us.sentry.io/api/0/organizations/7701/projects/>; rel="next"; results="false"' },
      body: [{ id: '9002', name: 'Checkout worker', slug: 'checkout-worker', hasAccess: true }],
    }] });
    const register = vi.fn();
    await activate({ actions: { register }, connectedAccounts: { register: vi.fn() }, composerReferences: { register: vi.fn() } } as never);
    const list = register.mock.calls.find(([id]) => id === 'sentry/list-projects')?.[1];
    expect(list).toBeTypeOf('function');
    const current = configuredInstance('https://us.sentry.io');
    const draft = {
      v: 1, binding: current.binding, localInstanceKey: current.localInstanceKey,
      keyStability: 'locatorDerived', locator: { v: 1, displayLabel: 'Organization' },
      configuration: { v: 1, token: JSON.stringify({
        v: 1, organizationId: ORGANIZATION_ID, environmentScope: { kind: 'all' },
        projectScope: { kind: 'selected', unitIds: ['9001'] },
        projectUnits: [{ id: '9001', label: 'Checkout', secondaryText: 'checkout' }],
      }) },
    };
    const configured = TriageListScopeUnitsResultV1Schema.parse(await list({ v: 1, draft, mode: 'configured' }, harness.context));
    expect(configured).toMatchObject({ kind: 'page', status: 'complete', selection: { kind: 'selected', unitIds: ['9001'] }, units: [{ id: '9001', label: 'Checkout' }] });
    expect(harness.materializeListedAccount).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
    const first = TriageListScopeUnitsResultV1Schema.parse(await list({ v: 1, draft, query: 'check' }, harness.context));
    expect(first).toMatchObject({ kind: 'page', status: 'partial', units: [{ id: '9001', label: 'Checkout' }] });
    if (first.kind !== 'page' || first.status !== 'partial') throw new Error('expected project continuation');
    const last = TriageListScopeUnitsResultV1Schema.parse(await list({ v: 1, draft, query: 'check', cursor: first.nextCursor }, harness.context));
    expect(last).toMatchObject({ kind: 'page', status: 'complete', units: [{ id: '9002', label: 'Checkout worker' }] });
    const urls = harness.request.mock.calls.map(([request]) => new URL(request.url));
    expect(urls.map((url) => url.pathname)).toEqual(['/api/0/organizations/7701/projects/', '/api/0/organizations/7701/projects/']);
    expect(urls.map((url) => url.searchParams.get('query'))).toEqual(['check', 'check']);
    expect(urls[1]?.searchParams.get('cursor')).toBe('next');
    expect(PLUGIN_MANIFEST.contributes.actions.find(({ id }) => id === 'sentry/list-projects'))
      .toMatchObject({ dangerLevel: 'safe', surfaces: expect.arrayContaining(['ui', 'agent', 'mcp', 'cli']) });
  });

  it('keeps selected projects on the registered scan Action across continuation pages', async () => {
    const harness = host({ responses: [issuesListPage1, {
      ...issuesListPage1,
      headers: { link: '<https://us.sentry.io/api/0/organizations/7701/issues/>; rel="next"; results="false"' },
      body: [],
    }] });
    const register = vi.fn();
    await activate({ actions: { register }, connectedAccounts: { register: vi.fn() }, composerReferences: { register: vi.fn() } } as never);
    const scan = register.mock.calls.find(([id]) => id === 'sentry/scan-issues')?.[1];
    expect(scan).toBeTypeOf('function');
    const instance = configuredInstance('https://us.sentry.io');
    instance.configuration.token = JSON.stringify({
      v: 1, organizationId: ORGANIZATION_ID,
      projectScope: { kind: 'selected', unitIds: ['9001'] }, environmentScope: { kind: 'all' },
    });
    const first = TriageScanResultV1Schema.parse(await scan({
      v: 1, instance, page: { kind: 'initial', limit: 30 },
    }, harness.context));
    expect(first.kind).toBe('page');
    if (first.kind !== 'page') throw new Error('expected a continuation');
    expect(first.observations[0]).toMatchObject({
      localRef: { collisionScope: `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}` },
      snapshot: { scopeUnitId: '9001' },
    });
    const last = TriageScanResultV1Schema.parse(await scan({
      v: 1, instance, page: { kind: 'continuation', continuation: first.continuation },
    }, harness.context));
    expect(last.kind).toBe('complete');
    expect(harness.request.mock.calls.map(([request]) => new URL(request.url).searchParams.getAll('project')))
      .toEqual([['9001'], ['9001']]);
  });

  async function write(action: string, harness: ReturnType<typeof host>, extra: object = {}, observeCancelledSettlement = false) {
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate: SENTRY_PLUGIN.activate, activateAccount }, services: harness.context.services });
    try {
      const handler = kit.registration('actions', action);
      if (!handler) throw new Error(`Missing registered Action ${action}`);
      const input = {
        v: 1, instance: configuredInstance('https://de.sentry.io'),
        localRef: { kindId: 'error-issue', collisionScope: `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`, entryId: issueDetail.body.id },
        ...extra,
      };
      // Only cancellation settlement needs observation before the Action RPC discards an aborted reply.
      return TriageTaskWriteResultV1Schema.parse(await (observeCancelledSettlement
        ? handler(input, harness.context)
        : kit.invokeAction(action, input)));
    } finally {
      await kit.dispose();
    }
  }

  it.each([
    ['sentry/resolve-issue', {}, { status: 'resolved' }, { status: 'resolved' }],
    ['sentry/archive-issue', {}, { status: 'ignored', substatus: 'archived_forever' }, { status: 'ignored', substatus: 'archived_forever' }],
    ['sentry/assign-issue', { assignee: { type: 'team', id: '42' } }, { assignedTo: 'team:42' }, { assignedTo: { type: 'team', id: '42', name: 'QA team' } }],
  ])('dispatches %s once and confirms the exact issue with a fresh GET', async (action, extra, body, changed) => {
    const harness = host({ responses: [issueDetail, { status: 200, headers: {}, body }, { ...issueDetail, body: { ...issueDetail.body, ...changed } }] });
    const result = await write(action, harness, extra);
    expect(result).toMatchObject({ kind: 'applied', observation: { localRef: { entryId: issueDetail.body.id } } });
    expect(harness.request.mock.calls.map(([request]) => request)).toMatchObject([
      { method: 'GET' }, { method: 'PUT', body: new TextEncoder().encode(JSON.stringify(body)), redirect: 'error' }, { method: 'GET' },
    ]);
    expect(harness.request.mock.calls.every(([request]) => new URL(request.url).pathname === `/api/0/organizations/${ORGANIZATION_ID}/issues/${issueDetail.body.id}/`)).toBe(true);
    const declaration = PLUGIN_MANIFEST.contributes.actions.find(({ id }) => id === action);
    expect(declaration).toMatchObject({ dangerLevel: 'writesRemote', confirmation: expect.any(Object), surfaces: expect.arrayContaining(['agent', 'mcp', 'cli', 'ui']) });
  });

  it('refuses a merged Sentry id before PUT', async () => {
    const harness = host({ responses: [{ ...issueDetail, body: { ...issueDetail.body, id: '99999' } }] });
    expect(await write('sentry/resolve-issue', harness)).toEqual({ kind: 'refused', reason: 'sentry-issue-merged' });
    expect(harness.request.mock.calls).toHaveLength(1);
  });

  it.each([true, false])('settles answer loss by reread without replay (changed=%s)', async (changed) => {
    const harness = host();
    harness.request.mockImplementationOnce(async (input) => ({ status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(issueDetail.body)) }));
    harness.request.mockRejectedValueOnce(new Error('connection lost'));
    harness.request.mockImplementationOnce(async (input) => ({ status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify({ ...issueDetail.body, status: changed ? 'resolved' : 'unresolved' })) }));
    expect(await write('sentry/resolve-issue', harness)).toMatchObject({ kind: changed ? 'applied' : 'uncertain' });
    expect(harness.request.mock.calls).toHaveLength(3);
  });

  it('does not mistake a PUT echo for settlement when confirmation fails', async () => {
    const harness = host({ responses: [issueDetail, { status: 200, headers: {}, body: { status: 'resolved' } }, { status: 503, headers: {}, body: {} }] });
    expect(await write('sentry/resolve-issue', harness)).toMatchObject({ kind: 'uncertain', failure: { class: 'transient' } });
  });

  it('returns a permission failure without confirming a rejected Sentry write', async () => {
    const harness = host({ responses: [issueDetail, { status: 403, headers: {}, body: {} }] });
    expect(await write('sentry/resolve-issue', harness)).toMatchObject({ kind: 'failed', failure: { class: 'permission' } });
    expect(harness.request.mock.calls).toHaveLength(2);
  });

  it('refuses an out-of-scope Sentry write without releasing credentials', async () => {
    const harness = host();
    expect(await write('sentry/resolve-issue', harness, { localRef: { kindId: 'error-issue', collisionScope: `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}999`, entryId: issueDetail.body.id } })).toMatchObject({ kind: 'failed', failure: { class: 'unsupportedContract' } });
    expect(harness.materializeListedAccount).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('refuses an unavailable selected Account before Sentry mutation HTTP', async () => {
    const harness = host();
    harness.materializeListedAccount.mockRejectedValue(new Error('selected account unavailable'));
    expect(await write('sentry/resolve-issue', harness)).toMatchObject({ kind: 'failed', failure: { class: 'authentication' } });
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('requires exact Sentry assignee identity on confirmation, not its display name', async () => {
    const harness = host({ responses: [issueDetail, { status: 200, headers: {}, body: {} }, { ...issueDetail, body: { ...issueDetail.body, assignedTo: { type: 'user', id: '999', name: 'QA team' } } }] });
    expect(await write('sentry/assign-issue', harness, { assignee: { type: 'team', id: '42' } })).toMatchObject({ kind: 'uncertain' });
  });

  it.each([
    { assignedTo: null, expected: 'applied' },
    { assignedTo: undefined, expected: 'uncertain' },
  ])('clears assignment through the same exact issue writer and confirms explicit unassignment ($expected)', async ({ assignedTo, expected }) => {
    const harness = host({ responses: [issueDetail, { status: 200, headers: {}, body: {} }, { ...issueDetail, body: { ...issueDetail.body, assignedTo } }] });
    expect(await write('sentry/assign-issue', harness, { assignee: null })).toMatchObject({ kind: expected });
    const dispatched = harness.request.mock.calls[1]?.[0];
    expect(JSON.parse(new TextDecoder().decode(dispatched?.body))).toEqual({ assignedTo: null });
    expect(harness.request).toHaveBeenCalledTimes(3);
  });

  it('does not confirm Archived forever from a temporary Sentry archive', async () => {
    const harness = host({ responses: [issueDetail, { status: 200, headers: {}, body: {} }, { ...issueDetail, body: { ...issueDetail.body, status: 'ignored', substatus: 'archived_until_escalating' } }] });
    expect(await write('sentry/archive-issue', harness)).toMatchObject({ kind: 'uncertain' });
  });

  it('rejects unsupported Sentry fields before provider access', async () => {
    const harness = host();
    await expect(write('sentry/resolve-issue', harness, { discard: true })).rejects.toThrow();
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('keeps a cancelled Sentry dispatch uncertain and does not replay', async () => {
    const controller = new AbortController();
    const harness = host();
    harness.context = { ...harness.context, signal: controller.signal };
    harness.request.mockImplementationOnce(async (input) => ({ status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(issueDetail.body)) }));
    harness.request.mockImplementationOnce(async () => { controller.abort(); throw new Error('cancelled after send'); });
    expect(await write('sentry/resolve-issue', harness, {}, true)).toMatchObject({ kind: 'uncertain', failure: { code: SENTRY_FAILURE_CODES.cancelled } });
    expect(harness.request.mock.calls).toHaveLength(2);
  });

  it('refuses a native credential binding before account or provider access', async () => {
    const seam = host();
    const result = await scanSentrySource({
      v: 1,
      instance: { ...configuredInstance('https://de.sentry.io'), binding: {
        purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
        source: 'native',
        service: ACCOUNT.service,
      } },
      page: { kind: 'initial', limit: 30 },
    }, seam.context);
    expect(result).toMatchObject({ kind: 'failed', failure: { class: 'unsupportedContract' } });
    expect(seam.materializeListedAccount).not.toHaveBeenCalled();
    expect(seam.request).not.toHaveBeenCalled();
  });

  it('reports a first run with no selected account as an empty listing, not a Sentry failure', async () => {
    // The host declines to list a purpose it holds no selection for, and that refusal
    // is a throw. Mapping it into this source's provider vocabulary would accuse a
    // Sentry deployment no request was ever sent to, and hide the one thing the
    // reader can act on.
    const harness = host();
    harness.listAccounts.mockRejectedValue(new Error('purpose has no selected account'));

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
    expect(result).toEqual({ kind: 'complete', candidates: [], failures: [] });
    expect(harness.getBinding).toHaveBeenCalledWith(
      SENTRY_CONNECTED_ACCOUNT_PURPOSE,
      { signal: harness.context.signal },
    );
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('lets a listing refusal that is not an unbound purpose keep propagating', async () => {
    // A source that learned nothing must not claim it learned that there is nothing:
    // a confirmed binding means the listing failed for some other reason.
    const harness = host({ binding: { account: ACCOUNT } });
    const refusal = new Error('connected accounts unavailable');
    harness.listAccounts.mockRejectedValue(refusal);

    await expect(listSentryInstances({ v: 1 }, harness.context)).rejects.toBe(refusal);
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('discovers candidates through the exact listed account, on the origin the host projected', async () => {
    const harness = host({
      origins: ['https://de.sentry.io'],
      responses: [onOrigin(organizationsCloudPage, 'https://de.sentry.io')],
    });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
    expect(harness.listAccounts).toHaveBeenCalledWith(
      { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE },
      { signal: harness.context.signal },
    );
    expect(harness.request.mock.calls[0]?.[0]?.url)
      .toBe('https://de.sentry.io/api/0/organizations/?per_page=100');
    expect(harness.materializeListedAccount).toHaveBeenCalledWith({
      purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE,
      account: ACCOUNT,
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://de.sentry.io',
        headerNames: ['authorization'],
      },
    }, { signal: harness.context.signal });
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') return;
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
      localInstanceKey: `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`,
      keyStability: 'locatorDerived',
    });
  });

  it('carries every discovered organization instead of imposing a local thirty-two-instance ceiling', async () => {
    const recorded = onOrigin(organizationsCloudPage, 'https://de.sentry.io');
    const organization = (recorded.body as readonly Record<string, unknown>[])[0];
    if (organization === undefined) throw new Error('expected one recorded organization');
    const harness = host({
      origins: ['https://de.sentry.io'],
      responses: [{
        ...recorded,
        body: Array.from({ length: 33 }, (_unused, index) => ({
          ...organization,
          id: String(index + 1),
          slug: `organization-${index + 1}`,
          name: `Organization ${index + 1}`,
        })),
      }],
    });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('expected complete discovery');
    expect(result.candidates).toHaveLength(33);
  });

  it('keeps a useful discovery prefix with explicit incompleteness inside the public response envelope', async () => {
    const origin = 'https://de.sentry.io';
    const recorded = onOrigin(organizationsCloudPage, origin);
    const organization = (recorded.body as readonly Record<string, unknown>[])[0];
    if (organization === undefined) throw new Error('expected one recorded organization');
    // Sentry's Organization model and API serializer both bound name to 64
    // characters. Derive membership from a real registered draft's bytes,
    // rather than stretching a native field beyond its provider contract.
    const label = 'o'.repeat(64);
    const responses: RecordedResponse[] = [{
      ...recorded, headers: { link: `<${origin}/api/0/organizations/>; rel="next"; results="false"` },
      body: [{ ...organization, id: '1', slug: 'organization-1', name: label }],
    }];
    const harness = host({ origins: [origin], responses });
    const kit = await createPluginTestkit({ manifest: SENTRY_PLUGIN.manifest,
      module: { activate: SENTRY_PLUGIN.activate, activateAccount }, services: harness.context.services });
    try {
      const seed = TriageListInstancesResultV1Schema.parse(await kit.invokeAction(SENTRY_ACTION_IDS.listInstances, { v: 1 }));
      if (seed.kind !== 'complete' || seed.candidates.length !== 1) throw new Error('expected one complete discovery draft');
      const draftBytes = new TextEncoder().encode(JSON.stringify(seed.candidates[0])).byteLength;
      const count = Math.ceil(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / draftBytes) + 1;
      const pages = Math.ceil(count / SENTRY_ORGANIZATIONS_PAGE_SIZE);
      responses.push(...Array.from({ length: pages }, (_unused, page) => ({
        ...recorded,
        headers: { link: `<${origin}/api/0/organizations/?per_page=${SENTRY_ORGANIZATIONS_PAGE_SIZE}&cursor=0:${page + 1}:0>; rel="next"; results="${page + 1 < pages}"; cursor="0:${page + 1}:0"` },
        body: Array.from({ length: Math.min(SENTRY_ORGANIZATIONS_PAGE_SIZE, count - page * SENTRY_ORGANIZATIONS_PAGE_SIZE) }, (_row, offset) => ({
          ...organization,
          id: String(1 + page * SENTRY_ORGANIZATIONS_PAGE_SIZE + offset),
          slug: `organization-${1 + page * SENTRY_ORGANIZATIONS_PAGE_SIZE + offset}`,
          name: label,
        })),
      })));
      const result = TriageListInstancesResultV1Schema.parse(await kit.invokeAction(SENTRY_ACTION_IDS.listInstances, { v: 1 }));
      expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
      expect(result.kind).toBe('incomplete');
      if (result.kind !== 'incomplete') throw new Error('expected explicit discovery incompleteness');
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates.length).toBeLessThan(count);
      expect(result.failure).toMatchObject({
        class: 'unsupportedContract', code: SENTRY_FAILURE_CODES.instanceListResponseTruncated,
      });
      expect(isExternalActionResultWithinResponseEnvelopeLimitV1({
        ...result, candidates: [...result.candidates, result.candidates[result.candidates.length - 1]],
      })).toBe(false);
      expect(harness.request).toHaveBeenCalledTimes(pages + 1);
    } finally { await kit.dispose(); }
    // The real 24 MB envelope requires tens of thousands of native-valid rows;
    // its measured 21.72 s suite exceeded the ordinary 15 s test-case budget.
  }, 60_000);

  it('discovers the US Cloud deployment when that is the projected origin', async () => {
    const harness = host({
      origins: ['https://us.sentry.io'],
      responses: [organizationsCloudPage],
    });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(harness.request.mock.calls[0]?.[0]?.url)
      .toBe('https://us.sentry.io/api/0/organizations/?per_page=100');
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') return;
    expect(result.candidates[0]?.localInstanceKey)
      .toBe(`https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`);
  });

  /**
   * Discovery reports `complete` only when the provider itself stated that its
   * organization listing ended. A `Link` header whose pagination metadata this
   * source cannot read leaves organizations unreachable, and reporting that as
   * complete discovery is how a Settings page offers a partial account list as
   * the whole one.
   */
  it('never reports unreadable organization pagination as complete discovery', async () => {
    const recorded = onOrigin(organizationsCloudPage, 'https://de.sentry.io');
    for (const link of [
      'not a link',
      '<https://de.sentry.io/api/0/organizations/?&cursor=a>; rel="previous"; results="false"',
      '<https://de.sentry.io/api/0/organizations/?&cursor=a>; rel="next"',
      '<https://de.sentry.io/api/0/organizations/?&cursor=a>; rel="next"; results="maybe"',
    ]) {
      const harness = host({
        origins: ['https://de.sentry.io'],
        responses: [{ ...recorded, headers: { ...recorded.headers, link } }],
      });

      const result = await listSentryInstances({ v: 1 }, harness.context);

      expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
      expect(result.kind, link).toBe('incomplete');
      if (result.kind !== 'incomplete') continue;
      // Every organization the page did carry is still an offerable candidate.
      expect(result.candidates, link).toHaveLength(1);
      expect(result.failures, link).toContainEqual({
        binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
        failure: {
          class: 'unsupportedContract',
          code: SENTRY_FAILURE_CODES.paginationCursorMalformed,
        },
      });
      // One page was read: an unreadable next relation is not a position to request.
      expect(harness.request, link).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps valid organization siblings but never reports a skipped malformed sibling as complete discovery', async () => {
    const recorded = onOrigin(organizationsCloudPage, 'https://de.sentry.io');
    const harness = host({
      origins: ['https://de.sentry.io'],
      responses: [{
        ...recorded,
        body: [
          ...(recorded.body as readonly unknown[]),
          { id: 'not-a-numeric-organization-id', name: 'Unreadable sibling' },
        ],
      }],
    });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
    expect(result.kind).toBe('incomplete');
    if (result.kind !== 'incomplete') return;
    expect(result.candidates).toHaveLength(1);
    expect(result.failure).toEqual({
      class: 'unsupportedContract',
      code: SENTRY_FAILURE_CODES.malformedOrganizationRow,
    });
    expect(result.failures).toContainEqual({
      binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
      failure: {
        class: 'unsupportedContract',
        code: SENTRY_FAILURE_CODES.malformedOrganizationRow,
      },
    });
  });

  /**
   * Sentry's organization cursor is an OFFSET triple (`value:offset:is_prev`), so a
   * concurrent create, delete or rename shifts the window between two pages and hands
   * back an organization the walk already recorded. Each copy became its own candidate:
   * the same organization was offered twice in Settings, and each duplicate obscured a
   * DISTINCT organization in the discovery result.
   *
   * A candidate is identified by its match tuple, which the draft already carries: the
   * exact account binding plus `localInstanceKey`. Two rows resolving to that same tuple
   * are one candidate, not two.
   */
  it('records one candidate per organization when offset paging returns the same row twice', async () => {
    const page = (
      organizationIds: readonly string[],
      nextResults: boolean,
      cursor: string,
    ): RecordedResponse => ({
      status: 200,
      headers: {
        'content-type': 'application/json',
        link: `<https://de.sentry.io/api/0/organizations/?&cursor=${cursor}>; rel="next"; results="${String(nextResults)}"; cursor="${cursor}"`,
      },
      body: organizationIds.map((id) => ({
        id,
        slug: `org-${id}`,
        name: `Org ${id}`,
        links: { organizationUrl: `https://org-${id}.sentry.io`, regionUrl: 'https://de.sentry.io' },
      })),
    });

    const harness = host({
      origins: ['https://de.sentry.io'],
      responses: [
        page(['7701', '7702'], true, '1:0:0'),
        // The window shifted: `7702` is repeated, and `7703` is genuinely new.
        page(['7702', '7703'], false, '1:100:0'),
      ],
    });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(() => TriageListInstancesResultV1Schema.parse(result)).not.toThrow();
    if (result.kind === 'failed') return;
    // Every DISTINCT organization survives; only the repeat is dropped.
    expect(result.candidates.map((candidate) => candidate.localInstanceKey)).toEqual([
      `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`,
      `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}7702`,
      `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}7703`,
    ]);
    // A repeat is not a provider contract failure either: nothing is reported as broken.
    expect(result.failures).toEqual([]);
  });

  it('never guesses a deployment for an account whose route the host did not project', async () => {
    const harness = host({ origins: [], responses: [] });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(harness.request).not.toHaveBeenCalled();
    expect(harness.materializeListedAccount).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: 'complete',
      candidates: [],
      failures: [{
        binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
        failure: {
          class: 'unsupportedContract',
          code: SENTRY_FAILURE_CODES.regionOriginUndeclared,
        },
      }],
    });
  });

  it('reports a truncated account listing as incomplete discovery', async () => {
    const harness = host({
      listStatus: 'truncated',
      responses: [onOrigin(organizationsCloudPage, 'https://de.sentry.io')],
    });

    const result = await listSentryInstances({ v: 1 }, harness.context);

    expect(result.kind).toBe('incomplete');
    if (result.kind !== 'incomplete') return;
    expect(result.failure).toEqual({
      class: 'unsupportedContract',
      code: SENTRY_FAILURE_CODES.accountListTruncated,
    });
    expect(result.candidates).toHaveLength(1);
  });

  it('scans the configured instance on its own origin and carries a continuation', async () => {
    const harness = host({
      responses: [onOrigin(issuesListPage1, 'https://de.sentry.io')],
    });

    const result = await scanSentrySource({
      v: 1,
      instance: configuredInstance('https://de.sentry.io'),
      page: { kind: 'initial', limit: 32 },
    }, harness.context);

    expect(() => TriageScanResultV1Schema.parse(result)).not.toThrow();
    expect(harness.request.mock.calls[0]?.[0]?.url)
      .toContain('https://de.sentry.io/api/0/organizations/7701/issues/');
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.observations[0]).toMatchObject({
      kind: 'present',
      localRef: {
        kindId: 'error-issue',
        collisionScope: `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`,
      },
    });
    expect(JSON.stringify(result)).not.toContain('Bearer');
  });

  it('reads one issue authoritatively and returns the exact requested local ref', async () => {
    const harness = host({ responses: [onOrigin(issueDetail, 'https://de.sentry.io')] });
    const collisionScope = `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`;

    const result = await getSentrySourceEntry({
      v: 1,
      instance: configuredInstance('https://de.sentry.io'),
      localRef: { kindId: 'error-issue', collisionScope, entryId: '5501001' },
    }, harness.context);

    expect(() => TriageGetResultV1Schema.parse(result)).not.toThrow();
    expect(harness.request.mock.calls[0]?.[0]?.url)
      .toBe('https://de.sentry.io/api/0/organizations/7701/issues/5501001/');
    expect(result).toMatchObject({
      kind: 'present',
      localRef: { kindId: 'error-issue', collisionScope, entryId: '5501001' },
    });
  });

  it('refuses a local ref that belongs to another configured scope', async () => {
    const harness = host({ responses: [] });

    const result = await getSentrySourceEntry({
      v: 1,
      instance: configuredInstance('https://de.sentry.io'),
      localRef: {
        kindId: 'error-issue',
        collisionScope: `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}${ORGANIZATION_ID}`,
        entryId: '5501001',
      },
    }, harness.context);

    expect(harness.request).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract' },
    });
  });
});
