import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH,
} from '@happier-dev/plugin-sdk/experimental/cloud/broker';
import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '../../../runtime/server/managedServerState.js';

import {
  OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV,
  OPEN_CODE_BROKER_LOAD_NONCE_ENV,
  OPEN_CODE_BROKER_REFRESH_TOKEN_ENV,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  buildOpenCodeBrokerMarker,
  serializeOpenCodeBrokerSelections,
} from './env.js';
import { deriveOpenCodeBrokerRefreshToken } from './capabilityToken.js';
import { OPEN_CODE_BROKER_LOADED_PATH } from './loadHandshake.js';
import { buildOpenCodeBrokerPluginSource } from './source.js';

const REFRESH_TOKEN_SENTINEL = 'refresh-token-MUST-NOT-LEAK';
// The daemon master control token MUST NEVER reach the broker (F2 least privilege). The broker holds
// only the derived scoped token; the master is the secret the source must never read or transmit.
const MASTER_CONTROL_TOKEN_SENTINEL = 'daemon-master-control-token-MUST-NOT-LEAK';
const SCOPED_REFRESH_TOKEN = deriveOpenCodeBrokerRefreshToken(MASTER_CONTROL_TOKEN_SENTINEL);

type LoadedPlugin = {
  loader: (getAuth: () => Promise<unknown>) => Promise<Record<string, unknown>>;
  provider: string;
};

async function loadBrokerPlugin(provider: 'openai' | 'anthropic'): Promise<LoadedPlugin> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-plugin-'));
  const file = join(dir, `broker-${provider}-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(file, buildOpenCodeBrokerPluginSource(provider), 'utf8');
  const mod = await import(pathToFileURL(file).href);
  const factory = mod.default as () => Promise<{ auth: { provider: string; loader: LoadedPlugin['loader'] } }>;
  const hooks = await factory();
  return { loader: hooks.auth.loader, provider: hooks.auth.provider };
}

// The daemon-state file carries the MASTER control token (Happier's own daemon writes it). The broker
// reads ONLY `httpPort` from it and uses the SCOPED token from its env — never the master from the file.
async function writeDaemonStateFile(masterToken: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-daemon-'));
  const file = join(dir, 'daemon.state.json');
  await writeFile(file, JSON.stringify({ httpPort: 51999, controlToken: masterToken }), 'utf8');
  return file;
}

describe('openCode broker plugin source (generated artifact, exercised live)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env[OPEN_CODE_BROKER_SELECTIONS_ENV];
    delete process.env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV];
    delete process.env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV];
    delete process.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
    delete process.env[OPEN_CODE_BROKER_LOAD_NONCE_ENV];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env[OPEN_CODE_BROKER_SELECTIONS_ENV];
    delete process.env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV];
    delete process.env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV];
    delete process.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV];
    delete process.env[OPEN_CODE_BROKER_LOAD_NONCE_ENV];
  });

  it('engages only on the Happier broker marker, not on a real direct credential', async () => {
    const { loader, provider } = await loadBrokerPlugin('openai');
    expect(provider).toBe('openai');

    const directKey = await loader(async () => ({ type: 'api', key: 'sk-real-openai-key' }));
    expect(directKey).toEqual({});

    const marker = buildOpenCodeBrokerMarker('openai', '1');
    const brokered = await loader(async () => ({ type: 'api', key: marker }));
    expect(typeof brokered.fetch).toBe('function');
    expect(brokered.apiKey).toBe(marker);
  });

  it('Codex: fetches the access token from the daemon bridge and shapes the request (scoped token, no refresh token, no master)', async () => {
    process.env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile(MASTER_CONTROL_TOKEN_SENTINEL);
    process.env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV] = SCOPED_REFRESH_TOKEN;
    process.env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'codex-pro', accountId: null, planType: 'pro' },
    });

    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const url = String(input);
      const reqInit = (init ?? {}) as RequestInit;
      calls.push({ url, headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
      if (url.includes(CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH)) {
        return new Response(
          JSON.stringify({ ok: true, result: { accessToken: 'fresh-access-token', chatgptAccountId: 'acct_99', chatgptPlanType: 'pro' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const { loader } = await loadBrokerPlugin('openai');
    const result = await loader(async () => ({ type: 'api', key: buildOpenCodeBrokerMarker('openai', '1') }));
    // The loader pins the Codex backend base URL so the AI SDK builds <baseURL>/responses.
    expect(result.baseURL).toBe('https://chatgpt.com/backend-api');
    const brokeredFetch = result.fetch as (input: string, init: RequestInit) => Promise<Response>;

    await brokeredFetch('https://chatgpt.com/backend-api/responses', {
      method: 'POST',
      headers: { 'x-api-key': REFRESH_TOKEN_SENTINEL, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-codex', input: [] }),
    });

    const bridgeCall = calls.find((c) => c.url.includes(CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH));
    expect(bridgeCall).toBeDefined();
    expect(bridgeCall!.url).toBe('http://127.0.0.1:51999/connected-service-auth/broker/daemon-auth-bridge/refresh');
    // F2: the broker authenticates the bridge with the SCOPED token from its env, NOT the master.
    expect(bridgeCall!.headers.get('x-happier-daemon-token')).toBe(SCOPED_REFRESH_TOKEN);
    expect(bridgeCall!.headers.get('x-happier-daemon-token')).not.toBe(MASTER_CONTROL_TOKEN_SENTINEL);
    expect(JSON.parse(bridgeCall!.body)).toMatchObject({ selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'codex-pro' } });
    // F6: the cold cache-miss requests a conditional (non-forced) refresh — the daemon returns the
    // current access token if still valid, rotating only near-expiry.
    expect(JSON.parse(bridgeCall!.body).forceRefresh).toBe(false);

    const providerCall = calls.find((c) => c.url.includes('chatgpt.com/backend-api'));
    expect(providerCall).toBeDefined();
    expect(providerCall!.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(providerCall!.headers.get('authorization')).toBe('Bearer fresh-access-token');
    expect(providerCall!.headers.get('chatgpt-account-id')).toBe('acct_99');
    expect(providerCall!.headers.get('openai-beta')).toBe('responses=experimental');
    expect(providerCall!.headers.get('originator')).toBe('codex_cli_rs');
    expect(providerCall!.headers.get('x-api-key')).toBeNull();
    const providerBody = JSON.parse(providerCall!.body);
    expect(providerBody.model).toBe('gpt-5.1-codex');
    expect(providerBody.include).toContain('reasoning.encrypted_content');

    // No-leak: nothing the broker ever transmits contains the refresh-token sentinel OR the master
    // control token (F2: the broker holds only the scoped token; the master never reaches it).
    for (const call of calls) {
      expect(call.body).not.toContain(REFRESH_TOKEN_SENTINEL);
      expect(call.body).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
      for (const [, value] of call.headers.entries()) {
        expect(value).not.toContain(REFRESH_TOKEN_SENTINEL);
        expect(value).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
      }
    }
  });

  it('Codex: on a 401 it forces one bridge refresh and retries', async () => {
    process.env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile(MASTER_CONTROL_TOKEN_SENTINEL);
    process.env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV] = SCOPED_REFRESH_TOKEN;
    process.env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'p', accountId: 'a', planType: null },
    });
    let bridgeCalls = 0;
    let providerCalls = 0;
    const bridgeBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const url = String(input);
      if (url.includes(CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH)) {
        bridgeCalls += 1;
        const reqInit = (init ?? {}) as RequestInit;
        bridgeBodies.push(JSON.parse(String(reqInit.body ?? '{}')) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, result: { accessToken: `access-${bridgeCalls}`, chatgptAccountId: 'a' } }), { status: 200 });
      }
      providerCalls += 1;
      return new Response('x', { status: providerCalls === 1 ? 401 : 200 });
    }) as unknown as typeof fetch;

    const { loader } = await loadBrokerPlugin('openai');
    const result = await loader(async () => ({ type: 'api', key: buildOpenCodeBrokerMarker('openai', '1') }));
    const brokeredFetch = result.fetch as (input: string, init: RequestInit) => Promise<Response>;
    const response = await brokeredFetch('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' });

    expect(response.status).toBe(200);
    expect(bridgeCalls).toBe(2);
    expect(providerCalls).toBe(2);
    // F6: the cold cache-miss is conditional (forceRefresh:false); the 401-retry forces a rotation.
    expect(bridgeBodies[0]?.forceRefresh).toBe(false);
    expect(bridgeBodies[1]?.forceRefresh).toBe(true);
  });

  it('Anthropic: uses Bearer + anthropic-beta, deletes x-api-key, and injects the Claude Code system identity', async () => {
    process.env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile(MASTER_CONTROL_TOKEN_SENTINEL);
    process.env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV] = SCOPED_REFRESH_TOKEN;
    process.env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections({
      anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
    });
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const url = String(input);
      const reqInit = (init ?? {}) as RequestInit;
      calls.push({ url, headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
      if (url.includes(CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH)) {
        return new Response(JSON.stringify({ ok: true, result: { accessToken: 'claude-access', expiresAt: Date.now() + 3_600_000 } }), { status: 200 });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const { loader, provider } = await loadBrokerPlugin('anthropic');
    expect(provider).toBe('anthropic');
    const result = await loader(async () => ({ type: 'api', key: buildOpenCodeBrokerMarker('anthropic', '1') }));
    const brokeredFetch = result.fetch as (input: string, init: RequestInit) => Promise<Response>;

    await brokeredFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': REFRESH_TOKEN_SENTINEL },
      body: JSON.stringify({ model: 'claude-x', system: 'Be helpful', messages: [] }),
    });

    const providerCall = calls.find((c) => c.url.includes('api.anthropic.com'));
    expect(providerCall).toBeDefined();
    expect(providerCall!.headers.get('authorization')).toBe('Bearer claude-access');
    expect(providerCall!.headers.get('anthropic-beta')).toContain('oauth-2025-04-20');
    expect(providerCall!.headers.get('x-api-key')).toBeNull();
    const body = JSON.parse(providerCall!.body);
    const firstSystem = Array.isArray(body.system) ? body.system[0] : body.system;
    expect(firstSystem.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    for (const call of calls) expect(call.body).not.toContain(REFRESH_TOKEN_SENTINEL);
  });

  it('F4: on activation fires a best-effort load handshake to the daemon with the scoped token + selection identity', async () => {
    const identity = 'opencode|connected|broker:1|openai-codex:codex-pro:';
    process.env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile(MASTER_CONTROL_TOKEN_SENTINEL);
    process.env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV] = SCOPED_REFRESH_TOKEN;
    process.env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV] = identity;
    process.env[OPEN_CODE_BROKER_LOAD_NONCE_ENV] = 'opencode-spawn-1';

    const handshakeCalls: Array<{ url: string; headers: Headers; body: string }> = [];
    let resolveHandshake: () => void = () => {};
    const handshakeFired = new Promise<void>((resolve) => { resolveHandshake = resolve; });
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const url = String(input);
      const reqInit = (init ?? {}) as RequestInit;
      if (url.includes(OPEN_CODE_BROKER_LOADED_PATH)) {
        handshakeCalls.push({ url, headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
        resolveHandshake();
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    // Loading the plugin invokes the factory, which fires the fire-and-forget handshake.
    await loadBrokerPlugin('openai');
    await handshakeFired;

    expect(handshakeCalls).toHaveLength(1);
    const call = handshakeCalls[0]!;
    expect(call.url).toBe(`http://127.0.0.1:51999${OPEN_CODE_BROKER_LOADED_PATH}`);
    // F2 lockstep: the handshake authenticates with the SCOPED token, never the master.
    expect(call.headers.get('x-happier-daemon-token')).toBe(SCOPED_REFRESH_TOKEN);
    expect(call.headers.get('x-happier-daemon-token')).not.toBe(MASTER_CONTROL_TOKEN_SENTINEL);
    const parsed = JSON.parse(call.body);
    expect(parsed.selectionIdentity).toBe(identity);
    expect(parsed.loadNonce).toBe('opencode-spawn-1');
    expect(parsed.provider).toBe('openai');
    expect(call.body).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
  });

  it('F4: does not fire a load handshake when there is no selection identity (native / direct-key)', async () => {
    process.env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile(MASTER_CONTROL_TOKEN_SENTINEL);
    process.env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV] = SCOPED_REFRESH_TOKEN;
    // No OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV set.
    let handshakeCalls = 0;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      if (String(input).includes(OPEN_CODE_BROKER_LOADED_PATH)) handshakeCalls += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await loadBrokerPlugin('openai');
    // Give any (incorrect) fire-and-forget a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handshakeCalls).toBe(0);
  });
});
