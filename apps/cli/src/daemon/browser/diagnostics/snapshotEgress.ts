import {
    ALWAYS_STRIP_FIELD_NAMES,
    classifyBrowserDiagnosticFieldForDestination,
    resolveRedactionLevel,
    type BrowserDiagnosticEgressDestination,
    type BrowserDiagnosticEventV1,
    type BrowserDiagnosticsSnapshotV1,
} from '@happier-dev/protocol';

/**
 * Viewer-identity-gated egress fidelity for the cross-device browser-diagnostics snapshot RPC (X1).
 *
 * This is the coupling LANE-B (destination fidelity) and LANE-C (viewer identity) were missing: the
 * `DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT` RPC is the cross-device egress chokepoint, so the snapshot it
 * returns must be redacted for the REQUESTING PARTY. Full owner fidelity (`resolveRedactionLevel` ⇒
 * `none`) is honored ONLY for the verified owning viewer; an agent/remote viewer is reduced to
 * `metadataOnly` so owner-full fidelity never leaks cross-device.
 *
 * Redaction-SSOT boundary (do NOT re-implement here):
 * - The owner-only value vector that genuinely differs by party is the INJECTED `console.entry.text`
 *   (and any future injected owner-only field). Those are stripped through the canonical egress
 *   classifier (`classifyBrowserDiagnosticFieldForDestination`), the same SSOT the capture/sidecar
 *   layers use, so the two can never drift.
 * - Credential-egress vectors (`protocol`/`cookie`/`authorization`) are dropped at EVERY destination,
 *   even the owner, via `ALWAYS_STRIP_FIELD_NAMES` (defense-in-depth; capture already strips them).
 * - cdp/previewProxy/nativeCallback VALUE redaction is owned by the sidecar capture layer (LANE-B B2);
 *   the daemon store holds already-redacted cdp events. This egress gate enforces the per-party LEVEL
 *   and the injected owner-only + credential stripping; it does not duplicate the per-kind cdp value
 *   allowlist.
 */
export type BrowserDiagnosticsViewerParty = 'owner' | 'agent';

export function browserDiagnosticsEgressDestinationForViewer(
    party: BrowserDiagnosticsViewerParty,
): BrowserDiagnosticEgressDestination {
    return party === 'owner' ? 'localOwner' : 'remoteSnapshot';
}

function normalizeFieldName(name: string): string {
    return name.trim().toLowerCase();
}

function redactEventDataForDestination(
    event: BrowserDiagnosticEventV1,
    destination: BrowserDiagnosticEgressDestination,
): Record<string, unknown> {
    const data = event.data ?? {};
    const injected = event.fidelity === 'injectedPage';
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
        // Credential-egress vectors never survive, even for the verified owner.
        if (ALWAYS_STRIP_FIELD_NAMES.has(normalizeFieldName(key))) continue;
        // Injected (page-tamperable) events carry the canonical per-kind allowlist; keep only the
        // fields the destination-aware classifier admits. This drops the owner-only console `text`
        // for an agent/remote viewer while keeping it for the verified owner.
        if (injected && classifyBrowserDiagnosticFieldForDestination(event.kind, key, destination) !== 'keep') {
            continue;
        }
        redacted[key] = value;
    }
    return redacted;
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
        data: redactEventDataForDestination(event, destination),
        redaction: { ...event.redaction, level },
    };
}

/**
 * Redact a daemon-owned browser-diagnostics snapshot for the requesting viewer party. The verified
 * owning viewer (`owner`) sees full fidelity (`none`); any other party (`agent` — agent transcript or
 * a remote device) is reduced to `metadataOnly`.
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
