import { createHmac, hkdfSync } from 'node:crypto';

import type { ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';

export type QuotaSnapshotFingerprintKey = Uint8Array;

const QUOTA_FINGERPRINT_INFO = 'happier-connected-service-quota-snapshot-dedup-v1';

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function toBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((entry) => normalizeJsonValue(entry));
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = normalizeJsonValue(entry);
    }
    return out;
  }
  return null;
}

function buildMaterialSnapshot(snapshot: ConnectedServiceQuotaSnapshotV1): JsonValue {
  return normalizeJsonValue({
    v: snapshot.v,
    serviceId: snapshot.serviceId,
    profileId: snapshot.profileId,
    staleAfterMs: snapshot.staleAfterMs,
    planLabel: snapshot.planLabel,
    accountLabel: snapshot.accountLabel,
    providerId: snapshot.providerId,
    activeAccountId: snapshot.activeAccountId,
    source: snapshot.source,
    confidence: snapshot.confidence,
    meters: snapshot.meters,
  });
}

export function deriveQuotaSnapshotFingerprintKey(input: Readonly<{
  credentials: Credentials;
  serverScope: string;
  accountScope: string;
}>): QuotaSnapshotFingerprintKey {
  const sourceMaterial = input.credentials.encryption.type === 'legacy'
    ? input.credentials.encryption.secret
    : input.credentials.encryption.machineKey;
  return new Uint8Array(hkdfSync(
    'sha256',
    toBuffer(sourceMaterial),
    Buffer.from(`quota:${input.serverScope}:${input.accountScope}`, 'utf8'),
    Buffer.from(QUOTA_FINGERPRINT_INFO, 'utf8'),
    32,
  ));
}

export function computeQuotaSnapshotFingerprint(
  snapshot: ConnectedServiceQuotaSnapshotV1,
  key: QuotaSnapshotFingerprintKey,
): string {
  return createHmac('sha256', toBuffer(key))
    .update(stableJson(buildMaterialSnapshot(snapshot)), 'utf8')
    .digest('hex')
    .slice(0, 32);
}
