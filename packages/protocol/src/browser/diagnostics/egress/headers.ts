import { isUnsafeTelemetryDataKey } from '../../../common/sensitiveKeys.js';
import { redactSensitiveUrlPathSegments } from './url.js';

/**
 * Canonical safe-telemetry header allowlist for browser diagnostics egress.
 *
 * This is the SINGLE source of truth for which response/request header NAMES may be surfaced in
 * redacted diagnostics. It was previously re-encoded ≥4× across the protocol layer, the daemon
 * sidecar, the peer-mediation observability twins, and the host re-sanitizer, and it DRIFTED on
 * `sec-websocket-protocol` (the sidecar correctly excluded it; other copies leaked it).
 *
 * `sec-websocket-protocol` is intentionally NOT listed: browsers cannot set `Authorization` on a
 * WebSocket handshake, so clients smuggle bearer tokens through the subprotocol value
 * (e.g. Kubernetes `base64url.bearer.authorization.k8s.io.<token>`), making its value a
 * credential-egress vector. Surfacing only allowlisted, value-safe header names keeps the
 * diagnostics contract metadata-only at egress.
 */
export const SAFE_TELEMETRY_HEADER_NAMES: ReadonlySet<string> = new Set([
  'accept',
  'content-type',
  'x-request-id',
  'x-tenant-label',
]);

export function normalizeTelemetryHeaderName(value: string): string {
  return value.trim().toLowerCase();
}

export function isSafeTelemetryHeaderName(name: string): boolean {
  return SAFE_TELEMETRY_HEADER_NAMES.has(normalizeTelemetryHeaderName(name));
}

function headerValues(value: string | readonly string[] | undefined): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 0) return '';
  if (limit <= 3) return value.slice(0, limit);
  return `${value.slice(0, limit - 3)}...`;
}

export type TelemetryHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * Redact a header bag down to the allowlisted, value-safe header names. Used at every egress site
 * (sidecar, peer-mediation observability, host re-sanitizer) so the allowlist can never drift again.
 */
export function redactDiagnosticsHeaders(
  headers: TelemetryHeaders | undefined,
  options: Readonly<{ valueLimit?: number }> = {},
): Readonly<Record<string, string>> {
  if (!headers) return {};
  const valueLimit = options.valueLimit ?? 256;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = normalizeTelemetryHeaderName(name);
    if (!SAFE_TELEMETRY_HEADER_NAMES.has(normalized)) continue;
    const values = headerValues(value);
    if (values.length === 0) continue;
    out[normalized] = truncate(values.join(', '), valueLimit);
  }
  return out;
}

export type RedactedDiagnosticsUrl = Readonly<{
  origin?: string;
  path: string;
  queryKeys: readonly string[];
}>;

/**
 * Redact a URL down to origin/path plus the NAMES of value-safe query params (never the values).
 * `urlBase` lets callers parse relative URLs (e.g. loopback/preview origins) without leaking a host.
 * When `includeOrigin` is false the origin is omitted (peer-mediation observability variant).
 */
export function redactDiagnosticsUrl(
  rawUrl: string,
  options: Readonly<{ urlBase?: string; includeOrigin?: boolean }> = {},
): RedactedDiagnosticsUrl {
  const includeOrigin = options.includeOrigin ?? true;
  try {
    const parsed = options.urlBase ? new URL(rawUrl, options.urlBase) : new URL(rawUrl);
    const queryKeys: string[] = [];
    for (const key of parsed.searchParams.keys()) {
      if (isUnsafeTelemetryDataKey(key)) continue;
      if (!queryKeys.includes(key)) queryKeys.push(key);
    }
    return {
      ...(includeOrigin ? { origin: parsed.origin } : {}),
      // Token-shaped path segments (`/reset/<token>`, UUIDs, JWTs) are as secret as query values;
      // redact them by value shape so only navigable structure survives (L2-3).
      path: redactSensitiveUrlPathSegments(parsed.pathname || '/'),
      queryKeys,
    };
  } catch {
    return {
      ...(includeOrigin ? { origin: 'unknown:' } : {}),
      path: '/',
      queryKeys: [],
    };
  }
}
