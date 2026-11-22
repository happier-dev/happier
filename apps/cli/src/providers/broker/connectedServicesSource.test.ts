import { describe, expect, it, vi } from 'vitest';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import type { TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';
import { PrivateLabelReadV1Schema } from '@happier-dev/protocol/crypto/privateLabelV1';
import { ProviderContributionV1Schema } from '@happier-dev/protocol/providers/contributions';

import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthService } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION,
  VERCEL_GATEWAY_PROVIDER_IDENTITY,
} from '../../../../../packages/plugins/vercel-ai-gateway/src/provider/contribution.js';
import { createConnectedServicesBrokerSourceMemberSelect, createConnectedServicesBrokerSourceOpen } from './connectedServicesSource';
import { createBrokerProviderRegistry, readProviderBrokerResponseBody } from './providerBroker.testkit';
import { createProviderConnectionHttpTransport } from './providerConnectionHttpTransport';

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
    displayName: PrivateLabelReadV1Schema.parse({ content: { t: 'plain', v: 'Shared Codex' }, recipientEnvelope: null }),
    enabled: true,
    revision: 7,
    deliveryPolicy: { preferredAllowedModes: ['brokered'] },
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
    allMembersAllowedRoutes: null,
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
      updateBrokerPlacement: false, updateDeliveryPolicy: false,
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

function bindingOwner(account: QualifiedConnectedAccountRef, pool?: Readonly<{
  group: { groupId: string; generation: number };
  isCurrent(): boolean;
}>) {
  const unusedBoundary = (): never => { throw new Error('Unexpected effect boundary'); };
  return createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unusedBoundary, subscribe: () => ({ dispose() {} }) },
    selectTarget: unusedBoundary,
    resolveTarget: async () => pool?.isCurrent() === false ? null : ({
      displayName: 'Account 1', account, ...(pool ? { group: pool.group } : {}),
    }),
    materializeAccount: unusedBoundary,
    projectTargetAccounts: unusedBoundary,
    assertTargetAccountMaterializable: unusedBoundary,
  });
}

function bindingSelectionResolver(account: QualifiedConnectedAccountRef = source.target.account, pool?: Parameters<typeof bindingOwner>[1]) {
  return vi.fn(bindingOwner(account, pool).resolveBindingIntentSelection);
}

describe('Connected Services Team credential broker source', () => {
  it('forwards only the saved Account purpose and never accepts a second Provider for that Account', async () => {
    const provider = VERCEL_GATEWAY_PROVIDER_IDENTITY;
    const otherProvider = { pluginId: 'example.provider.other', localId: 'other' };
    const definition = ProviderContributionV1Schema.parse(VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION);
    const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'vercel-team-one' };
    const qualified = {
      ...source, target: { ...source.target, account },
      providerPurpose: { consumer: provider, purpose: 'model-inference' },
    };
    const registry = createResolvedContributionRegistry({ providers: [provider, otherProvider].map(identity => ({
      identity, pluginId: identity.pluginId, definition: { ...definition, id: identity.localId },
      provenance: 'external', source: { kind: 'path' },
    })) });
    const purposeBindings = bindingOwner(account);
    const materialize = vi.fn(async () => ({
      headers: { authorization: 'Bearer test-account-credential', 'x-vercel-ai-gateway-team': 'team_from_account' },
      facts: { teamId: 'team_from_account' },
    }));
    const requestAuth = createConnectedAccountRequestAuthService({
      resolveCurrentBinding: ({ binding }) => binding.target.kind === 'account'
        ? { account: binding.target.account, credentialRevision: 'revision-1' } : null,
      materializeHeaders: materialize,
      refreshAfterAuthFailure: async () => ({ status: 'current_unchanged' }),
      reportQuotaFailure: async () => ({ status: 'current_unchanged' }),
    });
    const openHttp = vi.fn(async () => {
      const chunks = ['echo test-account-', 'credential'];
      return { status: 200, headers: { 'x-vendor-echo': 'test-account-credential' }, contentLength: null,
        read: async () => chunks.length ? new TextEncoder().encode(chunks.shift()!) : null, cancel() {} };
    });
    const readResource = vi.fn(async () => resource({ source: qualified }));
    const custody = { acquire: vi.fn(async () => null), retire: async () => true, retireExternalApiKey: async () => true,
      revalidateRetainedClaims: async () => 0, retireAll: async () => 0 };
    const open = createConnectedServicesBrokerSourceOpen({
      withRegistry: async read => await read(registry),
      readResource, resolveBindingIntentSelection: purposeBindings.resolveBindingIntentSelection, purposeBindings, requestAuth, custody,
      resolveAddresses: async () => ['93.184.215.14'],
      transport: createProviderConnectionHttpTransport({ openHttp }),
    });
    const input = request();
    const application = { ...input.application, implementationIdentity: provider, endpointTemplateId: 'vercel-responses' };
    await expect(open({ ...input, source: qualified, application: { ...application, implementationIdentity: otherProvider } }))
      .resolves.toEqual({ unavailable: 'source_selection_unavailable' });
    expect(openHttp).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    const result = await open({ ...input, source: qualified, application });
    if ('unavailable' in result) throw new Error(result.unavailable);
    try {
      const response = await result.projection.access.request({
        method: 'POST', pathAndQuery: '/v1/responses?teamId=caller-one&teamId=caller-two&beta=true',
        headers: { authorization: 'Bearer caller', 'x-api-key': 'caller-key', 'x-vercel-ai-gateway-team': 'caller-team' },
      });
      expect(openHttp).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        url: 'https://ai-gateway.vercel.sh/codex/v1/responses?teamId=team_from_account&beta=true',
        validatedAddresses: ['93.184.215.14'],
        headers: {
          authorization: 'Bearer test-account-credential', 'x-vercel-ai-gateway-team': 'team_from_account',
          'http-referer': 'https://happier.dev', 'x-title': 'Happier', 'accept-encoding': 'identity',
        },
      }));
      expect(response.status).toBe(200);
      expect(response.headers).toEqual({});
      expect(new TextDecoder().decode(await readProviderBrokerResponseBody(response.body))).not.toContain('test-account-credential');
      expect(materialize).toHaveBeenCalledOnce();
      expect(readResource).not.toHaveBeenCalled();
      expect(custody.acquire).not.toHaveBeenCalled();
    } finally {
      await result.projection.cleanup();
    }
  });

  it('refuses an application that declares the Account but not the saved Provider purpose', async () => {
    const input = request();
    const qualified = {
      ...source,
      providerPurpose: { consumer: input.application.implementationIdentity, purpose: 'anthropic-upstream' },
    };
    const acquire = vi.fn(async () => ({
      access: { endpointUrl: () => 'http://127.0.0.1:43120/v1', request: vi.fn() },
      isCurrent: () => true,
      cleanup: async () => {},
    }));
    const open = createConnectedServicesBrokerSourceOpen({
      readResource: async () => resource({ source: qualified }),
      resolveBindingIntentSelection: bindingSelectionResolver(),
      withRegistry: async read => await read(createBrokerProviderRegistry()),
      custody: { acquire, retire: async () => true, retireExternalApiKey: async () => true,
        revalidateRetainedClaims: async () => 0, retireAll: async () => 0 },
    });
    expect(await open({ ...input, source: qualified })).toEqual({ unavailable: 'source_selection_unavailable' });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('selects the signed exact member when the connected target changes after admission', async () => {
    const unusedBoundary = (): never => { throw new Error('Unexpected effect boundary'); };
    const owner = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unusedBoundary, subscribe: () => ({ dispose() {} }) },
      selectTarget: unusedBoundary,
      resolveTarget: async () => null,
      materializeAccount: unusedBoundary,
      projectTargetAccounts: unusedBoundary,
      assertTargetAccountMaterializable: unusedBoundary,
    });
    const resolveBindingIntentSelection = vi.fn(owner.resolveBindingIntentSelection);
    const select = createConnectedServicesBrokerSourceMemberSelect({
      withRegistry: async read => await read(createBrokerProviderRegistry()),
      resolveBindingIntentSelection,
    });

    await expect(select(request())).resolves.toEqual({
      kind: 'connected_account',
      service: source.target.account.service,
      connectedAccountId: source.target.account.accountId,
    });
    expect(resolveBindingIntentSelection).not.toHaveBeenCalled();
  });

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
    expect(await open(request())).toEqual({ unavailable: 'source_selection_unavailable' });
    expect(resolveBindingIntentSelection).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each([
    { service: source.target.account.service, endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses', purpose: 'openai-upstream' },
    { service: source.target.account.service, endpointTemplateId: 'cliproxyapi-anthropic', protocol: 'anthropic', purpose: 'openai-upstream' },
    { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses', purpose: 'anthropic-upstream' },
    { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, endpointTemplateId: 'cliproxyapi-openai-chat', protocol: 'openai-chat', purpose: 'anthropic-upstream' },
  ] as const)('qualifies $purpose for $protocol and retains its gateway refusal', async ({ service, endpointTemplateId, protocol, purpose }) => {
    const account = { ...source.target.account, service };
    const exactSource = { ...source, target: { kind: 'account' as const, account } };
    const exactRequest = { ...request(), source: exactSource, application: { ...request().application, endpointTemplateId, protocol } };
    const readResource = vi.fn(async () => resource({ source: exactSource }));
    const resolveBindingIntentSelection = bindingSelectionResolver(account);
    const projection = Object.freeze({
      access: Object.freeze({
        endpointUrl: vi.fn(() => 'http://127.0.0.1:45123/v1'),
        request: async () => ({ ok: false, status: 503, statusText: 'Service Unavailable',
          headers: { 'x-happier-provider-broker-error-code': 'broker_unavailable' },
          body: new Response('gateway refusal').body }),
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

    const opened = await open(exactRequest);
    expect(opened).toMatchObject({ sourceMember: { service, connectedAccountId: account.accountId } });
    if (!opened || 'unavailable' in opened) throw new Error('Expected connected source');
    expect(opened.projection.access.endpointUrl(endpointTemplateId)).toBe('http://127.0.0.1:45123/v1');
    await expect(opened.projection.access.request({ method: 'POST', pathAndQuery: '/v1/responses' })).rejects.toMatchObject({
      failure: { ok: false, reasonCode: 'broker_unavailable' },
    });
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

  it('releases custody when the resource is disabled during acquisition', async () => {
    let reads = 0;
    const readResource = vi.fn(async () => {
      reads += 1;
      return reads < 2 ? resource() : resource({ enabled: false });
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

    await expect(open(request())).resolves.toEqual({ unavailable: 'managed_custody_unavailable' });
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
    await expect(open({ ...requested, application, source: wrongSource })).resolves.toEqual({
      unavailable: 'source_selection_unavailable',
    });
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

    const opened = await open(request());
    expect(opened).toHaveProperty('projection');
    if (!('projection' in opened)) throw new Error('Expected an admitted broker source');
    expect(opened.projection.access.endpointUrl(request().application.endpointTemplateId)).toBe('http://127.0.0.1:45123/v1');
    expect(opened.projection.isCurrent()).toBe(true);
    expect(custody.acquire).toHaveBeenCalledOnce();
  });

  it('freezes a connected Pool selection to its admitted member until explicit retirement', async () => {
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
      group: { groupId: 'pool-1', generation: 4 }, isCurrent: () => true,
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
    if ('unavailable' in opened) throw new Error('Expected current Pool source');
    expect(opened?.sourceMember).toEqual({
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
