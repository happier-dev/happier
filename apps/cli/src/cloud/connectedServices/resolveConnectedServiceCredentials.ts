/**
 * Connected service credential resolver (client-side)
 *
 * Fetches sealed ciphertext from Happier Cloud and decrypts it locally using account-scoped crypto
 * material. The server never decrypts these payloads.
 */

import {
  ConnectedServiceCredentialBindingMismatchError,
  ConnectedServiceCredentialRecordV1Schema,
  assertConnectedServiceCredentialRecordBinding,
  openConnectedServiceCredentialCiphertext,
  isConnectedServiceCredentialHealthStatusUsable,
  normalizeConnectedServiceCredentialHealthStatus,
  type ConnectedServiceCredentialHealthStatusV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

export {
  ConnectedServiceCredentialBindingMismatchError,
  assertConnectedServiceCredentialRecordBinding,
} from '@happier-dev/protocol';

import { ConnectedServiceCredentialUnsupportedFormatError, type ConnectedServiceCredentialApi } from '@/api/connectedServices/connectedServiceCredentialApi';
import { requireEncryptionCredentials, type Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { resolveConnectedServiceAccountMode } from './resolveConnectedServiceAccountMode';

type ProfileHealthApi = Readonly<{
  listConnectedServiceProfiles?(input: Readonly<{ serviceId: ConnectedServiceId; forceRefresh: true }>): Promise<Readonly<{
    serviceId: ConnectedServiceId;
    profiles: readonly Readonly<{ profileId: string; status: ConnectedServiceCredentialHealthStatusV1 }>[];
  }>>;
}>;
type CredentialApi = ConnectedServiceCredentialApi & ProfileHealthApi;
type CredentialBinding = Readonly<{ serviceId: ConnectedServiceId; profileId: string }>;
export type ConnectedServiceProfileHealth =
  | Readonly<{ kind: 'usable'; status: ConnectedServiceCredentialHealthStatusV1 }>
  | Readonly<{ kind: 'present_but_unusable'; status: ConnectedServiceCredentialHealthStatusV1 }>
  | Readonly<{ kind: 'confirmed_missing' }>
  | Readonly<{ kind: 'unknown' }>;

export function classifyPresentConnectedServiceProfileHealth(
  projectedStatus: ConnectedServiceCredentialHealthStatusV1,
): ConnectedServiceProfileHealth {
  const status = normalizeConnectedServiceCredentialHealthStatus(projectedStatus);
  return { kind: isConnectedServiceCredentialHealthStatusUsable(status) ? 'usable' : 'present_but_unusable', status };
}

export async function readConnectedServiceProfileHealths(input: Readonly<{
  api: ProfileHealthApi;
  serviceId: ConnectedServiceId;
  profileIds: readonly string[];
}>): Promise<ReadonlyMap<string, ConnectedServiceProfileHealth>> {
  if (input.profileIds.length === 0) return new Map();
  const profiles = await input.api.listConnectedServiceProfiles?.({
    serviceId: input.serviceId, forceRefresh: true,
  }).catch((error: unknown) => {
    logger.warn('[CONNECTED SERVICES] Could not read current profile health', {
      serviceId: input.serviceId,
      error: serializeAxiosErrorForLog(error),
    });
    return null;
  });
  const current = profiles?.serviceId === input.serviceId
    ? new Map(profiles.profiles.map(profile => [profile.profileId, profile.status]))
    : null;
  return new Map(input.profileIds.map((profileId): [string, ConnectedServiceProfileHealth] => {
    if (!current) return [profileId, { kind: 'unknown' }];
    const status = current.get(profileId);
    return [profileId, status === undefined ? { kind: 'confirmed_missing' } : classifyPresentConnectedServiceProfileHealth(status)];
  }));
}

export class ConnectedServiceCredentialResolutionError extends Error {
  readonly name = 'ConnectedServiceCredentialResolutionError';
  readonly serviceId: ConnectedServiceId;
  readonly profileId: string;

  constructor(binding: CredentialBinding, readonly kind: 'confirmed_missing' | 'present_but_unusable' | 'unknown') {
    super(`Connected service credential resolution ${kind} (${binding.serviceId}/${binding.profileId})`);
    this.serviceId = binding.serviceId;
    this.profileId = binding.profileId;
  }
}

function throwCredentialReadError(binding: CredentialBinding, error: unknown): never {
  if (error instanceof ConnectedServiceCredentialBindingMismatchError) throw error;
  throw new ConnectedServiceCredentialResolutionError(
    binding,
    error instanceof ConnectedServiceCredentialUnsupportedFormatError ? 'present_but_unusable' : 'unknown',
  );
}

async function resolveAbsentCredential(api: ProfileHealthApi, binding: CredentialBinding): Promise<ConnectedServiceCredentialResolutionError> {
  const health = (await readConnectedServiceProfileHealths({
    api, serviceId: binding.serviceId, profileIds: [binding.profileId],
  })).get(binding.profileId);
  return new ConnectedServiceCredentialResolutionError(binding,
    !health || health.kind === 'unknown' ? 'unknown'
      : health.kind === 'confirmed_missing' ? 'confirmed_missing'
        : 'present_but_unusable');
}

function parseConnectedServiceCredentialRecord(params: Readonly<{
  binding: { serviceId: ConnectedServiceId; profileId: string };
  value: unknown;
}>): ConnectedServiceCredentialRecordV1 {
  const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(params.value);
  if (!parsed.success) {
    throw new Error(`Invalid connected service credential payload (${params.binding.serviceId}/${params.binding.profileId})`);
  }
  return assertConnectedServiceCredentialRecordBinding({
    binding: params.binding,
    record: parsed.data,
  });
}

export type ResolvedConnectedServiceCredential = Readonly<{
  record: ConnectedServiceCredentialRecordV1;
}> & ConnectedServiceCredentialRevisionBoundaryV1;

async function readPlainConnectedServiceCredential(params: Readonly<{
  api: CredentialApi;
  binding: { serviceId: ConnectedServiceId; profileId: string };
}>): Promise<ResolvedConnectedServiceCredential | null> {
  if (typeof params.api.getConnectedServiceCredentialPlain !== 'function') return null;
  const plain = await params.api.getConnectedServiceCredentialPlain({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
  }).catch((error: unknown) => throwCredentialReadError(params.binding, error));
  if (!plain) return null;
  const record = parseConnectedServiceCredentialRecord({
    binding: params.binding,
    value: plain.content.v,
  });
  return plain.revisionSemantics === 'revisioned'
    ? {
        record,
        revisionSemantics: 'revisioned',
        credentialRevision: plain.credentialRevision,
      }
    : {
        record,
        revisionSemantics: 'legacy_unfenced',
        credentialRevision: null,
      };
}

async function readPlainConnectedServiceCredentialBestEffort(params: Readonly<{
  api: CredentialApi;
  binding: { serviceId: ConnectedServiceId; profileId: string };
}>): Promise<ResolvedConnectedServiceCredential | null> {
  try {
    return await readPlainConnectedServiceCredential(params);
  } catch (error) {
    if (error instanceof ConnectedServiceCredentialBindingMismatchError) throw error;
    return null;
  }
}

async function readSealedConnectedServiceCredential(params: Readonly<{
  api: CredentialApi;
  credentials: Credentials;
  binding: { serviceId: ConnectedServiceId; profileId: string };
}>): Promise<ResolvedConnectedServiceCredential | null> {
  const sealed = await params.api.getConnectedServiceCredentialSealed({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
  }).catch((error: unknown) => throwCredentialReadError(params.binding, error));
  if (!sealed) return null;

  requireEncryptionCredentials(params.credentials);
  const opened = openConnectedServiceCredentialCiphertext({
    material:
      params.credentials.encryption.type === 'legacy'
        ? { type: 'legacy', secret: params.credentials.encryption.secret }
        : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
    ciphertext: sealed.sealed.ciphertext,
  });
  if (!opened || !opened.value) {
    throw new Error(`Failed to decrypt connected service credential (${params.binding.serviceId}/${params.binding.profileId})`);
  }

  const record = parseConnectedServiceCredentialRecord({
    binding: params.binding,
    value: opened.value,
  });
  return sealed.revisionSemantics === 'revisioned'
    ? {
        record,
        revisionSemantics: 'revisioned',
        credentialRevision: sealed.credentialRevision,
      }
    : {
        record,
        revisionSemantics: 'legacy_unfenced',
        credentialRevision: null,
      };
}

export async function resolveConnectedServiceCredentialsWithRevisions(params: Readonly<{
  credentials: Credentials;
  api: CredentialApi;
  bindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
}>): Promise<Map<ConnectedServiceId, ResolvedConnectedServiceCredential>> {
  const out = new Map<ConnectedServiceId, ResolvedConnectedServiceCredential>();
  const accountMode = await resolveConnectedServiceAccountMode(params.api);

  for (const binding of params.bindings) {
    if (accountMode !== 'e2ee') {
      const plain = accountMode === 'unknown'
        ? await readPlainConnectedServiceCredentialBestEffort({
            api: params.api,
            binding,
          })
        : await readPlainConnectedServiceCredential({
            api: params.api,
            binding,
          });
      if (plain) {
        out.set(binding.serviceId, plain);
        continue;
      }
      if (accountMode === 'plain') {
        throw await resolveAbsentCredential(params.api, binding);
      }
    }

    const sealed = await readSealedConnectedServiceCredential({
      api: params.api,
      credentials: params.credentials,
      binding,
    });
    if (!sealed) {
      throw await resolveAbsentCredential(params.api, binding);
    }
    out.set(binding.serviceId, sealed);
  }

  return out;
}

export async function resolveConnectedServiceCredentials(params: Readonly<{
  credentials: Credentials;
  api: CredentialApi;
  bindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
}>): Promise<Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>> {
  const resolved = await resolveConnectedServiceCredentialsWithRevisions(params);
  return new Map(Array.from(resolved, ([serviceId, value]) => [serviceId, value.record]));
}
