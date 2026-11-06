import { type SessionAttentionStanding } from '@happier-dev/protocol/sessions/organization/standings';
import type { SessionOrganizationSessionAppearance } from '@happier-dev/protocol/sessions/organization/appearances';
import { type SessionOrganizationContentEnvelope, type SessionOrganizationDisplayState } from '@happier-dev/protocol/sessions/organization/content';
import { type SessionFolderAssignment, type SessionOrganizationFolder } from '@happier-dev/protocol/sessions/organization/folders';
import { type SessionOrganizationLabel, type SessionOrganizationOrderEntry } from '@happier-dev/protocol/sessions/organization/ordering';
import { type SessionOrganizationPin } from '@happier-dev/protocol/sessions/organization/pins';
import { type SessionOrganizationSnapshot } from '@happier-dev/protocol/sessions/organization/snapshot';
import { type SessionOrganizationTag, type SessionTagAssignment } from '@happier-dev/protocol/sessions/organization/tags';

import type { EffectiveAccountEncryptionMode } from "@/app/encryption/accountEncryptionMode";
import { parseSessionOrganizationDisplayEnvelope } from "./contentEnvelope";
import type {
    SessionAppearanceRecord,
    SessionAttentionStandingRecord,
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
        listPinned: row.listPinned,
        railPinned: row.railPinned,
    };
}

export function mapSessionAttentionStanding(row: SessionAttentionStandingRecord): SessionAttentionStanding {
    return {
        sessionId: row.sessionId,
        standing: row.standing,
        ...(row.remindAt ? { remindAt: row.remindAt.getTime() } : {}),
        updatedAt: row.updatedAt.getTime(),
    };
}

export function mapSessionAppearance(
    row: SessionAppearanceRecord,
    expectedMode?: EffectiveAccountEncryptionMode | null,
): SessionOrganizationSessionAppearance {
    return {
        sessionId: row.sessionId,
        ...projectSessionOrganizationDisplay(row.displayDbValue, expectedMode),
        updatedAt: row.updatedAt.getTime(),
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
    attentionStandings?: SessionAttentionStanding[];
    sessionAppearances?: SessionOrganizationSessionAppearance[];
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
        // Omitted unless the request asked for standings: an absent array means "not fetched",
        // which every reader must be able to tell apart from "the account has none".
        ...(params.attentionStandings ? { attentionStandings: params.attentionStandings } : {}),
        ...(params.sessionAppearances ? { sessionAppearances: params.sessionAppearances } : {}),
    };
}
