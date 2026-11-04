import { describe, expect, it, vi } from 'vitest';
import {
  TeamCredentialSourceBindingV1Schema,
  type TeamCredentialResourceSummaryV1,
  type TeamCredentialSourceBindingV1,
} from '@happier-dev/protocol/teams';
import type { ManagedProviderEndpointAccessProjection } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';

import { projectProviderConnectionBrokerApplication } from './providerConnectionCpxBridge';
import { createBrokerProviderRegistry } from './providerBroker.testkit';

import {
  createTeamCredentialBrokerSourceOwner,
  isCLIProxyAPIBrokerApplication,
  teamCredentialBrokerPlacementAcceptsMachine,
} from './teamCredentialBrokerSourceOwner';
import { createConnectedServicesBrokerSourceOpen } from './connectedServicesSource';
import { logger } from '@/ui/logger';
import { createPrivateProviderBrokerStreamLifetime } from './daemonProviderBrokerRuntime';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function sourceCustodyHarness(sourceKind: 'connected_account' | 'connected_pool' = 'connected_account') {
  const accountSource = {
    v: 1, kind: 'connected_account',
    target: { kind: 'account', account: {
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'account-1',
    } },
    credentialIncarnation: 'credential-incarnation-1',
  } as const;
  const source = sourceKind === 'connected_account' ? accountSource : {
    v: 1 as const, kind: 'connected_pool' as const,
    target: { kind: 'group' as const, service: accountSource.target.account.service, groupId: 'pool-1' },
    poolIncarnation: 'pool-incarnation-1',
  };
  const application = {
    agentTargetKey: 'agent:codex',
    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
    endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses',
  } as const;
  const unusedBoundary = (): never => { throw new Error('Unexpected effect boundary'); };
  let targetReadError = false;
  const purposes = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unusedBoundary, subscribe: () => ({ dispose() {} }) },
    selectTarget: unusedBoundary,
    resolveTarget: async target => {
      if (targetReadError) throw new Error('Connected Account Home unavailable');
      return { displayName: 'Account 1', account: accountSource.target.account,
        ...(target.kind === 'group' ? { group: { groupId: target.groupId, generation: 1 } } : {}) };
    },
    materializeAccount: unusedBoundary,
    projectTargetAccounts: unusedBoundary,
    assertTargetAccountMaterializable: unusedBoundary,
  });
  const managed = createManagedServicesOwner({
    processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
    dependencies: unusedBoundary,
    resolveScope: (scope) => scope,
  });
  const operation = {
    operationId: 'session-1', pluginId: application.implementationIdentity.pluginId,
    contributionQualifiedId: `${application.implementationIdentity.pluginId}/providers/cliproxyapi`,
    occurrenceId: 'provider-occurrence', purposeBindingsEqualityKey: 'exact-connected-account',
    lifecycleKind: 'providerBroker' as const,
  };
  let childCurrent = true;
  const childRequest = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: null }));
  const childCleanup = vi.fn(async () => { childCurrent = false; });
  let pauseAfterJoin = false;
  let failReadAfterJoin = false;
  let readPause: ReturnType<typeof deferred<void>> | null = null;
  let readEntered: ReturnType<typeof deferred<void>> | null = null;
  // The fixture bridges the source's custody port into the real semantic/join
  // owner. Only the already-authorized Provider child is an effect boundary.
  const custody: ManagedProviderExplicitStartCustody = {
    async acquire(input) {
      const joined = await managed.runManagedProviderExplicitStart({
        ...operation, signal: input.signal, isCurrent: input.isAuthorizationCurrent,
        ...(input.revalidateRetainedCurrentness ? { revalidateRetainedCurrentness: input.revalidateRetainedCurrentness } : {}),
        establish: async () => ({ status: 'running', projection: {
          access: { endpointUrl: () => 'http://127.0.0.1:43120/v1', request: childRequest },
          isCurrent: () => childCurrent, cleanup: childCleanup,
        } }),
      });
      if (pauseAfterJoin) {
        pauseAfterJoin = false;
        readPause = deferred();
      }
      if (failReadAfterJoin) {
        failReadAfterJoin = false;
        sourceReadError = true;
      }
      return joined.status === 'established' ? joined.value.projection : null;
    },
    retire: async () => await managed.retireManagedProviderExplicitStart(operation),
    retireExternalApiKey: unusedBoundary,
    revalidateRetainedClaims: async (signal) => await managed.revalidateManagedProviderExplicitStarts(signal),
    retireAll: async () => await managed.retireManagedProviderExplicitStarts('providerBroker'),
  };
  let enabled = true;
  let sourceReadError = false;
  let sourceMissing = false;
  const readResource = vi.fn(async (): Promise<TeamCredentialResourceSummaryV1 | null> => {
    if (sourceReadError) throw new Error('Home unavailable');
    if (sourceMissing) return null;
    if (readPause) { readEntered?.resolve(undefined); await readPause.promise; }
    return {
      id: 'resource-1', teamId: 'team-1', custodianAccountId: 'custodian-1', sourceOwnerDisplayName: null,
      displayName: 'Shared Codex', enabled, revision: 7, source,
      deliveryPolicy: { preferredAllowedModes: ['brokered'] }, sessionUsePolicy: 'personal_allowed',
      sourcePresentation: { kind: 'connected_service', service: accountSource.target.account.service },
      directExportSupport: 'unsupported', activeUsageLimitCount: 0, requestPolicy: null,
      brokerPlacement: { kind: 'machine', machineId: 'broker-machine' },
      allMembersAllowedRoutes: null, groupGrants: [], memberGrants: [],
      readiness: { kind: 'available' }, recoveryAction: null,
      brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
      capabilities: { manageAudience: false, managePolicy: false, manageLimits: false, updateBrokerPlacement: false, updateDeliveryPolicy: false,
        narrowDisclosure: false, widenDisclosure: false, refreshDirectMaterial: false, disable: false, enable: false, delete: false },
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
  });
  const owner = createTeamCredentialBrokerSourceOwner({
    machineId: 'broker-machine', custody, selectConnectedServicesSourceMember: async () => null,
    openConnectedServicesSource: createConnectedServicesBrokerSourceOpen({
      withRegistry: async (read) => await read(createBrokerProviderRegistry()),
      readResource, resolveBindingIntentSelection: purposes.resolveBindingIntentSelection, custody,
    }),
    openProviderConnectionSource: unusedBoundary,
  });
  return {
    managed, childRequest, childCleanup, readResource, owner, source, application,
    acquire: (signal: AbortSignal) => owner.acquire({
      source, application, resourceId: 'resource-1', resourceRevision: 7, brokerMachineId: 'broker-machine',
      operation: { kind: 'session', sessionId: 'session-1' }, signal,
      revalidateOperationAuthorization: async () => true,
    }),
    pauseRead(afterJoin: boolean) {
      readEntered = deferred();
      pauseAfterJoin = afterJoin;
      if (!afterJoin) readPause = deferred();
      return readEntered.promise;
    },
    resumeRead() { readPause?.resolve(undefined); readPause = null; },
    revokeSource() { enabled = false; },
    failSourceReads() { sourceReadError = true; },
    failSourceReadAfterJoin() { failReadAfterJoin = true; },
    failTargetReads() { targetReadError = true; },
    restoreSourceReads() { sourceReadError = false; targetReadError = false; },
    deleteSource() { sourceMissing = true; },
  };
}

function projection(isCurrent = true): ManagedProviderEndpointAccessProjection {
  return Object.freeze({
    access: Object.freeze({
      endpointUrl: () => 'http://127.0.0.1:45123/v1',
      request: vi.fn(async () => ({
        ok: true as const,
        status: 200,
        statusText: 'OK',
        headers: Object.freeze({}),
        body: null,
      })),
    }),
    isCurrent: () => isCurrent,
    cleanup: vi.fn(),
  });
}

function opened(
  projectionValue = projection(),
  sourceCurrent: boolean | (() => boolean) = true,
  retire = vi.fn(async () => {}),
) {
  return Object.freeze({
    projection: projectionValue,
    retire,
    sourceCurrentness: Object.freeze({
      sourceMember: Object.freeze({
        kind: 'connected_account' as const,
        service: Object.freeze({ pluginId: 'acme.accounts', localId: 'service' }),
        connectedAccountId: 'source-account',
      }),
      isCurrent: vi.fn(async () => (
        typeof sourceCurrent === 'function' ? sourceCurrent() : sourceCurrent
      )),
    }),
  });
}

const service = Object.freeze({ pluginId: 'acme.accounts', localId: 'service' });
const parsedAccountSource = TeamCredentialSourceBindingV1Schema.parse({
  v: 1 as const,
  kind: 'connected_account' as const,
  target: Object.freeze({
    kind: 'account' as const,
    account: Object.freeze({ service, accountId: 'source-account' }),
  }),
  credentialIncarnation: 'credential-incarnation',
});
if (parsedAccountSource.kind !== 'connected_account') throw new Error('expected account source');
const accountSource = parsedAccountSource;
const parsedPoolSource = TeamCredentialSourceBindingV1Schema.parse({
  v: 1 as const,
  kind: 'connected_pool' as const,
  target: Object.freeze({ kind: 'group' as const, service, groupId: 'source-pool' }),
  poolIncarnation: 'pool-incarnation',
});
if (parsedPoolSource.kind !== 'connected_pool') throw new Error('expected pool source');
const poolSource = parsedPoolSource;
const parsedProviderSource = TeamCredentialSourceBindingV1Schema.parse({
  v: 1 as const,
  kind: 'provider_connection' as const,
  connectionId: 'pc_source',
  connectionSecurityFingerprint: 'connection-security:v1:source',
  credentialSlotId: 'apiKey',
});
if (parsedProviderSource.kind !== 'provider_connection') throw new Error('expected Provider source');
const providerSource = parsedProviderSource;

function request(
  source: TeamCredentialSourceBindingV1,
  overrides: Partial<Parameters<ReturnType<typeof createTeamCredentialBrokerSourceOwner>['acquire']>[0]> = {},
) {
  return {
    source,
    resourceId: 'resource-1',
    resourceRevision: 7,
    brokerMachineId: 'broker-machine',
    operation: { kind: 'session' as const, sessionId: 'session-1' },
    application: {
      agentTargetKey: 'agent:codex',
      implementationIdentity: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      endpointTemplateId: 'responses',
      protocol: 'openai-responses' as const,
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('Team credential broker source owner', () => {
  it('retires retained custody on a definite missing Home resource', async () => {
    const harness = sourceCustodyHarness();
    try {
      const acquired = await harness.acquire(new AbortController().signal);
      if (!acquired.ok) throw new Error('Expected source custody');
      harness.deleteSource();
      await expect(acquired.projection.access.request({ method: 'POST', pathAndQuery: '/v1/responses' })).rejects.toMatchObject({
        failure: { reasonCode: 'source_unavailable' },
      });
      expect(harness.managed.readRetainedSemanticCustodyCount()).toBe(0);
      expect(harness.childCleanup).toHaveBeenCalledOnce();
      expect(harness.childRequest).not.toHaveBeenCalled();
    } finally {
      await harness.managed.dispose();
    }
  });

  it.each(['resource', 'joined'] as const)('preserves an incumbent Pool gateway across repeated unknown %s reads after request cleanup without another acquire attempt', async phase => {
    const harness = sourceCustodyHarness('connected_pool');
    const lifetime = createPrivateProviderBrokerStreamLifetime({
      sourceOwner: harness.owner, application: harness.application,
      operation: { kind: 'session', sessionId: 'session-1' },
    });
    const input = { source: harness.source, application: harness.application,
      resourceId: 'resource-1', expectedResourceRevision: 7, brokerMachineId: 'broker-machine',
      operation: { kind: 'session' as const, sessionId: 'session-1' }, modelId: 'gpt-5', sourceRevision: 'source-v1' };
    try {
      const first = await lifetime.acquireSource(input);
      if (!first || 'reasonCode' in first) throw new Error('Expected Pool source');
      harness.failSourceReads();
      await expect(first.access.request({ method: 'POST', pathAndQuery: '/v1/responses' })).rejects.toMatchObject({
        failure: { reasonCode: 'source_unavailable' },
      });
      harness.readResource.mockClear();
      if (phase === 'joined') {
        harness.restoreSourceReads();
        harness.failSourceReadAfterJoin();
      }
      for (let request = 0; request < 2; request++) {
        await expect(lifetime.acquireSource(input)).resolves.toMatchObject({ ok: false, reasonCode: 'resource_unavailable' });
      }
      expect(harness.readResource).toHaveBeenCalledTimes(phase === 'joined' ? 4 : 2);
      expect(harness.childCleanup).not.toHaveBeenCalled();
      expect(harness.managed.readRetainedSemanticCustodyCount()).toBe(1);
      harness.restoreSourceReads();
      const recovered = await lifetime.acquireSource(input);
      if (!recovered || 'reasonCode' in recovered) throw new Error('Expected recovered Pool source');
      await expect(recovered.access.request({ method: 'POST', pathAndQuery: '/v1/responses' })).resolves.toMatchObject({ status: 200 });
      expect(harness.childRequest).toHaveBeenCalledOnce();
    } finally {
      await lifetime.close();
      await harness.managed.dispose();
    }
  });

  it('rechecks retained source custody only for matching feed facts and service identities', async () => {
    const harness = sourceCustodyHarness();
    try {
      const acquired = await harness.acquire(new AbortController().signal);
      if (!acquired.ok) throw new Error('Expected source custody');
      harness.readResource.mockClear();
      for (let arrival = 0; arrival < 20; arrival++) {
        await harness.managed.revalidateManagedProviderExplicitStarts(undefined, undefined, {
          facts: ['saved-secrets', 'provider-connections', 'connected-services'],
          connectedServiceRefs: [{ pluginId: 'other.plugin', localId: 'unrelated' }],
        });
      }
      await harness.managed.revalidateManagedProviderExplicitStarts(undefined, undefined, {
        facts: ['connected-services'], connectedServiceRefs: [],
      });
      expect(harness.readResource).not.toHaveBeenCalled();
      await harness.managed.revalidateManagedProviderExplicitStarts(undefined, undefined, {
        facts: ['connected-services'],
        connectedServiceRefs: [{ pluginId: 'happier.agent.codex', localId: 'openai-codex' }],
      });
      expect(harness.readResource).toHaveBeenCalledOnce();
      harness.readResource.mockClear();
      await harness.managed.revalidateManagedProviderExplicitStarts(undefined, undefined, { facts: ['connected-catalog'] });
      expect(harness.readResource).toHaveBeenCalledOnce();
      harness.revokeSource();
      await expect(harness.managed.revalidateManagedProviderExplicitStarts(undefined, undefined, {
        facts: ['teams'],
      })).resolves.toBe(1);
      expect(harness.childCleanup).toHaveBeenCalledOnce();
    } finally {
      await harness.managed.dispose();
    }
  });

  it.each(['acquire', 'request', 'target_request'] as const)('releases only the joined view on an unknown %s read and keeps shared custody recoverable', async phase => {
    const harness = sourceCustodyHarness();
    const providerRequest = { method: 'POST' as const, pathAndQuery: '/v1/responses', timeoutMs: 1_000 };
    try {
      const sibling = await harness.acquire(new AbortController().signal);
      if (!sibling.ok) throw new Error('Expected sibling custody');
      if (phase === 'acquire') {
        const paused = harness.pauseRead(true);
        const opening = harness.acquire(new AbortController().signal);
        await paused;
        harness.failSourceReads();
        harness.resumeRead();
        await expect(opening).resolves.toMatchObject({ ok: false, reasonCode: 'source_unavailable' });
      } else {
        const caller = await harness.acquire(new AbortController().signal);
        if (!caller.ok) throw new Error('Expected caller custody');
        if (phase === 'target_request') harness.failTargetReads();
        else harness.failSourceReads();
        await expect(caller.projection.access.request(providerRequest)).rejects.toMatchObject({
          failure: { ok: false, reasonCode: 'source_unavailable' },
        });
      }
      expect(harness.childRequest).not.toHaveBeenCalled();
      expect(harness.childCleanup).not.toHaveBeenCalled();
      expect(harness.managed.readRetainedSemanticCustodyCount()).toBe(1);
      harness.restoreSourceReads();
      await expect(sibling.projection.access.request(providerRequest)).resolves.toMatchObject({ status: 200 });
      harness.revokeSource();
      await expect(sibling.projection.access.request(providerRequest)).rejects.toMatchObject({
        failure: { ok: false, reasonCode: 'source_unavailable' },
      });
      expect(harness.childRequest).toHaveBeenCalledOnce();
      expect(harness.childCleanup).toHaveBeenCalledOnce();
      expect(harness.managed.readRetainedSemanticCustodyCount()).toBe(0);
    } finally {
      harness.resumeRead();
      await harness.managed.dispose();
    }
  });

  it('retains the failed Connected Services prerequisite in the typed refusal and safe log', async () => {
    const harness = sourceCustodyHarness();
    const diagnostics = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
      harness.revokeSource();
      await expect(harness.acquire(new AbortController().signal)).resolves.toEqual({
        ok: false, reasonCode: 'source_unavailable', sourceOpenFailureReason: 'resource_not_current',
      });
      expect(diagnostics).toHaveBeenCalledWith('[provider-broker-source]', {
        stage: 'source_open', code: 'projection_unavailable', reason: 'resource_not_current',
      });
      expect(harness.childRequest).not.toHaveBeenCalled();
    } finally {
      diagnostics.mockRestore();
      await harness.managed.dispose();
    }
  });

  it.each(['acquire', 'request', 'cleanup'] as const)('keeps sibling custody when a caller closes during %s source revalidation', async (phase) => {
    const harness = sourceCustodyHarness();
    const caller = new AbortController();
    const providerRequest = { method: 'POST' as const, pathAndQuery: '/v1/responses', timeoutMs: 1_000 };
    try {
      let work: Promise<unknown>;
      let paused: Promise<void>;
      let closeCaller = async () => { caller.abort(); };
      let sibling: Awaited<ReturnType<typeof harness.acquire>>;
      if (phase === 'acquire') {
        sibling = await harness.acquire(new AbortController().signal);
        paused = harness.pauseRead(true);
        work = harness.acquire(caller.signal);
      } else {
        const acquired = await harness.acquire(caller.signal);
        if (!acquired.ok) throw new Error('Expected caller source custody');
        if (phase === 'cleanup') closeCaller = async () => { await acquired.projection.cleanup(); };
        sibling = await harness.acquire(new AbortController().signal);
        paused = harness.pauseRead(false);
        work = acquired.projection.access.request(providerRequest);
      }
      if (!sibling.ok) throw new Error('Expected sibling source custody');
      await paused;
      await closeCaller();
      harness.resumeRead();
      if (phase === 'acquire') await work;
      else await expect(work).rejects.toMatchObject({ failure: { reasonCode: 'source_unavailable' } });
      expect(harness.childRequest).not.toHaveBeenCalled();
      expect(sibling.projection.isCurrent()).toBe(true);
      expect(harness.managed.readRetainedSemanticCustodyCount()).toBe(1);
      expect(harness.childCleanup).not.toHaveBeenCalled();
      await expect(harness.managed.revalidateManagedProviderExplicitStarts(new AbortController().signal)).resolves.toBe(0);
      await expect(sibling.projection.access.request(providerRequest)).resolves.toMatchObject({ status: 200 });
      harness.revokeSource();
      await expect(sibling.projection.access.request(providerRequest)).rejects.toMatchObject({ failure: { reasonCode: 'source_unavailable' } });
      expect(harness.childRequest).toHaveBeenCalledOnce();
      expect(harness.childCleanup).toHaveBeenCalledOnce();
      expect(harness.managed.readRetainedSemanticCustodyCount()).toBe(0);
    } finally {
      harness.resumeRead();
      await harness.managed.dispose();
    }
  });

  it('keeps custody when a retained revalidation pass is cancelled during its source read', async () => {
    const harness = sourceCustodyHarness();
    try {
      const acquired = await harness.acquire(new AbortController().signal);
      if (!acquired.ok) throw new Error('Expected source custody');
      const pass = new AbortController();
      const paused = harness.pauseRead(false);
      const checking = harness.managed.revalidateManagedProviderExplicitStarts(pass.signal);
      const refused = expect(checking).rejects.toMatchObject({ name: 'AbortError' });
      await paused;
      pass.abort();
      harness.resumeRead();
      await refused;
      expect(acquired.projection.isCurrent()).toBe(true);
      expect(harness.managed.readRetainedSemanticCustodyCount()).toBe(1);
      expect(harness.childCleanup).not.toHaveBeenCalled();
      await expect(harness.managed.revalidateManagedProviderExplicitStarts(new AbortController().signal)).resolves.toBe(0);
      harness.revokeSource();
      await expect(harness.managed.revalidateManagedProviderExplicitStarts(new AbortController().signal)).resolves.toBe(1);
      expect(harness.childCleanup).toHaveBeenCalledOnce();
      expect(harness.managed.readRetainedSemanticCustodyCount()).toBe(0);
    } finally {
      harness.resumeRead();
      await harness.managed.dispose();
    }
  });

  it('keeps retained custody when the Home source read is unavailable', async () => {
    const diagnostics = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const harness = sourceCustodyHarness();
    try {
      const acquired = await harness.acquire(new AbortController().signal);
      if (!acquired.ok) throw new Error('Expected source custody');
      harness.failSourceReads();
      await expect(harness.acquire(new AbortController().signal)).resolves.toMatchObject({
        ok: false,
        reasonCode: 'source_unavailable',
      });
      expect(diagnostics).toHaveBeenCalledWith('[provider-broker-source]', { stage: 'source_open', code: 'exception' });
      await expect(harness.managed.revalidateManagedProviderExplicitStarts()).resolves.toBe(0);
      expect(harness.childCleanup).not.toHaveBeenCalled();
      expect(harness.managed.readRetainedSemanticCustodyCount()).toBe(1);
    } finally {
      await harness.managed.dispose();
      diagnostics.mockRestore();
    }
  });

  it('uses one placement predicate for exact matching and already-admitted Pool targets', () => {
    expect(teamCredentialBrokerPlacementAcceptsMachine(
      { kind: 'machine', machineId: 'broker-machine' },
      'broker-machine',
    )).toBe(true);
    expect(teamCredentialBrokerPlacementAcceptsMachine(
      { kind: 'machine', machineId: 'other-machine' },
      'broker-machine',
    )).toBe(false);
    expect(teamCredentialBrokerPlacementAcceptsMachine(
      { kind: 'machine_pool', poolId: 'pool-1' },
      'broker-machine',
    )).toBe(true);
    expect(teamCredentialBrokerPlacementAcceptsMachine(null, 'broker-machine')).toBe(false);
    expect(teamCredentialBrokerPlacementAcceptsMachine(
      { kind: 'machine_pool', poolId: 'pool-1' },
      '',
    )).toBe(false);
  });

  it('takes the CLIProxyAPI application identity from the contribution projection', () => {
    const registry = createBrokerProviderRegistry();
    const projected = projectProviderConnectionBrokerApplication({
      registry,
      agentTargetKey: 'agent:happier.agent.codex/codex',
      protocol: 'openai-chat',
    });
    expect(projected).not.toBeNull();
    expect(isCLIProxyAPIBrokerApplication(registry, projected!)).toBe(true);
    expect(isCLIProxyAPIBrokerApplication({ providersByContributionKey: new Map() }, projected!)).toBe(false);
    expect(isCLIProxyAPIBrokerApplication(registry, { ...projected!, endpointTemplateId: 'cliproxyapi-anthropic' })).toBe(false);
    expect(isCLIProxyAPIBrokerApplication(registry, {
      ...projected!,
      implementationIdentity: { pluginId: 'happier.provider.other', localId: 'other' },
    })).toBe(false);
    expect(isCLIProxyAPIBrokerApplication(registry, {
      ...projected!,
      protocol: 'not-a-managed-protocol',
    })).toBe(false);
  });

  it('routes Connected Accounts and connected_pool through the same Connected Services owner', async () => {
    const connected = vi.fn(async () => opened());
    const provider = vi.fn(async () => opened());
    const owner = createTeamCredentialBrokerSourceOwner({
      selectConnectedServicesSourceMember: async () => null,
      custody: { retire: async () => true },
      machineId: 'broker-machine',
      openConnectedServicesSource: connected,
      openProviderConnectionSource: provider,
    });

    await expect(owner.acquire(request(accountSource))).resolves.toMatchObject({ ok: true });
    await expect(owner.acquire(request(poolSource, {
      operation: { kind: 'execution_run', executionRunId: 'run-1' },
    }))).resolves.toMatchObject({ ok: true });

    expect(connected).toHaveBeenNthCalledWith(1, expect.objectContaining({
      source: accountSource,
      resourceId: 'resource-1',
      brokerMachineId: 'broker-machine',
      operation: { kind: 'session', sessionId: 'session-1' },
    }));
    expect(connected).toHaveBeenNthCalledWith(2, expect.objectContaining({
      source: poolSource,
      operation: { kind: 'execution_run', executionRunId: 'run-1' },
    }));
    expect(provider).not.toHaveBeenCalled();
  });

  it('routes Provider Connections through the Provider/CPX source adapter', async () => {
    const connected = vi.fn(async () => opened());
    const provider = vi.fn(async () => opened());
    const owner = createTeamCredentialBrokerSourceOwner({
      selectConnectedServicesSourceMember: async () => null,
      custody: { retire: async () => true },
      machineId: 'broker-machine',
      openConnectedServicesSource: connected,
      openProviderConnectionSource: provider,
    });

    await expect(owner.acquire(request(providerSource))).resolves.toMatchObject({ ok: true });
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({
      source: providerSource,
      brokerMachineId: 'broker-machine',
      application: expect.objectContaining({
        endpointTemplateId: 'responses',
        protocol: 'openai-responses',
      }),
    }));
    expect(connected).not.toHaveBeenCalled();
  });

  it('rejects a different broker Machine before opening source custody', async () => {
    const connected = vi.fn(async () => opened());
    const provider = vi.fn(async () => opened());
    const owner = createTeamCredentialBrokerSourceOwner({
      selectConnectedServicesSourceMember: async () => null,
      custody: { retire: async () => true },
      machineId: 'broker-machine',
      openConnectedServicesSource: connected,
      openProviderConnectionSource: provider,
    });

    await expect(owner.acquire(request(accountSource, { brokerMachineId: 'other-machine' }))).resolves.toEqual({
      ok: false,
      reasonCode: 'broker_machine_mismatch',
    });
    expect(connected).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });

  it('releases only the aborted caller\'s joined view and leaves the operation to an explicit retire', async () => {
    const controller = new AbortController();
    const current = projection();
    const retire = vi.fn(async () => {});
    const owner = createTeamCredentialBrokerSourceOwner({
      selectConnectedServicesSourceMember: async () => null,
      custody: { retire: async () => true },
      machineId: 'broker-machine',
      openConnectedServicesSource: async () => opened(current, true, retire),
      openProviderConnectionSource: async () => opened(),
    });
    const acquired = await owner.acquire(request(accountSource, { signal: controller.signal }));
    if (!acquired.ok) throw new Error('expected source custody');
    controller.abort();
    await vi.waitFor(() => expect(current.cleanup).toHaveBeenCalledTimes(1));
    expect(acquired.projection.isCurrent()).toBe(false);
    await acquired.projection.cleanup();
    expect(current.cleanup).toHaveBeenCalledTimes(1);
    // The operation may still be serving other streams, so the caller going
    // away is not its end. Only an explicit retire ends it.
    expect(retire).not.toHaveBeenCalled();
    await acquired.retire();
    expect(retire).toHaveBeenCalledOnce();
  });

  it('retains cleanup custody after a failed release and coalesces concurrent retries', async () => {
    let releaseCleanup!: () => void;
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error('managed projection cleanup failed'))
      .mockImplementationOnce(async () => await new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      }));
    const current: ManagedProviderEndpointAccessProjection = Object.freeze({
      ...projection(),
      cleanup,
    });
    const owner = createTeamCredentialBrokerSourceOwner({
      selectConnectedServicesSourceMember: async () => null,
      custody: { retire: async () => true },
      machineId: 'broker-machine',
      openConnectedServicesSource: async () => opened(current),
      openProviderConnectionSource: async () => opened(),
    });
    const acquired = await owner.acquire(request(accountSource));
    if (!acquired.ok) throw new Error('expected source custody');

    await expect(acquired.projection.cleanup()).rejects.toThrow('managed projection cleanup failed');
    expect(acquired.projection.isCurrent()).toBe(false);
    await expect(acquired.projection.access.request({
      pathAndQuery: '/v1/responses',
      method: 'POST',
      body: undefined,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ failure: { ok: false, reasonCode: 'source_unavailable' } });
    expect(current.access.request).not.toHaveBeenCalled();
    const firstRetry = acquired.projection.cleanup();
    const concurrentRetry = acquired.projection.cleanup();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
    releaseCleanup();
    await Promise.all([firstRetry, concurrentRetry]);
    await acquired.projection.cleanup();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('releases a projection that is already stale at acquisition', async () => {
    const stale = projection(false);
    const retire = vi.fn(async () => {});
    const owner = createTeamCredentialBrokerSourceOwner({
      selectConnectedServicesSourceMember: async () => null,
      custody: { retire: async () => true },
      machineId: 'broker-machine',
      openConnectedServicesSource: async () => opened(stale, true, retire),
      openProviderConnectionSource: async () => opened(),
    });
    await expect(owner.acquire(request(accountSource))).resolves.toEqual({
      ok: false,
      reasonCode: 'source_unavailable',
    });
    expect(stale.cleanup).toHaveBeenCalledOnce();
    expect(retire).toHaveBeenCalledOnce();
  });

  it('retires broker custody when the shared source snapshot becomes stale', async () => {
    const current = projection();
    const retire = vi.fn(async () => {});
    const owner = createTeamCredentialBrokerSourceOwner({
      selectConnectedServicesSourceMember: async () => null,
      custody: { retire: async () => true },
      machineId: 'broker-machine',
      openConnectedServicesSource: async () => opened(current, false, retire),
      openProviderConnectionSource: async () => opened(),
    });
    await expect(owner.acquire(request(accountSource))).resolves.toEqual({
      ok: false,
      reasonCode: 'source_unavailable',
    });
    expect(current.cleanup).toHaveBeenCalledOnce();
    expect(retire).toHaveBeenCalledOnce();
  });

  it('rechecks opaque source currentness before every broker request', async () => {
    let sourceCurrent = true;
    const current = projection();
    const retire = vi.fn(async () => {});
    const owner = createTeamCredentialBrokerSourceOwner({
      selectConnectedServicesSourceMember: async () => null,
      custody: { retire: async () => true },
      machineId: 'broker-machine',
      openConnectedServicesSource: async () => opened(current, () => sourceCurrent, retire),
      openProviderConnectionSource: async () => opened(),
    });
    const acquired = await owner.acquire(request(accountSource));
    if (!acquired.ok) throw new Error('expected source custody');
    sourceCurrent = false;
    await expect(acquired.projection.access.request({
      pathAndQuery: '/responses',
      method: 'POST',
      body: undefined,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ failure: { ok: false, reasonCode: 'source_unavailable' } });
    expect(current.access.request).not.toHaveBeenCalled();
    expect(acquired.projection.isCurrent()).toBe(false);
    expect(current.cleanup).toHaveBeenCalledOnce();
    expect(retire).toHaveBeenCalledOnce();
  });
});
