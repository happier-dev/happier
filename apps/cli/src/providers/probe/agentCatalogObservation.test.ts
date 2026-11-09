import { describe, expect, it, vi } from 'vitest';

import { ProviderContributionV1Schema } from '@happier-dev/protocol';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
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
  let groupMember: string | null = 'selected-account';
  let groupGeneration = 1;
  let configurationRevision: string | null = null;
  let selectedGroup: { groupId: string; generation: number } | undefined;
  const refreshAfterAuthFailure = vi.fn<ConnectedAccountRequestAuthService['refreshAfterAuthFailure']>(async () => {
    token = 'refreshed-selected-account-token';
    revision = 'csr_1123456789ABCDEFGHJKMNPQRS';
    return { status: 'current_changed' as const };
  });
  const requestAuth = {
    lookupRequestAuth: vi.fn<ConnectedAccountRequestAuthService['lookupRequestAuth']>(async () => ({
      headers: { authorization: `Bearer ${token}` },
      facts: {},
      credentialContext: {
        account: { service, accountId: selectedAccountId },
        credentialRevision: revision,
        failingAccessTokenFingerprint: `sha256:${'a'.repeat(64)}`,
        ...(selectedGroup ? { group: selectedGroup } : {}),
      },
    })),
    refreshAfterAuthFailure,
  };
  const redacted: string[] = [];
  // Catalog observation uses explicit operation bindings. These persistent-store,
  // UI selection and credential boundaries must never be needed for native OAuth.
  const outsideObservation = async (): Promise<never> => { throw new Error('outside catalog observation'); };
  const resolveTarget = vi.fn(async (target: Parameters<Parameters<typeof createConnectedAccountPurposeBindingOwner>[0]['resolveTarget']>[0]) => {
    const account = target.kind === 'account' ? target.account
      : groupMember ? { service: target.service, accountId: groupMember } : null;
    return account ? { account, displayName: account.accountId,
      ...(target.kind === 'group' ? { group: { groupId: target.groupId, generation: groupGeneration } } : {}) } : null;
  });
  const bindingOwner = createConnectedAccountPurposeBindingOwner({
    store: { read: outsideObservation, update: outsideObservation, subscribe: () => ({ dispose() {} }) },
    selectTarget: outsideObservation,
    resolveTarget,
    resolveCredentialRevision: async () => revision,
    resolveCredentialConfigurationRevision: async () => configurationRevision,
    materializeAccount: outsideObservation,
    projectTargetAccounts: outsideObservation,
    assertTargetAccountMaterializable: outsideObservation,
  });
  const observation = createAgentProviderCatalogObservationService({
    readBindingObservation: input => bindingOwner.readBindingObservation(input),
    activatePurposeBindings: ({ subject, bindings, ...rest }) => {
      if (subject.kind !== 'agent_catalog_observation') {
        throw new Error('agent catalog observation test received an unexpected binding subject');
      }
      const binding = bindings[0];
      if (binding?.target.kind === 'account') selectedAccountId = binding.target.account.accountId;
      selectedGroup = binding?.target.kind === 'group'
        ? { groupId: binding.target.groupId, generation: groupGeneration } : undefined;
      return bindingOwner.activatePurposeBindings({
        ...rest, bindings,
        subject: { ...subject, isCurrent: () => current && subject.isCurrent() },
      });
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
  return { observation, requestAuth, refreshAfterAuthFailure, redacted, resolveTarget,
    setGroupMember: (accountId: string | null) => { groupMember = accountId; groupGeneration += 1; },
    setConfigurationRevision: (value: string) => { configurationRevision = value; },
    setCurrent: (value: boolean) => { current = value; } };
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
  it('retains an exact native credential observation after more than 64 other identities', async () => {
    let requests = 0;
    const h = harness(async () => { requests++; return response(200, ['native-model']); });
    const native = (index: number) => ({ ...input(), service, target: { status: 'ready' as const, endpointUrl: 'https://api.anthropic.com/', headerBindings: [{ name: 'authorization', format: 'bearer' as const }], credentialValue: `native-${index}`,
      credentialFingerprint: `sha256:${index.toString(16).padStart(8, '0')}${'a'.repeat(56)}` } });
    const first = await h.observation.observeNative(native(0));
    for (let index = 1; index <= 65; index++) await h.observation.observeNative(native(index));
    expect(await h.observation.observeNative({ ...native(0), currentOnly: true })).toEqual(first);
    expect(requests).toBe(66);
  });
  it('reads the exact source observation without dispatch for current-only admission and withdraws a failed refresh', async () => {
    let models = ['gpt-6.1-sol'];
    let status = 200;
    let requests = 0;
    const h = harness(async () => { requests++; return response(status, models); });
    expect(await h.observation.observe({ ...input(), currentOnly: true })).toMatchObject({ source: 'static' });
    expect(h.requestAuth.lookupRequestAuth).not.toHaveBeenCalled();
    expect(requests).toBe(0);
    const first = await h.observation.observe(input());
    expect(first).toMatchObject({ source: 'dynamic', models: [{ id: 'gpt-6.1-sol' }] });
    expect(await h.observation.observe({ ...input(), currentOnly: true })).toEqual(first);
    expect(await h.observation.observe({ ...input('other-account'), currentOnly: true })).toMatchObject({ source: 'static' });
    expect(h.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(1);
    expect(requests).toBe(1);
    models = ['gpt-6.1-terra'];
    const changed = await h.observation.observe(input());
    expect(changed).toMatchObject({ source: 'dynamic', models: [{ id: 'gpt-6.1-terra' }] });
    expect(await h.observation.observe({ ...input(), currentOnly: true })).toEqual(changed);
    status = 503;
    await h.observation.observe(input());
    expect(await h.observation.observe({ ...input(), currentOnly: true })).toMatchObject({ source: 'dynamic', stale: true });
    expect(requests).toBe(3);
  });

  it('reads an explicitly empty observation without acquiring credentials or restoring declared fallback models', async () => {
    const transport = vi.fn<ProviderProbeTransport>(async () => response(200, []));
    const h = harness(transport);
    expect(await h.observation.observe(input())).toMatchObject({ source: 'dynamic', models: [] });
    const acquisitions = h.requestAuth.lookupRequestAuth.mock.calls.length;
    for (let index = 0; index < 4; index++) {
      expect(await h.observation.observe({ ...input(), currentOnly: true })).toMatchObject({ source: 'dynamic', models: [] });
    }
    expect(h.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(acquisitions);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('reads recorded pool identity without selecting a member when the pool is empty or advances', async () => {
    const transport = vi.fn<ProviderProbeTransport>(async () => response(200, []));
    const h = harness(transport);
    const groupInput = { ...input(), binding: { purpose,
      target: { kind: 'group' as const, service, groupId: 'selected-pool' } } };
    await h.observation.observe(groupInput);
    const acquisitions = h.requestAuth.lookupRequestAuth.mock.calls.length;
    h.resolveTarget.mockClear();
    expect(await h.observation.observe({ ...groupInput, currentOnly: true })).toMatchObject({ source: 'dynamic', models: [] });
    expect(h.resolveTarget).toHaveBeenCalledTimes(1);
    h.setGroupMember(null);
    expect(await h.observation.observe({ ...groupInput, currentOnly: true })).toMatchObject({ source: 'static' });
    expect(h.resolveTarget).toHaveBeenCalledTimes(2);
    h.setGroupMember('other-account');
    expect(await h.observation.observe({ ...groupInput, currentOnly: true })).toMatchObject({ source: 'static' });
    expect(h.resolveTarget).toHaveBeenCalledTimes(3);
    expect(h.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(acquisitions);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('withdraws a cached catalog when selected source configuration changes without borrowing credentials', async () => {
    const h = harness(async () => response(200, ['configured-model']));
    await h.observation.observe(input());
    const acquisitions = h.requestAuth.lookupRequestAuth.mock.calls.length;
    h.setConfigurationRevision('configuration-2');
    expect(await h.observation.observe({ ...input(), currentOnly: true })).toMatchObject({ source: 'static' });
    expect(h.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(acquisitions);
  });

  it('retains the successful observation time when a refresh fails', async () => {
    let status = 200;
    const h = harness(async () => response(status, ['listed']));
    const success = await h.observation.observe(input());
    expect(success).toMatchObject({ observedAt: expect.any(Number), stale: false });
    status = 503;
    const failed = await h.observation.observe(input());
    expect(failed).toMatchObject({ observedAt: success.observedAt, stale: true });
  });

  it('does not spend a longer catalog wait on another callers shorter deadline', async () => {
    let transportCompleted = false;
    let releaseTransport!: () => void;
    const transportGate = new Promise<void>(resolve => { releaseTransport = resolve; });
    const h = harness(async () => {
      await transportGate;
      transportCompleted = true;
      return response(200, ['longer-wait']);
    });
    const native = { ...input(), service, target: {
      status: 'ready' as const, endpointUrl: 'https://api.anthropic.com/',
      headerBindings: [{ name: 'x-api-key', format: 'raw' as const }],
      credentialValue: 'helper', credentialFingerprint: 'sha256:' + 'a'.repeat(64),
    } };
    const short = h.observation.observeNative({ ...native, operationId: 'short-deadline', wallDeadlineAtMs: Date.now() + 50, signal: AbortSignal.timeout(50) });
    const shortRejected = expect(short).rejects.toBeInstanceOf(ProviderProbeCancelledError);
    const longer = h.observation.observeNative({ ...native, operationId: 'long-deadline', wallDeadlineAtMs: Date.now() + 1000, signal: AbortSignal.timeout(1000) });
    try {
      await shortRejected;
      expect(transportCompleted).toBe(false);
    } finally {
      releaseTransport();
    }
    await expect(longer).resolves.toMatchObject({ source: 'dynamic', models: [{ id: 'longer-wait' }] });
  });

  it('keeps native gateway prefixes, header modes and credentials isolated in observation caches', async () => {
    const requests: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
    const h = harness(async request => {
      requests.push({ url: request.url, headers: request.headers });
      return response(200, [`observed-${requests.length}`]);
    });
    const native = (endpointUrl: string, token = 'helper-key', apiKeyOnly = false) => ({
      ...input(), service,
      target: {
        status: 'ready' as const, credentialValue: token,
        credentialFingerprint: `sha256:${(token === 'helper-key' ? 'c' : 'd').repeat(64)}`,
        endpointUrl,
        headerBindings: apiKeyOnly
          ? [{ name: 'x-api-key', format: 'raw' as const }]
          : [{ name: 'x-api-key', format: 'raw' as const }, { name: 'authorization', format: 'bearer' as const }],
      },
    });
    const first = native('https://gateway.example/one/anthropic/');
    await expect(h.observation.observeNative(first)).resolves.toMatchObject({ source: 'dynamic', models: [{ id: 'observed-1' }] });
    expect(requests[0]).toMatchObject({
      url: 'https://gateway.example/one/anthropic/v1/models?limit=1000',
      headers: { 'x-api-key': 'helper-key', authorization: 'Bearer helper-key', 'anthropic-version': '2023-06-01' },
    });
    expect(requests[0]?.headers).not.toHaveProperty('anthropic-beta');
    expect(await h.observation.observeNative({ ...first, currentOnly: true })).toMatchObject({ models: [{ id: 'observed-1' }] });

    for (const distinct of [
      native('https://gateway.example/two/anthropic/'),
      native('https://other-gateway.example/one/anthropic/'),
      native('https://gateway.example/one/anthropic/', 'other-key'),
      native('https://gateway.example/one/anthropic/', 'helper-key', true),
    ]) {
      await expect(h.observation.observeNative({ ...distinct, currentOnly: true })).resolves.toMatchObject({ source: 'static' });
    }
    await h.observation.observeNative(native('https://gateway.example/one/anthropic/', 'helper-key', true));
    expect(requests[1]?.headers).toMatchObject({ 'x-api-key': 'helper-key' });
    expect(requests[1]?.headers).not.toHaveProperty('authorization');
    expect(h.requestAuth.lookupRequestAuth).not.toHaveBeenCalled();
  });

  it('uses a native OAuth bearer through the same catalog observation owner', async () => {
    const requests: Array<Readonly<Record<string, string>>> = [];
    const h = harness(async (request) => {
      requests.push(request.headers);
      return response(200, ['native-only']);
    });

    await expect(h.observation.observeNative({
      ...input(),
      service,
      target: {
        status: 'ready' as const, endpointUrl: 'https://api.anthropic.com/',
        headerBindings: [{ name: 'authorization', format: 'bearer' as const }],
        credentialValue: 'native-oauth-token',
        credentialFingerprint: `sha256:${'b'.repeat(64)}`,
      },
    })).resolves.toMatchObject({
      source: 'dynamic',
      stale: false,
      models: [{ id: 'native-only' }],
    });
    expect(requests).toEqual([expect.objectContaining({ authorization: 'Bearer native-oauth-token' })]);
    expect(h.requestAuth.lookupRequestAuth).not.toHaveBeenCalled();
  });

  it('refuses a native catalog purpose belonging to another consumer before transport', async () => {
    const transport = vi.fn<ProviderProbeTransport>(async () => response(200, ['native-only']));
    const h = harness(transport);
    await expect(h.observation.observeNative({
      ...input(),
      consumer: { pluginId: 'external.agent', localId: 'assistant' },
      service,
      target: {
        status: 'ready' as const, endpointUrl: 'https://api.anthropic.com/',
        headerBindings: [{ name: 'authorization', format: 'bearer' as const }],
        credentialValue: 'native-oauth-token',
        credentialFingerprint: `sha256:${'b'.repeat(64)}`,
      },
    })).resolves.toMatchObject({ source: 'static', refreshError: true });
    expect(transport).not.toHaveBeenCalled();
  });

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
    expect(h.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(1);

    models = [];
    await expect(h.observation.observe(input())).resolves.toMatchObject({ source: 'dynamic', models: [], stale: false });
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
    expect(h.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(2);

    const forbidden = harness(async () => response(403));
    await forbidden.observation.observe(input());
    expect(forbidden.refreshAfterAuthFailure).not.toHaveBeenCalled();
    expect(forbidden.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(1);

    const repeated = harness(async () => response(401));
    await repeated.observation.observe(input());
    expect(repeated.refreshAfterAuthFailure).toHaveBeenCalledOnce();
    expect(repeated.requestAuth.lookupRequestAuth).toHaveBeenCalledTimes(2);
  });

  it('uses the catalog observation caller signal before joining shared work, not during recovery or retry', async () => {
    const statuses = [401, 200];
    const h = harness(async () => response(statuses.shift() ?? 500, ['curated']));
    const signal = new AbortController().signal;

    await expect(h.observation.observe({ ...input(), signal })).resolves.toMatchObject({
      source: 'dynamic',
    });

    expect(h.refreshAfterAuthFailure.mock.calls[0]?.[0]).not.toHaveProperty('signal');
    for (const [lookup] of h.requestAuth.lookupRequestAuth.mock.calls) {
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
    await vi.waitFor(() => expect(h.resolveTarget).toHaveBeenCalledTimes(2));
    expect(h.requestAuth.lookupRequestAuth).toHaveBeenCalledOnce();

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
