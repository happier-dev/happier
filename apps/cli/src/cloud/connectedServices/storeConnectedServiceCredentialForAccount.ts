import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  sealConnectedServiceCredentialCiphertext,
  openConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialCompatibleMutationResponseV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceCredentialRevisionV1,
  type SealedConnectedServiceCredentialV1,
} from '@happier-dev/protocol';

import { parseConnectedServiceCredentialRecord } from './resolveConnectedServiceCredentials';
import { readHttpStatus } from '@/api/client/httpStatusError';
import type { Credentials } from '@/persistence';

type CredentialBinding = Readonly<{
  serviceId: ConnectedServiceCredentialRecordV1['serviceId'];
  profileId: string;
}>;

type CredentialMetadata = Readonly<{
  kind: 'oauth' | 'token';
  providerEmail: string | null;
  providerAccountId: string | null;
  expiresAt: number | null;
}>;

type PreparedCredentialWrite =
  | Readonly<{
      mode: 'plain';
      binding: CredentialBinding;
      expectedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null;
      revisionSemantics: ConnectedServiceCredentialRevisionBoundaryV1['revisionSemantics'];
      record: ConnectedServiceCredentialRecordV1;
    }>
  | Readonly<{
      mode: 'e2ee';
      binding: CredentialBinding;
      expectedCredentialRevision: ConnectedServiceCredentialRevisionV1 | null;
      revisionSemantics: ConnectedServiceCredentialRevisionBoundaryV1['revisionSemantics'];
      record: ConnectedServiceCredentialRecordV1;
      sealed: SealedConnectedServiceCredentialV1;
      metadata: CredentialMetadata;
    }>;

export type ConnectedServiceCredentialStorageApi = Readonly<{
  getAccountEncryptionMode: (options?: Readonly<{ refresh?: boolean }>) => Promise<'e2ee' | 'plain' | 'unknown'>;
  getConnectedServiceCredentialPlain: (binding: CredentialBinding) => Promise<({
    content: { t: 'plain'; v: ConnectedServiceCredentialRecordV1 };
  } & ConnectedServiceCredentialRevisionBoundaryV1) | null>;
  getConnectedServiceCredentialSealed: (binding: CredentialBinding) => Promise<({
    sealed: SealedConnectedServiceCredentialV1;
    metadata: {
      kind: 'oauth' | 'token';
      providerEmail?: string | null;
      providerAccountId?: string | null;
      expiresAt?: number | null;
    };
  } & ConnectedServiceCredentialRevisionBoundaryV1) | null>;
  registerConnectedServiceCredentialPlain: (params: CredentialBinding & Readonly<{
    content: { t: 'plain'; v: ConnectedServiceCredentialRecordV1 };
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    signal?: AbortSignal;
  }>) => Promise<ConnectedServiceCredentialCompatibleMutationResponseV1>;
  registerConnectedServiceCredentialSealed: (params: CredentialBinding & Readonly<{
    sealed: SealedConnectedServiceCredentialV1;
    metadata?: CredentialMetadata;
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    signal?: AbortSignal;
  }>) => Promise<ConnectedServiceCredentialCompatibleMutationResponseV1>;
}>;

export class ConnectedServiceCredentialStorageResultUnknownError extends Error {
  constructor() { super('Connected service credential storage result is unknown; check the profile before retrying'); this.name = 'ConnectedServiceCredentialStorageResultUnknownError'; }
}

export class ConnectedServiceCredentialIdentityMismatchError extends Error {
  constructor() { super('Connected service profile identity does not match the existing account; use a new profile'); this.name = 'ConnectedServiceCredentialIdentityMismatchError'; }
}

export class ConnectedServiceCredentialStorageSupersededError extends Error {
  readonly reason: 'revision_mismatch' | 'refresh_lease_lost';
  readonly credentialRevision: ConnectedServiceCredentialRevisionV1 | null;

  constructor(params: Readonly<{
    reason: 'revision_mismatch' | 'refresh_lease_lost';
    credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
  }>) {
    super('Connected service credential storage was superseded by a newer mutation');
    this.name = 'ConnectedServiceCredentialStorageSupersededError';
    this.reason = params.reason;
    this.credentialRevision = params.credentialRevision;
  }
}

function metadataForRecord(record: ConnectedServiceCredentialRecordV1): CredentialMetadata {
  return {
    kind: record.kind,
    providerEmail: record.kind === 'oauth' ? record.oauth.providerEmail ?? null : record.token.providerEmail ?? null,
    providerAccountId: record.kind === 'oauth' ? record.oauth.providerAccountId ?? null : record.token.providerAccountId ?? null,
    expiresAt: record.expiresAt,
  };
}

function normalizeMetadata(metadata: {
  kind: 'oauth' | 'token';
  providerEmail?: string | null;
  providerAccountId?: string | null;
  expiresAt?: number | null;
}): CredentialMetadata {
  return {
    kind: metadata.kind,
    providerEmail: metadata.providerEmail ?? null,
    providerAccountId: metadata.providerAccountId ?? null,
    expiresAt: metadata.expiresAt ?? null,
  };
}

function isAmbiguousWriteError(error: unknown): boolean {
  const status = readHttpStatus(error);
  return status === null || status === 408 || status === 429 || status >= 500;
}

async function readCurrentRevision(params: Readonly<{
  api: ConnectedServiceCredentialStorageApi;
  mode: 'e2ee' | 'plain';
  binding: CredentialBinding;
  credentials?: Credentials;
}>): Promise<(ConnectedServiceCredentialRevisionBoundaryV1 & { providerAccountId: string | null }) | null> {
  if (params.mode === 'plain') {
    const current = await params.api.getConnectedServiceCredentialPlain(params.binding);
    return current ? { ...current, providerAccountId: metadataForRecord(current.content.v).providerAccountId } : null;
  }
  const current = await params.api.getConnectedServiceCredentialSealed(params.binding);
  if (!current) return null;
  if (params.credentials) {
    let providerAccountId: string | null;
    try {
      const opened = openConnectedServiceCredentialCiphertext({
        material: params.credentials.encryption.type === 'legacy' ? { type: 'legacy', secret: params.credentials.encryption.secret } : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
        ciphertext: current.sealed.ciphertext,
      });
      if (!opened) throw new ConnectedServiceCredentialIdentityMismatchError();
      const record = parseConnectedServiceCredentialRecord({ binding: params.binding, value: opened.value });
      providerAccountId = metadataForRecord(record).providerAccountId;
    } catch { throw new ConnectedServiceCredentialIdentityMismatchError(); }
    return { ...current, providerAccountId };
  }
  return { ...current, providerAccountId: current.metadata.providerAccountId ?? null };
}

async function didStorePreparedCredential(params: Readonly<{
  api: ConnectedServiceCredentialStorageApi;
  prepared: PreparedCredentialWrite;
}>): Promise<{ stored: boolean; credentialRevision: ConnectedServiceCredentialRevisionV1 | null }> {
  if (params.prepared.mode === 'plain') {
    const current = await params.api.getConnectedServiceCredentialPlain(params.prepared.binding);
    return {
      stored: current !== null && isDeepStrictEqual(current.content.v, params.prepared.record),
      credentialRevision: current?.credentialRevision ?? null,
    };
  }

  const current = await params.api.getConnectedServiceCredentialSealed(params.prepared.binding);
  return {
    stored: current !== null
      && isDeepStrictEqual(current.sealed, params.prepared.sealed)
      && isDeepStrictEqual(normalizeMetadata(current.metadata), params.prepared.metadata),
    credentialRevision: current?.credentialRevision ?? null,
  };
}

async function writePreparedCredential(params: Readonly<{
  api: ConnectedServiceCredentialStorageApi;
  prepared: PreparedCredentialWrite;
  signal?: AbortSignal;
}>) {
  const { api, prepared } = params;
  if (prepared.mode === 'plain') {
    return await api.registerConnectedServiceCredentialPlain({
      ...prepared.binding,
      content: { t: 'plain', v: prepared.record },
      ...(params.signal ? { signal: params.signal } : {}),
      ...(prepared.revisionSemantics === 'revisioned'
        ? { expectedCredentialRevision: prepared.expectedCredentialRevision }
        : {}),
    });
  }

  return await api.registerConnectedServiceCredentialSealed({
    ...prepared.binding,
    sealed: prepared.sealed,
    metadata: prepared.metadata,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(prepared.revisionSemantics === 'revisioned'
      ? { expectedCredentialRevision: prepared.expectedCredentialRevision }
      : {}),
  });
}

export async function storeConnectedServiceCredentialForAccount(params: Readonly<{
  api: ConnectedServiceCredentialStorageApi;
  credentials: Credentials;
  record: ConnectedServiceCredentialRecordV1;
  signal?: AbortSignal;
  requireSameProviderAccount?: boolean;
  randomBytes?: (length: number) => Uint8Array;
}>): Promise<ConnectedServiceCredentialRevisionBoundaryV1> {
  params.signal?.throwIfAborted();
  const binding = { serviceId: params.record.serviceId, profileId: params.record.profileId };
  const mode = await params.api.getAccountEncryptionMode({ refresh: true });
  if (mode !== 'e2ee' && mode !== 'plain') {
    throw new Error('Cannot store connected service credential while account encryption mode is unknown');
  }

  const currentRevision = await readCurrentRevision({ api: params.api, mode, binding, ...(params.requireSameProviderAccount ? { credentials: params.credentials } : {}) });
  if (params.requireSameProviderAccount && currentRevision && currentRevision.providerAccountId !== metadataForRecord(params.record).providerAccountId) throw new ConnectedServiceCredentialIdentityMismatchError();
  params.signal?.throwIfAborted();
  const expectedCredentialRevision = currentRevision?.credentialRevision ?? null;
  const revisionSemantics = currentRevision?.revisionSemantics ?? 'revisioned';
  const prepared: PreparedCredentialWrite = mode === 'plain'
    ? { mode, binding, expectedCredentialRevision, revisionSemantics, record: params.record }
    : {
        mode,
        binding,
        expectedCredentialRevision,
        revisionSemantics,
        record: params.record,
        sealed: {
          format: 'account_scoped_v1',
          ciphertext: sealConnectedServiceCredentialCiphertext({
            material: params.credentials.encryption.type === 'legacy'
              ? { type: 'legacy', secret: params.credentials.encryption.secret }
              : { type: 'dataKey', machineKey: params.credentials.encryption.machineKey },
            payload: params.record,
            randomBytes: params.randomBytes ?? ((length) => randomBytes(length)),
          }),
        },
        metadata: metadataForRecord(params.record),
      };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let writeIssued = false;
    try {
      params.signal?.throwIfAborted();
      writeIssued = true;
      const result = await writePreparedCredential({ api: params.api, prepared, signal: params.signal });
      if ('error' in result) {
        throw new ConnectedServiceCredentialStorageSupersededError(result);
      }
      return 'credentialRevision' in result
        ? { revisionSemantics: 'revisioned', credentialRevision: result.credentialRevision }
        : { revisionSemantics: 'legacy_unfenced', credentialRevision: null };
    } catch (error) {
      if (params.signal?.aborted) {
        if (writeIssued) throw new ConnectedServiceCredentialStorageResultUnknownError();
        throw error;
      }
      if (error instanceof ConnectedServiceCredentialStorageSupersededError || !isAmbiguousWriteError(error)) {
        throw error;
      }

      let settlement: Awaited<ReturnType<typeof didStorePreparedCredential>>;
      try {
        settlement = await didStorePreparedCredential({ api: params.api, prepared });
      } catch {
        throw error;
      }
      if (settlement.stored && settlement.credentialRevision) {
        return { revisionSemantics: 'revisioned', credentialRevision: settlement.credentialRevision };
      }
      if (settlement.stored) {
        return { revisionSemantics: 'legacy_unfenced', credentialRevision: null };
      }
      if (settlement.credentialRevision !== prepared.expectedCredentialRevision) {
        throw new ConnectedServiceCredentialStorageSupersededError({
          reason: 'revision_mismatch',
          credentialRevision: settlement.credentialRevision,
        });
      }
      if (attempt === 1) throw error;
    }
  }

  throw new Error('Connected service credential storage did not settle');
}
