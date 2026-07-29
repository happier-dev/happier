import { randomBytes as nodeRandomBytes } from 'node:crypto';

import {
  SESSION_METADATA_LAYOUT_VERSION_V1,
  createSessionOwnerMetadataV1,
  projectSessionSharedMetadataV1,
  sealSessionOwnerMetadataV1,
  type SessionOwnerMetadataV1,
} from '@happier-dev/protocol';

import { encodeBase64, encrypt } from '@/api/encryption';
import type { Credentials } from '@/persistence';

export class SessionMetadataPrivacyUpgradeRequiredError extends Error {
  readonly code = 'metadata_privacy_upgrade_required' as const;
  readonly unsupportedFields: readonly string[];

  constructor(unsupportedFields: readonly string[]) {
    super('Session metadata requires a privacy-compatible client');
    this.name = 'SessionMetadataPrivacyUpgradeRequiredError';
    this.unsupportedFields = unsupportedFields;
  }
}

type SessionMetadataEnvelopeBuildParams = Readonly<{
  credentials: Credentials;
  metadata: unknown;
  agentState: unknown | null;
  storedContentMode: 'plain' | 'e2ee';
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
}>;

type SessionMetadataEnvelopeFields = Readonly<{
  metadataLayoutVersion: typeof SESSION_METADATA_LAYOUT_VERSION_V1;
  sharedMetadata: Readonly<{ ciphertext: string }>;
  ownerMetadata: Readonly<{ ciphertext: string }>;
  agentState: string | null;
}>;

type SessionMetadataLayoutZeroCreateFields = Readonly<{
  metadata: string;
  agentState: string | null;
}>;

export type SessionMetadataEnvelopeTupleFields = SessionMetadataEnvelopeFields & Readonly<{
  ownerMetadataValue: SessionOwnerMetadataV1;
}>;

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
  const ownerCryptoMaterial = params.credentials.encryption.type === 'legacy'
    ? {
        type: 'legacy' as const,
        secret: params.credentials.encryption.secret,
      }
    : {
        type: 'dataKey' as const,
        machineKey: params.credentials.encryption.machineKey,
      };
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
    ownerMetadata: {
      ciphertext: sealSessionOwnerMetadataV1({
        material: ownerCryptoMaterial,
        ownerMetadata: ownerMetadata.ownerMetadata,
        randomBytes: (length) => nodeRandomBytes(length),
      }),
    },
    agentState: agentStateCiphertext,
    ownerMetadataValue: ownerMetadata.ownerMetadata,
  };
}

export function buildSessionMetadataEnvelopeCreateFields(
  params: SessionMetadataEnvelopeBuildParams,
): SessionMetadataLayoutZeroCreateFields {
  const metadata = params.storedContentMode === 'plain'
    ? JSON.stringify(params.metadata)
    : encodeBase64(encrypt(
        params.encryptionKey,
        params.encryptionVariant,
        params.metadata,
      ));
  const agentState = params.agentState === null
    ? null
    : params.storedContentMode === 'plain'
      ? JSON.stringify(params.agentState)
      : encodeBase64(encrypt(
          params.encryptionKey,
          params.encryptionVariant,
          params.agentState,
        ));

  return {
    metadata,
    agentState,
  };
}
