import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildOpenCodeRequestAuthPluginSource } from './source.js';

type RequestAuthTestState = {
  lookup: ReturnType<typeof vi.fn>;
  reportAuth: ReturnType<typeof vi.fn>;
  reportQuota: ReturnType<typeof vi.fn>;
};

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

afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.__happierOpenCodeRequestAuthTest;
});

describe('OpenCode request-auth plugin source', () => {
  it('reports an exact 401 and retries once with a fresh lookup while the JSON body is replayable', async () => {
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
    const reportAuth = vi.fn(async () => ({ status: 'current_changed' }));
    const reportQuota = vi.fn(async () => ({ status: 'current_unchanged' }));
    globalThis.__happierOpenCodeRequestAuthTest = { lookup, reportAuth, reportQuota };
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: 'happier-request-auth:openai:2',
    }));
    const response = await loaded.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5', input: [] }),
    });

    expect(response.status).toBe(200);
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
    const reportQuota = vi.fn(async () => ({ status: 'current_changed' }));
    globalThis.__happierOpenCodeRequestAuthTest = { lookup, reportAuth, reportQuota };
    const upstream = vi.fn(async () => new Response('rate limited', { status: 429 }));
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: 'happier-request-auth:anthropic:2',
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
    const upstream = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: 'happier-request-auth:openai:2',
    }));
    const response = await loaded.fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-5', input: [] }),
    });

    expect(response.status).toBe(401);
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
    const upstream = vi.fn(async () => new Response('unauthorized', { status: 401 }));
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
      key: 'happier-request-auth:openai:2',
    }));
    const response = await loaded.fetch('https://api.openai.com/v1/responses', {
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
    const upstream = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    vi.stubGlobal('fetch', upstream);

    const plugin = await import(`${pathToFileURL(path).href}?${Math.random()}`);
    const contribution = await plugin.default();
    const loaded = await contribution.auth.loader(async () => ({
      type: 'api',
      key: 'happier-request-auth:openai:2',
    }));
    const response = await loaded.fetch('https://api.openai.com/v1/responses', {
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
    const upstream = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
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
      key: 'happier-request-auth:openai:2',
    }));
    const response = await loaded.fetch('https://api.openai.com/v1/responses', {
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
