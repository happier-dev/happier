import {
    type SessionOrganizationContentEnvelope,
    type SessionOrganizationDisplayState,
    type SessionFolderAssignment,
    type SessionOrganizationFolder,
    type SessionOrganizationLabel,
    type SessionOrganizationOrderEntry,
    type SessionOrganizationPin,
    type SessionOrganizationSnapshot,
    type SessionOrganizationTag,
    type SessionTagAssignment,
} from "@happier-dev/protocol";

import type { EffectiveAccountEncryptionMode } from "@/app/encryption/accountEncryptionMode";
import { parseSessionOrganizationDisplayEnvelope } from "./contentEnvelope";
import type {
    SessionOrganizationFolderRecord,
    SessionOrganizationLabelRecord,
    SessionOrganizationOrderEntryRecord,
    SessionOrganizationPinRecord,
    SessionOrganizationTagRecord,
} from "./types";

type SessionOrganizationDisplayProjection = Readonly<{
    display: SessionOrganizationContentEnvelope | null;
    displayState?: SessionOrganizationDisplayState;
}>;

function projectSessionOrganizationDisplay(
    value: string | null,
    expectedMode?: EffectiveAccountEncryptionMode | null,
): SessionOrganizationDisplayProjection {
    const parsed = parseSessionOrganizationDisplayEnvelope(value);
    if (parsed.status === "unreadable") {
        return {
            display: null,
            displayState: {
                status: "unavailable",
                reason: parsed.reason,
            },
        };
    }
    if (
        parsed.display !== null
        && expectedMode !== undefined
        && (
            expectedMode === null
            || parsed.display.t !== (
                expectedMode === "plain" ? "plain" : "encrypted"
            )
        )
    ) {
        return {
            display: null,
            displayState: {
                status: "unavailable",
                reason: "storage_mode_mismatch",
            },
        };
    }
    return { display: parsed.display };
}

export function mapSessionOrganizationPin(row: SessionOrganizationPinRecord): SessionOrganizationPin {
    return {
        sessionId: row.sessionId,
        sortKey: row.sortKey,
        pinnedAt: row.pinnedAt.getTime(),
    };
}

export function mapSessionOrganizationFolder(
    row: SessionOrganizationFolderRecord,
    parentFolderId: string | null = null,
    expectedMode?: EffectiveAccountEncryptionMode | null,
): SessionOrganizationFolder {
    return {
        folderId: row.id,
        folderKey: row.folderKey,
        parentFolderId,
        parentFolderKey: row.parentKey,
        sortKey: row.sortKey,
        ...projectSessionOrganizationDisplay(
            row.displayDbValue,
            expectedMode,
        ),
        archivedAt: row.archivedAt?.getTime() ?? null,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
}

export function mapSessionOrganizationTag(
    row: SessionOrganizationTagRecord,
    expectedMode?: EffectiveAccountEncryptionMode | null,
): SessionOrganizationTag {
    return {
        tagId: row.id,
        tagKey: row.tagKey,
        sortKey: row.sortKey,
        ...projectSessionOrganizationDisplay(
            row.displayDbValue,
            expectedMode,
        ),
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

export function mapSessionOrganizationLabel(
    row: SessionOrganizationLabelRecord,
    expectedMode?: EffectiveAccountEncryptionMode | null,
): SessionOrganizationLabel {
    return {
        labelKind: row.labelKind as SessionOrganizationLabel["labelKind"],
        scopeKey: row.scopeKey,
        ...projectSessionOrganizationDisplay(
            row.displayDbValue,
            expectedMode,
        ),
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
    };
}
