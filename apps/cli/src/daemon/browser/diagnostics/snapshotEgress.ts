import type { BrowserDiagnosticEgressDestination, BrowserDiagnosticEventV1, BrowserDiagnosticsSnapshotV1 } from '@happier-dev/protocol';
import { redactBrowserDiagnosticDataForDestination, resolveRedactionLevel } from '@happier-dev/protocol/browser/diagnostics/egress/classifier';

/**
 * Viewer-identity-gated egress fidelity for the cross-device browser-diagnostics snapshot RPC (X1).
 *
 * This is the coupling LANE-B (destination fidelity) and LANE-C (viewer identity) were missing: the
 * `DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT` RPC is the cross-device egress chokepoint, so the snapshot it
 * returns must be redacted for the REQUESTING PARTY. Full owner fidelity (`resolveRedactionLevel` ⇒
 * `none`) is honored for the transport-verified person, including trusted Machine guests;
 * agent destinations receive `metadataOnly`.
 *
 * Redaction-SSOT boundary (do NOT re-implement here):
 * - Console text/arguments and exception message/source/stack values differ by party at every
 *   fidelity, including CDP. Those are stripped through the canonical egress
 *   classifier (`classifyBrowserDiagnosticFieldForDestination`), the same SSOT the capture/sidecar
 *   layers use, so the two can never drift.
 * - Credential-egress vectors (`protocol`/`cookie`/`authorization`) are dropped at EVERY destination,
 *   even the person, via `ALWAYS_STRIP_FIELD_NAMES`. Selected-request values use a separate
 *   person-only envelope and never enter these event snapshots.
 * - The sidecar owns URL and safe-header redaction. This boundary consumes the same destination
 *   classifier as injected ingress, keeping owner-only values out of non-owner snapshots.
 */
export type BrowserDiagnosticsViewerParty = 'owner' | 'agent';

export function browserDiagnosticsEgressDestinationForViewer(
    party: BrowserDiagnosticsViewerParty,
): BrowserDiagnosticEgressDestination {
    return party === 'owner' ? 'localOwner' : 'remoteSnapshot';
}

function redactEventForDestination(
    event: BrowserDiagnosticEventV1,
    destination: BrowserDiagnosticEgressDestination,
): BrowserDiagnosticEventV1 {
    const injected = event.fidelity === 'injectedPage';
    // Full values are honored only for the local owner; an agent/remote viewer never gets ownerFull.
    const ownerFull = destination === 'localOwner';
    const level = resolveRedactionLevel(event.kind, destination, { injected, ownerFull });
    return {
        ...event,
        data: redactBrowserDiagnosticDataForDestination(event, destination),
        redaction: { ...event.redaction, level },
    };
}

/**
 * Redact a daemon-owned browser-diagnostics snapshot for the requesting viewer party. The verified
 * person (`owner`, the legacy destination name) sees full fidelity (`none`); an agent destination
 * is reduced to `metadataOnly` regardless of which device carries the request.
 */
export function redactBrowserDiagnosticsSnapshotForViewer(
    snapshot: BrowserDiagnosticsSnapshotV1,
    party: BrowserDiagnosticsViewerParty,
): BrowserDiagnosticsSnapshotV1 {
    const destination = browserDiagnosticsEgressDestinationForViewer(party);
    return {
        ...snapshot,
        events: snapshot.events.map((event) => redactEventForDestination(event, destination)),
    };
}
