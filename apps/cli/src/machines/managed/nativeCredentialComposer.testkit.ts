import axios from 'axios';
import { tmpdir } from 'node:os';
import { vi } from 'vitest';
import nacl from 'tweetnacl';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedControllerCredentialDeliveryReportV1Schema, ManagedNativeCredentialBindingV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { TeamCredentialProviderModelCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { MachineProvisionerNativeCredentialApplyInputV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import * as persistence from '@/persistence';
import { createTeamCredentialNativeProviderSourceFixture } from '@/providers/broker/teamCredentialNativeProviderSource.testkit';
import type { TeamCredentialNativeProviderSource } from '@/providers/broker/teamCredentialNativeProviderSource';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createManagedMachineControllerClient } from './acquire';
import { createManagedNativeInvocation } from './reconcile';
import type { ComposeManagedNativeCredentialsInput } from './nativeCredentialComposer';

export async function createNativeCredentialComposerFixture(fixtureOptions: Readonly<{
  machine?: Partial<Pick<ManagedMachineV1, 'launch' | 'resource'>>;
  nativeOptions?: Parameters<typeof nativeFixture>[0];
  purposeBindingOwner?: Parameters<typeof createManagedProviderOperationAuthority>[0]['purposeBindingOwner'];
}> = {}) {
  const source = await createTeamCredentialNativeProviderSourceFixture();
  const projection = await source.services.projectModels(source.request);
  if (projection.status !== 'success') throw new Error('Expected source catalog');
  const group = projection.groups[0];
  const row = group?.rows[0];
  if (!group?.sourceRevision || !row?.nativeSource || !row.application) throw new Error('Expected native source facts');
  const controller = { machineId: source.machineId, installationId: 'controller-installation' };
  const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_native_composer', custodianAccountId: 'controller-account',
    controller, enrolledMachineId: 'guest', launch: { provider: { pluginId: 'acme.compute', localId: 'vm' },
      schemaVersion: 1, name: 'guest', choices: {} }, allocation: 'bound', resource: {
      contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
    creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, ...fixtureOptions.machine });
  const model = TeamCredentialProviderModelCatalogEntryV1Schema.parse({ selection: { kind: 'team_credential_provider_model',
    resourceId: 'team-resource', teamId: 'team', expectedResourceRevision: 2, deliveryMode: 'vendor-native',
    agentTargetKey: source.agentTargetKey, modelId: row.ref.modelId }, descriptor: row.descriptor,
    application: row.application, sourceFacts: row.sourceFacts, sourceRevision: group.sourceRevision,
    nativeSource: { providerTicket: row.nativeSource.providerTicket }, availability: 'available' });
  const safeFacet = { managedId: machine.id, controllerInstallationId: controller.installationId,
    guestInstallationId: 'guest-installation', bindingKey: 'binding-a', placeholderRef: 'placeholder-ref-a',
    sourceRevision: group.sourceRevision, providerTicket: row.nativeSource.providerTicket };
  const binding = ManagedNativeCredentialBindingV1Schema.parse({ sessionId: 'session-a', accountId: 'member-account',
    custodianAccountId: machine.custodianAccountId, resourceId: 'team-resource', resourceRevision: 2, managedId: machine.id,
    providerModelSelection: { agentTargetKey: source.agentTargetKey, modelId: row.ref.modelId, application: row.application,
      executionMachineId: 'guest', nativeSource: { sourceRevision: group.sourceRevision, providerTicket: row.nativeSource.providerTicket } },
    safeFacet, installation: 'prepared', delivery: { safeFacet, placeholder: 'random-placeholder-a',
      providerAuthorizationTicket: row.nativeSource.authorizationTicket, endpoint: row.nativeSource.endpoint,
      credentialTransport: row.nativeSource.credentialTransport, model } });
  // Only Home HTTP and the stored credential file are replaced. Source admission,
  // registry activation, source materialization and managed dispatch remain real.
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(source.credentials);
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { resources: [source.sharedRow] } });
  let reportUnavailable = false;
  let nativeBindings = [binding];
  let nativeDesiredBindingKeys: readonly string[] | undefined;
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (String(url).endsWith('/policies')) return { status: 200, data: { machines: [machine], targets: [],
      nativeCredentialPolicies: [{ managedId: machine.id, bindings: nativeBindings,
        desiredBindingKeys: nativeDesiredBindingKeys ?? nativeBindings.map(row => row.safeFacet.bindingKey) }] } };
    if (String(url).endsWith('/get')) return { status: 200, data: machine };
    if (String(url).endsWith('/context')) return { status: 200, data: { machine, requestId: 'native-policy',
      nativeCredentialBindings: [binding], nativeCredentialDesiredBindingKeys: [binding.safeFacet.bindingKey] } };
    if (String(url).endsWith('/report')) {
      const envelope = ManagedControllerCredentialDeliveryReportV1Schema.parse(body);
      const report = envelope.credentialDelivery;
      if ('phase' in report) {
        binding.submission = { requestId: envelope.requestId, operation: report.request.operation ?? 'install' };
        return { status: 200, data: { machine, submitted: true } };
      }
      if (reportUnavailable) throw new Error('Home transport unavailable');
      delete binding.submission;
      if (report.result.kind === 'confirmed' && report.request.operation !== 'release') binding.installation = 'confirmed';
      if (report.result.kind === 'unknown') binding.installation = 'unknown';
      return { status: 200, data: { machine, credentialDeliveryResult: report.result } };
    }
    return { status: 200, data: { machine } };
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
    features: { teams: { enabled: true } }, capabilities: {},
  })), { status: 200, headers: { 'content-type': 'application/json' } })));
  const material: unknown[] = [];
  const calls: Parameters<ComposeManagedNativeCredentialsInput['invoke']>[] = [];
  let materialKeys = [binding.safeFacet.bindingKey];
  let vendorEffect: (() => Promise<void>) | undefined;
  const native = nativeFixture({ nativeCredentialDelivery: true, nativeCredentialService: true, privateNative: true, credentialPurposes: [],
    onNativeCredentialApply: async context => {
      for (const bindingKey of materialKeys) material.push({ bindingKey,
        result: await context.services.machineProvisioners.materializeNativeCredentialHeaders({ bindingKey }) });
      await vendorEffect?.();
    }, ...fixtureOptions.nativeOptions });
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential operation'); };
  const managedProviderOperationAuthority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
    purposeBindingOwner: fixtureOptions.purposeBindingOwner ?? createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
      selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
      projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable }),
    requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
    createRedactionLease: () => ({ add() {}, close() {} }) });
  const driverInput = { token: 'token', credentials: source.credentials, serverUrl: 'https://home.example',
    externalActionMachineRequestPrivateKey: nacl.sign.keyPair().secretKey,
    homeId: machine.homeId, controller, runtimeRegistry: native.runtimeRegistry, managedProviderOperationAuthority,
    homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: machine.homeId,
      canonicalServerUrl: 'https://home.example', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example' }] },
      authority: 'current_connection' }) };
  const options = { requestId: 'native-policy', context: { operationOwnerUpdate: { update() {} } } };
  const action = 'machines.managed.credentials.install' as const;
  const client = createManagedMachineControllerClient(driverInput, options, action);
  const invocation = createManagedNativeInvocation({ input: driverInput, options, client, machine, action }, () => machine);
  const handles: TeamCredentialNativeProviderSource[] = [];
  const input: ComposeManagedNativeCredentialsInput = { request: { homeId: machine.homeId, managedId: machine.id,
    sessionId: binding.sessionId, bindingKey: safeFacet.bindingKey, expectedResourceRevision: 2,
    expectedSourceRevision: safeFacet.sourceRevision, expectedProviderTicket: safeFacet.providerTicket }, machine,
    bindings: [binding], desiredBindingKeys: [binding.safeFacet.bindingKey],
    prepareSource: async (...args) => {
      const result = await source.services.prepareTeamCredentialNativeSource(...args);
      if (result.ok) handles.push(result.source);
      return result;
    }, invoke: async (...args) => {
      calls.push(args);
      materialKeys = MachineProvisionerNativeCredentialApplyInputV1Schema.parse(args[1]).bindings.map(binding => binding.bindingKey);
      return await invocation.invoke(...args);
    } };
  return { source, input, binding, calls, handles, material, native, driverInput, options,
    setVendorEffect(effect: typeof vendorEffect) { vendorEffect = effect; },
    setReportUnavailable(value: boolean) { reportUnavailable = value; },
    setNativeBindings(value: typeof nativeBindings) { nativeBindings = value; },
    setNativeDesiredBindingKeys(value: readonly string[]) { nativeDesiredBindingKeys = value; },
    cleanup: () => source.cleanup() };
}
