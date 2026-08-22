import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  projectBuiltInLegacyConnectedServiceCredentialRecordV1,
  sealConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialCompatibleMutationResponseV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceCredentialRevisionBoundaryV1,
  type ConnectedServiceCredentialRevisionV1,
  type SealedConnectedServiceCredentialV1,
} from '@happier-dev/protocol';

import { readHttpStatus } from '@/api/client/httpStatusError';
import {
  resolveQualifiedConnectedAccountPeerClass,
} from '@/api/client/qualifiedConnectedAccountApi';
import type {
  SessionSyncPendingInputServerContractResult,
} from '@/api/clientCompatibility/sessionSyncPendingInputServerContract';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';

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
  getServerFeaturesSnapshot: (
    options?: Readonly<{ refresh?: boolean }>,
  ) => Promise<CliServerFeaturesSnapshot | undefined>;
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

export class ConnectedServiceCredentialLegacyUnfencedMutationUnsupportedError
  extends Error {
  readonly code = 'connected_service_credential_legacy_unfenced_mutation_unsupported' as const;

  constructor() {
    super(
      'Connected service credential mutation requires a revisioned server contract',
    );
    this.name =
      'ConnectedServiceCredentialLegacyUnfencedMutationUnsupportedError';
  }
}

export class ConnectedServiceCredentialRevisionRequiredError extends Error {
  readonly code = 'connected_service_credential_revision_required' as const;

  constructor() {
    super(
      'Connected service credential mutation did not return a committed revision',
    );
    this.name = 'ConnectedServiceCredentialRevisionRequiredError';
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
}>): Promise<ConnectedServiceCredentialRevisionBoundaryV1 | null> {
  if (params.mode === 'plain') {
    return await params.api.getConnectedServiceCredentialPlain(params.binding);
  }
  return await params.api.getConnectedServiceCredentialSealed(params.binding);
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
}>): Promise<ConnectedServiceCredentialCompatibleMutationResponseV1> {
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
  credentials: StoredCredentials;
  record: ConnectedServiceCredentialRecordV1;
  serverContract?: SessionSyncPendingInputServerContractResult | null;
  randomBytes?: (length: number) => Uint8Array;
}>): Promise<ConnectedServiceCredentialRevisionBoundaryV1> {
  const record =
    projectBuiltInLegacyConnectedServiceCredentialRecordV1(params.record);
  const binding = { serviceId: record.serviceId, profileId: record.profileId };
  const mode = await params.api.getAccountEncryptionMode({ refresh: true });
  if (mode !== 'e2ee' && mode !== 'plain') {
    throw new Error('Cannot store connected service credential while account encryption mode is unknown');
  }

  const currentRevision = await readCurrentRevision({ api: params.api, mode, binding });
  const expectedCredentialRevision = currentRevision?.credentialRevision ?? null;
  let revisionSemantics = currentRevision?.revisionSemantics;
  if (revisionSemantics === 'legacy_unfenced') {
    throw new ConnectedServiceCredentialLegacyUnfencedMutationUnsupportedError();
  }
  if (!revisionSemantics) {
    let serverFeaturesSnapshot: CliServerFeaturesSnapshot | undefined;
    try {
      serverFeaturesSnapshot = await params.api.getServerFeaturesSnapshot({ refresh: true });
    } catch {
      serverFeaturesSnapshot = undefined;
    }
    const peerClass = resolveQualifiedConnectedAccountPeerClass(
      serverFeaturesSnapshot,
      params.serverContract,
    );
    if (peerClass === 'indeterminate') {
      throw new Error('Cannot store missing plaintext credential while server credential mutation contract is indeterminate');
    }
    if (peerClass === 'exact_v0_2_1') {
      throw new ConnectedServiceCredentialLegacyUnfencedMutationUnsupportedError();
    }
    revisionSemantics = 'revisioned';
  }
  revisionSemantics ??= 'revisioned';
  const prepared: PreparedCredentialWrite = mode === 'plain'
    ? { mode, binding, expectedCredentialRevision, revisionSemantics, record }
    : (() => {
        const credentials =
          requireAccountEncryptionCredentials(params.credentials);
        return {
          mode,
          binding,
          expectedCredentialRevision,
          revisionSemantics,
          record,
          sealed: {
            format: 'account_scoped_v1',
            ciphertext: sealConnectedServiceCredentialCiphertext({
              material: credentials.encryption.type === 'legacy'
                ? { type: 'legacy', secret: credentials.encryption.secret }
                : {
                    type: 'dataKey',
                    machineKey: credentials.encryption.machineKey,
                  },
              payload: record,
              randomBytes:
                params.randomBytes ?? ((length) => randomBytes(length)),
            }),
          },
          metadata: metadataForRecord(record),
        };
      })();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await writePreparedCredential({ api: params.api, prepared });
      if ('error' in result) throw new ConnectedServiceCredentialStorageSupersededError(result);
      if (!('credentialRevision' in result)) {
        throw new ConnectedServiceCredentialRevisionRequiredError();
      }
      return {
        revisionSemantics: 'revisioned',
        credentialRevision: result.credentialRevision,
      };
    } catch (error) {
      if (
        error instanceof ConnectedServiceCredentialStorageSupersededError
        || error instanceof ConnectedServiceCredentialRevisionRequiredError
        || !isAmbiguousWriteError(error)
      ) {
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
        throw new ConnectedServiceCredentialRevisionRequiredError();
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
