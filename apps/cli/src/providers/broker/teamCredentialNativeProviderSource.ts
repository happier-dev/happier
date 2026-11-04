import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderBindingAuthorizationTicketV1, ProviderCredentialTransportV1, ProviderErrorV1, ProviderBrokerApplicationBindingV1 } from '@happier-dev/protocol';
import type { TeamCredentialDeliveryPolicyV1, TeamCredentialResourceSummaryV1, TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams';

import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { isExternalProviderSpawnAuthorization, resolveProviderSpawnAuthorization, type ResolveProviderSpawnAuthorizationInput } from '@/providers/spawn/resolve';
import { projectProviderBindingAuthorizationTicketReference } from '@/providers/spawn/ticket';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import {
  materializeProviderConnectionBrokerSource,
  resolveAdmittedProviderConnectionSourceSnapshot,
  resolveProviderConnectionBrokerSource,
  type ProviderConnectionBrokerSourceSnapshot,
  type ProviderConnectionRegistryReader,
} from './providerConnectionSource';

/** Host-private current Home/source facts; never accepted from an Action operand. */
export type TeamCredentialNativeProviderSourceAuthority = Readonly<{
  resourceId: string;
  resourceRevision: number;
  custodianAccountId: string;
  enabled: boolean;
  deliveryPolicy: TeamCredentialDeliveryPolicyV1;
  source: TeamCredentialSourceBindingV1;
  sourceRevision: string;
}>;

/** Mapping only: the captured Account Home reader owns resource admission. */
export function projectTeamCredentialNativeProviderSourceAuthority(
  resource: TeamCredentialResourceSummaryV1,
  controllerAccountId: string,
): Omit<TeamCredentialNativeProviderSourceAuthority, 'sourceRevision'> | null {
  if (resource.custodianAccountId !== controllerAccountId || resource.source?.kind !== 'provider_connection'
    || !resource.deliveryPolicy) return null;
  return { resourceId: resource.id, resourceRevision: resource.revision,
    custodianAccountId: resource.custodianAccountId, enabled: resource.enabled,
    deliveryPolicy: resource.deliveryPolicy, source: resource.source };
}

export type PrepareTeamCredentialNativeProviderSourceInput = Readonly<{
  controllerAccountId: string;
  controllerMachineId: string;
  accountScopeKey: string;
  resource: TeamCredentialNativeProviderSourceAuthority;
  application: ProviderBrokerApplicationBindingV1;
  binding: Pick<ResolveProviderSpawnAuthorizationInput, 'selection' | 'agentTargetKey' | 'agentId' | 'lease'
    | 'runtimeModelDescriptor' | 'runtimeAdditionalModelDescriptors' | 'runtimeCatalogSnapshotExists'>;
  withRegistry: ProviderConnectionRegistryReader;
  collectDnsEvidence(input: Readonly<{
    source: Extract<TeamCredentialSourceBindingV1, { kind: 'provider_connection' }>;
    registry: ResolveProviderSpawnAuthorizationInput['registry'];
    signal: AbortSignal;
    accountSettingsSnapshot: ActiveAccountSettingsSnapshot;
  }>): Promise<ResolveProviderSpawnAuthorizationInput['dnsEvidenceByEndpointUrl']>;
  getAccountSettingsSnapshot(): ActiveAccountSettingsSnapshot | null;
  savedSecretOperationContext?: import('@/settings/secrets/savedSecretOperationContext').SavedSecretOperationContextV1;
  readCurrentResource(signal: AbortSignal): Promise<TeamCredentialNativeProviderSourceAuthority | null>;
  expectedProviderTicket?: string;
  signal: AbortSignal;
}>;

export type TeamCredentialNativeProviderSource = Readonly<{
  /** Canonical private ticket stays on the source/controller and binding row. */
  authorizationTicket: ProviderBindingAuthorizationTicketV1;
  providerTicket: string;
  sourceRevision: string;
  endpoint: ProviderConnectionBrokerSourceSnapshot['endpoint'];
  credentialTransport: ProviderCredentialTransportV1;
  readRenderedHeaders(): Promise<Readonly<
    | { ok: true; headers: Readonly<Record<string, string>> }
    | { ok: false; error: ProviderErrorV1 }
  >>;
  redact(value: string): string;
  cleanup(): Promise<void>;
}>;

export type PrepareTeamCredentialNativeProviderSourceResult = Readonly<
  | { ok: true; source: TeamCredentialNativeProviderSource }
  | { ok: false; error: ProviderErrorV1 }
>;

/** Metadata authorization precedes the managed owner's deferred material read. */
export async function prepareTeamCredentialNativeProviderSource(
  input: PrepareTeamCredentialNativeProviderSourceInput,
): Promise<PrepareTeamCredentialNativeProviderSourceResult> {
  const expectedResourceId = input.resource.resourceId;
  const expectedResourceRevision = input.resource.resourceRevision;
  const expectedSourceRevision = input.resource.sourceRevision;
  const expectedSource = JSON.stringify(input.resource.source);
  const fail = (code: ProviderErrorV1['code'] = 'provider_authorization_changed') => ({
    ok: false as const, error: createProviderErrorV1(code, { machineId: input.controllerMachineId }),
  });
  let closed = false;
  const leases: Extract<Awaited<ReturnType<typeof materializeProviderConnectionBrokerSource>>, { ok: true }>['lease'][] = [];
  const resolveCurrent = async (registry: ResolveProviderSpawnAuthorizationInput['registry']) => {
    if (closed || input.signal.aborted) return fail();
    const resource = await input.readCurrentResource(input.signal);
    if (!resource || input.signal.aborted || resource.resourceId !== expectedResourceId
      || resource.resourceRevision !== expectedResourceRevision || resource.sourceRevision !== expectedSourceRevision
      || resource.custodianAccountId !== input.controllerAccountId || !resource.enabled
      || !resource.deliveryPolicy.preferredAllowedModes.includes('vendor-native')
      || JSON.stringify(resource.source) !== expectedSource) return fail();
    if (resource.source.kind !== 'provider_connection') return fail('provider_credential_transport_unavailable');
    if (input.binding.selection.ref.providerConnectionId !== resource.source.connectionId
      || input.binding.agentTargetKey !== input.application.agentTargetKey) return fail();
    const initial = input.getAccountSettingsSnapshot();
    if (!initial || initial.scopeKey !== input.accountScopeKey || initial.providerConnectionsCatalog?.status !== 'ready') return fail();
    const dnsEvidenceByEndpointUrl = await input.collectDnsEvidence({ source: resource.source, registry, signal: input.signal, accountSettingsSnapshot: initial });
    const snapshot = input.getAccountSettingsSnapshot();
    if (closed || input.signal.aborted || !snapshot || snapshot.scopeKey !== input.accountScopeKey
      || snapshot.providerConnectionsCatalog?.status !== 'ready') return fail();
    const providerSettings = readProviderSettingsForCli(snapshot).settings;
    const authorized = resolveProviderSpawnAuthorization({ ...input.binding, machineId: input.controllerMachineId,
      accountSettings: snapshot.settings, savedSecretResources: snapshot.savedSecretResources, providerSettings,
      teamCredentialResource: { resourceId: resource.resourceId, resourceRevision: resource.resourceRevision },
      registry, dnsEvidenceByEndpointUrl });
    if (!authorized.ok) return authorized;
    const { authorization } = authorized;
    if (!isExternalProviderSpawnAuthorization(authorization) || authorization.credentialReference.kind !== 'apiKey') {
      return fail('provider_credential_transport_unavailable');
    }
    const transport = authorization.binding.runtimeCredentialTransport;
    if (!transport || transport.destination.kind !== 'httpHeader' || transport.additionalCredentials?.length) {
      return fail('provider_credential_transport_unavailable');
    }
    const endpoint = authorization.binding.endpoint;
    if (!endpoint.normalizedUrl.startsWith('https://')) return fail('provider_endpoint_unavailable');
    if (endpoint.endpointTemplateId !== input.application.endpointTemplateId || endpoint.protocol !== input.application.protocol) return fail();
    const resolved = resolveProviderConnectionBrokerSource({ source: resource.source, machineId: input.controllerMachineId,
      endpointTemplateId: endpoint.endpointTemplateId, protocol: endpoint.protocol, expectedCredentialTransport: transport,
      accountSettings: snapshot.settings, savedSecretResources: snapshot.savedSecretResources, providerSettings,
      registry, dnsEvidenceByEndpointUrl });
    if (!resolved.ok) return resolved;
    if (resolved.snapshot.provider.identity.pluginId !== input.application.implementationIdentity.pluginId
      || resolved.snapshot.provider.identity.localId !== input.application.implementationIdentity.localId) return fail();
    const providerTicket = projectProviderBindingAuthorizationTicketReference(authorization.ticket);
    if (input.expectedProviderTicket !== undefined && providerTicket !== input.expectedProviderTicket) return fail();
    return { ok: true as const, ticket: authorization.ticket, providerTicket,
      snapshot: resolved.snapshot, dnsEvidenceByEndpointUrl };
  };
  let expected: Awaited<ReturnType<typeof resolveCurrent>>;
  try { expected = await input.withRegistry(resolveCurrent); }
  catch { return fail(); }
  if (!expected.ok) return expected;
  const captured = expected;
  return { ok: true, source: Object.freeze({
    authorizationTicket: captured.ticket, providerTicket: captured.providerTicket,
    sourceRevision: expectedSourceRevision, endpoint: captured.snapshot.endpoint,
    credentialTransport: captured.snapshot.credentialRef.transport,
    async readRenderedHeaders() {
      if (closed || input.signal.aborted) return fail();
      const material = await input.withRegistry(async registry => {
        // New installation admits the selected key against Home even when its
        // AccountChange withdrawal hint was missed. Metadata never opens it.
        const admitted = await resolveAdmittedProviderConnectionSourceSnapshot({
          source: captured.snapshot.source, machineId: input.controllerMachineId,
          expectedScopeKey: input.accountScopeKey, registry,
          dnsEvidenceByEndpointUrl: captured.dnsEvidenceByEndpointUrl,
          getAccountSettingsSnapshot: input.getAccountSettingsSnapshot,
          operationContext: input.savedSecretOperationContext, signal: input.signal,
          endpoint: { ...captured.snapshot.endpoint, credentialTransport: captured.snapshot.credentialRef.transport },
        });
        if (!admitted.ok) return admitted;
        return await materializeProviderConnectionBrokerSource({ expected: captured.snapshot, registry,
          dnsEvidenceByEndpointUrl: captured.dnsEvidenceByEndpointUrl, getAccountSettingsSnapshot: input.getAccountSettingsSnapshot });
      }).catch(() => fail());
      if (!material.ok) return material;
      if (closed || input.signal.aborted) { material.lease.close(); return fail(); }
      const credential = material.lease.credential;
      if (credential.kind !== 'httpHeader' || credential.additionalCredentials?.length) {
        material.lease.close(); return fail('provider_credential_transport_unavailable');
      }
      leases.push(material.lease);
      // Public endpoint headers stay with the ordinary Agent adapter. Native
      // policy transforms only this admitted credential, not those headers.
      return { ok: true as const, headers: Object.freeze({ [credential.name]: credential.value }) };
    },
    redact(value: string) { return leases.reduce((redacted, lease) => lease.redact(redacted), value); },
    async cleanup() { closed = true; for (const lease of leases.splice(0)) lease.close(); },
  }) };
}
