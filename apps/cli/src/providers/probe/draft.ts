import { randomUUID } from 'node:crypto';

import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderSettingsV1Schema } from '@happier-dev/protocol/providers/settings/v1';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { createEmptyProviderRuntimeStateFileV1 } from '@happier-dev/protocol/providers/runtimeState/v1';
import { createProviderObservationAuthorizationFingerprintV1, createProviderProbeRequestFingerprintV1 } from '@happier-dev/protocol/providers/securityFingerprintsV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { createProviderFingerprintV1 } from '@happier-dev/protocol/providers/fingerprints';
import type { ProviderErrorV1 } from '@happier-dev/protocol';
import { DaemonProviderDraftProbeRequestV1Schema } from '@happier-dev/protocol/rpc/providers';
import type { DaemonProviderDraftProbeRequestV1 } from '@happier-dev/protocol/rpc/providers';

import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { refreshSavedSecretCatalogForOperation } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { acquireSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import type { TargetSecretSourcesV1 } from '@/plugins/runtime/lifecycle/contributions/targetSecretSources';
import { readProviderSettingsForCli } from '../settings/read';
import { resolveProviderConnectionForMachine } from '../registry/resolve';
import { collectProviderConnectionDnsEvidence } from '../registry/dnsEvidence';
import type { ResolvedProviderConnectionEndpoint } from '../registry/types';
import { createAccountBoundProviderSnapshotReader } from '../lifecycle/currentAccountSettingsSnapshot';
import {
  createProviderOperationLifetime,
  type ProviderOperationLifetime,
} from '../operationLifetime';
import type { ProviderRuntimeStateStore } from '../runtimeState';
import type { ProviderProbeHostCredentialReference } from '../spawn/credentials';
import { providerSavedSecretAdmissionError, resolveRuntimeProviderCredential } from '../spawn/runtimeCredential';
import type {
  ProviderProbeAuthorizationPort,
  ProviderProbeAuthorizationRequest,
  ProviderProbeOperationScope,
} from './authorization';
import { createProviderCatalogService, type ProviderCatalogRefreshResult, type ProviderProbeEndpoint } from './catalog';
import type { createProviderProbeHttpClient } from './client';

export function createProviderDraftProbeSchedulerKey(raw: unknown): string {
  const request = DaemonProviderDraftProbeRequestV1Schema.parse(raw);
  return createProviderFingerprintV1('probe-observation', {
    kind: 'draft',
    request,
  });
}

function createEphemeralRuntimeStore(machineId: string): ProviderRuntimeStateStore {
  let state = createEmptyProviderRuntimeStateFileV1(machineId);
  return {
    path: '<ephemeral-draft-provider-probe>',
    read: async () => state,
    updateTransientEndpointHealth: async (transform) => {
      state = { ...state, endpointHealth: [...await transform(state.endpointHealth)] };
    },
    update: async (transform) => {
      state = await transform(state);
      return state;
    },
  };
}

function error(input: DaemonProviderDraftProbeRequestV1, code: Parameters<typeof createProviderErrorV1>[0]) {
  return createProviderErrorV1(code, {
    connectionId: input.draftConnectionId,
    machineId: input.machineId,
  });
}

function createDraftConnection(input: DaemonProviderDraftProbeRequestV1) {
  return ProviderConnectionV1Schema.parse({
    v: 1,
    id: input.draftConnectionId,
    source: { kind: 'custom', template: input.template },
    role: 'named',
    displayName: input.template.name,
    displayNameMode: 'custom',
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
  });
}

function selectedSecretReference(
  input: DaemonProviderDraftProbeRequestV1,
  snapshot: ActiveAccountSettingsSnapshot,
): Readonly<{ secretId: string; secretRecordFingerprint: string }> | null | ProviderErrorV1 {
  if (input.savedSecretId === null) return null;
  const inspected = createSavedSecretMaterializerFromSnapshotV1(snapshot).inspect(input.savedSecretId);
  if (inspected.status !== 'ready') return error(input, 'provider_secret_missing');
  return {
    secretId: input.savedSecretId,
    secretRecordFingerprint: inspected.fingerprint,
  };
}

async function resolveDraftFacts(input: Readonly<{
  request: DaemonProviderDraftProbeRequestV1;
  snapshot: ActiveAccountSettingsSnapshot;
  resolveAddresses: (hostname: string) => Promise<readonly string[]>;
  lifetime: ProviderOperationLifetime;
}>) {
  if (input.snapshot.providerConnectionsCatalog?.status !== 'ready') {
    return { ok: false as const, error: error(input.request, 'provider_probe_authorization_invalid') };
  }
  const currentProviderSettings = readProviderSettingsForCli(input.snapshot);
  if (currentProviderSettings.diagnostics.length > 0
    || currentProviderSettings.settings.connections.some((connection) => connection.id === input.request.draftConnectionId)) {
    return { ok: false as const, error: error(input.request, 'provider_probe_authorization_invalid') };
  }
  const connection = createDraftConnection(input.request);
  const providerSettings = ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [connection],
  });
  const registry = { providersByContributionKey: new Map() };
  const dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
    connectionId: input.request.draftConnectionId,
    machineId: input.request.machineId,
    providerSettings,
    registry,
    resolveAddresses: input.resolveAddresses,
    lifetime: input.lifetime,
  });
  const resolution = resolveProviderConnectionForMachine({
    connectionId: input.request.draftConnectionId,
    machineId: input.request.machineId,
    providerSettings,
    registry,
    dnsEvidenceByEndpointUrl,
  });
  if (resolution.status !== 'resolved') {
    return { ok: false as const, error: error(input.request, 'provider_probe_authorization_invalid') };
  }
  if (resolution.record.deployment.kind !== 'external') {
    return { ok: false as const, error: error(input.request, 'provider_probe_authorization_invalid') };
  }
  return { ok: true as const, record: resolution.record };
}

export function createProviderDraftProbeService(input: Readonly<{
  machineId: string;
  secretSources?: TargetSecretSourcesV1;
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  resolveAddresses: (hostname: string) => Promise<readonly string[]>;
  client: ReturnType<typeof createProviderProbeHttpClient>;
  now?: () => number;
  openTeamDirect?: Parameters<typeof resolveRuntimeProviderCredential>[0]['openTeamDirect'];
}>) {
  const now = input.now ?? Date.now;

  /**
   * Admits this draft probe against Home-current shared material.
   *
   * A hydrated catalog row is not authorization for a *new* operation:
   * `AccountChange` is only a wake-up hint, so a shared Saved Secret revoked
   * since hydration would otherwise still reach the provider. The batch
   * refresh in `hydrateSavedSecretCatalog` is the single owner of that
   * decision and returns the cached snapshot untouched for a personal
   * reference, so a personal-secret draft probe still never touches the
   * network.
   */
  async function admitProbeOperation(
    request: DaemonProviderDraftProbeRequestV1,
    lifetime: ProviderOperationLifetime,
    snapshot: ActiveAccountSettingsSnapshot,
  ) {
    if (request.savedSecretId === null) return { ok: true as const };
    const expectedScopeKey = snapshot.scopeKey;
    if (expectedScopeKey === undefined || expectedScopeKey.length === 0) {
      return { ok: true as const };
    }
    try {
      await refreshSavedSecretCatalogForOperation({
        expectedScopeKey,
        references: [{ ref: request.savedSecretId }],
        ...(lifetime.signal ? { signal: lifetime.signal } : {}),
      });
      return { ok: true as const };
    } catch (caught) {
      return { ok: false as const, error: providerSavedSecretAdmissionError(caught, {
        connectionId: request.draftConnectionId,
        machineId: request.machineId,
      }) };
    }
  }

  async function prepare(
    request: DaemonProviderDraftProbeRequestV1,
    lifetime: ProviderOperationLifetime,
  ) {
    const getAccountSettingsSnapshot = createAccountBoundProviderSnapshotReader(input.getAccountSettingsSnapshot);
    const initialSnapshot = getAccountSettingsSnapshot();
    if (!initialSnapshot) return { ok: false as const, error: error(request, 'provider_probe_authorization_invalid') };
    const admitted = await admitProbeOperation(request, lifetime, initialSnapshot);
    if (!admitted.ok) return admitted;
    const snapshot = getAccountSettingsSnapshot();
    if (!snapshot) return { ok: false as const, error: error(request, 'provider_authorization_changed') };
    const facts = await resolveDraftFacts({
      request,
      snapshot,
      resolveAddresses: input.resolveAddresses,
      lifetime,
    });
    if (!facts.ok) return facts;
    const selectedSecret = selectedSecretReference(request, snapshot);
    if (selectedSecret && 'code' in selectedSecret) return { ok: false as const, error: selectedSecret };
    if (request.template.catalog.source !== 'probe') return { ok: false as const, error: error(request, 'provider_probe_authorization_invalid') };
    const endpoints: ProviderProbeEndpoint[] = facts.record.endpoints.map((endpoint) => ({
      endpointTemplateId: endpoint.endpointTemplateId,
      protocol: endpoint.protocol,
      normalizedUrl: endpoint.normalizedUrl,
      publicHeaders: endpoint.publicHeaders,
      credentialPolicy: request.template.credential === undefined
        ? 'none'
        : request.template.credential.required ? 'required' : 'optional',
    }));
    const preparedProbes: Array<Readonly<{
      endpoint: ResolvedProviderConnectionEndpoint;
      path: string;
      parser: ProviderProbeAuthorizationRequest['parser'];
      requestFingerprint: ReturnType<typeof createProviderProbeRequestFingerprintV1>;
      credentialRef: ProviderProbeHostCredentialReference | null;
      observationAuthorizationFingerprint: ReturnType<typeof createProviderObservationAuthorizationFingerprintV1>;
    }>> = [];
    for (const probe of request.template.catalog.probes) {
      const endpoint = facts.record.endpoints.find((candidate) => candidate.endpointTemplateId === probe.endpointTemplateId);
      if (!endpoint) return { ok: false as const, error: error(request, 'provider_probe_authorization_invalid') };
      const transports = request.template.credential?.transports.filter((transport) =>
        transport.protocols.includes(endpoint.protocol) && transport.uses.includes('probe')) ?? [];
      const selectedTransport = selectedSecret === null ? null : transports[0] ?? null;
      if (selectedSecret !== null && transports.length !== 1) {
        return { ok: false as const, error: error(request, 'provider_credential_transport_unavailable') };
      }
      const requestFingerprint = createProviderProbeRequestFingerprintV1({
        method: 'GET', endpointUrl: endpoint.normalizedUrl, path: probe.path,
        parser: probe.parser, publicHeaders: endpoint.publicHeaders,
      });
      preparedProbes.push({
        endpoint,
        path: probe.path,
        parser: probe.parser,
        requestFingerprint,
        credentialRef: selectedSecret && selectedTransport
          ? {
              connectionId: request.draftConnectionId,
              machineId: request.machineId,
              reference: { kind: 'apiKey', ...selectedSecret },
              transport: selectedTransport,
              protocol: endpoint.protocol,
              admittedSnapshot: snapshot,
            }
          : null,
        observationAuthorizationFingerprint: createProviderObservationAuthorizationFingerprintV1({
          selectedSecretBindingId: selectedSecret?.secretId ?? null,
          selectedSecretRecordFingerprint: selectedSecret?.secretRecordFingerprint ?? null,
          credential: selectedSecret && selectedTransport
            ? { transport: selectedTransport, selectedProtocol: endpoint.protocol, selectedUse: 'probe' }
            : null,
        }),
      });
    }
    let materializer: ReturnType<typeof acquireSavedSecretMaterializerForOperation> | undefined;
    const resolveSavedSecretMaterializer = () => materializer ??= acquireSavedSecretMaterializerForOperation({
      snapshot,
      references: request.savedSecretId ? [{ ref: request.savedSecretId }] : [],
      secretSources: input.secretSources,
      signal: lifetime.signal,
      isCurrent: () => getAccountSettingsSnapshot()?.scopeKey === snapshot.scopeKey && !lifetime.signal?.aborted,
    });
    const authorization: ProviderProbeAuthorizationPort<ResolvedProviderConnectionEndpoint, ProviderProbeHostCredentialReference> = {
      authorize: async (probeRequest) => {
        const prepared = probeRequest.deployment === 'managedLocal' ? undefined : preparedProbes.find((candidate) =>
          probeRequest.connectionId === request.draftConnectionId
          && probeRequest.machineId === request.machineId
          && probeRequest.endpointTemplateId === candidate.endpoint.endpointTemplateId
          && probeRequest.endpointUrl === candidate.endpoint.normalizedUrl
          && probeRequest.protocol === candidate.endpoint.protocol
          && probeRequest.path === candidate.path
          && probeRequest.parser === candidate.parser
          && probeRequest.probeRequestFingerprint === candidate.requestFingerprint);
        return prepared ? {
          ok: true,
          ticket: prepared.endpoint,
          credentialRef: prepared.credentialRef,
          observationAuthorizationFingerprint: prepared.observationAuthorizationFingerprint,
        } : { ok: false, error: error(request, 'provider_probe_authorization_invalid') };
      },
      // This finite read is already admitted; the generic catalog port also
      // serves persisted observations, while this store is request-local.
      revalidate: async () => ({ ok: true }),
      authorizeDestination: async (endpoint, _probeRequest, destination) =>
        getAccountSettingsSnapshot()
          && destination.origin === new URL(endpoint.normalizedUrl).origin
          && destination.scope === endpoint.endpointScope
          ? { ok: true }
          : { ok: false, error: error(request, 'provider_authorization_changed') },
      resolveCredential: async (reference) => resolveRuntimeProviderCredential({
        credentialRef: reference,
        getAccountSettingsSnapshot,
        resolveSavedSecretMaterializer,
        signal: lifetime.signal,
        ...(input.openTeamDirect ? { openTeamDirect: input.openTeamDirect } : {}),
      }),
    };
    return { ok: true as const, endpoints, probes: request.template.catalog.probes, authorization };
  }

  return Object.freeze({
    probe: async (
      raw: unknown,
      lifetime?: ProviderOperationLifetime,
    ): Promise<ProviderCatalogRefreshResult> => {
      const request = DaemonProviderDraftProbeRequestV1Schema.parse(raw);
      if (request.machineId !== input.machineId) {
        return { status: 'error', error: error(request, 'provider_not_enabled_on_machine') };
      }
      if (request.template.catalog.source !== 'probe') return { status: 'not_supported' };
      const operationLifetime = lifetime ?? createProviderOperationLifetime({});
      const operationScope: ProviderProbeOperationScope = { lifetime: operationLifetime };
      const prepared = await prepare(request, operationLifetime);
      if (!prepared.ok) return { status: 'error', error: prepared.error };
      if (prepared.probes.length === 0) return { status: 'not_supported' };
      const service = createProviderCatalogService({
        client: input.client,
        authorization: prepared.authorization,
        runtimeStore: createEphemeralRuntimeStore(input.machineId),
        now,
        createObservationId: randomUUID,
      });
      return service.refresh({
        connectionId: request.draftConnectionId,
        machineId: request.machineId,
        endpoints: prepared.endpoints,
        probes: prepared.probes,
        ...(operationLifetime.signal ? { signal: operationLifetime.signal } : {}),
        wallDeadlineAtMs: operationLifetime.wallDeadlineAtMs,
        operationScope,
      });
    },
  });
}
