import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';

import {
    isLocalServiceRowAttributedToSession,
    resolveLocalServiceLaunchTargetPortLabel,
    resolveLocalServiceOpenableTarget,
} from '@/sync/domains/local/services/presentation';
import type { TranslationKey } from '@/text/i18n';

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
    sourceLabel: TranslationKey; // translation key for the source label
    status: ServiceRowStatus;
    reasonCode: string | null; // raw code for OWNER-COPY (NEVER rendered raw)
    primaryAction:
        | Readonly<{ kind: 'open'; openTarget: LocalServiceLaunchTarget }>
        | Readonly<{ kind: 'start'; target: LocalServiceLaunchTarget }>
        | null; // null ⇒ inert row (quiet caption, no headline action)
    terminateIdentityConfidence?: 'full' | 'pid_only' | null;
    /** The underlying launch target, carried for per-row secondary affordances (e.g. public preview). */
    target: LocalServiceLaunchTarget;
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
    // Openability is judged purely from the service launch target (browserTarget present
    // and not unavailable). Any openable target — loopback `open`, exposure `open_preview`,
    // or a managed running target — surfaces ONE open action; the open target is carried,
    // never built here.
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
    return target.id.startsWith('inventory:') ? target.id.slice('inventory:'.length) : null;
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
    const rows = input.launchTargets.map((target, index): { row: ServiceRow; index: number } => {
        const inventoryId = inventoryIdFromTarget(target);
        const inventoryRow = inventoryId ? inventoryById.get(inventoryId) : undefined;
        const status = resolveStatus(target);
        const row: ServiceRow = {
            id: target.id,
            scope: resolveBand(target, input.sessionId, input.scope),
            title: target.title,
            portLabel: resolveLocalServiceLaunchTargetPortLabel(target),
            scheme: readScheme(inventoryRow),
            host: readHost(inventoryRow),
            workspaceLabel: readWorkspaceLabel(inventoryRow) ?? readString(target.cwd),
            processLabel: readProcessLabel(inventoryRow, target),
            sourceLabel: SOURCE_LABEL_KEYS[target.source],
            status,
            reasonCode: target.unavailableReason ?? null,
            primaryAction: resolvePrimaryAction(target),
            terminateIdentityConfidence: readTerminateIdentityConfidence(inventoryRow, target),
            target,
        };
        return { row, index };
    });

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
