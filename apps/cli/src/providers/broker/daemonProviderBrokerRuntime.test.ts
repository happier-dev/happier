import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import axios, { AxiosError } from 'axios';
import tweetnacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IROH_MACHINE_ADMISSION_PATH,
  IROH_MACHINE_APPLICATION_CAPABILITY_HEADER,
  IROH_MACHINE_APPLICATION_PORT_HEADER,
  IROH_MACHINE_REMOTE_ENDPOINT_HEADER,
} from '@happier-dev/iroh-native/node';
import {
  createProviderBrokerRouteGrantSigningInputV1,
  encodeProviderBrokerAuthorityV1,
  type ProviderBrokerApplicationBindingV1,
  type SignedProviderBrokerRouteGrantV1,
} from '@happier-dev/protocol';
import { createPeerMediationLoopbackApp } from '@/daemon/peer/mediation/loopback/server';
import { createProviderBrokerRouteGrantSigningInputV2, type SignedProviderBrokerRouteGrantV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, ProviderConnectionIdSchema,
  ProviderContributionV1Schema, ProviderSettingsV1Schema, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { PROVIDER_BROKER_PRIVATE_CLOSE_PATH, PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH,
  PROVIDER_BROKER_MODEL_ID_HEADER, PROVIDER_BROKER_ENDPOINT_PATH_HEADER } from './providerBrokerPrivateProtocol';
import { createBrokerProviderRegistry } from './providerBroker.testkit';
import {
  computeTeamCredentialSourceMemberKeyV1,
  TEAM_CREDENTIAL_EXTERNAL_PROVIDER_APPLICATION_HTTP_PATH_V1,
  type TeamCredentialResourceSummaryV1,
} from '@happier-dev/protocol/teams';

import type { ManagedProviderEndpointHttpAccess } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { logger } from '@/ui/logger';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import { createAccountConnectionBrokerSourceOpen, retireAccountConnectionBrokerSource } from './accountConnectionSource';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { projectProviderBrokerApplication } from './applicationProjection';
import { refreshActiveProviderConnectionsCatalog } from '@/providers/settings/hydrate';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
  createConnectedServicesBrokerSourceMemberSelect,
  createConnectedServicesBrokerSourceOpen,
} from './connectedServicesSource';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import {
  createTeamCredentialBrokerSourceOwner,
  type TeamCredentialBrokerOperation,
  type TeamCredentialBrokerSourceOwner,
} from './teamCredentialBrokerSourceOwner';
import {
  createPrivateProviderBrokerStreamLifetime,
  revalidateExternalProviderBrokerAuthorization,
  resolveRunnerCredentialSelectionCurrentness,
  startDaemonProviderBrokerRuntime,
} from './daemonProviderBrokerRuntime';

const authority = {
  payload: {
    v: 1 as const,
    grantId: 'grant-1',
    aud: 'happier-provider-broker-route-v1' as const,
    issuedAt: 100,
    expiresAt: 200,
    teamId: 'team-1',
    resourceId: 'resource-1',
    sourceRevision: 'source-revision-7',
    brokerPlacementFingerprint: 'c'.repeat(64),
    initiatorTokenEpoch: 0,
    initiator: { accountId: 'worker-account', machineId: 'worker-machine', endpointId: 'a'.repeat(64) },
    target: { custodianAccountId: 'custodian-account', machineId: 'broker-machine', endpointId: 'b'.repeat(64) },
    consumer: { kind: 'session' as const, sessionId: 'session-1' },
    application: {
      agentTargetKey: 'codex',
      implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'cliproxyapi-openai-responses',
      protocol: 'openai-responses' as const,
    },
  },
  signature: { alg: 'Ed25519' as const, keyId: 'home', valueBase64Url: 'A'.repeat(86) },
};

const source = {
  v: 1 as const,
  kind: 'connected_account' as const,
  target: {
    kind: 'account' as const,
    account: {
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      accountId: 'source-account',
    },
  },
  credentialIncarnation: 'credential-row-1',
};

const closeTasks: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closeTasks.splice(0).map((close) => close()));
  resetActiveAccountSettingsSnapshotForTests();
});

describe('resolveRunnerCredentialSelectionCurrentness', () => {
  const application = authority.payload.application;
  const selection = {
    v: 1 as const,
    resourceId: 'resource-1',
    brokerMachineId: 'broker-machine',
    revision: 7,
    application,
    sourceRevision: 'source-revision-7',
  };
  const resource = (overrides: Partial<TeamCredentialResourceSummaryV1> = {}): TeamCredentialResourceSummaryV1 => {
    // Complete summary row carrying the schema's canonical defaults; overrides
    // apply via Object.assign so `Partial` cannot re-widen required-nullable or
    // defaulted output fields back to `undefined`.
    const base: TeamCredentialResourceSummaryV1 = {
      id: 'resource-1',
      teamId: 'team-1',
      custodianAccountId: 'custodian-account',
      sourceOwnerDisplayName: null,
      displayName: 'Shared Codex',
      enabled: true,
      revision: 7,
      deliveryPolicy: { preferredAllowedModes: ['brokered'] },
      sessionUsePolicy: 'personal_allowed',
      source,
      sourcePresentation: { kind: 'connected_service', service: source.target.account.service },
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
  };

  it('accepts a Pool-frozen exact Machine only when that selected daemon is currently eligible', async () => {
    const resolveEligibility = vi.fn(async () => ({ status: 'eligible' as const }));

    await expect(resolveRunnerCredentialSelectionCurrentness({
      registeredMachineId: 'broker-machine',
      selection,
      modelId: 'gpt-5',
      signal: new AbortController().signal,
      readResource: async () => resource({ brokerPlacement: { kind: 'machine_pool', poolId: 'pool-1' } }),
      resolveEligibility,
    })).resolves.toBe('available');

    expect(resolveEligibility).toHaveBeenCalledWith({
      machineId: 'broker-machine',
      teamId: 'team-1',
      resourceId: 'resource-1',
      expectedResourceRevision: 7,
      source,
      application,
      modelId: 'gpt-5',
      sourceRevision: 'source-revision-7',
    }, expect.any(AbortSignal));
  });

  it('does not let another eligible Pool member mask an unavailable selected daemon', async () => {
    const resolveEligibility = vi.fn(async (request: Readonly<{ machineId: string }>) => request.machineId === 'other-pool-member'
      ? { status: 'eligible' as const }
      : { status: 'unavailable' as const, reason: 'model_unavailable' as const });

    await expect(resolveRunnerCredentialSelectionCurrentness({
      registeredMachineId: 'broker-machine',
      selection,
      modelId: 'gpt-5',
      signal: new AbortController().signal,
      readResource: async () => resource({ brokerPlacement: { kind: 'machine_pool', poolId: 'pool-1' } }),
      resolveEligibility,
    })).resolves.toBe('source_unavailable');

    expect(resolveEligibility).toHaveBeenCalledOnce();
    expect(resolveEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 'broker-machine' }),
      expect.any(AbortSignal),
    );
  });

  it('preserves ordinary exact-Machine readiness through the same exact eligibility owner', async () => {
    const resolveEligibility = vi.fn(async () => ({ status: 'eligible' as const }));
    await expect(resolveRunnerCredentialSelectionCurrentness({
      registeredMachineId: 'broker-machine',
      selection,
      modelId: 'gpt-5',
      signal: new AbortController().signal,
      readResource: async () => resource(),
      resolveEligibility,
    })).resolves.toBe('available');
    expect(resolveEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: 'broker-machine', modelId: 'gpt-5' }),
      expect.any(AbortSignal),
    );
  });

  it('denies a frozen selection that is not this daemon or the resource exact placement', async () => {
    const resolveEligibility = vi.fn(async () => ({ status: 'eligible' as const }));
    const signal = new AbortController().signal;

    await expect(resolveRunnerCredentialSelectionCurrentness({
      registeredMachineId: 'other-machine',
      selection,
      modelId: 'gpt-5',
      signal,
      readResource: async () => resource({ brokerPlacement: { kind: 'machine_pool', poolId: 'pool-1' } }),
      resolveEligibility,
    })).resolves.toBe('source_unavailable');
    await expect(resolveRunnerCredentialSelectionCurrentness({
      registeredMachineId: 'broker-machine',
      selection,
      modelId: 'gpt-5',
      signal,
      readResource: async () => resource({ brokerPlacement: { kind: 'machine', machineId: 'different-machine' } }),
      resolveEligibility,
    })).resolves.toBe('source_unavailable');

    expect(resolveEligibility).not.toHaveBeenCalled();
  });

  it('fails closed for a malformed selected-daemon eligibility response', async () => {
    await expect(resolveRunnerCredentialSelectionCurrentness({
      registeredMachineId: 'broker-machine',
      selection,
      modelId: 'gpt-5',
      signal: new AbortController().signal,
      readResource: async () => resource({ brokerPlacement: { kind: 'machine_pool', poolId: 'pool-1' } }),
      resolveEligibility: async () => ({ status: 'eligible', extra: true }),
    })).resolves.toBe('source_unavailable');
  });

  it.each([
    ['missing placement', { brokerPlacement: null }],
    ['disabled resource', { enabled: false }],
    ['stale resource revision', { revision: 8 }],
    ['missing source', { source: null }],
  ] satisfies ReadonlyArray<readonly [string, Partial<TeamCredentialResourceSummaryV1>]>)('fails closed for %s before local source work', async (_name, overrides) => {
    const resolveEligibility = vi.fn(async () => ({ status: 'eligible' as const }));
    await expect(resolveRunnerCredentialSelectionCurrentness({
      registeredMachineId: 'broker-machine',
      selection,
      modelId: 'gpt-5',
      signal: new AbortController().signal,
      readResource: async () => resource(overrides),
      resolveEligibility,
    })).resolves.toBe('source_unavailable');
    expect(resolveEligibility).not.toHaveBeenCalled();
  });

  it('distinguishes an unsupported application from stale source/model currentness', async () => {
    const base = {
      registeredMachineId: 'broker-machine',
      selection,
      modelId: 'gpt-5',
      signal: new AbortController().signal,
      readResource: async () => resource({ brokerPlacement: { kind: 'machine_pool', poolId: 'pool-1' } }),
    } as const;
    await expect(resolveRunnerCredentialSelectionCurrentness({
      ...base,
      resolveEligibility: async () => ({ status: 'unavailable', reason: 'application_unavailable' }),
    })).resolves.toBe('update_required');
    await expect(resolveRunnerCredentialSelectionCurrentness({
      ...base,
      resolveEligibility: async () => ({ status: 'unavailable', reason: 'source_changed' }),
    })).resolves.toBe('source_unavailable');
  });
});

async function requestThroughApplicationTarget(input: Readonly<{
  port: number;
  localCapability: string;
}>): Promise<string> {
  const body = JSON.stringify({ model: 'gpt-5', input: 'hello' });
  const request = [
    'POST /v1/responses HTTP/1.1',
    'Host: 127.0.0.1',
    `Authorization: Bearer ${encodeProviderBrokerAuthorityV1(authority)}`,
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n');

  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: input.port });
    const chunks: Buffer[] = [];
    socket.once('connect', () => {
      socket.write(input.localCapability, 'ascii');
      // Keep the response half open. The client requested `Connection: close`,
      // so the application owns closing only after the streamed result lands.
      socket.write(request, 'utf8');
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function requestThroughExternalApplicationTarget(input: Readonly<{
  port: number;
  localCapability: string;
  body: unknown;
}>): Promise<string> {
  const body = JSON.stringify(input.body);
  const request = [
    `POST ${TEAM_CREDENTIAL_EXTERNAL_PROVIDER_APPLICATION_HTTP_PATH_V1} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n');

  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: input.port });
    const chunks: Buffer[] = [];
    socket.once('connect', () => {
      socket.write(input.localCapability, 'ascii');
      socket.write(request, 'utf8');
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

describe('revalidateExternalProviderBrokerAuthorization', () => {
  it('keeps transient Home refusals distinct from operation authority loss', () => {
    expect(revalidateExternalProviderBrokerAuthorization({ ok: true })).toBe(true);
    for (const reasonCode of ['resource_forbidden', 'session_not_active', 'operation_not_current',
      'execution_run_not_found', 'execution_run_terminal'] as const) {
      expect(revalidateExternalProviderBrokerAuthorization({ ok: false, reasonCode })).toBe(false);
    }
    for (const reasonCode of ['resource_unavailable', 'resource_changed'] as const) {
      expect(() => revalidateExternalProviderBrokerAuthorization({ ok: false, reasonCode }))
        .toThrow('external broker authority unavailable');
    }
  });
});

describe('startDaemonProviderBrokerRuntime', () => {
  it('records one failed terminal fact when source acquisition is lost after external admission', async () => {
    const binding = {
      v: 1 as const,
      kind: 'external_api_key' as const,
      teamId: 'team-1',
      resourceId: 'resource-1',
      requestId: 'request-1',
      externalApiKeyId: '550e8400-e29b-41d4-a716-446655440000',
      operationId: '550e8400-e29b-41d4-a716-446655440001',
      brokerPlacementFingerprint: 'c'.repeat(64),
      assignedAccountId: 'worker-account',
      assignedTeamMembershipId: 'membership-1',
    };
    const recordExternalTerminalUsage = vi.fn(async () => ({
      ok: true as const,
      usageEventId: 'terminal-usage-1',
      created: true,
    }));
    const revalidateExternalAuthorization = vi.fn(async () => false);
    const acquire = vi.fn(async (request: Parameters<TeamCredentialBrokerSourceOwner['acquire']>[0]) => {
      expect(await request.revalidateOperationAuthorization?.()).toBe(false);
      return { ok: false as const, reasonCode: 'source_unavailable' as const };
    });
    const runtime = await startDaemonProviderBrokerRuntime({
      machineId: 'broker-machine',
      resolveTrustRoots: () => [],
      nowMs: () => 150,
      resolveRequestPolicy: vi.fn(),
      admitRequest: vi.fn(),
      authorizeModelCatalog: vi.fn(),
      resolveExternalRequestPolicy: async () => ({
        kind: 'application' as const,
        resourceRevision: 7,
        policy: null,
        modelCatalog: {
          models: [{ id: 'gpt-5' }],
          resolveCanonicalModelId: (modelId: string) => modelId,
        },
        application: authority.payload.application,
      }),
      admitExternalRequest: async () => ({
        ok: true as const,
        resourceId: 'resource-1',
        resourceRevision: 7,
        brokerMachineId: 'broker-machine',
        source,
        operation: {
          kind: 'external_api_key' as const,
          externalApiKeyId: binding.externalApiKeyId,
          operationId: binding.operationId,
          assignedAccountId: binding.assignedAccountId,
          assignedTeamMembershipId: binding.assignedTeamMembershipId,
        },
        usageEventId: 'admission-usage-1',
        terminalRequestId: `external:${binding.externalApiKeyId}:${binding.requestId}`,
      }),
      recordExternalTerminalUsage,
      revalidateExternalAuthorization,
      sourceOwner: Object.freeze({
        selectSourceMemberKey: async () => null,
        acquire,
        retireOperation: async () => undefined,
      }),
      createRequestId: () => 'unused',
    });
    closeTasks.push(runtime.close);
    const target = await runtime.resolveExternalProviderBrokerApplicationTarget({ binding });
    if (!target) throw new Error('external target unavailable');

    const response = await requestThroughExternalApplicationTarget({
      ...target,
      body: {
        v: 1,
        requestId: binding.requestId,
        teamId: binding.teamId,
        resourceId: binding.resourceId,
        caller: {
          kind: 'external_api_key',
          keyId: binding.externalApiKeyId,
          assignedAccountId: binding.assignedAccountId,
          assignedTeamMembershipId: binding.assignedTeamMembershipId,
        },
        route: 'responses',
        method: 'POST',
        pathAndQuery: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from('{"model":"gpt-5","input":"hello"}').toString('base64'),
      },
    });

    expect(response).toContain('HTTP/1.1 403 Forbidden');
    expect(recordExternalTerminalUsage).toHaveBeenCalledOnce();
    expect(revalidateExternalAuthorization).toHaveBeenCalledWith({
      binding,
      expectedResourceRevision: 7,
      application: authority.payload.application,
    });
    expect(recordExternalTerminalUsage).toHaveBeenCalledWith({
      v: 1,
      admissionUsageEventId: 'admission-usage-1',
      requestId: `external:${binding.externalApiKeyId}:${binding.requestId}`,
      brokerMachineId: 'broker-machine',
      completedAtMs: 150,
      outcome: 'failed',
      measurement: 'unavailable',
      actualModelId: null,
      tokens: null,
    });
  });

  it.each([
    ['resource_unavailable', false],
    ['resource_forbidden', true],
  ] as const)('retires retained external custody only for known authority loss: %s', async (reasonCode, retires) => {
    const binding = {
      v: 1 as const,
      kind: 'external_api_key' as const,
      teamId: 'team-1',
      resourceId: 'resource-1',
      requestId: 'request-revoked',
      externalApiKeyId: '550e8400-e29b-41d4-a716-446655440000',
      operationId: '550e8400-e29b-41d4-a716-446655440001',
      brokerPlacementFingerprint: 'c'.repeat(64),
      assignedAccountId: 'worker-account',
      assignedTeamMembershipId: 'membership-1',
    };
    const retireExternalApiKey = vi.fn(async () => true);
    const runtime = await startDaemonProviderBrokerRuntime({
      machineId: 'broker-machine',
      resolveTrustRoots: () => [],
      nowMs: () => 150,
      resolveRequestPolicy: vi.fn(),
      admitRequest: vi.fn(),
      authorizeModelCatalog: vi.fn(),
      resolveExternalRequestPolicy: async () => ({
        kind: 'application' as const,
        resourceRevision: 7,
        policy: null,
        modelCatalog: {
          models: [{ id: 'gpt-5' }],
          resolveCanonicalModelId: (modelId: string) => modelId,
        },
        application: authority.payload.application,
      }),
      admitExternalRequest: async () => ({
        ok: false as const,
        reasonCode,
      }),
      recordExternalTerminalUsage: vi.fn(),
      retireExternalApiKey,
      sourceOwner: createTeamCredentialBrokerSourceOwner({
        selectConnectedServicesSourceMember: async () => null,
        custody: { retire: async () => true },
        machineId: 'broker-machine',
        openConnectedServicesSource: async () => null,
        openProviderConnectionSource: async () => null,
      }),
      createRequestId: () => 'unused',
    });
    closeTasks.push(runtime.close);
    const target = await runtime.resolveExternalProviderBrokerApplicationTarget({ binding });
    if (!target) throw new Error('external target unavailable');

    const response = await requestThroughExternalApplicationTarget({
      ...target,
      body: {
        v: 1,
        requestId: binding.requestId,
        teamId: binding.teamId,
        resourceId: binding.resourceId,
        caller: {
          kind: 'external_api_key',
          keyId: binding.externalApiKeyId,
          assignedAccountId: binding.assignedAccountId,
          assignedTeamMembershipId: binding.assignedTeamMembershipId,
        },
        route: 'responses',
        method: 'POST',
        pathAndQuery: '/v1/responses',
        headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from('{"model":"gpt-5","input":"hello"}').toString('base64'),
      },
    });

    expect(response).toContain('HTTP/1.1 403 Forbidden');
    if (retires) {
      expect(retireExternalApiKey).toHaveBeenCalledWith({
        externalApiKeyId: binding.externalApiKeyId,
        operationId: binding.operationId,
        application: authority.payload.application,
      });
    } else {
      expect(retireExternalApiKey).not.toHaveBeenCalled();
    }
  });

  it.each([
    { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, protocol: 'openai-responses', endpointTemplateId: 'cliproxyapi-openai-responses', purpose: 'openai-upstream', modelId: 'gpt-5' },
    { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, protocol: 'anthropic', endpointTemplateId: 'cliproxyapi-anthropic', purpose: 'openai-upstream', modelId: 'gpt-5' },
    { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, protocol: 'openai-responses', endpointTemplateId: 'cliproxyapi-openai-responses', purpose: 'anthropic-upstream', modelId: 'claude-sonnet-4-5' },
  ] as const)('streams $purpose through signed $protocol admission and exact source custody', async ({ service, protocol, endpointTemplateId, purpose, modelId }) => {
    const authority = signedAuthority({ ...signedAuthority().payload,
      application: { ...signedAuthority().payload.application, endpointTemplateId, protocol },
    });
    const source = { v: 1 as const, kind: 'connected_account' as const,
      target: { kind: 'account' as const, account: { service, accountId: 'source-account' } },
      credentialIncarnation: 'credential-row-1',
    };
    const upstream = createServer((request, response) => {
      expect(request.headers.authorization).toBeUndefined();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    closeTasks.push(async () => await new Promise<void>((resolve) => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('upstream unavailable');

    const access: ManagedProviderEndpointHttpAccess = {
      endpointUrl: () => `http://127.0.0.1:${address.port}${protocol === 'anthropic' ? '/' : '/v1'}`,
      request: async (request) => {
        const response = await fetch(`http://127.0.0.1:${address.port}${request.pathAndQuery}`, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          // The genuine fetch boundary accepts the same native signal; its
          // installed overload uses a legacy global AbortSignal declaration.
          signal: request.signal as NonNullable<Parameters<typeof fetch>[1]>['signal'],
        });
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: response.body,
        };
      },
    };
    const dispatchOrder: string[] = [];
    const cleanup = vi.fn(async () => {});
    const resource: TeamCredentialResourceSummaryV1 = {
      id: 'resource-1', teamId: 'team-1', custodianAccountId: 'custodian-account',
      sourceOwnerDisplayName: null,
      displayName: 'Shared Codex', enabled: true, revision: 7,
      deliveryPolicy: { preferredAllowedModes: ['brokered'] }, sessionUsePolicy: 'personal_allowed',
      source,
      sourcePresentation: { kind: 'connected_service', service: source.target.account.service },
      directExportSupport: 'unsupported', activeUsageLimitCount: 0,
      requestPolicy: null,
      brokerPlacement: { kind: 'machine', machineId: 'broker-machine' },
      allMembersAllowedRoutes: null,
      groupGrants: [], memberGrants: [], readiness: { kind: 'available' }, recoveryAction: null,
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
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    };
    const readResource = vi.fn(async () => resource);
    const unusedBoundary = (): never => { throw new Error('Unexpected effect boundary'); };
    const bindingOwner = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unusedBoundary, subscribe: () => ({ dispose() {} }) },
      selectTarget: unusedBoundary,
      resolveTarget: async () => ({ displayName: 'Account 1', account: source.target.account }),
      materializeAccount: unusedBoundary,
      projectTargetAccounts: unusedBoundary,
      assertTargetAccountMaterializable: unusedBoundary,
    });
    const resolveBindingIntentSelection = vi.fn(bindingOwner.resolveBindingIntentSelection);
    const custody: ManagedProviderExplicitStartCustody = Object.freeze({
      acquire: vi.fn(async () => {
        dispatchOrder.push('source-selection');
        return { access, isCurrent: () => true, cleanup };
      }),
      retire: vi.fn(async () => true),
      retireExternalApiKey: vi.fn(async () => true),
      revalidateRetainedClaims: vi.fn(async () => 0),
      retireAll: vi.fn(async () => 0),
    });
    const openConnectedServicesSource = createConnectedServicesBrokerSourceOpen({
      withRegistry: async (read) => await read(createBrokerProviderRegistry()),
      readResource,
      resolveBindingIntentSelection,
      custody,
    });
    const sourceOwner = createTeamCredentialBrokerSourceOwner({
      selectConnectedServicesSourceMember: createConnectedServicesBrokerSourceMemberSelect({
        withRegistry: async (read) => await read(createBrokerProviderRegistry()),
        resolveBindingIntentSelection,
      }),
      custody: { retire: async () => true },
      machineId: 'broker-machine',
      openConnectedServicesSource,
      openProviderConnectionSource: async () => null,
    });
    const runtime = await startDaemonProviderBrokerRuntime({
      machineId: 'broker-machine',
      resolveTrustRoots: () => homeTrustRoots,
      nowMs: () => 150,
      resolveRequestPolicy: async () => {
        dispatchOrder.push('policy');
        return {
          resourceRevision: 7,
          sourceRevision: 'source-revision-7',
          application: authority.payload.application,
          policy: null,
          modelCatalog: {
            models: [{ id: modelId }],
            resolveCanonicalModelId: (modelId: string) => modelId,
          },
          source,
        };
      },
      admitRequest: async (admission) => {
        dispatchOrder.push('usage-admission');
        expect(admission.sourceMemberKey).toBe(computeTeamCredentialSourceMemberKeyV1({
          kind: 'connected_account',
          service: source.target.account.service,
          connectedAccountId: source.target.account.accountId,
        }));
        return { ok: true as const, resourceId: 'resource-1', brokerMachineId: 'broker-machine', source, operation: authority.payload.consumer, usageEventId: 'usage-1' };
      },
      authorizeModelCatalog: async () => { dispatchOrder.push('metadata-admission'); return { ok: true as const }; },
      sourceOwner,
      createRequestId: () => 'request-1',
    });
    closeTasks.push(runtime.close);

    const openTarget = () => runtime.resolveProviderBrokerApplicationTarget({
      handshake: { v: 1, kind: 'provider_broker', authority },
      authority,
      authenticatedRemoteEndpointId: authority.payload.initiator.endpointId,
      localEndpointId: authority.payload.target.endpointId,
      signal: new AbortController().signal,
    });
    const metadataTarget = await openTarget();
    if (!metadataTarget) throw new Error('metadata target unavailable');
    const metadata = await rawRequestThroughApplicationTarget({ ...metadataTarget, method: 'GET',
      path: PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH, headers: { [PROVIDER_BROKER_MODEL_ID_HEADER]: modelId } });
    expect(metadata).toContain('HTTP/1.1 204 No Content');
    expect(metadata).toContain(`${PROVIDER_BROKER_ENDPOINT_PATH_HEADER}: ${protocol === 'anthropic' ? '/' : '/v1'}`);
    expect(dispatchOrder).toEqual(['policy', 'metadata-admission', 'source-selection', 'metadata-admission']);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    dispatchOrder.length = 0;
    const target = await openTarget();
    expect(target).not.toBeNull();
    const response = await rawRequestThroughApplicationTarget({ ...target!, method: 'POST',
      path: protocol === 'anthropic' ? '/v1/messages' : '/v1/responses',
      body: JSON.stringify({ model: modelId, ...(protocol === 'anthropic'
        ? { messages: [{ role: 'user', content: 'hello' }], max_tokens: 10 }
        : { input: 'hello' }) }),
    });
    expect(response).toContain('HTTP/1.1 200 OK');
    expect(response).toContain('{"ok":true}');
    expect(dispatchOrder).toEqual(['policy', 'usage-admission', 'source-selection']);
    expect(resolveBindingIntentSelection).toHaveBeenCalledWith(expect.objectContaining({
      target: source.target,
      purpose: expect.objectContaining({ purpose }),
    }));
    expect(custody.acquire).toHaveBeenCalledWith(expect.objectContaining({
      operationClaim: { kind: 'providerBroker', operation: authority.payload.consumer },
    }));
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
  });

  it('reuses one exact source projection for the application-stream lifetime', async () => {
    const cleanup = vi.fn(async () => {});
    const openConnectedServicesSource = vi.fn(async () => ({
      projection: {
        access: { endpointUrl: () => 'http://127.0.0.1:1/v1', request: vi.fn() },
        isCurrent: () => true,
        cleanup,
      },
      retire: vi.fn(async () => {}),
      sourceCurrentness: { sourceMember: { kind: 'connected_account' as const, service: source.target.account.service, connectedAccountId: source.target.account.accountId }, isCurrent: async () => true },
    }));
    const lifetime = createPrivateProviderBrokerStreamLifetime({
      sourceOwner: createTeamCredentialBrokerSourceOwner({
        selectConnectedServicesSourceMember: async () => null,
        machineId: 'broker-machine',
        custody: { retire: async () => true },
        openConnectedServicesSource,
        openProviderConnectionSource: async () => null,
      }),
      application: authority.payload.application,
      operation: authority.payload.consumer,
    });
    const admitted = {
      resourceId: 'resource-1',
      brokerMachineId: 'broker-machine',
      source,
      operation: authority.payload.consumer,
      usageEventId: 'usage-1',
    };
    const acquireInput = {
      source: admitted.source,
      resourceId: admitted.resourceId,
      brokerMachineId: admitted.brokerMachineId,
      operation: admitted.operation,
      expectedResourceRevision: 7,
      application: authority.payload.application,
      modelId: 'gpt-5',
      sourceRevision: authority.payload.sourceRevision,
    };

    const first = await lifetime.acquireSource(acquireInput);
    const second = await lifetime.acquireSource(acquireInput);
    expect(first).toBe(second);
    expect(openConnectedServicesSource).toHaveBeenCalledOnce();
    expect(openConnectedServicesSource).toHaveBeenCalledWith(expect.objectContaining({
      operation: { kind: 'session', sessionId: 'session-1' },
    }));
    await lifetime.close();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('re-enters the canonical Pool source owner and switches before the next admission uses a source', async () => {
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
    const requestA = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      statusText: 'OK',
      headers: Object.freeze({}),
      body: null,
    }));
    const requestB = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      statusText: 'OK',
      headers: Object.freeze({}),
      body: null,
    }));
    const accessA: ManagedProviderEndpointHttpAccess = Object.freeze({
      endpointUrl: () => 'http://127.0.0.1:41001/v1',
      request: requestA,
    });
    const accessB: ManagedProviderEndpointHttpAccess = Object.freeze({
      endpointUrl: () => 'http://127.0.0.1:41002/v1',
      request: requestB,
    });
    const cleanupA = vi.fn(async () => {});
    const retireA = vi.fn(async () => {});
    const cleanupB = vi.fn(async () => {});
    const retireB = vi.fn(async () => {});
    const retireOperation = vi.fn(async () => {});
    let sourceACurrent = true;
    const ownerAcquire = vi.fn<TeamCredentialBrokerSourceOwner['acquire']>()
      .mockResolvedValueOnce({
        ok: true,
        sourceMemberKey: 'connected-account:A',
        projection: { access: accessA, isCurrent: () => sourceACurrent, cleanup: cleanupA },
        retire: retireA,
      })
      // The incumbent managed-service owner retires the stale A operation
      // while rejecting the first B establishment. The stream must retry the
      // canonical owner, never return A for this request, and never select B
      // itself.
      .mockImplementationOnce(async () => {
        sourceACurrent = false;
        return { ok: false, reasonCode: 'source_unavailable', sourceOpenFailureReason: 'managed_custody_unavailable' };
      })
      .mockResolvedValueOnce({
        ok: true,
        sourceMemberKey: 'connected-account:B',
        projection: { access: accessB, isCurrent: () => true, cleanup: cleanupB },
        retire: retireB,
      });
    const lifetime = createPrivateProviderBrokerStreamLifetime({
      sourceOwner: Object.freeze({
        selectSourceMemberKey: async () => null,
        acquire: ownerAcquire,
        retireOperation,
      }),
      application: authority.payload.application,
      operation: authority.payload.consumer,
    });
    const acquireInput = {
      source: poolSource,
      resourceId: 'resource-1',
      brokerMachineId: 'broker-machine',
      operation: authority.payload.consumer,
      expectedResourceRevision: 7,
      application: authority.payload.application,
      modelId: 'gpt-5',
      sourceRevision: authority.payload.sourceRevision,
    };

    const first = await lifetime.acquireSource(acquireInput);
    expect(first).toEqual({
      access: accessA,
      sourceMemberKey: 'connected-account:A',
    });
    if (!first || 'reasonCode' in first) throw new Error('Expected first Pool source');
    await first?.access.request({
      pathAndQuery: '/v1/responses',
      method: 'POST',
      body: undefined,
      timeoutMs: 1_000,
    });
    const second = await lifetime.acquireSource(acquireInput);
    expect(second).toEqual({
      access: accessB,
      sourceMemberKey: 'connected-account:B',
    });
    if (!second || 'reasonCode' in second) throw new Error('Expected replacement Pool source');
    expect(ownerAcquire).toHaveBeenCalledTimes(3);
    expect(retireA).not.toHaveBeenCalled();
    expect(cleanupA).toHaveBeenCalledOnce();
    expect(retireB).not.toHaveBeenCalled();
    await second?.access.request({
      pathAndQuery: '/v1/responses',
      method: 'POST',
      body: undefined,
      timeoutMs: 1_000,
    });
    expect(requestA).toHaveBeenCalledOnce();
    expect(requestB).toHaveBeenCalledOnce();

    // Closing the stream releases only its joined view of B. The Session's
    // operation is not this stream's to end.
    await lifetime.close();
    expect(cleanupB).toHaveBeenCalledOnce();
    expect(retireB).not.toHaveBeenCalled();
    expect(retireOperation).not.toHaveBeenCalled();
  });

  it('keeps one Session operation across its streams and retires it only on the explicit close', async () => {
    // One Session, several live HTTP connections: an Agent's client pool opens
    // a second connection for a concurrent request and reopens one between
    // turns. Each is its own broker stream over the same signed authority.
    const custodyRetire = vi.fn(async () => true);
    const opened: Array<Readonly<{ cleanup: ReturnType<typeof vi.fn>; retire: ReturnType<typeof vi.fn> }>> = [];
    const request = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      statusText: 'OK',
      headers: Object.freeze({}),
      body: null,
    }));
    const sourceOwner = createTeamCredentialBrokerSourceOwner({
      selectConnectedServicesSourceMember: async () => null,
      machineId: 'broker-machine',
      custody: { retire: custodyRetire },
      openConnectedServicesSource: async () => {
        const join = { cleanup: vi.fn(async () => {}), retire: vi.fn(async () => {}) };
        opened.push(join);
        return {
          projection: {
            access: { endpointUrl: () => 'http://127.0.0.1:1/v1', request },
            isCurrent: () => true,
            cleanup: join.cleanup,
          },
          retire: join.retire,
          sourceCurrentness: {
            sourceMember: {
              kind: 'connected_account' as const,
              service: source.target.account.service,
              connectedAccountId: source.target.account.accountId,
            },
            isCurrent: async () => true,
          },
        };
      },
      openProviderConnectionSource: async () => null,
    });
    const newStream = () => createPrivateProviderBrokerStreamLifetime({
      sourceOwner,
      application: authority.payload.application,
      operation: authority.payload.consumer,
    });
    const acquireInput = {
      source,
      resourceId: 'resource-1',
      brokerMachineId: 'broker-machine',
      operation: authority.payload.consumer,
      expectedResourceRevision: 7,
      application: authority.payload.application,
      modelId: 'gpt-5',
      sourceRevision: authority.payload.sourceRevision,
    };

    const first = newStream();
    const second = newStream();
    expect(await first.acquireSource(acquireInput)).not.toBeNull();
    const secondAccess = await second.acquireSource(acquireInput);
    expect(secondAccess).not.toBeNull();
    if (!secondAccess || 'reasonCode' in secondAccess) throw new Error('Expected surviving stream source');

    await first.close();
    expect(opened[0]?.cleanup).toHaveBeenCalledOnce();
    expect(opened[0]?.retire).not.toHaveBeenCalled();
    expect(custodyRetire).not.toHaveBeenCalled();
    // The surviving connection still reaches the gateway.
    await expect(secondAccess?.access.request({
      pathAndQuery: '/v1/responses',
      method: 'POST',
      body: undefined,
      timeoutMs: 1_000,
    })).resolves.toMatchObject({ ok: true });
    // So does a connection opened after that close.
    const third = newStream();
    expect(await third.acquireSource(acquireInput)).not.toBeNull();
    expect(custodyRetire).not.toHaveBeenCalled();

    // The authorized explicit close arrives on its own stream, which has
    // acquired nothing, and ends the operation the authority names.
    const closer = newStream();
    await closer.retire();
    expect(custodyRetire).toHaveBeenCalledWith({
      identity: authority.payload.application.implementationIdentity,
      operationClaim: { kind: 'providerBroker', operation: authority.payload.consumer },
    });
    await second.close();
    await third.close();
  });

  it('coalesces concurrent stream close callers until source cleanup finishes', async () => {
    let releaseCleanup!: () => void;
    const cleanup = vi.fn(async () => await new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    }));
    const retire = vi.fn(async () => {});
    const lifetime = createPrivateProviderBrokerStreamLifetime({
      sourceOwner: createTeamCredentialBrokerSourceOwner({
        selectConnectedServicesSourceMember: async () => null,
        machineId: 'broker-machine',
        custody: { retire: async () => true },
        openConnectedServicesSource: async () => ({
          projection: {
            access: { endpointUrl: () => 'http://127.0.0.1:1/v1', request: vi.fn() },
            isCurrent: () => true,
            cleanup,
          },
          retire,
          sourceCurrentness: { sourceMember: { kind: 'connected_account' as const, service: source.target.account.service, connectedAccountId: source.target.account.accountId }, isCurrent: async () => true },
        }),
        openProviderConnectionSource: async () => null,
      }),
      application: authority.payload.application,
      operation: authority.payload.consumer,
    });
    const acquired = await lifetime.acquireSource({
      source,
      resourceId: 'resource-1',
      brokerMachineId: 'broker-machine',
      operation: authority.payload.consumer,
      expectedResourceRevision: 7,
      application: authority.payload.application,
      modelId: 'gpt-5',
      sourceRevision: authority.payload.sourceRevision,
    });
    expect(acquired).not.toBeNull();

    const firstClose = lifetime.close();
    let concurrentSettled = false;
    const concurrentClose = lifetime.close().then(() => { concurrentSettled = true; });
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(concurrentSettled).toBe(false);
    releaseCleanup();
    await Promise.all([firstClose, concurrentClose]);
    await lifetime.close();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(retire).not.toHaveBeenCalled();
  });

  it('fails closed before creating a stream target when the signed application is not current', async () => {
    const runtime = await startDaemonProviderBrokerRuntime({
      machineId: 'broker-machine',
      resolveTrustRoots: () => [],
      nowMs: () => 150,
      verifyAuthority: () => ({ valid: false as const, reasonCode: 'grant_binding_mismatch' }),
      resolveRequestPolicy: vi.fn(),
      admitRequest: vi.fn(),
      authorizeModelCatalog: vi.fn(),
      sourceOwner: createTeamCredentialBrokerSourceOwner({
        selectConnectedServicesSourceMember: async () => null,
        machineId: 'broker-machine',
        custody: { retire: async () => true },
        openConnectedServicesSource: async () => null,
        openProviderConnectionSource: async () => null,
      }),
      createRequestId: () => 'request-1',
    });
    closeTasks.push(runtime.close);
    await expect(runtime.resolveProviderBrokerApplicationTarget({
      handshake: { v: 1, kind: 'provider_broker', authority },
      authority,
      authenticatedRemoteEndpointId: authority.payload.initiator.endpointId,
      localEndpointId: authority.payload.target.endpointId,
      signal: new AbortController().signal,
    })).resolves.toBeNull();
  });
});

async function rawRequestThroughApplicationTarget(input: Readonly<{
  port: number;
  localCapability: string;
  method: 'DELETE' | 'POST' | 'GET';
  path: string;
  body?: string;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}>): Promise<string> {
  const request = [
    `${input.method} ${input.path} HTTP/1.1`,
    'Host: 127.0.0.1',
    'Connection: close',
    ...Object.entries(input.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    ...(input.body === undefined
      ? ['Content-Length: 0']
      : ['Content-Type: application/json', `Content-Length: ${Buffer.byteLength(input.body)}`]),
    '',
    input.body ?? '',
  ].join('\r\n');
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: input.port });
    const abort = () => socket.destroy();
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    const chunks: Buffer[] = [];
    socket.once('connect', () => {
      socket.write(input.localCapability, 'ascii');
      socket.write(request, 'utf8');
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => {
      input.signal?.removeEventListener('abort', abort);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/** Takes one complete HTTP/1.1 response off the front of `buffer`, framed by
 * Content-Length or chunked encoding, or returns null while it is partial. */
function takeHttpResponse(buffer: Buffer): Readonly<{ response: string; rest: Buffer }> | null {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;
  const head = buffer.subarray(0, headerEnd).toString('latin1');
  const bodyStart = headerEnd + 4;
  const contentLength = /\r\ncontent-length:\s*(\d+)/iu.exec(head);
  let end = bodyStart;
  if (contentLength) {
    end = bodyStart + Number(contentLength[1]);
    if (buffer.length < end) return null;
  } else if (/\r\ntransfer-encoding:\s*chunked/iu.test(head)) {
    const terminator = buffer.indexOf('\r\n0\r\n\r\n', headerEnd);
    if (terminator < 0) return null;
    end = terminator + '\r\n0\r\n\r\n'.length;
  }
  return { response: buffer.subarray(0, end).toString('utf8'), rest: buffer.subarray(end) };
}

/** Sequential requests on one application stream: each is written only after
 * the previous response has fully arrived, and the socket stays open between
 * them. `before` runs between responses, e.g. to edit Home state. */
async function keepAliveRequestsThroughApplicationTarget(input: Readonly<{
  port: number;
  localCapability: string;
  steps: ReadonlyArray<Readonly<{ path: string; body: string; before?: () => void }>>;
}>): Promise<string[]> {
  const socket = connect({ host: '127.0.0.1', port: input.port });
  await once(socket, 'connect');
  socket.write(input.localCapability, 'ascii');
  let buffer: Buffer = Buffer.alloc(0);
  let waiting: (() => void) | null = null;
  let closed = false;
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    waiting?.();
  });
  socket.once('close', () => {
    closed = true;
    waiting?.();
  });
  const nextResponse = async (): Promise<string> => {
    for (;;) {
      const taken = takeHttpResponse(buffer);
      if (taken) {
        buffer = taken.rest;
        return taken.response;
      }
      if (closed) throw new Error('application stream closed before a complete response');
      await new Promise<void>((resolve) => { waiting = resolve; });
      waiting = null;
    }
  };
  const responses: string[] = [];
  try {
    for (const [index, step] of input.steps.entries()) {
      step.before?.();
      socket.write([
        `POST ${step.path} HTTP/1.1`,
        'Host: 127.0.0.1',
        `Connection: ${index === input.steps.length - 1 ? 'close' : 'keep-alive'}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(step.body)}`,
        '',
        step.body,
      ].join('\r\n'), 'utf8');
      responses.push(await nextResponse());
    }
  } finally {
    socket.destroy();
  }
  return responses;
}

const homeKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
const homeTrustRoots = [{ keyId: 'home', publicKey: Buffer.from(homeKey.publicKey).toString('base64url') }];
const signedAuthority = (payload: SignedProviderBrokerRouteGrantV1['payload'] = authority.payload): SignedProviderBrokerRouteGrantV1 => ({
  payload,
  signature: {
    alg: 'Ed25519',
    keyId: 'home',
    valueBase64Url: Buffer.from(tweetnacl.sign.detached(
      Buffer.from(createProviderBrokerRouteGrantSigningInputV1(payload)),
      homeKey.secretKey,
    )).toString('base64url'),
  },
});

/** The target's real machine/1 admission route in front of the real broker
 * runtime; each call admits one new carrier stream. */
function startBrokerAdmission(
  runtime: Awaited<ReturnType<typeof startDaemonProviderBrokerRuntime>>,
  nowMs: number,
  handshake?: Parameters<typeof runtime.resolveProviderBrokerApplicationTarget>[0]['handshake'],
) {
  const admission = createPeerMediationLoopbackApp({
    nowMs: () => nowMs,
    expected: {
      accountId: 'custodian-account',
      machineId: 'broker-machine',
      flowKind: 'bounded_transfer',
      routeKind: 'loopback_direct',
      endpointFingerprint: 'unused',
    },
    trustRoots: homeTrustRoots,
    irohMachineAdmission: {
      localEndpointId: authority.payload.target.endpointId,
      role: 'acceptor',
      allowedFlows: [],
      resolveApplicationTarget: () => null,
      resolveProviderBrokerApplicationTarget: runtime.resolveProviderBrokerApplicationTarget,
    },
  });
  closeTasks.push(async () => { await admission.close(); });
  return async (remoteEndpointId: string = authority.payload.initiator.endpointId) => {
    const response = await admission.inject({
      method: 'POST',
      url: IROH_MACHINE_ADMISSION_PATH,
      headers: { [IROH_MACHINE_REMOTE_ENDPOINT_HEADER]: remoteEndpointId },
      payload: handshake ?? { v: 1, kind: 'provider_broker', authority: signedAuthority() },
    });
    return {
      statusCode: response.statusCode,
      port: Number(response.headers[IROH_MACHINE_APPLICATION_PORT_HEADER.toLowerCase()]),
      localCapability: String(response.headers[IROH_MACHINE_APPLICATION_CAPABILITY_HEADER.toLowerCase()]),
    };
  };
}

describe('Provider-broker release after grant expiry (machine/1 admission + broker runtime)', () => {
  it.each(['resource_test', 'private'] as const)('retains a failed exact source open through the %s application response', async (ingress) => {
    const diagnostics = vi.spyOn(logger, 'warnLocalFile');
    closeTasks.push(async () => { diagnostics.mockRestore(); });
    const unused = (): never => { throw new Error('Source refusal reached a Provider effect'); };
    const custody = createManagedProviderExplicitStartCustody({ machineId: 'broker-machine', happyHomeDir: '/unreached-source' });
    const bindings = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unused, subscribe: () => ({ dispose() {} }) },
      selectTarget: unused, resolveTarget: async () => ({ displayName: 'Account', account: source.target.account }),
      materializeAccount: unused, projectTargetAccounts: unused, assertTargetAccountMaterializable: unused,
    });
    const sourceOwner = createTeamCredentialBrokerSourceOwner({
      machineId: 'broker-machine', custody,
      selectConnectedServicesSourceMember: createConnectedServicesBrokerSourceMemberSelect({
        withRegistry: async read => await read(createBrokerProviderRegistry()), resolveBindingIntentSelection: bindings.resolveBindingIntentSelection,
      }),
      openConnectedServicesSource: createConnectedServicesBrokerSourceOpen({
        withRegistry: async read => await read(createBrokerProviderRegistry()), resolveBindingIntentSelection: bindings.resolveBindingIntentSelection,
        // The Home resource HTTP read is unavailable. Selection, currentness,
        // source acquisition, policy, application handling and TCP stay real.
        readResource: async () => null, custody,
      }),
      openProviderConnectionSource: unused,
    });
    const binding = { v: 1 as const, kind: 'resource_test' as const, teamId: 'team-1', resourceId: 'resource-1',
      actorAccountId: 'custodian-account', requestId: 'source-refusal', expectedResourceRevision: 7,
      application: authority.payload.application, source };
    const runtime = await startDaemonProviderBrokerRuntime({
      machineId: 'broker-machine', resolveTrustRoots: () => homeTrustRoots, nowMs: () => 150,
      createRequestId: () => 'source-refusal', resolveRequestPolicy: async () => ({ resourceRevision: 7,
        sourceRevision: authority.payload.sourceRevision, application: binding.application, source, policy: null,
        modelCatalog: { models: [{ id: 'gpt-5' }], resolveCanonicalModelId: id => id } }),
      admitRequest: unused, authorizeModelCatalog: async () => ({ ok: true }),
      resolveResourceTestRequestPolicy: async () => ({ resourceRevision: 7, application: binding.application, policy: null,
        modelCatalog: { models: [{ id: 'gpt-5' }], resolveCanonicalModelId: id => id } }),
      admitResourceTestRequest: async () => ({ ok: true, resourceId: binding.resourceId, resourceRevision: 7,
        brokerMachineId: 'broker-machine', source, operation: { kind: 'resource_test', actorAccountId: binding.actorAccountId },
        usageEventId: null }),
      sourceOwner,
    });
    closeTasks.push(runtime.close);
    // Relay authorization is the already-authenticated transport boundary;
    // the real relay/route composition separately verifies its signature.
    const target = ingress === 'private' ? await startBrokerAdmission(runtime, 150)()
      : await runtime.resolveExternalProviderBrokerApplicationTarget({ binding, relayAuthorization: {
      payload: { v: 2, grantId: 'test-grant', accountId: 'custodian-account', targetMachineId: 'broker-machine',
        flowKind: 'provider_broker', routeKind: 'server_relay', tunnelId: 'test-tunnel', relaySocketId: 'test-relay',
        providerBroker: binding, capProfileId: 'server-relay-v1', maxFrameBytes: 65_536, maxIdleMs: 10_000,
        maxDurationMs: 30_000, iat: 100, exp: 200, aud: 'happier-tcp-tunnel-relay-authorization' },
      signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: 'AA' },
    } });
    if (!target) throw new Error('Resource-test application target absent');
    const response = ingress === 'private' ? await rawRequestThroughApplicationTarget({ ...target, method: 'GET',
      path: PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH, headers: { [PROVIDER_BROKER_MODEL_ID_HEADER]: 'gpt-5' } })
      : await rawRequestThroughApplicationTarget({ ...target, method: 'POST',
      path: TEAM_CREDENTIAL_EXTERNAL_PROVIDER_APPLICATION_HTTP_PATH_V1,
      body: JSON.stringify({ v: 1, kind: 'resource_test', teamId: binding.teamId, resourceId: binding.resourceId,
        requestId: binding.requestId, route: 'responses', method: 'POST', pathAndQuery: '/v1/responses',
        bodyBase64: Buffer.from(JSON.stringify({ model: 'gpt-5', input: 'hello' })).toString('base64') }),
    });
    expect(response).toContain('HTTP/1.1 403');
    const code = ingress === 'private' ? 'resource_unavailable' : 'source_unavailable';
    expect(response).toContain(`x-happier-provider-broker-error-code: ${code}`);
    expect(diagnostics).toHaveBeenCalledWith('[provider-broker-application]', expect.objectContaining({
      stage: 'application_response', code, sourceOpenFailureReason: 'resource_not_current',
    }));
    expect(response).not.toContain('resource_not_current');
  });

  it.each(['unavailable', 'cancelled'] as const)('admits the personal carrier before private source acquisition (%s Home read)', async outcome => {
    const payload: SignedProviderBrokerRouteGrantV2['payload'] = {
      v: 2, grantId: 'personal-request', aud: 'happier-provider-broker-route-v2', issuedAt: 100, expiresAt: 200,
      homeId: 'home-1', accountId: 'custodian-account', initiatorTokenEpoch: 0,
      source: { kind: 'account_connection', connectionId: ProviderConnectionIdSchema.parse('personal-gateway'),
        expectedConnectionSecurityFingerprint: 'connection-security:v1:test',
        expectedManagedRuntimeBindingFingerprint: 'managed-runtime-binding:v1:test' },
      initiator: { ...authority.payload.initiator, accountId: 'custodian-account' },
      target: authority.payload.target, consumer: authority.payload.consumer, application: authority.payload.application,
    };
    const signed: SignedProviderBrokerRouteGrantV2 = { payload, signature: { alg: 'Ed25519', keyId: 'home',
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createProviderBrokerRouteGrantSigningInputV2(payload)), homeKey.secretKey)).toString('base64url') } };
    let catalogReads = 0;
    let homeReadStarted!: (signal: AbortSignal) => void;
    const homeRead = new Promise<AbortSignal>(resolve => { homeReadStarted = resolve; });
    const open = createAccountConnectionBrokerSourceOpen({
      homeId: 'home-1', accountId: 'custodian-account', machineId: 'broker-machine',
      expectedAccountSettingsScopeKey: 'unavailable-source',
      custody: createManagedProviderExplicitStartCustody({ machineId: 'broker-machine', happyHomeDir: '/unreached-source' }),
      withRegistry: async read => await read(createBrokerProviderRegistry()),
      // Private Account storage and Home HTTP are system boundaries. An
      // unavailable catalog must refuse HTTP metadata without closing QUIC.
      getAccountSettingsSnapshot: () => {
        catalogReads++;
        return outcome === 'unavailable' ? null : { source: 'cache', scopeKey: 'unavailable-source',
          settings: AccountSettingsSchema.parse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] };
      },
      resolveBindingIntent: async () => { throw new Error('unavailable source resolved credentials'); },
      projectModels: async () => { throw new Error('unavailable source projected models'); },
      admitConsumer: async (_authority, signal) => {
        if (outcome === 'unavailable') return true;
        if (!signal) throw new Error('Home read lacks its stream lifetime');
        homeReadStarted(signal);
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          signal.throwIfAborted();
        });
        return true;
      },
    });
    const runtime = await startDaemonProviderBrokerRuntime({ machineId: 'broker-machine', resolveTrustRoots: () => homeTrustRoots,
      nowMs: () => 150, createRequestId: () => 'request-1', resolveRequestPolicy: async () => null,
      admitRequest: async () => ({ ok: false, reasonCode: 'resource_unavailable' }),
      authorizeModelCatalog: async () => ({ ok: false, reasonCode: 'resource_unavailable' }),
      sourceOwner: createTeamCredentialBrokerSourceOwner({ machineId: 'broker-machine', custody: { retire: async () => false },
        selectConnectedServicesSourceMember: async () => null, openConnectedServicesSource: async () => null, openProviderConnectionSource: async () => null }),
      accountConnection: { homeId: 'home-1', accountId: 'custodian-account', open, retire: async () => {} },
    });
    closeTasks.push(runtime.close);
    const admit = startBrokerAdmission(runtime, 150, { v: 2, kind: 'provider_broker', authority: signed });
    expect((await admit('c'.repeat(64))).statusCode).toBe(403);
    expect(catalogReads).toBe(0);
    const stream = await admit();
    expect(stream.statusCode).toBe(204);
    expect(catalogReads).toBe(0);
    const caller = new AbortController();
    const pending = rawRequestThroughApplicationTarget({ ...stream, method: 'GET', path: PROVIDER_BROKER_PRIVATE_ENDPOINT_PATH, signal: caller.signal });
    if (outcome === 'cancelled') {
      const homeSignal = await homeRead;
      expect(homeSignal.aborted).toBe(false);
      caller.abort();
      await vi.waitFor(() => expect(homeSignal.aborted).toBe(true));
      expect(await pending).toBe('');
    } else {
      const metadata = await pending;
      expect(metadata).toContain('HTTP/1.1 403');
      expect(metadata).toContain('resource_unavailable');
      expect(metadata).not.toContain(PROVIDER_BROKER_ENDPOINT_PATH_HEADER);
    }
    expect(catalogReads).toBe(1);
  });

  it.each([{ label: 'expired', nowMs: 60_000 }, { label: 'current release-only', nowMs: 150 }])('admits $label personal authority only to release its own connection consumer', async ({ nowMs }) => {
    const payload: SignedProviderBrokerRouteGrantV2['payload'] = {
      v: 2, grantId: 'personal-release', aud: 'happier-provider-broker-route-v2', issuedAt: 100, expiresAt: 200,
      homeId: 'home-1', accountId: 'custodian-account', initiatorTokenEpoch: 0,
      source: { kind: 'account_connection', connectionId: ProviderConnectionIdSchema.parse('personal-gateway'),
        expectedConnectionSecurityFingerprint: 'connection-security:v1:test',
        expectedManagedRuntimeBindingFingerprint: 'managed-runtime-binding:v1:test' },
      initiator: { ...authority.payload.initiator, accountId: 'custodian-account' },
      target: authority.payload.target, consumer: authority.payload.consumer, application: authority.payload.application,
    };
    const signed: SignedProviderBrokerRouteGrantV2 = { payload, signature: { alg: 'Ed25519', keyId: 'home',
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createProviderBrokerRouteGrantSigningInputV2(payload)), homeKey.secretKey)).toString('base64url') } };
    let retired = false;
    let catalogReads = 0;
    const openAccountSource = createAccountConnectionBrokerSourceOpen({
      homeId: 'home-1', accountId: 'custodian-account', machineId: 'broker-machine',
      expectedAccountSettingsScopeKey: 'unreached-release-source',
      custody: createManagedProviderExplicitStartCustody({ machineId: 'broker-machine', happyHomeDir: '/unreached-release-source' }),
      withRegistry: async read => await read(createBrokerProviderRegistry()),
      // Account settings storage and Machine model RPC are genuine external
      // boundaries. Retirement must not even read the catalog, let alone
      // acquire a source through the real canonical opener.
      getAccountSettingsSnapshot: () => { catalogReads++; return null; },
      resolveBindingIntent: async () => { throw new Error('release resolved a credential'); },
      projectModels: async () => { throw new Error('release projected models'); },
      admitConsumer: async () => { throw new Error('release sought fresh Home admission'); },
    });
    const runtime = await startDaemonProviderBrokerRuntime({ machineId: 'broker-machine', resolveTrustRoots: () => homeTrustRoots,
      nowMs: () => nowMs, createRequestId: () => 'request-1', resolveRequestPolicy: async () => null,
      admitRequest: async () => ({ ok: false, reasonCode: 'resource_unavailable' }), authorizeModelCatalog: async () => ({ ok: false, reasonCode: 'resource_unavailable' }),
      sourceOwner: createTeamCredentialBrokerSourceOwner({ machineId: 'broker-machine', custody: { retire: async () => false },
        selectConnectedServicesSourceMember: async () => null, openConnectedServicesSource: async () => null, openProviderConnectionSource: async () => null }),
      accountConnection: { homeId: 'home-1', accountId: 'custodian-account',
        open: openAccountSource,
        retire: async () => { retired = true; } },
    });
    closeTasks.push(runtime.close);
    const handshake = { v: 2 as const, kind: 'provider_broker' as const, authority: signed, intent: 'release' as const };
    const target = await runtime.resolveProviderBrokerApplicationTarget({ handshake,
      authority: signed, authenticatedRemoteEndpointId: payload.initiator.endpointId, localEndpointId: payload.target.endpointId,
      signal: new AbortController().signal });
    expect(target).not.toBeNull();
    if (!target) throw new Error('personal release target unavailable');
    const inference = await rawRequestThroughApplicationTarget({ ...target, method: 'POST', path: '/v1/responses', body: '{}' });
    expect(inference).toContain('HTTP/1.1 403');
    expect(retired).toBe(false);
    const admit = startBrokerAdmission(runtime, nowMs, handshake);
    expect((await admit('c'.repeat(64))).statusCode).toBe(403);
    const tampered = startBrokerAdmission(runtime, nowMs, { ...handshake, authority: {
      ...signed, payload: { ...payload, source: { ...payload.source, connectionId: ProviderConnectionIdSchema.parse('foreign-connection') } },
    } });
    expect((await tampered()).statusCode).toBe(403);
    expect(retired).toBe(false);
    const releaseStream = await admit();
    expect(releaseStream.statusCode).toBe(204);
    const response = await rawRequestThroughApplicationTarget({ ...releaseStream, method: 'DELETE', path: PROVIDER_BROKER_PRIVATE_CLOSE_PATH });
    expect(response).toContain('HTTP/1.1 204');
    expect(retired).toBe(true);
    expect(catalogReads).toBe(0);
  });
  async function startTarget(nowMs: number) {
    const custodyRetire = vi.fn(async () => true);
    const openConnectedServicesSource = vi.fn(async () => null);
    const resolveRequestPolicy = vi.fn(async () => null);
    const admitRequest = vi.fn();
    const runtime = await startDaemonProviderBrokerRuntime({
      machineId: 'broker-machine',
      resolveTrustRoots: () => homeTrustRoots,
      nowMs: () => nowMs,
      resolveRequestPolicy,
      admitRequest,
      authorizeModelCatalog: vi.fn(),
      sourceOwner: createTeamCredentialBrokerSourceOwner({
        machineId: 'broker-machine',
        custody: { retire: custodyRetire },
        selectConnectedServicesSourceMember: async () => null,
        openConnectedServicesSource,
        openProviderConnectionSource: async () => null,
      }),
      createRequestId: () => 'request-1',
    });
    closeTasks.push(runtime.close);
    const admitStream = startBrokerAdmission(runtime, nowMs);
    return { admitStream, custodyRetire, openConnectedServicesSource, resolveRequestPolicy, admitRequest };
  }

  it('retires the exact Session claim over a stream whose original grant has expired', async () => {
    // Long-lived Session: it ends well after its initial handshake TTL.
    const target = await startTarget(authority.payload.expiresAt + 60_000);

    const stream = await target.admitStream();
    expect(stream.statusCode).toBe(204);
    const released = await rawRequestThroughApplicationTarget({
      ...stream,
      method: 'DELETE',
      path: PROVIDER_BROKER_PRIVATE_CLOSE_PATH,
    });

    expect(released).toContain('HTTP/1.1 204');
    expect(target.custodyRetire).toHaveBeenCalledOnce();
    expect(target.custodyRetire).toHaveBeenCalledWith({
      identity: authority.payload.application.implementationIdentity,
      operationClaim: { kind: 'providerBroker', operation: authority.payload.consumer },
    });
  });

  it('admits no release stream for an expired authority presented from another transport endpoint', async () => {
    const target = await startTarget(authority.payload.expiresAt + 60_000);

    const stream = await target.admitStream('c'.repeat(64));

    expect(stream.statusCode).not.toBe(204);
    expect(target.custodyRetire).not.toHaveBeenCalled();
  });

  it('refuses inference on an expired-grant stream before policy, admission or source custody', async () => {
    const target = await startTarget(authority.payload.expiresAt + 60_000);

    const stream = await target.admitStream();
    expect(stream.statusCode).toBe(204);
    const inference = await rawRequestThroughApplicationTarget({
      ...stream,
      method: 'POST',
      path: '/v1/responses',
      body: JSON.stringify({ model: 'gpt-5', input: 'hello' }),
    });

    expect(inference).toContain('HTTP/1.1 403');
    expect(inference).toContain('grant_expired');
    expect(target.resolveRequestPolicy).not.toHaveBeenCalled();
    expect(target.admitRequest).not.toHaveBeenCalled();
    expect(target.openConnectedServicesSource).not.toHaveBeenCalled();
    expect(target.custodyRetire).not.toHaveBeenCalled();
  });

  it('keeps a current grant stream on the ordinary per-request path', async () => {
    const target = await startTarget(authority.payload.issuedAt + 50);

    const stream = await target.admitStream();
    expect(stream.statusCode).toBe(204);
    const inference = await rawRequestThroughApplicationTarget({
      ...stream,
      method: 'POST',
      path: '/v1/responses',
      body: JSON.stringify({ model: 'gpt-5', input: 'hello' }),
    });

    // The ordinary path reaches current request policy (here: unavailable).
    expect(inference).toContain('HTTP/1.1 403');
    expect(inference).not.toContain('grant_expired');
    expect(target.resolveRequestPolicy).toHaveBeenCalledOnce();
  });
});

describe('Provider-broker admission precedes source custody (machine/1 admission + broker runtime)', () => {
  const brokerResource: TeamCredentialResourceSummaryV1 = {
    id: 'resource-1', teamId: 'team-1', custodianAccountId: 'custodian-account',
    sourceOwnerDisplayName: null,
    displayName: 'Shared Codex', enabled: true, revision: 7,
    deliveryPolicy: { preferredAllowedModes: ['brokered'] }, sessionUsePolicy: 'personal_allowed',
    source,
    sourcePresentation: { kind: 'connected_service', service: source.target.account.service },
    directExportSupport: 'unsupported', activeUsageLimitCount: 0,
    requestPolicy: null,
    brokerPlacement: { kind: 'machine', machineId: 'broker-machine' },
    allMembersAllowedRoutes: null,
    groupGrants: [], memberGrants: [], readiness: { kind: 'available' }, recoveryAction: null,
    brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
    capabilities: {
      manageAudience: false, managePolicy: false, manageLimits: false, updateBrokerPlacement: false, updateDeliveryPolicy: false,
      narrowDisclosure: false, widenDisclosure: false, refreshDirectMaterial: false,
      disable: false, enable: false, delete: false,
    },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };

  async function startRetainedTarget(personal = false) {
    type Consumer = SignedProviderBrokerRouteGrantV1['payload']['consumer'];
    const diagnostics = vi.spyOn(logger, 'warnLocalFile');
    closeTasks.push(async () => { diagnostics.mockRestore(); });
    const unused = (): never => { throw new Error('Unexpected effect boundary'); };
    const managed = createManagedServicesOwner({
      processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
      dependencies: unused,
      resolveScope: scope => scope,
    });
    const operationKey = (operation: TeamCredentialBrokerOperation) => JSON.stringify({ kind: 'providerBroker', operation });
    const claim = (operation: TeamCredentialBrokerOperation) => ({
      operationId: operationKey(operation),
      pluginId: authority.payload.application.implementationIdentity.pluginId,
      contributionQualifiedId: `${authority.payload.application.implementationIdentity.pluginId}/providers/${authority.payload.application.implementationIdentity.localId}`,
    });
    const consumers = new Map<string, boolean>();
    const homeReads: string[] = [];
    const streamChecks: string[] = [];
    const children = new Map<string, { current: boolean; starts: number; cleanupAttempts: number; cleanupFailures: number }>();
    let endConsumerOnRequest = false;
    let failCleanupOnRequest = false;
    let homeUnavailable = false;
    let onChildRetired = () => {};
    // The source custody port uses the real managed semantic/join owner. The
    // already-authorized child process and Home HTTP are the effect boundaries.
    const custody: ManagedProviderExplicitStartCustody = {
      async acquire(input) {
        const operation = input.operationClaim.operation;
        const key = operationKey(operation);
        const joined = await managed.runManagedProviderExplicitStart({
          ...claim(operation), occurrenceId: 'provider-occurrence', purposeBindingsEqualityKey: 'exact-connected-account',
          lifecycleKind: 'providerBroker', signal: input.signal, isCurrent: input.isAuthorizationCurrent,
          ...(input.revalidateRetainedCurrentness ? { revalidateRetainedCurrentness: input.revalidateRetainedCurrentness } : {}),
          establish: async () => {
            const child = { current: true, starts: (children.get(key)?.starts ?? 0) + 1, cleanupAttempts: 0, cleanupFailures: 0 };
            children.set(key, child);
            return { status: 'running', projection: {
              access: { endpointUrl: () => 'http://127.0.0.1:43120/v1', request: async () => {
                if (!child.current) throw new Error('Retired child reached');
                if (endConsumerOnRequest) consumers.set(key, false);
                if (failCleanupOnRequest) child.cleanupFailures = 1;
                return { ok: true, status: 200, statusText: 'OK', headers: {}, body: null };
              } },
              isCurrent: () => child.current,
              cleanup: async () => {
                child.cleanupAttempts++;
                if (child.cleanupFailures > 0) { child.cleanupFailures--; throw new Error('Child cleanup unavailable'); }
                child.current = false;
                onChildRetired();
              },
            } };
          },
        });
        return joined.status === 'established' ? joined.value.projection : null;
      },
      retire: async input => await managed.retireManagedProviderExplicitStart(claim(input.operationClaim.operation)),
      retireExternalApiKey: unused,
      revalidateRetainedClaims: async (signal, selector, invalidation) => await managed.revalidateManagedProviderExplicitStarts(
        signal, selector ? claim(selector.operationClaim.operation) : undefined, invalidation,
      ),
      retireAll: async () => await managed.retireManagedProviderExplicitStarts('providerBroker'),
    };
    closeTasks.push(async () => { await custody.retireAll(); });
    const bindings = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unused, subscribe: () => ({ dispose() {} }) },
      selectTarget: unused, resolveTarget: async () => ({ displayName: 'Account', account: source.target.account }),
      materializeAccount: unused, projectTargetAccounts: unused, assertTargetAccountMaterializable: unused,
    });
    const sourceOwner = createTeamCredentialBrokerSourceOwner({
      machineId: 'broker-machine', custody,
      selectConnectedServicesSourceMember: createConnectedServicesBrokerSourceMemberSelect({
        withRegistry: async read => await read(createBrokerProviderRegistry()), resolveBindingIntentSelection: bindings.resolveBindingIntentSelection,
      }),
      openConnectedServicesSource: createConnectedServicesBrokerSourceOpen({
        withRegistry: async read => await read(createBrokerProviderRegistry()), readResource: async () => brokerResource,
        resolveBindingIntentSelection: bindings.resolveBindingIntentSelection, custody,
      }),
      openProviderConnectionSource: unused,
    });
    let personalAuthority: SignedProviderBrokerRouteGrantV2 | null = null;
    let personalOpenFailure: unknown;
    const personalConnection = personal ? (() => {
      const base = createBrokerProviderRegistry();
      const registry = { providersByContributionKey: new Map([...base.providersByContributionKey].map(([key, contribution]) => [key, {
        ...contribution, definition: ProviderContributionV1Schema.parse({ ...contribution.definition,
          managedRuntime: { ...contribution.definition.managedRuntime, sharing: 'connectionMachine', connectedAccounts: [] } }),
      }])) };
      const connectionId = ProviderConnectionIdSchema.parse('personal-retained-source');
      const initial = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{
        v: 1, id: connectionId, source: { kind: 'contribution', contributionKey: 'happier.provider.cliproxyapi/cliproxyapi' },
        deployment: { kind: 'managedLocal' }, role: 'default', displayName: 'Gateway', displayNameMode: 'automatic',
        revision: 1, createdAt: 1, updatedAt: 1, gatewayPlacement: { kind: 'machine', machineId: 'broker-machine' },
      }] });
      const resolve = (settings: typeof initial) => resolveProviderConnectionForMachine({ connectionId,
        machineId: 'broker-machine', providerSettings: settings, registry, dnsEvidenceByEndpointUrl: new Map() });
      const resolved = resolve(initial);
      if (resolved.status !== 'resolved') throw new Error('Personal source unresolved');
      const settings = ProviderSettingsV1Schema.parse({ ...initial, machineGrants: [{ v: 1, connectionId,
        machineId: 'broker-machine', connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint,
        endpointSetFingerprint: resolved.record.endpointSetFingerprint, confirmedAt: 1 }] });
      const admitted = resolve(settings);
      if (admitted.status !== 'resolved' || admitted.record.deployment.kind !== 'managedLocal') throw new Error('Personal source unavailable');
      const application = projectProviderBrokerApplication({ connection: admitted.record,
        agentTargetKey: 'agent:happier.agent.codex/codex', protocol: authority.payload.application.protocol });
      if (!application) throw new Error('Personal application unavailable');
      const { catalog, defaults } = splitProviderSettingsV1(settings);
      const credentials = { token: 'retained-personal-catalog', encryption: null };
      const scopeKey = resolveAccountSettingsScopeKey(credentials);
      setActiveAccountSettingsSnapshot({ source: 'cache', scopeKey, settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], savedSecretResources: [], savedSecretCatalogState: 'ready',
        settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }),
        providerConnectionsCatalog: { status: 'ready', revision: 1, catalog } });
      let readCatalog = async () => catalog;
      // Home HTTP is the boundary; refresh, loading publication, and source
      // revalidation all run through their production owners.
      const catalogHttp = vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
          mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path === '/v1/account/entity-rows/provider-connections') return { status: 200, data: {
          status: 'present', revision: 2, content: { t: 'plain', v: await readCatalog() } } };
        throw new Error(`Unexpected personal catalog HTTP boundary: ${path}`);
      });
      closeTasks.push(async () => { catalogHttp.mockRestore(); });
      const payload: SignedProviderBrokerRouteGrantV2['payload'] = { v: 2, grantId: 'personal-retained-grant',
        aud: 'happier-provider-broker-route-v2', issuedAt: 100, expiresAt: 200, homeId: 'home-1', accountId: 'custodian-account',
        initiatorTokenEpoch: 0, initiator: { ...authority.payload.initiator, accountId: 'custodian-account' },
        target: authority.payload.target, consumer: authority.payload.consumer, application,
        source: { kind: 'account_connection', connectionId,
          expectedConnectionSecurityFingerprint: admitted.record.connectionSecurityFingerprint,
          expectedManagedRuntimeBindingFingerprint: createProviderManagedRuntimeBindingFingerprintV1({
            implementationIdentity: admitted.record.deployment.implementationIdentity,
            managedRuntime: admitted.record.deployment.managedRuntime, purposeBindings: { v: 1, bindings: [] },
          }) },
      };
      personalAuthority = { payload, signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: Buffer.from(tweetnacl.sign.detached(
        Buffer.from(createProviderBrokerRouteGrantSigningInputV2(payload)), homeKey.secretKey,
      )).toString('base64url') } };
      const open = createAccountConnectionBrokerSourceOpen({ homeId: 'home-1', accountId: 'custodian-account',
        machineId: 'broker-machine', expectedAccountSettingsScopeKey: scopeKey, custody,
        withRegistry: async read => await read(registry),
        getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
        resolveBindingIntent: unused,
        admitConsumer: async signed => {
          const key = operationKey(signed.payload.consumer);
          homeReads.push(key);
          return consumers.get(key) === true;
        },
        projectModels: async () => DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'success', agentTargetKey: application.agentTargetKey,
          groups: [{ connectionId, providerName: 'Gateway', connectionName: 'Gateway', connectionRole: 'default',
            connectionDisplayNameMode: 'automatic', connectionRevision: 1,
            sourceAuthority: { provider: { identity: application.implementationIdentity, definitionRevision: 1 },
              connectionSecurityFingerprint: admitted.record.connectionSecurityFingerprint }, authorization: { authorized: true },
            modelLoadAction: 'descriptor_absent', manualModelPolicy: 'allowed', supportsFreeformModelIds: false,
            suppressedConnectedServiceIds: [], rows: [{ ref: { agentTargetKey: application.agentTargetKey, providerConnectionId: connectionId, modelId: 'gpt-5' },
              descriptor: { id: 'gpt-5', name: 'GPT' }, application, sources: { manual: false, static: false, probe: true }, confidence: 'probe',
              compatibility: { result: { status: 'verified', selectedProtocol: application.protocol,
                evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-10-09' } },
                compatibilityFingerprint: 'compatibility:v1:retained', confirmed: false },
              endpointHealth: 'not_checked', catalog: { stale: false }, loadState: 'unknown', visibility: 'visible' }] }],
        }),
      });
      return { homeId: 'home-1', accountId: 'custodian-account',
        refreshCatalog: (read: typeof readCatalog = async () => catalog) => {
          readCatalog = read;
          return refreshActiveProviderConnectionsCatalog({ credentials }, { afterChange: true });
        },
        removeConnection: () => splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1).catalog,
        open: async (request: Parameters<typeof open>[0]) => {
          try { return await open(request); } catch (error) { personalOpenFailure = error; throw error; }
        },
        retire: async ({ authority: signed }: { authority: SignedProviderBrokerRouteGrantV2 }) => await retireAccountConnectionBrokerSource({
          homeId: 'home-1', accountId: 'custodian-account', machineId: 'broker-machine', custody, authority: signed,
        }),
        revalidateCurrentness: async ({ authority: signed }: { authority: SignedProviderBrokerRouteGrantV2 }) => {
          await custody.revalidateRetainedClaims(undefined, { identity: signed.payload.application.implementationIdentity,
            operationClaim: { kind: 'providerBroker', operation: signed.payload.consumer },
            sharedGateway: { homeId: 'home-1', accountId: 'custodian-account', machineId: 'broker-machine',
              connectionId: signed.payload.source.connectionId, consumerId: JSON.stringify(signed.payload.consumer) } });
          streamChecks.push(operationKey(signed.payload.consumer));
        } };
    })() : null;
    const runtimeInput = {
      machineId: 'broker-machine', resolveTrustRoots: () => homeTrustRoots, nowMs: () => 150,
      createRequestId: () => 'retained-request',
      ...(personalConnection ? { accountConnection: personalConnection } : {}),
      resolveRequestPolicy: async () => ({ resourceRevision: 7, sourceRevision: authority.payload.sourceRevision,
        application: authority.payload.application, source, policy: null,
        modelCatalog: { models: [{ id: 'gpt-5' }], resolveCanonicalModelId: (id: string) => id } }),
      admitRequest: async (request: Parameters<Parameters<typeof startDaemonProviderBrokerRuntime>[0]['admitRequest']>[0]) => ({
        ok: true as const, resourceId: 'resource-1', brokerMachineId: 'broker-machine', source,
        operation: request.authority.payload.consumer, usageEventId: 'usage-1',
      }),
      authorizeModelCatalog: async () => ({ ok: true as const }), sourceOwner,
      revalidateOperationAuthorization: async (input: { authority: SignedProviderBrokerRouteGrantV1; expectedResourceRevision: number; signal?: AbortSignal }) => {
        input.signal?.throwIfAborted();
        expect(input.expectedResourceRevision).toBe(7);
        const key = operationKey(input.authority.payload.consumer);
        homeReads.push(key);
        if (homeUnavailable) throw new Error('Home unavailable');
        return consumers.get(key) === true;
      },
      revalidateOperationCurrentness: async (input: { operation: TeamCredentialBrokerOperation; application: ProviderBrokerApplicationBindingV1 }, signal?: AbortSignal) => {
        await custody.revalidateRetainedClaims(signal, {
          identity: input.application.implementationIdentity,
          operationClaim: { kind: 'providerBroker', operation: input.operation },
        });
        streamChecks.push(operationKey(input.operation));
      },
    };
    const runtime = await startDaemonProviderBrokerRuntime(runtimeInput);
    closeTasks.push(runtime.close);
    const streamHandshake = (consumer: Consumer = authority.payload.consumer, expired = false) => {
      const occurrence = consumer.kind === 'execution_run' ? { executionRunOccurrenceId: 'run-occurrence-1' } : {};
      if (personalAuthority) {
        const payload = { ...personalAuthority.payload, consumer, ...occurrence, ...(expired ? { expiresAt: 149 } : {}) };
        const signed: SignedProviderBrokerRouteGrantV2 = { payload, signature: { alg: 'Ed25519', keyId: 'home',
          valueBase64Url: Buffer.from(tweetnacl.sign.detached(
            Buffer.from(createProviderBrokerRouteGrantSigningInputV2(payload)), homeKey.secretKey,
          )).toString('base64url') } };
        return { v: 2 as const, kind: 'provider_broker' as const, authority: signed };
      }
      const signed = signedAuthority({ ...authority.payload, consumer, ...occurrence });
      return { v: 1 as const, kind: 'provider_broker' as const, authority: signed };
    };
    const admitStream = async (consumer: Consumer = authority.payload.consumer, expired = false) => await startBrokerAdmission(runtime, 150, streamHandshake(consumer, expired))();
    const infer = async (consumer: Consumer = authority.payload.consumer) => {
      const key = operationKey(consumer);
      if (!consumers.has(key)) consumers.set(key, true);
      const target = await admitStream(consumer);
      expect(target.statusCode).toBe(204);
      const response = await rawRequestThroughApplicationTarget({ ...target, method: 'POST', path: '/v1/responses',
        body: JSON.stringify({ model: 'gpt-5', input: 'hello' }) });
      expect(response, JSON.stringify(diagnostics.mock.calls) + String(personalOpenFailure)).toContain('HTTP/1.1 200');
      return target;
    };
    const openInferenceStream = async () => {
      consumers.set(operationKey(authority.payload.consumer), true);
      const target = await admitStream();
      expect(target.statusCode).toBe(204);
      const socket = connect({ host: '127.0.0.1', port: target.port });
      closeTasks.push(async () => { socket.destroy(); });
      await once(socket, 'connect');
      let buffer: Buffer = Buffer.alloc(0);
      const response = new Promise<string>((resolve, reject) => {
        socket.once('error', reject);
        socket.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          const parsed = takeHttpResponse(buffer);
          if (parsed) resolve(parsed.response);
        });
      });
      const body = JSON.stringify({ model: 'gpt-5', input: 'hello' });
      socket.write(target.localCapability, 'ascii');
      socket.write(['POST /v1/responses HTTP/1.1', 'Host: 127.0.0.1', 'Connection: keep-alive',
        'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, '', body].join('\r\n'), 'utf8');
      expect(await response).toContain('HTTP/1.1 200');
    };
    const closeUnusedStream = async (consumer: Consumer = authority.payload.consumer, expired = false) => {
      const target = await admitStream(consumer, expired);
      expect(target.statusCode).toBe(204);
      const socket = connect({ host: '127.0.0.1', port: target.port });
      closeTasks.push(async () => { socket.destroy(); });
      await once(socket, 'connect');
      const closed = once(socket, 'close');
      // Authenticate the admitted transport, then close it before any HTTP
      // request can select or acquire a source.
      socket.end(target.localCapability, 'ascii');
      await closed;
    };
    const abortUnusedStream = async (expired = false) => {
      const handshake = streamHandshake(undefined, expired);
      const nativeStream = new AbortController();
      const target = await runtime.resolveProviderBrokerApplicationTarget({
        handshake, authority: handshake.authority, signal: nativeStream.signal,
        authenticatedRemoteEndpointId: handshake.authority.payload.initiator.endpointId,
        localEndpointId: handshake.authority.payload.target.endpointId,
      });
      expect(target).not.toBeNull();
      nativeStream.abort();
    };
    return {
      custody, homeReads, streamChecks, infer, admitStream, openInferenceStream, closeUnusedStream, abortUnusedStream, closeRuntime: runtime.close,
      personalConnection,
      child: (consumer: Consumer = authority.payload.consumer) => children.get(operationKey(consumer))!,
      endConsumer: (consumer: Consumer = authority.payload.consumer) => consumers.set(operationKey(consumer), false),
      endOnRequest: () => { endConsumerOnRequest = true; },
      setHomeUnavailable: (unavailable: boolean) => { homeUnavailable = unavailable; },
      failCleanupOnRequest: () => { failCleanupOnRequest = true; },
      onChildRetired: (callback: () => void) => { onChildRetired = callback; },
      key: operationKey,
    };
  }

  describe('retained consumer currentness through signed private acquisition', () => {
    it('preserves a personal Gateway claim through loading and failed catalog refreshes, then serves the same claim', async () => {
      const target = await startRetainedTarget(true);
      const personal = target.personalConnection!;
      await target.infer();
      await vi.waitFor(() => expect(target.streamChecks).toHaveLength(1));
      let failObservation!: (error: Error) => void;
      const heldRow = new Promise<never>((_resolve, reject) => { failObservation = reject; });
      let rowStarted!: () => void;
      const rowRead = new Promise<void>(resolve => { rowStarted = resolve; });
      const refresh = personal.refreshCatalog(async () => { rowStarted(); return heldRow; });
      try {
        expect(getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog?.status).toBe('loading');
        await rowRead;
        await target.closeUnusedStream();
        await vi.waitFor(() => expect(target.streamChecks).toHaveLength(2));
        expect(target.child()).toMatchObject({ current: true, starts: 1, cleanupAttempts: 0 });
      } finally {
        failObservation(new Error('Catalog observation failed'));
        await refresh;
      }
      expect(await refresh).toMatchObject({ status: 'unavailable' });
      await target.closeUnusedStream();
      await vi.waitFor(() => expect(target.streamChecks).toHaveLength(3));
      expect(target.child()).toMatchObject({ current: true, starts: 1, cleanupAttempts: 0 });
      expect(await personal.refreshCatalog()).toMatchObject({ status: 'ready' });
      await target.infer();
      await vi.waitFor(() => expect(target.streamChecks).toHaveLength(4));
      expect(target.child()).toMatchObject({ current: true, starts: 1, cleanupAttempts: 0 });
    });

    it('retires a personal Gateway claim when a ready catalog confirms removal', async () => {
      const target = await startRetainedTarget(true);
      await target.infer();
      await vi.waitFor(() => expect(target.streamChecks).toHaveLength(1));
      const personal = target.personalConnection!;
      expect(await personal.refreshCatalog(async () => personal.removeConnection())).toMatchObject({ status: 'ready' });
      await target.closeUnusedStream();
      await vi.waitFor(() => expect(target.child()).toMatchObject({ current: false, cleanupAttempts: 1 }));
    });

    it.each(['account-replaced', 'lifetime-ended'] as const)('retires a personal Gateway claim after its Account is %s', async cause => {
      const target = await startRetainedTarget(true);
      await target.infer();
      await vi.waitFor(() => expect(target.streamChecks).toHaveLength(1));
      if (cause === 'account-replaced') {
        setActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!, scopeKey: 'different-account' });
      } else {
        resetActiveAccountSettingsSnapshotForTests();
      }
      await target.closeUnusedStream();
      await vi.waitFor(() => expect(target.child()).toMatchObject({ current: false, cleanupAttempts: 1 }));
    });

    it.each([false, true])('revalidates connected catalogs and skips unrelated service facts for a personal=%s source', async personal => {
      const target = await startRetainedTarget(personal);
      await target.infer();
      await vi.waitFor(() => expect(target.streamChecks).toHaveLength(1));
      target.homeReads.length = 0;
      for (let arrival = 0; arrival < 20; arrival++) {
        await target.custody.revalidateRetainedClaims(undefined, undefined, {
          facts: ['connected-services'], connectedServiceRefs: [{ pluginId: 'unrelated.plugin', localId: 'accounts' }],
        });
      }
      if (personal) await target.custody.revalidateRetainedClaims(undefined, undefined, { facts: ['connected-services'] });
      expect(target.homeReads).toEqual([]);
      await target.custody.revalidateRetainedClaims(undefined, undefined, { facts: ['connected-catalog'] });
      expect(target.homeReads).toEqual([target.key(authority.payload.consumer)]);
      expect(target.child().current).toBe(true);
    });

    it('retains an active Run after stream close and retires its ended occurrence without retiring a same-source Session', async () => {
      const target = await startRetainedTarget();
      const run = { kind: 'execution_run' as const, executionRunId: 'run-1' };
      await target.infer(run);
      await vi.waitFor(() => expect(target.streamChecks).toEqual([target.key(run)]));
      expect(target.child(run)).toMatchObject({ current: true, starts: 1, cleanupAttempts: 0 });

      await target.infer();
      await vi.waitFor(() => expect(target.streamChecks).toHaveLength(2));
      target.endConsumer(run);
      const readsBeforeClose = target.homeReads.length;
      await target.closeUnusedStream(run);
      await vi.waitFor(() => expect(target.child(run).current).toBe(false));

      expect(target.homeReads.slice(readsBeforeClose)).toEqual([target.key(run)]);
      expect(target.streamChecks).toEqual([target.key(run), target.key(authority.payload.consumer), target.key(run)]);
      expect(target.child(run)).toMatchObject({ starts: 1, cleanupAttempts: 1 });
      expect(target.child()).toMatchObject({ current: true, starts: 1, cleanupAttempts: 0 });
    });

    it.each([
      { personal: false, expired: false, cancellation: 'tcp_disconnect' },
      { personal: true, expired: false, cancellation: 'tcp_disconnect' },
      { personal: true, expired: true, cancellation: 'tcp_disconnect' },
      { personal: false, expired: false, cancellation: 'admission_cancelled' },
      { personal: true, expired: false, cancellation: 'admission_cancelled' },
      { personal: true, expired: true, cancellation: 'admission_cancelled' },
    ])('revalidates retained custody when a later stream closes before source acquisition ($personal, expired=$expired, $cancellation)', async ({ personal, expired, cancellation }) => {
      const target = await startRetainedTarget(personal);
      const survivor = { kind: 'session' as const, sessionId: 'session-survivor' };
      await target.infer();
      await target.infer(survivor);
      // Both first streams finish their currentness checks while their
      // consumers are live, so they cannot supply the later retirement.
      await vi.waitFor(() => expect(target.streamChecks).toHaveLength(2));
      target.endConsumer();
      const readsBeforeClose = target.homeReads.length;
      if (cancellation === 'admission_cancelled') await target.abortUnusedStream(expired);
      else await target.closeUnusedStream(undefined, expired);
      await vi.waitFor(() => expect(target.child().current, JSON.stringify({ streamChecks: target.streamChecks, homeReads: target.homeReads })).toBe(false));
      expect(target.streamChecks).toEqual([target.key(authority.payload.consumer), target.key(survivor), target.key(authority.payload.consumer)]);
      expect(target.homeReads).toHaveLength(readsBeforeClose + 1);
      expect(target.child().cleanupAttempts).toBe(1);
      expect(target.child(survivor)).toMatchObject({ current: true, cleanupAttempts: 0 });
    });

    it.each([false, true])('performs no Home read when a stream closes without a retained claim (personal=%s)', async personal => {
      const target = await startRetainedTarget(personal);
      await target.closeUnusedStream();
      await target.closeRuntime();
      expect(target.child()).toBeUndefined();
      expect(target.homeReads).toHaveLength(0);
    });

    it('revalidates personal V2 retained custody once and retires an ended consumer on stream close', async () => {
      const target = await startRetainedTarget(true);
      await target.infer();
      expect(target.child().current).toBe(true);
      const before = target.homeReads.length;
      expect(await target.custody.revalidateRetainedClaims()).toBe(0);
      expect(target.homeReads.length - before).toBe(1);
      target.endOnRequest();
      await target.infer();
      await vi.waitFor(() => expect(target.child().current).toBe(false));
      expect(target.child().cleanupAttempts).toBe(1);
      expect(await target.custody.revalidateRetainedClaims()).toBe(0);
    });

    it('retires the exact closed-stream claim on the Home wake after a release never reaches the target', async () => {
      const target = await startRetainedTarget();
      await target.infer();
      await vi.waitFor(() => expect(target.streamChecks).toHaveLength(1));
      expect(target.child().current).toBe(true);
      expect(target.child().cleanupAttempts).toBe(0);

      // This release loses transport authentication before its HTTP request
      // reaches the live broker. There is no successful target retirement.
      const release = await target.admitStream();
      await rawRequestThroughApplicationTarget({ ...release, localCapability: 'x'.repeat(release.localCapability.length),
        method: 'DELETE', path: PROVIDER_BROKER_PRIVATE_CLOSE_PATH });
      expect(target.child().current).toBe(true);
      target.endConsumer();
      expect(await target.custody.revalidateRetainedClaims()).toBe(1);
      expect(target.child()).toMatchObject({ current: false, cleanupAttempts: 1 });
      expect(await target.custody.revalidateRetainedClaims()).toBe(0);
    });

    it('revalidates once on close and retires a consumer that already ended at Home', async () => {
      const target = await startRetainedTarget();
      target.endOnRequest();
      await target.infer();
      await vi.waitFor(() => expect(target.child().current).toBe(false));
      expect(target.child().cleanupAttempts).toBe(1);
      expect(target.homeReads).toEqual([target.key(authority.payload.consumer)]);
      await Promise.resolve();
      expect(target.homeReads).toHaveLength(1);
    });

    it('keeps another same-source consumer current with one Home read per stream close', async () => {
      const target = await startRetainedTarget();
      const survivor = { kind: 'session' as const, sessionId: 'session-survivor' };
      await target.infer();
      await vi.waitFor(() => expect(target.homeReads).toHaveLength(1));
      await target.infer(survivor);
      await vi.waitFor(() => expect(target.homeReads).toHaveLength(2));
      expect(target.homeReads).toEqual([target.key(authority.payload.consumer), target.key(survivor)]);
      expect(target.child().current).toBe(true);
      target.endConsumer();
      expect(await target.custody.revalidateRetainedClaims()).toBe(1);
      expect(target.homeReads).toHaveLength(4);
      expect(target.child()).toMatchObject({ current: false, cleanupAttempts: 1 });
      expect(target.child(survivor)).toMatchObject({ current: true, cleanupAttempts: 0 });
      await target.infer(survivor);
      await vi.waitFor(() => expect(target.homeReads).toHaveLength(5));
      expect(target.child(survivor).starts).toBe(1);
      await Promise.resolve();
      expect(target.homeReads).toHaveLength(5);
    });

    it('keeps failed target cleanup recoverable through the existing retained-currentness pass', async () => {
      const target = await startRetainedTarget();
      await target.infer();
      await vi.waitFor(() => expect(target.homeReads).toHaveLength(1));
      target.child().cleanupFailures = 1;
      target.endConsumer();
      await expect(target.custody.revalidateRetainedClaims()).rejects.toBeInstanceOf(AggregateError);
      expect(target.child()).toMatchObject({ current: true, cleanupAttempts: 1 });
      expect(await target.custody.revalidateRetainedClaims()).toBe(1);
      expect(target.child()).toMatchObject({ current: false, cleanupAttempts: 2 });
      expect(target.homeReads).toHaveLength(2);
    });

    it('preserves retained custody through an unreadable Home until a later currentness decision', async () => {
      const target = await startRetainedTarget();
      await target.infer();
      await vi.waitFor(() => expect(target.homeReads).toHaveLength(1));
      target.setHomeUnavailable(true);
      target.endConsumer();
      expect(await target.custody.revalidateRetainedClaims()).toBe(0);
      expect(target.child()).toMatchObject({ current: true, cleanupAttempts: 0 });
      target.setHomeUnavailable(false);
      expect(await target.custody.revalidateRetainedClaims()).toBe(1);
      expect(target.child()).toMatchObject({ current: false, cleanupAttempts: 1 });
    });

    it('stays clean after a successful retirement loses its release acknowledgement', async () => {
      const target = await startRetainedTarget();
      await target.infer();
      await vi.waitFor(() => expect(target.homeReads).toHaveLength(1));
      const release = await target.admitStream();
      const releaseCaller = new AbortController();
      target.onChildRetired(() => releaseCaller.abort());
      const response = await rawRequestThroughApplicationTarget({ ...release, signal: releaseCaller.signal,
        method: 'DELETE', path: PROVIDER_BROKER_PRIVATE_CLOSE_PATH });
      // The child is retired before the release response can reach its caller.
      expect(response).not.toContain('HTTP/1.1 204');
      expect(target.child()).toMatchObject({ current: false, cleanupAttempts: 1 });
      target.endConsumer();
      expect(await target.custody.revalidateRetainedClaims()).toBe(0);
      expect(target.child().cleanupAttempts).toBe(1);
      expect(target.homeReads).toHaveLength(1);
    });

    it('lets stream close settle after child cleanup fails and recovers on the next Home wake', async () => {
      const target = await startRetainedTarget();
      target.endOnRequest();
      target.failCleanupOnRequest();
      await target.infer();
      await vi.waitFor(() => expect(target.child().cleanupAttempts).toBe(1));
      expect(target.child().current).toBe(true);
      expect(await target.custody.revalidateRetainedClaims()).toBe(1);
      expect(target.child()).toMatchObject({ current: false, cleanupAttempts: 2 });
      expect(target.homeReads).toHaveLength(1);
    });

    it.each([false, true])('settles active streams before retiring daemon custody (personal=%s)', async personal => {
      const target = await startRetainedTarget(personal);
      await target.openInferenceStream();
      const readsBeforeStop = target.homeReads.length;
      await target.closeRuntime();
      expect(target.homeReads).toHaveLength(readsBeforeStop + 1);
      await target.custody.retireAll();
      expect(target.child()).toMatchObject({ current: false, cleanupAttempts: 1 });
      expect(target.homeReads).toHaveLength(readsBeforeStop + 1);
    });
  });

  async function startTarget(
    admitRequest: Parameters<typeof startDaemonProviderBrokerRuntime>[0]['admitRequest'],
    options: Readonly<{
      resourceRevision?: () => number;
      /** The resource's current request policy, as the Home serves it now. */
      requestPolicy?: () => TeamCredentialResourceSummaryV1['requestPolicy'];
      providerRequest?: ManagedProviderEndpointHttpAccess['request'];
    }> = {},
  ) {
    // The Home's current resource revision, read by the daemon's request
    // policy and source-currentness owners exactly as production does.
    const resourceRevision = options.resourceRevision ?? (() => 7);
    let upstreamHits = 0;
    const upstream = createServer((_request, response) => {
      upstreamHits += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    closeTasks.push(async () => await new Promise<void>((resolve) => upstream.close(() => resolve())));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('upstream unavailable');
    const access: ManagedProviderEndpointHttpAccess = {
      endpointUrl: () => `http://127.0.0.1:${address.port}/v1`,
      request: options.providerRequest ?? (async (request) => {
        const response = await fetch(`http://127.0.0.1:${address.port}${request.pathAndQuery}`, {
          method: request.method,
          body: request.body,
          // Preserve the native signal across the legacy fetch type boundary.
          signal: request.signal as NonNullable<Parameters<typeof fetch>[1]>['signal'],
        });
        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: response.body,
        };
      }),
    };
    const order: string[] = [];
    // The managed Provider process host is the system boundary: starting or
    // joining it is the effect under test; retiring it ends the claim.
    const custody: ManagedProviderExplicitStartCustody = Object.freeze({
      acquire: vi.fn(async () => {
        order.push('source-custody');
        return { access, isCurrent: () => true, cleanup: async () => {} };
      }),
      retire: vi.fn(async () => true),
      retireExternalApiKey: vi.fn(async () => true),
      revalidateRetainedClaims: vi.fn(async () => 0),
      retireAll: vi.fn(async () => 0),
    });
    const resolveBindingIntentSelection = vi.fn(async ({ purpose, target }) => ({
      binding: { purpose, target },
      resolved: { displayName: 'Account 1', account: source.target.account },
      isCurrent: async () => true,
    }));
    const runtime = await startDaemonProviderBrokerRuntime({
      machineId: 'broker-machine',
      resolveTrustRoots: () => homeTrustRoots,
      nowMs: () => 150,
      resolveRequestPolicy: async () => ({
        resourceRevision: resourceRevision(),
        sourceRevision: 'source-revision-7',
        application: authority.payload.application,
        policy: options.requestPolicy?.() ?? null,
        modelCatalog: {
          models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }],
          resolveCanonicalModelId: (modelId: string) => modelId,
        },
        source,
      }),
      admitRequest: async (request) => {
        order.push('home-admission');
        return await admitRequest(request);
      },
      authorizeModelCatalog: async () => ({ ok: true as const }),
      sourceOwner: createTeamCredentialBrokerSourceOwner({
        machineId: 'broker-machine',
        custody,
        selectConnectedServicesSourceMember: createConnectedServicesBrokerSourceMemberSelect({
          withRegistry: async (read) => await read(createBrokerProviderRegistry()),
          resolveBindingIntentSelection,
        }),
        openConnectedServicesSource: createConnectedServicesBrokerSourceOpen({
          withRegistry: async (read) => await read(createBrokerProviderRegistry()),
          readResource: async () => ({ ...brokerResource, revision: resourceRevision() }),
          resolveBindingIntentSelection,
          custody,
        }),
        openProviderConnectionSource: async () => null,
      }),
      createRequestId: () => `request-${order.length}`,
    });
    closeTasks.push(runtime.close);
    const admitStream = startBrokerAdmission(runtime, 150);
    const infer = async () => {
      const stream = await admitStream();
      expect(stream.statusCode).toBe(204);
      return await rawRequestThroughApplicationTarget({
        ...stream,
        method: 'POST',
        path: '/v1/responses',
        body: JSON.stringify({ model: 'gpt-5', input: 'hello' }),
      });
    };
    /** Several sequential HTTP requests on ONE admitted application stream,
     * the way an Agent's keep-alive connection reaches the target. */
    const inferOnOneStream = async (steps: ReadonlyArray<Readonly<{ before?: () => void; model?: string }>>) => {
      const stream = await admitStream();
      expect(stream.statusCode).toBe(204);
      return await keepAliveRequestsThroughApplicationTarget({
        ...stream,
        steps: steps.map((step) => ({
          ...(step.before ? { before: step.before } : {}),
          path: '/v1/responses',
          body: JSON.stringify({ model: step.model ?? 'gpt-5', input: 'hello' }),
        })),
      });
    };
    return { infer, inferOnOneStream, custody, order, upstreamHits: () => upstreamHits };
  }

  const admittedFor = (request: Readonly<{ sourceMemberKey: string }>) => {
    expect(request.sourceMemberKey).toBe(computeTeamCredentialSourceMemberKeyV1({
      kind: 'connected_account',
      service: source.target.account.service,
      connectedAccountId: source.target.account.accountId,
    }));
    return {
      ok: true as const,
      resourceId: 'resource-1',
      brokerMachineId: 'broker-machine',
      source,
      operation: authority.payload.consumer,
      usageEventId: 'usage-1',
    };
  };

  it.each(['home_admission', 'upstream_forward'] as const)(
    'attributes an unexpected %s failure to the exact broker request without disclosing content',
    async (phase) => {
      const diagnostics = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
      const failure = new AxiosError('private URL/header/body/credential', 'ECONNABORTED');
      const target = await startTarget(async (request) => {
        if (phase === 'home_admission') throw failure;
        return admittedFor(request);
      }, phase === 'upstream_forward' ? { providerRequest: async () => { throw failure; } } : {});
      try {
        const response = await target.infer();
        expect(response).toContain('HTTP/1.1 503');
        expect(response).toContain('broker_unavailable');
        expect(diagnostics).toHaveBeenCalledWith('[provider-broker-application]', expect.objectContaining({
          stage: 'handler', code: 'exception', phase, brokerRequestId: 'request-0',
          errorName: 'AxiosError', errorCode: 'ECONNABORTED',
        }));
        expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private');
        expect(response).not.toContain('private');
        // A failed request never tries another source. Home refusal cannot
        // materialize even the selected source; upstream failure keeps it.
        expect(target.order).toEqual(phase === 'home_admission'
          ? ['home-admission'] : ['home-admission', 'source-custody']);
        expect(target.upstreamHits()).toBe(0);
      } finally {
        diagnostics.mockRestore();
      }
    },
  );

  it('refuses a request revoked after open before any managed source start', async () => {
    const target = await startTarget(async () => ({ ok: false as const, reasonCode: 'resource_forbidden' as const }));

    const response = await target.infer();

    expect(response).toContain('HTTP/1.1 403');
    expect(target.order).toEqual(['home-admission']);
    expect(target.custody.acquire).not.toHaveBeenCalled();
  });

  it('retires the exact operation on actual authority loss, but not on a reached limit', async () => {
    const admitRequest = vi.fn<Parameters<typeof startTarget>[0]>()
      .mockImplementationOnce(async (request) => admittedFor(request))
      .mockImplementationOnce(async () => ({
        ok: false as const,
        reasonCode: 'team_credential_usage_limit' as const,
      }))
      .mockImplementationOnce(async () => ({ ok: false as const, reasonCode: 'resource_forbidden' as const }));
    const target = await startTarget(admitRequest);

    const first = await target.infer();
    expect(first).toContain('HTTP/1.1 200 OK');
    expect(target.order).toEqual(['home-admission', 'source-custody']);

    const limited = await target.infer();
    expect(limited).toContain('HTTP/1.1 403');
    expect(target.custody.retire).not.toHaveBeenCalled();

    const revoked = await target.infer();
    expect(revoked).toContain('HTTP/1.1 403');
    expect(target.custody.acquire).toHaveBeenCalledOnce();
    expect(target.custody.retire).toHaveBeenCalledOnce();
    expect(target.custody.retire).toHaveBeenCalledWith({
      identity: authority.payload.application.implementationIdentity,
      operationClaim: { kind: 'providerBroker', operation: authority.payload.consumer },
    });
  });

  it('keeps a live keep-alive stream across a policy edit and rechecks the next request at the new revision', async () => {
    // L10/04:272 — the revision is a mutable policy fact rechecked online on
    // every request; it is neither stream nor source identity.
    let resourceRevision = 7;
    const admitRequest = vi.fn<Parameters<typeof startTarget>[0]>(async (request) => admittedFor(request));
    const target = await startTarget(admitRequest, { resourceRevision: () => resourceRevision });

    const [first, second] = await target.inferOnOneStream([
      {},
      // The custodian edits the resource policy; the resource stays valid.
      { before: () => { resourceRevision = 8; } },
    ]);

    expect(first).toContain('HTTP/1.1 200 OK');
    expect(second).toContain('HTTP/1.1 200 OK');
    // Each request went to Home admission, the second at the new revision.
    expect(admitRequest.mock.calls.map(([request]) => request.expectedResourceRevision)).toEqual([7, 8]);
    expect(target.upstreamHits()).toBe(2);
    // One operation, one source projection, nothing retired.
    expect(target.custody.acquire).toHaveBeenCalledOnce();
    expect(target.custody.retire).not.toHaveBeenCalled();
  });

  it('serves every currently allowed model on one stream and refuses a model the allowlist dropped on its next request', async () => {
    // L10/04:270 — the model is a current request fact, never signed stream
    // identity; the one request-policy owner re-evaluates it against the
    // resource's current allowlist on every request (L10/PLAN.md:438).
    let resourceRevision = 7;
    let allowedModelIds = ['gpt-5', 'gpt-5-mini'];
    const admitRequest = vi.fn<Parameters<typeof startTarget>[0]>(async (request) => admittedFor(request));
    const target = await startTarget(admitRequest, {
      resourceRevision: () => resourceRevision,
      requestPolicy: () => ({ allowedProtocolKinds: null, allowedModelIds, reasoningEffort: null }),
    });

    const responses = await target.inferOnOneStream([
      { model: 'gpt-5' },
      { model: 'gpt-5-mini' },
      // The custodian drops gpt-5-mini from the resource's allowlist.
      { model: 'gpt-5-mini', before: () => { resourceRevision = 8; allowedModelIds = ['gpt-5']; } },
      { model: 'gpt-5' },
    ]);

    expect(responses[0]).toContain('HTTP/1.1 200 OK');
    expect(responses[1]).toContain('HTTP/1.1 200 OK');
    expect(responses[2]).toContain('HTTP/1.1 403');
    expect(responses[2]).toContain('model_not_allowed');
    expect(responses[3]).toContain('HTTP/1.1 200 OK');
    // The refused model reached neither the Home nor the upstream.
    expect(admitRequest.mock.calls.map(([request]) => [request.requestFacts.modelId, request.expectedResourceRevision]))
      .toEqual([['gpt-5', 7], ['gpt-5-mini', 7], ['gpt-5', 8]]);
    expect(target.upstreamHits()).toBe(3);
    // One operation, one joined source projection, nothing retired.
    expect(target.custody.acquire).toHaveBeenCalledOnce();
    expect(target.custody.retire).not.toHaveBeenCalled();
  });

  it('refuses the second request on one keep-alive stream when Home refuses it, with one upstream hit', async () => {
    const admitRequest = vi.fn<Parameters<typeof startTarget>[0]>()
      .mockImplementationOnce(async (request) => admittedFor(request))
      .mockImplementationOnce(async () => ({ ok: false as const, reasonCode: 'resource_forbidden' as const }));
    const target = await startTarget(admitRequest);

    const [first, second] = await target.inferOnOneStream([{}, {}]);

    expect(first).toContain('HTTP/1.1 200 OK');
    expect(second).toContain('HTTP/1.1 403');
    expect(second).toContain('resource_forbidden');
    // The existing stream's second request was admitted online, not reused.
    expect(admitRequest).toHaveBeenCalledTimes(2);
    expect(target.upstreamHits()).toBe(1);
    // The refused request reached no source custody. The Home writes a
    // UsageEvent only inside an admitted response (proven against the real
    // Home in providerBrokerAdmission.sqlite.integration.spec.ts), so the
    // refusal is the "no second usage" fact at this boundary.
    expect(target.order).toEqual(['home-admission', 'source-custody', 'home-admission']);
  });
});
