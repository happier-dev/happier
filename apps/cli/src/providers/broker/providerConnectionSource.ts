import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { projectActionFailureCauseV1, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { AgentProviderCredentialTransport } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ProviderCredentialTransportV1, ProviderErrorV1, ProviderWireProtocol, ProviderSettingsV1 } from '@happier-dev/protocol';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { prepareProviderConnectionsCatalogForCli } from '@/providers/settings/hydrate';
import type {
  TeamCredentialBrokerPlacementV1,
  TeamCredentialSourceBindingV1,
  TeamCredentialSourceMemberV1,
} from '@happier-dev/protocol/teams';

import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createSavedSecretMaterializerFromSnapshotV1, type SavedSecretMaterializerV1 } from '@/settings/secrets/savedSecretCatalog';
import { refreshSavedSecretCatalogForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { ManagedProviderEndpointAccessProjection } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { resolveProviderConnectionForMachine, resolveProviderConnectionSecurityFingerprintMatch } from '@/providers/registry';
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
import type { TeamCredentialBrokerSourceOpenInput, TeamCredentialBrokerOpenedSource, TeamCredentialBrokerSourceOpenFailureReason } from './teamCredentialBrokerSourceOwner';
import { preserveBrokerSourceHealthFailure } from './sourceFailure';
import {
  isCpxBrokerApplication,
  providerConnectionBrokerSourceMember,
  sameTeamCredentialBrokerSource,
  teamCredentialBrokerResourceAcceptsMachine,
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
  requestCostDeclared?: true;
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
  expectedCredentialTransport?: AgentProviderCredentialTransport;
  accountSettings: unknown;
  providerSettings: ProviderSettingsV1;
  savedSecretMaterializer: SavedSecretMaterializerV1;
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
  cause?: unknown,
): Readonly<{ ok: false; error: ProviderErrorV1 }> {
  return { ok: false, error: createProviderErrorV1(code, { connectionId: source.connectionId, machineId }, cause) };
}

function selectCredential(input: Readonly<{
  record: ResolvedProviderConnectionRecord;
  protocol: ProviderWireProtocol;
  expectedTransport?: AgentProviderCredentialTransport;
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
  // The private CPX final hop carries the selected primary and required companion headers.
  // Other transports for the same Provider protocol are valid for their
  // native Agent consumers and must not make this adapter ambiguous.
  const selected = input.expectedTransport
    ? transports.find((candidate) => (
        candidate.id === input.expectedTransport!.id
        && JSON.stringify(candidate) === JSON.stringify(input.expectedTransport)
      )) ?? null
    : transports.length === 1 ? transports[0]! : null;
  if (!selected || selected.additionalCredentials?.some(row => row.destination.kind !== 'httpHeader')) return null;
  return { slotId: credential.slotId, transport: selected };
}

/**
 * Projects the exact current Provider facts required by the Team broker. The
 * Provider registry remains the sole endpoint, grant, catalog and credential
 * binding owner. Sealed credential descriptors are opened by the Saved Secret
 * owner; this adapter never probes, refreshes or acquires native material.
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
  const sourceFingerprint = resolveProviderConnectionSecurityFingerprintMatch(record, input.source.connectionSecurityFingerprint);
  if (
    record.deployment.kind !== 'external'
    || record.source.kind !== 'contribution'
    || !sourceFingerprint.matches
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
  const materializer = input.savedSecretMaterializer;
  const reference = resolveProviderCredentialReference({
    providerSettings: input.providerSettings,
    accountSettings: input.accountSettings,
    savedSecretMaterializer: materializer,
    connectionId: record.connectionId,
    machineId: input.machineId,
    credentialSlotId: credential.slotId,
    required: true,
    additionalCredentials: credential.transport.additionalCredentials,
  });
  if (!reference.ok) return reference;
  if (reference.reference.kind === 'apiKey') {
    const refs = [reference.reference.secretId, ...(reference.reference.additionalCredentials ?? []).map(row => row.secretId)];
    for (const ref of refs) {
      const content = materializer.resolveContent(ref);
      if (content.status === 'forbidden'
        || content.status === 'ready' && content.content.v === 2 && content.content.source.kind === 'external') {
        return fail('provider_credential_transport_unavailable', input.source, input.machineId);
      }
    }
  }
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
      ...(record.source.definition.requestCost?.endpointTemplateIds.includes(endpoint.endpointTemplateId)
        ? { requestCostDeclared: true as const } : {}),
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
  savedSecretMaterializer: SavedSecretMaterializerV1;
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
      // Direct delivery's current material is one API key; companion sets stay
      // with the custodian's broker instead of being partially delivered.
      return credential?.slotId === input.source.credentialSlotId && !credential.transport.additionalCredentials?.length;
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
  return resolveAdmittedProviderConnectionSourceSnapshot(input);
}

/** Source-only admission shared by direct export and native installation. An
 * exact selected endpoint/transport is supplied by native Provider admission;
 * direct export retains its canonical deterministic endpoint selection. */
export async function resolveAdmittedProviderConnectionSourceSnapshot(input: Readonly<{
  source: ProviderConnectionSource;
  machineId: string;
  expectedScopeKey: string;
  registry: ProviderContributionRegistryView;
  dnsEvidenceByEndpointUrl: ProviderEndpointDnsEvidence;
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  operationContext?: import('@/settings/secrets/savedSecretOperationContext').SavedSecretOperationContextV1;
  endpoint?: Readonly<{ endpointTemplateId: string; protocol: ProviderWireProtocol; credentialTransport: ProviderCredentialTransportV1 }>;
  signal?: AbortSignal;
}>): Promise<ResolveResult> {
  const resolveFrom = (snapshot: ActiveAccountSettingsSnapshot) => snapshot.providerConnectionsCatalog?.status !== 'ready'
    || snapshot.scopeKey !== input.expectedScopeKey || input.signal?.aborted
    ? fail('provider_authorization_changed', input.source, input.machineId) : (input.endpoint
      ? resolveProviderConnectionBrokerSource({
        source: input.source, machineId: input.machineId, endpointTemplateId: input.endpoint.endpointTemplateId,
        protocol: input.endpoint.protocol, expectedCredentialTransport: input.endpoint.credentialTransport,
        accountSettings: snapshot.settings, providerSettings: readProviderSettingsForCli(snapshot).settings,
        savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot, {
          isCurrent: () => !input.signal?.aborted,
        }), registry: input.registry,
        dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
      }) : resolveProviderConnectionDirectSourceSnapshot({
    source: input.source,
    machineId: input.machineId,
    accountSettings: snapshot.settings,
    providerSettings: readProviderSettingsForCli(snapshot).settings,
    savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot, {
      isCurrent: () => !input.signal?.aborted,
    }),
    registry: input.registry,
    dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
  }));
  const catalog = await prepareProviderConnectionsCatalogForCli({ expectedScopeKey: input.expectedScopeKey,
    operationContext: input.operationContext, signal: input.signal });
  if (catalog.status !== 'ready') return fail('provider_authorization_changed', input.source, input.machineId);
  const current = input.getAccountSettingsSnapshot();
  if (!current) return fail('provider_authorization_changed', input.source, input.machineId);
  const resolved = resolveFrom(current);
  if (!resolved.ok || resolved.snapshot.credentialRef.reference.kind !== 'apiKey') return resolved;
  let admitted: ActiveAccountSettingsSnapshot;
  try {
    admitted = await refreshSavedSecretCatalogForOperation({
      expectedScopeKey: input.expectedScopeKey,
      operationContext: input.operationContext,
      references: [{ ref: resolved.snapshot.credentialRef.reference.secretId },
        ...(resolved.snapshot.credentialRef.reference.additionalCredentials ?? []).map(row => ({ ref: row.secretId }))],
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    return fail('provider_secret_missing', input.source, input.machineId, error);
  }
  return resolveFrom(admitted);
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
      savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(accountSnapshot),
      registry: input.registry,
      dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
      ...(input.localCandidateUrlsByConnectionId
        ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
        : {}),
    });
    if (!current.ok) return false;
    const expectedReference = input.expected.credentialRef.reference;
    const currentReference = current.snapshot.credentialRef.reference;
    return expectedReference.kind === 'apiKey'
      && currentReference.kind === 'apiKey'
      && expectedReference.secretId === currentReference.secretId
      && expectedReference.secretRecordFingerprint === currentReference.secretRecordFingerprint
      && JSON.stringify(expectedReference.additionalCredentials) === JSON.stringify(currentReference.additionalCredentials);
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
    savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(accountSnapshot),
    registry: input.registry,
    dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
    ...(input.localCandidateUrlsByConnectionId
      ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
      : {}),
  });
  if (!current.ok) return current;
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
    savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(accountSnapshot),
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
    // The open already carries the exact selected transport; final
    // materialization must too, or a Provider publishing
    // several runtime header transports for one protocol becomes ambiguous
    // here and no request can be brokered.
    expectedCredentialTransport: input.expected.credentialRef.transport,
    accountSettings: accountSnapshot.settings,
    providerSettings: readProviderSettingsForCli(accountSnapshot).settings,
    savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(accountSnapshot),
    registry: input.registry,
    dnsEvidenceByEndpointUrl: input.dnsEvidenceByEndpointUrl,
    ...(input.localCandidateUrlsByConnectionId
      ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
      : {}),
  });
  if (!current.ok) return current;
  return resolveRuntimeProviderCredential({
    credentialRef: current.snapshot.credentialRef,
    // Materialize from the exact current snapshot whose connection, grant,
    // endpoint and credential slot were just revalidated. The credential
    // reference deliberately comes from that current snapshot so rotation of
    // the Saved Secret in the pinned slot is adopted at request time.
    getAccountSettingsSnapshot: () => accountSnapshot,
  });
}

/**
 * Connects the exact Provider Connection owner to the private CPX/SVC09 data
 * plane. The open captures source metadata once; credential acquisition uses
 * that destination and the current Saved Secret. The bridge receives neither a retained
 * plaintext value nor a Provider/Settings object.
 */
export function createProviderConnectionBrokerSourceOpen(input: Readonly<{
  acquireRequestCostParser?(identity: Readonly<{ pluginId: string; localId: string }>): Promise<import('@/plugins/projection/registry/types').ResolvedProviderRequestCostParser | null>;
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
}>): (request: ProviderConnectionOpenInput) => Promise<TeamCredentialBrokerOpenedSource
  | Readonly<{ unavailable: TeamCredentialBrokerSourceOpenFailureReason; failureCause?: ActionFailureCauseV1 }>> {
  const unavailable = (reason: TeamCredentialBrokerSourceOpenFailureReason, cause?: unknown): Readonly<{
    unavailable: TeamCredentialBrokerSourceOpenFailureReason;
    failureCause?: ActionFailureCauseV1;
  }> => ({ unavailable: reason, ...(cause === undefined ? {} : { failureCause: projectActionFailureCauseV1(cause) }) });
  return async (request) => {
    if (request.brokerMachineId !== input.machineId) return unavailable('broker_machine_mismatch');
    if (request.signal.aborted) return unavailable('request_cancelled');

    const capture = await input.withRegistry(async (registry) => {
      if (!isCpxBrokerApplication(registry, request.application)) return unavailable('application_unavailable');
      const resource = await input.readResource(request.resourceId, request.signal);
      if (!teamCredentialBrokerResourceAcceptsMachine(resource, request.brokerMachineId)
        || !sameTeamCredentialBrokerSource(resource.source, request.source)) return unavailable('resource_not_current');
      const exactSelection = request.operation.kind === 'session' || request.operation.kind === 'execution_run'
        ? await (async () => {
          if (
            !input.resolveExactSelection
            || !resource?.teamId
            || !request.modelId
            || !request.sourceRevision
          ) return null;
          return await input.resolveExactSelection({
              machineId: input.machineId,
              teamId: resource.teamId,
              resourceId: request.resourceId,
              expectedResourceRevision: request.resourceRevision,
              source: request.source,
              application: request.application,
              modelId: request.modelId,
              sourceRevision: request.sourceRevision,
              signal: request.signal,
            });
        })()
      : null;
      if ((request.operation.kind === 'session' || request.operation.kind === 'execution_run')
        && !exactSelection) return unavailable('source_selection_unavailable');
      if (exactSelection?.protocol !== undefined
        && exactSelection.protocol !== request.application.protocol) return unavailable('source_protocol_mismatch');

      const captured = input.getAccountSettingsSnapshot();
      if (!captured?.scopeKey) return unavailable('account_snapshot_unavailable');
      const catalog = captured.providerConnectionsCatalog?.status === 'ready'
        ? captured.providerConnectionsCatalog
        : await prepareProviderConnectionsCatalogForCli({ expectedScopeKey: captured.scopeKey, signal: request.signal });
      const accountSnapshot = input.getAccountSettingsSnapshot();
      if (catalog.status !== 'ready') return unavailable('provider_catalog_unavailable');
      if (accountSnapshot?.scopeKey !== captured.scopeKey) return unavailable('account_snapshot_unavailable');
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
        return unavailable('endpoint_resolution_unavailable');
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
      if (endpoints.length !== 1) return unavailable('endpoint_selection_unavailable');
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
        savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(accountSnapshot, {
          isCurrent: () => !request.signal.aborted,
        }),
        registry,
        dnsEvidenceByEndpointUrl,
        ...(input.localCandidateUrlsByConnectionId
          ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
          : {}),
      });
      if (!resolved.ok) {
        preserveBrokerSourceHealthFailure(resolved.error);
        return unavailable('source_selection_unavailable');
      }
      return resolved.snapshot.activationOccurrenceId !== null
        ? { snapshot: resolved.snapshot, registry, dnsEvidenceByEndpointUrl, scopeKey: captured.scopeKey }
        : unavailable('activation_occurrence_unavailable');
    }).catch(error => {
      preserveBrokerSourceHealthFailure(error);
      return unavailable('source_currentness_unknown', error);
    });
    if ('unavailable' in capture) return capture;
    const expected = capture.snapshot;
    const requestCost = request.operation.kind === 'external_api_key' && expected.requestCostDeclared === true
      ? await input.acquireRequestCostParser?.(expected.provider.identity).catch(() => null)
      : null;
    const requestCostParser = requestCost?.activationOccurrenceId === expected.activationOccurrenceId
      && requestCost.endpointTemplateIds.includes(expected.endpoint.endpointTemplateId)
      ? (usage: unknown) => requestCost.isCurrent() ? requestCost.parse(usage) : null
      : undefined;
    const reopen = async (rejoinSignal: AbortSignal): Promise<TeamCredentialBrokerOpenedSource
      | Readonly<{ unavailable: TeamCredentialBrokerSourceOpenFailureReason }>> => {
      const isCurrent = async (
        signal: AbortSignal = rejoinSignal,
      ): Promise<boolean> => {
        return !signal.aborted && input.getAccountSettingsSnapshot()?.scopeKey === capture.scopeKey;
      };
      const acquireRequestCredential = async (): Promise<RuntimeCredentialLease | null> => {
        if (!await isCurrent()) return null;
        try {
          const materialized = await materializeProviderConnectionBrokerSource({
            expected,
            registry: capture.registry,
            dnsEvidenceByEndpointUrl: capture.dnsEvidenceByEndpointUrl,
            ...(input.localCandidateUrlsByConnectionId
              ? { localCandidateUrlsByConnectionId: input.localCandidateUrlsByConnectionId }
              : {}),
            getAccountSettingsSnapshot: () => {
              const current = input.getAccountSettingsSnapshot();
              return current?.scopeKey === capture.scopeKey ? current : null;
            },
          });
          if (!materialized.ok) return preserveBrokerSourceHealthFailure(materialized.error);
          if (rejoinSignal.aborted) { materialized.lease.close(); return null; }
          return materialized.lease;
        } catch (error) {
          preserveBrokerSourceHealthFailure(error);
          throw error;
        }
      };
      let projection: Awaited<ReturnType<typeof input.openCpxProviderConnection>>;
      try {
        projection = await input.openCpxProviderConnection({
          ...(request.retirementGroup ? { retirementGroup: request.retirementGroup } : {}),
          application: request.application,
          operation: request.operation,
          endpoint: expected.endpoint,
          signal: rejoinSignal,
          isCurrent,
          acquireRequestCredential,
        });
      } catch (error) {
        preserveBrokerSourceHealthFailure(error);
        return unavailable('managed_custody_unavailable', error);
      }
      if (!projection) return unavailable('managed_custody_unavailable');
      if (rejoinSignal.aborted || !projection.isCurrent()) {
        if (!rejoinSignal.aborted && !projection.isCurrent()) {
          await projection.retire().catch(() => undefined);
        }
        await Promise.resolve(projection.cleanup()).catch(() => undefined);
        return unavailable(rejoinSignal.aborted ? 'request_cancelled' : 'projection_not_current');
      }
      return Object.freeze({
        projection: requestCostParser ? Object.freeze({ ...projection, requestCostParser }) : projection,
        retire: projection.retire,
        sourceMember: providerConnectionBrokerSourceMember(request.source),
        reopen,
      });
    };
    return await reopen(request.signal);
  };
}
