import { describe, expect, it, vi } from 'vitest';

import { ProviderContributionV1Schema } from '@happier-dev/protocol';
import {
  ConnectedAccountRequestAuthError,
  type ConnectedAccountRequestAuthService,
} from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';

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
  scheduler = createProviderProbeScheduler(),
) {
  let current = true;
  let selectedAccountId = 'selected-account';
  let revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
  let token = 'selected-account-token';
  const refreshAfterAuthFailure = vi.fn<ConnectedAccountRequestAuthService['refreshAfterAuthFailure']>(async () => {
    token = 'refreshed-selected-account-token';
    revision = 'csr_1123456789ABCDEFGHJKMNPQRS';
    return { status: 'current_changed' as const };
  });
  const requestAuth = {
    lookupRequestAuth: vi.fn<ConnectedAccountRequestAuthService['lookupRequestAuth']>(async () => ({
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
      if (subject.kind !== 'agent_catalog_observation') {
        throw new Error('agent catalog observation test received an unexpected binding subject');
      }
      const binding = bindings[0];
      let active = true;
      if (binding?.target.kind === 'account') selectedAccountId = binding.target.account.accountId;
      return {
        subjectId: 'observation-subject',
        isCurrent: () => active && current && subject.isCurrent(),
        resolvePurposeBinding: () => binding ?? null,
        listPurposeBindings: () => bindings,
        dispose: () => { active = false; },
      };
    },
    requestAuth,
    createRedactionLease: () => ({
      add: (values: readonly string[]) => redacted.push(...values),
      containsSensitiveValue: (value: string) => redacted.some((secret) => value.includes(secret)),
      close: () => { redacted.length = 0; },
    }),
    client: createProviderProbeHttpClient({
      resolveAddresses: async () => ['93.184.216.34'],
      transport,
    }),
    scheduler,
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
    expect(h.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(2);

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

  it('keeps a retained native catalog current when only local scheduler capacity is unavailable', async () => {
    const scheduler = createProviderProbeScheduler({ maxConcurrentOperations: 1, maxPendingOperations: 1 });
    const h = harness(async () => response(200, ['api-only']), scheduler);
    await expect(h.observation.observe(input())).resolves.toMatchObject({
      source: 'dynamic', stale: false, models: [{ id: 'api-only' }],
    });

    let releaseActive!: () => void;
    const active = scheduler.runCatalog(
      'occupied',
      'manual_refresh',
      () => new Promise<Readonly<{ status: 'success' }>>((resolve) => {
        releaseActive = () => resolve({ status: 'success' });
      }),
      { unavailable: () => ({ status: 'error' as const }) },
    );
    const queued = scheduler.runCatalog(
      'queued',
      'manual_refresh',
      async () => ({ status: 'success' as const }),
      { unavailable: () => ({ status: 'error' as const }) },
    );
    await vi.waitFor(() => expect(releaseActive).toBeTypeOf('function'));

    await expect(h.observation.observe(input())).resolves.toMatchObject({
      source: 'dynamic', stale: false, models: [{ id: 'api-only' }],
    });

    releaseActive();
    await expect(active).resolves.toMatchObject({ status: 'success' });
    await expect(queued).resolves.toMatchObject({ status: 'success' });
  });

  it('keeps the static catalog when the selected endpoint has no fixed URL', async () => {
    const transport = vi.fn(async () => response(200, ['curated']));
    const h = harness(transport);
    const localProvider = ProviderContributionV1Schema.parse({
      ...provider,
      kind: 'local',
      endpointTemplates: [{
        ...provider.endpointTemplates[0],
        baseUrl: undefined,
        localUrlCandidates: ['http://127.0.0.1:11434'],
      }],
    });

    await expect(h.observation.observe({ ...input(), provider: localProvider })).resolves.toMatchObject({
      source: 'static',
      stale: false,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('keeps the static catalog when the catalog purpose has no selected target binding', async () => {
    const transport = vi.fn(async () => response(200, ['api-only']));
    const h = harness(transport);

    await expect(h.observation.observe({ ...input(), binding: null })).resolves.toMatchObject({
      source: 'static',
      stale: false,
    });
    expect(h.requestAuth.lookupRequestAuth).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('refreshes and retries exactly once for 401, but never for 403 or a second 401', async () => {
    const statuses = [401, 200];
    const h = harness(async () => response(statuses.shift() ?? 500, ['curated']));
    await expect(h.observation.observe(input())).resolves.toMatchObject({ source: 'dynamic' });
    expect(h.refreshAfterAuthFailure).toHaveBeenCalledOnce();
    expect(h.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(3);

    const forbidden = harness(async () => response(403));
    await forbidden.observation.observe(input());
    expect(forbidden.refreshAfterAuthFailure).not.toHaveBeenCalled();
    expect(forbidden.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(2);

    const repeated = harness(async () => response(401));
    await repeated.observation.observe(input());
    expect(repeated.refreshAfterAuthFailure).toHaveBeenCalledOnce();
    expect(repeated.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(3);
  });

  it('uses the catalog observation caller signal before joining shared work, not during recovery or retry', async () => {
    const statuses = [401, 200];
    const h = harness(async () => response(statuses.shift() ?? 500, ['curated']));
    const signal = new AbortController().signal;

    await expect(h.observation.observe({ ...input(), signal })).resolves.toMatchObject({
      source: 'dynamic',
    });

    expect(h.requestAuth.lookupRequestAuth).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ signal }),
    );
    expect(h.refreshAfterAuthFailure.mock.calls[0]?.[0]).not.toHaveProperty('signal');
    for (const [lookup] of h.requestAuth.lookupRequestAuth.mock.calls.slice(1)) {
      expect(lookup).not.toHaveProperty('signal');
    }
  });

  it('keeps coalesced catalog work alive when its first caller becomes non-current and a current waiter remains', async () => {
    let resolveTransport!: (value: ReturnType<typeof response>) => void;
    const transport = vi.fn(() => new Promise<ReturnType<typeof response>>((resolve) => {
      resolveTransport = resolve;
    }));
    const h = harness(transport);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const sharedMaterialization = {
      ...use,
      materialization: {
        ...use.materialization,
        headerNames: ['authorization', 'x-shared-registry'] as const,
      },
    };

    const first = h.observation.observe({
      ...input(),
      operationId: 'operation-first',
      requestAuthUse: sharedMaterialization,
      signal: firstController.signal,
      isCurrent: () => !firstController.signal.aborted,
    });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    const second = h.observation.observe({
      ...input(),
      operationId: 'operation-second',
      requestAuthUse: {
        ...sharedMaterialization,
        materialization: {
          ...sharedMaterialization.materialization,
          headerNames: ['x-shared-registry', 'authorization'] as const,
        },
      },
      signal: secondController.signal,
      isCurrent: () => !secondController.signal.aborted,
    });
    await vi.waitFor(() => expect(h.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(3));

    firstController.abort();
    await expect(first).rejects.toBeInstanceOf(ProviderProbeCancelledError);
    resolveTransport(response(200, ['api-only']));

    await expect(second).resolves.toMatchObject({
      source: 'dynamic',
      models: [{ id: 'api-only', name: 'API api-only' }],
      stale: false,
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('does not join catalog work that captured a different request-auth materialization', async () => {
    const releases: Array<(value: ReturnType<typeof response>) => void> = [];
    const transport = vi.fn(() => new Promise<ReturnType<typeof response>>((resolve) => {
      releases.push(resolve);
    }));
    const h = harness(transport);
    const first = h.observation.observe({ ...input(), operationId: 'registry-a' });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
    const second = h.observation.observe({
      ...input(),
      operationId: 'registry-b',
      requestAuthUse: {
        ...use,
        materialization: {
          ...use.materialization,
          headerNames: ['authorization', 'x-registry-b'] as const,
        },
      },
    });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));

    releases.shift()?.(response(200, ['registry-a']));
    releases.shift()?.(response(200, ['registry-b']));

    await expect(first).resolves.toMatchObject({
      source: 'dynamic', models: [{ id: 'registry-a', name: 'API registry-a' }],
    });
    await expect(second).resolves.toMatchObject({
      source: 'dynamic', models: [{ id: 'registry-b', name: 'API registry-b' }],
    });
  });

  it('remembers a successful 401 recovery under the refreshed credential revision', async () => {
    const statuses = [401, 200, 503];
    const h = harness(async () => response(statuses.shift() ?? 503, ['curated']));

    await expect(h.observation.observe(input())).resolves.toMatchObject({ source: 'dynamic', stale: false });
    await expect(h.observation.observe(input())).resolves.toMatchObject({ source: 'dynamic', stale: true });
  });

  it('keeps refreshed catalog data with the observation owner instead of retaining a manual payload in the scheduler', async () => {
    const statuses = [401, 200];
    const transport = vi.fn(async () => response(statuses.shift() ?? 503, ['curated']));
    const h = harness(transport);

    await expect(h.observation.observe(input())).resolves.toMatchObject({ source: 'dynamic', stale: false });
    await expect(h.observation.observe({ ...input(), trigger: 'picker_open' })).resolves.toMatchObject({
      source: 'dynamic', stale: true,
    });
    expect(transport).toHaveBeenCalledTimes(3);
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
