import { createHash, createHmac, hkdfSync } from 'node:crypto';

import type { ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { serializeProviderAccountUsageSnapshotMaterialV1 } from '@happier-dev/protocol/connect/account-usage-primitives';
import type { StoredCredentials } from '@/persistence';

export type ProviderAccountUsageFingerprintKey = Uint8Array;

const PROVIDER_ACCOUNT_USAGE_FINGERPRINT_INFO = 'happier-provider-account-usage-snapshot-dedup-v1';

function toBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function serializeProviderAccountUsageSnapshotMaterial(snapshot: ProviderAccountUsageSnapshotV1): string {
  return serializeProviderAccountUsageSnapshotMaterialV1(snapshot);
}

export function computeProviderAccountUsageSnapshotMaterialRevision(
  snapshot: ProviderAccountUsageSnapshotV1,
): string {
  return createHash('sha256')
    .update(serializeProviderAccountUsageSnapshotMaterial(snapshot), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export function deriveProviderAccountUsageFingerprintKey(input: Readonly<{
  credentials: StoredCredentials;
  serverScope: string;
  accountScope: string;
}>): ProviderAccountUsageFingerprintKey {
  // Plain-account fingerprints are dedupe metadata, not ciphertext integrity.
  // Keep their public, scope-derived key independent of the rotating bearer token.
  const sourceMaterial = input.credentials.encryption
    ? input.credentials.encryption.type === 'legacy'
      ? input.credentials.encryption.secret
      : input.credentials.encryption.machineKey
    : createHash('sha256')
        .update(
          `plain:${input.serverScope}:${input.accountScope}:${PROVIDER_ACCOUNT_USAGE_FINGERPRINT_INFO}`,
          'utf8',
        )
        .digest();
  return new Uint8Array(hkdfSync(
    'sha256',
    toBuffer(sourceMaterial),
    Buffer.from(`provider-account-usage:${input.serverScope}:${input.accountScope}`, 'utf8'),
    Buffer.from(PROVIDER_ACCOUNT_USAGE_FINGERPRINT_INFO, 'utf8'),
    32,
  ));
}

export function computeProviderAccountUsageSnapshotFingerprint(
  snapshot: ProviderAccountUsageSnapshotV1,
  key: ProviderAccountUsageFingerprintKey,
): string {
  return createHmac('sha256', toBuffer(key))
    .update(serializeProviderAccountUsageSnapshotMaterial(snapshot), 'utf8')
    .digest('hex')
    .slice(0, 32);
}
