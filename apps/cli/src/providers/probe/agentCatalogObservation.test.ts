import { describe, expect, it, vi } from 'vitest';

import { ProviderContributionV1Schema } from '@happier-dev/protocol';
import { ConnectedAccountRequestAuthError } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';

import {
  createProviderProbeHttpClient,
  ProviderProbeCancelledError,
  type ProviderProbeTransport,
} from './client';
import { createAgentProviderCatalogObservationService } from './agentCatalogObservation';
import { createProviderProbeScheduler } from './scheduler';

const consumer = { pluginId: 'happier.agent.claude', localId: 'claude' } as const;
const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' } as const;
const purpose = { consumer, purpose: 'model_upstream' } as const;
const use = {
  purpose,
  materialization: {
    kind: 'httpHeaders' as const,
    origin: 'https://api.anthropic.com',
    headerNames: ['authorization'],
  },
};
const provider = ProviderContributionV1Schema.parse({
  v: 1,
  id: 'anthropic',
  name: 'Anthropic',
  kind: 'frontier',
  endpointTemplates: [{
    id: 'anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    publicHeaders: { 'anthropic-version': '2023-06-01' },
    capabilities: {
      streaming: 'supported',
      toolRoundTrips: 'supported',
      statefulResponses: 'unknown',
      reasoningControls: 'supported',
    },
  }],
  credential: {
    kind: 'apiKey', slotId: 'apiKey', required: true,
    transports: [{
      id: 'anthropic-x-api-key', protocols: ['anthropic'], uses: ['probe'],
      destination: { kind: 'httpHeader', name: 'x-api-key', format: 'raw' },
    }],
  },
  catalog: {
    source: 'static+probe',
    manualModelPolicy: 'allowed',
    membershipPolicy: 'probe-authoritative',
    staticModels: [
      { id: 'curated', name: 'Curated name', description: 'Curated presentation' },
      { id: 'static-only', name: 'Static fallback' },
    ],
    probes: [{ endpointTemplateId: 'anthropic', path: '/v1/models?limit=1000', parser: 'anthropic-models' }],
  },
});

function response(status: number, models: readonly string[] = []) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ data: models.map((id) => ({ id, display_name: `API ${id}` })) })),
  };
}

function harness(
  transport: ProviderProbeTransport,
  options: Readonly<{ catalogSuccessTtlMs?: number }> = {},
) {
  let current = true;
  let selectedAccountId = 'selected-account';
  let revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
  let token = 'selected-account-token';
  const refreshAfterAuthFailure = vi.fn(async () => {
    token = 'refreshed-selected-account-token';
    revision = 'csr_1123456789ABCDEFGHJKMNPQRS';
    return { status: 'current_changed' as const };
  });
  const requestAuth = {
    lookupRequestAuth: vi.fn(async () => ({
      accessToken: token,
      credentialContext: {
        account: { service, accountId: selectedAccountId },
        credentialRevision: revision,
        failingAccessTokenFingerprint: `sha256:${'a'.repeat(64)}`,
      },
    })),
    refreshAfterAuthFailure,
  };
  const redacted: string[] = [];
  const observation = createAgentProviderCatalogObservationService({
    activatePurposeBindings: ({ subject, bindings }) => {
      const binding = bindings[0];
      if (binding?.target.kind === 'account') selectedAccountId = binding.target.account.accountId;
      return {
        subjectId: 'observation-subject',
        isCurrent: () => current && subject.isCurrent(),
        resolvePurposeBinding: () => binding ?? null,
        listPurposeBindings: () => bindings,
        dispose: () => {},
      };
    },
    requestAuth,
    createRedactionLease: () => ({
      add: (values: readonly string[]) => redacted.push(...values),
      close: () => { redacted.length = 0; },
    }),
    client: createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport,
    }),
    scheduler: createProviderProbeScheduler({ catalogSuccessTtlMs: options.catalogSuccessTtlMs ?? 0 }),
    now: (() => { let value = 10; return () => value += 1; })(),
  });
  return { observation, requestAuth, refreshAfterAuthFailure, redacted, setCurrent: (value: boolean) => { current = value; } };
}

function input(selection: 'selected-account' | 'other-account' = 'selected-account') {
  return {
    machineId: 'machine-1',
    operationId: `operation-${selection}`,
    consumer,
    purpose,
    binding: {
      purpose,
      target: { kind: 'account' as const, account: { service, accountId: selection } },
    },
    requestAuthUse: use,
    provider,
    trigger: 'manual_refresh' as const,
    isCurrent: () => true,
  };
}

describe('Agent Provider catalog observation', () => {
  it('uses only the selected account bearer and authoritative membership, including successful empty', async () => {
    const requests: Array<Readonly<Record<string, string>>> = [];
    let models = ['curated', 'api-only'];
    const h = harness(async (request) => {
      requests.push(request.headers);
      return response(200, models);
    });

    await expect(h.observation.observe(input())).resolves.toMatchObject({
      source: 'dynamic',
      models: [
        { id: 'api-only', name: 'API api-only' },
        { id: 'curated', name: 'Curated name', description: 'Curated presentation' },
      ],
    });
    expect(requests[0]).toMatchObject({ authorization: 'Bearer selected-account-token' });
    expect(requests[0]).not.toHaveProperty('x-api-key');
    expect(h.requestAuth.lookupRequestAuth).toHaveBeenCalledOnce();

    models = [];
    await expect(h.observation.observe(input())).resolves.toEqual({ source: 'dynamic', models: [], stale: false });
  });

  it('falls back static on cold failure and retains the bounded last-good observation after later failure', async () => {
    let status = 503;
    const h = harness(async () => response(status, ['curated']));
    await expect(h.observation.observe(input())).resolves.toMatchObject({
      source: 'static',
      models: expect.arrayContaining([{ id: 'static-only', name: 'Static fallback' }]),
    });
    status = 200;
    await expect(h.observation.observe(input())).resolves.toMatchObject({ source: 'dynamic', stale: false });
    status = 503;
    await expect(h.observation.observe(input())).resolves.toMatchObject({
      source: 'dynamic', stale: true, models: [{ id: 'curated', name: 'Curated name', description: 'Curated presentation' }],
    });
  });

  it('refreshes and retries exactly once for 401, but never for 403 or a second 401', async () => {
    const statuses = [401, 200];
    const h = harness(async () => response(statuses.shift() ?? 500, ['curated']));
    await expect(h.observation.observe(input())).resolves.toMatchObject({ source: 'dynamic' });
    expect(h.refreshAfterAuthFailure).toHaveBeenCalledOnce();
    expect(h.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(2);

    const forbidden = harness(async () => response(403));
    await forbidden.observation.observe(input());
    expect(forbidden.refreshAfterAuthFailure).not.toHaveBeenCalled();
    expect(forbidden.requestAuth.lookupRequestAuth).toHaveBeenCalledOnce();

    const repeated = harness(async () => response(401));
    await repeated.observation.observe(input());
    expect(repeated.refreshAfterAuthFailure).toHaveBeenCalledOnce();
    expect(repeated.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(2);
  });

  it('remembers a successful 401 recovery under the refreshed credential revision', async () => {
    const statuses = [401, 200, 503];
    const h = harness(async () => response(statuses.shift() ?? 503, ['curated']));

    await expect(h.observation.observe(input())).resolves.toMatchObject({ source: 'dynamic', stale: false });
    await expect(h.observation.observe(input())).resolves.toMatchObject({ source: 'dynamic', stale: true });
  });

  it('reuses the scheduler result under the refreshed credential identity without another request', async () => {
    const statuses = [401, 200];
    const transport = vi.fn(async () => response(statuses.shift() ?? 503, ['curated']));
    const h = harness(transport, { catalogSuccessTtlMs: 5 * 60_000 });

    await expect(h.observation.observe(input())).resolves.toMatchObject({ source: 'dynamic', stale: false });
    await expect(h.observation.observe({ ...input(), trigger: 'picker_open' })).resolves.toMatchObject({
      source: 'dynamic', stale: false,
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does not apply a failed post-refresh retry to the pre-refresh credential identity', async () => {
    const statuses = [200, 401, 503];
    const h = harness(async () => response(statuses.shift() ?? 503, ['curated']));
    await expect(h.observation.observe(input())).resolves.toMatchObject({ source: 'dynamic', stale: false });

    await expect(h.observation.observe(input())).resolves.toMatchObject({ source: 'static', stale: false });
  });

  it('falls back to static when selected-account request auth is unavailable', async () => {
    const h = harness(async () => response(200, ['curated']));
    h.requestAuth.lookupRequestAuth.mockRejectedValueOnce(
      new ConnectedAccountRequestAuthError('request_auth_credential_unavailable'),
    );

    const result = await h.observation.observe(input());
    expect(result.source).toBe('static');
    expect(result.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'static-only' })]));
  });

  it('partitions retained observations by non-secret account identity', async () => {
    let status = 200;
    const h = harness(async () => response(status, ['curated']));
    await h.observation.observe(input('selected-account'));
    status = 503;
    const result = await h.observation.observe(input('other-account'));
    expect(result.source).toBe('static');
    expect(result.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'static-only' })]));
  });

  it('propagates superseded currentness as cancellation without publishing a fallback', async () => {
    const h = harness(async () => response(200, ['curated']));
    h.setCurrent(false);

    await expect(h.observation.observe(input())).rejects.toBeInstanceOf(ProviderProbeCancelledError);
  });

  it('cancels after async probe I/O becomes stale and does not publish its successful result', async () => {
    let requestCount = 0;
    let invalidate = () => {};
    const h = harness(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        invalidate();
        return response(200, ['curated']);
      }
      return response(503, ['curated']);
    });
    invalidate = () => h.setCurrent(false);

    await expect(h.observation.observe(input())).rejects.toBeInstanceOf(ProviderProbeCancelledError);
    h.setCurrent(true);
    await expect(h.observation.observe(input())).resolves.toMatchObject({ source: 'static', stale: false });
  });
});
