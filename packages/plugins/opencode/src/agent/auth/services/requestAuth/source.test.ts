import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildConnectedAccountRequestAuthClientSource,
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/agents/request-auth';

import { buildOpenCodeRequestAuthPluginSource } from './source.js';

type RequestAuthTestState = {
  lookup: ReturnType<typeof vi.fn>;
  reportAuth: ReturnType<typeof vi.fn>;
  reportQuota: ReturnType<typeof vi.fn>;
};

type RequestAuthReporter = (
  input: Readonly<Record<string, unknown>>,
) => Promise<Readonly<{ status: string }>>;

declare global {
  // Test-only boundary consumed by the generated plugin fixture.
  // eslint-disable-next-line no-var
  var __happierOpenCodeRequestAuthTest: RequestAuthTestState | undefined;
}

const CLIENT_SOURCE = `
async function lookupConnectedAccountRequestAuth(input) {
  return globalThis.__happierOpenCodeRequestAuthTest.lookup(input);
}
async function reportConnectedAccountAuthFailure(input) {
  return globalThis.__happierOpenCodeRequestAuthTest.reportAuth(input);
}
async function reportConnectedAccountQuotaFailure(input) {
  return globalThis.__happierOpenCodeRequestAuthTest.reportQuota(input);
}
`;

async function loadWithOpenCodeV1_14_41PluginSemantics(path: string): Promise<Readonly<{
  exportNames: readonly string[];
  contributions: readonly unknown[];
}>> {
  const pluginModule = await import(`${pathToFileURL(path).href}?${Math.random()}`) as Readonly<
    Record<string, unknown>
  >;
  const seen = new Set<unknown>();
  const factories: Array<(input: unknown) => unknown> = [];
  for (const exported of Object.values(pluginModule)) {
    if (seen.has(exported)) continue;
    seen.add(exported);
    const factory = typeof exported === 'function'
      ? exported as (input: unknown) => unknown
      : exported !== null
        && typeof exported === 'object'
        && 'server' in exported
        && typeof exported.server === 'function'
        ? exported.server as (input: unknown) => unknown
        : null;
    if (!factory) throw new TypeError('Plugin export is not a function');
    factories.push(factory);
  }
  return Object.freeze({
    exportNames: Object.freeze(Object.keys(pluginModule)),
    contributions: Object.freeze(
      await Promise.all(factories.map(async (factory) => await factory(Object.freeze({})))),
    ),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.__happierOpenCodeRequestAuthTest;
});

describe('OpenCode request-auth plugin source', () => {
  it('loads the real generated asset through pinned OpenCode 1.14.41 export semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-loader-'));
    const path = join(root, 'plugin.mjs');
    await writeFile(path, buildOpenCodeRequestAuthPluginSource({
      provider: 'openai',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'openai-codex-model-request',
      },
      requestAuthClientSource: buildConnectedAccountRequestAuthClientSource({
        capabilityPathEnv: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
      }),
    }), 'utf8');

    const loaded = await loadWithOpenCodeV1_14_41PluginSemantics(path);

    expect(loaded.exportNames).toEqual(['default']);
    expect(loaded.contributions).toHaveLength(1);
    expect(loaded.contributions[0]).toMatchObject({
      auth: {
        provider: 'openai',
        methods: [],
        loader: expect.any(Function),
      },
    });
  });

  it('is actionful only for the exact provider marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-marker-'));
    const path = join(root, 'plugin.mjs');
    await writeFile(path, buildOpenCodeRequestAuthPluginSource({
      provider: 'openai',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'openai-codex-model-request',
      },
      requestAuthClientSource: CLIENT_SOURCE,
    }), 'utf8');
    const lookup = vi.fn();
    const reportAuth = vi.fn();
    const reportQuota = vi.fn();
    globalThis.__happierOpenCodeRequestAuthTest = { lookup, reportAuth, reportQuota };
    const upstream = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    for (const key of [
      'happier-request-auth:openai:1-stale',
      'prefix-happier-request-auth:openai:1',
      'happier-request-auth:anthropic:1',
    ]) {
      await expect(contribution.auth.loader(async () => ({
        type: 'api',
        key,
      }))).resolves.toEqual({});
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    expect(reportAuth).not.toHaveBeenCalled();
    expect(reportQuota).not.toHaveBeenCalled();
  });

  it.each([
    {
      provider: 'openai',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'openai-codex-model-request',
      },
      url: 'https://api.openai.com/v1/responses',
    },
    {
      provider: 'anthropic',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'anthropic-model-request',
      },
      url: 'http://api.anthropic.com/v1/messages',
    },
    {
      provider: 'openai',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'openai-codex-model-request',
      },
      url: 'https://credentials@chatgpt.com/backend-api/responses',
    },
  ])('rejects an unauthorized $provider request before lease lookup or upstream effect', async ({
    provider,
    purpose,
    url,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-origin-'));
    const path = join(root, 'plugin.mjs');
    await writeFile(path, buildOpenCodeRequestAuthPluginSource({
      provider,
      purpose,
      requestAuthClientSource: CLIENT_SOURCE,
    }), 'utf8');
    const lookup = vi.fn(async () => ({
      accessToken: 'must-not-leak',
      credentialContext: { credentialRevision: 'current-revision' },
    }));
    const reportAuth = vi.fn();
    const reportQuota = vi.fn();
    globalThis.__happierOpenCodeRequestAuthTest = { lookup, reportAuth, reportQuota };
    const upstream = vi.fn<typeof fetch>(async () => new Response('unexpected', { status: 200 }));
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: `happier-request-auth:${provider}:1`,
    }));

    await expect(loaded.fetch(url, {
      method: 'POST',
      body: JSON.stringify({ model: 'test', messages: [] }),
    })).rejects.toThrow('happier_opencode_request_auth_destination_mismatch');
    expect(lookup).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    expect(reportAuth).not.toHaveBeenCalled();
    expect(reportQuota).not.toHaveBeenCalled();
  });

  it.each([
    {
      provider: 'openai',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'openai-codex-model-request',
      },
      url: 'https://chatgpt.com/backend-api/responses',
    },
    {
      provider: 'anthropic',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'anthropic-model-request',
      },
      url: 'https://api.anthropic.com/v1/messages',
    },
  ])('authorizes an exact HTTPS $provider origin', async ({ provider, purpose, url }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-origin-'));
    const path = join(root, 'plugin.mjs');
    await writeFile(path, buildOpenCodeRequestAuthPluginSource({
      provider,
      purpose,
      requestAuthClientSource: CLIENT_SOURCE,
    }), 'utf8');
    const lookup = vi.fn(async () => ({
      accessToken: 'current-token',
      credentialContext: { credentialRevision: 'current-revision' },
    }));
    const reportAuth = vi.fn();
    const reportQuota = vi.fn();
    globalThis.__happierOpenCodeRequestAuthTest = { lookup, reportAuth, reportQuota };
    const upstream = vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: `happier-request-auth:${provider}:1`,
    }));
    const response = await loaded.fetch(url, {
      method: 'POST',
      body: JSON.stringify({ model: 'test', messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(lookup).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('rejects an off-origin redirect before it can cause a second credential-bearing request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-redirect-'));
    const path = join(root, 'plugin.mjs');
    await writeFile(path, buildOpenCodeRequestAuthPluginSource({
      provider: 'openai',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'openai-codex-model-request',
      },
      requestAuthClientSource: CLIENT_SOURCE,
    }), 'utf8');
    const lookup = vi.fn(async () => ({
      accessToken: 'current-token',
      credentialContext: { credentialRevision: 'current-revision' },
    }));
    const reportAuth = vi.fn();
    const reportQuota = vi.fn();
    globalThis.__happierOpenCodeRequestAuthTest = { lookup, reportAuth, reportQuota };
    const upstream = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 307,
      headers: { location: 'https://untrusted.example/v1/responses' },
    }));
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: 'happier-request-auth:openai:1',
    }));

    await expect(loaded.fetch('https://chatgpt.com/backend-api/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'test', input: [] }),
    })).rejects.toThrow('happier_opencode_request_auth_redirect_rejected');

    expect(lookup).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/codex/responses',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(upstream.mock.calls.some(([url]) => url === 'https://untrusted.example/v1/responses')).toBe(false);
    expect(reportAuth).not.toHaveBeenCalled();
    expect(reportQuota).not.toHaveBeenCalled();
  });

  it('cancels a retryable streaming 401 before one fresh replay of the reconstructible request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-'));
    const path = join(root, 'plugin.mjs');
    await writeFile(path, buildOpenCodeRequestAuthPluginSource({
      provider: 'openai',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'openai-codex-model-request',
      },
      requestAuthClientSource: CLIENT_SOURCE,
    }), 'utf8');
    const lookup = vi.fn()
      .mockResolvedValueOnce({
        accessToken: 'attempt-one',
        requiredHeaders: { 'ChatGPT-Account-Id': 'account-one' },
        credentialContext: { credentialRevision: 'revision-one' },
      })
      .mockResolvedValueOnce({
        accessToken: 'attempt-two',
        requiredHeaders: { 'ChatGPT-Account-Id': 'account-two' },
        credentialContext: { credentialRevision: 'revision-two' },
      });
    const reportAuth = vi.fn<RequestAuthReporter>(async () => ({ status: 'current_changed' }));
    const reportQuota = vi.fn(async () => ({ status: 'current_unchanged' }));
    globalThis.__happierOpenCodeRequestAuthTest = { lookup, reportAuth, reportQuota };
    const retryLifecycle: string[] = [];
    const firstResponse = new Response(new ReadableStream<Uint8Array>({
      async cancel() {
        await Promise.resolve();
        retryLifecycle.push('first-response-cancelled');
      },
    }), { status: 401 });
    let upstreamAttempt = 0;
    const upstream = vi.fn<typeof fetch>(async () => {
      upstreamAttempt += 1;
      retryLifecycle.push(`upstream-attempt-${upstreamAttempt}`);
      return upstreamAttempt === 1
        ? firstResponse
        : new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: 'happier-request-auth:openai:1',
    }));
    const response = await loaded.fetch('https://chatgpt.com/backend-api/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5', input: [] }),
    });

    expect(response.status).toBe(200);
    expect(retryLifecycle).toEqual([
      'upstream-attempt-1',
      'first-response-cancelled',
      'upstream-attempt-2',
    ]);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(reportAuth).toHaveBeenCalledOnce();
    expect(reportAuth.mock.calls[0]?.[0]).toMatchObject({
      credentialContext: { credentialRevision: 'revision-one' },
      normalizedFailure: {
        class: 'authentication',
        evidence: {
          httpStatus: 401,
          limitCategory: 'auth_invalid',
          quotaScope: 'unknown',
          evidenceSource: { kind: 'structured' },
        },
      },
    });
    const firstHeaders = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    const secondHeaders = new Headers(upstream.mock.calls[1]?.[1]?.headers);
    expect(firstHeaders.get('authorization')).toBe('Bearer attempt-one');
    expect(firstHeaders.get('chatgpt-account-id')).toBe('account-one');
    expect(secondHeaders.get('authorization')).toBe('Bearer attempt-two');
    expect(secondHeaders.get('chatgpt-account-id')).toBe('account-two');
  });

  it('removes stale Anthropic credential headers that are absent from the current lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-'));
    const path = join(root, 'plugin.mjs');
    await writeFile(path, buildOpenCodeRequestAuthPluginSource({
      provider: 'anthropic',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'anthropic-model-request',
      },
      requestAuthClientSource: CLIENT_SOURCE,
    }), 'utf8');
    const lookup = vi.fn(async () => ({
      accessToken: 'current-token',
      credentialContext: { credentialRevision: 'current-revision' },
    }));
    const reportAuth = vi.fn();
    const reportQuota = vi.fn();
    globalThis.__happierOpenCodeRequestAuthTest = { lookup, reportAuth, reportQuota };
    const upstream = vi.fn<typeof fetch>(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: 'happier-request-auth:anthropic:1',
    }));
    await loaded.fetch('https://api.anthropic.com/v1/messages', {
      headers: {
        authorization: 'Bearer stale-token',
        'chatgpt-account-id': 'stale-account-id',
        'x-api-key': 'stale-api-key',
        'x-claude-code-session-id': 'stale-session-id',
      },
    });

    const headers = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer current-token');
    expect(headers.get('chatgpt-account-id')).toBeNull();
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('x-claude-code-session-id')).toBeNull();
  });

  it('reports every exact 429 context but never exceeds one leaf-owned retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-'));
    const path = join(root, 'plugin.mjs');
    await writeFile(path, buildOpenCodeRequestAuthPluginSource({
      provider: 'anthropic',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'anthropic-model-request',
      },
      requestAuthClientSource: CLIENT_SOURCE,
    }), 'utf8');
    const lookup = vi.fn()
      .mockResolvedValueOnce({
        accessToken: 'attempt-one',
        credentialContext: { credentialRevision: 'revision-one' },
      })
      .mockResolvedValueOnce({
        accessToken: 'attempt-two',
        credentialContext: { credentialRevision: 'revision-two' },
      });
    const reportAuth = vi.fn(async () => ({ status: 'current_unchanged' }));
    const reportQuota = vi.fn<RequestAuthReporter>(async () => ({ status: 'current_changed' }));
    globalThis.__happierOpenCodeRequestAuthTest = { lookup, reportAuth, reportQuota };
    const upstream = vi.fn<typeof fetch>(async () => new Response('rate limited', { status: 429 }));
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: 'happier-request-auth:anthropic:1',
    }));
    const response = await loaded.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude', messages: [] }),
    });

    expect(response.status).toBe(429);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(reportQuota).toHaveBeenCalledTimes(2);
    expect(reportQuota.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        credentialContext: { credentialRevision: 'revision-one' },
        normalizedFailure: {
          class: 'quota',
          evidence: {
            httpStatus: 429,
            limitCategory: 'rate_limit',
            quotaScope: 'unknown',
            evidenceSource: { kind: 'structured' },
          },
        },
      }),
      expect.objectContaining({
        credentialContext: { credentialRevision: 'revision-two' },
      }),
    ]);
  });

  it('reports but does not retry when currentness is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-'));
    const path = join(root, 'plugin.mjs');
    await writeFile(path, buildOpenCodeRequestAuthPluginSource({
      provider: 'openai',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'openai-codex-model-request',
      },
      requestAuthClientSource: CLIENT_SOURCE,
    }), 'utf8');
    const lookup = vi.fn(async () => ({
      accessToken: 'current-token',
      credentialContext: { credentialRevision: 'current-revision' },
    }));
    const reportAuth = vi.fn(async () => ({ status: 'current_unchanged' }));
    const reportQuota = vi.fn(async () => ({ status: 'current_unchanged' }));
    globalThis.__happierOpenCodeRequestAuthTest = { lookup, reportAuth, reportQuota };
    const upstream = vi.fn<typeof fetch>(async () => new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: 'happier-request-auth:openai:1',
    }));
    const response = await loaded.fetch('https://chatgpt.com/backend-api/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5', input: [] }),
    });

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe('unauthorized');
    expect(lookup).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledOnce();
    expect(reportAuth).toHaveBeenCalledOnce();
  });

  it('reports but does not retry a body whose bytes cannot be reconstructed exactly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-'));
    const path = join(root, 'plugin.mjs');
    await writeFile(path, buildOpenCodeRequestAuthPluginSource({
      provider: 'openai',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'openai-codex-model-request',
      },
      requestAuthClientSource: CLIENT_SOURCE,
    }), 'utf8');
    const lookup = vi.fn(async () => ({
      accessToken: 'current-token',
      credentialContext: { credentialRevision: 'current-revision' },
    }));
    const reportAuth = vi.fn(async () => ({ status: 'current_changed' }));
    const reportQuota = vi.fn(async () => ({ status: 'current_unchanged' }));
    globalThis.__happierOpenCodeRequestAuthTest = { lookup, reportAuth, reportQuota };
    const upstream = vi.fn<typeof fetch>(async () => new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', upstream);
    const streamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('request'));
        controller.close();
      },
    });

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: 'happier-request-auth:openai:1',
    }));
    const response = await loaded.fetch('https://chatgpt.com/backend-api/responses', {
      method: 'POST',
      body: streamBody,
      duplex: 'half',
    });

    expect(response.status).toBe(401);
    expect(lookup).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledOnce();
    expect(reportAuth).toHaveBeenCalledOnce();
  });

  it('does not retry when cancellation arrives during recovery reporting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-'));
    const path = join(root, 'plugin.mjs');
    await writeFile(path, buildOpenCodeRequestAuthPluginSource({
      provider: 'openai',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'openai-codex-model-request',
      },
      requestAuthClientSource: CLIENT_SOURCE,
    }), 'utf8');
    const abortController = new AbortController();
    const lookup = vi.fn(async () => ({
      accessToken: 'current-token',
      credentialContext: { credentialRevision: 'current-revision' },
    }));
    const reportAuth = vi.fn(async () => {
      abortController.abort();
      return { status: 'current_changed' };
    });
    const reportQuota = vi.fn(async () => ({ status: 'current_unchanged' }));
    globalThis.__happierOpenCodeRequestAuthTest = { lookup, reportAuth, reportQuota };
    const upstream = vi.fn<typeof fetch>(async () => new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: 'happier-request-auth:openai:1',
    }));
    const response = await loaded.fetch('https://chatgpt.com/backend-api/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5', input: [] }),
      signal: abortController.signal,
    });

    expect(response.status).toBe(401);
    expect(abortController.signal.aborted).toBe(true);
    expect(lookup).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledOnce();
    expect(reportAuth).toHaveBeenCalledOnce();
  });

  it('passes through partial output failures without a hidden leaf retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-opencode-request-auth-'));
    const path = join(root, 'plugin.mjs');
    await writeFile(path, buildOpenCodeRequestAuthPluginSource({
      provider: 'openai',
      purpose: {
        consumer: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        purpose: 'openai-codex-model-request',
      },
      requestAuthClientSource: CLIENT_SOURCE,
    }), 'utf8');
    const lookup = vi.fn(async () => ({
      accessToken: 'current-token',
      credentialContext: { credentialRevision: 'current-revision' },
    }));
    const reportAuth = vi.fn(async () => ({ status: 'current_changed' }));
    const reportQuota = vi.fn(async () => ({ status: 'current_changed' }));
    globalThis.__happierOpenCodeRequestAuthTest = { lookup, reportAuth, reportQuota };
    let emitted = false;
    const upstream = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!emitted) {
          emitted = true;
          controller.enqueue(new TextEncoder().encode('partial output'));
          return;
        }
        controller.error(new Error('upstream disconnected after output'));
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: 'happier-request-auth:openai:1',
    }));
    const response = await loaded.fetch('https://chatgpt.com/backend-api/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5', input: [] }),
    });
    const reader = response.body!.getReader();

    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: new TextEncoder().encode('partial output'),
    });
    await expect(reader.read()).rejects.toThrow('upstream disconnected after output');
    expect(lookup).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledOnce();
    expect(reportAuth).not.toHaveBeenCalled();
    expect(reportQuota).not.toHaveBeenCalled();
  });
});
