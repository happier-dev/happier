import {
    LocalServiceManagedRuntimeSnapshotV1Schema,
    type LocalServiceManagedRuntimeSnapshotV1,
} from '@happier-dev/protocol';

import type { ManagedLocalServicesSnapshot } from './store';

export type LocalServiceManagedSnapshotClientInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    sessionId?: string | null;
    signal?: AbortSignal;
}>;

export type LocalServiceManagedSnapshotClientResult =
    | Readonly<{ ok: true; snapshot: ManagedLocalServicesSnapshot }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'request_failed' | 'invalid_response' }>;

export function managedSnapshotFromProtocolSnapshot(
    snapshot: LocalServiceManagedRuntimeSnapshotV1,
): ManagedLocalServicesSnapshot {
    return {
        machineId: snapshot.machineId,
        generatedAt: snapshot.generatedAt,
        refreshState: snapshot.refreshState,
        rows: snapshot.rows.map((row) => ({
            id: row.id,
            ownerLabel: row.owner.kind === 'plugin'
                ? row.owner.pluginId
                : row.owner.kind === 'session'
                    ? row.owner.sessionId
                    : row.owner.workspaceId,
            phase: row.phase,
            launchMode: row.launchMode,
            ...(row.routeName ? { routeName: row.routeName } : {}),
            ...(row.inventoryId ? { inventoryId: row.inventoryId } : {}),
            ...(typeof row.port === 'number' ? { port: row.port } : {}),
            ...(row.url ? { url: row.url } : {}),
            supportedActions: row.supportedActions,
            diagnostics: row.diagnostics,
            updatedAt: snapshot.generatedAt,
        })),
        diagnostics: snapshot.diagnostics,
    };
}

export function parseLocalServiceManagedSnapshot(value: unknown): ManagedLocalServicesSnapshot {
    return managedSnapshotFromProtocolSnapshot(LocalServiceManagedRuntimeSnapshotV1Schema.parse(value));
}
