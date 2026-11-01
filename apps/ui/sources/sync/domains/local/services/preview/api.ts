import {
    LocalServicePreviewSnapshotRowV1Schema,
    type DaemonLocalServicePreviewOpenOrCreateRequestV1,
    type DaemonLocalServicePreviewOpenOrCreateResponseV1,
    type DaemonLocalServicePreviewRevokeRequestV1,
    type DaemonLocalServicePreviewRevokeResponseV1,
} from '@happier-dev/protocol/local/services/preview/v1';

import type { LocalServicePreviewSnapshot, LocalServicePreviewSnapshotRow } from './store';

export type LocalServicePreviewLifecycleFailureReason =
    | 'unavailable'
    | 'request_failed'
    | 'invalid_response'
    | `refused:${string}`;

export type LocalServicePreviewOpenOrCreateClientInput = Readonly<{
    request: DaemonLocalServicePreviewOpenOrCreateRequestV1;
    serverId?: string | null;
    signal?: AbortSignal;
}>;

export type LocalServicePreviewRevokeClientInput = Readonly<{
    request: DaemonLocalServicePreviewRevokeRequestV1;
    serverId?: string | null;
    signal?: AbortSignal;
}>;

export type LocalServicePreviewOpenOrCreateClientResult =
    | Readonly<{ ok: true; response: DaemonLocalServicePreviewOpenOrCreateResponseV1 }>
    | Readonly<{ ok: false; reason: LocalServicePreviewLifecycleFailureReason }>;

export type LocalServicePreviewRevokeClientResult =
    | Readonly<{ ok: true; response: DaemonLocalServicePreviewRevokeResponseV1 }>
    | Readonly<{ ok: false; reason: LocalServicePreviewLifecycleFailureReason }>;

export type LocalServicePreviewSnapshotClientInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    accountId?: string | null;
    signal?: AbortSignal;
}>;

export type LocalServicePreviewSnapshotClientResult =
    | Readonly<{ ok: true; snapshot: LocalServicePreviewSnapshot }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'request_failed' | 'invalid_response' }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readTimestampOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readDiagnostics(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [];
}

function readRefreshState(value: unknown): LocalServicePreviewSnapshot['refreshState'] | null {
    return value === 'idle' || value === 'refreshing' || value === 'error' ? value : null;
}

function readSnapshotRow(
    value: unknown,
    expectedMachineId: string,
): LocalServicePreviewSnapshotRow | null {
    const parsed = LocalServicePreviewSnapshotRowV1Schema.safeParse(value);
    if (!parsed.success || parsed.data.resource.machineId !== expectedMachineId
        || parsed.data.previewId !== parsed.data.resource.previewId) {
        return null;
    }
    return parsed.data;
}

function readRows(
    snapshot: Readonly<Record<string, unknown>>,
    expectedMachineId: string,
): readonly LocalServicePreviewSnapshotRow[] | null {
    const rawRows = Array.isArray(snapshot.previews)
        ? snapshot.previews
        : null;
    if (!rawRows) {
        return null;
    }

    return rawRows
        .map((row) => readSnapshotRow(row, expectedMachineId))
        .filter((row): row is LocalServicePreviewSnapshotRow => Boolean(row));
}

export function normalizeLocalServicePreviewSnapshotPayload(
    value: unknown,
    expectedMachineId: string,
): LocalServicePreviewSnapshot | null {
    if (!isRecord(value)) {
        return null;
    }
    const machineId = readNonEmptyString(value.machineId);
    if (machineId && machineId !== expectedMachineId) {
        return null;
    }
    const generatedAt = readTimestampOrNull(value.generatedAt);
    const refreshState = readRefreshState(value.refreshState);
    if (generatedAt === null || !refreshState) {
        return null;
    }
    const previews = readRows(value, expectedMachineId);
    if (!previews) {
        return null;
    }
    return {
        generatedAt,
        refreshState,
        previews,
        diagnostics: readDiagnostics(value.diagnostics),
    };
}
