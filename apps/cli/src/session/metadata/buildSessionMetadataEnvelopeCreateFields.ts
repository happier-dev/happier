import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { projectUsageSessionTimingV1, type UsageSessionTimingV1 } from '@happier-dev/protocol/usage/usageWorkEvidence';

import { SESSION_METADATA_LAYOUT_VERSION_V1, createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { projectSessionDisplayV1, sealSessionSharedDisplayEnvelopeV1Sync, sealSessionOwnerDisplayEnvelopeV1 } from '@happier-dev/protocol';
import type { AccountScopedCryptoMaterial, SessionOwnerMetadataEnvelopeV1, SessionOwnerMetadataV1, SessionDisplayProjectionV1 } from '@happier-dev/protocol';

import { encodeBase64, encrypt } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';

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
  usageTimingV1: UsageSessionTimingV1;
  metadataLayoutVersion: typeof SESSION_METADATA_LAYOUT_VERSION_V1;
  sharedMetadata: Readonly<{ ciphertext: string }>;
  ownerMetadata: SessionOwnerMetadataEnvelopeV1;
  agentState: string | null;
  displayProjectionV1: SessionDisplayProjectionV1 | null;
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
  // Both full documents and display leaves describe this exact create tuple.
  // Projection precedes crypto; the existing Session key is already available
  // even though the Home has not assigned the final Session identity yet.
  let displayProjectionV1: SessionDisplayProjectionV1 | null = null;
  try {
    const display = projectSessionDisplayV1({ sharedMetadata, ownerMetadata: ownerMetadata.ownerMetadata });
    if (!display.owner) throw new SessionMetadataPrivacyUpgradeRequiredError(['ownerDisplay']);
    const sharedDisplay = sealSessionSharedDisplayEnvelopeV1Sync({
      sessionMode: params.storedContentMode,
      display: display.shared,
      ...(params.storedContentMode === 'e2ee' ? {
        encryptPayload: (payload: unknown) => encodeBase64(encrypt(params.encryptionKey, params.encryptionVariant, payload)),
      } : {}),
    });
    const ownerDisplay = sealSessionOwnerDisplayEnvelopeV1({
      accountMode: params.accountEncryptionMode,
      display: display.owner,
      ...(params.accountEncryptionMode === 'e2ee' ? { material: resolveAccountEncryptionMaterial(params.credentials) } : {}),
      randomBytes: length => nodeRandomBytes(length),
    });
    if (!sharedDisplay.ok || !ownerDisplay.ok) {
      throw new SessionMetadataPrivacyUpgradeRequiredError([
        ...(!sharedDisplay.ok ? ['sharedDisplay'] : []),
        ...(!ownerDisplay.ok ? ['ownerDisplay'] : []),
      ]);
    }
    displayProjectionV1 = { v: 1, sourceMetadataVersion: 0, metadataLayoutVersion: 1,
      shared: sharedDisplay.envelope, owner: ownerDisplay.envelope };
  } catch {
    logger.warn('[SessionDisplay] Projection unavailable; creating the full metadata tuple without display');
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
    usageTimingV1: projectUsageSessionTimingV1({ metadata: params.metadata, agentState: params.agentState ?? {} }),
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
    displayProjectionV1,
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
