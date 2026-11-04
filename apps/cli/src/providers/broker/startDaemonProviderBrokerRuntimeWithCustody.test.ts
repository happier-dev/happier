import { connect } from 'node:net';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import tweetnacl from 'tweetnacl';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createProviderBrokerRouteGrantSigningInputV1,
  FeaturesResponseSchema,
  ProviderBrokerModelCatalogAuthorizationV1Schema,
  ProviderBrokerRequestAdmissionV1Schema,
  type SignedProviderBrokerRouteGrantV1,
} from '@happier-dev/protocol';
import type { TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import {
  createProviderBrokerRouteGrantSigningInputV2,
  ProviderBrokerAccountAdmissionV2Schema,
  type SignedProviderBrokerRouteGrantV2,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { createProviderManagedRuntimeBindingFingerprintV1 } from '@happier-dev/protocol/providers/contributions';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';

import { ApiClient } from '@/api/api';
import { createHttpStatusError } from '@/api/client/httpStatusError';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createManagedServicesOwner } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { createManagedServiceProcessSupervisorHost } from '@/plugins/runtime/invocation/services/managedProcessSupervisor';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { createManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { waitForProcessExit } from '@/testkit/process/spawn';
import {
  clearActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshot,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

import { createBrokerProviderRegistry } from './providerBroker.testkit';
import { createConnectedServicesBrokerSourceMemberSelect, createConnectedServicesBrokerSourceOpen } from './connectedServicesSource';
import { createTeamCredentialBrokerSourceOwner } from './teamCredentialBrokerSourceOwner';
import { readTeamCredentialBrokerResource, startDaemonProviderBrokerRuntimeWithCustody } from './startDaemonProviderBrokerRuntimeWithCustody';
import { revalidateExternalProviderBrokerAuthorization } from './daemonProviderBrokerRuntime';

const { axiosGet, axiosPost, readCursor, writeCursor } = vi.hoisted(() => ({
  axiosGet: vi.fn(), axiosPost: vi.fn(), readCursor: vi.fn(), writeCursor: vi.fn(),
}));
// Home HTTP and persisted cursor I/O are the only substituted host boundaries.
vi.mock('axios', () => ({ default: { get: axiosGet, post: axiosPost, isAxiosError: () => false }, isAxiosError: () => false }));
vi.mock('@/persistence', async importOriginal => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readAccountChangesCursor: readCursor,
  writeAccountChangesCursor: writeCursor,
}));

it.each(['network', 500, 403, 404] as const)('composes Team wakes and exact close with a %s Home resource-read outcome', async resourceReadFailure => {
  const previousSnapshot = getActiveAccountSettingsSnapshot();
  clearActiveAccountSettingsSnapshot();
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('token') });
  const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {} })));
  onTestFinished(() => {
    fetchBoundary.mockRestore();
    clearActiveAccountSettingsSnapshot();
    if (previousSnapshot) setActiveAccountSettingsSnapshot(previousSnapshot);
  });
  const application = {
    agentTargetKey: 'agent:codex',
    implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
    endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses',
  } as const;
  const source = { v: 1, kind: 'connected_account',
    target: { kind: 'account', account: {
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'upstream-account',
    } }, credentialIncarnation: 'credential-row-1',
  } as const;
  const resource: TeamCredentialResourceSummaryV1 = {
    id: 'resource-1', teamId: 'team-1', custodianAccountId: 'custodian-account', sourceOwnerDisplayName: null,
    displayName: 'Shared Codex', enabled: true, revision: 7, source,
    deliveryPolicy: { preferredAllowedModes: ['brokered'] }, sessionUsePolicy: 'personal_allowed',
    sourcePresentation: { kind: 'connected_service', service: source.target.account.service },
    directExportSupport: 'unsupported', activeUsageLimitCount: 0, requestPolicy: null,
    brokerPlacement: { kind: 'machine', machineId: 'broker-machine' },
    allMembersAllowedRoutes: null, groupGrants: [], memberGrants: [], readiness: { kind: 'available' }, recoveryAction: null,
    brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
    capabilities: { manageAudience: false, managePolicy: false, manageLimits: false, updateBrokerPlacement: false,
      updateDeliveryPolicy: false, narrowDisclosure: false, widenDisclosure: false, refreshDirectMaterial: false, disable: false, enable: false, delete: false },
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  };
  let cursor = 0;
  let homeCursor = 0;
  const currentConsumers = new Set(['ended-at-home', 'stream-ended', 'still-current']);
  const homeReads: string[] = [];
  let resourceFailure: Error | null = null;
  readCursor.mockImplementation(async () => cursor);
  writeCursor.mockImplementation(async (_accountId: string, next: number) => { cursor = next; });
  axiosGet.mockImplementation(async (url: string) => {
    if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'custodian-account' } };
    if (url.endsWith('/v1/account/saved-secrets/resources/materials')) {
      return { status: 200, data: SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [] }) };
    }
    if (url.endsWith('/v1/auth/ping')) return { status: 200, data: {} };
    if (url.includes('/v2/changes')) return { status: 200, data: {
      changes: homeCursor > cursor ? [{ cursor: homeCursor, kind: 'account', entityId: 'teams', changedAt: homeCursor, hint: null }] : [],
      nextCursor: homeCursor,
    } };
    throw new Error(`Unexpected Home HTTP read: ${url}`);
  });
  axiosPost.mockImplementation(async (_url: string, body: unknown) => {
    if (body && typeof body === 'object' && 'resourceId' in body) {
      if (resourceFailure) throw resourceFailure;
      return { status: 200, data: resource };
    }
    const admission = ProviderBrokerRequestAdmissionV1Schema.safeParse(body);
    if (admission.success) return { status: 200, data: { ok: true, resourceId: resource.id,
      brokerMachineId: 'broker-machine', source, operation: admission.data.authority.payload.consumer, usageEventId: 'usage-1' } };
    const request = ProviderBrokerModelCatalogAuthorizationV1Schema.parse(body);
    if (request.authority.payload.consumer.kind !== 'session') throw new Error('Expected Session consumer');
    const sessionId = request.authority.payload.consumer.sessionId;
    homeReads.push(sessionId);
    return { status: 200, data: currentConsumers.has(sessionId)
      ? { ok: true } : { ok: false, reasonCode: 'session_not_active' } };
  });
  const api = await ApiClient.create({ token: 'token', encryption: null });
  const apiMachine = api.machineSyncClient({ id: 'broker-machine', encryptionMode: 'plain', metadata: null,
    metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
  apiMachine.onConnectedServicesProjection(async () => {});
  const syncTeamChange = async () => {
    homeCursor++;
    await (apiMachine as unknown as { syncChangesOnConnect(options: { reason: 'live' }): Promise<void> })
      .syncChangesOnConnect({ reason: 'live' });
  };
  const unused = (): never => { throw new Error('Unexpected effect boundary'); };
  const managed = createManagedServicesOwner({
    processSupervisorHost: createManagedServiceProcessSupervisorHost({ custodyOwner: 'daemon' }),
    dependencies: unused, resolveScope: scope => scope,
  });
  const children = new Map<string, { current: boolean; cleanup: number }>();
  const operationIdentity = (claim: Parameters<ManagedProviderExplicitStartCustody['retire']>[0]) => ({
    operationId: JSON.stringify(claim.operationClaim), pluginId: claim.identity.pluginId,
    contributionQualifiedId: `${claim.identity.pluginId}/providers/${claim.identity.localId}`,
  });
  // This transparent port joins the real managed custody owner. Only the
  // supervised external process is substituted; its cleanup remains observable.
  const custody: ManagedProviderExplicitStartCustody = {
    async acquire(request) {
      const operation = request.operationClaim.operation;
      if (operation.kind !== 'session') throw new Error('Expected Session operation');
      const sessionId = operation.sessionId;
      const joined = await managed.runManagedProviderExplicitStart({
        ...operationIdentity(request), occurrenceId: 'provider-occurrence', purposeBindingsEqualityKey: 'upstream',
        lifecycleKind: 'providerBroker', signal: request.signal, isCurrent: request.isAuthorizationCurrent,
        revalidateRetainedCurrentness: request.revalidateRetainedCurrentness,
        establish: async () => {
          const child = { current: true, cleanup: 0 };
          children.set(sessionId, child);
          return { status: 'running', projection: {
            access: { endpointUrl: () => 'http://127.0.0.1:43120/v1', request: async () =>
              ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: null }) },
            isCurrent: () => child.current,
            cleanup: async () => { child.current = false; child.cleanup++; },
          } };
        },
      });
      return joined.status === 'established' ? joined.value.projection : null;
    },
    retire: async claim => await managed.retireManagedProviderExplicitStart(operationIdentity(claim)),
    retireExternalApiKey: unused,
    revalidateRetainedClaims: async (signal, selector) =>
      await managed.revalidateManagedProviderExplicitStarts(signal, selector ? operationIdentity(selector) : undefined),
    retireAll: async () => await managed.retireManagedProviderExplicitStarts('providerBroker'),
  };
  onTestFinished(async () => { await managed.dispose(); });
  const purposes = createConnectedAccountPurposeBindingOwner({
    store: { read: async () => ({ v: 1, bindings: [] }), update: unused, subscribe: () => ({ dispose() {} }) },
    selectTarget: unused, resolveTarget: async () => ({ displayName: 'Upstream', account: source.target.account }),
    materializeAccount: unused, projectTargetAccounts: unused, assertTargetAccountMaterializable: unused,
  });
  const registry = createBrokerProviderRegistry();
  const withRegistry: Parameters<typeof createConnectedServicesBrokerSourceOpen>[0]['withRegistry'] = async read => await read(registry);
  const sourceOwner = createTeamCredentialBrokerSourceOwner({ machineId: 'broker-machine', custody,
    selectConnectedServicesSourceMember: createConnectedServicesBrokerSourceMemberSelect({
      withRegistry, resolveBindingIntentSelection: purposes.resolveBindingIntentSelection,
    }),
    openConnectedServicesSource: createConnectedServicesBrokerSourceOpen({ withRegistry, custody,
      readResource: async (id, signal) => await readTeamCredentialBrokerResource(api, id, signal),
      resolveBindingIntentSelection: purposes.resolveBindingIntentSelection,
    }),
    openProviderConnectionSource: unused,
  });
  const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
  const runtime = await startDaemonProviderBrokerRuntimeWithCustody({ api, apiMachine, custody, runtime: {
    machineId: 'broker-machine', nowMs: () => 150, createRequestId: () => 'request-1', sourceOwner,
    resolveTrustRoots: () => [{ keyId: 'home', publicKey: Buffer.from(signingKey.publicKey).toString('base64url') }],
    resolveRequestPolicy: async () => ({ resourceRevision: 7, sourceRevision: 'source-revision-7', application, source,
      policy: null, modelCatalog: { models: [{ id: 'gpt-5' }], resolveCanonicalModelId: id => id } }),
    admitRequest: async request => await api.admitTeamCredentialProviderBrokerRequest({ v: 1,
      authority: request.authority, expectedResourceRevision: request.expectedResourceRevision,
      sourceMemberKey: request.sourceMemberKey, requestId: request.requestId, requestFacts: request.requestFacts,
    }, { signal: request.request.signal }),
    authorizeModelCatalog: unused,
  } });
  onTestFinished(runtime.close);
  const open = async (sessionId: string) => {
    const payload: SignedProviderBrokerRouteGrantV1['payload'] = {
      v: 1, grantId: `grant-${sessionId}`, aud: 'happier-provider-broker-route-v1', issuedAt: 100, expiresAt: 200,
      teamId: 'team-1', resourceId: resource.id, sourceRevision: 'source-revision-7', brokerPlacementFingerprint: 'c'.repeat(64),
      initiatorTokenEpoch: 0, initiator: { accountId: 'worker-account', machineId: 'worker-machine', endpointId: 'a'.repeat(64) },
      target: { custodianAccountId: 'custodian-account', machineId: 'broker-machine', endpointId: 'b'.repeat(64) },
      consumer: { kind: 'session', sessionId }, application,
    };
    const authority: SignedProviderBrokerRouteGrantV1 = { payload, signature: { alg: 'Ed25519', keyId: 'home',
      valueBase64Url: Buffer.from(tweetnacl.sign.detached(Buffer.from(createProviderBrokerRouteGrantSigningInputV1(payload)), signingKey.secretKey)).toString('base64url') } };
    const target = await runtime.resolveProviderBrokerApplicationTarget({ handshake: { v: 1, kind: 'provider_broker', authority }, authority,
      authenticatedRemoteEndpointId: payload.initiator.endpointId, localEndpointId: payload.target.endpointId, signal: new AbortController().signal });
    if (!target) throw new Error('Expected admitted application stream');
    return target;
  };
  const infer = async (sessionId: string) => {
    const target = await open(sessionId);
    const socket = connect({ host: '127.0.0.1', port: target.port });
    onTestFinished(() => { socket.destroy(); });
    const response = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      socket.once('error', reject);
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        const received = Buffer.concat(chunks).toString('utf8');
        if (received.includes('\r\n\r\n')) resolve(received);
      });
      socket.once('connect', () => {
        const body = JSON.stringify({ model: 'gpt-5', input: 'hello' });
        socket.write(target.localCapability, 'ascii');
        socket.write(['POST /v1/responses HTTP/1.1', 'Host: 127.0.0.1', 'Connection: keep-alive',
          'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, '', body].join('\r\n'));
      });
    });
    expect(response).toContain('HTTP/1.1 200');
    const previousReads = homeReads.length;
    socket.destroy();
    await vi.waitFor(() => expect(homeReads).toHaveLength(previousReads + 1));
    expect(homeReads.at(-1)).toBe(sessionId);
  };
  expect(homeReads).toEqual([]);
  for (const sessionId of currentConsumers) await infer(sessionId);
  homeReads.length = 0;
  resourceFailure = resourceReadFailure === 'network'
    ? new Error('Home network unavailable')
    : createHttpStatusError(resourceReadFailure, 'Home resource read failed');
  await syncTeamChange();
  expect(homeReads).toEqual([]);
  if (resourceReadFailure === 404) {
    expect(managed.readRetainedSemanticCustodyCount()).toBe(0);
    for (const sessionId of currentConsumers) {
      expect(children.get(sessionId)).toEqual({ current: false, cleanup: 1 });
    }
    resourceFailure = null;
    for (const sessionId of currentConsumers) await infer(sessionId);
  } else {
    expect(managed.readRetainedSemanticCustodyCount()).toBe(3);
    for (const sessionId of currentConsumers) {
      expect(children.get(sessionId)).toEqual({ current: true, cleanup: 0 });
    }
    resourceFailure = null;
  }
  homeReads.length = 0;
  currentConsumers.delete('ended-at-home');
  await syncTeamChange();
  expect([...homeReads].sort()).toEqual(['ended-at-home', 'still-current', 'stream-ended']);
  expect(children.get('ended-at-home')).toEqual({ current: false, cleanup: 1 });
  expect(children.get('still-current')).toEqual({ current: true, cleanup: 0 });
  expect(children.get('stream-ended')).toEqual({ current: true, cleanup: 0 });
  expect(managed.readRetainedSemanticCustodyCount()).toBe(2);
  homeReads.length = 0;
  currentConsumers.delete('stream-ended');
  const target = await open('stream-ended');
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: target.port });
    socket.once('error', reject);
    socket.once('close', resolve);
    socket.once('connect', () => socket.end(target.localCapability, 'ascii'));
  });
  await vi.waitFor(() => expect(children.get('stream-ended')).toEqual({ current: false, cleanup: 1 }));
  expect(homeReads).toEqual(['stream-ended']);
  expect(children.get('still-current')).toEqual({ current: true, cleanup: 0 });
  homeReads.length = 0;
  await runtime.close();
  expect(children.get('still-current')).toEqual({ current: false, cleanup: 1 });
  expect(managed.readRetainedSemanticCustodyCount()).toBe(0);
  // New custody can belong to the replacement broker; the closed instance's
  // listener and feature-disable callback must not act on it.
  let replacementReads = 0;
  const replacement = await custody.acquire({ identity: application.implementationIdentity,
    contributionKey: `${application.implementationIdentity.pluginId}/${application.implementationIdentity.localId}`,
    request: { reason: 'explicitStartLocal', endpointTemplateIds: [application.endpointTemplateId] },
    operationClaim: { kind: 'providerBroker', operation: { kind: 'session', sessionId: 'replacement' } },
    purposeBindings: { v: 1, bindings: [] }, signal: new AbortController().signal,
    isAuthorizationCurrent: () => true, revalidateAuthorization: async () => true,
    revalidateRetainedCurrentness: async () => { replacementReads++; return false; },
  });
  expect(replacement).not.toBeNull();
  await syncTeamChange();
  await runtime.retireAllClaims();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(replacementReads).toBe(0);
  expect(children.get('replacement')).toEqual({ current: true, cleanup: 0 });
  expect(homeReads).toEqual([]);
});

it('composes personal stream close with the exact shared gateway selector through real registry custody', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'personal-broker-composition-' }, async ({ homeDir }) => {
    const controller = createPluginReloadController();
    const fixture = await createManagedRunLaunchFixture({ directory: join(homeDir, 'fixture'), happyHomeDir: homeDir,
      controller, physicalGateway: true });
    const gateway = fixture.gateway!;
    const custody = createManagedProviderExplicitStartCustody({ machineId: fixture.machineId, happyHomeDir: homeDir, controller });
    const api = await ApiClient.create({ token: 'token', encryption: null });
    const apiMachine = api.machineSyncClient({ id: fixture.machineId, encryptionMode: 'plain', metadata: null,
      metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const signingKey = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
    const current = new Map([['selected-connection', true], ['unrelated-connection', true]]);
    const reads: string[] = [];
    axiosPost.mockImplementation(async (_url: string, body: unknown) => {
      const request = ProviderBrokerAccountAdmissionV2Schema.parse(body);
      const connectionId = request.authority.payload.source.connectionId;
      reads.push(connectionId);
      return { status: 200, data: current.get(connectionId) === true
        ? { ok: true } : { ok: false, reasonCode: 'session_not_active' } };
    });
    const application = { agentTargetKey: fixture.agentTargetKey, implementationIdentity: gateway.identity,
      endpointTemplateId: 'api', protocol: 'openai-responses' } as const;
    const authorityFor = (connectionId: string): SignedProviderBrokerRouteGrantV2 => {
      const payload: SignedProviderBrokerRouteGrantV2['payload'] = {
        v: 2, grantId: `grant-${connectionId}`, aud: 'happier-provider-broker-route-v2', issuedAt: 100, expiresAt: 200,
        homeId: 'home', accountId: 'account', initiatorTokenEpoch: 0,
        initiator: { accountId: 'account', machineId: 'consumer-machine', endpointId: 'a'.repeat(64) },
        target: { custodianAccountId: 'account', machineId: fixture.machineId, endpointId: 'b'.repeat(64) },
        consumer: { kind: 'session', sessionId: 'same-session' }, application,
        source: { kind: 'account_connection', connectionId: ProviderConnectionIdSchema.parse(connectionId),
          expectedConnectionSecurityFingerprint: fixture.record.connectionSecurityFingerprint,
          expectedManagedRuntimeBindingFingerprint: createProviderManagedRuntimeBindingFingerprintV1({
            implementationIdentity: gateway.identity, purposeBindings: gateway.purposeBindings,
            managedRuntime: fixture.contributes.providersByContributionKey.get(`${gateway.identity.pluginId}/${gateway.identity.localId}`)!.definition.managedRuntime!,
          }),
        },
      };
      return { payload, signature: { alg: 'Ed25519', keyId: 'home', valueBase64Url: Buffer.from(tweetnacl.sign.detached(
        Buffer.from(createProviderBrokerRouteGrantSigningInputV2(payload)), signingKey.secretKey,
      )).toString('base64url') } };
    };
    const acquire = async (connectionId: string) => {
      const authority = authorityFor(connectionId);
      return await custody.acquire({ identity: gateway.identity,
        contributionKey: `${gateway.identity.pluginId}/${gateway.identity.localId}`,
        request: { reason: 'explicitStartLocal', endpointTemplateIds: ['api'] }, purposeBindings: gateway.purposeBindings,
        operationClaim: { kind: 'providerBroker', operation: authority.payload.consumer },
        sharedGateway: { homeId: 'home', accountId: 'account', machineId: fixture.machineId, connectionId,
          consumerId: JSON.stringify(authority.payload.consumer) },
        signal: new AbortController().signal, isAuthorizationCurrent: () => true, revalidateAuthorization: async () => true,
        revalidateRetainedCurrentness: async signal => revalidateExternalProviderBrokerAuthorization(
          await api.admitAccountConnectionProviderBroker({ v: 2, authority }, { signal }),
        ),
      });
    };
    const unused = (): never => { throw new Error('Unexpected source effect for an unopened stream'); };
    const runtime = await startDaemonProviderBrokerRuntimeWithCustody({ api, apiMachine, custody, runtime: {
      machineId: fixture.machineId, nowMs: () => 150, createRequestId: () => 'request-1',
      resolveTrustRoots: () => [{ keyId: 'home', publicKey: Buffer.from(signingKey.publicKey).toString('base64url') }],
      sourceOwner: createTeamCredentialBrokerSourceOwner({ machineId: fixture.machineId, custody,
        selectConnectedServicesSourceMember: unused, openConnectedServicesSource: unused, openProviderConnectionSource: unused }),
      accountConnection: { homeId: 'home', accountId: 'account', open: unused, retire: unused },
      resolveRequestPolicy: unused, admitRequest: unused, authorizeModelCatalog: unused,
    } });
    try {
      const selected = await acquire('selected-connection');
      const selectedPid = Number(await readFile(join(gateway.directory, 'gateway-started'), 'utf8'));
      const unrelated = await acquire('unrelated-connection');
      const unrelatedPid = Number(await readFile(join(gateway.directory, 'gateway-started'), 'utf8'));
      expect(selected).not.toBeNull();
      expect(unrelated).not.toBeNull();
      current.set('selected-connection', false);
      current.set('unrelated-connection', false);
      reads.length = 0;
      const authority = authorityFor('selected-connection');
      const target = await runtime.resolveProviderBrokerApplicationTarget({ handshake: { v: 2, kind: 'provider_broker', authority }, authority,
        authenticatedRemoteEndpointId: authority.payload.initiator.endpointId, localEndpointId: authority.payload.target.endpointId,
        signal: new AbortController().signal });
      if (!target) throw new Error('Expected personal application stream');
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port: target.port });
        socket.once('error', reject);
        socket.once('close', resolve);
        socket.once('connect', () => socket.end(target.localCapability, 'ascii'));
      });
      await vi.waitFor(() => expect(selected!.isCurrent()).toBe(false));
      expect(await waitForProcessExit(selectedPid)).toBe(true);
      expect(reads).toEqual(['selected-connection']);
      expect(unrelated!.isCurrent()).toBe(true);
      expect(process.kill(unrelatedPid, 0)).toBe(true);
      await runtime.close();
      expect(unrelated!.isCurrent()).toBe(false);
      expect(await waitForProcessExit(unrelatedPid)).toBe(true);
      expect(reads).toEqual(['selected-connection']);
    } finally {
      await runtime.close();
      await fixture.cleanup();
    }
  });
});
