import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';

import {
    isLocalServiceRowAttributedToSession,
    resolveLocalServiceLaunchTargetPortLabel,
    resolveLocalServiceOpenableTarget,
    resolveLocalServicePortLabel,
} from '@/sync/domains/local/services/presentation';
import type { TranslationKey } from '@/text/i18n';
import { localServiceListenerGroupKey } from '@happier-dev/protocol/local/services/inventory';

export type ServiceRowScope = 'thisSession' | 'workspace' | 'machine' | 'suggestion';
export type ServiceRowStatus = 'running' | 'starting' | 'stale' | 'stopped' | 'unavailable';

export type ServiceRow = Readonly<{
    id: string; // stable identity (inventory:<id> | package:<id> | ...)
    scope: ServiceRowScope; // ranking band
    title: string;
    portLabel: string | null; // ":<port>" or null (single port-token authority)
    scheme: 'http' | 'https' | 'unknown' | null;
    host: string | null; // "localhost" / "127.0.0.1" / null
    workspaceLabel: string | null; // cwd / workspace path
    processLabel: string | null; // redacted command preview
    /** Human identity/address facts projected by the inventory or launch target. */
    serviceLabel?: string | null;
    addressLabel?: string | null;
    sourceLabel: TranslationKey; // translation key for the source label
    status: ServiceRowStatus;
    reasonCode: string | null; // raw code for OWNER-COPY (NEVER rendered raw)
    primaryAction:
        | Readonly<{ kind: 'open'; openTarget: LocalServiceLaunchTarget }>
        | Readonly<{ kind: 'start'; target: LocalServiceLaunchTarget }>
        | Readonly<{ kind: 'run_script'; target: LocalServiceLaunchTarget }>
        | null; // null ⇒ inert row (quiet caption, no headline action)
    terminateIdentityConfidence?: 'full' | 'pid_only' | null;
    /** The underlying launch target, carried for per-row secondary affordances (e.g. public preview). */
    target: LocalServiceLaunchTarget;
    /** One of Happier's own listeners (its daemon, dev UI, tunnels, agent runners): shown apart, never counted. */
    internal: boolean;
    /** Present only when canonical inventory proves this listener is currently listening. */
    listeningListenerKey?: string;
}>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

const SOURCE_LABEL_KEYS: Readonly<Record<LocalServiceLaunchTarget['source'], TranslationKey>> = {
    inventory_entry: 'localServices.source.detected',
    managed_service: 'localServices.source.managed',
    package_script: 'localServices.source.packageScript',
    registered_preview: 'localServices.source.preview',
    terminal_url: 'localServices.source.terminalUrl',
    workspace_file_asset: 'localServices.source.fileAsset',
    recent: 'localServices.source.recent',
};

function resolveStatus(target: LocalServiceLaunchTarget): ServiceRowStatus {
    // Available means the script can be launched, never that a listener is running. Older
    // launcher snapshots may omit sourceClass; source already establishes this distinction.
    if (target.source === 'package_script') return 'stopped';
    switch (target.state) {
        case 'available':
            return 'running';
        case 'starting':
            return 'starting';
        case 'stale':
            return 'stale';
        case 'unavailable':
            // A managed_* stopped reason reads as stopped; everything else as unavailable.
            return target.unavailableReason?.includes('stopped') ? 'stopped' : 'unavailable';
    }
}

function resolvePrimaryAction(target: LocalServiceLaunchTarget): ServiceRow['primaryAction'] {
    if (target.source === 'package_script' && target.sourceClass?.kind === 'package_script') return { kind: 'run_script', target };
    // A target with private-preview registration is an Open intent. The shared action
    // owner registers it before admitting the returned browser target and access URL.
    const openTarget = resolveLocalServiceOpenableTarget(target);
    if (openTarget) {
        return { kind: 'open', openTarget };
    }
    if (target.actions.includes('start')) {
        return { kind: 'start', target };
    }
    return null;
}

function inventoryIdFromTarget(target: LocalServiceLaunchTarget): string | null {
    if (target.sourceClass?.kind === 'inventory_entry' || target.sourceClass?.kind === 'managed_service') {
        return target.sourceClass.inventoryEntryId ?? null;
    }
    return null;
}

function readWorkspaceLabel(row: LocalServiceInventoryRow | undefined): string | null {
    if (!row) return null;
    const workspace = isRecord(row.provenance) ? row.provenance.workspace : undefined;
    const workspacePath = readString(isRecord(workspace) ? workspace.path : undefined);
    if (workspacePath) return workspacePath;
    const process = isRecord(row.provenance) ? row.provenance.process : undefined;
    return readString(isRecord(process) ? process.cwd : undefined);
}

function readProcessLabel(row: LocalServiceInventoryRow | undefined, target: LocalServiceLaunchTarget): string | null {
    if (row) {
        const process = isRecord(row.provenance) ? row.provenance.process : undefined;
        const command = readString(isRecord(process) ? process.command : undefined);
        if (command && command !== 'unknown') return command;
    }
    return readString(target.commandPreview);
}

function readTerminateIdentityConfidence(
    row: LocalServiceInventoryRow | undefined,
    target: LocalServiceLaunchTarget,
): ServiceRow['terminateIdentityConfidence'] {
    if (!row || target.source !== 'inventory_entry' || !target.actions.includes('terminate_detected')) {
        return null;
    }
    const process = isRecord(row.provenance) ? row.provenance.process : undefined;
    if (!isRecord(process) || typeof process.pid !== 'number') {
        return null;
    }
    return typeof process.processStartTimeMs === 'number' ? 'full' : 'pid_only';
}

function readHost(row: LocalServiceInventoryRow | undefined): string | null {
    return row ? readString(row.address.host) : null;
}

function readScheme(row: LocalServiceInventoryRow | undefined): ServiceRow['scheme'] {
    if (!row) return null;
    const scheme = row.endpoint?.scheme;
    return scheme === 'http' || scheme === 'https' || scheme === 'unknown' ? scheme : null;
}

function resolveBand(
    target: LocalServiceLaunchTarget,
    sessionId: string | null,
    scope: 'workspace' | 'machine',
): ServiceRowScope {
    if (target.source === 'package_script') {
        return 'suggestion';
    }
    if (isLocalServiceRowAttributedToSession(target, sessionId)) {
        return 'thisSession';
    }
    return scope === 'machine' ? 'machine' : 'workspace';
}

const BAND_ORDER: Readonly<Record<ServiceRowScope, number>> = {
    thisSession: 0,
    workspace: 1,
    machine: 2,
    suggestion: 3,
};

function runningFirstKey(status: ServiceRowStatus): 0 | 1 {
    return status === 'running' ? 0 : 1;
}

/** `0.0.0.0:631`, `:::631`, `[::]:22`, `127.0.0.1:5173`, `localhost:5173` — an address, not a name. */
const ADDRESS_LIKE_TITLE = /^(?:\[?[0-9a-f:.]*\]?|localhost|\*):\d{1,5}$/i;

function executableName(command: string | null): string | null {
    const first = command?.trim().split(/\s+/)[0];
    if (!first) return null;
    const base = first.split(/[\\/]/).pop()?.trim();
    return base && base.length > 0 ? base : null;
}

/**
 * The row's name: the daemon's title when it is a real name (a page title, a framework, a package
 * script), else the process that listens, else `localhost:<port>`. A raw bind address such as
 * `0.0.0.0:44935` or `:::631` is never a name.
 */
function resolveServiceRowTitle(
    target: LocalServiceLaunchTarget,
    processLabel: string | null,
    portLabel: string | null,
): string {
    if (!ADDRESS_LIKE_TITLE.test(target.title.trim())) return target.title;
    const process = target.source === 'inventory_entry' ? executableName(processLabel) : null;
    if (process) return process;
    return portLabel ? `localhost${portLabel}` : target.title;
}

type AddressKind = LocalServiceInventoryRow['address']['kind'];

/** Among one port's bindings, the address that opens on this machine wins: loopback, then any-IPv4, then any-IPv6. */
function bindingRank(kind: AddressKind | null, host: string | null): number {
    if (kind === 'loopback') return 0;
    if (kind === 'wildcard') return host?.includes(':') ? 2 : 1;
    return 3;
}

/**
 * One row per local port: a server bound to `::`, `0.0.0.0` and `127.0.0.1` is one service, not three.
 * LAN-bound and non-inventory rows (package scripts, previews) are never merged. The kept row takes the
 * best name any of its bindings had.
 */
function dedupeLocalBindings(entries: readonly Readonly<{
    row: ServiceRow;
    index: number;
    kind: AddressKind | null;
    port: number | null;
    listenerKey: string | null;
}>[]): Array<{ row: ServiceRow; index: number }> {
    const groups = new Map<string, typeof entries[number][]>();
    const order: string[] = [];
    for (const entry of entries) {
        const local = entry.row.target.source === 'inventory_entry'
            && entry.port !== null
            && (entry.kind === 'loopback' || entry.kind === 'wildcard');
        const key = local ? entry.listenerKey! : `row:${entry.row.id}`;
        const group = groups.get(key);
        if (group) group.push(entry);
        else {
            groups.set(key, [entry]);
            order.push(key);
        }
    }
    return order.flatMap((key) => {
        const group = groups.get(key)!;
        const currentKinds = new Set(group.filter((entry) => entry.row.listeningListenerKey).map((entry) => entry.row.internal));
        // A port can be shared by distinct local interfaces/processes. Never fold a proven
        // user listener into Happier's group, while stale predecessors still yield to live facts.
        const partitions = currentKinds.size > 1
            ? [group.filter((entry) => entry.row.internal), group.filter((entry) => !entry.row.internal)]
            : [group];
        return partitions.map((group) => {
            const [kept] = [...group].sort((a, b) => (
                Number(!a.row.listeningListenerKey) - Number(!b.row.listeningListenerKey)
                || bindingRank(a.kind, a.row.host) - bindingRank(b.kind, b.row.host)
                || a.index - b.index
            ));
            const current = group.filter((entry) => entry.row.listeningListenerKey);
            const evidence = current.length > 0 ? current : group;
            const named = evidence.find((entry) => !ADDRESS_LIKE_TITLE.test(entry.row.target.title.trim()));
            const internal = evidence.some((entry) => entry.row.internal);
            const row = named && named !== kept
                ? { ...kept!.row, title: named.row.title, internal }
                : internal !== kept!.row.internal ? { ...kept!.row, internal } : kept!.row;
            return { row, index: kept!.index };
        });
    });
}

/**
 * The ONE ranked service-row model. Folds detected inventory rows and launcher targets
 * into a single list ordered:
 *   running/this-session → workspace → machine → suggestions.
 * Order within a band is stable (running-first). Never filters: every in-scope launch
 * target lands in exactly one band. Openability is judged via
 * resolveLocalServiceOpenableTarget; the open target is carried, never built here.
 *
 * Detected inventory is supporting metadata only. The daemon launcher snapshot is the
 * single source of truth for launch targets, openability, and browser targets; this row
 * model never rebuilds daemon targets from inventory.
 */
export function buildLocalServiceRows(input: Readonly<{
    inventoryRows: readonly LocalServiceInventoryRow[];
    launchTargets: readonly LocalServiceLaunchTarget[];
    sessionId: string | null;
    scope: 'workspace' | 'machine';
}>): readonly ServiceRow[] {
    const inventoryById = new Map<string, LocalServiceInventoryRow>();
    for (const row of input.inventoryRows) {
        inventoryById.set(row.id, row);
    }
    const mapped = input.launchTargets.map((target, index) => {
        const inventoryId = inventoryIdFromTarget(target);
        const inventoryRow = inventoryId ? inventoryById.get(inventoryId) : undefined;
        const status = resolveStatus(target);
        const processLabel = readProcessLabel(inventoryRow, target);
        // The inventory's numeric port is the authority; the target's subtitle is the fallback.
        const portLabel = (inventoryRow ? resolveLocalServicePortLabel(inventoryRow) : null)
            ?? resolveLocalServiceLaunchTargetPortLabel(target);
        const title = resolveServiceRowTitle(target, processLabel, portLabel);
        const listenerKey = inventoryRow ? localServiceListenerGroupKey(inventoryRow) : null;
        const row: ServiceRow = {
            id: target.id,
            scope: resolveBand(target, input.sessionId, input.scope),
            title,
            portLabel,
            scheme: readScheme(inventoryRow),
            host: readHost(inventoryRow),
            workspaceLabel: readWorkspaceLabel(inventoryRow) ?? readString(target.cwd),
            processLabel,
            serviceLabel: readString(isRecord(inventoryRow?.presentation) ? inventoryRow.presentation.displayName : null)
                ?? readString(isRecord(inventoryRow?.classification) ? inventoryRow.classification.displayName : null)
                ?? executableName(processLabel),
            addressLabel: readString(isRecord(inventoryRow?.presentation) ? inventoryRow.presentation.addressLabel : null)
                ?? readString(target.browserTarget?.display?.addressLabel),
            sourceLabel: SOURCE_LABEL_KEYS[target.source],
            status,
            reasonCode: target.source === 'package_script' && target.sourceClass?.kind === 'package_script' ? null : target.unavailableReason ?? null,
            primaryAction: resolvePrimaryAction(target),
            terminateIdentityConfidence: readTerminateIdentityConfidence(inventoryRow, target),
            target,
            internal: (target.source === 'inventory_entry' && target.kind === 'happier')
                || (isRecord(inventoryRow?.classification) && inventoryRow.classification.kind === 'happier'),
            ...(inventoryRow?.state === 'listening' && listenerKey ? { listeningListenerKey: listenerKey } : {}),
        };
        return { row, index, kind: inventoryRow?.address.kind ?? null, port: inventoryRow?.port ?? null, listenerKey };
    });
    const rows = dedupeLocalBindings(mapped);

    return rows
        .sort((a, b) => {
            const bandDelta = BAND_ORDER[a.row.scope] - BAND_ORDER[b.row.scope];
            if (bandDelta !== 0) return bandDelta;
            const runDelta = runningFirstKey(a.row.status) - runningFirstKey(b.row.status);
            if (runDelta !== 0) return runDelta;
            return a.index - b.index;
        })
        .map((entry) => entry.row);
}

/**
 * The pane's sections, by what the user can do with a row (session-tabs lab S): what is running here,
 * what can be started (a launcher target with a start action), what else runs on the machine, and
 * Happier's own listeners. A row that is neither running nor startable (a dead system listener, a
 * script the launcher refuses) has nothing to offer and is not shown (`null`). Derived from the ranking
 * band, status and primary action — never a second ranking.
 */
export type ServiceRowSection = 'running' | 'ready' | 'elsewhere' | 'happier';

const SECTION_ORDER: readonly ServiceRowSection[] = ['running', 'ready', 'elsewhere', 'happier'];

export function resolveServiceRowSection(row: ServiceRow): ServiceRowSection | null {
    // Happier's own listeners are one quiet group, closed by default, and never "running here".
    if (row.internal) return 'happier';
    // A package script is a launcher suggestion: its `available` state means "can start", not "running".
    if (row.scope === 'suggestion') return row.primaryAction?.kind === 'start' || row.primaryAction?.kind === 'run_script' ? 'ready' : null;
    if (row.status === 'running' || row.status === 'starting' || row.status === 'stale') {
        return row.scope === 'machine' ? 'elsewhere' : 'running';
    }
    return row.primaryAction?.kind === 'start' ? 'ready' : null;
}

/** The ranked rows split into non-empty sections, keeping the ranking order inside each. */
export function groupLocalServiceRowsBySection(rows: readonly ServiceRow[]): ReadonlyArray<Readonly<{
    section: ServiceRowSection;
    rows: readonly ServiceRow[];
}>> {
    const grouped = new Map<ServiceRowSection, ServiceRow[]>();
    for (const row of rows) {
        const section = resolveServiceRowSection(row);
        if (!section) continue;
        const list = grouped.get(section) ?? [];
        list.push(row);
        grouped.set(section, list);
    }
    return SECTION_ORDER
        .map((section) => ({ section, rows: grouped.get(section) ?? [] }))
        .filter((entry) => entry.rows.length > 0);
}

/** Actual listening user services; openable access and startable suggestions are not listener evidence. */
export function selectLocalServiceRunningCount(rows: readonly ServiceRow[]): number {
    const listeners = new Set<string>();
    for (const row of rows) {
        if (row.listeningListenerKey && !row.internal) listeners.add(row.listeningListenerKey);
    }
    return listeners.size;
}
