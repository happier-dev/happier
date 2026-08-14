import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

import { redactDiagnosticsHeaders } from '../../../../browser/diagnostics/egress/headers.js';
import { isUnsafeTelemetryDataKey } from '../../../../common/sensitiveKeys.js';

/**
 * Canonical peer-mediation observability metadata redactor.
 *
 * Root cause B / DUP-3: the daemon (`apps/cli`) and server (`apps/server`) each carried a
 * line-for-line copy of this redactor (header allowlist, URL key-only stripping, recursive metadata
 * sanitizer, hashed reference helper). They differed ONLY in the URL parse base and string-truncation
 * limit — every other byte drifted independently. Protocol is the shared layer both `apps/cli` and
 * `apps/server` may import (cli must not import server and vice-versa), so the single owner lives
 * here. Callers pass the env-specific `urlBase` and reuse the shared SAFE_TELEMETRY_HEADER_NAMES
 * allowlist (which excludes `sec-websocket-protocol`).
 */

export type PeerMediationObservabilityHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export type PeerMediationObservabilityRedactionOptions = Readonly<{
  /** Base used to parse relative URLs (e.g. `http://loopback.invalid` / `http://preview.invalid`). */
  urlBase: string;
  /** Max length for string metadata values before truncation. */
  valueLimit?: number;
}>;

const DEFAULT_VALUE_LIMIT = 512;
const HEADER_VALUE_LIMIT = 256;

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function truncateValue(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function redactPeerMediationObservabilityHeaders(
  headers: PeerMediationObservabilityHeaders,
): Readonly<Record<string, string>> {
  return redactDiagnosticsHeaders(headers, { valueLimit: HEADER_VALUE_LIMIT });
}

export function redactPeerMediationObservabilityUrl(
  rawUrl: string,
  urlBase: string,
): Readonly<{ path: string; queryKeys: readonly string[] }> {
  try {
    const parsed = new URL(rawUrl, urlBase);
    const queryKeys: string[] = [];
    for (const key of parsed.searchParams.keys()) {
      if (isUnsafeTelemetryDataKey(key)) continue;
      if (!queryKeys.includes(key)) queryKeys.push(key);
    }
    return { path: parsed.pathname || '/', queryKeys };
  } catch {
    return { path: '/', queryKeys: [] };
  }
}

function redactMetadataValue(
  key: string,
  value: unknown,
  options: Required<PeerMediationObservabilityRedactionOptions>,
): unknown {
  const normalized = normalizeName(key);
  if (normalized === 'url' && typeof value === 'string') {
    return redactPeerMediationObservabilityUrl(value, options.urlBase);
  }
  if (normalized === 'headers' && isRecord(value)) {
    return redactPeerMediationObservabilityHeaders(value as PeerMediationObservabilityHeaders);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactMetadataValue(key, item, options));
  }
  if (isRecord(value)) {
    return redactPeerMediationObservabilityMetadata(value, options);
  }
  return typeof value === 'string' ? truncateValue(value, options.valueLimit) : value;
}

export function redactPeerMediationObservabilityMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  options: PeerMediationObservabilityRedactionOptions,
): Readonly<Record<string, unknown>> {
  if (!metadata) return {};
  const resolved: Required<PeerMediationObservabilityRedactionOptions> = {
    urlBase: options.urlBase,
    valueLimit: options.valueLimit ?? DEFAULT_VALUE_LIMIT,
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isUnsafeTelemetryDataKey(key)) continue;
    out[key] = redactMetadataValue(key, value, resolved);
  }
  return out;
}

export function redactedPeerMediationObservabilityReference(
  prefix: string,
  raw: string | undefined,
): string | undefined {
  if (!raw) return undefined;
  return `${prefix}_${bytesToHex(sha256(utf8ToBytes(raw))).slice(0, 12)}`;
}
