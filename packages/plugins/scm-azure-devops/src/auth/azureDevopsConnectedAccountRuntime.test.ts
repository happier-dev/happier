import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  AZURE_DEVOPS_BASE_CONFIGURATION_FIELD,
  AZURE_DEVOPS_MANUAL_MODE_ID,
  azureDevopsConnectedAccountRuntime,
} from './azureDevopsConnectedAccountRuntime.js';

const SERVICES_BASE = 'https://dev.azure.com/acme';
const SERVICES_ORIGIN = 'https://dev.azure.com';
const SERVER_BASE = 'https://server.example/tfs/DefaultCollection';
const SERVER_ORIGIN = 'https://server.example';
const TOKEN = 'azure-devops-test-pat';
const CONNECTION_DATA = {
  authenticatedUser: {
    id: 'd6245f20-2af8-44f4-9451-8107cb2767db',
    providerDisplayName: 'Ada Lovelace',
  },
  deploymentType: 'hosted',
  instanceId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
};

const ACCOUNT = {
  service: { pluginId: 'happier.scm.forge.azure-devops', localId: 'azure-devops-account' },
  accountId: 'account-1',
};

/**
 * A partial host context: this runtime reads only the configured values and the credential store,
 * so the rest of the invocation surface is deliberately absent rather than fabricated. The `never`
 * cast at each call site is the harness boundary, not a production one.
 */
function createHarness(input: Readonly<{
  base?: string;
  credentials?: Readonly<Record<string, string>>;
  response?: Readonly<{ status: number; body: unknown }>;
}> = {}) {
  const stored = new Map<string, string>(Object.entries(input.credentials ?? {}));
  const requests: Array<Readonly<{ url: string; headers: Readonly<Record<string, string>> }>> = [];
  const configuration = {
    target: { kind: 'account' as const, account: ACCOUNT, modeId: AZURE_DEVOPS_MANUAL_MODE_ID },
    revision: 'revision-1',
    values: input.base === undefined
      ? {}
      : { [AZURE_DEVOPS_BASE_CONFIGURATION_FIELD]: input.base },
    getSecret: async () => null,
  };
  const signal = new AbortController().signal;
  const services = {
    http: {
      async request(request: Readonly<{
        url: string;
        headers: Readonly<Record<string, string>>;
      }>) {
        requests.push(request);
        const response = input.response ?? { status: 200, body: CONNECTION_DATA };
        return {
          status: response.status,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify(response.body)),
        };
      },
    },
  };
  return {
    stored,
    authenticationContext: {
      signal,
      service: ACCOUNT.service,
      attempt: { kind: 'connect' as const, attemptId: 'attempt-1' },
      configuration,
      attemptCredentials: {
        async get(key: string) { return stored.get(key) ?? null; },
        async set(key: string, value: string) { stored.set(key, value); },
        async delete(key: string) { stored.delete(key); },
      },
      services,
    },
    readContext: {
      signal,
      account: ACCOUNT,
      configuration,
      credentials: { async get(key: string) { return stored.get(key) ?? null; } },
      services,
    },
    requests,
  };
}

function manualMode() {
  const mode = azureDevopsConnectedAccountRuntime.authentication.modes[AZURE_DEVOPS_MANUAL_MODE_ID];
  if (mode?.kind !== 'manual') throw new Error('Expected the manual Azure DevOps mode');
  return mode;
}

describe('Azure DevOps connected-account runtime', () => {
  it('confirms the provider identity before persisting the attempted PAT', async () => {
    const harness = createHarness({ base: SERVICES_BASE });

    const result = await manualMode().complete(
      { fields: { token: TOKEN } },
      harness.authenticationContext as never,
    );

    expect(result.status).toBe('connected');
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.url).toBe(
      'https://dev.azure.com/acme/_apis/connectionData?api-version=7.1-preview.1',
    );
    expect(harness.requests[0]?.headers.Authorization).toBe(
      `Basic ${Buffer.from(`:${TOKEN}`, 'utf8').toString('base64')}`,
    );
    expect(harness.stored.get('token')).toBe(TOKEN);
    if (result.status !== 'connected') return;
    expect(result.providerIdentity?.accountId).toBe(CONNECTION_DATA.authenticatedUser.id);
  });

  it('rejects an invalid PAT without leaving it in the attempt credential store', async () => {
    const harness = createHarness({
      base: SERVICES_BASE,
      response: { status: 401, body: { message: 'Unauthorized' } },
    });

    const result = await manualMode().complete(
      { fields: { token: 'mistyped-token' } },
      harness.authenticationContext as never,
    );

    expect(result.status).toBe('rejected');
    expect(harness.stored.has('token')).toBe(false);
  });

  it('rejects a Server that cannot serve REST 7.1 before persisting its PAT', async () => {
    const harness = createHarness({
      base: SERVER_BASE,
      response: {
        status: 400,
        body: {
          message: 'The requested REST API version of 7.1 is out of range for this server.',
          typeKey: 'VssVersionNotSupportedException',
        },
      },
    });

    const result = await manualMode().complete(
      { fields: { token: TOKEN } },
      harness.authenticationContext as never,
    );

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.diagnostic.code).toBe('azure_devops_rest_version_unsupported');
    }
    expect(harness.stored.has('token')).toBe(false);
  });

  it('names the account by the configured deployment base, not by the shared service host', async () => {
    // Every Azure DevOps Services account lives on one host, so a host-only label would render
    // every organization identically in the account list.
    const cases: readonly (readonly [string, string])[] = [
      [SERVICES_BASE, 'dev.azure.com/acme'],
      [SERVER_BASE, 'server.example/tfs/DefaultCollection'],
      [SERVICES_ORIGIN, 'dev.azure.com'],
    ];

    for (const [base, expected] of cases) {
      const harness = createHarness({ base });
      const result = await manualMode().complete(
        { fields: { token: TOKEN } },
        harness.authenticationContext as never,
      );
      expect(result.status, base).toBe('connected');
      if (result.status !== 'connected') continue;
      expect(result.displayName, base).toBe(expected);
    }
  });

  it('rejects a connection whose configured deployment cannot be validated', async () => {
    const harness = createHarness({ base: 'not a url' });

    const result = await manualMode().complete(
      { fields: { token: TOKEN } },
      harness.authenticationContext as never,
    );

    expect(result.status).toBe('rejected');
    expect(harness.requests).toHaveLength(0);
    expect(harness.stored.has('token')).toBe(false);
  });

  it('materializes the personal access token for the bare origin the host admits', async () => {
    const harness = createHarness({ base: SERVER_BASE, credentials: { token: TOKEN } });

    const materialization = await azureDevopsConnectedAccountRuntime.materialize(
      { kind: 'httpHeaders', origin: SERVER_ORIGIN, headerNames: ['authorization'] },
      harness.readContext as never,
    );

    expect(materialization).toEqual({
      kind: 'httpHeaders',
      headers: { Authorization: `Basic ${Buffer.from(`:${TOKEN}`, 'utf8').toString('base64')}` },
    });
  });

  it('refuses to materialize for a path-bearing base, because a base routes and never authorizes', async () => {
    const harness = createHarness({ base: SERVER_BASE, credentials: { token: TOKEN } });

    await expect(azureDevopsConnectedAccountRuntime.materialize(
      { kind: 'httpHeaders', origin: SERVER_BASE, headerNames: ['authorization'] },
      harness.readContext as never,
    )).rejects.toThrow('cannot materialize credentials for this origin');
  });

  it('reports the account unavailable when the stored token is gone', async () => {
    const harness = createHarness({ base: SERVICES_BASE });

    const health = await azureDevopsConnectedAccountRuntime.status(harness.readContext as never);

    expect(health.status).toBe('unavailable');
  });

  it('reports a stored PAT reconnect-required when Azure no longer accepts it', async () => {
    const harness = createHarness({
      base: SERVICES_BASE,
      credentials: { token: TOKEN },
      response: { status: 401, body: { message: 'Unauthorized' } },
    });

    const health = await azureDevopsConnectedAccountRuntime.status(harness.readContext as never);

    expect(health.status).toBe('reconnectRequired');
    expect(harness.requests).toHaveLength(1);
  });
});
