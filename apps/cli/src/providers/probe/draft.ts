import { randomUUID } from 'node:crypto';

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionV1Schema,
  ProviderProbeAuthorizationV1Schema,
  ProviderSettingsV1Schema,
  createEmptyProviderRuntimeStateFileV1,
  createProviderCredentialDestinationFingerprintV1,
  createProviderErrorV1,
  createProviderFingerprintV1,
  createProviderObservationAuthorizationFingerprintV1,
  createProviderProbeRequestFingerprintV1,
  createProviderSavedSecretRecordFingerprintV1,
  type ProviderErrorV1,
  type ProviderProbeAuthorizationV1,
  type ProviderRuntimeStateFileV1,
} from '@happier-dev/protocol';
import {
  DaemonProviderDraftProbeRequestV1Schema,
  type DaemonProviderDraftProbeRequestV1,
} from '@happier-dev/protocol/rpc';

import { indexSavedSecretsByIdFromAccountSettings } from '@/settings/secrets/indexSavedSecretsById';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readProviderSettingsForCli } from '../settings/read';
import { resolveProviderConnectionForMachine } from '../registry/resolve';
import { collectProviderConnectionDnsEvidence } from '../registry/dnsEvidence';
import type { ProviderRuntimeStateStore } from '../runtimeState';
import type { ProviderProbeHostCredentialReference } from '../spawn/credentials';
import { resolveRuntimeProviderCredential } from '../spawn/runtimeCredential';
import type {
  ProviderProbeAuthorizationPort,
  ProviderProbeAuthorizationRequest,
} from './authorization';
import { createProviderCatalogService, type ProviderCatalogRefreshResult, type ProviderProbeEndpoint } from './catalog';
import type { createProviderProbeHttpClient } from './client';

const DEFAULT_AUTHORIZATION_TTL_MS = 30_000;
const MAX_REPLAY_ENTRIES = 256;

type DraftAuthorizationTicket = Readonly<{
  authorization: ProviderProbeAuthorizationV1;
  draftConnectionId: string;
}>;

type DraftAuthorizationRecord = {
  ticket: DraftAuthorizationTicket;
  input: DaemonProviderDraftProbeRequestV1;
  endpointTemplateId: string;
  endpointUrl: string;
  endpointScope: 'account' | 'machine';
  protocol: ProviderProbeAuthorizationRequest['protocol'];
  path: string;
  parser: ProviderProbeAuthorizationRequest['parser'];
  publicHeaders: Readonly<Record<string, string>>;
  credentialRef: ProviderProbeHostCredentialReference | null;
  observationAuthorizationFingerprint: ReturnType<typeof createProviderObservationAuthorizationFingerprintV1>;
  consumed: boolean;
};

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
  const secret = indexSavedSecretsByIdFromAccountSettings(snapshot.settings).get(input.savedSecretId);
  if (!secret?.encryptedValue) return error(input, 'provider_secret_missing');
  return {
    secretId: input.savedSecretId,
    secretRecordFingerprint: createProviderSavedSecretRecordFingerprintV1({
      secretId: input.savedSecretId,
      persistedEncryptedEnvelope: secret.encryptedValue,
    }),
  };
}

async function resolveDraftFacts(input: Readonly<{
  request: DaemonProviderDraftProbeRequestV1;
  snapshot: ActiveAccountSettingsSnapshot;
  resolveAddresses: (hostname: string) => Promise<readonly string[]>;
  exactDestination?: Readonly<{ endpointUrl: string; resolvedAddresses: readonly string[] }>;
}>) {
  const currentProviderSettings = readProviderSettingsForCli(input.snapshot.settings);
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
  let dnsEvidenceByEndpointUrl = await collectProviderConnectionDnsEvidence({
    connectionId: input.request.draftConnectionId,
    machineId: input.request.machineId,
    providerSettings,
    registry,
    resolveAddresses: input.resolveAddresses,
  });
  if (input.exactDestination) {
    const exactEvidenceByEndpointUrl = new Map(dnsEvidenceByEndpointUrl);
    exactEvidenceByEndpointUrl.set(
      input.exactDestination.endpointUrl,
      input.exactDestination.resolvedAddresses,
    );
    dnsEvidenceByEndpointUrl = exactEvidenceByEndpointUrl;
  }
  const resolution = resolveProviderConnectionForMachine({
    connectionId: input.request.draftConnectionId,
    machineId: input.request.machineId,
    accountSettings: { providerSettingsV1: providerSettings },
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
  getAccountSettingsSnapshot: () => ActiveAccountSettingsSnapshot | null;
  resolveAddresses: (hostname: string) => Promise<readonly string[]>;
  client: ReturnType<typeof createProviderProbeHttpClient>;
  now?: () => number;
  createAuthorizationId?: () => string;
  authorizationTtlMs?: number;
  maxReplayEntries?: number;
  beforeAuthorizationConsume?: () => void | Promise<void>;
}>) {
  const now = input.now ?? Date.now;
  const createAuthorizationId = input.createAuthorizationId ?? randomUUID;
  const authorizationTtlMs = Math.min(
    DEFAULT_AUTHORIZATION_TTL_MS,
    Math.max(1, input.authorizationTtlMs ?? DEFAULT_AUTHORIZATION_TTL_MS),
  );
  const maxReplayEntries = Math.min(MAX_REPLAY_ENTRIES, Math.max(1, input.maxReplayEntries ?? MAX_REPLAY_ENTRIES));
  const recordsById = new Map<string, DraftAuthorizationRecord>();
  const replayExpiryByKey = new Map<string, number>();

  function pruneExpired(at: number): void {
    for (const [key, expiresAt] of replayExpiryByKey) {
      if (expiresAt <= at) replayExpiryByKey.delete(key);
    }
    for (const [id, record] of recordsById) {
      if (record.ticket.authorization.expiresAt <= at) recordsById.delete(id);
    }
  }

  function reserveAction(request: DaemonProviderDraftProbeRequestV1): boolean {
    const at = now();
    pruneExpired(at);
    const key = JSON.stringify([request.machineId, request.draftConnectionId, request.actionNonce]);
    if (replayExpiryByKey.has(key) || replayExpiryByKey.size >= maxReplayEntries) return false;
    replayExpiryByKey.set(key, at + authorizationTtlMs);
    for (const [id, record] of recordsById) {
      if (record.ticket.draftConnectionId === request.draftConnectionId) recordsById.delete(id);
    }
    return true;
  }

  async function currentRecordState(
    record: DraftAuthorizationRecord,
    exactDestination?: Readonly<{ endpointUrl: string; resolvedAddresses: readonly string[] }>,
  ) {
    const at = now();
    if (record.ticket.authorization.expiresAt <= at) {
      return { ok: false as const, error: error(record.input, 'provider_probe_authorization_invalid') };
    }
    const snapshot = input.getAccountSettingsSnapshot();
    if (!snapshot) return { ok: false as const, error: error(record.input, 'provider_authorization_changed') };
    const facts = await resolveDraftFacts({
      request: record.input,
      snapshot,
      resolveAddresses: input.resolveAddresses,
      ...(exactDestination ? { exactDestination } : {}),
    });
    if (!facts.ok) return facts;
    const endpoint = facts.record.endpoints.find((candidate) =>
      candidate.endpointTemplateId === record.endpointTemplateId
      && candidate.protocol === record.protocol
      && candidate.normalizedUrl === record.endpointUrl);
    if (!endpoint || facts.record.endpointSetFingerprint !== record.ticket.authorization.endpointSetFingerprint) {
      return { ok: false as const, error: error(record.input, 'provider_authorization_changed') };
    }
    const secret = selectedSecretReference(record.input, snapshot);
    if (secret && 'code' in secret) return { ok: false as const, error: secret };
    const secretId = secret?.secretId ?? null;
    const secretFingerprint = secret?.secretRecordFingerprint ?? null;
    if (secretId !== record.ticket.authorization.selectedSecretBindingId
      || secretFingerprint !== record.ticket.authorization.selectedSecretRecordFingerprint) {
      return { ok: false as const, error: error(record.input, 'provider_authorization_changed') };
    }
    return { ok: true as const, endpoint };
  }

  function requestMatches(record: DraftAuthorizationRecord, request: ProviderProbeAuthorizationRequest): boolean {
    if (request.deployment === 'managedLocal') return false;
    return request.connectionId === record.ticket.draftConnectionId
      && request.machineId === record.input.machineId
      && request.endpointTemplateId === record.endpointTemplateId
      && request.endpointUrl === record.endpointUrl
      && request.protocol === record.protocol
      && request.path === record.path
      && request.parser === record.parser
      && request.probeRequestFingerprint === record.ticket.authorization.probeRequestFingerprint;
  }

  const authorization: ProviderProbeAuthorizationPort<DraftAuthorizationTicket, ProviderProbeHostCredentialReference> = {
    authorize: async (request) => {
      const record = [...recordsById.values()].find((candidate) =>
        !candidate.consumed && requestMatches(candidate, request));
      if (!record) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_probe_authorization_invalid', {
            connectionId: request.connectionId,
            machineId: request.machineId,
          }),
        };
      }
      record.consumed = true;
      const current = await currentRecordState(record);
      if (!current.ok) return current;
      return {
        ok: true,
        ticket: record.ticket,
        observationAuthorizationFingerprint: record.observationAuthorizationFingerprint,
        credentialRef: record.credentialRef,
      };
    },
    revalidate: async (ticket, request) => {
      const record = recordsById.get(ticket.authorization.id);
      if (!record || !record.consumed || !requestMatches(record, request)) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_probe_authorization_invalid', {
            connectionId: request.connectionId,
            machineId: request.machineId,
          }),
        };
      }
      const current = await currentRecordState(record);
      return current.ok ? { ok: true } : current;
    },
    authorizeDestination: async (ticket, request, destination) => {
      const record = recordsById.get(ticket.authorization.id);
      if (!record || !record.consumed || !requestMatches(record, request)) {
        return {
          ok: false,
          error: createProviderErrorV1('provider_probe_authorization_invalid', {
            connectionId: request.connectionId,
            machineId: request.machineId,
          }),
        };
      }
      if (destination.origin !== new URL(record.endpointUrl).origin || destination.scope !== record.endpointScope) {
        return { ok: false, error: error(record.input, 'provider_authorization_changed') };
      }
      const current = await currentRecordState(record, {
        endpointUrl: record.endpointUrl,
        resolvedAddresses: destination.resolvedAddresses,
      });
      return current.ok ? { ok: true } : current;
    },
    resolveCredential: (reference) => resolveRuntimeProviderCredential({
      credentialRef: reference,
      getAccountSettingsSnapshot: input.getAccountSettingsSnapshot,
    }),
  };

  async function prepare(request: DaemonProviderDraftProbeRequestV1) {
    if (!reserveAction(request)) {
      return { ok: false as const, error: error(request, 'provider_probe_authorization_invalid') };
    }
    const snapshot = input.getAccountSettingsSnapshot();
    if (!snapshot) return { ok: false as const, error: error(request, 'provider_probe_authorization_invalid') };
    const facts = await resolveDraftFacts({ request, snapshot, resolveAddresses: input.resolveAddresses });
    if (!facts.ok) return facts;
    const selectedSecret = selectedSecretReference(request, snapshot);
    if (selectedSecret && 'code' in selectedSecret) return { ok: false as const, error: selectedSecret };
    if (request.template.catalog.source !== 'probe') {
      return { ok: true as const, endpoints: [] as ProviderProbeEndpoint[], probes: [] as const };
    }
    const endpoints: ProviderProbeEndpoint[] = facts.record.endpoints.map((endpoint) => ({
      endpointTemplateId: endpoint.endpointTemplateId,
      protocol: endpoint.protocol,
      normalizedUrl: endpoint.normalizedUrl,
      publicHeaders: endpoint.publicHeaders,
      credentialPolicy: request.template.credential === undefined
        ? 'none'
        : request.template.credential.required ? 'required' : 'optional',
    }));
    const expiresAt = now() + authorizationTtlMs;
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
      const authorizationId = createAuthorizationId();
      if (recordsById.has(authorizationId)) {
        return { ok: false as const, error: error(request, 'provider_probe_authorization_invalid') };
      }
      const authorizationValue = ProviderProbeAuthorizationV1Schema.parse({
        v: 1,
        id: authorizationId,
        machineId: request.machineId,
        endpointSetFingerprint: facts.record.endpointSetFingerprint,
        credentialDestinationFingerprint: createProviderCredentialDestinationFingerprintV1(
          selectedTransport?.destination ?? null,
        ),
        probeRequestFingerprint: requestFingerprint,
        selectedSecretBindingId: selectedSecret?.secretId ?? null,
        selectedSecretRecordFingerprint: selectedSecret?.secretRecordFingerprint ?? null,
        use: 'probe',
        expiresAt,
      });
      const ticket = { authorization: authorizationValue, draftConnectionId: request.draftConnectionId };
      recordsById.set(authorizationId, {
        ticket,
        input: request,
        endpointTemplateId: endpoint.endpointTemplateId,
        endpointUrl: endpoint.normalizedUrl,
        endpointScope: endpoint.endpointScope,
        protocol: endpoint.protocol,
        path: probe.path,
        parser: probe.parser,
        publicHeaders: endpoint.publicHeaders,
        credentialRef: selectedSecret && selectedTransport
          ? {
              connectionId: request.draftConnectionId,
              machineId: request.machineId,
              reference: { kind: 'apiKey', ...selectedSecret },
              transport: selectedTransport,
              protocol: endpoint.protocol,
            }
          : null,
        observationAuthorizationFingerprint: createProviderObservationAuthorizationFingerprintV1({
          selectedSecretBindingId: selectedSecret?.secretId ?? null,
          selectedSecretRecordFingerprint: selectedSecret?.secretRecordFingerprint ?? null,
          credential: selectedSecret && selectedTransport
            ? { transport: selectedTransport, selectedProtocol: endpoint.protocol, selectedUse: 'probe' }
            : null,
        }),
        consumed: false,
      });
    }
    return { ok: true as const, endpoints, probes: request.template.catalog.probes };
  }

  return Object.freeze({
    probe: async (raw: unknown): Promise<ProviderCatalogRefreshResult> => {
      const request = DaemonProviderDraftProbeRequestV1Schema.parse(raw);
      if (request.machineId !== input.machineId) {
        return { status: 'error', error: error(request, 'provider_not_enabled_on_machine') };
      }
      if (request.template.catalog.source !== 'probe') return { status: 'not_supported' };
      const prepared = await prepare(request);
      if (!prepared.ok) return { status: 'error', error: prepared.error };
      if (prepared.probes.length === 0) return { status: 'not_supported' };
      await input.beforeAuthorizationConsume?.();
      const service = createProviderCatalogService({
        client: input.client,
        authorization,
        runtimeStore: createEphemeralRuntimeStore(input.machineId),
        now,
        createObservationId: randomUUID,
      });
      return service.refresh({
        connectionId: request.draftConnectionId,
        machineId: request.machineId,
        endpoints: prepared.endpoints,
        probes: prepared.probes,
      });
    },
  });
}
