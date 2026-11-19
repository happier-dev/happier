// QB-26/27: registered GitHub source reads through a real HTTP boundary.
// This owner composition does not claim native Machine transport or mounted retention.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import type { JsonValue, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { TriageGetResultV1Schema, TriageScanResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { activate, activateAccount } from '../../../plugins/scm-github/src/activate';
import { PLUGIN_MANIFEST } from '../../../plugins/scm-github/src/manifest';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../../plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_RESPONSE_FAILURE_CODE } from '../../../plugins/scm-github/src/observations/githubResponseFailure';
import { GITHUB_TRIAGE_ACTION_IDS_V1, GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../../plugins/scm-github/src/triage/contribution';
import { encodeGithubTriageConfiguration } from '../../../plugins/scm-github/src/triage/configuration';
import { GithubIssueFactsResultV1Schema } from '../../../plugins/scm-github/src/triage/detail/contracts';
import {
  GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_REPOSITORY, GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_ISSUE_RESPONSE, GITHUB_REPOSITORY_RESPONSE, GITHUB_SEARCH_ISSUE_ITEM, githubSearchResponse,
} from '../../../plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { createStubGithubTransport, GITHUB_TEST_ACCOUNT, githubChecksBatchResponse } from '../../../plugins/scm-github/src/triage/testkit/githubTriage.test-support';

type Fault = Readonly<{ status?: number; malformed?: boolean; disconnect?: boolean; hold?: boolean }>;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, 'GitHub fault fixture cleanup failed');
});

async function githubFixture() {
  const repositoryKey = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();
  const token = encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey } });
  if (token === null) throw new Error('GitHub fixture configuration cannot encode');
  const instance = { v: 1 as const,
    instance: { source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }, sourceInstanceId: randomUUID() },
    binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT },
    localInstanceKey: 'github.com', configuration: { v: 1 as const, token },
  };
  const localRef = { kindId: 'issue', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`, entryId: '7' };
  const input = { v: 1, instance, localRef, lastKnownLocator: { v: 1, routingToken: repositoryKey } };
  const issue = { ...GITHUB_ISSUE_RESPONSE, repository: GITHUB_REPOSITORY_RESPONSE,
    repository_url: `https://api.github.com/repos/${repositoryKey}`,
    url: `https://api.github.com/repos/${repositoryKey}/issues/7`, html_url: `https://github.com/${repositoryKey}/issues/7` };
  const searchIssue = { ...GITHUB_SEARCH_ISSUE_ITEM, ...issue };
  let fault: Fault | undefined;
  let requestSeen: (() => void) | undefined;
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = new URL(request.url ?? '/', 'https://api.github.com');
    paths.push(`${url.pathname}${url.search}`);
    requestSeen?.();
    if (fault?.hold) return;
    if (fault?.disconnect) { request.socket.destroy(); return; }
    response.writeHead(fault?.status ?? 200, { 'content-type': 'application/json',
      ...(fault?.status === 429 ? { 'retry-after': '1' } : {}) });
    if (fault) { response.end(JSON.stringify(fault.malformed ? { invalid: true } : { message: 'Constructed GitHub fault' })); return; }
    const body = Buffer.concat(chunks);
    let result: unknown;
    if (url.pathname === '/search/issues') result = githubSearchResponse({ items: [searchIssue] });
    else if (url.pathname.endsWith('/issues/7')) result = issue;
    else if (url.pathname === `/repos/${repositoryKey}` || url.pathname === `/repositories/${GITHUB_FIXTURE_REPOSITORY_ID}`) result = GITHUB_REPOSITORY_RESPONSE;
    else if (url.pathname === '/graphql') {
      const query = JSON.parse(body.toString('utf8')) as { query: string };
      result = query.query.includes('isPinned viewerSubscription')
        ? { data: { repository: { databaseId: Number(GITHUB_FIXTURE_REPOSITORY_ID), issue: { isPinned: true, viewerSubscription: 'SUBSCRIBED' } } } }
        : githubChecksBatchResponse({ url: url.href, method: 'POST', headers: {}, redirect: 'manual', body }).body;
    } else result = { login: 'monalisa', id: 583233 };
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('GitHub fault fixture did not bind TCP');
  // Reuse the owning testkit's Connected Account boundary. Its HTTP responder
  // forwards to real loopback TCP; all source admission, mapping and classification run.
  const transport = createStubGithubTransport({ async respond(request, options) {
    const url = new URL(request.url);
    expect(url.origin).toBe('https://api.github.com');
    const response = await fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, {
      method: request.method, headers: request.headers, signal: options?.signal, redirect: 'manual',
      ...(request.body === undefined ? {} : { body: new TextDecoder().decode(request.body) }),
    });
    return { status: response.status, headers: Object.fromEntries(response.headers), rawBody: new Uint8Array(await response.arrayBuffer()) };
  } });
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: transport.context.services });
  cleanup.push(() => kit.dispose());
  const invoke = (id: string, value: JsonValue) => kit.invokeAction(id, value, { surface: 'ui' });
  const scanInput = { v: 1, instance, page: { kind: 'initial', limit: 64 } };
  const detailInput = { v: 1, instance, localRef, routingToken: repositoryKey };
  return { kit, input, scanInput, detailInput, localRef, transport, paths,
    setFault(value?: Fault) { fault = value; },
    get: () => invoke(GITHUB_TRIAGE_ACTION_IDS_V1.get, input),
    scan: () => invoke(GITHUB_TRIAGE_ACTION_IDS_V1.scan, scanInput),
    detail: () => invoke(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readIssueFacts, detailInput),
    nextRequest() { return new Promise<void>(resolve => { requestSeen = () => { requestSeen = undefined; resolve(); }; }); },
  };
}

it('keeps GitHub get faults unresolved and scan faults explicitly unhealthy, then recovers through registered Actions', async () => {
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const h = await githubFixture();
    expect(TriageGetResultV1Schema.parse(await h.get())).toMatchObject({ kind: 'present', localRef: h.localRef });
    expect(TriageScanResultV1Schema.parse(await h.scan())).toMatchObject({ kind: 'complete', evidence: { kind: 'walkFinished' } });
    for (const [fault, expected] of [
      [{ status: 401 }, { class: 'authentication', code: GITHUB_RESPONSE_FAILURE_CODE.unauthorized }],
      [{ status: 403 }, { class: 'permission', code: GITHUB_RESPONSE_FAILURE_CODE.forbidden }],
      [{ status: 429 }, { class: 'rateLimit', code: GITHUB_RESPONSE_FAILURE_CODE.rateLimited }],
      [{ status: 503 }, { class: 'transient', code: GITHUB_RESPONSE_FAILURE_CODE.serverError }],
      [{ status: 418 }, { class: 'unknown', code: 'github_status_418' }],
      [{ status: 404 }, { class: 'unknown', code: GITHUB_RESPONSE_FAILURE_CODE.notFound }],
      [{ malformed: true }, { class: 'unknown', code: 'route-body-mismatch' }],
      [{ disconnect: true }, { class: 'transient', code: 'github_request_failed' }],
    ] as const) {
      h.setFault(fault);
      expect(TriageGetResultV1Schema.parse(await h.get())).toMatchObject({ kind: 'unresolved', localRef: h.localRef, failure: expected });
      const scan = TriageScanResultV1Schema.parse(await h.scan());
      if ('status' in fault && fault.status === 429) {
        expect(scan).toMatchObject({ kind: 'failed', failure: { ...expected, retryNotBeforeMs: expect.any(Number) } });
        if (scan.kind !== 'failed' || scan.failure.retryNotBeforeMs === undefined) throw new Error('Expected the provider retry time');
        const requests = h.paths.length;
        h.setFault();
        expect(TriageGetResultV1Schema.parse(await h.get())).toMatchObject({ kind: 'unresolved', failure: expected });
        expect(h.paths).toHaveLength(requests);
        now = scan.failure.retryNotBeforeMs;
      } else {
        expect(scan).toMatchObject({ kind: 'complete', observations: [], evidence: { kind: 'partial', reason: 'lane-unresolved' } });
      }
      expect(scan).not.toHaveProperty('continuation');
      h.setFault();
      const recovered = TriageGetResultV1Schema.parse(await h.get());
      expect(recovered, JSON.stringify({ fault, recovered })).toMatchObject({ kind: 'present', localRef: h.localRef });
      expect(TriageScanResultV1Schema.parse(await h.scan())).toMatchObject({ kind: 'complete', evidence: { kind: 'walkFinished' } });
    }
  } finally {
    clock.mockRestore();
  }
});

it('propagates GitHub caller cancellation through registered scan, get and mounted issue facts, then admits a fresh read', async () => {
  const h = await githubFixture();
  expect(GithubIssueFactsResultV1Schema.parse(await h.detail())).toMatchObject({ kind: 'issueFacts', isPinned: true, viewerSubscription: 'SUBSCRIBED' });
  for (const [id, input, kind] of [
    [GITHUB_TRIAGE_ACTION_IDS_V1.scan, h.scanInput, 'failed'],
    [GITHUB_TRIAGE_ACTION_IDS_V1.get, h.input, 'unresolved'],
    [GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readIssueFacts, h.detailInput, 'unavailable'],
  ] as const) {
    const controller = new AbortController();
    h.setFault({ hold: true });
    const observed = h.nextRequest();
    const handler = h.kit.registration('actions', id);
    if (!handler) throw new Error(`Missing registered GitHub Action ${id}`);
    // The host RPC discards canceled replies; inspect the actual registered source
    // handler's classifier while preserving its real HTTP and account dependencies.
    const pending = handler(input, { ...h.transport.context, signal: controller.signal, surface: 'ui',
      requestId: randomUUID(), invokedAtMs: Date.now() } as PluginInvocationContext);
    await observed;
    controller.abort(new DOMException('Caller left the source', 'AbortError'));
    expect(await pending).toMatchObject({ kind, failure: { class: 'transient', code: 'github_request_cancelled' } });
    h.setFault();
    expect(TriageGetResultV1Schema.parse(await h.get())).toMatchObject({ kind: 'present', localRef: h.localRef });
    expect(GithubIssueFactsResultV1Schema.parse(await h.detail())).toMatchObject({ kind: 'issueFacts' });
  }
});
