import {
    DaemonLocalServiceLauncherSnapshotRequestV1Schema,
    LocalServiceLauncherSnapshotV1Schema,
} from '@happier-dev/protocol';

import type { LocalServiceLauncherSnapshot } from './types';

export const LOCAL_SERVICE_LAUNCHER_SNAPSHOT_ROUTE = '/local-services/launcher/snapshot';

export type LocalServiceLauncherSnapshotRequest = (
    path: string,
    init?: RequestInit,
) => Promise<Response>;

export type LocalServiceLauncherSnapshotClientInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    sessionId?: string | null;
    scope?: 'workspace' | 'machine' | null;
    workspaceRoot?: string | null;
    signal?: AbortSignal;
    request?: LocalServiceLauncherSnapshotRequest;
}>;

export type LocalServiceLauncherSnapshotClientResult =
    | Readonly<{ ok: true; snapshot: LocalServiceLauncherSnapshot }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'request_failed' | 'invalid_response' }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readResponseSnapshotPayload(value: unknown): unknown {
    if (!isRecord(value)) {
        return null;
    }
    return value.ok === true ? value.snapshot : value;
}

export function parseLocalServiceLauncherSnapshot(value: unknown): LocalServiceLauncherSnapshot {
    return LocalServiceLauncherSnapshotV1Schema.parse(value);
}

export async function fetchLocalServiceLauncherSnapshot(
    input: LocalServiceLauncherSnapshotClientInput,
): Promise<LocalServiceLauncherSnapshotClientResult> {
    const request = input.request;
    if (!request) {
        return { ok: false, reason: 'unavailable' };
    }

    try {
        // Structural parity with the machine-RPC transport: the snapshot request carries the
        // same session/scope/workspaceRoot scoping payload (one schema, no drifting second
        // transport). ~-expansion + Windows-safe containment happen at the daemon boundary.
        const payload = DaemonLocalServiceLauncherSnapshotRequestV1Schema.parse({
            machineId: input.machineId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.scope ? { scope: input.scope } : {}),
            ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
        });
        const response = await request(LOCAL_SERVICE_LAUNCHER_SNAPSHOT_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: input.signal,
        });
        if (response.status === 404 || response.status === 501) {
            return { ok: false, reason: 'unavailable' };
        }
        if (!response.ok) {
            return { ok: false, reason: 'request_failed' };
        }
        const parsed = LocalServiceLauncherSnapshotV1Schema.safeParse(
            readResponseSnapshotPayload(await response.json()),
        );
        if (!parsed.success || parsed.data.machineId !== input.machineId) {
            return { ok: false, reason: 'invalid_response' };
        }
        return { ok: true, snapshot: parsed.data };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}
