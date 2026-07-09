import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildBrokerBridgeCallSource } from './bridgeCallSource.js';

/**
 * The shared bridge-call source is provider-neutral JS embedded by connected-service broker artifacts.
 * We exercise it live by wrapping it in a tiny ESM module that exports the generated
 * `fetchAccessTokenFromBridge` so the same code path both runtimes embed is tested once, here.
 */
const SELECTIONS_ENV = 'TEST_BROKER_SELECTIONS';
const DAEMON_STATE_PATH_ENV = 'TEST_BROKER_DAEMON_STATE_PATH';
const REFRESH_TOKEN_ENV = 'TEST_BROKER_REFRESH_TOKEN';
const PLUGIN_VERSION_ENV = 'TEST_BROKER_VERSION';

async function loadBridgeCaller(params: Readonly<{
  selectionKey: string;
  bridgePath: string;
  serviceId: string;
  planTypeBodyKey?: string | null;
  resultAccountIdKeys?: readonly string[];
  selectionIdentityEnv?: string | null;
}>): Promise<
  (forceRefresh: boolean) => Promise<{ accessToken: string; accountId: string | null; expiresAt: number | null }>
> {
  const source = buildBrokerBridgeCallSource({
    ...params,
    selectionsEnv: SELECTIONS_ENV,
    daemonStatePathEnv: DAEMON_STATE_PATH_ENV,
    refreshTokenEnv: REFRESH_TOKEN_ENV,
    pluginVersionEnv: PLUGIN_VERSION_ENV,
    pluginVersion: '7',
    sessionTag: 'test-broker',
  });
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-bridge-'));
  const file = join(dir, `bridge-${params.selectionKey}-${Math.random().toString(36).slice(2)}.mjs`);
  // Wrap the (statement) source so the embedded function becomes an ESM export we can call directly.
  // The shared source assumes the assembling module supplies `readFileSync` (its documented contract),
  // exactly as the OpenCode plugin + Pi extension preambles do; replicate that here.
  await writeFile(
    file,
    `import { readFileSync } from "node:fs";\n${source}\nexport { fetchAccessTokenFromBridge };\n`,
    'utf8',
  );
  const mod = await import(pathToFileURL(file).href);
  return mod.fetchAccessTokenFromBridge;
}

async function writeDaemonStateFile(token: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-bridge-daemon-'));
  const file = join(dir, 'daemon.state.json');
  await writeFile(file, JSON.stringify({ httpPort: 41999, controlToken: token }), 'utf8');
  return file;
}

describe('buildBrokerBridgeCallSource (shared bridge-call, exercised live)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env[SELECTIONS_ENV];
    delete process.env[DAEMON_STATE_PATH_ENV];
    delete process.env[REFRESH_TOKEN_ENV];
    delete process.env[PLUGIN_VERSION_ENV];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env[SELECTIONS_ENV];
    delete process.env[DAEMON_STATE_PATH_ENV];
    delete process.env[REFRESH_TOKEN_ENV];
    delete process.env[PLUGIN_VERSION_ENV];
  });

  it('reads httpPort from daemon-state, sends the SCOPED token, and POSTs the descriptor-defined body', async () => {
    process.env[DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile('master-MUST-NOT-LEAK');
    process.env[REFRESH_TOKEN_ENV] = 'scoped-broker-token';
    process.env[SELECTIONS_ENV] = JSON.stringify({
      alpha: { serviceId: 'service-alpha', profileId: 'profile-a', accountId: null, planType: 'pro' },
    });
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const reqInit = (init ?? {}) as RequestInit;
      calls.push({ url: String(input), headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
      return new Response(
        JSON.stringify({ ok: true, result: { accessToken: 'fresh-access', tenantAccountId: 'acct_7' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const fetchAccessTokenFromBridge = await loadBridgeCaller({
      selectionKey: 'alpha',
      bridgePath: '/connected-service-auth/service-alpha/token/refresh',
      serviceId: 'service-alpha',
      planTypeBodyKey: 'subscriptionPlan',
      resultAccountIdKeys: ['accountId', 'tenantAccountId'],
    });
    const result = await fetchAccessTokenFromBridge(false);

    expect(result.accessToken).toBe('fresh-access');
    expect(result.accountId).toBe('acct_7');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:41999/connected-service-auth/service-alpha/token/refresh');
    expect(calls[0].headers.get('x-happier-daemon-token')).toBe('scoped-broker-token');
    expect(calls[0].headers.get('x-happier-daemon-token')).not.toBe('master-MUST-NOT-LEAK');
    const body = JSON.parse(calls[0].body);
    expect(body).toMatchObject({
      selection: { kind: 'profile', serviceId: 'service-alpha', profileId: 'profile-a' },
      subscriptionPlan: 'pro',
      forceRefresh: false,
    });
    // The master control token must never appear on the wire.
    expect(calls[0].body).not.toContain('master-MUST-NOT-LEAK');
  });

  it('omits optional plan metadata when no descriptor body key is provided', async () => {
    process.env[DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile('tok');
    process.env[REFRESH_TOKEN_ENV] = 'scoped';
    process.env[SELECTIONS_ENV] = JSON.stringify({
      beta: { serviceId: 'service-beta', profileId: 'profile-b', accountId: null, planType: null },
    });
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')));
      expect(String(input)).toBe('http://127.0.0.1:41999/connected-service-auth/service-beta/token/refresh');
      return new Response(JSON.stringify({ ok: true, result: { accessToken: 'claude-access', expiresAt: 123456 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const fetchAccessTokenFromBridge = await loadBridgeCaller({
      selectionKey: 'beta',
      bridgePath: '/connected-service-auth/service-beta/token/refresh',
      serviceId: 'service-beta',
    });
    const result = await fetchAccessTokenFromBridge(true);
    expect(result.accessToken).toBe('claude-access');
    expect(result.expiresAt).toBe(123456);
    expect(bodies[0]).toMatchObject({
      selection: { kind: 'profile', serviceId: 'service-beta', profileId: 'profile-b' },
      forceRefresh: true,
    });
    expect(bodies[0]).not.toHaveProperty('subscriptionPlan');
  });

  it('throws a clear error when the scoped token is missing (fail-closed)', async () => {
    process.env[DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile('tok');
    process.env[SELECTIONS_ENV] = JSON.stringify({
      alpha: { serviceId: 'service-alpha', profileId: 'p', accountId: null, planType: null },
    });
    const fetchAccessTokenFromBridge = await loadBridgeCaller({
      selectionKey: 'alpha',
      bridgePath: '/connected-service-auth/service-alpha/token/refresh',
      serviceId: 'service-alpha',
    });
    await expect(fetchAccessTokenFromBridge(false)).rejects.toThrow(/scoped_token_missing/);
  });

  it('R3-6: sends the baked broker selection identity when a selectionIdentityEnv is configured', async () => {
    // The synthetic sessionId can never authorize against the daemon's tracked sessions; the broker's
    // genuine stable identity is the baked selection-identity env string. The emitted source must
    // forward it so the daemon can authorize against a LIVE runtime target carrying the same identity.
    const IDENTITY_ENV = 'TEST_BROKER_SELECTION_IDENTITY';
    process.env[DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile('tok');
    process.env[REFRESH_TOKEN_ENV] = 'scoped';
    process.env[SELECTIONS_ENV] = JSON.stringify({
      alpha: { serviceId: 'service-alpha', profileId: 'profile-a', accountId: null, planType: null },
    });
    process.env[IDENTITY_ENV] = 'test|connected|broker:7|alpha:profile-a:acct-1';
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')));
      return new Response(JSON.stringify({ ok: true, result: { accessToken: 'a' } }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const fetchAccessTokenFromBridge = await loadBridgeCaller({
        selectionKey: 'alpha',
        bridgePath: '/connected-service-auth/service-alpha/token/refresh',
        serviceId: 'service-alpha',
        selectionIdentityEnv: IDENTITY_ENV,
      });
      await fetchAccessTokenFromBridge(false);

      expect(bodies[0]).toMatchObject({
        selectionIdentity: 'test|connected|broker:7|alpha:profile-a:acct-1',
      });

      // Absent env value → the field is omitted (never an empty string).
      delete process.env[IDENTITY_ENV];
      await fetchAccessTokenFromBridge(false);
      expect(bodies[1]).not.toHaveProperty('selectionIdentity');

      // No selectionIdentityEnv configured → the field is omitted entirely.
      const withoutIdentity = await loadBridgeCaller({
        selectionKey: 'alpha',
        bridgePath: '/connected-service-auth/service-alpha/token/refresh',
        serviceId: 'service-alpha',
      });
      process.env[IDENTITY_ENV] = 'test|connected|broker:7|alpha:profile-a:acct-1';
      await withoutIdentity(false);
      expect(bodies[2]).not.toHaveProperty('selectionIdentity');
    } finally {
      delete process.env[IDENTITY_ENV];
    }
  });

  it('bounds the daemon bridge fetch with an abort/timeout signal (RR-7)', async () => {
    // A hung daemon must not hang the provider auth path forever: the emitted source has to attach a
    // bounded AbortSignal to the bridge fetch (guarded for runtimes lacking AbortSignal.timeout).
    process.env[DAEMON_STATE_PATH_ENV] = await writeDaemonStateFile('tok');
    process.env[REFRESH_TOKEN_ENV] = 'scoped';
    process.env[SELECTIONS_ENV] = JSON.stringify({
      alpha: { serviceId: 'service-alpha', profileId: 'p', accountId: null, planType: null },
    });
    const signals: Array<AbortSignal | undefined> = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init: unknown) => {
      signals.push((init as RequestInit | undefined)?.signal ?? undefined);
      return new Response(JSON.stringify({ ok: true, result: { accessToken: 'a' } }), { status: 200 });
    }) as unknown as typeof fetch;

    const fetchAccessTokenFromBridge = await loadBridgeCaller({
      selectionKey: 'alpha',
      bridgePath: '/connected-service-auth/service-alpha/token/refresh',
      serviceId: 'service-alpha',
    });
    await fetchAccessTokenFromBridge(false);

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});
