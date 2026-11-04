import { ProviderConnectionIdSchema, ProviderSettingsV1Schema, formatSharedSavedSecretRefV1,
  sealSavedSecretResourceStoredContentV1, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import type { TeamCredentialNativeSourceContext } from '@/providers/modelManagement/nativeProviderSource';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

/** Real committed executable plugin, Agent adapter, source catalog and Saved
 * Secret shape. Callers substitute only Home HTTP, credential files and vendor IO. */
export async function createTeamCredentialNativeProviderSourceFixture(input: Readonly<{
  catalogModels?: NonNullable<Parameters<typeof createManagedRunLaunchFixture>[0]>['catalogModels'];
  experimental?: boolean;
}> = {}) {
  const controller = createPluginReloadController();
  const fixture = await createManagedRunLaunchFixture({ controller, catalogModels: input.catalogModels, experimental: input.experimental });
  const registry = resolveProviderContributionRegistryView(fixture.contributes,
    fixture.lease.registry.generation, fixture.lease.registry.readPluginOccurrenceId);
  const connectionId = ProviderConnectionIdSchema.parse('run-gateway');
  const external = ProviderSettingsV1Schema.parse({ ...fixture.providerSettings,
    connections: fixture.providerSettings.connections.map(connection => ({ ...connection, deployment: { kind: 'external' } })),
    machineGrants: [], accountGrants: [],
    secretBindingsByConnectionId: { [connectionId]: { account: { apiKey: formatSharedSavedSecretRefV1('native-key') } } },
  });
  const resolved = resolveProviderConnectionForMachine({ connectionId, machineId: fixture.machineId,
    providerSettings: external, registry, dnsEvidenceByEndpointUrl: new Map([['https://example.test/v1', ['1.1.1.1']]]) });
  if (resolved.status !== 'resolved') { await fixture.cleanup(); throw new Error('Expected external source'); }
  const settings = ProviderSettingsV1Schema.parse({ ...external, accountGrants: [{ v: 1, connectionId,
    connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, confirmedAt: 1 }] });
  const storedContent = sealSavedSecretResourceStoredContentV1({ resourceId: 'native-key', mode: 'plain',
    content: { v: 1, kind: 'apiKey', name: 'Gateway key', value: 'native-source-secret' } });
  const credentials = { token: 'run-account', encryption: null };
  const sharedRow = { resourceId: 'native-key', encryptionMode: 'plain' as const, recipientEnvelope: null, storedContent,
    entry: { ref: formatSharedSavedSecretRefV1('native-key'), source: 'shared_resource' as const,
      relationship: 'recipient' as const, ownerAccountId: 'controller-account', name: 'Gateway key', kind: 'apiKey' as const,
      revision: 1, materialStatus: 'ready' as const,
      capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false } } };
  const snapshot = { ...fixture.snapshot, providerConnectionsCatalog: { status: 'ready' as const, revision: 1,
    catalog: splitProviderSettingsV1(settings).catalog }, savedSecretCatalogState: 'ready' as const,
    savedSecretResources: [{ resourceId: sharedRow.resourceId, ownerAccountId: sharedRow.entry.ownerAccountId,
      displayName: sharedRow.entry.name, kind: sharedRow.entry.kind, encryptionMode: sharedRow.encryptionMode,
      revision: sharedRow.entry.revision, materialStatus: sharedRow.entry.materialStatus, storedContent }] };
  setActiveAccountSettingsSnapshot(snapshot);
  let sourceReads = 0;
  let dnsReads = 0;
  let providersEnabled = true;
  let resource: Awaited<ReturnType<TeamCredentialNativeSourceContext['readResource']>> = {
    resourceId: 'team-resource', resourceRevision: 2, custodianAccountId: 'controller-account', enabled: true,
    deliveryPolicy: { preferredAllowedModes: ['vendor-native'] },
    source: { v: 1, kind: 'provider_connection', connectionId,
      connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, credentialSlotId: 'apiKey' },
  };
  const services = createRuntimeProviderModelManagementServices({ machineId: fixture.machineId, registry,
    featureGate: { isEnabled: () => providersEnabled }, getAccountSettingsSnapshot: getActiveAccountSettingsSnapshot,
    acquireRuntimeLease: async () => {
      const lease = controller.tryAcquireRuntimeRegistry();
      if (!lease) throw new Error('Expected current runtime');
      return lease;
    }, resolveAddresses: async () => { dnsReads++; return ['1.1.1.1']; },
    teamCredentialNativeSource: { controllerAccountId: 'controller-account', readResource: async () => { sourceReads++; return resource; } },
    modelSettingsMutation: async (): Promise<never> => { throw new Error('Unexpected mutation'); } });
  const request = { machineId: fixture.machineId, agentTargetKey: fixture.agentTargetKey, sourceCatalog: true as const,
    refreshPolicy: 'current_only' as const, providerConnection: { connectionId,
      expectedConnectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint },
    nativeSource: { resourceId: 'team-resource', expectedResourceRevision: 2 } };
  return { ...fixture, services, request, credentials, sharedRow, get resource() { return resource; },
    setProvidersEnabled(value: boolean) { providersEnabled = value; },
    setResource(value: typeof resource) { resource = value; }, get sourceReads() { return sourceReads; }, get dnsReads() { return dnsReads; },
    async cleanup() { resetActiveAccountSettingsSnapshotForTests(); await fixture.cleanup(); } };
}
