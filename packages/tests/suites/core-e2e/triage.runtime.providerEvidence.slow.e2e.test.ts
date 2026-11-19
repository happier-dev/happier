// QB-67/68 source evidence composition: real registered Actions and loopback HTTP.
// This does not exercise the mounted UI, Corpus, or native Machine transport.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate as activateSentryAccount } from '../../../plugins/sentry/src/accountRuntime';
import { SENTRY_PLUGIN } from '../../../plugins/sentry/src/manifest';
import { SENTRY_ACTION_IDS, SENTRY_CONNECTED_ACCOUNT_PURPOSE, SENTRY_FAILURE_CODES, SENTRY_SCOPE_SEPARATOR, SENTRY_SELF_HOSTED_UNSUPPORTED_CODES } from '../../../plugins/sentry/src/sentryContracts';
import { encodeSentryInstanceConfiguration } from '../../../plugins/sentry/src/instances/sentryInstanceConfiguration';
import { SentryReadEventResultV1Schema } from '../../../plugins/sentry/src/detail/detailContracts';
import { activate as activatePosthogAccount } from '../../../plugins/posthog/src/accountRuntime';
import { POSTHOG_PLUGIN } from '../../../plugins/posthog/src/manifest';
import { POSTHOG_ACTION_IDS, POSTHOG_CONNECTED_ACCOUNT_PURPOSE } from '../../../plugins/posthog/src/posthogContracts';
import { encodePosthogConfiguration } from '../../../plugins/posthog/src/source/instance';
import { PosthogSampledEventsResultV1Schema } from '../../../plugins/posthog/src/source/detail/issueEventsContract';
import { PosthogCodeVariablesResultV1Schema } from '../../../plugins/posthog/src/source/detail/codeVariablesContract';
import posthogEvents from '../../../plugins/posthog/src/api/__fixtures__/queryIssueEventsPage.json';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, 'Provider evidence fixture cleanup failed');
});

async function fixture(provider: 'sentry' | 'posthog') {
  const sentry = provider === 'sentry';
  const plugin = sentry ? SENTRY_PLUGIN : POSTHOG_PLUGIN;
  const origin = sentry ? 'https://errors.example.test' : 'https://eu.posthog.com';
  const purpose = sentry ? SENTRY_CONNECTED_ACCOUNT_PURPOSE : POSTHOG_CONNECTED_ACCOUNT_PURPOSE;
  const posthog = encodePosthogConfiguration({ v: 1, organizationUuid: '00000000-0000-4000-8000-0000000000a1',
    environments: [{ teamPathId: 4821, teamUuid: '00000000-0000-4000-8000-0000000000d1', parentProjectId: 4820, displayName: 'Production' }],
    scanWindowPolicy: { kind: 'exact', from: '2026-07-01T00:00:00.000Z', to: '2026-08-15T00:00:00.000Z' },
    detailWindowPolicy: { kind: 'relative', durationMs: 30 * 86_400_000 } });
  if (!posthog.ok) throw new Error('PostHog evidence fixture cannot encode');
  const instance = { v: 1 as const,
    instance: { source: { pluginId: plugin.manifest.id, localId: sentry ? 'sentry-issues' : 'posthog-error-tracking' }, sourceInstanceId: randomUUID() },
    binding: { purpose, account: { service: { pluginId: plugin.manifest.id, localId: sentry ? 'sentry-account' : POSTHOG_CONNECTED_ACCOUNT_PURPOSE }, accountId: 'evidence-account' } },
    localInstanceKey: sentry ? `${origin}${SENTRY_SCOPE_SEPARATOR}7701` : `posthog-org:${origin}:00000000-0000-4000-8000-0000000000a1`,
    configuration: { v: 1 as const, token: sentry ? encodeSentryInstanceConfiguration({ v: 1, organizationId: '7701', projectScope: { kind: 'all' }, environmentScope: { kind: 'all' } }) : posthog.token },
  };
  const localRef = { kindId: 'error-issue', entryId: sentry ? '1234' : '00000000-0000-4000-8000-000000000001',
    collisionScope: sentry ? `${origin}${SENTRY_SCOPE_SEPARATOR}7701` : `posthog:${origin}:00000000-0000-4000-8000-0000000000d1` };
  const replies: Array<{ status?: number; body: unknown }> = [];
  const requests: Array<{ url: URL; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ url: new URL(request.url ?? '/', origin), body: body ? JSON.parse(body) : null });
    const reply = replies.shift();
    response.writeHead(reply?.status ?? (reply ? 200 : 598), { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply?.body ?? {}));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider evidence fixture did not bind TCP');
  // Only genuine host account/HTTP boundaries are replaced. Projection and all
  // source admission, request geometry, result fitting and strict ABI stay real.
  const services = {
    connectedAccounts: {
      async listAccounts() { return { status: 'complete', accounts: [{ account: instance.binding.account, displayName: provider, state: 'connected', connectedAccountOrigins: [origin], connectedAccountBases: [origin] }] }; },
      async materializeListedAccount() { return { kind: 'httpHeaders', headers: { authorization: 'Bearer constructed-evidence-token' } }; },
    },
    http: createPluginHttpFixture({ async request(input, options) {
      const url = new URL(input.url);
      expect(url.origin).toBe(origin);
      const response = await fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, {
        method: input.method, headers: input.headers, signal: options?.signal, redirect: 'error',
        ...(input.body === undefined ? {} : { body: new TextDecoder().decode(input.body) }),
      });
      return { status: response.status, finalUrl: input.url, headers: Object.fromEntries(response.headers), body: new Uint8Array(await response.arrayBuffer()) };
    } }),
  } as unknown as PluginInvocationContext['services']; // Host boundary fixture exposes the services used by these Actions.
  const kit = await createPluginTestkit({ manifest: plugin.manifest,
    module: { activate: plugin.activate, activateAccount: sentry ? activateSentryAccount : activatePosthogAccount }, services });
  cleanup.push(() => kit.dispose());
  return { instance, localRef, replies, requests,
    invoke: (id: string, input: Readonly<Record<string, JsonValue>>) => kit.invokeAction(id, { v: 1, instance, localRef, ...input }, { surface: 'ui' }),
  };
}

it('states a missing self-hosted Sentry event operation without probing a version or fallback route', async () => {
  const h = await fixture('sentry');
  h.replies.push({ status: 405, body: { detail: 'Method not allowed' } });
  const result = SentryReadEventResultV1Schema.parse(await h.invoke(SENTRY_ACTION_IDS.readEvent, { selector: { kind: 'representative' } }));
  expect(h.requests.map(request => request.url.pathname)).toEqual(['/api/0/organizations/7701/issues/1234/events/recommended/']);
  expect(result).toMatchObject({ kind: 'unavailable', failure: { class: 'unsupportedContract', code: SENTRY_SELF_HOSTED_UNSUPPORTED_CODES.event } });
});

it('rereads the concrete recommended Sentry event and recursively withholds provider-annotated evidence', async () => {
  const h = await fixture('sentry');
  const eventId = 'a'.repeat(32);
  const event = { eventID: eventId, groupID: '1234', title: 'Safe event title',
    user: { email: 'scrubbed-email@example.test', name: 'malformed-meta-name' },
    entries: [{ type: 'exception', data: { values: [{ type: 'SafeException', value: 'scrubbed-exception-message',
      stacktrace: { frames: [{ filename: '/scrubbed/private/path.ts', function: 'safeFunction', lineNo: 42, vars: { secret: 'frame-variable-sentinel' } }] } }] } }],
    _meta: { user: { email: { '': { rem: [], err: ['scrubbed'] } }, name: { '': { unknown_annotation: true } } },
      entries: { '0': { data: { values: { '0': { value: { '': { rem: [['@secret', 's', 0, 10]] } },
        stacktrace: { frames: { '0': { filename: { '': { chunks: [{ type: 'redaction' }] } } } } } } } } } },
    },
  };
  h.replies.push({ body: event });
  const first = SentryReadEventResultV1Schema.parse(await h.invoke(SENTRY_ACTION_IDS.readEvent, { selector: { kind: 'representative' } }));
  expect(first).toMatchObject({ kind: 'event', projection: { eventId, title: 'Safe event title', sections: [{ kind: 'exception', type: 'SafeException', frames: [{ function: 'safeFunction', lineNo: 42 }] }] } });
  if (first.kind !== 'event' || first.projection.eventId === null) throw new Error('Recommended fixture must identify its exact event');
  const selector = { kind: 'event', eventId: first.projection.eventId };
  h.replies.push({ body: event });
  const exact = SentryReadEventResultV1Schema.parse(await h.invoke(SENTRY_ACTION_IDS.readEvent, { selector }));
  expect(exact).toEqual(first);
  for (const sentinel of ['scrubbed-email', 'malformed-meta-name', 'scrubbed-exception-message', '/scrubbed/private', 'frame-variable-sentinel', '@secret']) expect(JSON.stringify(exact)).not.toContain(sentinel);
  expect(first.projection.redactions).toEqual(expect.arrayContaining([
    { path: 'user.email', reason: 'providerScrubbed' }, { path: 'user.name', reason: 'providerScrubbed' },
    { path: 'entries[0].data.values[0].value', reason: 'providerScrubbed' },
    { path: 'entries[0].data.frames[0].filename', reason: 'providerScrubbed' },
  ]));
  h.replies.push({ body: { ...event, eventID: 'b'.repeat(32) } });
  expect(SentryReadEventResultV1Schema.parse(await h.invoke(SENTRY_ACTION_IDS.readEvent, { selector }))).toMatchObject({ kind: 'unavailable', failure: { class: 'unsupportedContract', code: SENTRY_FAILURE_CODES.responseUnparseable } });
  expect(h.requests.map(request => request.url.pathname)).toEqual([
    '/api/0/organizations/7701/issues/1234/events/recommended/',
    `/api/0/organizations/7701/issues/1234/events/${eventId}/`,
    `/api/0/organizations/7701/issues/1234/events/${eventId}/`,
  ]);
});

it('freezes PostHog sample query geometry and rereads only the selected offset and UUID for code variables', async () => {
  const h = await fixture('posthog');
  h.replies.push({ body: posthogEvents }, { body: { ...posthogEvents, hasMore: false, nextOffset: null, offset: 3 } });
  const first = PosthogSampledEventsResultV1Schema.parse(await h.invoke(POSTHOG_ACTION_IDS.issueEvents, { limit: 3 }));
  if (first.kind !== 'sampled' || !first.continuation || !first.frozenRequest) throw new Error('Sample fixture must publish its continuation and frozen query');
  const second = PosthogSampledEventsResultV1Schema.parse(await h.invoke(POSTHOG_ACTION_IDS.issueEvents, { limit: 3, continuation: first.continuation }));
  expect(second).toMatchObject({ kind: 'sampled' });
  expect(second).not.toHaveProperty('continuation');
  const [initialBody, nextBody] = h.requests.map(request => request.body);
  expect(initialBody).toMatchObject({ issueId: h.localRef.entryId, offset: 0, limit: 3, filterTestAccounts: false, onlyAppFrames: false });
  expect(nextBody).toEqual({ ...(initialBody as object), offset: 3 });
  const selected = first.events[1];
  if (!selected || selected.providerOffset === undefined) throw new Error('Sample fixture must identify the selected provider row');
  expect(selected).toMatchObject({ uuid: posthogEvents.results[1]?.uuid, providerOffset: 1 });
  const reread = { ...posthogEvents.results[1], properties: { privateSibling: 'reread-sibling-sentinel',
    $exception_list: [{ stacktrace: { frames: [{ function: 'selectedFunction', line: 42, privateSibling: 'frame-sibling-sentinel', code_variables: { selectedValue: 'explicitly-revealed-value' } }] } }] } };
  const envelope = { results: [reread], hasMore: false, offset: selected.providerOffset, limit: 1 };
  const input = { selectedUuid: selected.uuid, selectedOffset: selected.providerOffset, frozenRequest: first.frozenRequest };
  h.replies.push({ body: envelope });
  const revealed = PosthogCodeVariablesResultV1Schema.parse(await h.invoke(POSTHOG_ACTION_IDS.codeVariables, input));
  expect(revealed).toMatchObject({ kind: 'revealed' });
  if (revealed.kind !== 'revealed') throw new Error('Exact selected row must reveal the requested variables');
  expect(JSON.parse(revealed.variablesText)).toEqual([{ frame: { function: 'selectedFunction', line: 42 }, variables: { selectedValue: 'explicitly-revealed-value' } }]);
  expect(revealed.variablesText).not.toContain('sibling-sentinel');
  expect(h.requests[2]?.body).toEqual({ issueId: h.localRef.entryId,
    dateRange: { date_from: first.frozenRequest.from, date_to: first.frozenRequest.to },
    filterTestAccounts: false, onlyAppFrames: false, include: ['code_variables'], limit: 1, offset: 1 });
  h.replies.push({ body: { ...envelope, results: [{ ...reread, uuid: posthogEvents.results[0]?.uuid }] } });
  expect(PosthogCodeVariablesResultV1Schema.parse(await h.invoke(POSTHOG_ACTION_IDS.codeVariables, input))).toMatchObject({ kind: 'unavailable', failure: { class: 'unsupportedContract' } });
});
