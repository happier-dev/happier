import { describe, expect, it, vi } from 'vitest';

import { SENTRY_CLOUD_REGION_ORIGINS, SENTRY_FAILURE_CODES } from '../sentryContracts.js';

import {
  SENTRY_CLOUD_MODE_ID,
  SENTRY_CONFIRMED_ORIGIN_CREDENTIAL_KEY,
  SENTRY_SELF_HOSTED_MODE_ID,
  SENTRY_TOKEN_CREDENTIAL_KEY,
  sentryConnectedAccountRuntime,
} from './connectedAccountRuntime.js';

const ACCOUNT = Object.freeze({
  service: { pluginId: 'happier.sentry', localId: 'sentry-account' },
  accountId: 'account-1',
});

type ResponseStub = Readonly<{ status: number; body: string }>;

function jsonResponse(status: number, body: unknown): ResponseStub {
  return { status, body: JSON.stringify(body) };
}

const ONE_ORGANIZATION = jsonResponse(200, [{ id: '42', slug: 'acme' }]);

/**
 * A mutable configuration snapshot, because the whole point of these tests is
 * what happens when the persisted configuration changes *after* a connection was
 * confirmed. The store is a plain map so a promoted attempt credential and a
 * later read see exactly the same bytes the host would carry across.
 */
function createHarness(input: Readonly<{
  modeId: string;
  values: Readonly<Record<string, unknown>>;
  responses?: readonly ResponseStub[];
  credentials?: Readonly<Record<string, string>>;
}>) {
  const responses = [...(input.responses ?? [ONE_ORGANIZATION])];
  const request = vi.fn(async () => {
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next === undefined) throw new Error('Sentry test harness ran out of responses');
    return {
      status: next.status,
      finalUrl: 'https://example.invalid/',
      headers: {},
      body: new TextEncoder().encode(next.body),
    };
  });
  const stored = new Map<string, string>(Object.entries(input.credentials ?? {}));
  const configuration = {
    target: { kind: 'account' as const, account: ACCOUNT, modeId: input.modeId },
    revision: 'revision-1',
    values: { ...input.values },
    getSecret: async () => null,
  };
  const services = { http: { request } };
  const signal = new AbortController().signal;
  return {
    request,
    stored,
    configuration,
    /** Rewrites the persisted configuration without any reconnect attempt. */
    mutate(values: Readonly<Record<string, unknown>>): void {
      configuration.values = { ...values };
      configuration.revision = 'revision-2';
    },
    authenticationContext: {
      signal,
      services,
      service: ACCOUNT.service,
      attempt: { kind: 'connect' as const, attemptId: 'attempt-1' },
      configuration,
      attemptCredentials: {
        async get(key: string) { return stored.get(key) ?? null; },
        async set(key: string, value: string) { stored.set(key, value); },
        async delete(key: string) { stored.delete(key); },
      },
    },
    readContext: {
      signal,
      services,
      account: ACCOUNT,
      configuration,
      credentials: { async get(key: string) { return stored.get(key) ?? null; } },
    },
  };
}

function completeConnection(
  harness: ReturnType<typeof createHarness>,
  token = 'sentry-test-token',
) {
  const mode = sentryConnectedAccountRuntime.authentication.modes[
    harness.configuration.target.modeId
  ];
  if (mode?.kind !== 'manual') throw new Error('Expected a manual Sentry authentication mode');
  return mode.complete(
    { fields: { [SENTRY_TOKEN_CREDENTIAL_KEY]: token } },
    harness.authenticationContext as never,
  );
}

describe('Sentry connected-account runtime — Cloud region choice', () => {
  it('confirms a Cloud connection on the origin its closed region choice declares', async () => {
    const harness = createHarness({ modeId: SENTRY_CLOUD_MODE_ID, values: { region: 'de' } });

    const result = await completeConnection(harness);

    expect(result.status).toBe('connected');
    expect((harness.request.mock.calls[0]?.[0] as Readonly<{ url: string }>).url)
      .toBe(`${SENTRY_CLOUD_REGION_ORIGINS.de}/api/0/organizations/?per_page=1`);
    expect(harness.stored.get(SENTRY_CONFIRMED_ORIGIN_CREDENTIAL_KEY))
      .toBe(SENTRY_CLOUD_REGION_ORIGINS.de);
  });

  it('refuses a Cloud region outside the declared choice set without reaching the network', async () => {
    const harness = createHarness({
      modeId: SENTRY_CLOUD_MODE_ID,
      values: { region: 'https://evil.example.com' },
    });

    const result = await completeConnection(harness);

    expect(result).toMatchObject({
      status: 'rejected',
      diagnostic: { code: SENTRY_FAILURE_CODES.regionOriginUndeclared },
    });
    expect(harness.request).not.toHaveBeenCalled();
  });

  it('refuses a Cloud origin configured against the self-hosted mode', async () => {
    const harness = createHarness({
      modeId: SENTRY_SELF_HOSTED_MODE_ID,
      values: { origin: SENTRY_CLOUD_REGION_ORIGINS.us },
    });

    const result = await completeConnection(harness);

    expect(result).toMatchObject({
      status: 'rejected',
      diagnostic: { code: SENTRY_FAILURE_CODES.regionOriginUndeclared },
    });
    expect(harness.request).not.toHaveBeenCalled();
  });
});

describe('Sentry connected-account runtime — confirmation outcomes', () => {
  it('reports an unreadable 200 body as unparseable rather than as an empty organization list', async () => {
    const harness = createHarness({
      modeId: SENTRY_CLOUD_MODE_ID,
      values: { region: 'us' },
      responses: [{ status: 200, body: '{"detail":"not a list"}' }],
    });

    const result = await completeConnection(harness);

    expect(result).toMatchObject({
      status: 'rejected',
      diagnostic: { code: SENTRY_FAILURE_CODES.responseUnparseable },
    });
  });

  it('reports a 200 array whose rows carry no usable id as unparseable', async () => {
    const harness = createHarness({
      modeId: SENTRY_CLOUD_MODE_ID,
      values: { region: 'us' },
      responses: [jsonResponse(200, [{ slug: 'acme' }])],
    });

    const result = await completeConnection(harness);

    expect(result).toMatchObject({
      status: 'rejected',
      diagnostic: { code: SENTRY_FAILURE_CODES.responseUnparseable },
    });
  });

  it('reports a genuinely empty organization list as no accessible organizations', async () => {
    const harness = createHarness({
      modeId: SENTRY_CLOUD_MODE_ID,
      values: { region: 'us' },
      responses: [jsonResponse(200, [])],
    });

    const result = await completeConnection(harness);

    expect(result).toMatchObject({
      status: 'rejected',
      diagnostic: { code: SENTRY_FAILURE_CODES.noAccessibleOrganizations },
    });
  });
});

describe('Sentry connected-account runtime — confirmation binds the credential to one deployment', () => {
  it('materializes the bearer only for the deployment the connection confirmed', async () => {
    const harness = createHarness({ modeId: SENTRY_CLOUD_MODE_ID, values: { region: 'us' } });
    await completeConnection(harness);

    const materialized = await sentryConnectedAccountRuntime.materialize(
      {
        kind: 'httpHeaders',
        origin: SENTRY_CLOUD_REGION_ORIGINS.us,
        headerNames: ['authorization'],
      },
      harness.readContext as never,
    );

    expect(materialized).toEqual({
      kind: 'httpHeaders',
      headers: { Authorization: 'Bearer sentry-test-token' },
    });
  });

  it('refuses to materialize after the configured deployment changed without a reconnect', async () => {
    const harness = createHarness({ modeId: SENTRY_CLOUD_MODE_ID, values: { region: 'us' } });
    await completeConnection(harness);

    // The user edited the region. `changeBehavior: 'reconnect'` says this is a
    // new connection, not an update of this one — so the confirmed credential
    // must not reach the newly configured deployment before it is confirmed
    // there.
    harness.mutate({ region: 'de' });

    await expect(sentryConnectedAccountRuntime.materialize(
      {
        kind: 'httpHeaders',
        origin: SENTRY_CLOUD_REGION_ORIGINS.de,
        headerNames: ['authorization'],
      },
      harness.readContext as never,
    )).rejects.toThrow();
    expect(harness.request).toHaveBeenCalledTimes(1);
  });

  it('does not send the confirmed credential to a newly configured deployment while reading health', async () => {
    const harness = createHarness({ modeId: SENTRY_CLOUD_MODE_ID, values: { region: 'us' } });
    await completeConnection(harness);
    harness.mutate({ region: 'de' });

    const health = await sentryConnectedAccountRuntime.status(harness.readContext as never);

    expect(health).toMatchObject({
      status: 'reconnectRequired',
      diagnostic: { code: SENTRY_FAILURE_CODES.deploymentUnconfirmed },
    });
    // The confirmation GET from connect is the only request this token ever made.
    expect(harness.request).toHaveBeenCalledTimes(1);
  });

  it('refuses an account whose credentials were never bound to a confirmed deployment', async () => {
    const harness = createHarness({
      modeId: SENTRY_CLOUD_MODE_ID,
      values: { region: 'us' },
      credentials: { [SENTRY_TOKEN_CREDENTIAL_KEY]: 'sentry-test-token' },
    });

    await expect(sentryConnectedAccountRuntime.materialize(
      {
        kind: 'httpHeaders',
        origin: SENTRY_CLOUD_REGION_ORIGINS.us,
        headerNames: ['authorization'],
      },
      harness.readContext as never,
    )).rejects.toThrow();
  });
});
