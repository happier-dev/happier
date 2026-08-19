import {
    type SessionAttentionStanding,
    type SessionFolderAssignment,
    type SessionOrganizationFolder,
    type SessionOrganizationLabel,
    type SessionOrganizationOrderEntry,
    type SessionOrganizationPin,
    type SessionOrganizationSnapshot,
    type SessionOrganizationTag,
    type SessionTagAssignment,
} from "@happier-dev/protocol";

import { parseSessionOrganizationDisplayEnvelope } from "./contentEnvelope";
import type {
    SessionAttentionStandingRecord,
    SessionOrganizationFolderRecord,
    SessionOrganizationLabelRecord,
    SessionOrganizationOrderEntryRecord,
    SessionOrganizationPinRecord,
    SessionOrganizationTagRecord,
} from "./types";

export function mapSessionOrganizationPin(row: SessionOrganizationPinRecord): SessionOrganizationPin {
    return {
        sessionId: row.sessionId,
        sortKey: row.sortKey,
        pinnedAt: row.pinnedAt.getTime(),
    };
}

export function mapSessionAttentionStanding(row: SessionAttentionStandingRecord): SessionAttentionStanding {
    return {
        sessionId: row.sessionId,
        standing: row.standing,
        updatedAt: row.updatedAt.getTime(),
    };
}

export function mapSessionOrganizationFolder(
    row: SessionOrganizationFolderRecord,
    parentFolderId: string | null = null,
): SessionOrganizationFolder {
    return {
        folderId: row.id,
        folderKey: row.folderKey,
        parentFolderId,
        parentFolderKey: row.parentKey,
        sortKey: row.sortKey,
        display: parseSessionOrganizationDisplayEnvelope(row.displayDbValue),
        archivedAt: row.archivedAt?.getTime() ?? null,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
}

export function mapSessionOrganizationTag(row: SessionOrganizationTagRecord): SessionOrganizationTag {
    return {
        tagId: row.id,
        tagKey: row.tagKey,
        sortKey: row.sortKey,
        display: parseSessionOrganizationDisplayEnvelope(row.displayDbValue),
        archivedAt: row.archivedAt?.getTime() ?? null,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
}

export function mapSessionOrganizationOrderEntry(row: SessionOrganizationOrderEntryRecord): SessionOrganizationOrderEntry {
    return {
        scopeKind: row.scopeKind as SessionOrganizationOrderEntry["scopeKind"],
        scopeKey: row.scopeKey,
        itemKind: row.itemKind as SessionOrganizationOrderEntry["itemKind"],
        itemKey: row.itemKey,
        sortKey: row.sortKey,
    };
}

export function mapSessionOrganizationLabel(row: SessionOrganizationLabelRecord): SessionOrganizationLabel {
    return {
        labelKind: row.labelKind as SessionOrganizationLabel["labelKind"],
        scopeKey: row.scopeKey,
        display: parseSessionOrganizationDisplayEnvelope(row.displayDbValue),
        archivedAt: row.archivedAt?.getTime() ?? null,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
}

export function createSessionOrganizationSnapshot(params: Readonly<{
    version: number;
    pins: SessionOrganizationPin[];
    folders: SessionOrganizationFolder[];
    folderAssignments: SessionFolderAssignment[];
    tags: SessionOrganizationTag[];
    tagAssignments: SessionTagAssignment[];
    orderEntries: SessionOrganizationOrderEntry[];
    labels: SessionOrganizationLabel[];
    attentionStandings?: SessionAttentionStanding[];
}>): SessionOrganizationSnapshot {
    return {
        schemaVersion: 1,
        version: params.version,
        pins: params.pins,
        folders: params.folders,
        folderAssignments: params.folderAssignments,
        tags: params.tags,
        tagAssignments: params.tagAssignments,
        orderEntries: params.orderEntries,
        labels: params.labels,
        ...(params.attentionStandings ? { attentionStandings: params.attentionStandings } : {}),
    };
}
