import type { Prisma } from "@prisma/client";
import {
    type SessionOrganizationSnapshotRequest,
} from "@happier-dev/protocol";

import { inTx, type Tx } from "@/storage/inTx";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import {
    createSessionOrganizationSnapshot,
    mapSessionAttentionStanding,
    mapSessionOrganizationFolder,
    mapSessionOrganizationLabel,
    mapSessionOrganizationOrderEntry,
    mapSessionOrganizationPin,
    mapSessionOrganizationTag,
} from "./organizationSnapshot";
import { hashSessionOrganizationKey } from "./hashKeys";
import { filterValidSessionOrganizationOrderEntries } from "./organizationOrderValidation";
import { createVisibleUnarchivedOrganizationSessionWhere } from "./sessionVisibility";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";

export type SessionFolderAssignmentRecord = Readonly<{
    sessionId: string;
    folderId: string;
}>;

/** List membership and personal order stay here; listing supplies its admitted corpus. */
export async function fetchSessionOrganizationPinnedSessionIds(
    accountId: string,
    authentication: SessionAccessAuthentication,
    admittedRead?: Readonly<{ reader: Pick<Tx, "sessionPin">; sessionWhere: Prisma.SessionWhereInput }>,
): Promise<string[]> {
    const readPins = async (reader: Pick<Tx, "sessionPin">, sessionWhere: Prisma.SessionWhereInput) => {
        const pins = await reader.sessionPin.findMany({
            where: {
                accountId,
                listPinned: true,
                session: sessionWhere,
            },
            orderBy: [{ sortKey: "asc" }, { pinnedAt: "asc" }],
            select: { sessionId: true, sortKey: true, pinnedAt: true },
        });
        return pins.map((pin) => pin.sessionId);
    };
    if (admittedRead) return await readPins(admittedRead.reader, admittedRead.sessionWhere);
    return await inTx(async (tx) => await readPins(
        tx,
        await createVisibleUnarchivedOrganizationSessionWhere(tx, accountId, authentication),
    ), { readOnly: true });
}

export async function fetchSessionFolderAssignmentsForSessions(params: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
    authentication: SessionAccessAuthentication;
}>): Promise<SessionFolderAssignmentRecord[]> {
    if (params.sessionIds.length === 0) return [];

    return await inTx(async (tx) => {
        const sessionWhere = await buildSessionAccessWhere({ tx, accountId: params.accountId, capability: 'readTranscript', mode: 'effective_access_v1', authentication: params.authentication });
        return await tx.sessionFolderAssignment.findMany({
            where: {
                accountId: params.accountId,
                sessionId: { in: [...params.sessionIds] },
                session: sessionWhere,
            },
            orderBy: { sessionId: "asc" },
            select: {
                sessionId: true,
                folderId: true,
            },
        });
    }, { readOnly: true });
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

function createFolderAssignmentWhere(sessionWhere: Prisma.SessionWhereInput, params: Readonly<{
    accountId: string;
    request: SessionOrganizationSnapshotRequest;
    authentication: SessionAccessAuthentication;
}>): Prisma.SessionFolderAssignmentWhereInput {
    const sessionIds = params.request.assignmentSessionIds;
    const folderIds = params.request.folderIds;
    const scopedPredicates: Prisma.SessionFolderAssignmentWhereInput[] = [
        ...(sessionIds.length > 0 ? [{ sessionId: { in: [...sessionIds] } }] : []),
        ...(folderIds.length > 0 ? [{ folderId: { in: [...folderIds] } }] : []),
    ];
    return {
        accountId: params.accountId,
        session: sessionWhere,
        ...(params.request.includeAllFolderAssignments
            ? {}
            : scopedPredicates.length > 0
                ? { OR: scopedPredicates }
                : { sessionId: { in: [] } }),
    };
}

function createTagAssignmentWhere(sessionWhere: Prisma.SessionWhereInput, params: Readonly<{
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
        session: sessionWhere,
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
    authentication: SessionAccessAuthentication;
}>) {
    return await inTx(async (tx) => {
        const sessionWhere = await buildSessionAccessWhere({ tx, accountId: params.accountId, capability: 'readTranscript', mode: 'effective_access_v1', authentication: params.authentication });
        const visibleSessionWhere = await createVisibleUnarchivedOrganizationSessionWhere(tx, params.accountId, params.authentication);
        const account = await tx.account.findUnique({
            where: { id: params.accountId },
            select: {
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
        const accountCurrentness = account
            ? deriveAccountEncryptionCurrentnessFromRow(account)
            : null;
        const accountMode = accountCurrentness?.status === "ready"
            ? accountCurrentness.currentness.encryptionMode
            : null;

        const [
            checkpoint,
            pins,
            folders,
            folderAssignments,
            tags,
            tagAssignments,
            orderEntries,
            labels,
            attentionStandings,
        ] = await Promise.all([
            tx.sessionOrganizationCheckpoint.findUnique({
                where: { accountId: params.accountId },
                select: { version: true },
            }),
            tx.sessionPin.findMany({
                where: {
                    accountId: params.accountId,
                    session: visibleSessionWhere,
                },
                orderBy: [{ sortKey: "asc" }, { pinnedAt: "asc" }],
                select: { sessionId: true, sortKey: true, pinnedAt: true, listPinned: true, railPinned: true },
            }),
            params.request.includeFolders
                ? tx.sessionOrganizationFolder.findMany({
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
            tx.sessionFolderAssignment.findMany({
                where: createFolderAssignmentWhere(sessionWhere, params),
                orderBy: { sessionId: "asc" },
                select: { sessionId: true, folderId: true },
            }),
            params.request.includeTags
                ? tx.sessionOrganizationTag.findMany({
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
            tx.sessionTagAssignment.findMany({
                where: createTagAssignmentWhere(sessionWhere, params),
                orderBy: [{ sessionId: "asc" }, { tagId: "asc" }],
                select: { sessionId: true, tagId: true },
            }),
            tx.sessionOrganizationOrderEntry.findMany({
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
                ? tx.sessionOrganizationLabel.findMany({
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
            params.request.includeAttentionStandings
                ? tx.sessionAttentionStanding.findMany({
                    where: {
                        accountId: params.accountId,
                        session: visibleSessionWhere,
                    },
                    orderBy: { sessionId: "asc" },
                    select: { sessionId: true, standing: true, remindAt: true, updatedAt: true },
                })
                : Promise.resolve(null),
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
            reader: tx,
            authentication: params.authentication,
        });

        return createSessionOrganizationSnapshot({
            version: checkpoint?.version ?? 0,
            pins: pins.map(mapSessionOrganizationPin),
            folders: folders.map((folder) => mapSessionOrganizationFolder(
                folder,
                folder.parentKey
                    ? folderIdsByKey.get(folder.parentKey) ?? null
                    : null,
                accountMode,
            )),
            folderAssignments,
            tags: tags.map((tag) => mapSessionOrganizationTag(tag, accountMode)),
            tagAssignments: [...groupedTagAssignments.entries()].map(([sessionId, tagIds]) => ({ sessionId, tagIds })),
            orderEntries: validOrderEntries.map(mapSessionOrganizationOrderEntry),
            labels: labels.map((label) => mapSessionOrganizationLabel(label, accountMode)),
            ...(attentionStandings ? { attentionStandings: attentionStandings.map((row) => {
                const mapped = mapSessionAttentionStanding(row);
                if (params.request.includeAttentionReminderTimes) return mapped;
                return { sessionId: mapped.sessionId, standing: row.remindAt && row.remindAt.getTime() > Date.now() ? false : mapped.standing, updatedAt: mapped.updatedAt };
            }) } : {}),
        });
    }, { readOnly: true });
}
