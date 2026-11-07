import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageReadAttentionResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { activate, activateAccount } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import { encodeGithubTriageConfiguration } from './configuration.js';
import { GITHUB_PULL_REQUEST_RESPONSE, GITHUB_FIXTURE_REPOSITORY_ID } from './__fixtures__/githubResponses.js';
import { createStubGithubTransport, GITHUB_TEST_ACCOUNT, type StubHttpResponse } from './testkit/githubTriage.test-support.js';

function configuredInstance() {
  const fixture = createTriageSourceV1Fixture();
  const token = encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'account' } });
  if (token === null) throw new Error('Valid fixture configuration');
  return { ...fixture.configuredInstance,
    instance: { ...fixture.configuredInstance.instance, source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' } },
    binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT },
    configuration: { v: 1 as const, token },
  };
}

const reviewRequest = {
  reason: 'review_requested', repository: { id: GITHUB_FIXTURE_REPOSITORY_ID },
  subject: { type: 'PullRequest', url: 'https://api.github.com/repos/octo-org/example-app/pulls/1284' },
};

describe('registered GitHub attention feed', () => {
  it('follows the provider next page before conditionally returning to the feed head', async () => {
    const instance = configuredInstance();
    const nextUrl = 'https://api.github.com/notifications?all=true&per_page=50&page=2';
    const modified = 'Fri, 30 Oct 2026 19:00:00 GMT';
    const transport = createStubGithubTransport({ respond: request => ({
      status: 200, body: [], headers: { 'last-modified': modified, 'x-poll-interval': '90',
        ...(!new URL(request.url).searchParams.has('page') && request.headers['If-Modified-Since'] === undefined
          ? { link: `<${nextUrl}>; rel="next"` } : {}) },
    }) });
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      const invoke = async (cursor?: { v: 1; token: string }) => {
        const result = TriageReadAttentionResultV1Schema.parse(await kit.invokeAction('triage/read-github-attention',
          { v: 1, instance, ...(cursor === undefined ? {} : { cursor }) }, { surface: 'plugin' }));
        if (result.kind !== 'page') throw new Error('Provider page must be readable');
        return result;
      };
      const first = await invoke();
      expect(first.nextPage).toBe(true);
      const second = await invoke(first.cursor);
      expect(second).toMatchObject({ nextPage: false, pollIntervalMs: 90_000 });
      expect(transport.requests[1]).toMatchObject({ url: nextUrl });
      expect(transport.requests[1]?.headers['If-Modified-Since']).toBeUndefined();
      await invoke(second.cursor);
      expect(new URL(transport.requests[2]!.url).searchParams.get('since')).toBe('2026-10-30T19:00:00Z');
      expect(transport.requests[2]?.headers).toMatchObject({ 'If-Modified-Since': modified });
    } finally { await kit.dispose(); }
  });

  it('reads only changed threads after the retained watermark, including terminal changes', async () => {
    const instance = configuredInstance();
    const modified = 'Fri, 30 Oct 2026 19:00:00 GMT';
    let closed = false;
    const transport = createStubGithubTransport({ respond: request => {
      const url = new URL(request.url);
      if (url.pathname === '/notifications') return { status: 200, headers: { 'last-modified': modified },
        body: url.searchParams.get('since') === '2026-10-30T19:00:00Z' && !closed ? []
          : [{ ...reviewRequest, reason: closed ? 'state_change' : 'review_requested' }] };
      if (url.pathname === '/repos/octo-org/example-app/pulls/1284') return { status: 200,
        body: closed ? { ...GITHUB_PULL_REQUEST_RESPONSE, state: 'closed', merged: true } : GITHUB_PULL_REQUEST_RESPONSE };
      return undefined;
    } });
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      const invoke = async (cursor?: { v: 1; token: string }) => TriageReadAttentionResultV1Schema.parse(
        await kit.invokeAction('triage/read-github-attention', { v: 1, instance, ...(cursor ? { cursor } : {}) }, { surface: 'plugin' }));
      const first = await invoke();
      expect(first).toMatchObject({ kind: 'page', items: [{ resolved: false }] });
      if (first.kind !== 'page') throw new Error('Provider page must be readable');
      const before = transport.requests.length;
      const quiet = await invoke(first.cursor);
      expect(transport.requests.slice(before).filter(request => new URL(request.url).pathname.includes('/pulls/'))).toHaveLength(0);
      expect(transport.requests.slice(before)).toHaveLength(1);
      expect(quiet).toMatchObject({ kind: 'page', items: [] });
      closed = true;
      expect(await invoke(first.cursor)).toMatchObject({ kind: 'page', items: [{ resolved: true }] });
      expect(transport.requests.filter(request => new URL(request.url).pathname.includes('/pulls/'))).toHaveLength(2);
    } finally { await kit.dispose(); }
  });

  it('keeps the incremental filter and head watermark throughout provider pagination', async () => {
    const instance = configuredInstance();
    const initial = 'Fri, 30 Oct 2026 19:00:00 GMT';
    const updated = 'Fri, 30 Oct 2026 20:00:00 GMT';
    const later = 'Fri, 30 Oct 2026 21:00:00 GMT';
    const transport = createStubGithubTransport({ respond: request => {
      const url = new URL(request.url);
      const since = url.searchParams.get('since');
      const paging = url.searchParams.has('page');
      const next = new URL(url);
      next.searchParams.set('page', '2');
      return { status: 200, body: [], headers: {
        'last-modified': paging ? later : since ? updated : initial,
        ...(since === '2026-10-30T19:00:00Z' && !paging ? { link: `<${next}>; rel="next"` } : {}),
      } };
    } });
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      const invoke = async (cursor?: { v: 1; token: string }) => {
        const result = TriageReadAttentionResultV1Schema.parse(await kit.invokeAction('triage/read-github-attention',
          { v: 1, instance, ...(cursor ? { cursor } : {}) }, { surface: 'plugin' }));
        if (result.kind !== 'page') throw new Error('Provider page must be readable');
        return result;
      };
      const baseline = await invoke();
      const changed = await invoke(baseline.cursor);
      expect(changed.nextPage).toBe(true);
      const tail = await invoke(changed.cursor);
      expect(tail.nextPage).toBe(false);
      expect(new URL(transport.requests[2]!.url).searchParams.get('since')).toBe('2026-10-30T19:00:00Z');
      expect(transport.requests[2]?.headers['If-Modified-Since']).toBeUndefined();
      await invoke(tail.cursor);
      expect(new URL(transport.requests[3]!.url).searchParams.get('since')).toBe('2026-10-30T20:00:00Z');
      expect(transport.requests[3]?.headers['If-Modified-Since']).toBe(updated);
    } finally { await kit.dispose(); }
  });

  it('cancels the in-flight provider request without returning an acknowledged page', async () => {
    const instance = configuredInstance();
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let notifyStarted = () => {};
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const transport = createStubGithubTransport({ respond: (_request, options) => {
      requestSignal = options?.signal;
      notifyStarted();
      return new Promise<never>(() => {});
    } });
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      const pending = kit.invokeAction('triage/read-github-attention', { v: 1, instance },
        { surface: 'plugin', signal: controller.signal });
      const rejected = expect(pending).rejects.toMatchObject({ code: 'plugin_action_aborted' });
      await started;
      controller.abort(new Error('attention cancelled'));
      await rejected;
      expect(requestSignal?.aborted).toBe(true);
      expect(transport.requests).toHaveLength(1);
    } finally { controller.abort(); await kit.dispose(); }
  });

  it('preserves a failed exact read instead of advancing the conditional feed past an unseen review request', async () => {
    const instance = configuredInstance();
    let available = false;
    const transport = createStubGithubTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (path === '/notifications') return { status: 200, body: [reviewRequest],
        headers: { 'last-modified': 'Fri, 30 Oct 2026 19:00:00 GMT', 'x-poll-interval': '90' } };
      if (path === '/repos/octo-org/example-app/pulls/1284') return available
        ? { status: 200, body: GITHUB_PULL_REQUEST_RESPONSE }
        : { status: 503, body: { message: 'Unavailable' } };
      return undefined;
    } });
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      const invoke = () => kit.invokeAction('triage/read-github-attention', { v: 1, instance }, { surface: 'plugin' });
      expect(await invoke()).toMatchObject({ kind: 'failed', failure: { class: 'transient', code: 'github_server_error' } });
      available = true;
      expect(await invoke()).toMatchObject({ kind: 'page', items: [{ reason: 'reviewRequested', resolved: false }] });
      expect(transport.requests.filter(request => new URL(request.url).pathname === '/notifications')
        .every(request => request.headers['If-Modified-Since'] === undefined)).toBe(true);
    } finally { await kit.dispose(); }
  });

  it('reads review requests and terminal facts with conditional requests and the provider cadence', async () => {
    const instance = configuredInstance();
    let pass = 0;
    const transport = createStubGithubTransport({ respond: (request): StubHttpResponse | undefined => {
      const path = new URL(request.url).pathname;
      if (path === '/notifications') {
        pass += 1;
        return pass === 2 ? { status: 304, headers: { 'x-poll-interval': '90' } }
          : { status: 200, headers: { 'last-modified': 'Fri, 30 Oct 2026 19:00:00 GMT', 'x-poll-interval': '90' }, body: [{
            reason: pass === 3 ? 'state_change' : 'review_requested', repository: { id: GITHUB_FIXTURE_REPOSITORY_ID },
            subject: { type: 'PullRequest', url: 'https://api.github.com/repos/octo-org/example-app/pulls/1284' },
          }] };
      }
      if (path === '/repos/octo-org/example-app/pulls/1284') return { status: 200,
        body: pass === 3 ? { ...GITHUB_PULL_REQUEST_RESPONSE, state: 'closed', merged: true } : GITHUB_PULL_REQUEST_RESPONSE };
      return undefined;
    } });
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      const invoke = (cursor?: { v: 1; token: string }) => kit.invokeAction('triage/read-github-attention',
        { v: 1, instance, ...(cursor === undefined ? {} : { cursor }) }, { surface: 'plugin' });
      const first = TriageReadAttentionResultV1Schema.parse(await invoke());
      expect(first).toMatchObject({ kind: 'page', pollIntervalMs: 90_000,
        items: [{ reason: 'reviewRequested', resolved: false, localRef: { kindId: 'pull-request', entryId: '1284' } }] });
      if (first.kind !== 'page') throw new Error('Provider page must be readable');
      const cursor = first.cursor;
      expect(await invoke(cursor)).toMatchObject({ kind: 'page', items: [], pollIntervalMs: 90_000 });
      expect(transport.requests.filter(request => new URL(request.url).pathname === '/notifications')[1]?.headers)
        .toMatchObject({ 'If-Modified-Since': 'Fri, 30 Oct 2026 19:00:00 GMT' });
      expect(await invoke(cursor)).toMatchObject({ items: [{ reason: 'reviewRequested', resolved: true }] });
      expect(transport.requests.filter(request => new URL(request.url).pathname.endsWith('/pulls/1284'))).toHaveLength(2);
      expect(transport.requests.filter(request => new URL(request.url).pathname === '/notifications')
        .every(request => new URL(request.url).searchParams.get('all') === 'true')).toBe(true);
    } finally { await kit.dispose(); }
  });
});
