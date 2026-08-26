import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS,
} from '@/api/connectedServices/serverApiTimeout';
import {
  CONNECTED_SERVICE_OAUTH_REFRESH_FETCH_TIMEOUT_MS,
} from '@/daemon/connectedServices/refresh/serviceRefreshers';

import {
  CONNECTED_SERVICE_BROKER_BRIDGE_FETCH_TIMEOUT_MS,
  buildBrokerBridgeCallSource,
} from './brokerBridgeCallSource';

/**
 * The shared bridge-call source is provider-agnostic JS embedded by BOTH the OpenCode plugin and the
 * Pi extension. We exercise it live by wrapping it in a tiny ESM module that exports the generated
 * `fetchAccessTokenFromBridge` so the same code path both runtimes embed is tested once, here.
 */
const SELECTIONS_ENV = 'TEST_BROKER_SELECTIONS';
const BROKER_STATE_PATH_ENV = 'TEST_BROKER_STATE_PATH';
const PLUGIN_VERSION_ENV = 'TEST_BROKER_VERSION';
const SELECTION_IDENTITY_ENV = 'TEST_BROKER_SELECTION_IDENTITY';

type BridgeFixture = Readonly<{
  providerTag: string;
  bridgePath: string;
  serviceId: string;
  planTypeBodyField?: string;
  accountIdResultFields?: readonly string[];
}>;

async function loadBridgeCaller(fixture: BridgeFixture): Promise<
  (forceRefresh: boolean) => Promise<{
    accessToken: string;
    accountId: string | null;
    expiresAt: number | null;
    selectionEpoch: number | null;
  }>
> {
  const source = buildBrokerBridgeCallSource({
    ...fixture,
    selectionsEnv: SELECTIONS_ENV,
    brokerStatePathEnv: BROKER_STATE_PATH_ENV,
    pluginVersionEnv: PLUGIN_VERSION_ENV,
    pluginVersion: '7',
    sessionTag: 'test-broker',
    selectionIdentityEnv: SELECTION_IDENTITY_ENV,
  });
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-bridge-'));
  const file = join(dir, `bridge-${fixture.providerTag}-${Math.random().toString(36).slice(2)}.mjs`);
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

async function writeBrokerStateFile(params: Readonly<{
  httpPort?: number;
  brokerRefreshToken?: string;
}> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-bridge-daemon-'));
  const file = join(dir, 'connected-service-broker.state.json');
  await writeFile(file, JSON.stringify({
    httpPort: params.httpPort ?? 41999,
    ...(params.brokerRefreshToken
      ? { connectedServiceBrokerRefreshToken: params.brokerRefreshToken }
      : {}),
  }), 'utf8');
  return file;
}

describe('brokerBridgeCallSource (shared bridge-call, exercised live)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete process.env[SELECTIONS_ENV];
    delete process.env[BROKER_STATE_PATH_ENV];
    delete process.env[PLUGIN_VERSION_ENV];
    delete process.env[SELECTION_IDENTITY_ENV];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    delete process.env[SELECTIONS_ENV];
    delete process.env[BROKER_STATE_PATH_ENV];
    delete process.env[PLUGIN_VERSION_ENV];
    delete process.env[SELECTION_IDENTITY_ENV];
  });

  it('keeps the outer bridge deadline above every reachable bounded auth wait', () => {
    expect(CONNECTED_SERVICE_OAUTH_REFRESH_FETCH_TIMEOUT_MS).toBe(120_000);
    expect(CONNECTED_SERVICE_BROKER_BRIDGE_FETCH_TIMEOUT_MS).toBeGreaterThan(
      MAX_CONNECTED_SERVICES_SERVER_API_TIMEOUT_MS
        + (2 * CONNECTED_SERVICE_OAUTH_REFRESH_FETCH_TIMEOUT_MS),
    );
  });

  it('reads one minimal broker descriptor, sends the SCOPED token, and POSTs caller-owned bridge metadata', async () => {
    process.env[BROKER_STATE_PATH_ENV] = await writeBrokerStateFile({
      brokerRefreshToken: 'scoped-broker-token',
    });
    const fixture = {
      providerTag: 'provider-a',
      bridgePath: '/connected-service-auth/service-a/access-token/refresh',
      serviceId: 'service-a',
      planTypeBodyField: 'planTypeHint',
      accountIdResultFields: ['providerAccountId'] as const,
    };
    process.env[SELECTIONS_ENV] = JSON.stringify({
      [fixture.providerTag]: { serviceId: fixture.serviceId, profileId: 'profile-a', accountId: null, planType: 'pro' },
    });
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      const reqInit = (init ?? {}) as RequestInit;
      calls.push({ url: String(input), headers: new Headers(reqInit.headers ?? {}), body: String(reqInit.body ?? '') });
      return new Response(
        JSON.stringify({ ok: true, result: { accessToken: 'fresh-access', providerAccountId: 'acct_7' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const fetchAccessTokenFromBridge = await loadBridgeCaller(fixture);
    const result = await fetchAccessTokenFromBridge(false);

    expect(result.accessToken).toBe('fresh-access');
    expect(result.accountId).toBe('acct_7');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://127.0.0.1:41999${fixture.bridgePath}`);
    expect(calls[0].headers.get('x-happier-daemon-token')).toBe('scoped-broker-token');
    expect(calls[0].headers.get('x-happier-daemon-token')).not.toBe('master-MUST-NOT-LEAK');
    const body = JSON.parse(calls[0].body);
    expect(body).toMatchObject({
      selection: { kind: 'profile', serviceId: fixture.serviceId, profileId: 'profile-a' },
      planTypeHint: 'pro',
      forceRefresh: false,
    });
    // The master control token must never appear on the wire.
    expect(calls[0].body).not.toContain('master-MUST-NOT-LEAK');
  });

  it('omits a plan hint unless the caller declares one and forwards forceRefresh', async () => {
    process.env[BROKER_STATE_PATH_ENV] = await writeBrokerStateFile({
      brokerRefreshToken: 'scoped',
    });
    const fixture = {
      providerTag: 'provider-b',
      bridgePath: '/connected-service-auth/service-b/access-token/refresh',
      serviceId: 'service-b',
    };
    process.env[SELECTIONS_ENV] = JSON.stringify({
      [fixture.providerTag]: { serviceId: fixture.serviceId, profileId: 'profile-b', accountId: null, planType: null },
    });
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')));
      expect(String(input)).toBe(`http://127.0.0.1:41999${fixture.bridgePath}`);
      return new Response(JSON.stringify({ ok: true, result: { accessToken: 'claude-access', expiresAt: 123456 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const fetchAccessTokenFromBridge = await loadBridgeCaller(fixture);
    const result = await fetchAccessTokenFromBridge(true);
    expect(result.accessToken).toBe('claude-access');
    expect(result.expiresAt).toBe(123456);
    expect(bodies[0]).toMatchObject({
      selection: { kind: 'profile', serviceId: fixture.serviceId, profileId: 'profile-b' },
      forceRefresh: true,
    });
    expect(bodies[0]).not.toHaveProperty('planTypeHint');
  });

  it('preserves group selections and sends the broker selection identity so the daemon can resolve the effective account', async () => {
    process.env[BROKER_STATE_PATH_ENV] = await writeBrokerStateFile({
      brokerRefreshToken: 'scoped',
    });
    process.env[SELECTION_IDENTITY_ENV] = 'opencode|connected|broker:1|openai-codex:stable-acct:';
    const fixture = {
      providerTag: 'provider-a',
      bridgePath: '/connected-service-auth/service-a/access-token/refresh',
      serviceId: 'service-a',
    };
    process.env[SELECTIONS_ENV] = JSON.stringify({
      [fixture.providerTag]: {
        kind: 'group',
        serviceId: fixture.serviceId,
        groupId: 'main',
        activeProfileId: 'profile-new',
        fallbackProfileId: 'profile-old',
        generation: 11,
        accountId: 'acct-new',
      },
    });
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init: unknown) => {
      bodies.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')));
      return new Response(JSON.stringify({
        ok: true,
        result: { accessToken: 'fresh-access', accountId: 'acct-new', selectionEpoch: 4 },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const fetchAccessTokenFromBridge = await loadBridgeCaller(fixture);
    const result = await fetchAccessTokenFromBridge(false);

    expect(result).toMatchObject({
      accessToken: 'fresh-access',
      accountId: 'acct-new',
      selectionEpoch: 4,
    });
    expect(bodies[0]).toMatchObject({
      selectionIdentity: 'opencode|connected|broker:1|openai-codex:stable-acct:',
      selection: {
        kind: 'group',
        serviceId: fixture.serviceId,
        groupId: 'main',
        activeProfileId: 'profile-new',
        fallbackProfileId: 'profile-old',
        generation: 11,
      },
      forceRefresh: false,
    });
    expect(JSON.stringify(bodies[0])).not.toContain('profile-old-refresh-token');
  });

  it('bounds the bridge fetch with an abort signal (RR-7: no unbounded wait in the provider auth path)', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    process.env[BROKER_STATE_PATH_ENV] = await writeBrokerStateFile({
      brokerRefreshToken: 'scoped-broker-token',
    });
    const fixture = {
      providerTag: 'provider-a',
      bridgePath: '/connected-service-auth/service-a/access-token/refresh',
      serviceId: 'service-a',
      accountIdResultFields: ['providerAccountId'] as const,
    };
    process.env[SELECTIONS_ENV] = JSON.stringify({
      [fixture.providerTag]: { serviceId: fixture.serviceId, profileId: 'profile-a', accountId: null, planType: null },
    });
    const signals: Array<unknown> = [];
    globalThis.fetch = vi.fn(async (_input: unknown, init: unknown) => {
      signals.push((init as RequestInit | undefined)?.signal ?? null);
      return new Response(
        JSON.stringify({ ok: true, result: { accessToken: 'fresh-access', providerAccountId: 'acct_7' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const fetchAccessTokenFromBridge = await loadBridgeCaller(fixture);
    await fetchAccessTokenFromBridge(false);

    // A hung daemon must not hang the provider's auth path forever: the bridge call carries a
    // timeout-bound AbortSignal by construction.
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(CONNECTED_SERVICE_BROKER_BRIDGE_FETCH_TIMEOUT_MS);
  });

  it('uses the replacement daemon port and scoped capability from the same current state snapshot', async () => {
    const brokerStatePath = await writeBrokerStateFile({
      httpPort: 41001,
      brokerRefreshToken: 'scoped-a',
    });
    process.env[BROKER_STATE_PATH_ENV] = brokerStatePath;
    const fixture = {
      providerTag: 'provider-a',
      bridgePath: '/connected-service-auth/service-a/access-token/refresh',
      serviceId: 'service-a',
    };
    process.env[SELECTIONS_ENV] = JSON.stringify({
      [fixture.providerTag]: { serviceId: fixture.serviceId, profileId: 'p', accountId: null, planType: null },
    });
    const calls: Array<{ url: string; token: string | null }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init: unknown) => {
      calls.push({
        url: String(input),
        token: new Headers((init as RequestInit | undefined)?.headers ?? {}).get('x-happier-daemon-token'),
      });
      return new Response(JSON.stringify({ ok: true, result: { accessToken: 'access' } }), { status: 200 });
    }) as unknown as typeof fetch;

    const fetchAccessTokenFromBridge = await loadBridgeCaller(fixture);
    await fetchAccessTokenFromBridge(false);

    await writeFile(brokerStatePath, JSON.stringify({
      httpPort: 41002,
      connectedServiceBrokerRefreshToken: 'scoped-b',
    }), 'utf8');
    await fetchAccessTokenFromBridge(false);

    expect(calls).toEqual([
      { url: `http://127.0.0.1:41001${fixture.bridgePath}`, token: 'scoped-a' },
      { url: `http://127.0.0.1:41002${fixture.bridgePath}`, token: 'scoped-b' },
    ]);
  });

  it('throws a clear error when the current broker state lacks the scoped token (fail-closed)', async () => {
    process.env[BROKER_STATE_PATH_ENV] = await writeBrokerStateFile();
    const fixture = {
      providerTag: 'provider-a',
      bridgePath: '/connected-service-auth/service-a/access-token/refresh',
      serviceId: 'service-a',
    };
    process.env[SELECTIONS_ENV] = JSON.stringify({
      [fixture.providerTag]: { serviceId: fixture.serviceId, profileId: 'p', accountId: null, planType: null },
    });
    const fetchAccessTokenFromBridge = await loadBridgeCaller(fixture);
    await expect(fetchAccessTokenFromBridge(false)).rejects.toThrow(/broker_state_incomplete/);
  });

  it.each([
    { label: 'a whitespace-only scoped token', httpPort: 41999, brokerRefreshToken: '   ' },
    { label: 'port zero', httpPort: 0, brokerRefreshToken: 'scoped' },
    { label: 'an out-of-range port', httpPort: 65_536, brokerRefreshToken: 'scoped' },
    { label: 'a fractional port', httpPort: 41_999.5, brokerRefreshToken: 'scoped' },
  ])('rejects $label in the atomic broker descriptor', async ({ httpPort, brokerRefreshToken }) => {
    process.env[BROKER_STATE_PATH_ENV] = await writeBrokerStateFile({
      httpPort,
      brokerRefreshToken,
    });
    const fixture = {
      providerTag: 'provider-a',
      bridgePath: '/connected-service-auth/service-a/access-token/refresh',
      serviceId: 'service-a',
    };
    process.env[SELECTIONS_ENV] = JSON.stringify({
      [fixture.providerTag]: {
        serviceId: fixture.serviceId,
        profileId: 'p',
        accountId: null,
        planType: null,
      },
    });
    const fetchAccessTokenFromBridge = await loadBridgeCaller(fixture);
    await expect(fetchAccessTokenFromBridge(false)).rejects.toThrow(/broker_state_incomplete/);
  });
});
