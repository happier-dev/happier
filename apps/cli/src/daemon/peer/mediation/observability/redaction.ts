import {
    redactPeerMediationObservabilityHeaders,
    redactPeerMediationObservabilityMetadata,
    redactPeerMediationObservabilityUrl,
    redactedPeerMediationObservabilityReference,
    type PeerMediationObservabilityHeaders,
} from '@happier-dev/protocol';

// Daemon-side peer-mediation observability redaction. The redaction logic itself lives in the single
// shared protocol owner (`@happier-dev/protocol`); this module only binds the daemon-specific URL
// base so `apps/cli` and `apps/server` cannot re-drift (DUP-3). cli must not import server and vice
// versa — protocol is the shared layer both may import.
const DAEMON_OBSERVABILITY_URL_BASE = 'http://loopback.invalid';

export type DaemonPeerMediationObservabilityHeaders = PeerMediationObservabilityHeaders;

export function redactDaemonPeerMediationObservabilityHeaders(
    headers: DaemonPeerMediationObservabilityHeaders,
): Readonly<Record<string, string>> {
    return redactPeerMediationObservabilityHeaders(headers);
}

export function redactDaemonPeerMediationObservabilityUrl(
    rawUrl: string,
): Readonly<{ path: string; queryKeys: readonly string[] }> {
    return redactPeerMediationObservabilityUrl(rawUrl, DAEMON_OBSERVABILITY_URL_BASE);
}

export function redactDaemonPeerMediationObservabilityMetadata(
    metadata: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
    return redactPeerMediationObservabilityMetadata(metadata, { urlBase: DAEMON_OBSERVABILITY_URL_BASE });
}

export function redactedDaemonPeerMediationReference(prefix: string, raw: string | undefined): string | undefined {
    return redactedPeerMediationObservabilityReference(prefix, raw);
}
