import { createHash, createHmac, hkdfSync } from 'node:crypto';

import type { ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';

export type ProviderAccountUsageFingerprintKey = Uint8Array;

const PROVIDER_ACCOUNT_USAGE_FINGERPRINT_INFO = 'happier-provider-account-usage-snapshot-dedup-v1';

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

function buildMaterialSnapshot(snapshot: ProviderAccountUsageSnapshotV1): JsonValue {
  return normalizeJsonValue({
    v: snapshot.v,
    recordKey: snapshot.recordKey,
    providerId: snapshot.providerId,
    accountSubject: snapshot.accountSubject,
    staleAfterMs: snapshot.staleAfterMs,
    source: snapshot.source,
    confidence: snapshot.confidence,
    state: snapshot.state,
    planLabel: snapshot.planLabel ?? null,
    accountLabel: snapshot.accountLabel ?? null,
    recoveryCredits: snapshot.recoveryCredits ?? null,
    meters: snapshot.meters,
  });
}

function serializeProviderAccountUsageSnapshotMaterial(snapshot: ProviderAccountUsageSnapshotV1): string {
  return stableJson(buildMaterialSnapshot(snapshot));
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
  credentials: Credentials;
  serverScope: string;
  accountScope: string;
}>): ProviderAccountUsageFingerprintKey {
  const sourceMaterial = input.credentials.encryption.type === 'legacy'
    ? input.credentials.encryption.secret
    : input.credentials.encryption.machineKey;
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
