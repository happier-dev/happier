import { t } from '@/text';
import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { ManagedLocalServiceRow as ManagedLocalServiceStoreRow } from '@/sync/domains/local/services/managed/store';

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

function readLabelTexts(labels: readonly unknown[]): readonly string[] {
    return labels
        .map((label) => readString(readRecordField(label, 'text')))
        .filter((text): text is string => Boolean(text));
}

function readPresentation(row: LocalServiceInventoryRow, key: string): string | null {
    return readString(readRecordField(row.presentation, key));
}

function readClassification(row: LocalServiceInventoryRow, key: string): string | null {
    return readString(readRecordField(row.classification, key));
}

function readWorkspacePath(row: LocalServiceInventoryRow): string | null {
    const workspace = readRecordField(row.provenance, 'workspace');
    return readString(readRecordField(workspace, 'path'));
}

function readRedactedProcessCommand(row: LocalServiceInventoryRow): string | null {
    const process = readRecordField(row.provenance, 'process');
    if (!isRecord(process) || process.redacted !== true) {
        return null;
    }
    return readString(process.command);
}

export function resolveLocalServiceAddressLabel(row: LocalServiceInventoryRow): string {
    return readPresentation(row, 'addressLabel') ?? `${row.address.host}:${row.port}`;
}

export function resolveLocalServiceTitle(row: LocalServiceInventoryRow): string {
    return readPresentation(row, 'pageTitle')
        ?? readPresentation(row, 'displayName')
        ?? readClassification(row, 'displayName')
        ?? resolveLocalServiceAddressLabel(row);
}

export function resolveLocalServiceFactLines(row: LocalServiceInventoryRow): readonly string[] {
    const labels = readLabelTexts(row.labels).map((label) => t('localServices.inventory.label', { value: label }));
    const diagnostics = readLocalServiceDiagnostics(row.diagnostics)
        .map((diagnostic) => t('localServices.inventory.diagnostic', { value: diagnostic.code }));
    const command = readRedactedProcessCommand(row);
    const workspace = readWorkspacePath(row);
    const folder = readPresentation(row, 'folderLabel');

    return [
        t('localServices.inventory.address', { value: resolveLocalServiceAddressLabel(row) }),
        folder ? t('localServices.inventory.folder', { value: folder }) : null,
        workspace ? t('localServices.inventory.workspace', { value: workspace }) : null,
        command ? t('localServices.inventory.process', { value: command }) : null,
        ...labels,
        resolveInventoryConfidenceLabel(row.confidence),
        ...diagnostics,
    ].filter((line): line is string => Boolean(line));
}

function resolveInventoryConfidenceKey(confidence: LocalServiceInventoryRow['confidence']): 'strong' | 'moderate' | 'tentative' {
    switch (confidence) {
        case 'high':
            return 'strong';
        case 'medium':
            return 'moderate';
        case 'low':
            return 'tentative';
    }
}

function resolveInventoryConfidenceLabel(confidence: LocalServiceInventoryRow['confidence']): string {
    switch (resolveInventoryConfidenceKey(confidence)) {
        case 'strong':
            return t('localServices.inventory.confidenceLabel.strong');
        case 'moderate':
            return t('localServices.inventory.confidenceLabel.moderate');
        case 'tentative':
            return t('localServices.inventory.confidenceLabel.tentative');
    }
}

export function resolveInventoryStatusLabel(state: LocalServiceInventoryRow['state']): string {
    switch (state) {
        case 'listening':
            return t('localServices.inventory.state.listening');
        case 'stale':
            return t('localServices.inventory.state.stale');
        case 'gone':
            return t('localServices.inventory.state.gone');
        case 'unknown':
            return t('localServices.inventory.state.unknown');
    }
}

export function resolveManagedStatusLabel(phase: ManagedLocalServiceStoreRow['phase']): string {
    switch (phase) {
        case 'starting':
            return t('localServices.managed.status.starting');
        case 'detecting':
            return t('localServices.managed.status.detecting');
        case 'running':
            return t('localServices.managed.status.running');
        case 'unhealthy':
            return t('localServices.managed.status.unhealthy');
        case 'stopping':
            return t('localServices.managed.status.stopping');
        case 'stopped':
            return t('localServices.managed.status.stopped');
        case 'failed':
            return t('localServices.managed.status.failed');
    }
}

function resolveManagedLaunchModeLabel(launchMode: ManagedLocalServiceStoreRow['launchMode']): string {
    switch (launchMode) {
        case 'detectAfterLaunch':
            return t('localServices.managed.launchModeLabel.detectedAfterStart');
        case 'assignAndInject':
            return t('localServices.managed.launchModeLabel.assignedAtStart');
        case 'externalRegistered':
            return t('localServices.managed.launchModeLabel.registeredByTool');
    }
}

export function resolveManagedFactLines(row: ManagedLocalServiceStoreRow): readonly string[] {
    const diagnostics = readLocalServiceDiagnostics(row.diagnostics)
        .map((diagnostic) => t('localServices.managed.diagnostic', { value: diagnostic.code }));

    return [
        row.ownerLabel ? t('localServices.managed.owner', { value: row.ownerLabel }) : null,
        row.routeName ? t('localServices.managed.route', { value: row.routeName }) : null,
        resolveManagedLaunchModeLabel(row.launchMode),
        row.url ? t('localServices.managed.url', { value: row.url }) : null,
        ...diagnostics,
    ].filter((line): line is string => Boolean(line));
}

// ---------------------------------------------------------------------------
// Density / ordering / openability / session-attribution presentation helpers
// (pure functions; no domain state, no browser-target construction, no filter)
// ---------------------------------------------------------------------------

/** A row carrying a numeric `port` field — inventory rows and managed/launch records both qualify. */
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

/** `true` when a detected inventory row is currently listening. */
function isInventoryRowRunning(row: LocalServiceInventoryRow): boolean {
    return row.state === 'listening';
}

/**
 * Running-first sort key for any row that may carry a `state` field. Listening
 * rows sort first (`0`); everything else preserves input order (`1`). Launch
 * targets (states `available|starting|stale|unavailable`) never report
 * `listening`, so this is a stable no-op for them — running-first only reorders
 * detected inventory rows, exactly where the live/stale distinction exists.
 */
function runningFirstSortKey(row: Readonly<{ state?: unknown }>): 0 | 1 {
    return row.state === 'listening' ? 0 : 1;
}

function stableSortByRunningFirst<Row extends Readonly<{ state?: unknown }>>(
    rows: readonly Row[],
): readonly Row[] {
    return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
            const keyDelta = runningFirstSortKey(a.row) - runningFirstSortKey(b.row);
            return keyDelta !== 0 ? keyDelta : a.index - b.index;
        })
        .map((entry) => entry.row);
}

/** `true` when a managed service is in a live phase (running or actively detecting its port). */
function isManagedRowRunning(row: ManagedLocalServiceStoreRow): boolean {
    return row.phase === 'running' || row.phase === 'detecting';
}

/**
 * The persistent "N services · M running" header count. `total` is every row on
 * the surface; `running` is detected rows that are listening plus managed rows
 * in a live phase.
 */
export function selectLocalServiceServiceCounts(input: Readonly<{
    inventoryRows: readonly LocalServiceInventoryRow[];
    managedRows: readonly ManagedLocalServiceStoreRow[];
}>): Readonly<{ total: number; running: number }> {
    const inventoryRunning = input.inventoryRows.reduce(
        (count, row) => count + (isInventoryRowRunning(row) ? 1 : 0),
        0,
    );
    const managedRunning = input.managedRows.reduce(
        (count, row) => count + (isManagedRowRunning(row) ? 1 : 0),
        0,
    );
    return {
        total: input.inventoryRows.length + input.managedRows.length,
        running: inventoryRunning + managedRunning,
    };
}

/**
 * Stable running-first ordering for detected inventory rows. Listening rows lead;
 * relative order within each band is preserved (referential stability is kept by
 * the caller's memoized row map — this only reorders, never clones rows).
 */
export function rankLocalServiceRows(
    rows: readonly LocalServiceInventoryRow[],
): readonly LocalServiceInventoryRow[] {
    return stableSortByRunningFirst(rows);
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

/** `true` when a launch target is ready to interact with (available). */
function isLaunchTargetReady(target: LocalServiceLaunchTarget): boolean {
    return target.state === 'available';
}

/**
 * Stable ready-first ordering for launch targets: `available` targets lead;
 * relative order within each band is preserved. Mirrors the running-first
 * ranking for detected rows, applied to the launch-target state vocabulary.
 */
export function rankLocalServiceLaunchTargets(
    targets: readonly LocalServiceLaunchTarget[],
): readonly LocalServiceLaunchTarget[] {
    return targets
        .map((target, index) => ({ target, index }))
        .sort((a, b) => {
            const keyDelta = (isLaunchTargetReady(a.target) ? 0 : 1) - (isLaunchTargetReady(b.target) ? 0 : 1);
            return keyDelta !== 0 ? keyDelta : a.index - b.index;
        })
        .map((entry) => entry.target);
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

/**
 * Partitions rows into the current session's services and the rest of the
 * workspace's services, preserving input order within each band. This is a
 * grouping/sort primitive — NOT a filter: every input row lands in exactly one
 * band (`thisSession.length + workspace.length === rows.length`). When
 * `sessionId` is null, every row lands in `workspace`.
 */
export function partitionLocalServiceRowsBySession<Row extends SessionAttributedRow>(
    rows: readonly Row[],
    sessionId: string | null,
): Readonly<{ thisSession: readonly Row[]; workspace: readonly Row[] }> {
    if (!sessionId) {
        return { thisSession: [], workspace: stableSortByRunningFirst(rows) };
    }
    const thisSession: Row[] = [];
    const workspace: Row[] = [];
    for (const row of rows) {
        if (isLocalServiceRowAttributedToSession(row, sessionId)) {
            thisSession.push(row);
        } else {
            workspace.push(row);
        }
    }
    return {
        thisSession: stableSortByRunningFirst(thisSession),
        workspace: stableSortByRunningFirst(workspace),
    };
}
