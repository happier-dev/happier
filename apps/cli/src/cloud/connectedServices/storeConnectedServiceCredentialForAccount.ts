import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  sealConnectedServiceCredentialCiphertext,
  buildConnectedServiceCredentialMetadata,
  type ConnectedServiceCredentialCompatibleMutationResponseV1,
  type ConnectedServiceCredentialMetadata,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceCredentialRevisionV1,
  type SealedConnectedServiceCredentialV1,
} from '@happier-dev/protocol';

import { readHttpStatus } from '@/api/client/httpStatusError';
import { requireEncryptionCredentials, type Credentials } from '@/persistence';

type CredentialBinding = Readonly<{
  serviceId: ConnectedServiceCredentialRecordV1['serviceId'];
  profileId: string;
}>;

type CredentialMetadata = ConnectedServiceCredentialMetadata;

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
  getAccountEncryptionMode: (options?: Readonly<{ refresh?: boolean; signal?: AbortSignal }>) => Promise<'e2ee' | 'plain' | 'unknown'>;
  getConnectedServiceCredentialPlain: (binding: CredentialBinding & Readonly<{ signal?: AbortSignal }>) => Promise<({
    content: { t: 'plain'; v: ConnectedServiceCredentialRecordV1 };
  } & ConnectedServiceCredentialRevisionBoundaryV1) | null>;
  getConnectedServiceCredentialSealed: (binding: CredentialBinding & Readonly<{ signal?: AbortSignal }>) => Promise<({
    sealed: SealedConnectedServiceCredentialV1;
    metadata: {
      kind: 'oauth' | 'token';
      providerEmail?: string | null;
      providerAccountId?: string | null;
      providerOrganizationId?: string | null;
      expiresAt?: number | null;
    };
  } & ConnectedServiceCredentialRevisionBoundaryV1) | null>;
  registerConnectedServiceCredentialPlain: (params: CredentialBinding & Readonly<{
    content: { t: 'plain'; v: ConnectedServiceCredentialRecordV1 };
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  }>) => Promise<ConnectedServiceCredentialCompatibleMutationResponseV1>;
  registerConnectedServiceCredentialSealed: (params: CredentialBinding & Readonly<{
    sealed: SealedConnectedServiceCredentialV1;
    metadata?: CredentialMetadata;
    expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  }>) => Promise<ConnectedServiceCredentialCompatibleMutationResponseV1>;
}>;

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

export class ConnectedServiceCredentialIdentityConflictError extends Error {
  readonly code = 'profile_conflict';
  constructor() { super('The profile belongs to a different or unverified provider account'); this.name = 'ConnectedServiceCredentialIdentityConflictError'; }
}

export class ConnectedServiceCredentialStorageResultUnknownError extends Error {
  readonly code = 'storage_result_unknown';
  constructor() { super('The entered credential write could not be settled'); this.name = 'ConnectedServiceCredentialStorageResultUnknownError'; }
}

function normalizeMetadata(metadata: {
  kind: 'oauth' | 'token';
  providerEmail?: string | null;
  providerAccountId?: string | null;
  providerOrganizationId?: string | null;
  expiresAt?: number | null;
}): CredentialMetadata {
  return {
    kind: metadata.kind,
    providerEmail: metadata.providerEmail ?? null,
    providerAccountId: metadata.providerAccountId ?? null,
    ...(metadata.providerOrganizationId ? { providerOrganizationId: metadata.providerOrganizationId } : {}),
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
  signal?: AbortSignal;
}>) {
  if (params.mode === 'plain') {
    const current = await params.api.getConnectedServiceCredentialPlain({ ...params.binding, ...(params.signal ? { signal: params.signal } : {}) });
    return current;
  }
  const current = await params.api.getConnectedServiceCredentialSealed({ ...params.binding, ...(params.signal ? { signal: params.signal } : {}) });
  return current;
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
      && isDeepStrictEqual(normalizeMetadata({
        ...current.metadata,
        // Released relays accept and strip this additive metadata field. Ciphertext readback
        // still proves the complete intended credential when that relay omits the projection.
        ...(current.metadata.providerOrganizationId === undefined
          ? { providerOrganizationId: params.prepared.metadata.providerOrganizationId }
          : {}),
      }), params.prepared.metadata),
    credentialRevision: current?.credentialRevision ?? null,
  };
}

async function writePreparedCredential(params: Readonly<{
  api: ConnectedServiceCredentialStorageApi;
  prepared: PreparedCredentialWrite;
}>) {
  const { api, prepared } = params;
  if (prepared.mode === 'plain') {
    return await api.registerConnectedServiceCredentialPlain({
      ...prepared.binding,
      content: { t: 'plain', v: prepared.record },
      ...(prepared.revisionSemantics === 'revisioned'
        ? { expectedCredentialRevision: prepared.expectedCredentialRevision }
        : {}),
    });
  }

  return await api.registerConnectedServiceCredentialSealed({
    ...prepared.binding,
    sealed: prepared.sealed,
    metadata: prepared.metadata,
    ...(prepared.revisionSemantics === 'revisioned'
      ? { expectedCredentialRevision: prepared.expectedCredentialRevision }
      : {}),
  });
}

export async function storeConnectedServiceCredentialForAccount(params: Readonly<{
  api: ConnectedServiceCredentialStorageApi;
  credentials: Credentials;
  record: ConnectedServiceCredentialRecordV1;
  identityPolicy?: 'same_account_or_empty';
  signal?: AbortSignal;
  randomBytes?: (length: number) => Uint8Array;
}>): Promise<ConnectedServiceCredentialRevisionBoundaryV1> {
  const binding = { serviceId: params.record.serviceId, profileId: params.record.profileId };
  params.signal?.throwIfAborted();
  const mode = await params.api.getAccountEncryptionMode({ refresh: true, ...(params.signal ? { signal: params.signal } : {}) });
  if (mode !== 'e2ee' && mode !== 'plain') {
    throw new Error('Cannot store connected service credential while account encryption mode is unknown');
  }

  params.signal?.throwIfAborted();
  const currentRevision = await readCurrentRevision({ api: params.api, mode, binding, signal: params.signal });
  params.signal?.throwIfAborted();
  if (params.identityPolicy === 'same_account_or_empty' && currentRevision !== null) {
    const existing = 'content' in currentRevision ? buildConnectedServiceCredentialMetadata(currentRevision.content.v) : normalizeMetadata(currentRevision.metadata);
    const incoming = buildConnectedServiceCredentialMetadata(params.record);
    const sameAccount = existing.kind === incoming.kind && (
      existing.providerAccountId && incoming.providerAccountId
        ? existing.providerAccountId === incoming.providerAccountId
        : !existing.providerAccountId && !incoming.providerAccountId && existing.providerEmail && incoming.providerEmail
          ? existing.providerEmail === incoming.providerEmail
          : false
    );
    if (!sameAccount) throw new ConnectedServiceCredentialIdentityConflictError();
    // Unfenced servers cannot protect identity between the check and write.
    if (currentRevision.revisionSemantics !== 'revisioned') throw new ConnectedServiceCredentialIdentityConflictError();
  }
  const expectedCredentialRevision = currentRevision?.credentialRevision ?? null;
  const revisionSemantics = currentRevision?.revisionSemantics ?? 'revisioned';
  const prepared: PreparedCredentialWrite = mode === 'plain'
    ? { mode, binding, expectedCredentialRevision, revisionSemantics, record: params.record }
    : (() => {
      requireEncryptionCredentials(params.credentials);
      return {
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
        metadata: buildConnectedServiceCredentialMetadata(params.record),
      };
    })();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0 && params.signal?.aborted) throw new ConnectedServiceCredentialStorageResultUnknownError();
    params.signal?.throwIfAborted();
    try {
      const result = await writePreparedCredential({ api: params.api, prepared });
      if ('error' in result) {
        throw new ConnectedServiceCredentialStorageSupersededError(result);
      }
      return 'credentialRevision' in result
        ? { revisionSemantics: 'revisioned', credentialRevision: result.credentialRevision }
        : { revisionSemantics: 'legacy_unfenced', credentialRevision: null };
    } catch (error) {
      if (error instanceof ConnectedServiceCredentialStorageSupersededError || !isAmbiguousWriteError(error)) {
        throw error;
      }

      let settlement: Awaited<ReturnType<typeof didStorePreparedCredential>>;
      try {
        settlement = await didStorePreparedCredential({ api: params.api, prepared });
      } catch {
        if (params.signal?.aborted || params.identityPolicy === 'same_account_or_empty') throw new ConnectedServiceCredentialStorageResultUnknownError();
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
      if (attempt === 1) {
        if (params.signal?.aborted || params.identityPolicy === 'same_account_or_empty') throw new ConnectedServiceCredentialStorageResultUnknownError();
        throw error;
      }
    }
  }

  throw new Error('Connected service credential storage did not settle');
}
