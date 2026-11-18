// QB-19/20/24/26/27/67/68: registered Account source operations over real HTTP.
// This proves the plugin/HTTP seam, not UI → server → daemon credential provisioning.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import {
  MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1, MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  TriageGetResultV1Schema, TriageListInstancesResultV1Schema, TriageScanResultV1Schema,
} from '@happier-dev/triage-protocol/v1';
import { activate as activateSentryAccount } from '../../../plugins/sentry/src/accountRuntime';
import { SENTRY_PLUGIN } from '../../../plugins/sentry/src/manifest';
import { SENTRY_ACTION_IDS, SENTRY_CONNECTED_ACCOUNT_PURPOSE, SENTRY_FAILURE_CODES, SENTRY_SCOPE_SEPARATOR } from '../../../plugins/sentry/src/sentryContracts';
import { encodeSentryInstanceConfiguration } from '../../../plugins/sentry/src/instances/sentryInstanceConfiguration';
import sentryPage from '../../../plugins/sentry/src/fixtures/issuesListPage1.json';
import sentryIssue from '../../../plugins/sentry/src/fixtures/issueDetail.json';
import sentryOrganizations from '../../../plugins/sentry/src/fixtures/organizationsCloudPage.json';
import { activate as activatePosthogAccount } from '../../../plugins/posthog/src/accountRuntime';
import { POSTHOG_PLUGIN } from '../../../plugins/posthog/src/manifest';
import { POSTHOG_ACTION_IDS, POSTHOG_CONNECTED_ACCOUNT_PURPOSE } from '../../../plugins/posthog/src/posthogContracts';
import { POSTHOG_FAILURE_CODES, createPosthogSourceEntryReader } from '../../../plugins/posthog/src/source/operations';
import { encodePosthogConfiguration } from '../../../plugins/posthog/src/source/instance';
import { PosthogIssueActivityResultV1Schema } from '../../../plugins/posthog/src/source/detail/issueActivityContract';
import { PosthogSampledEventsResultV1Schema } from '../../../plugins/posthog/src/source/detail/issueEventsContract';
import posthogPage from '../../../plugins/posthog/src/api/__fixtures__/queryIssuesPage1.json';
import posthogIssue from '../../../plugins/posthog/src/api/__fixtures__/crudIssueRead.json';
import posthogDetail from '../../../plugins/posthog/src/api/__fixtures__/queryIssueDetail.json';
import posthogEvents from '../../../plugins/posthog/src/api/__fixtures__/queryIssueEventsPage.json';

type Provider = 'sentry' | 'posthog';
type Reply = Readonly<{ status?: number; headers?: Readonly<Record<string, string>>; body?: unknown; disconnect?: boolean; hold?: boolean }>;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, 'Provider fault fixture cleanup failed');
});

function configured(provider: Provider) {
  const sourceInstanceId = randomUUID();
  if (provider === 'sentry') return {
    v: 1 as const,
    instance: { source: { pluginId: SENTRY_PLUGIN.manifest.id, localId: 'sentry-issues' }, sourceInstanceId },
    binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: {
      service: { pluginId: SENTRY_PLUGIN.manifest.id, localId: 'sentry-account' }, accountId: 'fault-account',
    } },
    localInstanceKey: `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`,
    configuration: { v: 1 as const, token: encodeSentryInstanceConfiguration({ v: 1, organizationId: '7701', projectScope: { kind: 'all' }, environmentScope: { kind: 'all' } }) },
  };
  const encoded = encodePosthogConfiguration({ v: 1,
    organizationUuid: '00000000-0000-4000-8000-0000000000a1',
    environments: [{ teamPathId: 4821, teamUuid: '00000000-0000-4000-8000-0000000000d1', parentProjectId: 4820, displayName: 'Production' }],
    scanWindowPolicy: { kind: 'exact', from: '2026-07-01T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z' },
    detailWindowPolicy: { kind: 'relative', durationMs: 30 * 86_400_000 },
  });
  if (!encoded.ok) throw new Error('PostHog fixture configuration cannot encode');
  return {
    v: 1 as const,
    instance: { source: { pluginId: POSTHOG_PLUGIN.manifest.id, localId: 'posthog-error-tracking' }, sourceInstanceId },
    binding: { purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE, account: {
      service: { pluginId: POSTHOG_PLUGIN.manifest.id, localId: POSTHOG_CONNECTED_ACCOUNT_PURPOSE }, accountId: 'fault-account',
    } },
    localInstanceKey: 'posthog-org:https://eu.posthog.com:00000000-0000-4000-8000-0000000000a1',
    configuration: { v: 1 as const, token: encoded.token },
  };
}

async function fixture(provider: Provider) {
  const instance = configured(provider);
  const origin = provider === 'sentry' ? 'https://us.sentry.io' : 'https://eu.posthog.com';
  const ids = provider === 'sentry' ? SENTRY_ACTION_IDS : POSTHOG_ACTION_IDS;
  const localRef = { kindId: 'error-issue', entryId: provider === 'sentry' ? sentryIssue.body.id : posthogIssue.id,
    collisionScope: provider === 'sentry' ? `${origin}${SENTRY_SCOPE_SEPARATOR}7701` : 'posthog:https://eu.posthog.com:00000000-0000-4000-8000-0000000000d1' };
  const replies: Reply[] = [];
  const requests: Array<Readonly<{ url: URL; method: string; body: unknown }>> = [];
  const materializations: unknown[] = [];
  const transportSignals: Array<AbortSignal | undefined> = [];
  let onRequest: (() => void) | undefined;
  let listedOrigins: readonly string[] = [origin];
  let listingStatus: 'complete' | 'truncated' = 'complete';
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks).toString('utf8');
    requests.push({ url: new URL(request.url ?? '/', origin), method: request.method ?? 'GET', body: bytes ? JSON.parse(bytes) : null });
    const next = replies.shift();
    onRequest?.();
    if (!next) { response.writeHead(598); response.end('{}'); return; }
    if (next.disconnect) { request.socket.destroy(); return; }
    if (next.hold) return;
    response.writeHead(next.status ?? 200, { 'content-type': 'application/json', ...next.headers });
    response.end(JSON.stringify(next.body ?? {}));
  });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  cleanup.push(async () => { http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Provider fixture did not bind TCP');
  // Genuine host boundaries only: account listing/materialization and the HTTP
  // transport. Registration, routing, parsers, classifier and strict ABI stay real.
  const services = {
    connectedAccounts: {
      async listAccounts() { return { status: listingStatus, accounts: [{ account: instance.binding.account, displayName: provider, state: 'connected', connectedAccountOrigins: listedOrigins, connectedAccountBases: listedOrigins }] }; },
      async getBinding() { return null; },
      async materializeListedAccount(input: unknown) { materializations.push(input); return { kind: 'httpHeaders', headers: { authorization: 'Bearer constructed-provider-fault-token' } }; },
    },
    http: createPluginHttpFixture({ async request(input, options) {
      transportSignals.push(options?.signal);
      const url = new URL(input.url);
      expect(url.origin).toBe(origin);
      const response = await fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, {
        method: input.method, headers: input.headers,
        ...(input.body === undefined ? {} : { body: new TextDecoder().decode(input.body) }), signal: options?.signal, redirect: 'error',
      });
      return { status: response.status, finalUrl: input.url, headers: Object.fromEntries(response.headers), body: new Uint8Array(await response.arrayBuffer()) };
    } }),
  } as unknown as PluginInvocationContext['services']; // Host service boundary fixture exposes only the operations used here.
  const plugin = provider === 'sentry' ? SENTRY_PLUGIN : POSTHOG_PLUGIN;
  const kit = await createPluginTestkit({ manifest: plugin.manifest,
    module: { activate: plugin.activate, activateAccount: provider === 'sentry' ? activateSentryAccount : activatePosthogAccount }, services });
  cleanup.push(() => kit.dispose());
  const invoke = (id: string, input: JsonValue) => kit.invokeAction(id, input, { surface: 'ui' });
  const scan = (page: JsonValue = { kind: 'initial', limit: 10 }) => invoke(ids.scan, { v: 1, instance, page });
  const get = () => invoke(ids.get, { v: 1, instance, localRef });
  const goodScan = (): Reply => provider === 'sentry'
    ? { body: sentryPage.body, headers: { link: '<https://us.sentry.io/api/0/organizations/7701/issues/>; rel="next"; results="false"' } }
    : { body: { ...posthogPage, hasMore: false, nextOffset: null } };
  const goodGet = () => { replies.push(...(provider === 'sentry' ? [{ body: sentryIssue.body }] : [{ body: posthogIssue }, { body: posthogDetail }])); };
  return { provider, instance, localRef, ids, kit, services, replies, requests, materializations, transportSignals, invoke, scan, get, goodScan, goodGet,
    origins(value: readonly string[]) { listedOrigins = value; }, truncated() { listingStatus = 'truncated'; },
    nextRequest() { return new Promise<void>(resolve => { onRequest = () => { onRequest = undefined; resolve(); }; }); },
  };
}

describe.each(['sentry', 'posthog'] as const)('%s registered Account provider HTTP faults', provider => {
  it('keeps every valid raw sibling, reports exact omissions and separates entry truncation from enumeration health', async () => {
    const h = await fixture(provider);
    h.replies.push(h.goodScan());
    const control = TriageScanResultV1Schema.parse(await h.scan());
    expect(control.kind).toBe('complete');
    const malformed = provider === 'sentry'
      ? { ...h.goodScan(), body: [sentryPage.body[0], { id: 17 }, sentryPage.body[1], null] }
      : { body: { ...posthogPage, results: [posthogPage.results[0], { id: 'malformed' }, posthogPage.results[1], null], hasMore: false, nextOffset: null } };
    h.replies.push(malformed);
    const partial = TriageScanResultV1Schema.parse(await h.scan());
    expect(partial).toMatchObject({ kind: 'complete', observations: [expect.any(Object), expect.any(Object)],
      evidence: { kind: 'partial', reason: provider === 'sentry' ? SENTRY_FAILURE_CODES.malformedIssueRow : POSTHOG_FAILURE_CODES.malformedRows, omittedItemCount: 2 } });
    if (partial.kind === 'failed') throw new Error('Malformed sibling discarded the valid rows');
    expect(partial.observations.map(row => row.localRef.entryId)).toEqual(provider === 'sentry'
      ? sentryPage.body.map(row => row.id) : posthogPage.results.slice(0, 2).map(row => row.id));
    const pathologicalSentry = { ...sentryPage.body[0], title: 'T'.repeat(20 * 1024), culprit: 'C'.repeat(20 * 1024) };
    h.replies.push(provider === 'sentry'
      ? { ...h.goodScan(), body: [pathologicalSentry] }
      : { body: { ...posthogPage, results: [{ ...posthogPage.results[0], description: 'T'.repeat(20 * 1024) }], hasMore: false, nextOffset: null } });
    const projected = TriageScanResultV1Schema.parse(await h.scan());
    expect(projected).toMatchObject({ kind: 'complete', evidence: { kind: 'walkFinished' }, observations: [{ kind: 'present', snapshot: { projectionTruncated: true } }] });
    if (provider === 'sentry') {
      h.replies.push({ body: pathologicalSentry });
      const exact = TriageGetResultV1Schema.parse(await h.get());
      expect(exact).toMatchObject({ kind: 'present', localRef: h.localRef, snapshot: { projectionTruncated: true } });
      if (exact.kind !== 'present') throw new Error('A large identity-valid issue disappeared at the registered Action boundary');
      expect(new TextEncoder().encode(exact.snapshot.title).byteLength).toBeLessThanOrEqual(MAX_TRIAGE_TEXT_UTF8_BYTES_V1);
      const culprit = exact.snapshot.facts.find(fact => fact.id === 'culprit')?.value;
      expect(culprit).toMatchObject({ kind: 'text' });
      if (culprit?.kind !== 'text') throw new Error('The large culprit fact disappeared instead of being projected');
      expect(new TextEncoder().encode(culprit.value).byteLength).toBeLessThanOrEqual(MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1);
      expect(culprit.value.length).toBeGreaterThan(0);
      expect(culprit.value).not.toBe(pathologicalSentry.culprit);
    }
  });

  it('keeps 401, 403, 429, 5xx, malformed output, unknown status and transport loss unresolved, then recovers', async () => {
    const h = await fixture(provider);
    h.goodGet();
    expect(TriageGetResultV1Schema.parse(await h.get())).toMatchObject({ kind: 'present', localRef: h.localRef });
    for (const [reply, failureClass] of [
      [{ status: 401 }, 'authentication'], [{ status: 403 }, 'permission'], [{ status: 429 }, 'rateLimit'],
      [{ status: 503 }, 'transient'], [{ body: { invalid: true } }, 'unsupportedContract'],
      [{ status: 418 }, 'unknown'], [{ disconnect: true }, 'transient'], [{ status: 404 }, 'unknown'],
    ] as const) {
      h.replies.push(reply);
      expect(TriageGetResultV1Schema.parse(await h.get())).toMatchObject({ kind: 'unresolved', localRef: h.localRef, failure: { class: failureClass } });
      h.goodGet();
      expect(TriageGetResultV1Schema.parse(await h.get())).toMatchObject({ kind: 'present', localRef: h.localRef });
    }
    // An empty walk carries no authoritative tombstone for the successful get.
    h.replies.push(provider === 'sentry' ? { ...h.goodScan(), body: [] } : { body: { results: [], hasMore: false, limit: 10, offset: 0 } });
    expect(TriageScanResultV1Schema.parse(await h.scan())).toMatchObject({ kind: 'complete', observations: [] });
    h.goodGet();
    expect(TriageGetResultV1Schema.parse(await h.get())).toMatchObject({ kind: 'present' });
  });

  it('ends throttled continuations without retry and starts a later pass at its original position', async () => {
    const h = await fixture(provider);
    h.replies.push(provider === 'sentry' ? { body: sentryPage.body, headers: sentryPage.headers } : { body: posthogPage });
    const first = TriageScanResultV1Schema.parse(await h.scan({ kind: 'initial', limit: 10 }));
    expect(first.kind).toBe('page');
    if (first.kind !== 'page') throw new Error('Control did not produce a real continuation');
    for (const hint of ['future', 'absent', 'malformed', 'stale'] as const) {
      const future = 4_000_000_060_000;
      const headers: Readonly<Record<string, string>> = provider === 'sentry'
        ? hint === 'absent' ? {} : { 'x-sentry-rate-limit-reset': hint === 'future' ? String(future / 1_000) : hint === 'stale' ? '1' : 'malformed' }
        : hint === 'absent' ? {} : { 'retry-after': hint === 'future' ? new Date(future).toUTCString() : hint === 'stale' ? new Date(1_000).toUTCString() : 'malformed' };
      const before = h.requests.length;
      h.replies.push({ status: 429, headers });
      const failed = TriageScanResultV1Schema.parse(await h.scan({ kind: 'continuation', continuation: first.continuation }));
      expect(failed).toMatchObject({ kind: 'failed', failure: { class: 'rateLimit' } });
      expect(failed).not.toHaveProperty('continuation');
      if (failed.kind !== 'failed') throw new Error('Throttle unexpectedly kept a frontier');
      if (hint === 'future') expect(failed.failure.retryNotBeforeMs).toBe(future);
      else expect(failed.failure).not.toHaveProperty('retryNotBeforeMs');
      expect(h.requests).toHaveLength(before + 1); // Observable no-retry contract.
      h.replies.push(h.goodScan());
      expect(TriageScanResultV1Schema.parse(await h.scan())).toMatchObject({ kind: 'complete' });
      const restarted = h.requests.at(-1)!;
      if (provider === 'sentry') expect(restarted.url.searchParams.has('cursor')).toBe(false);
      else expect(restarted.body).toMatchObject({ offset: 0 });
    }
  });

  it('classifies caller cancellation through registered discovery, scan, get and mounted detail', async () => {
    const h = await fixture(provider);
    h.replies.push(h.goodScan());
    expect(TriageScanResultV1Schema.parse(await h.scan()).kind).toBe('complete');
    const entries = [
      [h.ids.listInstances, { v: 1 }],
      [h.ids.scan, { v: 1, instance: h.instance, page: { kind: 'initial', limit: 10 } }],
      [h.ids.get, { v: 1, instance: h.instance, localRef: h.localRef }],
      [provider === 'sentry' ? SENTRY_ACTION_IDS.readIssue : POSTHOG_ACTION_IDS.issueEvents,
        { v: 1, instance: h.instance, localRef: h.localRef, ...(provider === 'sentry' ? { projection: 'overview' } : { limit: 3 }) }],
    ] as const;
    for (const [id, input] of entries) {
      const controller = new AbortController();
      const observed = h.nextRequest();
      h.replies.push({ hold: true });
      const handler = h.kit.registration('actions', id);
      if (!handler) throw new Error(`Missing registered Action ${id}`);
      // The RPC discards aborted replies. Invoke its registered source handler to
      // observe the source classifier's settlement, as in the canonical owner tests.
      const pending = handler(input, { signal: controller.signal, surface: 'ui', requestId: randomUUID(), services: h.services } as PluginInvocationContext);
      await observed;
      controller.abort();
      const result = await pending;
      expect(JSON.stringify(result)).toContain(provider === 'sentry' ? SENTRY_FAILURE_CODES.cancelled : POSTHOG_FAILURE_CODES.cancelled);
      expect(result).not.toHaveProperty('continuation');
      expect(result).not.toMatchObject({ kind: 'present' });
      h.goodGet();
      expect(TriageGetResultV1Schema.parse(await h.get())).toMatchObject({ kind: 'present' });
    }
  });
});

it.each([
  ['same', '99:0:0', SENTRY_FAILURE_CODES.paginationCursorNotAdvancing],
  ['cycle', '100:0:0', SENTRY_FAILURE_CODES.paginationCursorNotAdvancing],
  ['malformed', '', SENTRY_FAILURE_CODES.paginationCursorMalformed],
] as const)('Sentry reapplies advancing Group ids, freezes native geometry and stops a %s cursor', async (_shape, finalCursor, reason) => {
  const h = await fixture('sentry');
  const reply = (cursor: string, title: string): Reply => ({ body: [{ ...sentryPage.body[0], title }],
    headers: { link: `<https://us.sentry.io/api/0/organizations/7701/issues/?cursor=${cursor}>; rel="next"; results="true"; cursor="${cursor}"` } });
  h.replies.push(reply('100:0:0', 'First'), reply('99:0:0', 'Updated'), reply(finalCursor, 'Final'));
  let result = TriageScanResultV1Schema.parse(await h.scan({ kind: 'initial', limit: 37 }));
  for (const title of ['Updated', 'Final']) {
    if (result.kind !== 'page') throw new Error('Advancing duplicate unexpectedly stopped');
    result = TriageScanResultV1Schema.parse(await h.scan({ kind: 'continuation', continuation: result.continuation }));
    expect(result).toMatchObject({ observations: [{ localRef: { entryId: sentryIssue.body.id }, snapshot: { title } }] });
  }
  expect(result).toMatchObject({ kind: 'complete', evidence: { kind: 'partial', reason } });
  expect(h.requests.map(row => row.url.searchParams.get('limit'))).toEqual(['37', '37', '37']);
});

it('Sentry discovers more than 32 valid tuples across real HTTP pages and reports truncated account-list evidence', async () => {
  const h = await fixture('sentry');
  const organizations = Array.from({ length: 40 }, (_, i) => ({ ...sentryOrganizations.body[0], id: String(7701 + i), slug: `org-${i}`, name: `Organization ${i}` }));
  const push = () => h.replies.push(
    { body: organizations.slice(0, 20), headers: { link: '<https://us.sentry.io/api/0/organizations/?cursor=0:20:0>; rel="next"; results="true"; cursor="0:20:0"' } },
    { body: organizations.slice(20), headers: { link: '<https://us.sentry.io/api/0/organizations/>; rel="next"; results="false"' } },
  );
  push();
  expect(TriageListInstancesResultV1Schema.parse(await h.invoke(SENTRY_ACTION_IDS.listInstances, { v: 1 })))
    .toMatchObject({ kind: 'complete', candidates: expect.arrayContaining(organizations.map(row => expect.objectContaining({ localInstanceKey: `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}${row.id}` }))), failures: [] });
  h.truncated();
  push();
  const truncated = TriageListInstancesResultV1Schema.parse(await h.invoke(SENTRY_ACTION_IDS.listInstances, { v: 1 }));
  expect(truncated).toMatchObject({ kind: 'incomplete', failure: { code: SENTRY_FAILURE_CODES.accountListTruncated } });
  if (truncated.kind === 'complete' || truncated.kind === 'incomplete') expect(truncated.candidates).toHaveLength(40);
});

it('Sentry merges only the exact immutable-organization get successor and rejects a mismatched scope before HTTP', async () => {
  const h = await fixture('sentry');
  h.replies.push({ body: { ...sentryIssue.body, id: '5501999' } });
  expect(TriageGetResultV1Schema.parse(await h.get())).toMatchObject({ kind: 'merged', localRef: h.localRef, successor: { ...h.localRef, entryId: '5501999' } });
  const before = h.requests.length;
  expect(TriageGetResultV1Schema.parse(await h.invoke(SENTRY_ACTION_IDS.get, { v: 1, instance: h.instance,
    localRef: { ...h.localRef, collisionScope: `https://de.sentry.io${SENTRY_SCOPE_SEPARATOR}7701` } })))
    .toMatchObject({ kind: 'unresolved', failure: { class: 'unsupportedContract', code: SENTRY_FAILURE_CODES.invokedOrganizationMismatch } });
  expect(h.requests).toHaveLength(before);
});

it('PostHog refuses missing or ambiguous listed origins before materialization, routes by Team id and keeps Activity 403 visible', async () => {
  const h = await fixture('posthog');
  for (const origins of [[], ['https://eu.posthog.com', 'https://us.posthog.com']]) {
    h.origins(origins);
    const discovery = TriageListInstancesResultV1Schema.parse(await h.invoke(POSTHOG_ACTION_IDS.listInstances, { v: 1 }));
    expect(discovery).toMatchObject({ kind: 'complete', candidates: [], failures: [{ failure: { class: 'unsupportedContract',
      code: origins.length === 0 ? POSTHOG_FAILURE_CODES.originUnavailable : POSTHOG_FAILURE_CODES.originAmbiguous } }] });
  }
  expect(h.materializations).toHaveLength(0);
  expect(h.requests).toHaveLength(0);
  expect(JSON.parse(h.instance.configuration.token)).not.toHaveProperty('origin');
  h.origins(['https://eu.posthog.com']);
  h.goodGet();
  expect(TriageGetResultV1Schema.parse(await h.get())).toMatchObject({ kind: 'present', localRef: h.localRef });
  expect(h.requests[0]?.url.pathname).toContain('/api/projects/4821/');
  expect(h.requests[0]?.url.pathname).not.toContain('/4820/');
  h.replies.push({ status: 403 });
  expect(PosthogIssueActivityResultV1Schema.parse(await h.invoke(POSTHOG_ACTION_IDS.issueActivity,
    { v: 1, instance: h.instance, localRef: h.localRef, limit: 3 })))
    .toMatchObject({ kind: 'unavailable', failure: { class: 'permission', code: POSTHOG_FAILURE_CODES.forbidden } });
});

it('PostHog samples with one exact include policy and drops distinct ids and unapproved raw properties', async () => {
  const h = await fixture('posthog');
  h.replies.push({ body: { ...posthogEvents, hasMore: false, nextOffset: null } });
  const result = PosthogSampledEventsResultV1Schema.parse(await h.invoke(POSTHOG_ACTION_IDS.issueEvents,
    { v: 1, instance: h.instance, localRef: h.localRef, limit: 3 }));
  expect(result).toMatchObject({ kind: 'sampled', events: [expect.objectContaining({ uuid: posthogEvents.results[0]?.uuid }), expect.any(Object), expect.any(Object)] });
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]?.body).toMatchObject({ include: ['exception', 'stacktrace', 'navigation', 'correlation'] });
  const serialized = JSON.stringify(result);
  for (const privateValue of ['distinct_id', 'person-distinct-id-must-not-survive', 'sentinel-must-not-survive', 'buyer@example.invalid']) expect(serialized).not.toContain(privateValue);
});

it('applies an injected caller bound to one whole PostHog CRUD-and-enrichment invocation and distinguishes cancellation', async () => {
  const h = await fixture('posthog');
  const input = { v: 1, instance: h.instance, localRef: h.localRef };
  h.goodGet();
  expect(TriageGetResultV1Schema.parse(await h.get())).toMatchObject({ kind: 'present' });
  const read = createPosthogSourceEntryReader(1_000);
  h.replies.push({ hold: true });
  const timedOut = await read(input, {
    surface: 'ui', signal: new AbortController().signal, services: h.services,
  } as PluginInvocationContext);
  expect(TriageGetResultV1Schema.parse(timedOut)).toMatchObject({ kind: 'unresolved', failure: {
    class: 'transient', code: POSTHOG_FAILURE_CODES.timedOut,
  } });
  h.replies.push({ body: posthogIssue }, { hold: true });
  const result = await read(input, {
    surface: 'ui', signal: new AbortController().signal, services: h.services,
  } as PluginInvocationContext);
  // A completed authoritative CRUD read survives unavailable optional enrichment.
  expect(TriageGetResultV1Schema.parse(result)).toMatchObject({ kind: 'present', localRef: h.localRef });
  expect(h.requests.slice(-2).map(request => request.method)).toEqual(['GET', 'POST']);
  const [crudSignal, enrichmentSignal] = h.transportSignals.slice(-2);
  expect(crudSignal).toBe(enrichmentSignal);
  expect(enrichmentSignal?.aborted).toBe(true);
});
