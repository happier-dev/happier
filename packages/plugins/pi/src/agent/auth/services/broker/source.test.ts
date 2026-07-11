import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH,
} from '@happier-dev/plugin-sdk/experimental/cloud/broker';
import {
  PI_BROKER_DAEMON_STATE_PATH_ENV,
  PI_BROKER_LOAD_NONCE_ENV,
  PI_BROKER_REFRESH_TOKEN_PATH_ENV,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  buildPiBrokerExtensionSource,
  isPiBrokerMarker,
  serializePiBrokerSelections,
} from './index.js';

const REFRESH_TOKEN_SENTINEL = 'provider-refresh-token-MUST-NOT-LEAK';
const MASTER_CONTROL_TOKEN_SENTINEL = 'master-control-token-MUST-NOT-LEAK';

type PiOauthOverride = {
  name: string;
  login: () => Promise<unknown>;
  refreshToken: (cred: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getApiKey: (cred: Record<string, unknown>) => string;
};
type RegisteredProvider = { name: string; config: { oauth?: PiOauthOverride } };

/**
 * Load the generated Pi broker extension as a real ESM module and invoke its default factory with a
 * stub `pi` whose `registerProvider` captures the OAuth overrides — the same surface Pi's extension
 * runtime exposes. This exercises the actual code the Pi binary loads.
 */
async function loadPiBrokerExtension(): Promise<{ registered: RegisteredProvider[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-pi-broker-ext-'));
  const file = join(dir, `ext-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(file, buildPiBrokerExtensionSource(), 'utf8');
  const mod = await import(pathToFileURL(file).href);
  const factory = mod.default as (pi: { registerProvider: (name: string, config: { oauth?: PiOauthOverride }) => void }) => Promise<void>;
  const registered: RegisteredProvider[] = [];
  await factory({ registerProvider: (name, config) => registered.push({ name, config }) });
  return { registered };
}

async function writeDaemonStateFile(token: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-pi-broker-daemon-'));
  const file = join(dir, 'daemon.state.json');
  await writeFile(file, JSON.stringify({ httpPort: 52777, controlToken: token }), 'utf8');
  return file;
}

async function setCapabilityToken(token: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-pi-broker-capability-'));
  const path = join(dir, 'capability.json');
  await writeFile(path, JSON.stringify({
    v: 1,
    materializationId: 'mat-pi',
    selectionIdentityDigest: 'selection-digest',
    capability: token,
  }), { mode: 0o600 });
  process.env[PI_BROKER_REFRESH_TOKEN_PATH_ENV] = path;
}

describe('buildPiBrokerExtensionSource (generated artifact, exercised live)', () => {
  const originalFetch = globalThis.fetch;

  const clearEnv = () => {
    delete process.env[PI_BROKER_SELECTIONS_ENV];
    delete process.env[PI_BROKER_DAEMON_STATE_PATH_ENV];
    delete process.env[PI_BROKER_REFRESH_TOKEN_PATH_ENV];
    delete process.env[PI_BROKER_SELECTION_IDENTITY_ENV];
    delete process.env[PI_BROKER_LOAD_NONCE_ENV];
  };

  beforeEach(clearEnv);
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearEnv();
  });

  it('embeds only the file-path capability contract, never the raw-token env contract', () => {
    const source = buildPiBrokerExtensionSource();
    expect(source).toContain('HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN_PATH');
    expect(source).not.toContain('HAPPIER_CONNECTED_SERVICE_BROKER_REFRESH_TOKEN"');
  });

  it('registers an OAuth override ONLY for brokered providers present in the selections env', async () => {
    process.env[PI_BROKER_SELECTIONS_ENV] = serializePiBrokerSelections({
      anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
    });
    const { registered } = await loadPiBrokerExtension();
    expect(registered.map((r) => r.name)).toEqual(['anthropic']);
    expect(typeof registered[0].config.oauth?.refreshToken).toBe('function');
    expect(typeof registered[0].config.oauth?.getApiKey).toBe('function');
  });

  it('registers both providers under their Pi provider ids when both are selected', async () => {
    process.env[PI_BROKER_SELECTIONS_ENV] = serializePiBrokerSelections({
      anthropic: { serviceId: 'claude-subscription', profileId: 'c', accountId: null, planType: null },
      openai: { serviceId: 'openai-codex', profileId: 'x', accountId: null, planType: 'pro' },
    });
    const { registered } = await loadPiBrokerExtension();
    // Registered under Pi's provider ids (openai bridge tag ⇒ openai-codex provider).
    expect(registered.map((r) => r.name).sort()).toEqual(['anthropic', 'openai-codex']);
  });

  it('Claude: refreshToken brokers the access token with the SCOPED token, returns a marker refresh (no leak)', async () => {
    process.env[PI_BROKER_DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile(MASTER_CONTROL_TOKEN_SENTINEL);
    await setCapabilityToken('random-independent-broker-capability');
    process.env[PI_BROKER_SELECTIONS_ENV] = serializePiBrokerSelections({
      anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
    });

    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const reqInit = (init ?? {}) as RequestInit;
      calls.push({ url: String(input), headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
      return new Response(
        JSON.stringify({ ok: true, result: { accessToken: 'fresh-claude-access', expiresAt: Date.now() + 3_600_000, accountId: 'acct_c' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const { registered } = await loadPiBrokerExtension();
    const oauth = registered.find((r) => r.name === 'anthropic')!.config.oauth!;
    // The stored cred carries the provider refresh token as a sentinel; the broker must NOT forward it.
    const next = await oauth.refreshToken({ refresh: REFRESH_TOKEN_SENTINEL, access: '', expires: 0 });

    expect(next.access).toBe('fresh-claude-access');
    expect(isPiBrokerMarker(next.refresh)).toBe(true);
    expect(next.refresh).not.toBe(REFRESH_TOKEN_SENTINEL);
    expect(typeof next.expires).toBe('number');
    expect(oauth.getApiKey(next)).toBe('fresh-claude-access');

    const bridgeCall = calls.find((c) => c.url.includes(CONNECTED_SERVICE_BROKER_DAEMON_AUTH_BRIDGE_REFRESH_PATH));
    expect(bridgeCall).toBeDefined();
    expect(bridgeCall!.url).toBe('http://127.0.0.1:52777/connected-service-auth/broker/daemon-auth-bridge/refresh');
    expect(bridgeCall!.headers.get('x-happier-daemon-token')).toBe('random-independent-broker-capability');
    expect(bridgeCall!.headers.get('x-happier-daemon-token')).not.toBe(MASTER_CONTROL_TOKEN_SENTINEL);
    expect(JSON.parse(bridgeCall!.body)).toMatchObject({
      selection: { kind: 'profile', serviceId: 'claude-subscription', profileId: 'claude-pro' },
      forceRefresh: false,
    });

    // No-leak: neither the provider refresh token nor the master control token appears anywhere.
    for (const call of calls) {
      expect(call.body).not.toContain(REFRESH_TOKEN_SENTINEL);
      expect(call.body).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
      for (const [, value] of call.headers.entries()) {
        expect(value).not.toContain(REFRESH_TOKEN_SENTINEL);
        expect(value).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
      }
    }
  });

  it('Codex: refreshToken targets the chatgpt bridge and forwards the plan type', async () => {
    process.env[PI_BROKER_DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile('tok');
    await setCapabilityToken('random-independent-broker-capability');
    process.env[PI_BROKER_SELECTIONS_ENV] = serializePiBrokerSelections({
      openai: { serviceId: 'openai-codex', profileId: 'codex-pro', accountId: 'acct_z', planType: 'pro' },
    });
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')));
      expect(String(input)).toBe('http://127.0.0.1:52777/connected-service-auth/broker/daemon-auth-bridge/refresh');
      return new Response(JSON.stringify({ ok: true, result: { accessToken: 'codex-access', chatgptAccountId: 'acct_z' } }), { status: 200 });
    }) as unknown as typeof fetch;

    const { registered } = await loadPiBrokerExtension();
    const oauth = registered.find((r) => r.name === 'openai-codex')!.config.oauth!;
    const next = await oauth.refreshToken({ refresh: 'x', access: '', expires: 0 });
    expect(next.access).toBe('codex-access');
    expect(bodies[0]).toMatchObject({
      selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'codex-pro' },
      chatgptPlanType: 'pro',
    });
  });

  it('login throws (the broker never logs in; login happens in Happier)', async () => {
    process.env[PI_BROKER_SELECTIONS_ENV] = serializePiBrokerSelections({
      anthropic: { serviceId: 'claude-subscription', profileId: 'c', accountId: null, planType: null },
    });
    const { registered } = await loadPiBrokerExtension();
    await expect(registered[0].config.oauth!.login()).rejects.toThrow(/login_unsupported/);
  });

  it('pings the SHARED daemon load-handshake endpoint with the scoped token on activation', async () => {
    process.env[PI_BROKER_DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile(MASTER_CONTROL_TOKEN_SENTINEL);
    await setCapabilityToken('random-independent-broker-capability');
    process.env[PI_BROKER_SELECTIONS_ENV] = serializePiBrokerSelections({
      anthropic: { serviceId: 'claude-subscription', profileId: 'claude-pro', accountId: null, planType: null },
    });
    process.env[PI_BROKER_SELECTION_IDENTITY_ENV] = 'pi|connected|broker:1|anthropic:claude-pro:';
    process.env[PI_BROKER_LOAD_NONCE_ENV] = 'pi-spawn-1';
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const reqInit = (init ?? {}) as RequestInit;
      calls.push({ url: String(input), headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await loadPiBrokerExtension();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const handshake = calls.find((c) => c.url.includes('/connected-service-auth/broker/loaded'));
    expect(handshake).toBeDefined();
    expect(handshake!.url).toBe('http://127.0.0.1:52777/connected-service-auth/broker/loaded');
    expect(handshake!.headers.get('x-happier-daemon-token')).toBe('random-independent-broker-capability');
    const body = JSON.parse(handshake!.body);
    expect(body.selectionIdentity).toBe('pi|connected|broker:1|anthropic:claude-pro:');
    expect(body.loadNonce).toBe('pi-spawn-1');
    // The handshake reports the bridge provider tag (anthropic), which the daemon schema accepts.
    expect(body.providers).toContain('anthropic');
    expect(handshake!.body).not.toContain(MASTER_CONTROL_TOKEN_SENTINEL);
  });
});
