import {
    buildSessionOrganizationLabelKey,
    buildSessionOrganizationOrderScopeKey,
    readSessionOrganizationServerScopedId,
} from './keys';
import type { NormalizedSessionOrganizationState, SessionOrganizationProjection } from './types';
import type {
    SessionAttentionStanding,
    SessionOrganizationFolder,
    SessionOrganizationLabel,
    SessionOrganizationOrderEntry,
    SessionOrganizationPin,
    SessionOrganizationTag,
} from '@happier-dev/protocol';

function compareNullableSortKey(a: string | null, b: string | null): number {
    if (a && b) return a.localeCompare(b);
    if (a) return -1;
    if (b) return 1;
    return 0;
}

export function buildSessionOrganizationProjection(
    state: NormalizedSessionOrganizationState,
    serverId: string,
): SessionOrganizationProjection {
    const pinsBySessionId: Record<string, SessionOrganizationPin> = {};
    const foldersById: Record<string, SessionOrganizationFolder> = {};
    const folderAssignmentsBySessionId: Record<string, string | null> = {};
    const tagsById: Record<string, SessionOrganizationTag> = {};
    const tagAssignmentsBySessionId: Record<string, readonly string[]> = {};
    const attentionStandingsBySessionId: Record<string, SessionAttentionStanding> = {};
    const orderEntriesByScopeKey: Record<string, readonly SessionOrganizationOrderEntry[]> = {};
    const labelsByLabelKey: Record<string, SessionOrganizationLabel> = {};

    for (const [key, pin] of Object.entries(state.pinsBySessionKey)) {
        if (readSessionOrganizationServerScopedId(key, serverId) === pin.sessionId) {
            pinsBySessionId[pin.sessionId] = pin;
        }
    }
    for (const [key, folder] of Object.entries(state.foldersByFolderKey)) {
        if (readSessionOrganizationServerScopedId(key, serverId) === folder.folderId) {
            foldersById[folder.folderId] = folder;
        }
    }
    for (const [key, folderId] of Object.entries(state.folderAssignmentsBySessionKey)) {
        const sessionId = readSessionOrganizationServerScopedId(key, serverId);
        if (sessionId) {
            folderAssignmentsBySessionId[sessionId] = folderId;
        }
    }
    for (const [key, tag] of Object.entries(state.tagsByTagKey)) {
        if (readSessionOrganizationServerScopedId(key, serverId) === tag.tagId) {
            tagsById[tag.tagId] = tag;
        }
    }
    for (const [key, tagIds] of Object.entries(state.tagAssignmentsBySessionKey)) {
        const sessionId = readSessionOrganizationServerScopedId(key, serverId);
        if (sessionId) {
            tagAssignmentsBySessionId[sessionId] = tagIds;
        }
    }
    for (const [key, standing] of Object.entries(state.attentionStandingsBySessionKey)) {
        if (readSessionOrganizationServerScopedId(key, serverId) === standing.sessionId) {
            attentionStandingsBySessionId[standing.sessionId] = standing;
        }
    }
    const serverPrefix = `${String(serverId).trim()}:`;
    for (const [key, entries] of Object.entries(state.orderEntriesByScopeKey)) {
        if (key.startsWith(serverPrefix)) {
            const firstEntry = entries[0];
            orderEntriesByScopeKey[firstEntry
                ? buildSessionOrganizationOrderScopeKey({ serverId, scopeKind: firstEntry.scopeKind, scopeKey: firstEntry.scopeKey })
                : key] = entries;
        }
    }
    for (const [key, label] of Object.entries(state.labelsByLabelKey)) {
        if (key.startsWith(serverPrefix)) {
            labelsByLabelKey[buildSessionOrganizationLabelKey({ serverId, labelKind: label.labelKind, scopeKey: label.scopeKey })] = label;
        }
    }

    const pinnedSessionIds = Object.values(pinsBySessionId)
        .sort((a, b) => compareNullableSortKey(a.sortKey, b.sortKey) || a.pinnedAt - b.pinnedAt || a.sessionId.localeCompare(b.sessionId))
        .map((pin) => pin.sessionId);

    return {
        schemaVersion: state.schemaVersionByServerId[serverId] ?? null,
        version: state.snapshotVersionByServerId[serverId] ?? null,
        pinnedSessionIds,
        pinsBySessionId,
        foldersById,
        folderAssignmentsBySessionId,
        tagsById,
        tagAssignmentsBySessionId,
        attentionStandingsBySessionId,
        orderEntriesByScopeKey,
        labelsByLabelKey,
    };
}
