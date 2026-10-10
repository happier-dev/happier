import {
    SESSION_ORGANIZATION_MAX_FOLDERS,
    SESSION_ORGANIZATION_MAX_LABELS,
    SESSION_ORGANIZATION_MAX_PINNED_SESSIONS,
    SESSION_ORGANIZATION_MAX_TAGS,
    type CreateOrUpdateSessionOrganizationFolderRequest,
    type CreateOrUpdateSessionOrganizationTagRequest,
    type DeleteSessionOrganizationFolderRequest,
    type DeleteSessionOrganizationLabelRequest,
    type DeleteSessionOrganizationTagRequest,
    type ImportLegacySessionOrganizationRequest,
    type ImportLegacySessionOrganizationResponse,
    type MoveSessionFolderAssignmentsResponse,
    type ReorderSessionOrganizationRequest,
    type SetSessionAttentionStandingRequest,
    type SetSessionPinRequest,
    type SetSessionTagAssignmentsRequest,
    type UpsertSessionOrganizationLabelRequest,
} from "@happier-dev/protocol";

import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import { scheduleAccountActivityBadgeRefresh } from "@/app/activity/refreshAccountActivityBadgePushes";
import { acknowledgeCurrentSessionDiscussionFrontiersInTx } from "@/app/session/discussions/readState";
import { applyViewerReadCursorOperationInTx } from "@/app/session/personal/readState";
import { afterTx, inTx } from "@/storage/inTx";
import {
    areSessionOrganizationDisplayEnvelopesAllowedForAccount,
    isSessionOrganizationDisplayEnvelopeAllowedForAccount,
    serializeSessionOrganizationDisplayEnvelope,
} from "./contentEnvelope";
import {
    findActiveSessionOrganizationFoldersById,
    resolveActiveSessionOrganizationParentFolder,
    validateSessionOrganizationFolderParentChange,
} from "./folderIdentity";
import {
    markBulkSessionFolderAssignmentsChanged,
    markSessionFolderAssignmentChanged,
    markSessionOrganizationChanged,
} from "./changes";
import { hashSessionOrganizationKey } from "./hashKeys";
import {
    mapSessionAttentionStanding,
    mapSessionOrganizationFolder,
    mapSessionOrganizationLabel,
    mapSessionOrganizationPin,
    mapSessionOrganizationTag,
} from "./organizationSnapshot";
import type { SessionFolderAssignmentRecord } from "./organizationQueries";
import {
    reorderSessionOrganizationInTx,
    reorderSessionPinsInTx,
} from "./organizationOrdering";
import { validateSessionOrganizationSessionOrderItems } from "./organizationOrderValidation";
import { createVisibleUnarchivedOrganizationSessionWhere } from "./sessionVisibility";
import type { SessionOrganizationTx } from "./types";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";

type ImportLegacySessionOrganizationErrorCode =
    | "invalid-session-organization-import"
    | "session-pin-limit-exceeded"
    | "session-organization-folder-limit-exceeded"
    | "session-organization-tag-limit-exceeded"
    | "session-organization-label-limit-exceeded";

class SessionOrganizationImportKnownError extends Error {
    constructor(readonly code: ImportLegacySessionOrganizationErrorCode) {
        super(code);
    }
}

function failSessionOrganizationImport(code: ImportLegacySessionOrganizationErrorCode): never {
    throw new SessionOrganizationImportKnownError(code);
}

function appendGroupedImportOrderEntry(
    groups: Map<string, ReorderSessionOrganizationRequest>,
    entry: ImportLegacySessionOrganizationRequest["orderEntries"][number],
): void {
    const groupKey = `${entry.scopeKind}\u0000${entry.scopeKey}`;
    const group = groups.get(groupKey);
    if (group) {
        group.entries.push({
            itemKind: entry.itemKind,
            itemKey: entry.itemKey,
            sortKey: entry.sortKey,
        });
        return;
    }

    groups.set(groupKey, {
        scopeKind: entry.scopeKind,
        scopeKey: entry.scopeKey,
        entries: [{
            itemKind: entry.itemKind,
            itemKey: entry.itemKey,
            sortKey: entry.sortKey,
        }],
    });
}

async function canAccessSyncedSessionForOrganizationInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    sessionId: string;
    authentication: SessionAccessAuthentication;
}>): Promise<boolean> {
    const row = await tx.session.findFirst({
        where: {
            AND: [{ id: params.sessionId }, await buildSessionAccessWhere({ tx, accountId: params.accountId, capability: 'readTranscript', mode: 'effective_access_v1', authentication: params.authentication })],
        },
        select: { id: true },
    });
    return Boolean(row);
}

async function canAccessVisibleUnarchivedSessionForOrganizationInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    sessionId: string;
    authentication: SessionAccessAuthentication;
}>): Promise<boolean> {
    const row = await tx.session.findFirst({
        where: {
            id: params.sessionId,
            ...await createVisibleUnarchivedOrganizationSessionWhere(tx, params.accountId, params.authentication),
        },
        select: { id: true },
    });
    return Boolean(row);
}

export async function validateSessionOrganizationDisplayEnvelopesForAccount(params: Readonly<{
    accountId: string;
    displays: readonly (CreateOrUpdateSessionOrganizationFolderRequest["display"])[];
}>): Promise<boolean> {
    return await inTx(async (tx) => await areSessionOrganizationDisplayEnvelopesAllowedForAccount({
        tx,
        accountId: params.accountId,
        displays: params.displays,
    }));
}

export async function importLegacySessionOrganization(params: Readonly<{
    accountId: string;
    request: ImportLegacySessionOrganizationRequest;
    authentication: SessionAccessAuthentication;
}>): Promise<ImportLegacySessionOrganizationResponse | { error: ImportLegacySessionOrganizationErrorCode }> {
    try {
        return await inTx(async (tx) => {
            const displaysAllowed = await areSessionOrganizationDisplayEnvelopesAllowedForAccount({
                tx,
                accountId: params.accountId,
                displays: [
                    ...params.request.folders.map((folder) => folder.display),
                    ...params.request.tags.map((tag) => tag.display),
                    ...params.request.labels.map((label) => label.display),
                ],
            });
            if (!displaysAllowed) {
                failSessionOrganizationImport("invalid-session-organization-import");
            }

            const orderGroups = new Map<string, ReorderSessionOrganizationRequest>();
            for (const entry of params.request.orderEntries) {
                appendGroupedImportOrderEntry(orderGroups, entry);
            }

            for (const orderRequest of orderGroups.values()) {
                if (orderRequest.scopeKind !== "pinned") continue;
                const validPinnedOrder = await validateSessionOrganizationSessionOrderItems({
                    accountId: params.accountId,
                    entries: orderRequest.entries,
                    reader: tx,
                    authentication: params.authentication,
                });
                if (!validPinnedOrder) {
                    failSessionOrganizationImport("invalid-session-organization-import");
                }
            }

            let importedPins = 0;
            for (const pin of params.request.pins) {
                const visible = await canAccessVisibleUnarchivedSessionForOrganizationInTx(tx, {
                    accountId: params.accountId,
                    sessionId: pin.sessionId,
                    authentication: params.authentication,
                });
                if (!visible) continue;

                const result = await setSessionPinInTx(tx, {
                    accountId: params.accountId,
                    sessionId: pin.sessionId,
                    request: { pinned: true, sortKey: pin.sortKey ?? null },
                    authentication: params.authentication,
                });
                if ("error" in result) {
                    failSessionOrganizationImport(result.error === "session-pin-limit-exceeded"
                        ? result.error
                        : "invalid-session-organization-import");
                }
                importedPins += 1;
            }

            let importedFolders = 0;
            for (const folder of params.request.folders) {
                const result = await upsertSessionOrganizationFolderInTx(tx, {
                    accountId: params.accountId,
                    request: folder,
                });
                if ("error" in result) {
                    failSessionOrganizationImport(result.error === "session-organization-folder-limit-exceeded"
                        ? result.error
                        : "invalid-session-organization-import");
                }
                importedFolders += 1;
            }

            let importedTags = 0;
            for (const tag of params.request.tags) {
                const result = await upsertSessionOrganizationTagInTx(tx, {
                    accountId: params.accountId,
                    request: tag,
                });
                if ("error" in result) {
                    failSessionOrganizationImport(result.error === "invalid-display-envelope"
                        ? "invalid-session-organization-import"
                        : result.error);
                }
                importedTags += 1;
            }

            for (const assignment of params.request.tagAssignments) {
                const visible = await canAccessSyncedSessionForOrganizationInTx(tx, {
                    accountId: params.accountId,
                    sessionId: assignment.sessionId,
                    authentication: params.authentication,
                });
                if (!visible) continue;
                const result = await setSessionTagAssignmentsInTx(tx, {
                    accountId: params.accountId,
                    sessionId: assignment.sessionId,
                    request: { tagIds: assignment.tagIds },
                    authentication: params.authentication,
                });
                if ("error" in result) {
                    failSessionOrganizationImport("invalid-session-organization-import");
                }
            }

            let importedOrderEntries = 0;
            for (const orderRequest of orderGroups.values()) {
                if (orderRequest.scopeKind === "pinned") {
                    const result = await reorderSessionPinsInTx(tx, {
                        accountId: params.accountId,
                        request: orderRequest,
                        authentication: params.authentication,
                    });
                    if ("error" in result) {
                        failSessionOrganizationImport("invalid-session-organization-import");
                    }
                    importedOrderEntries += result.orderEntries.length;
                } else {
                    const result = await reorderSessionOrganizationInTx(tx, {
                        accountId: params.accountId,
                        request: orderRequest,
                        authentication: params.authentication,
                    });
                    if ("error" in result) {
                        failSessionOrganizationImport("invalid-session-organization-import");
                    }
                    importedOrderEntries += result.orderEntries.length;
                }
            }

            let importedLabels = 0;
            for (const label of params.request.labels) {
                const result = await upsertSessionOrganizationLabelInTx(tx, {
                    accountId: params.accountId,
                    request: label,
                });
                if ("error" in result) {
                    failSessionOrganizationImport(result.error === "invalid-display-envelope"
                        ? "invalid-session-organization-import"
                        : result.error);
                }
                importedLabels += 1;
            }

            return {
                imported: {
                    pins: importedPins,
                    folders: importedFolders,
                    tags: importedTags,
                    orderEntries: importedOrderEntries,
                    labels: importedLabels,
                },
            };
        });
    } catch (error) {
        if (error instanceof SessionOrganizationImportKnownError) {
            return { error: error.code };
        }
        throw error;
    }
}

/** Change only the requested personal membership, retaining shared pin identity and order. */
export async function setSessionPinInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    sessionId: string;
    request: SetSessionPinRequest;
    authentication: SessionAccessAuthentication;
}>): Promise<Readonly<{ pin: ReturnType<typeof mapSessionOrganizationPin> | null }> | { error: "session-pin-limit-exceeded" | "session-not-found" }> {
    const surface = params.request.surface ?? "list";
    const membership = surface === "rail" ? { railPinned: params.request.pinned } : { listPinned: params.request.pinned };
    const select = { sessionId: true, sortKey: true, pinnedAt: true, listPinned: true, railPinned: true } as const;
    if (!params.request.pinned) {
        // Update only this membership. The row write keeps a concurrent other-surface
        // change intact, and clearing a missing row must never recreate a saved choice.
        const updated = await tx.sessionPin.updateMany({
            where: { accountId: params.accountId, sessionId: params.sessionId },
            data: membership,
        });
        if (updated.count === 0) return { pin: null };
        const retained = await tx.sessionPin.findUnique({
            where: { accountId_sessionId: { accountId: params.accountId, sessionId: params.sessionId } },
            select,
        });
        if (retained && !retained.listPinned && !retained.railPinned) {
            await tx.sessionPin.deleteMany({
                where: { accountId: params.accountId, sessionId: params.sessionId, listPinned: false, railPinned: false },
            });
        }
        await markSessionOrganizationChanged(tx, {
            accountId: params.accountId,
            scope: "pins",
            sessionIds: [params.sessionId],
        });
        return { pin: retained && (retained.listPinned || retained.railPinned) ? mapSessionOrganizationPin(retained) : null };
    }

    const visible = await canAccessVisibleUnarchivedSessionForOrganizationInTx(tx, {
        accountId: params.accountId,
        sessionId: params.sessionId,
        authentication: params.authentication,
    });
    if (!visible) {
        return { error: "session-not-found" };
    }

    const existingPin = await tx.sessionPin.findUnique({
        where: { accountId_sessionId: { accountId: params.accountId, sessionId: params.sessionId } },
        select: { id: true },
    });
    if (!existingPin) {
        const pinnedCount = await tx.sessionPin.count({
            where: {
                accountId: params.accountId,
                session: await createVisibleUnarchivedOrganizationSessionWhere(tx, params.accountId, params.authentication),
            },
        });
        if (pinnedCount >= SESSION_ORGANIZATION_MAX_PINNED_SESSIONS) {
            return { error: "session-pin-limit-exceeded" };
        }
    }

    const pin = await tx.sessionPin.upsert({
        where: { accountId_sessionId: { accountId: params.accountId, sessionId: params.sessionId } },
        create: {
            accountId: params.accountId,
            sessionId: params.sessionId,
            sortKey: params.request.sortKey ?? null,
            listPinned: surface === "list",
            railPinned: surface === "rail",
        },
        update: membership,
        select,
    });

    await markSessionOrganizationChanged(tx, {
        accountId: params.accountId,
        scope: "pins",
        sessionIds: [params.sessionId],
    });

    return { pin: mapSessionOrganizationPin(pin) };
}

export async function setSessionPin(params: Readonly<{
    accountId: string;
    sessionId: string;
    request: SetSessionPinRequest;
    authentication: SessionAccessAuthentication;
}>): Promise<Readonly<{ pin: ReturnType<typeof mapSessionOrganizationPin> | null }> | { error: "session-pin-limit-exceeded" | "session-not-found" }> {
    return await inTx(async (tx) => await setSessionPinInTx(tx, params));
}

async function markSessionAttentionStandingChangedInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    scope: "attentionStandings";
    sessionIds: readonly string[];
}>): Promise<void> {
    await markSessionOrganizationChanged(tx, params);
    afterTx(tx, () => scheduleAccountActivityBadgeRefresh({
        badgeAttentionChanged: true,
        accountIds: [params.accountId],
    }));
}

/**
 * Writes the account-scoped attention standing override for one session.
 *
 * Standing and reminder are independent mutations on one record. Scheduling snapshots the exact
 * prior standing override inside the row; removing the reminder restores it (or removes a
 * reminder-only row), so snoozing never changes the user's durable attention preference.
 *
 * Only a genuine change marks the organization scope and schedules the Account badge refresh.
 * Re-asserting the standing already stored, or clearing one that was never declared, returns the
 * current record without a write, so a repeated menu tap costs no checkpoint bump and no badge
 * push. The refresh itself is `afterTx`-scheduled, so a rolled-back enclosing transaction never
 * emits one.
 */
export async function setSessionAttentionStandingInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    sessionId: string;
    request: SetSessionAttentionStandingRequest;
    authentication: SessionAccessAuthentication;
}>): Promise<Readonly<{ standing: ReturnType<typeof mapSessionAttentionStanding> | null }> | { error: "session-not-found" }> {
    if (params.request.standing === null) {
        const deleted = await tx.sessionAttentionStanding.deleteMany({
            where: { accountId: params.accountId, sessionId: params.sessionId },
        });
        if (deleted.count === 0) return { standing: null };
        await markSessionAttentionStandingChangedInTx(tx, {
            accountId: params.accountId,
            scope: "attentionStandings",
            sessionIds: [params.sessionId],
        });
        return { standing: null };
    }

    if (params.request.remindAt === null) {
        const existingReminder = await tx.sessionAttentionStanding.findUnique({
            where: { accountId_sessionId: { accountId: params.accountId, sessionId: params.sessionId } },
            select: { sessionId: true, standing: true, remindAt: true, standingBeforeReminder: true, updatedAt: true },
        });
        if (!existingReminder) {
            return { standing: null };
        }
        if (!existingReminder.remindAt) {
            return { standing: mapSessionAttentionStanding(existingReminder) };
        }
        if (existingReminder.standingBeforeReminder === null) {
            await tx.sessionAttentionStanding.deleteMany({
                where: { accountId: params.accountId, sessionId: params.sessionId },
            });
            await markSessionAttentionStandingChangedInTx(tx, {
                accountId: params.accountId,
                scope: "attentionStandings",
                sessionIds: [params.sessionId],
            });
            return { standing: null };
        }

        const restoredStanding = await tx.sessionAttentionStanding.update({
            where: { accountId_sessionId: { accountId: params.accountId, sessionId: params.sessionId } },
            data: {
                standing: existingReminder.standingBeforeReminder,
                remindAt: null,
                standingBeforeReminder: null,
            },
            select: { sessionId: true, standing: true, remindAt: true, updatedAt: true },
        });
        await markSessionAttentionStandingChangedInTx(tx, {
            accountId: params.accountId,
            scope: "attentionStandings",
            sessionIds: [params.sessionId],
        });
        return { standing: mapSessionAttentionStanding(restoredStanding) };
    }

    const visible = await canAccessVisibleUnarchivedSessionForOrganizationInTx(tx, {
        accountId: params.accountId,
        sessionId: params.sessionId,
        authentication: params.authentication,
    });
    if (!visible) {
        return { error: "session-not-found" };
    }

    const existingStanding = await tx.sessionAttentionStanding.findUnique({
        where: { accountId_sessionId: { accountId: params.accountId, sessionId: params.sessionId } },
        select: { id: true, sessionId: true, standing: true, remindAt: true, standingBeforeReminder: true, updatedAt: true },
    });
    if (
        typeof params.request.standing === "boolean"
        && existingStanding?.remindAt === null
        && existingStanding.standing === params.request.standing
    ) {
        return { standing: mapSessionAttentionStanding(existingStanding) };
    }
    if (typeof params.request.remindAt === "number") {
        // The read-state owner, rather than cursor-row existence, decides whether
        // this Account is currently tracked. An unfollowed collaborator may
        // retain an inert historical row; setting a reminder is still valid and
        // must not turn that row back into tracking.
        const read = await applyViewerReadCursorOperationInTx(tx, {
            accountId: params.accountId,
            sessionId: params.sessionId,
            operation: { kind: "mark-read" },
            authentication: params.authentication,
        });
        if (!read.ok && read.error !== "session-not-tracked") {
            return { error: "session-not-found" };
        }
        if (read.ok) {
            await acknowledgeCurrentSessionDiscussionFrontiersInTx(tx, {
                accountId: params.accountId,
                sessionId: params.sessionId,
            });
        }
    }

    const standing = typeof params.request.remindAt === "number"
        ? await tx.sessionAttentionStanding.upsert({
            where: { accountId_sessionId: { accountId: params.accountId, sessionId: params.sessionId } },
            create: {
                accountId: params.accountId,
                sessionId: params.sessionId,
                standing: false,
                remindAt: new Date(params.request.remindAt),
                standingBeforeReminder: null,
            },
            update: {
                remindAt: new Date(params.request.remindAt),
                standingBeforeReminder: existingStanding?.remindAt
                    ? existingStanding.standingBeforeReminder
                    : existingStanding?.standing ?? null,
            },
            select: { sessionId: true, standing: true, remindAt: true, updatedAt: true },
        })
        : await tx.sessionAttentionStanding.upsert({
            where: { accountId_sessionId: { accountId: params.accountId, sessionId: params.sessionId } },
            create: {
                accountId: params.accountId,
                sessionId: params.sessionId,
                standing: params.request.standing!,
                remindAt: null,
                standingBeforeReminder: null,
            },
            update: {
                standing: params.request.standing!,
                remindAt: null,
                standingBeforeReminder: null,
            },
            select: { sessionId: true, standing: true, remindAt: true, updatedAt: true },
        });

    await markSessionAttentionStandingChangedInTx(tx, {
        accountId: params.accountId,
        scope: "attentionStandings",
        sessionIds: [params.sessionId],
    });

    return { standing: mapSessionAttentionStanding(standing) };
}

export async function setSessionAttentionStanding(params: Readonly<{
    accountId: string;
    sessionId: string;
    request: SetSessionAttentionStandingRequest;
    authentication: SessionAccessAuthentication;
}>): Promise<Readonly<{ standing: ReturnType<typeof mapSessionAttentionStanding> | null }> | { error: "session-not-found" }> {
    return await inTx(async (tx) => await setSessionAttentionStandingInTx(tx, params));
}

export async function upsertSessionOrganizationFolderInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    request: CreateOrUpdateSessionOrganizationFolderRequest;
}>): Promise<Readonly<{ folder: ReturnType<typeof mapSessionOrganizationFolder> }> | { error: "invalid-parent-folder" | "invalid-display-envelope" | "session-organization-folder-limit-exceeded" }> {
    if (!await isSessionOrganizationDisplayEnvelopeAllowedForAccount({
        tx,
        accountId: params.accountId,
        display: params.request.display,
    })) {
        return { error: "invalid-display-envelope" };
    }

    const parent = await resolveActiveSessionOrganizationParentFolder({
        tx,
        accountId: params.accountId,
        parentFolderId: params.request.parentFolderId,
        parentFolderKey: params.request.parentFolderKey,
    });
    if (parent && "error" in parent) {
        return parent;
    }
    const validParentChange = await validateSessionOrganizationFolderParentChange({
        tx,
        accountId: params.accountId,
        folderId: params.request.folderId,
        folderKey: params.request.folderKey,
        parentFolderKey: params.request.parentFolderKey,
    });
    if (!validParentChange) {
        return { error: "invalid-parent-folder" };
    }

    const folderHash = hashSessionOrganizationKey(params.request.folderKey);
    const parentHash = params.request.parentFolderKey
        ? hashSessionOrganizationKey(params.request.parentFolderKey)
        : null;
    const existingRows = await tx.sessionOrganizationFolder.findMany({
        where: { accountId: params.accountId, folderHash },
        select: { id: true, folderKey: true, archivedAt: true },
    });
    for (const row of existingRows) {
        if (row.folderKey !== params.request.folderKey) {
            throw new Error("session organization folder hash collision");
        }
    }
    if (!existingRows.some((row) => row.archivedAt === null)) {
        const activeFolderCount = await tx.sessionOrganizationFolder.count({
            where: { accountId: params.accountId, archivedAt: null },
        });
        if (activeFolderCount >= SESSION_ORGANIZATION_MAX_FOLDERS) {
            return { error: "session-organization-folder-limit-exceeded" };
        }
    }

    const displayDbValue = serializeSessionOrganizationDisplayEnvelope(params.request.display);
    const createData = {
        ...(params.request.folderId ? { id: params.request.folderId } : {}),
        accountId: params.accountId,
        folderKey: params.request.folderKey,
        folderHash,
        parentKey: params.request.parentFolderKey,
        parentHash,
        sortKey: params.request.sortKey,
        displayDbValue,
    };
    const folder = await tx.sessionOrganizationFolder.upsert({
        where: { accountId_folderHash: { accountId: params.accountId, folderHash } },
        create: createData,
        update: {
            folderKey: params.request.folderKey,
            parentKey: params.request.parentFolderKey,
            parentHash,
            sortKey: params.request.sortKey,
            displayDbValue,
            archivedAt: null,
        },
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
    });

    await markSessionOrganizationChanged(tx, {
        accountId: params.accountId,
        scope: "folders",
        folderIds: [folder.id],
    });

    return { folder: mapSessionOrganizationFolder(folder, parent?.id ?? null) };
}

export async function upsertSessionOrganizationFolder(params: Readonly<{
    accountId: string;
    request: CreateOrUpdateSessionOrganizationFolderRequest;
}>): Promise<Readonly<{ folder: ReturnType<typeof mapSessionOrganizationFolder> }> | { error: "invalid-parent-folder" | "invalid-display-envelope" | "session-organization-folder-limit-exceeded" }> {
    return await inTx(async (tx) => await upsertSessionOrganizationFolderInTx(tx, params));
}

function collectDeletedFolderIds(params: Readonly<{
    rootFolderId: string;
    folders: ReadonlyArray<Readonly<{ id: string; folderKey: string; parentKey: string | null }>>;
}>): string[] {
    const rootFolder = params.folders.find((folder) => folder.id === params.rootFolderId);
    if (!rootFolder) return [];
    const deletedIds = new Set<string>([rootFolder.id]);
    const deletedKeys = new Set<string>([rootFolder.folderKey]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const folder of params.folders) {
            if (!deletedIds.has(folder.id) && folder.parentKey && deletedKeys.has(folder.parentKey)) {
                deletedIds.add(folder.id);
                deletedKeys.add(folder.folderKey);
                changed = true;
            }
        }
    }
    return [...deletedIds];
}

export async function deleteSessionOrganizationFolder(params: Readonly<{
    accountId: string;
    request: DeleteSessionOrganizationFolderRequest;
}>) {
    return await inTx(async (tx) => {
        const folders = await tx.sessionOrganizationFolder.findMany({
            where: { accountId: params.accountId, archivedAt: null },
            select: { id: true, folderKey: true, parentKey: true },
        });
        const folder = folders.find((candidate) => candidate.id === params.request.folderId) ?? null;
        if (!folder) {
            return {
                deletedFolderIds: [],
                assignmentTargetFolderId: null,
                affectedAssignmentCount: 0,
            };
        }

        const deletedFolderIds = collectDeletedFolderIds({
            rootFolderId: params.request.folderId,
            folders,
        });
        const archivedAt = new Date();
        await tx.sessionOrganizationFolder.updateMany({
            where: { accountId: params.accountId, id: { in: deletedFolderIds } },
            data: { archivedAt },
        });

        const assignmentTargetFolderId = folder.parentKey
            ? (folders.find((candidate) => candidate.folderKey === folder.parentKey)?.id ?? null)
            : null;
        const writeResult = assignmentTargetFolderId === null
            ? await tx.sessionFolderAssignment.deleteMany({
                where: { accountId: params.accountId, folderId: { in: deletedFolderIds } },
            })
            : await tx.sessionFolderAssignment.updateMany({
                where: { accountId: params.accountId, folderId: { in: deletedFolderIds } },
                data: { folderId: assignmentTargetFolderId },
            });

        await markSessionOrganizationChanged(tx, {
            accountId: params.accountId,
            scope: "folders",
            folderIds: deletedFolderIds,
        });
        if (writeResult.count > 0) {
            await markBulkSessionFolderAssignmentsChanged(tx, {
                accountId: params.accountId,
                folderIds: deletedFolderIds,
                toFolderId: assignmentTargetFolderId,
            });
            await markSessionOrganizationChanged(tx, {
                accountId: params.accountId,
                scope: "folderAssignments",
                folderIds: deletedFolderIds,
                scopeKeys: [assignmentTargetFolderId ?? "root"],
            });
        }

        return {
            deletedFolderIds,
            assignmentTargetFolderId,
            affectedAssignmentCount: writeResult.count,
        };
    });
}

export async function setSessionFolderAssignmentInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    sessionId: string;
    folderId: string | null;
    authentication: SessionAccessAuthentication;
}>): Promise<Readonly<{ sessionId: string; folderId: string | null }> | { error: "invalid-folder" | "session-not-found" }> {
    if (!await canAccessSyncedSessionForOrganizationInTx(tx, params)) return { error: "session-not-found" };
    if (params.folderId !== null) {
        const targetFolder = await findActiveSessionOrganizationFoldersById({
            tx,
            accountId: params.accountId,
            folderIds: [params.folderId],
        });
        if (targetFolder.length !== 1) {
            return { error: "invalid-folder" };
        }
    }

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
}

export async function setSessionFolderAssignment(params: Readonly<{
    accountId: string;
    sessionId: string;
    folderId: string | null;
    authentication: SessionAccessAuthentication;
}>): Promise<Readonly<{ sessionId: string; folderId: string | null }> | { error: "invalid-folder" | "session-not-found" }> {
    return await inTx(async (tx) =>
        await setSessionFolderAssignmentInTx(tx, params),
    );
}

async function validateSessionOrganizationTagIdsInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    tagIds: readonly string[];
}>): Promise<string[] | null> {
    const uniqueTagIds = Array.from(new Set(params.tagIds));
    const existingTags = uniqueTagIds.length > 0
        ? await tx.sessionOrganizationTag.findMany({
            where: { accountId: params.accountId, id: { in: uniqueTagIds }, archivedAt: null },
            select: { id: true },
        })
        : [];
    return existingTags.length === uniqueTagIds.length ? uniqueTagIds : null;
}

/**
 * Applies only the initial placement of a just-created Session. Callers must
 * use their surrounding Session-create transaction and turn a returned error
 * into a rollback; ordinary later folder/tag edits retain their public owners.
 */
export async function applySessionCreationPlacementInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    sessionId: string;
    folderId: string | null;
    tagIds: readonly string[];
}>): Promise<Readonly<{ folderId: string | null; tagIds: string[] }> | {
    error: "invalid-folder" | "invalid-session-tags";
}> {
    const ownedSession = await tx.session.findFirst({
        where: { id: params.sessionId, accountId: params.accountId },
        select: { id: true },
    });
    if (!ownedSession) return { error: "invalid-folder" };
    if (params.folderId !== null) {
        const targetFolder = await findActiveSessionOrganizationFoldersById({
            tx,
            accountId: params.accountId,
            folderIds: [params.folderId],
        });
        if (targetFolder.length !== 1) {
            return { error: "invalid-folder" };
        }
    }
    if (!await validateSessionOrganizationTagIdsInTx(tx, {
        accountId: params.accountId,
        tagIds: params.tagIds,
    })) {
        return { error: "invalid-session-tags" };
    }

    await tx.sessionFolderAssignment.deleteMany({
        where: { accountId: params.accountId, sessionId: params.sessionId },
    });
    if (params.folderId !== null) {
        await tx.sessionFolderAssignment.create({
            data: { accountId: params.accountId, sessionId: params.sessionId, folderId: params.folderId },
        });
    }
    await tx.sessionTagAssignment.deleteMany({
        where: { accountId: params.accountId, sessionId: params.sessionId },
    });
    if (params.tagIds.length > 0) {
        await tx.sessionTagAssignment.createMany({
            data: params.tagIds.map((tagId) => ({ accountId: params.accountId, sessionId: params.sessionId, tagId })),
        });
    }
    await markSessionFolderAssignmentChanged(tx, {
        accountId: params.accountId,
        sessionId: params.sessionId,
        folderId: params.folderId,
    });
    await markSessionOrganizationChanged(tx, {
        accountId: params.accountId,
        scope: "tagAssignments",
        sessionIds: [params.sessionId],
        tagIds: [...params.tagIds],
    });
    return { folderId: params.folderId, tagIds: [...params.tagIds] };
}

/**
 * Returns the queryable organization projection for a Session create/load
 * response. It is deliberately a snapshot, not creation correspondence:
 * later ordinary organization edits remain visible and are never reverted by
 * a create-key retry.
 */
export async function readSessionOrganizationPlacementInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    sessionId: string;
}>): Promise<Readonly<{ folderId: string | null; tagIds: string[] }>> {
    const [folder, tags] = await Promise.all([
        tx.sessionFolderAssignment.findUnique({
            where: {
                accountId_sessionId: {
                    accountId: params.accountId,
                    sessionId: params.sessionId,
                },
            },
            select: { folderId: true },
        }),
        tx.sessionTagAssignment.findMany({
            where: {
                accountId: params.accountId,
                sessionId: params.sessionId,
            },
            select: { tagId: true },
            orderBy: { tagId: "asc" },
        }),
    ]);
    return {
        folderId: folder?.folderId ?? null,
        tagIds: tags.map((tag) => tag.tagId),
    };
}

export async function moveSessionFolderAssignments(params: Readonly<{
    accountId: string;
    fromFolderIds: readonly string[];
    toFolderId: string | null;
    authentication: SessionAccessAuthentication;
}>): Promise<MoveSessionFolderAssignmentsResponse | { error: "invalid-folder" }> {
    return await inTx(async (tx) => {
        if (params.toFolderId !== null) {
            const targetFolder = await findActiveSessionOrganizationFoldersById({
                tx,
                accountId: params.accountId,
                folderIds: [params.toFolderId],
            });
            if (targetFolder.length !== 1) {
                return { error: "invalid-folder" };
            }
        }

        const where = {
            accountId: params.accountId,
            folderId: { in: [...params.fromFolderIds] },
            session: await buildSessionAccessWhere({
                tx,
                accountId: params.accountId,
                capability: "readTranscript",
                mode: "effective_access_v1",
                authentication: params.authentication,
            }),
        };
        const assignments = await tx.sessionFolderAssignment.findMany({
            where,
            orderBy: [{ folderId: "asc" }, { sessionId: "asc" }],
            select: {
                sessionId: true,
                folderId: true,
            },
        }) as SessionFolderAssignmentRecord[];

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

export async function upsertSessionOrganizationTagInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    request: CreateOrUpdateSessionOrganizationTagRequest;
}>): Promise<Readonly<{ tag: ReturnType<typeof mapSessionOrganizationTag> }> | { error: "invalid-display-envelope" | "session-organization-tag-limit-exceeded" }> {
    if (!await isSessionOrganizationDisplayEnvelopeAllowedForAccount({
        tx,
        accountId: params.accountId,
        display: params.request.display,
    })) {
        return { error: "invalid-display-envelope" };
    }

    const tagHash = hashSessionOrganizationKey(params.request.tagKey);
    const existingRows = await tx.sessionOrganizationTag.findMany({
        where: { accountId: params.accountId, tagHash },
        select: { id: true, tagKey: true, archivedAt: true },
    });
    for (const row of existingRows) {
        if (row.tagKey !== params.request.tagKey) {
            throw new Error("session organization tag hash collision");
        }
    }
    if (!existingRows.some((row) => row.archivedAt === null)) {
        const activeTagCount = await tx.sessionOrganizationTag.count({
            where: { accountId: params.accountId, archivedAt: null },
        });
        if (activeTagCount >= SESSION_ORGANIZATION_MAX_TAGS) {
            return { error: "session-organization-tag-limit-exceeded" };
        }
    }

    const displayDbValue = serializeSessionOrganizationDisplayEnvelope(params.request.display);
    const tag = await tx.sessionOrganizationTag.upsert({
        where: { accountId_tagHash: { accountId: params.accountId, tagHash } },
        create: {
            ...(params.request.tagId ? { id: params.request.tagId } : {}),
            accountId: params.accountId,
            tagKey: params.request.tagKey,
            tagHash,
            sortKey: params.request.sortKey,
            displayDbValue,
        },
        update: {
            tagKey: params.request.tagKey,
            sortKey: params.request.sortKey,
            displayDbValue,
            archivedAt: null,
        },
        select: {
            id: true,
            tagKey: true,
            sortKey: true,
            displayDbValue: true,
            archivedAt: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    await markSessionOrganizationChanged(tx, {
        accountId: params.accountId,
        scope: "tags",
        tagIds: [tag.id],
    });

    return { tag: mapSessionOrganizationTag(tag) };
}

export async function upsertSessionOrganizationTag(params: Readonly<{
    accountId: string;
    request: CreateOrUpdateSessionOrganizationTagRequest;
}>): Promise<Readonly<{ tag: ReturnType<typeof mapSessionOrganizationTag> }> | { error: "invalid-display-envelope" | "session-organization-tag-limit-exceeded" }> {
    return await inTx(async (tx) => await upsertSessionOrganizationTagInTx(tx, params));
}

export async function deleteSessionOrganizationTag(params: Readonly<{
    accountId: string;
    request: DeleteSessionOrganizationTagRequest;
}>) {
    return await inTx(async (tx) => {
        const removedAssignments = await tx.sessionTagAssignment.deleteMany({
            where: { accountId: params.accountId, tagId: params.request.tagId },
        });
        await tx.sessionOrganizationTag.updateMany({
            where: { accountId: params.accountId, id: params.request.tagId },
            data: { archivedAt: new Date() },
        });

        await markSessionOrganizationChanged(tx, {
            accountId: params.accountId,
            scope: "tags",
            tagIds: [params.request.tagId],
            deletedTagIds: [params.request.tagId],
        });
        if (removedAssignments.count > 0) {
            await markSessionOrganizationChanged(tx, {
                accountId: params.accountId,
                scope: "tagAssignments",
                tagIds: [params.request.tagId],
            });
        }

        return {
            tagId: params.request.tagId,
            removedAssignmentCount: removedAssignments.count,
        };
    });
}

export async function setSessionTagAssignments(params: Readonly<{
    accountId: string;
    sessionId: string;
    request: SetSessionTagAssignmentsRequest;
    authentication: SessionAccessAuthentication;
}>): Promise<Readonly<{ sessionId: string; tagIds: string[] }> | { error: "invalid-session-tags" | "session-not-found" }> {
    return await inTx(async (tx) => await setSessionTagAssignmentsInTx(tx, params));
}

export async function setSessionTagAssignmentsInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    sessionId: string;
    request: SetSessionTagAssignmentsRequest;
    authentication: SessionAccessAuthentication;
}>): Promise<Readonly<{ sessionId: string; tagIds: string[] }> | { error: "invalid-session-tags" | "session-not-found" }> {
    if (!await canAccessSyncedSessionForOrganizationInTx(tx, params)) return { error: "session-not-found" };
    const uniqueTagIds = await validateSessionOrganizationTagIdsInTx(tx, {
        accountId: params.accountId,
        tagIds: params.request.tagIds,
    });
    if (!uniqueTagIds) {
        return { error: "invalid-session-tags" };
    }

    await tx.sessionTagAssignment.deleteMany({
        where: { accountId: params.accountId, sessionId: params.sessionId },
    });
    if (uniqueTagIds.length > 0) {
        await tx.sessionTagAssignment.createMany({
            data: uniqueTagIds.map((tagId) => ({
                accountId: params.accountId,
                sessionId: params.sessionId,
                tagId,
            })),
        });
    }
    const assignments = await tx.sessionTagAssignment.findMany({
        where: { accountId: params.accountId, sessionId: params.sessionId },
        orderBy: { tagId: "asc" },
        select: { sessionId: true, tagId: true },
    });

    await markSessionOrganizationChanged(tx, {
        accountId: params.accountId,
        scope: "tagAssignments",
        sessionIds: [params.sessionId],
        tagIds: uniqueTagIds,
    });

    return {
        sessionId: params.sessionId,
        tagIds: assignments.map((assignment) => assignment.tagId),
    };
}

export async function upsertSessionOrganizationLabelInTx(tx: SessionOrganizationTx, params: Readonly<{
    accountId: string;
    request: UpsertSessionOrganizationLabelRequest;
}>): Promise<Readonly<{ label: ReturnType<typeof mapSessionOrganizationLabel> }> | { error: "invalid-display-envelope" | "session-organization-label-limit-exceeded" }> {
    if (!await isSessionOrganizationDisplayEnvelopeAllowedForAccount({
        tx,
        accountId: params.accountId,
        display: params.request.display,
    })) {
        return { error: "invalid-display-envelope" };
    }

    const scopeHash = hashSessionOrganizationKey(params.request.scopeKey);
    const existingRows = await tx.sessionOrganizationLabel.findMany({
        where: {
            accountId: params.accountId,
            labelKind: params.request.labelKind,
            scopeHash,
        },
        select: {
            scopeKey: true,
            archivedAt: true,
        },
    });
    for (const row of existingRows) {
        if (row.scopeKey !== params.request.scopeKey) {
            throw new Error("session organization label hash collision");
        }
    }
    if (!existingRows.some((row) => row.archivedAt === null)) {
        const activeLabelCount = await tx.sessionOrganizationLabel.count({
            where: { accountId: params.accountId, archivedAt: null },
        });
        if (activeLabelCount >= SESSION_ORGANIZATION_MAX_LABELS) {
            return { error: "session-organization-label-limit-exceeded" };
        }
    }

    const displayDbValue = serializeSessionOrganizationDisplayEnvelope(params.request.display);
    const label = await tx.sessionOrganizationLabel.upsert({
        where: {
            accountId_labelKind_scopeHash: {
                accountId: params.accountId,
                labelKind: params.request.labelKind,
                scopeHash,
            },
        },
        create: {
            accountId: params.accountId,
            labelKind: params.request.labelKind,
            scopeKey: params.request.scopeKey,
            scopeHash,
            displayDbValue,
        },
        update: {
            scopeKey: params.request.scopeKey,
            displayDbValue,
            archivedAt: null,
        },
        select: {
            labelKind: true,
            scopeKey: true,
            displayDbValue: true,
            archivedAt: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    await markSessionOrganizationChanged(tx, {
        accountId: params.accountId,
        scope: "labels",
        scopeKeys: [params.request.scopeKey],
    });

    return { label: mapSessionOrganizationLabel(label) };
}

export async function upsertSessionOrganizationLabel(params: Readonly<{
    accountId: string;
    request: UpsertSessionOrganizationLabelRequest;
}>): Promise<Readonly<{ label: ReturnType<typeof mapSessionOrganizationLabel> }> | { error: "invalid-display-envelope" | "session-organization-label-limit-exceeded" }> {
    return await inTx(async (tx) => await upsertSessionOrganizationLabelInTx(tx, params));
}

export async function deleteSessionOrganizationLabel(params: Readonly<{
    accountId: string;
    request: DeleteSessionOrganizationLabelRequest;
}>) {
    return await inTx(async (tx) => {
        const scopeHash = hashSessionOrganizationKey(params.request.scopeKey);
        await tx.sessionOrganizationLabel.updateMany({
            where: {
                accountId: params.accountId,
                labelKind: params.request.labelKind,
                scopeHash,
                scopeKey: params.request.scopeKey,
                archivedAt: null,
            },
            data: { archivedAt: new Date() },
        });

        await markSessionOrganizationChanged(tx, {
            accountId: params.accountId,
            scope: "labels",
            scopeKeys: [params.request.scopeKey],
        });

        return {
            labelKind: params.request.labelKind,
            scopeKey: params.request.scopeKey,
            archived: true,
        };
    });
}
