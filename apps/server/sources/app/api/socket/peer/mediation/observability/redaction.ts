import {
    redactPeerMediationObservabilityHeaders as redactSharedPeerMediationObservabilityHeaders,
    redactPeerMediationObservabilityMetadata as redactSharedPeerMediationObservabilityMetadata,
    redactPeerMediationObservabilityUrl as redactSharedPeerMediationObservabilityUrl,
    redactedPeerMediationObservabilityReference,
    type PeerMediationObservabilityHeaders as SharedPeerMediationObservabilityHeaders,
} from "@happier-dev/protocol";

// Server-side peer-mediation observability redaction. The redaction logic itself lives in the single
// shared protocol owner (`@happier-dev/protocol`); this module only binds the server-specific URL
// base so `apps/cli` and `apps/server` cannot re-drift (DUP-3). server must not import cli and vice
// versa — protocol is the shared layer both may import.
const SERVER_OBSERVABILITY_URL_BASE = "http://preview.invalid";

export type PeerMediationObservabilityHeaders = SharedPeerMediationObservabilityHeaders;

export function redactPeerMediationObservabilityHeaders(
    headers: PeerMediationObservabilityHeaders,
): Readonly<Record<string, string>> {
    return redactSharedPeerMediationObservabilityHeaders(headers);
}

export function redactPeerMediationObservabilityUrl(
    rawUrl: string,
): Readonly<{ path: string; queryKeys: readonly string[] }> {
    return redactSharedPeerMediationObservabilityUrl(rawUrl, SERVER_OBSERVABILITY_URL_BASE);
}

export function redactPeerMediationObservabilityMetadata(
    metadata: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
    return redactSharedPeerMediationObservabilityMetadata(metadata, { urlBase: SERVER_OBSERVABILITY_URL_BASE });
}

export function redactedPeerMediationReference(prefix: string, raw: string | undefined): string | undefined {
    return redactedPeerMediationObservabilityReference(prefix, raw);
}
