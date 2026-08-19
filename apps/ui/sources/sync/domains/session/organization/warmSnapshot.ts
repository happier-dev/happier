import { SESSION_ORGANIZATION_SNAPSHOT_VERSION, type SessionOrganizationSnapshot } from '@happier-dev/protocol';

import type { SessionOrganizationProjection } from './types';

/**
 * Rebuilds the organization snapshot that the store currently holds for one server.
 *
 * The session list cannot paint pinned rows, folders, manual order, or the sessions the user
 * keeps in Needs attention without organization state, so a boot that has none must either
 * wait for the round trip or show a list it will immediately have to rearrange. Projecting the
 * live state back into the canonical snapshot shape is what lets the warm cache persist it: the
 * same value the server sends, described by the same protocol schema, applied on the next boot
 * through the one owner of organization state (`applySessionOrganizationSnapshot`).
 *
 * Returns `null` whenever the projection is not a complete snapshot the protocol can express —
 * no observed version yet, or a schema version this build does not speak. Callers persist
 * nothing in that case rather than writing a shape the next boot would have to guess about.
 *
 * Sessions the projection knows are explicitly *unassigned* are omitted: the protocol models
 * assignments, not sessions, and a full snapshot answers "unassigned" by absence. That matches
 * what a cold boot already reconstructs from the server's own response.
 *
 * The result is assembled from already-typed state rather than validated here; this runs on the
 * foreground fetch path, and the schema check belongs where the bytes are untrusted — on the
 * warm-cache read.
 */
export function buildSessionOrganizationSnapshotFromProjection(
    projection: SessionOrganizationProjection,
): SessionOrganizationSnapshot | null {
    if (projection.version === null) return null;
    if (projection.schemaVersion !== SESSION_ORGANIZATION_SNAPSHOT_VERSION) return null;

    return {
        schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION,
        version: projection.version,
        pins: projection.pinnedSessionIds
            .map((sessionId) => projection.pinsBySessionId[sessionId])
            .filter((pin) => pin !== undefined),
        folders: Object.values(projection.foldersById),
        folderAssignments: Object.entries(projection.folderAssignmentsBySessionId)
            .flatMap(([sessionId, folderId]) => (folderId ? [{ sessionId, folderId }] : [])),
        tags: Object.values(projection.tagsById),
        tagAssignments: Object.entries(projection.tagAssignmentsBySessionId)
            .map(([sessionId, tagIds]) => ({ sessionId, tagIds: [...tagIds] })),
        orderEntries: Object.values(projection.orderEntriesByScopeKey).flatMap((entries) => [...entries]),
        labels: Object.values(projection.labelsByLabelKey),
        attentionStandings: Object.values(projection.attentionStandingsBySessionId),
    };
}
