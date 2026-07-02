import { t } from '@/text';
import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';
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
        t('localServices.inventory.confidence', { value: row.confidence }),
        ...diagnostics,
    ].filter((line): line is string => Boolean(line));
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

export function resolveManagedFactLines(row: ManagedLocalServiceStoreRow): readonly string[] {
    const diagnostics = readLocalServiceDiagnostics(row.diagnostics)
        .map((diagnostic) => t('localServices.managed.diagnostic', { value: diagnostic.code }));

    return [
        row.ownerLabel ? t('localServices.managed.owner', { value: row.ownerLabel }) : null,
        row.routeName ? t('localServices.managed.route', { value: row.routeName }) : null,
        t('localServices.managed.launchMode', { value: row.launchMode }),
        row.url ? t('localServices.managed.url', { value: row.url }) : null,
        row.inventoryId ? t('localServices.managed.inventory', { value: row.inventoryId }) : null,
        ...diagnostics,
    ].filter((line): line is string => Boolean(line));
}
