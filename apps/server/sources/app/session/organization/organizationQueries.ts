import type { Prisma } from "@prisma/client";
import {
    type SessionOrganizationSnapshotRequest,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createV2SessionListVisibilityWhere } from "@/app/api/routes/session/v2SessionListRows";
import {
    createSessionOrganizationSnapshot,
    mapSessionOrganizationFolder,
    mapSessionOrganizationLabel,
    mapSessionOrganizationOrderEntry,
    mapSessionOrganizationPin,
    mapSessionOrganizationTag,
} from "./organizationSnapshot";
import { hashSessionOrganizationKey } from "./hashKeys";
import { filterValidSessionOrganizationOrderEntries } from "./organizationOrderValidation";
import { createVisibleUnarchivedOrganizationSessionWhere } from "./sessionVisibility";

export type SessionFolderAssignmentRecord = Readonly<{
    sessionId: string;
    folderId: string;
}>;

export async function fetchSessionOrganizationPinnedSessionIds(accountId: string): Promise<string[]> {
    const pins = await db.sessionPin.findMany({
        where: {
            accountId,
            session: createVisibleUnarchivedOrganizationSessionWhere(accountId),
        },
        orderBy: [{ sortKey: "asc" }, { pinnedAt: "asc" }],
        select: { sessionId: true, sortKey: true, pinnedAt: true },
    });
    return pins.map((pin) => pin.sessionId);
}

export async function fetchSessionFolderAssignmentsForSessions(params: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
}>): Promise<SessionFolderAssignmentRecord[]> {
    if (params.sessionIds.length === 0) return [];

    return await db.sessionFolderAssignment.findMany({
        where: {
            accountId: params.accountId,
            sessionId: { in: [...params.sessionIds] },
            session: createV2SessionListVisibilityWhere({ userId: params.accountId }),
        },
        orderBy: { sessionId: "asc" },
        select: {
            sessionId: true,
            folderId: true,
        },
    });
}

export function createSessionFolderAssignmentSessionWhere(params: Readonly<{
    accountId: string;
    folderIds: readonly string[];
    archived: boolean;
    cursorWhere?: Prisma.SessionWhereInput;
}>): Prisma.SessionWhereInput {
    return {
        archivedAt: params.archived ? { not: null } : null,
        ...(params.cursorWhere ?? {}),
        sessionFolderAssignments: {
            some: {
                accountId: params.accountId,
                folderId: { in: [...params.folderIds] },
            },
        },
    };
}

function createFolderAssignmentWhere(params: Readonly<{
    accountId: string;
    request: SessionOrganizationSnapshotRequest;
}>): Prisma.SessionFolderAssignmentWhereInput {
    const sessionIds = params.request.assignmentSessionIds;
    const folderIds = params.request.folderIds;
    const scopedPredicates: Prisma.SessionFolderAssignmentWhereInput[] = [
        ...(sessionIds.length > 0 ? [{ sessionId: { in: [...sessionIds] } }] : []),
        ...(folderIds.length > 0 ? [{ folderId: { in: [...folderIds] } }] : []),
    ];
    return {
        accountId: params.accountId,
        session: createV2SessionListVisibilityWhere({ userId: params.accountId }),
        ...(params.request.includeAllFolderAssignments
            ? {}
            : scopedPredicates.length > 0
                ? { OR: scopedPredicates }
                : { sessionId: { in: [] } }),
    };
}

function createTagAssignmentWhere(params: Readonly<{
    accountId: string;
    request: SessionOrganizationSnapshotRequest;
}>): Prisma.SessionTagAssignmentWhereInput {
    const sessionIds = params.request.assignmentSessionIds;
    const tagIds = params.request.tagIds;
    const scopedPredicates: Prisma.SessionTagAssignmentWhereInput[] = [
        ...(sessionIds.length > 0 ? [{ sessionId: { in: [...sessionIds] } }] : []),
        ...(tagIds.length > 0 ? [{ tagId: { in: [...tagIds] } }] : []),
    ];
    return {
        accountId: params.accountId,
        session: createV2SessionListVisibilityWhere({ userId: params.accountId }),
        ...(params.request.includeAllTagAssignments
            ? {}
            : scopedPredicates.length > 0
                ? { OR: scopedPredicates }
                : { sessionId: { in: [] } }),
    };
}

export async function fetchSessionOrganizationSnapshot(params: Readonly<{
    accountId: string;
    request: SessionOrganizationSnapshotRequest;
}>) {
    const [
        checkpoint,
        pins,
        folders,
        folderAssignments,
        tags,
        tagAssignments,
        orderEntries,
        labels,
    ] = await Promise.all([
        db.sessionOrganizationCheckpoint.findUnique({
            where: { accountId: params.accountId },
            select: { version: true },
        }),
        db.sessionPin.findMany({
            where: {
                accountId: params.accountId,
                session: createVisibleUnarchivedOrganizationSessionWhere(params.accountId),
            },
            orderBy: [{ sortKey: "asc" }, { pinnedAt: "asc" }],
            select: { sessionId: true, sortKey: true, pinnedAt: true },
        }),
        params.request.includeFolders
            ? db.sessionOrganizationFolder.findMany({
                where: { accountId: params.accountId, archivedAt: null },
                orderBy: [{ parentHash: "asc" }, { sortKey: "asc" }, { createdAt: "asc" }],
                select: {
                    id: true,
                    folderKey: true,
                    parentKey: true,
                    sortKey: true,
                    displayDbValue: true,
                    archivedAt: true,
                    createdAt: true,
                    updatedAt: true,
                },
            })
            : Promise.resolve([]),
        db.sessionFolderAssignment.findMany({
            where: createFolderAssignmentWhere(params),
            orderBy: { sessionId: "asc" },
            select: { sessionId: true, folderId: true },
        }),
        params.request.includeTags
            ? db.sessionOrganizationTag.findMany({
                where: { accountId: params.accountId, archivedAt: null },
                orderBy: [{ sortKey: "asc" }, { createdAt: "asc" }],
                select: {
                    id: true,
                    tagKey: true,
                    sortKey: true,
                    displayDbValue: true,
                    archivedAt: true,
                    createdAt: true,
                    updatedAt: true,
                },
            })
            : Promise.resolve([]),
        db.sessionTagAssignment.findMany({
            where: createTagAssignmentWhere(params),
            orderBy: [{ sessionId: "asc" }, { tagId: "asc" }],
            select: { sessionId: true, tagId: true },
        }),
        db.sessionOrganizationOrderEntry.findMany({
            where: {
                accountId: params.accountId,
                ...(params.request.orderScopes.length > 0
                    ? {
                        OR: params.request.orderScopes.map((scope) => ({
                            scopeKind: scope.scopeKind,
                            scopeHash: hashSessionOrganizationKey(scope.scopeKey),
                            scopeKey: scope.scopeKey,
                        })),
                    }
                    : {}),
            },
            orderBy: [{ scopeKind: "asc" }, { scopeHash: "asc" }, { sortKey: "asc" }],
            select: { scopeKind: true, scopeKey: true, itemKind: true, itemKey: true, sortKey: true },
        }),
        params.request.includeLabels
            ? db.sessionOrganizationLabel.findMany({
                where: { accountId: params.accountId, archivedAt: null },
                orderBy: [{ labelKind: "asc" }, { scopeHash: "asc" }],
                select: {
                    labelKind: true,
                    scopeKey: true,
                    displayDbValue: true,
                    archivedAt: true,
                    createdAt: true,
                    updatedAt: true,
                },
            })
            : Promise.resolve([]),
    ]);

    const groupedTagAssignments = new Map<string, string[]>();
    for (const assignment of tagAssignments) {
        const tagIds = groupedTagAssignments.get(assignment.sessionId) ?? [];
        tagIds.push(assignment.tagId);
        groupedTagAssignments.set(assignment.sessionId, tagIds);
    }
    const folderIdsByKey = new Map(folders.map((folder) => [folder.folderKey, folder.id]));
    const validOrderEntries = await filterValidSessionOrganizationOrderEntries({
        accountId: params.accountId,
        entries: orderEntries,
        reader: db,
    });

    return createSessionOrganizationSnapshot({
        version: checkpoint?.version ?? 0,
        pins: pins.map(mapSessionOrganizationPin),
        folders: folders.map((folder) => mapSessionOrganizationFolder(folder, folder.parentKey ? folderIdsByKey.get(folder.parentKey) ?? null : null)),
        folderAssignments,
        tags: tags.map(mapSessionOrganizationTag),
        tagAssignments: [...groupedTagAssignments.entries()].map(([sessionId, tagIds]) => ({ sessionId, tagIds })),
        orderEntries: validOrderEntries.map(mapSessionOrganizationOrderEntry),
        labels: labels.map(mapSessionOrganizationLabel),
    });
}
