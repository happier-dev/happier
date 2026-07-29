import {
    LocalServicePreviewResourceV1Schema,
    type DaemonLocalServicePreviewOpenOrCreateRequestV1,
    type DaemonLocalServicePreviewOpenOrCreateResponseV1,
    type DaemonLocalServicePreviewRevokeRequestV1,
    type DaemonLocalServicePreviewRevokeResponseV1,
    type LocalServicePreviewResourceV1,
} from '@happier-dev/protocol';

import type { LocalServicePreviewSnapshot, LocalServicePreviewSnapshotRow } from './store';

export const LOCAL_SERVICE_PREVIEW_SNAPSHOT_ROUTE = '/local-services/preview/snapshot';

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

export type LocalServicePreviewSnapshotRequest = (
    path: string,
    init?: RequestInit,
) => Promise<Response>;

export type LocalServicePreviewSnapshotClientInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    signal?: AbortSignal;
    request?: LocalServicePreviewSnapshotRequest;
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

function stripResourceFields(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    return {
        previewId: value.previewId,
        sessionId: value.sessionId,
        machineId: value.machineId,
        owner: value.owner,
        target: value.target,
        initialPath: value.initialPath,
        display: value.display,
        originMode: value.originMode,
        ...(value.policy !== undefined ? { policy: value.policy } : {}),
        ...(value.browserTarget !== undefined ? { browserTarget: value.browserTarget } : {}),
    };
}

function readResource(value: unknown): LocalServicePreviewResourceV1 | null {
    if (!isRecord(value)) {
        return null;
    }
    const parsed = LocalServicePreviewResourceV1Schema.safeParse(stripResourceFields(value));
    return parsed.success ? parsed.data : null;
}

function readSnapshotRow(
    value: unknown,
    expectedMachineId: string,
): LocalServicePreviewSnapshotRow | null {
    if (!isRecord(value)) {
        return null;
    }
    const resource = readResource(value.resource) ?? readResource(value);
    if (!resource || resource.machineId !== expectedMachineId) {
        return null;
    }
    const previewId = readNonEmptyString(value.previewId) ?? resource.previewId;
    if (previewId !== resource.previewId) {
        return null;
    }
    return {
        previewId,
        resource,
        accessUrl: readNonEmptyString(value.accessUrl),
        expiresAt: readTimestampOrNull(value.expiresAt),
        diagnostics: readDiagnostics(value.diagnostics),
    };
}

function readRows(
    snapshot: Readonly<Record<string, unknown>>,
    expectedMachineId: string,
): readonly LocalServicePreviewSnapshotRow[] | null {
    const rawRows = Array.isArray(snapshot.previews)
        ? snapshot.previews
        : Array.isArray(snapshot.resources)
            ? snapshot.resources
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

function readResponseSnapshotPayload(value: unknown): unknown {
    if (!isRecord(value)) {
        return null;
    }
    return value.ok === true ? value.snapshot : value;
}

export async function fetchLocalServicePreviewSnapshot(
    input: LocalServicePreviewSnapshotClientInput,
): Promise<LocalServicePreviewSnapshotClientResult> {
    const request = input.request;
    if (!request) {
        return { ok: false, reason: 'unavailable' };
    }

    try {
        const response = await request(LOCAL_SERVICE_PREVIEW_SNAPSHOT_ROUTE, {
            method: 'POST',
            signal: input.signal,
        });
        if (response.status === 404 || response.status === 501) {
            return { ok: false, reason: 'unavailable' };
        }
        if (!response.ok) {
            return { ok: false, reason: 'request_failed' };
        }
        const payload = readResponseSnapshotPayload(await response.json());
        const snapshot = normalizeLocalServicePreviewSnapshotPayload(payload, input.machineId);
        return snapshot ? { ok: true, snapshot } : { ok: false, reason: 'invalid_response' };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}
