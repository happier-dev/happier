import { createHash } from 'node:crypto';

import {
    redactDiagnosticsHeaders,
    redactDiagnosticsUrl,
} from '@happier-dev/protocol';

export type SidecarDiagnosticsHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

// Header allowlist + URL stripping route through the single egress SSOT in `@happier-dev/protocol`
// (`SAFE_TELEMETRY_HEADER_NAMES` / `redactDiagnosticsHeaders` / `redactDiagnosticsUrl`), which
// excludes `sec-websocket-protocol` (a token-smuggling vector). This is the only owner — the sidecar
// no longer re-encodes the allowlist (root cause B / DUP-2).

export function createSidecarPrivateReference(prefix: string, raw: string): string {
    return `sidecar_${prefix}_${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
}

export function redactSidecarDiagnosticsHeaders(
    headers: SidecarDiagnosticsHeaders | undefined,
): Readonly<Record<string, string>> {
    return redactDiagnosticsHeaders(headers, { valueLimit: 256 });
}

export type SidecarRedactedUrl = Readonly<{
    origin: string;
    path: string;
    queryKeys: readonly string[];
}>;

export function redactSidecarDiagnosticsUrl(rawUrl: string): SidecarRedactedUrl {
    const redacted = redactDiagnosticsUrl(rawUrl);
    return {
        origin: redacted.origin ?? 'unknown:',
        path: redacted.path,
        queryKeys: redacted.queryKeys,
    };
}

export function redactSidecarContextUrl(rawUrl: string | undefined): string | undefined {
    if (!rawUrl) return undefined;

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return undefined;
    }
    const { path, queryKeys } = redactDiagnosticsUrl(rawUrl);
    const base = `${parsed.origin}${path || '/'}`;
    if (queryKeys.length === 0) return base;
    return `${base}?${queryKeys.map((key) => encodeURIComponent(key)).join('&')}`;
}

export function resolveSidecarContextOrigin(rawUrl: string | undefined): string | undefined {
    if (!rawUrl) return undefined;
    try {
        return new URL(rawUrl).origin;
    } catch {
        return undefined;
    }
}
