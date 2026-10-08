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
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

export {
  ConnectedServiceCredentialBindingMismatchError,
  assertConnectedServiceCredentialRecordBinding,
} from '@happier-dev/protocol';

import type { ConnectedServiceCredentialApi } from '@/api/connectedServices/connectedServiceCredentialApi';
import type { Credentials } from '@/persistence';
import { resolveConnectedServiceAccountMode } from './resolveConnectedServiceAccountMode';

export class ConnectedServiceCredentialResolutionError extends Error {
  readonly name = 'ConnectedServiceCredentialResolutionError';
  readonly kind = 'missing_credential' as const;
  readonly serviceId: ConnectedServiceId;
  readonly profileId: string;

  constructor(binding: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) {
    super(`Missing connected service credential (${binding.serviceId}/${binding.profileId})`);
    this.serviceId = binding.serviceId;
    this.profileId = binding.profileId;
  }
}

export function parseConnectedServiceCredentialRecord(params: Readonly<{
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
  api: ConnectedServiceCredentialApi;
  binding: { serviceId: ConnectedServiceId; profileId: string };
}>): Promise<ResolvedConnectedServiceCredential | null> {
  if (typeof params.api.getConnectedServiceCredentialPlain !== 'function') return null;
  const plain = await params.api.getConnectedServiceCredentialPlain({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
  });
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
  api: ConnectedServiceCredentialApi;
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
  api: ConnectedServiceCredentialApi;
  credentials: Credentials;
  binding: { serviceId: ConnectedServiceId; profileId: string };
}>): Promise<ResolvedConnectedServiceCredential | null> {
  const sealed = await params.api.getConnectedServiceCredentialSealed({
    serviceId: params.binding.serviceId,
    profileId: params.binding.profileId,
  });
  if (!sealed) return null;

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
  api: ConnectedServiceCredentialApi;
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
        throw new ConnectedServiceCredentialResolutionError(binding);
      }
    }

    const sealed = await readSealedConnectedServiceCredential({
      api: params.api,
      credentials: params.credentials,
      binding,
    });
    if (!sealed) {
      throw new ConnectedServiceCredentialResolutionError(binding);
    }
    out.set(binding.serviceId, sealed);
  }

  return out;
}

export async function resolveConnectedServiceCredentials(params: Readonly<{
  credentials: Credentials;
  api: ConnectedServiceCredentialApi;
  bindings: ReadonlyArray<{ serviceId: ConnectedServiceId; profileId: string }>;
}>): Promise<Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>> {
  const resolved = await resolveConnectedServiceCredentialsWithRevisions(params);
  return new Map(Array.from(resolved, ([serviceId, value]) => [serviceId, value.record]));
}
