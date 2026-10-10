import {
    buildSessionOrganizationLabelKey,
    buildSessionOrganizationOrderScopeKey,
    buildSessionOrganizationSessionKey,
    buildSessionOrganizationServerKey,
} from './keys';
import type {
    NormalizedSessionOrganizationState,
    SessionOrganizationProjection,
    UiSessionOrganizationFolder,
    UiSessionOrganizationLabel,
    UiSessionOrganizationTag,
} from './types';
import type {
    SessionAttentionStanding,
    SessionOrganizationOrderEntry,
    SessionOrganizationPin,
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
    const foldersById: Record<string, UiSessionOrganizationFolder> = {};
    const folderAssignmentsBySessionId: Record<string, string | null> = {};
    const tagsById: Record<string, UiSessionOrganizationTag> = {};
    const tagAssignmentsBySessionId: Record<string, readonly string[]> = {};
    const attentionStandingsBySessionId: Record<string, SessionAttentionStanding> = {};
    const orderEntriesByScopeKey: Record<string, readonly SessionOrganizationOrderEntry[]> = {};
    const labelsByLabelKey: Record<string, UiSessionOrganizationLabel> = {};

    for (const [key, pin] of Object.entries(state.pinsBySessionKey)) {
        if (key === buildSessionOrganizationSessionKey(serverId, pin.sessionId)) {
            pinsBySessionId[pin.sessionId] = pin;
        }
    }
    for (const [key, folder] of Object.entries(state.foldersByFolderKey)) {
        if (key === buildSessionOrganizationServerKey(serverId, folder.folderId)) {
            foldersById[folder.folderId] = folder;
        }
    }
    for (const [key, assignment] of Object.entries(state.folderAssignmentsBySessionKey)) {
        if (key === buildSessionOrganizationSessionKey(serverId, assignment.sessionId)) {
            folderAssignmentsBySessionId[assignment.sessionId] = assignment.folderId;
        }
    }
    for (const [key, tag] of Object.entries(state.tagsByTagKey)) {
        if (key === buildSessionOrganizationServerKey(serverId, tag.tagId)) {
            tagsById[tag.tagId] = tag;
        }
    }
    for (const [key, assignment] of Object.entries(state.tagAssignmentsBySessionKey)) {
        if (key === buildSessionOrganizationSessionKey(serverId, assignment.sessionId)) {
            tagAssignmentsBySessionId[assignment.sessionId] = assignment.tagIds;
        }
    }
    for (const [key, standing] of Object.entries(state.attentionStandingsBySessionKey)) {
        if (key === buildSessionOrganizationSessionKey(serverId, standing.sessionId)) {
            attentionStandingsBySessionId[standing.sessionId] = standing;
        }
    }
    for (const entries of Object.values(state.orderEntriesByScopeKey)) {
        const firstEntry = entries[0];
        if (!firstEntry) continue;
        const exactKey = buildSessionOrganizationOrderScopeKey({
            serverId,
            scopeKind: firstEntry.scopeKind,
            scopeKey: firstEntry.scopeKey,
        });
        if (state.orderEntriesByScopeKey[exactKey] === entries) {
            orderEntriesByScopeKey[exactKey] = entries;
        }
    }
    for (const label of Object.values(state.labelsByLabelKey)) {
        const exactKey = buildSessionOrganizationLabelKey({
            serverId,
            labelKind: label.labelKind,
            scopeKey: label.scopeKey,
        });
        if (state.labelsByLabelKey[exactKey] === label) {
            labelsByLabelKey[exactKey] = label;
        }
    }

    const sortedPins = Object.values(pinsBySessionId)
        .sort((a, b) => compareNullableSortKey(a.sortKey, b.sortKey) || a.pinnedAt - b.pinnedAt || a.sessionId.localeCompare(b.sessionId))
        .map((pin) => pin.sessionId);
    const pinnedOrderKey = buildSessionOrganizationOrderScopeKey({ serverId, scopeKind: 'pinned', scopeKey: 'pins' });
    const orderedPinSessionIds = [...new Set([
        ...(orderEntriesByScopeKey[pinnedOrderKey] ?? [])
            .filter(entry => entry.itemKind === 'session' && pinsBySessionId[entry.itemKey] !== undefined)
            .sort((a, b) => compareNullableSortKey(a.sortKey, b.sortKey) || a.itemKey.localeCompare(b.itemKey))
            .map(entry => entry.itemKey),
        ...sortedPins,
    ])];

    return {
        schemaVersion: state.schemaVersionByServerId[serverId] ?? null,
        version: state.snapshotVersionByServerId[serverId] ?? null,
        orderedPinSessionIds,
        pinnedSessionIds: orderedPinSessionIds.filter(sessionId => pinsBySessionId[sessionId]?.listPinned === true),
        railPinnedSessionIds: orderedPinSessionIds.filter(sessionId => pinsBySessionId[sessionId]?.railPinned === true),
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

/**
 * Qualifies and deduplicates a mounted-Home projection set while leaving the
 * actual projection cache/selector with its canonical store owner.
 */
export function buildSessionOrganizationProjections(
    serverIds: readonly string[],
    readProjection: (serverId: string) => SessionOrganizationProjection,
): Readonly<Record<string, SessionOrganizationProjection>> {
    const result: Record<string, SessionOrganizationProjection> = {};
    for (const rawServerId of serverIds) {
        const serverId = String(rawServerId ?? '').trim();
        if (!serverId || Object.prototype.hasOwnProperty.call(result, serverId)) continue;
        result[serverId] = readProjection(serverId);
    }
    return result;
}
