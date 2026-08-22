import { randomBytes as nodeRandomBytes } from 'node:crypto';

import {
  SESSION_METADATA_LAYOUT_VERSION_V1,
  createPlainSessionOwnerMetadataEnvelopeV1,
  createSessionOwnerMetadataV1,
  projectSessionSharedMetadataV1,
  sealSessionOwnerMetadataEnvelopeV1,
  type AccountScopedCryptoMaterial,
  type SessionOwnerMetadataEnvelopeV1,
  type SessionOwnerMetadataV1,
} from '@happier-dev/protocol';

import { encodeBase64, encrypt } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';

export class SessionMetadataPrivacyUpgradeRequiredError extends Error {
  readonly code = 'metadata_privacy_upgrade_required' as const;
  readonly unsupportedFields: readonly string[];

  constructor(unsupportedFields: readonly string[]) {
    super('Session metadata requires a privacy-compatible client');
    this.name = 'SessionMetadataPrivacyUpgradeRequiredError';
    this.unsupportedFields = unsupportedFields;
  }
}

type SessionMetadataEnvelopeBuildBaseParams = Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: 'plain' | 'e2ee';
  metadata: unknown;
  agentState: unknown | null;
}>;

type SessionMetadataEnvelopeBuildParams =
  | SessionMetadataEnvelopeBuildBaseParams & Readonly<{
      storedContentMode: 'plain';
    }>
  | SessionMetadataEnvelopeBuildBaseParams & Readonly<{
      storedContentMode: 'e2ee';
      encryptionKey: Uint8Array;
      encryptionVariant: 'legacy' | 'dataKey';
    }>;

type SessionMetadataEnvelopeFields = Readonly<{
  metadataLayoutVersion: typeof SESSION_METADATA_LAYOUT_VERSION_V1;
  sharedMetadata: Readonly<{ ciphertext: string }>;
  ownerMetadata: SessionOwnerMetadataEnvelopeV1;
  agentState: string | null;
}>;

export type SessionMetadataEnvelopeTupleFields = SessionMetadataEnvelopeFields & Readonly<{
  ownerMetadataValue: SessionOwnerMetadataV1;
}>;

function resolveAccountEncryptionMaterial(
  credentials: StoredCredentials,
): AccountScopedCryptoMaterial {
  if (!credentials.encryption) {
    throw new SessionMetadataPrivacyUpgradeRequiredError([
      'accountEncryptionMaterial',
    ]);
  }
  return credentials.encryption.type === 'legacy'
    ? {
        type: 'legacy',
        secret: credentials.encryption.secret,
      }
    : {
        type: 'dataKey',
        machineKey: credentials.encryption.machineKey,
      };
}

export function buildSessionMetadataEnvelopeFields(
  params: SessionMetadataEnvelopeBuildParams,
): SessionMetadataEnvelopeTupleFields {
  const sharedMetadata = projectSessionSharedMetadataV1({
    metadata: params.metadata,
    agentState: params.agentState,
  });
  const ownerMetadata = createSessionOwnerMetadataV1({
    metadata: params.metadata,
  });
  if (!ownerMetadata.ok) {
    throw new SessionMetadataPrivacyUpgradeRequiredError(
      ownerMetadata.unsupportedFields,
    );
  }
  const sharedMetadataCiphertext = params.storedContentMode === 'plain'
    ? JSON.stringify(sharedMetadata)
    : encodeBase64(encrypt(
        params.encryptionKey,
        params.encryptionVariant,
        sharedMetadata,
      ));
  const agentStateCiphertext = params.agentState === null
    ? null
    : params.storedContentMode === 'plain'
      ? JSON.stringify(params.agentState)
      : encodeBase64(encrypt(
          params.encryptionKey,
          params.encryptionVariant,
          params.agentState,
        ));

  return {
    metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
    sharedMetadata: { ciphertext: sharedMetadataCiphertext },
    ownerMetadata: params.accountEncryptionMode === 'plain'
      ? createPlainSessionOwnerMetadataEnvelopeV1(
          ownerMetadata.ownerMetadata,
        )
      : sealSessionOwnerMetadataEnvelopeV1({
          material: resolveAccountEncryptionMaterial(
            params.credentials,
          ),
          ownerMetadata: ownerMetadata.ownerMetadata,
          randomBytes: (length) => nodeRandomBytes(length),
        }),
    agentState: agentStateCiphertext,
    ownerMetadataValue: ownerMetadata.ownerMetadata,
  };
}

export function buildSessionMetadataEnvelopeCreateFields(
  params: SessionMetadataEnvelopeBuildParams,
): SessionMetadataEnvelopeFields {
  const {
    ownerMetadataValue: _ownerMetadataValue,
    ...fields
  } = buildSessionMetadataEnvelopeFields(params);
  return fields;
}
