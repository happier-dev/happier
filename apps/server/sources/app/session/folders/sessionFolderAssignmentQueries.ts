import type { Prisma } from "@prisma/client";

import { createV2SessionListVisibilityWhere } from "@/app/api/routes/session/v2SessionListRows";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    markBulkSessionFolderAssignmentsChanged,
    markSessionFolderAssignmentChanged,
} from "./sessionFolderAssignmentChanges";

export type SessionFolderAssignmentRecord = Readonly<{
    sessionId: string;
    folderId: string;
}>;

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

export async function setSessionFolderAssignment(params: Readonly<{
    accountId: string;
    sessionId: string;
    folderId: string | null;
}>): Promise<Readonly<{ sessionId: string; folderId: string | null }>> {
    return await inTx(async (tx) => {
        if (params.folderId === null) {
            await tx.sessionFolderAssignment.deleteMany({
                where: {
                    accountId: params.accountId,
                    sessionId: params.sessionId,
                },
            });
        } else {
            await tx.sessionFolderAssignment.upsert({
                where: {
                    accountId_sessionId: {
                        accountId: params.accountId,
                        sessionId: params.sessionId,
                    },
                },
                create: {
                    accountId: params.accountId,
                    sessionId: params.sessionId,
                    folderId: params.folderId,
                },
                update: {
                    folderId: params.folderId,
                },
            });
        }

        await markSessionFolderAssignmentChanged(tx, {
            accountId: params.accountId,
            sessionId: params.sessionId,
            folderId: params.folderId,
        });

        return {
            sessionId: params.sessionId,
            folderId: params.folderId,
        };
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

export async function moveSessionFolderAssignments(params: Readonly<{
    accountId: string;
    fromFolderIds: readonly string[];
    toFolderId: string | null;
}>): Promise<Readonly<{
    assignments: SessionFolderAssignmentRecord[];
    affectedCount: number;
    toFolderId: string | null;
}>> {
    return await inTx(async (tx) => {
        const where = {
            accountId: params.accountId,
            folderId: { in: [...params.fromFolderIds] },
        };
        const assignments = await tx.sessionFolderAssignment.findMany({
            where,
            orderBy: [{ folderId: "asc" }, { sessionId: "asc" }],
            select: {
                sessionId: true,
                folderId: true,
            },
        });

        const writeResult = params.toFolderId === null
            ? await tx.sessionFolderAssignment.deleteMany({ where })
            : await tx.sessionFolderAssignment.updateMany({
                where,
                data: { folderId: params.toFolderId },
            });

        await markBulkSessionFolderAssignmentsChanged(tx, {
            accountId: params.accountId,
            folderIds: params.fromFolderIds,
            toFolderId: params.toFolderId,
        });

        return {
            assignments,
            affectedCount: writeResult.count,
            toFolderId: params.toFolderId,
        };
    });
}
