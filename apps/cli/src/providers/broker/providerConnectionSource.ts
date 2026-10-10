import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { ProviderCredentialTransportV1, ProviderErrorV1, ProviderWireProtocol, ProviderSettingsV1 } from '@happier-dev/protocol';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { prepareProviderConnectionsCatalogForCli } from '@/providers/settings/hydrate';
import type {
  TeamCredentialBrokerPlacementV1,
  TeamCredentialSourceBindingV1,
  TeamCredentialSourceMemberV1,
} from '@happier-dev/protocol/teams';

import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SavedSecretCatalogResourceInputV1 } from '@/settings/secrets/savedSecretCatalog';
import { refreshSavedSecretCatalogForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { ManagedProviderEndpointAccessProjection } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import type {
  ProviderContributionRegistryView,
  ProviderEndpointDnsEvidence,
  ResolvedProviderConnectionRecord,
} from '@/providers/registry/types';
import {
  resolveProviderCredentialReference,
  resolveProviderCredentialPlaintext,
  type ProviderCredentialPlaintextResultForSpawn,
  type ProviderProbeHostCredentialReference,
} from '@/providers/spawn/credentials';
import { resolveRuntimeProviderCredential } from '@/providers/spawn/runtimeCredential';
import type { TeamCredentialBrokerSourceOpenInput } from './teamCredentialBrokerSourceOwner';
import {
  isCLIProxyAPIBrokerApplication,
  providerConnectionBrokerSourceMember,
  teamCredentialBrokerPlacementAcceptsMachine,
} from './teamCredentialBrokerSourceOwner';

type ProviderConnectionSource = Extract<TeamCredentialSourceBindingV1, { kind: 'provider_connection' }>;

export type ProviderConnectionBrokerSourceSnapshot = Readonly<{
  source: ProviderConnectionSource;
  provider: Readonly<{
    identity: Readonly<{ pluginId: string; localId: string }>;
    definitionRevision: number;
  }>;
  machineId: string;
  connectionRevision: number;
  endpointSetFingerprint: string;
  grantFingerprint: string;
  activationOccurrenceId: string | null;
  endpoint: Readonly<{
    endpointTemplateId: string;
    normalizedUrl: string;
    protocol: ProviderWireProtocol;
    publicHeaders: Readonly<Record<string, string>>;
    resolvedAddresses: readonly string[];
  }>;
  credentialRef: ProviderProbeHostCredentialReference;
}>;

export type ResolveProviderConnectionBrokerSourceInput = Readonly<{
  source: ProviderConnectionSource;
  machineId: string;
  endpointTemplateId: string;
  protocol: ProviderWireProtocol;
  expectedCredentialTransport?: ProviderCredentialTransportV1;
  accountSettings: unknown;
  providerSettings: ProviderSettingsV1;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  localCandidateUrlsByConnectionId?: Parameters<typeof resolveProviderConnectionForMachine>[0]['localCandidateUrlsByConnectionId'];
}>;

type ResolveResult =
  | Readonly<{ ok: true; snapshot: ProviderConnectionBrokerSourceSnapshot }>
  | Readonly<{ ok: false; error: ProviderErrorV1 }>;

type ProviderConnectionOpenInput = TeamCredentialBrokerSourceOpenInput & Readonly<{
  source: ProviderConnectionSource;
}>;

type RuntimeCredentialResult = Awaited<ReturnType<typeof resolveRuntimeProviderCredential>>;
type RuntimeCredentialLease = Extract<RuntimeCredentialResult, { ok: true }>['lease'];

export type ProviderConnectionCpxBridgeOpenInput = Readonly<{
  retirementGroup?: TeamCredentialBrokerSourceOpenInput['retirementGroup'];
  application: ProviderConnectionOpenInput['application'];
  operation: ProviderConnectionOpenInput['operation'];
  endpoint: ProviderConnectionBrokerSourceSnapshot['endpoint'];
  signal: AbortSignal;
  isCurrent(signal?: AbortSignal): Promise<boolean>;
  revalidateOperationAuthorization?(signal?: AbortSignal): Promise<boolean>;
  acquireRequestCredential(): Promise<RuntimeCredentialLease | null>;
}>;

export type ProviderConnectionCpxBridge = Readonly<{
  open(
    input: ProviderConnectionCpxBridgeOpenInput,
  ): Promise<(ManagedProviderEndpointAccessProjection & Readonly<{
    retire(): Promise<void>;
  }>) | null>;
}>;

export type ProviderConnectionRegistryReader = <TResult>(
  read: (registry: ProviderContributionRegistryView) => TResult | Promise<TResult>,
) => Promise<TResult>;

function fail(
  code: ProviderErrorV1['code'],
  source: ProviderConnectionSource,
  machineId: string,
): Readonly<{ ok: false; error: ProviderErrorV1 }> {
  return { ok: false, error: createProviderErrorV1(code, { connectionId: source.connectionId, machineId }) };
}

function selectCredential(input: Readonly<{
  record: ResolvedProviderConnectionRecord;
  protocol: ProviderWireProtocol;
  expectedTransport?: ProviderCredentialTransportV1;
}>): Readonly<{ slotId: string; transport: ProviderCredentialTransportV1 }> | null {
  const credential = input.record.source.kind === 'contribution'
    ? input.record.source.definition.credential
    : input.record.source.template.credential;
  if (!credential) return null;
  const transports = credential.transports.filter((candidate) => (
    candidate.uses.includes('runtime')
    && candidate.protocols.includes(input.protocol)
    && candidate.destination.kind === 'httpHeader'
  ));
  // The private CPX final hop can carry exactly one HTTP-header credential.
  // Other transports for the same Provider protocol are valid for their
  // native Agent consumers and must not make this adapter ambiguous.
  const selected = input.expectedTransport
    ? transports.find((candidate) => (
        candidate.id === input.expectedTransport!.id
        && JSON.stringify(candidate) === JSON.stringify(input.expectedTransport)
      )) ?? null
    : transports.length === 1 ? transports[0]! : null;
  if (!selected) return null;
  return { slotId: credential.slotId, transport: selected };
}

/**
 * Projects the exact current Provider facts required by the Team broker. The
 * Provider registry remains the sole endpoint, grant, catalog and credential
 * binding owner; this adapter does not probe, refresh or decrypt anything.
 */
export function resolveProviderConnectionBrokerSource(
  input: ResolveProviderConnectionBrokerSourceInput,
): ResolveResult {
  const resolution = resolveProviderConnectionForMachine({
    connectionId: input.source.connectionId,
    machineId: input.machineId,
    providerSettings: input.providerSettings,
    registry: input.registry,
    dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
    ...(input.localCandidateUrlsByConnectionId
      ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
      : {}),
  });
  if (resolution.status !== 'resolved') {
    return fail(
      resolution.status === 'endpoint_unresolved'
        ? 'provider_endpoint_unavailable'
        : 'provider_connection_invalid',
      input.source,
      input.machineId,
    );
  }
  const record = resolution.record;
  if (!record.authorization.authorized) {
    return fail(record.authorization.errorCode, input.source, input.machineId);
  }
  if (
    record.deployment.kind !== 'external'
    || record.source.kind !== 'contribution'
    || record.connectionSecurityFingerprint !== input.source.connectionSecurityFingerprint
  ) {
    return fail('provider_authorization_changed', input.source, input.machineId);
  }
  const endpoint = record.endpoints.find((candidate) => (
    candidate.endpointTemplateId === input.endpointTemplateId
    && candidate.protocol === input.protocol
  ));
  if (!endpoint) return fail('provider_endpoint_unavailable', input.source, input.machineId);
  const credential = selectCredential({
    record,
    protocol: input.protocol,
    ...(input.expectedCredentialTransport
      ? { expectedTransport: input.expectedCredentialTransport }
      : {}),
  });
  if (!credential || credential.slotId !== input.source.credentialSlotId) {
    return fail('provider_credential_transport_unavailable', input.source, input.machineId);
  }
  const reference = resolveProviderCredentialReference({
    providerSettings: input.providerSettings,
    accountSettings: input.accountSettings,
    ...(input.savedSecretResources
      ? { savedSecretResources: input.savedSecretResources }
      : {}),
    connectionId: record.connectionId,
    machineId: input.machineId,
    credentialSlotId: credential.slotId,
    required: true,
  });
  if (!reference.ok) return reference;
  return {
    ok: true,
    snapshot: {
      source: input.source,
      provider: {
        identity: {
          pluginId: record.source.pluginId,
          localId: record.source.definition.id,
        },
        definitionRevision: record.source.definition.v,
      },
      machineId: input.machineId,
      connectionRevision: record.connection.revision,
      endpointSetFingerprint: record.endpointSetFingerprint,
      grantFingerprint: record.authorization.grantFingerprint,
      activationOccurrenceId:
        input.registry.providerActivationOccurrenceIdsByPluginId?.get(record.source.pluginId)
        ?? input.registry.providersByContributionKey.get(
          record.source.contributionKey,
        )?.managedRuntime?.activationOccurrenceId
        ?? input.registry.providersByContributionKey.get(
          record.source.contributionKey,
        )?.catalogParsers?.activationOccurrenceId
        ?? null,
      endpoint: {
        endpointTemplateId: endpoint.endpointTemplateId,
        normalizedUrl: endpoint.normalizedUrl,
        protocol: endpoint.protocol,
        publicHeaders: endpoint.publicHeaders,
        resolvedAddresses: endpoint.resolvedAddresses,
      },
      credentialRef: {
        connectionId: record.connectionId,
        machineId: input.machineId,
        reference: reference.reference,
        transport: credential.transport,
        protocol: input.protocol,
      },
    },
  };
}

/** Selects one deterministic runtime endpoint solely to enter the existing exact Provider snapshot owner. */
export function resolveProviderConnectionDirectSourceSnapshot(input: Readonly<{
  source: ProviderConnectionSource;
  machineId: string;
  accountSettings: unknown;
  providerSettings: ProviderSettingsV1;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
}>): ResolveResult {
  const resolution = resolveProviderConnectionForMachine({
    connectionId: input.source.connectionId,
    machineId: input.machineId,
    providerSettings: input.providerSettings,
    registry: input.registry,
    dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
  });
  if (resolution.status !== 'resolved') {
    return fail(
      resolution.status === 'endpoint_unresolved'
        ? 'provider_endpoint_unavailable'
        : 'provider_connection_invalid',
      input.source,
      input.machineId,
    );
  }
  const candidates = resolution.record.endpoints
    .filter((endpoint) => {
      const credential = selectCredential({ record: resolution.record, protocol: endpoint.protocol });
      return credential?.slotId === input.source.credentialSlotId;
    })
    .sort((left, right) => [left.endpointTemplateId, left.protocol, left.normalizedUrl].join('\u0000')
      .localeCompare([right.endpointTemplateId, right.protocol, right.normalizedUrl].join('\u0000')));
  const endpoint = candidates[0];
  if (!endpoint) return fail('provider_credential_transport_unavailable', input.source, input.machineId);
  return resolveProviderConnectionBrokerSource({
    ...input,
    endpointTemplateId: endpoint.endpointTemplateId,
    protocol: endpoint.protocol,
  });
}

/**
 * Direct-material preparation is an operation boundary: it admits the source's
 * Saved Secret against the Home (teams-lane-10 08 §5.8) and resolves the
 * source from the admitted Account snapshot, so a revocation whose
 * AccountChange hint was missed is never prepared for recipients. An unchanged
 * catalog publishes nothing, so this admission cannot wake the reconciler
 * that called it.
 */
export async function resolveAdmittedProviderConnectionDirectSourceSnapshot(input: Readonly<{
  source: ProviderConnectionSource;
  machineId: string;
  expectedScopeKey: string;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  signal?: AbortSignal;
}>): Promise<ResolveResult> {
  const resolveFrom = (snapshot: ActiveAccountSettingsSnapshot) => snapshot.providerConnectionsCatalog?.status !== 'ready'
    ? fail('provider_authorization_changed', input.source, input.machineId) : resolveProviderConnectionDirectSourceSnapshot({
    source: input.source,
    machineId: input.machineId,
    accountSettings: snapshot.settings,
    providerSettings: readProviderSettingsForCli(snapshot).settings,
    ...(snapshot.savedSecretResources ? { savedSecretResources: snapshot.savedSecretResources } : {}),
    registry: input.registry,
    dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
  });
  const catalog = await prepareProviderConnectionsCatalogForCli({ expectedScopeKey: input.expectedScopeKey, signal: input.signal });
  if (catalog.status !== 'ready') return fail('provider_authorization_changed', input.source, input.machineId);
  const current = input.getAccountSettingsSnapshot();
  if (!current) return fail('provider_authorization_changed', input.source, input.machineId);
  const resolved = resolveFrom(current);
  if (!resolved.ok || resolved.snapshot.credentialRef.reference.kind !== 'apiKey') return resolved;
  let admitted: ActiveAccountSettingsSnapshot;
  try {
    admitted = await refreshSavedSecretCatalogForOperation({
      expectedScopeKey: input.expectedScopeKey,
      references: [{ ref: resolved.snapshot.credentialRef.reference.secretId }],
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch {
    return fail('provider_secret_missing', input.source, input.machineId);
  }
  return resolveFrom(admitted);
}

function sameSnapshot(
  left: ProviderConnectionBrokerSourceSnapshot,
  right: ProviderConnectionBrokerSourceSnapshot,
): boolean {
  return left.connectionRevision === right.connectionRevision
    && left.provider.identity.pluginId === right.provider.identity.pluginId
    && left.provider.identity.localId === right.provider.identity.localId
    && left.provider.definitionRevision === right.provider.definitionRevision
    && left.endpointSetFingerprint === right.endpointSetFingerprint
    && left.grantFingerprint === right.grantFingerprint
    && left.activationOccurrenceId === right.activationOccurrenceId
    && left.endpoint.endpointTemplateId === right.endpoint.endpointTemplateId
    && left.endpoint.normalizedUrl === right.endpoint.normalizedUrl
    && left.endpoint.protocol === right.endpoint.protocol
    && JSON.stringify(left.endpoint.publicHeaders) === JSON.stringify(right.endpoint.publicHeaders)
    && JSON.stringify(left.endpoint.resolvedAddresses) === JSON.stringify(right.endpoint.resolvedAddresses)
    && left.credentialRef.transport.id === right.credentialRef.transport.id;
}

/** Revalidates an opaque Provider source snapshot without disclosing material. */
export async function isProviderConnectionBrokerSourceCurrent(input: Readonly<{
  expected: ProviderConnectionBrokerSourceSnapshot;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  localCandidateUrlsByConnectionId?: ResolveProviderConnectionBrokerSourceInput['localCandidateUrlsByConnectionId'];
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
}>): Promise<boolean> {
  try {
    const accountSnapshot = input.getAccountSettingsSnapshot();
    if (!accountSnapshot) return false;
    const current = resolveProviderConnectionBrokerSource({
      source: input.expected.source,
      machineId: input.expected.machineId,
      endpointTemplateId: input.expected.endpoint.endpointTemplateId,
      protocol: input.expected.endpoint.protocol,
      expectedCredentialTransport: input.expected.credentialRef.transport,
      accountSettings: accountSnapshot.settings,
      providerSettings: readProviderSettingsForCli(accountSnapshot).settings,
      ...(accountSnapshot.savedSecretResources
        ? { savedSecretResources: accountSnapshot.savedSecretResources }
        : {}),
      registry: input.registry,
      dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
      ...(input.localCandidateUrlsByConnectionId
        ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
        : {}),
    });
    return current.ok && sameSnapshot(current.snapshot, input.expected);
  } catch {
    return false;
  }
}

/** Direct material captures plaintext and therefore pins the exact Saved
 * Secret record. Unlike broker requests, which intentionally acquire the
 * latest value for every request, a rotated direct credential must invalidate
 * the captured snapshot before it can be published. */
export async function isProviderConnectionDirectSourceCurrent(input: Readonly<{
  expected: ProviderConnectionBrokerSourceSnapshot;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  localCandidateUrlsByConnectionId?: ResolveProviderConnectionBrokerSourceInput['localCandidateUrlsByConnectionId'];
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
}>): Promise<boolean> {
  try {
    const accountSnapshot = input.getAccountSettingsSnapshot();
    if (!accountSnapshot) return false;
    const current = resolveProviderConnectionBrokerSource({
      source: input.expected.source,
      machineId: input.expected.machineId,
      endpointTemplateId: input.expected.endpoint.endpointTemplateId,
      protocol: input.expected.endpoint.protocol,
      expectedCredentialTransport: input.expected.credentialRef.transport,
      accountSettings: accountSnapshot.settings,
      providerSettings: readProviderSettingsForCli(accountSnapshot).settings,
      ...(accountSnapshot.savedSecretResources
        ? { savedSecretResources: accountSnapshot.savedSecretResources }
        : {}),
      registry: input.registry,
      dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
      ...(input.localCandidateUrlsByConnectionId
        ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
        : {}),
    });
    if (!current.ok || !sameSnapshot(current.snapshot, input.expected)) return false;
    const expectedReference = input.expected.credentialRef.reference;
    const currentReference = current.snapshot.credentialRef.reference;
    return expectedReference.kind === 'apiKey'
      && currentReference.kind === 'apiKey'
      && expectedReference.secretId === currentReference.secretId
      && expectedReference.secretRecordFingerprint === currentReference.secretRecordFingerprint;
  } catch {
    return false;
  }
}

/**
 * Materializes the unrendered Provider credential only for the source-owned
 * direct-delivery producer. Broker/runtime callers continue to receive only
 * the rendered, redaction-leased HTTP projection.
 */
export async function materializeProviderConnectionDirectCredential(input: Readonly<{
  expected: ProviderConnectionBrokerSourceSnapshot;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  localCandidateUrlsByConnectionId?: ResolveProviderConnectionBrokerSourceInput['localCandidateUrlsByConnectionId'];
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
}>): Promise<ProviderCredentialPlaintextResultForSpawn> {
  const accountSnapshot = input.getAccountSettingsSnapshot();
  if (accountSnapshot?.providerConnectionsCatalog?.status !== 'ready') {
    return {
      ok: false,
      error: createProviderErrorV1('provider_authorization_changed', {
        connectionId: input.expected.source.connectionId,
        machineId: input.expected.machineId,
      }),
    };
  }
  const current = resolveProviderConnectionBrokerSource({
    source: input.expected.source,
    machineId: input.expected.machineId,
    endpointTemplateId: input.expected.endpoint.endpointTemplateId,
    protocol: input.expected.endpoint.protocol,
    expectedCredentialTransport: input.expected.credentialRef.transport,
    accountSettings: accountSnapshot.settings,
    providerSettings: readProviderSettingsForCli(accountSnapshot).settings,
    ...(accountSnapshot.savedSecretResources
      ? { savedSecretResources: accountSnapshot.savedSecretResources }
      : {}),
    registry: input.registry,
    dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
    ...(input.localCandidateUrlsByConnectionId
      ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
      : {}),
  });
  if (!current.ok) return current;
  if (!sameSnapshot(current.snapshot, input.expected)) {
    return {
      ok: false,
      error: createProviderErrorV1('provider_authorization_changed', {
        connectionId: input.expected.source.connectionId,
        machineId: input.expected.machineId,
      }),
    };
  }
  const reference = current.snapshot.credentialRef.reference;
  if (reference.kind === 'team_direct') {
    return {
      ok: false,
      error: createProviderErrorV1('provider_authorization_changed', {
        connectionId: input.expected.source.connectionId,
        machineId: input.expected.machineId,
      }),
    };
  }
  return resolveProviderCredentialPlaintext({
    reference,
    accountSettings: accountSnapshot.settings,
    ...(accountSnapshot.savedSecretResources
      ? { savedSecretResources: accountSnapshot.savedSecretResources }
      : {}),
    settingsSecretsReadKeys: accountSnapshot.settingsSecretsReadKeys,
    connectionId: current.snapshot.credentialRef.connectionId,
    machineId: current.snapshot.credentialRef.machineId,
  });
}

/**
 * Re-resolves every source fact and then delegates plaintext rendering,
 * current Saved Secret verification and redaction to the canonical runtime
 * credential owner. The returned lease is request-scoped and must be closed by
 * the caller.
 */
export async function materializeProviderConnectionBrokerSource(input: Readonly<{
  expected: ProviderConnectionBrokerSourceSnapshot;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  localCandidateUrlsByConnectionId?: ResolveProviderConnectionBrokerSourceInput['localCandidateUrlsByConnectionId'];
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
}>): Promise<Awaited<ReturnType<typeof resolveRuntimeProviderCredential>>> {
  const accountSnapshot = input.getAccountSettingsSnapshot();
  if (accountSnapshot?.providerConnectionsCatalog?.status !== 'ready') {
    return {
      ok: false,
      error: createProviderErrorV1('provider_authorization_changed', {
        connectionId: input.expected.source.connectionId,
        machineId: input.expected.machineId,
      }),
    };
  }
  const current = resolveProviderConnectionBrokerSource({
    source: input.expected.source,
    machineId: input.expected.machineId,
    endpointTemplateId: input.expected.endpoint.endpointTemplateId,
    protocol: input.expected.endpoint.protocol,
    // The open and its currentness checks already carry the exact selected
    // transport; final materialization must too, or a Provider publishing
    // several runtime header transports for one protocol becomes ambiguous
    // here and no request can be brokered.
    expectedCredentialTransport: input.expected.credentialRef.transport,
    accountSettings: accountSnapshot.settings,
    providerSettings: readProviderSettingsForCli(accountSnapshot).settings,
    ...(accountSnapshot.savedSecretResources
      ? { savedSecretResources: accountSnapshot.savedSecretResources }
      : {}),
    registry: input.registry,
    dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
    ...(input.localCandidateUrlsByConnectionId
      ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
      : {}),
  });
  if (!current.ok) return current;
  if (!sameSnapshot(current.snapshot, input.expected)) {
    return {
      ok: false,
      error: createProviderErrorV1('provider_authorization_changed', {
        connectionId: input.expected.source.connectionId,
        machineId: input.expected.machineId,
      }),
    };
  }
  return resolveRuntimeProviderCredential({
    credentialRef: current.snapshot.credentialRef,
    // Materialize from the exact current snapshot whose connection, grant,
    // endpoint and credential slot were just revalidated. The credential
    // reference deliberately comes from that current snapshot so rotation of
    // the Saved Secret in the pinned slot is adopted at request time.
    getAccountSettingsSnapshot: () => accountSnapshot,
  });
}

function sameSource(
  left: TeamCredentialSourceBindingV1 | null,
  right: ProviderConnectionSource,
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Connects the exact Provider Connection owner to the private CPX/SVC09 data
 * plane. Registry and Settings authority are re-entered for every currentness
 * check and credential acquisition; the bridge receives neither a retained
 * plaintext value nor a Provider/Settings object.
 */
export function createProviderConnectionBrokerSourceOpen(input: Readonly<{
  machineId: string;
  readResource(
    resourceId: string,
    signal: AbortSignal,
  ): Promise<Readonly<{
    teamId?: string;
    source: TeamCredentialSourceBindingV1;
    brokerPlacement: TeamCredentialBrokerPlacementV1 | null;
    revision: number;
    enabled: boolean;
  }> | null>;
  withRegistry: ProviderConnectionRegistryReader;
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  collectDnsEvidence(input: Readonly<{
    source: ProviderConnectionSource;
    registry: ProviderContributionRegistryView;
    signal: AbortSignal;
  }>): Promise<ProviderEndpointDnsEvidence>;
  localCandidateUrlsByConnectionId?: ResolveProviderConnectionBrokerSourceInput['localCandidateUrlsByConnectionId'];
  openCpxProviderConnection: ProviderConnectionCpxBridge['open'];
  resolveExactSelection?(input: Readonly<{
    machineId: string;
    teamId: string;
    resourceId: string;
    expectedResourceRevision: number;
    source: ProviderConnectionSource;
    application: ProviderConnectionOpenInput['application'];
    modelId: string;
    sourceRevision: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    endpointTemplateId: string;
    protocol: ProviderWireProtocol;
    credentialTransport: ProviderCredentialTransportV1;
  }> | null>;
}>): (request: ProviderConnectionOpenInput) => Promise<Readonly<{
  projection: ManagedProviderEndpointAccessProjection;
  retire(): Promise<void>;
  sourceCurrentness: Readonly<{
    sourceMember: TeamCredentialSourceMemberV1;
    isCurrent(): Promise<boolean>;
  }>;
}> | null> {
  return async (request) => {
    if (
      request.brokerMachineId !== input.machineId
      || request.signal.aborted
      || !await input.withRegistry((registry) => isCLIProxyAPIBrokerApplication(registry, request.application))
    ) return null;

    const readsResourceCurrent = async (
      signal: AbortSignal = request.signal,
    ): Promise<boolean> => {
      if (signal.aborted) return false;
      const resource = await input.readResource(request.resourceId, signal);
      // Enabled, placement and source identity; never the policy revision,
      // which the Home rechecks per request (`04-private-iroh-broker-transport.md:272`).
      return resource !== null
        && resource.enabled
        && teamCredentialBrokerPlacementAcceptsMachine(resource.brokerPlacement, request.brokerMachineId)
        && sameSource(resource.source, request.source);
    };
    if (!await readsResourceCurrent()) return null;

    const exactSelectionRequest = request.operation.kind === 'session' || request.operation.kind === 'execution_run'
      ? await (async () => {
          const resource = await input.readResource(request.resourceId, request.signal).catch(() => null);
          if (
            !input.resolveExactSelection
            || !resource?.teamId
            || !request.modelId
            || !request.sourceRevision
          ) return null;
          return {
            input: {
              machineId: input.machineId,
              teamId: resource.teamId,
              resourceId: request.resourceId,
              expectedResourceRevision: request.resourceRevision,
              source: request.source,
              application: request.application,
              modelId: request.modelId,
              sourceRevision: request.sourceRevision,
              signal: request.signal,
            },
            selection: await input.resolveExactSelection({
              machineId: input.machineId,
              teamId: resource.teamId,
              resourceId: request.resourceId,
              expectedResourceRevision: request.resourceRevision,
              source: request.source,
              application: request.application,
              modelId: request.modelId,
              sourceRevision: request.sourceRevision,
              signal: request.signal,
            }).catch(() => null),
          };
        })()
      : null;
    const exactSelection = exactSelectionRequest?.selection ?? null;
    if ((request.operation.kind === 'session' || request.operation.kind === 'execution_run')
      && !exactSelection) return null;
    if (exactSelection?.protocol !== undefined
      && exactSelection.protocol !== request.application.protocol) return null;

    const expected = await input.withRegistry(async (registry) => {
      const captured = input.getAccountSettingsSnapshot();
      if (!captured?.scopeKey) return null;
      const catalog = captured.providerConnectionsCatalog?.status === 'ready'
        ? captured.providerConnectionsCatalog
        : await prepareProviderConnectionsCatalogForCli({ expectedScopeKey: captured.scopeKey, signal: request.signal });
      const accountSnapshot = input.getAccountSettingsSnapshot();
      if (catalog.status !== 'ready' || accountSnapshot?.scopeKey !== captured.scopeKey) return null;
      const dnsEvidenceByEndpointUrl = await input.collectDnsEvidence({
        source: request.source,
        registry,
        signal: request.signal,
      });
      const resolution = resolveProviderConnectionForMachine({
        connectionId: request.source.connectionId,
        machineId: input.machineId,
        providerSettings: readProviderSettingsForCli(accountSnapshot).settings,
        registry,
        dnsEvidenceByEndpointUrl,
        ...(input.localCandidateUrlsByConnectionId
          ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
          : {}),
      });
      if (resolution.status !== 'resolved' || resolution.record.deployment.kind !== 'external') {
        return null;
      }
      const endpoints = resolution.record.endpoints.filter((candidate) => (
        candidate.protocol === request.application.protocol
        && (!exactSelection
          || candidate.endpointTemplateId === exactSelection.endpointTemplateId)
      ));
      // Private Session/Run opens consume the canonical exact source endpoint
      // above. One-shot external/resource-test admission currently carries
      // only the protocol, so refuse ambiguity rather than guessing among
      // same-protocol Provider destinations.
      if (endpoints.length !== 1) return null;
      const resolved = resolveProviderConnectionBrokerSource({
        source: request.source,
        machineId: input.machineId,
        endpointTemplateId: endpoints[0]!.endpointTemplateId,
        protocol: request.application.protocol,
        ...(exactSelection
          ? { expectedCredentialTransport: exactSelection.credentialTransport }
          : {}),
        accountSettings: accountSnapshot.settings,
        providerSettings: readProviderSettingsForCli(accountSnapshot).settings,
        ...(accountSnapshot.savedSecretResources
          ? { savedSecretResources: accountSnapshot.savedSecretResources }
          : {}),
        registry,
        dnsEvidenceByEndpointUrl,
        ...(input.localCandidateUrlsByConnectionId
          ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
          : {}),
      });
      return resolved.ok && resolved.snapshot.activationOccurrenceId !== null
        ? resolved.snapshot
        : null;
    }).catch(() => null);
    if (!expected || !await readsResourceCurrent()) return null;
    const isCurrent = async (
      signal: AbortSignal = request.signal,
    ): Promise<boolean> => {
      if (!await readsResourceCurrent(signal)) return false;
      if (exactSelectionRequest) {
        const currentSelection = await input.resolveExactSelection!({
          ...exactSelectionRequest.input,
          signal,
        }).catch(() => null);
        if (!currentSelection
          || JSON.stringify(currentSelection) !== JSON.stringify(exactSelectionRequest.selection)) return false;
      }
      return await input.withRegistry(async (registry) => {
        const dnsEvidenceByEndpointUrl = await input.collectDnsEvidence({
          source: request.source,
          registry,
          signal,
        });
        return await isProviderConnectionBrokerSourceCurrent({
          expected,
          registry,
          dnsEvidenceByEndpointUrl,
          ...(input.localCandidateUrlsByConnectionId
            ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
            : {}),
          getAccountSettingsSnapshot: input.getAccountSettingsSnapshot,
        });
      });
    };
    const acquireRequestCredential = async (): Promise<RuntimeCredentialLease | null> => {
      if (!await isCurrent()) return null;
      try {
        return await input.withRegistry(async (registry) => {
          const dnsEvidenceByEndpointUrl = await input.collectDnsEvidence({
            source: request.source,
            registry,
            signal: request.signal,
          });
          const materialized = await materializeProviderConnectionBrokerSource({
            expected,
            registry,
            dnsEvidenceByEndpointUrl,
            ...(input.localCandidateUrlsByConnectionId
              ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
              : {}),
            getAccountSettingsSnapshot: input.getAccountSettingsSnapshot,
          });
          if (!materialized.ok) return null;
          return materialized.lease;
        });
      } catch {
        return null;
      }
    };
    const projection = await input.openCpxProviderConnection({
      ...(request.retirementGroup ? { retirementGroup: request.retirementGroup } : {}),
      application: request.application,
      operation: request.operation,
      endpoint: expected.endpoint,
      signal: request.signal,
      isCurrent,
      ...(request.revalidateOperationAuthorization
        ? {
            revalidateOperationAuthorization:
              request.revalidateOperationAuthorization,
          }
        : {}),
      acquireRequestCredential,
    }).catch(() => null);
    if (!projection || request.signal.aborted || !await isCurrent() || !projection.isCurrent()) {
      if (projection) {
        if (!request.signal.aborted) await projection.retire().catch(() => undefined);
        await Promise.resolve(projection.cleanup()).catch(() => undefined);
      }
      return null;
    }
    return Object.freeze({
      projection,
      retire: projection.retire,
      sourceCurrentness: Object.freeze({
        sourceMember: providerConnectionBrokerSourceMember(request.source),
        isCurrent,
      }),
    });
  };
}
