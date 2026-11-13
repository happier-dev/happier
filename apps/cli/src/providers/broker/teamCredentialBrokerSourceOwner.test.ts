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
  isCpxBrokerApplication,
  teamCredentialBrokerPlacementAcceptsMachine,
} from './teamCredentialBrokerSourceOwner';
import { createConnectedServicesBrokerSourceOpen } from './connectedServicesSource';
import { logger } from '@/ui/logger';
import { createPrivateProviderBrokerStreamLifetime } from './daemonProviderBrokerRuntime';

function sourceCustodyHarness(
  sourceKind: 'connected_account' | 'connected_pool' = 'connected_account',
  options: Readonly<{ revokeSourceAfterJoin?: boolean }> = {},
) {
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
  const purposes = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unusedBoundary, subscribe: () => ({ dispose() {} }) },
    selectTarget: unusedBoundary,
    resolveTarget: async target => {
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
  // The fixture bridges the source's custody port into the real semantic/join
  // owner. Only the already-authorized Provider child is an effect boundary.
  const custody: ManagedProviderExplicitStartCustody = {
    async acquire(input) {
      if (options.revokeSourceAfterJoin) {
        expect(await input.revalidateAuthorization(input.signal)).toBe(true);
      }
      const joined = await managed.runManagedProviderExplicitStart({
        ...operation, signal: input.signal, isCurrent: input.isAuthorizationCurrent,
        ...(input.revalidateRetainedCurrentness ? { revalidateRetainedCurrentness: input.revalidateRetainedCurrentness } : {}),
        establish: async () => ({ status: 'running', projection: {
          access: { endpointUrl: () => 'http://127.0.0.1:43120/v1', request: childRequest },
          isCurrent: () => childCurrent, cleanup: childCleanup,
        } }),
      });
      if (options.revokeSourceAfterJoin) {
        enabled = false;
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
  const readResource = vi.fn(async (): Promise<TeamCredentialResourceSummaryV1 | null> => {
    if (sourceReadError) throw new Error('Home unavailable');
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
    }),
    revokeSource() { enabled = false; },
    failSourceReads() { sourceReadError = true; },
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
  retire = vi.fn(async () => {}),
) {
  return Object.freeze({
    projection: projectionValue,
    retire,
    sourceMember: Object.freeze({
      kind: 'connected_account' as const,
      service: Object.freeze({ pluginId: 'acme.accounts', localId: 'service' }),
      connectedAccountId: 'source-account',
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
  it('retains the typed cause when source establishment throws', async () => {
    const failureCause = { phase: 'provider.credential_resolution', errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null } as const;
    const owner = createTeamCredentialBrokerSourceOwner({
      selectConnectedServicesSourceMember: async () => null,
      custody: { retire: async () => true }, machineId: 'broker-machine',
      openConnectedServicesSource: async () => { throw Object.assign(new Error('private source detail'), { failureCause }); },
      openProviderConnectionSource: async () => opened(),
    });
    await expect(owner.acquire(request(accountSource))).resolves.toMatchObject({
      ok: false, reasonCode: 'source_unavailable', failureCause,
    });
  });

  it('keeps the admitted source when Home changes after managed establishment', async () => {
    const harness = sourceCustodyHarness('connected_account', { revokeSourceAfterJoin: true });
    try {
      const acquired = await harness.acquire(new AbortController().signal);
      expect(acquired).toMatchObject({ ok: true });
      if (!acquired.ok) return;
      await expect(acquired.projection.access.request({ method: 'POST', pathAndQuery: '/v1/responses' }))
        .resolves.toMatchObject({ status: 200 });
      expect(harness.readResource).toHaveBeenCalledTimes(2);
      expect(harness.childRequest).toHaveBeenCalledOnce();
      expect(harness.managed.readRetainedSemanticCustodyCount()).toBe(1);
    } finally {
      await harness.managed.dispose();
    }
  });

  it('serves an admitted Session continuation without rereading Home source authority', async () => {
    const harness = sourceCustodyHarness();
    try {
      const acquired = await harness.acquire(new AbortController().signal);
      if (!acquired.ok) throw new Error('Expected admitted Session custody');
      const providerRequest = { method: 'POST' as const, pathAndQuery: '/v1/responses' };
      await expect(acquired.projection.access.request(providerRequest)).resolves.toMatchObject({ status: 200 });
      harness.readResource.mockClear();
      harness.revokeSource();
      await expect(harness.managed.revalidateManagedProviderExplicitStarts(undefined, undefined, {
        facts: ['teams'],
      })).resolves.toBe(0);
      harness.failSourceReads();
      for (let turn = 0; turn < 3; turn++) {
        await expect(acquired.projection.access.request(providerRequest)).resolves.toMatchObject({ status: 200 });
      }
      expect(harness.readResource).not.toHaveBeenCalled();
      expect(harness.managed.readRetainedSemanticCustodyCount()).toBe(1);
      await acquired.retire();
      await expect(acquired.projection.access.request(providerRequest)).rejects.toMatchObject({
        failure: { reasonCode: 'source_unavailable' },
      });
      await expect(harness.acquire(new AbortController().signal)).resolves.toMatchObject({
        ok: false, reasonCode: 'source_unavailable',
      });
      expect(harness.childRequest).toHaveBeenCalledTimes(4);
    } finally {
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

  it('rejoins retained custody without rereading an unavailable Home source', async () => {
    const harness = sourceCustodyHarness();
    try {
      const acquired = await harness.acquire(new AbortController().signal);
      if (!acquired.ok) throw new Error('Expected source custody');
      harness.readResource.mockClear();
      harness.failSourceReads();
      const joined = await harness.acquire(new AbortController().signal);
      expect(joined).toMatchObject({ ok: true });
      if (!joined.ok) throw new Error('Expected retained source join');
      await expect(joined.projection.access.request({ method: 'POST', pathAndQuery: '/v1/responses' }))
        .resolves.toMatchObject({ status: 200 });
      expect(harness.readResource).not.toHaveBeenCalled();
      await expect(harness.managed.revalidateManagedProviderExplicitStarts()).resolves.toBe(0);
      expect(harness.childCleanup).not.toHaveBeenCalled();
      expect(harness.managed.readRetainedSemanticCustodyCount()).toBe(1);
      await joined.projection.cleanup();
      await acquired.projection.cleanup();
    } finally {
      await harness.managed.dispose();
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
    expect(isCpxBrokerApplication(registry, projected!)).toBe(true);
    expect(isCpxBrokerApplication({ providersByContributionKey: new Map() }, projected!)).toBe(false);
    expect(isCpxBrokerApplication(registry, { ...projected!, endpointTemplateId: 'cliproxyapi-anthropic' })).toBe(false);
    expect(isCpxBrokerApplication(registry, {
      ...projected!,
      implementationIdentity: { pluginId: 'happier.provider.other', localId: 'other' },
    })).toBe(false);
    expect(isCpxBrokerApplication(registry, {
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
      openConnectedServicesSource: async () => opened(current, retire),
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
      openConnectedServicesSource: async () => opened(stale, retire),
      openProviderConnectionSource: async () => opened(),
    });
    await expect(owner.acquire(request(accountSource))).resolves.toEqual({
      ok: false,
      reasonCode: 'source_unavailable',
      sourceOpenFailureReason: 'projection_not_current',
    });
    expect(stale.cleanup).toHaveBeenCalledOnce();
    expect(retire).toHaveBeenCalledOnce();
  });

});
