import { describe, expect, it, vi } from 'vitest';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import type { TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';

import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedServicesBrokerSourceOpen } from './connectedServicesSource';
import { createBrokerProviderRegistry } from './providerBroker.testkit';

const source = Object.freeze({
  v: 1 as const,
  kind: 'connected_account' as const,
  target: Object.freeze({
    kind: 'account' as const,
    account: Object.freeze({
      service: Object.freeze({
        pluginId: 'happier.agent.codex',
        localId: 'openai-codex',
      }),
      accountId: 'account-1',
    }),
  }),
  credentialIncarnation: 'credential-incarnation-1',
});

function resource(overrides: Partial<TeamCredentialResourceSummaryV1> = {}): TeamCredentialResourceSummaryV1 {
  // Complete summary row carrying the schema's canonical defaults; overrides
  // apply via Object.assign so `Partial` cannot re-widen required-nullable or
  // defaulted output fields back to `undefined`.
  const base: TeamCredentialResourceSummaryV1 = {
    id: 'resource-1',
    teamId: 'team-1',
    custodianAccountId: 'custodian-1',
    sourceOwnerDisplayName: null,
    displayName: 'Shared Codex',
    enabled: true,
    revision: 7,
    disclosureCeiling: 'brokered_only',
    sessionUsePolicy: 'personal_allowed',
    source,
    sourcePresentation: {
      kind: 'connected_service',
      service: source.target.account.service,
    },
    directExportSupport: 'unsupported',
    activeUsageLimitCount: 0,
    requestPolicy: null,
    brokerPlacement: { kind: 'machine', machineId: 'broker-machine' },
    allMembersDeliveryMode: null,
    groupGrants: [],
    memberGrants: [],
    readiness: { kind: 'available' },
    recoveryAction: null,
    brokerPresentation: {
      selectedTarget: null,
      eligibleTargets: [],
      selectedPool: null,
      eligiblePools: [],
    },
    capabilities: {
      manageAudience: false,
      managePolicy: false,
      manageLimits: false,
      updateBrokerPlacement: false,
      narrowDisclosure: false,
      widenDisclosure: false,
      refreshDirectMaterial: false,
      disable: false,
      enable: false,
      delete: false,
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  return Object.assign(base, overrides);
}

function request(signal = new AbortController().signal) {
  return {
    source,
    resourceId: 'resource-1',
    resourceRevision: 7,
    brokerMachineId: 'broker-machine',
    operation: { kind: 'session' as const, sessionId: 'session-1' },
    application: {
      agentTargetKey: 'codex',
      implementationIdentity: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      endpointTemplateId: 'cliproxyapi-openai-responses',
      protocol: 'openai-responses' as const,
    },
    signal,
  };
}

function bindingSelectionResolver(account: QualifiedConnectedAccountRef = source.target.account, pool?: Readonly<{
  group: { groupId: string; generation: number };
  isCurrent(): boolean;
}>) {
  const unusedBoundary = (): never => { throw new Error('Unexpected effect boundary'); };
  const owner = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unusedBoundary, subscribe: () => ({ dispose() {} }) },
    selectTarget: unusedBoundary,
    resolveTarget: async () => pool?.isCurrent() === false ? null : ({
      displayName: 'Account 1', account, ...(pool ? { group: pool.group } : {}),
    }),
    materializeAccount: unusedBoundary,
    projectTargetAccounts: unusedBoundary,
    assertTargetAccountMaterializable: unusedBoundary,
  });
  return vi.fn(owner.resolveBindingIntentSelection);
}

describe('Connected Services Team credential broker source', () => {
  it('refuses an excluded managed Provider before selecting credentials or acquiring custody', async () => {
    const readResource = vi.fn(async () => resource());
    const resolveBindingIntentSelection = bindingSelectionResolver();
    const acquire = vi.fn(async () => ({
      access: { endpointUrl: () => 'http://127.0.0.1:43120/v1', request: vi.fn() },
      isCurrent: () => true,
      cleanup: async () => {},
    }));
    const open = createConnectedServicesBrokerSourceOpen({
      readResource,
      resolveBindingIntentSelection,
      withRegistry: async (read) => await read({ providersByContributionKey: new Map() }),
      custody: {
        acquire,
        retire: async () => true,
        retireExternalApiKey: async () => true,
        revalidateRetainedClaims: async () => 0,
        retireAll: async () => 0,
      },
    });
    expect(await open(request())).toBeNull();
    expect(resolveBindingIntentSelection).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each([
    { service: source.target.account.service, endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses', purpose: 'openai-upstream' },
    { service: source.target.account.service, endpointTemplateId: 'cliproxyapi-anthropic', protocol: 'anthropic', purpose: 'openai-upstream' },
    { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses', purpose: 'anthropic-upstream' },
    { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, endpointTemplateId: 'cliproxyapi-openai-chat', protocol: 'openai-chat', purpose: 'anthropic-upstream' },
  ] as const)('qualifies $purpose from the admitted source for $protocol without binding another family', async ({ service, endpointTemplateId, protocol, purpose }) => {
    const account = { ...source.target.account, service };
    const exactSource = { ...source, target: { kind: 'account' as const, account } };
    const exactRequest = { ...request(), source: exactSource, application: { ...request().application, endpointTemplateId, protocol } };
    const readResource = vi.fn(async () => resource({ source: exactSource }));
    const resolveBindingIntentSelection = bindingSelectionResolver(account);
    const projection = Object.freeze({
      access: Object.freeze({
        endpointUrl: vi.fn(() => 'http://127.0.0.1:45123/v1'),
        request: vi.fn(),
      }),
      isCurrent: vi.fn(() => true),
      cleanup: vi.fn(),
    });
    const custody: ManagedProviderExplicitStartCustody = Object.freeze({
      acquire: vi.fn(async () => projection),
      retire: vi.fn(async () => true),
      retireExternalApiKey: vi.fn(async () => true),
      revalidateRetainedClaims: vi.fn(async () => 0),
      retireAll: vi.fn(async () => 0),
    });
    const open = createConnectedServicesBrokerSourceOpen({
      withRegistry: async (read) => await read(createBrokerProviderRegistry()),
      readResource,
      resolveBindingIntentSelection,
      custody,
    });

    await expect(open(exactRequest)).resolves.toMatchObject({ projection, sourceCurrentness: { sourceMember: { service, connectedAccountId: account.accountId } } });
    expect(resolveBindingIntentSelection).toHaveBeenCalledWith(expect.objectContaining({
      purpose: {
        consumer: {
          pluginId: 'happier.provider.cliproxyapi',
          localId: 'cliproxyapi',
        },
        purpose,
      },
      target: exactSource.target,
      serviceRefs: [service],
    }));
    expect(custody.acquire).toHaveBeenCalledWith(expect.objectContaining({
      contributionKey: 'happier.provider.cliproxyapi/cliproxyapi',
      operationClaim: { kind: 'providerBroker', operation: request().operation },
      request: {
        reason: 'explicitStartLocal',
        endpointTemplateIds: [endpointTemplateId],
      },
    }));
    const acquired = vi.mocked(custody.acquire).mock.calls[0]![0];
    expect(acquired.purposeBindings).toEqual({ v: 1, bindings: [{
      purpose: { consumer: request().application.implementationIdentity, purpose },
      target: exactSource.target,
    }] });
  });

  it('keeps the operation current across a policy edit, which only advances the resource revision', async () => {
    // The revision is a mutable policy fact the Home rechecks on every request
    // (`04-private-iroh-broker-transport.md:272`); it is not source identity.
    let revision = 7;
    const readResource = vi.fn(async () => resource({ revision }));
    const cleanup = vi.fn();
    const custody: ManagedProviderExplicitStartCustody = Object.freeze({
      acquire: vi.fn(async () => Object.freeze({
        access: Object.freeze({ endpointUrl: vi.fn(() => null), request: vi.fn() }),
        isCurrent: vi.fn(() => true),
        cleanup,
      })),
      retire: vi.fn(async () => true),
      retireExternalApiKey: vi.fn(async () => true),
      revalidateRetainedClaims: vi.fn(async () => 0),
      retireAll: vi.fn(async () => 0),
    });
    const open = createConnectedServicesBrokerSourceOpen({
      withRegistry: async (read) => await read(createBrokerProviderRegistry()),
      readResource,
      resolveBindingIntentSelection: bindingSelectionResolver(),
      custody,
    });

    const opened = await open(request());
    expect(opened).not.toBeNull();
    readResource.mockRejectedValueOnce(new Error('Home unreachable'));
    // The shared operation owner denies an uncertain read without retiring custody;
    // the next authoritative read can recover the same operation.
    await expect(opened!.sourceCurrentness.isCurrent()).resolves.toBe(false);
    revision = 8;
    await expect(opened!.sourceCurrentness.isCurrent()).resolves.toBe(true);
    // A real withdrawal of the resource still ends the operation.
    readResource.mockImplementation(async () => resource({ revision, enabled: false }));
    await expect(opened!.sourceCurrentness.isCurrent()).resolves.toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('releases custody when the resource is disabled during acquisition', async () => {
    let reads = 0;
    const readResource = vi.fn(async () => {
      reads += 1;
      return reads < 3 ? resource() : resource({ enabled: false });
    });
    const cleanup = vi.fn();
    const custody: ManagedProviderExplicitStartCustody = Object.freeze({
      acquire: vi.fn(async () => Object.freeze({
        access: Object.freeze({ endpointUrl: vi.fn(() => null), request: vi.fn() }),
        isCurrent: vi.fn(() => true),
        cleanup,
      })),
      retire: vi.fn(async () => true),
      retireExternalApiKey: vi.fn(async () => true),
      revalidateRetainedClaims: vi.fn(async () => 0),
      retireAll: vi.fn(async () => 0),
    });
    const open = createConnectedServicesBrokerSourceOpen({
      readResource,
      resolveBindingIntentSelection: bindingSelectionResolver(),
      withRegistry: async (read) => await read(createBrokerProviderRegistry()),
      custody,
    });

    await expect(open(request())).resolves.toBeNull();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each(['endpoint', 'protocol', 'service', 'implementation', 'source-proof'] as const)('fails closed before source custody for a mismatched %s', async (mismatch) => {
    const custody: ManagedProviderExplicitStartCustody = Object.freeze({
      acquire: vi.fn(async () => null),
      retire: vi.fn(async () => false),
      retireExternalApiKey: vi.fn(async () => false),
      revalidateRetainedClaims: vi.fn(async () => 0),
      retireAll: vi.fn(async () => 0),
    });
    const open = createConnectedServicesBrokerSourceOpen({
      withRegistry: async (read) => await read(createBrokerProviderRegistry()),
      readResource: vi.fn(async () => resource()),
      resolveBindingIntentSelection: bindingSelectionResolver(),
      custody,
    });

    const requested = request();
    const application = {
      ...requested.application,
      ...(mismatch === 'endpoint' ? { endpointTemplateId: 'unknown-endpoint' } : {}),
      ...(mismatch === 'protocol' ? { endpointTemplateId: 'cliproxyapi-anthropic' } : {}),
      ...(mismatch === 'implementation' ? { implementationIdentity: { pluginId: 'foreign', localId: 'cliproxyapi' } } : {}),
    };
    const wrongSource = mismatch === 'service' || mismatch === 'source-proof'
      ? { ...source, target: { ...source.target, account: { ...source.target.account,
        ...(mismatch === 'service' ? { service: { pluginId: 'foreign', localId: 'openai-codex' } } : { accountId: 'different-account' }),
      } } } : source;
    await expect(open({ ...requested, application, source: wrongSource })).resolves.toBeNull();
    expect(custody.acquire).not.toHaveBeenCalled();
  });

  it('accepts the Home-selected exact target for Pool placement without treating membership as an ongoing ACL', async () => {
    const readResource = vi.fn(async () => resource({
      brokerPlacement: { kind: 'machine_pool', poolId: 'pool-1' },
    }));
    const projection = Object.freeze({
      access: Object.freeze({ endpointUrl: vi.fn(() => 'http://127.0.0.1:45123/v1'), request: vi.fn() }),
      isCurrent: vi.fn(() => true),
      cleanup: vi.fn(),
    });
    const custody: ManagedProviderExplicitStartCustody = Object.freeze({
      acquire: vi.fn(async () => projection),
      retire: vi.fn(async () => true),
      retireExternalApiKey: vi.fn(async () => true),
      revalidateRetainedClaims: vi.fn(async () => 0),
      retireAll: vi.fn(async () => 0),
    });
    const open = createConnectedServicesBrokerSourceOpen({
      withRegistry: async (read) => await read(createBrokerProviderRegistry()),
      readResource,
      resolveBindingIntentSelection: bindingSelectionResolver(),
      custody,
    });

    await expect(open(request())).resolves.toMatchObject({ projection });
    expect(custody.acquire).toHaveBeenCalledOnce();
  });

  it('freezes a connected Pool selection to its exact member and retires it when the canonical selector changes', async () => {
    const poolSource = {
      v: 1 as const,
      kind: 'connected_pool' as const,
      target: {
        kind: 'group' as const,
        service: source.target.account.service,
        groupId: 'pool-1',
      },
      poolIncarnation: 'pool-incarnation-1',
    };
    let selectionCurrent = true;
    const selectedAccount = {
      service: source.target.account.service,
      accountId: 'selected-account-2',
    };
    const custody: ManagedProviderExplicitStartCustody = Object.freeze({
      acquire: vi.fn(async () => Object.freeze({
        access: Object.freeze({ endpointUrl: () => 'http://127.0.0.1:45123/v1', request: vi.fn() }),
        isCurrent: () => true,
        cleanup: vi.fn(),
      })),
      retire: vi.fn(async () => true),
      retireExternalApiKey: vi.fn(async () => true),
      revalidateRetainedClaims: vi.fn(async () => 0),
      retireAll: vi.fn(async () => 0),
    });
    const resolveBindingIntentSelection = bindingSelectionResolver(selectedAccount, {
      group: { groupId: 'pool-1', generation: 4 }, isCurrent: () => selectionCurrent,
    });
    const open = createConnectedServicesBrokerSourceOpen({
      withRegistry: async (read) => await read(createBrokerProviderRegistry()),
      readResource: vi.fn(async () => resource({
        source: poolSource,
        sourcePresentation: { kind: 'connected_service', service: poolSource.target.service },
        brokerPlacement: { kind: 'machine_pool', poolId: 'machines-1' },
      })),
      resolveBindingIntentSelection,
      custody,
    });

    const opened = await open({ ...request(), source: poolSource, application: {
      ...request().application, endpointTemplateId: 'cliproxyapi-anthropic', protocol: 'anthropic',
    } });
    expect(opened?.sourceCurrentness.sourceMember).toEqual({
      kind: 'connected_account',
      service: selectedAccount.service,
      connectedAccountId: selectedAccount.accountId,
    });
    expect(custody.acquire).toHaveBeenCalledWith(expect.objectContaining({
      purposeBindings: {
        v: 1,
        bindings: [expect.objectContaining({
          target: { kind: 'account', account: selectedAccount },
        })],
      },
    }));
    selectionCurrent = false;
    await expect(opened?.sourceCurrentness.isCurrent()).resolves.toBe(false);
    // Retirement is idempotent at the one broker-source acquisition owner, so
    // a repeated release never issues a second custody retirement.
    await opened?.retire();
    await opened?.retire();
    expect(custody.retire).toHaveBeenCalledOnce();
    expect(custody.retire).toHaveBeenLastCalledWith({
      identity: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      operationClaim: {
        kind: 'providerBroker',
        operation: { kind: 'session', sessionId: 'session-1' },
      },
    });
  });
});
