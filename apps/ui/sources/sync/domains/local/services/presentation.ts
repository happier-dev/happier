import { t } from '@/text';
import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';

type UnknownRecord = Record<string, unknown>;

export type LocalServiceDisplayDiagnostic = Readonly<{
    code: string;
    severity: 'info' | 'warning' | 'error';
}>;

function isRecord(value: unknown): value is UnknownRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readRecordField(value: unknown, key: string): unknown {
    return isRecord(value) ? value[key] : undefined;
}

export function readLocalServiceDiagnostics(value: readonly unknown[]): readonly LocalServiceDisplayDiagnostic[] {
    return value
        .map((entry): LocalServiceDisplayDiagnostic | null => {
            if (!isRecord(entry)) return null;
            const code = readString(entry.code);
            if (!code) return null;
            const severity = entry.severity === 'warning' || entry.severity === 'error'
                ? entry.severity
                : 'info';
            return { code, severity };
        })
        .filter((entry): entry is LocalServiceDisplayDiagnostic => Boolean(entry));
}

// ---------------------------------------------------------------------------
// Density / openability / session-attribution presentation helpers
// (pure functions; no domain state, no browser-target construction, no filter)
//
// Row ORDERING is not here: `serviceRow.ts#buildLocalServiceRows` is the single
// ranking owner. The predecessor rankers that lived alongside it were removed with
// the legacy managed render path (RU2 surfaces finalization, SB-B).
// ---------------------------------------------------------------------------

/** A row carrying a numeric `port` field — inventory rows and launch records both qualify. */
type PortBearingRow = Readonly<{ port?: number | null }>;

/**
 * The monospace `:<port>` token shown beside a service's primary label. Returns
 * `null` when the row exposes no positive port so callers omit the token rather
 * than rendering an empty `:` affordance.
 */
export function resolveLocalServicePortLabel(row: PortBearingRow): string | null {
    const port = row.port;
    if (typeof port !== 'number' || !Number.isFinite(port) || port <= 0) {
        return null;
    }
    return `:${port}`;
}

/**
 * The persistent "N services · M running" header count. `total` is every detected
 * row on the surface; `running` is the subset currently listening.
 */
export function selectLocalServiceServiceCounts(input: Readonly<{
    inventoryRows: readonly LocalServiceInventoryRow[];
}>): Readonly<{ total: number; running: number }> {
    return {
        total: input.inventoryRows.length,
        running: input.inventoryRows.reduce(
            (count, row) => count + (row.state === 'listening' ? 1 : 0),
            0,
        ),
    };
}

/**
 * Returns the launch target itself when its service is openable in the browser —
 * i.e. it carries a daemon-projected `browserTarget` and is not `unavailable`.
 * Returns `null` otherwise so callers render no open affordance (fail-closed).
 *
 * Openability is judged purely from the **service** launch target. This helper
 * never reads, builds, or references a browser view target; the launch
 * target → browser target mapping and the actual open belong to the host's
 * bound `onOpenServiceInBrowser` callback, not this presentation layer.
 */
export function resolveLocalServiceOpenableTarget(
    target: LocalServiceLaunchTarget,
): LocalServiceLaunchTarget | null {
    if (target.state === 'unavailable') {
        return null;
    }
    return target.browserTarget ? target : null;
}

/**
 * The monospace `:<port>` token for a launch target. Launch targets carry their
 * address in `subtitle` (e.g. `localhost:5173`), not a numeric `port` field, so
 * we parse the trailing `:<digits>` and funnel it through
 * {@link resolveLocalServicePortLabel} for a single port-token authority.
 */
export function resolveLocalServiceLaunchTargetPortLabel(target: LocalServiceLaunchTarget): string | null {
    const subtitle = readString(target.subtitle);
    if (!subtitle) {
        return null;
    }
    const match = /:(\d{1,5})(?:\/|$)/.exec(subtitle);
    const port = match ? Number.parseInt(match[1] as string, 10) : NaN;
    return resolveLocalServicePortLabel({ port: Number.isFinite(port) ? port : null });
}

/** A row carrying session attribution — a launch target (`sessionId`) or an inventory row (`provenance.session.id`). */
type SessionAttributedRow = LocalServiceInventoryRow | LocalServiceLaunchTarget;

function readRowSessionId(row: SessionAttributedRow): string | null {
    const directSessionId = readString((row as { sessionId?: unknown }).sessionId);
    if (directSessionId) {
        return directSessionId;
    }
    const session = readRecordField((row as { provenance?: unknown }).provenance, 'session');
    return readString(readRecordField(session, 'id'));
}

/**
 * `true` when a row's own session attribution (launch-target `sessionId` or
 * inventory `provenance.session.id`) equals the active session. Always `false`
 * when `sessionId` is null/absent — this never infers attribution from anything
 * but the row's own session fact.
 */
export function isLocalServiceRowAttributedToSession(
    row: SessionAttributedRow,
    sessionId: string | null,
): boolean {
    if (!sessionId) {
        return false;
    }
    return readRowSessionId(row) === sessionId;
}

