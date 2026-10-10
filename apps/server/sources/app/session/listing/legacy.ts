import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import type { Prisma } from "@prisma/client";
import { projectLegacyViewerLastViewedSessionSeqV1, projectLegacyViewerUnreadSinceV1 } from "@happier-dev/protocol";
import { QUIET_SESSION_PERSONAL_DISCUSSION_FACTS } from "@/app/session/personal/discussionFacts";
import { createSessionPersonalProjectionSelect, projectSessionViewer } from "@/app/session/personal/projection";
import { db } from "@/storage/db";
import { ACCOUNT_DISPLAY_PROFILE_SELECT, toShareUserProfile } from "@/app/account/profile/accountDisplayProfile";
import {
    collectSessionTranscriptVisibleRowsBeforeTake,
    createSessionTranscriptPublicationRecencyQueryBranches,
    createSessionTranscriptShareableRecencyQueryBranches,
    filterSessionTranscriptPublicationSequenceFacts,
    isSessionTranscriptShareable,
    resolveSessionTranscriptNonOwnerRecencyMs,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import {
    isSessionMetadataPrivacyUpgradeRequiredError,
    projectSessionMetadataForRecipient,
    requiresSessionMetadataOwnerAccountMode,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import { mapPendingActivationAuthorization } from "@/app/session/pending/pendingActivationAuthorization";
import {
    createSessionDataKeyEnvelopeViewerSelect,
    projectViewerSessionDataKey,
} from "@/app/session/encryption/sessionDataKeyEnvelopePersistence";
import {
    parseStoredSessionLatestTurnStatus,
    parseStoredSessionRuntimeIssue,
    readSessionTranscriptAuthorityFields,
    omitSessionListProjectionFallbackColumns,
    projectSessionListingPublicationPreview,
    readLatestTurnStatusObservedAt,
} from "./rows";
import {
    createSessionRollbackEligibleTurnsSelect,
    readSessionTurnRollbackEligibleStarts,
} from "@/app/session/turns/sessionRollbackEligibilityProjection";
import { readSessionListViewerDiscussionFacts, runWithSessionListProjectionFallback } from "./page";
import { readSessionListOwnerAccountModes } from "./service";

const SESSION_ROLLBACK_ELIGIBLE_TURNS_SELECT = createSessionRollbackEligibleTurnsSelect();

const V1_SESSION_ROW_SELECT = {
    id: true,
    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    createdAt: true,
    updatedAt: true,
    meaningfulActivityAt: true,
    archivedAt: true,
    encryptionMode: true,
    metadata: true,
    metadataVersion: true,
    metadataLayoutVersion: true,
    ownerMetadata: true,
    agentState: true,
    agentStateVersion: true,
    pendingPermissionRequestCount: true,
    pendingUserActionRequestCount: true,
    latestTurnId: true,
    latestTurnStatus: true,
    latestTurnStatusObservedAt: true,
    lastRuntimeIssue: true,
    turns: SESSION_ROLLBACK_ELIGIBLE_TURNS_SELECT,
    pendingCount: true,
    pendingBlockedCount: true,
    pendingVersion: true,
    pendingActivationRequestId: true,
    pendingActivationRequestedAt: true,
    pendingActivationStatus: true,
    pendingActivationFailureCode: true,
    pendingActivationManagedTarget: true,
    active: true,
    lastActiveAt: true,
} as const satisfies Prisma.SessionSelect;

function createV1SessionShareSelect(sessionSelect: Prisma.SessionSelect = V1_SESSION_ROW_SELECT): Prisma.SessionShareSelect {
    return {
        accessLevel: true,
        canApprovePermissions: true,
        sharedByUserId: true,
        sharedByUser: { select: ACCOUNT_DISPLAY_PROFILE_SELECT },
        session: {
            select: sessionSelect,
        },
    };
}

const V1_SESSION_ROW_LEGACY_SELECT = omitSessionListProjectionFallbackColumns(V1_SESSION_ROW_SELECT);

async function findV1SessionListRows(userId: string, rowRepresentabilityWhere: Prisma.SessionWhereInput) {
    return await runWithSessionListProjectionFallback(
        () => findV1SessionListRowsWithSelect(userId, rowRepresentabilityWhere, V1_SESSION_ROW_SELECT),
        () => findV1SessionListRowsWithSelect(userId, rowRepresentabilityWhere, V1_SESSION_ROW_LEGACY_SELECT),
    );
}

async function findV1SessionListRowsWithSelect(userId: string, rowRepresentabilityWhere: Prisma.SessionWhereInput, sessionSelect: Prisma.SessionSelect) {
    const representabilityClauses = Object.keys(rowRepresentabilityWhere).length > 0
        ? [rowRepresentabilityWhere]
        : [];
    const [ownedBranches, shareBranches] = await Promise.all([
            Promise.all(createSessionTranscriptPublicationRecencyQueryBranches().map((branch) =>
                collectSessionTranscriptVisibleRowsBeforeTake({
                    take: 150,
                    fetchPage: async (page) =>
                        await db.session.findMany({
                            where: {
                                accountId: userId,
                                archivedAt: null,
                                AND: [branch.where, ...representabilityClauses, buildSessionAccessWhere({ accountId: userId, capability: "readTranscript", mode: "legacy_owner_or_direct" })],
                            },
                            orderBy: [...branch.orderBy],
                            ...(page.skip === undefined ? {} : { skip: page.skip }),
                            ...(page.take === undefined ? {} : { take: page.take }),
                            select: { ...sessionSelect, ...createSessionPersonalProjectionSelect(userId), ...createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: userId }) },
                        }),
                    isOwner: () => true,
                    readPublication: (session) => session,
                }),
            )),
            Promise.all(createSessionTranscriptShareableRecencyQueryBranches().map((branch) =>
                collectSessionTranscriptVisibleRowsBeforeTake({
                    take: 150,
                    fetchPage: async (page) =>
                        await db.sessionShare.findMany({
                            where: {
                                sharedWithUserId: userId,
                                session: {
                                    archivedAt: null,
                                    AND: [branch.where, ...representabilityClauses, buildSessionAccessWhere({ accountId: userId, capability: "readTranscript", mode: "legacy_owner_or_direct" })],
                                },
                            },
                            orderBy: branch.orderBy.map((orderBy) => ({ session: orderBy })),
                            ...(page.skip === undefined ? {} : { skip: page.skip }),
                            ...(page.take === undefined ? {} : { take: page.take }),
                            select: { ...createV1SessionShareSelect(sessionSelect), session: { select: { ...sessionSelect, ...createSessionPersonalProjectionSelect(userId), ...createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: userId }) } } },
                        }),
                    isOwner: () => false,
                    readPublication: (share) => share.session,
                }),
            )),
        ]);
        const ownedBySessionId = new Map(
            ownedBranches
                .flat()
                .map((session) => [session.id, session] as const),
        );
        const sharesBySessionId = new Map(
            shareBranches
                .flat()
                .map((share) => [share.session.id, share] as const),
        );
    return [[...ownedBySessionId.values()], [...sharesBySessionId.values()]] as const;
}

/** Retains the released V1 owner/direct projection and 150-row page. */
export async function listLegacyV1SessionsForAccount(params: Readonly<{
    userId: string;
    rowRepresentabilityWhere: Prisma.SessionWhereInput;
}>) {
    const { userId } = params;
    const [ownedSessions, shares] = await findV1SessionListRows(userId, params.rowRepresentabilityWhere);
    const emittedRows = [
        ...ownedSessions.map((session) => ({
            recipient: "owner" as const,
            session,
            updatedAt: projectSessionListingPublicationPreview(session).updatedAt,
        })),
        ...shares
            .filter((share) =>
                isSessionTranscriptShareable(share.session))
            .map((share) => ({
                recipient: "shared" as const,
                session: share.session,
                share,
                updatedAt: resolveSessionTranscriptNonOwnerRecencyMs(
                    share.session,
                    share.session.updatedAt,
                ),
            })),
    ]
        .sort((a, b) => b.updatedAt - a.updatedAt);
    const projectedRows = emittedRows
        .slice(0, 150);
    const ownerAccountModes =
        await readSessionListOwnerAccountModes(
            projectedRows.map((row) => row.session),
        );
    const discussionFacts = await readSessionListViewerDiscussionFacts(
        projectedRows.map((row) => row.session),
        userId,
    );
    const projectLegacyRow = (row: (typeof projectedRows)[number]) => {
        const v = row.session;
        const viewer = projectSessionViewer({
            row: v,
            viewerAccountId: userId,
            discussion: discussionFacts.get(v.id) ?? QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
        });
        const publicationProjection = projectSessionListingPublicationPreview(v);
        const hasLiveFacts = publicationProjection.hasLiveFacts;
        // "Which runtime facts may this V1 row publish" is one rule, and the V1
        // owner and shared recipients answer it identically — only the metadata
        // recipient, the data key and the share fields differ below. Stating it
        // once here is what keeps the rule in step with the selection predicate
        // that admits the row (`createFilteredSessionListWhere`).
        const liveFacts = {
            pendingPermissionRequestCount: hasLiveFacts ? v.pendingPermissionRequestCount : 0,
            pendingUserActionRequestCount: hasLiveFacts ? v.pendingUserActionRequestCount : 0,
            latestTurnId: hasLiveFacts ? v.latestTurnId ?? null : null,
            latestTurnStatus: hasLiveFacts ? parseStoredSessionLatestTurnStatus(v.latestTurnStatus) : null,
            latestTurnStatusObservedAt: hasLiveFacts
                ? readLatestTurnStatusObservedAt(v.latestTurnStatusObservedAt)
                : null,
            lastRuntimeIssue: hasLiveFacts ? parseStoredSessionRuntimeIssue(v.lastRuntimeIssue) : null,
            rollbackEligibleTurnStarts: filterSessionTranscriptPublicationSequenceFacts(
                readSessionTurnRollbackEligibleStarts(v),
                v,
            ),
            ...readSessionTranscriptAuthorityFields(v),
            acceptedThroughServerSeq: publicationProjection.acceptedThroughServerSeq,
            pendingCount: hasLiveFacts ? v.pendingCount : 0,
            pendingBlockedCount: hasLiveFacts ? v.pendingBlockedCount : 0,
            pendingVersion: hasLiveFacts ? v.pendingVersion : 0,
            ...(hasLiveFacts
                ? { pendingActivationAuthorization: mapPendingActivationAuthorization(v) }
                : {}),
        };
        if (row.recipient === "owner") {
            return {
                id: v.id,
                seq: publicationProjection.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: publicationProjection.updatedAt,
                meaningfulActivityAt: publicationProjection.meaningfulActivityAt,
                active: hasLiveFacts && v.active,
                activeAt: publicationProjection.activeAt,
                archivedAt: v.archivedAt?.getTime() ?? null,
                encryptionMode: v.encryptionMode === "plain" ? "plain" : "e2ee",
                ...projectSessionMetadataForRecipient({
                    session: v,
                    recipient:
                        requiresSessionMetadataOwnerAccountMode({
                            session: v,
                        }) && ownerAccountModes.has(v.accountId)
                            ? {
                                type: "owner",
                                accountId: userId,
                                accountMode: ownerAccountModes.get(v.accountId)!,
                              }
                            : {
                                type: "legacy_owner",
                                accountId: userId,
                              },
                }),
                viewer,
                lastViewedSessionSeq: projectLegacyViewerLastViewedSessionSeqV1({ readState: viewer.readState, visibleSessionSeq: publicationProjection.seq }),
                unreadSince: projectLegacyViewerUnreadSinceV1(viewer.readState),
                ...liveFacts,
                dataEncryptionKey: projectViewerSessionDataKey(v),
                lastMessage: null,
            };
        }

        const share = row.share;
        return {
            id: v.id,
            seq: publicationProjection.seq,
            createdAt: v.createdAt.getTime(),
            updatedAt: publicationProjection.updatedAt,
            meaningfulActivityAt: publicationProjection.meaningfulActivityAt,
            active: hasLiveFacts && v.active,
            activeAt: publicationProjection.activeAt,
            archivedAt: v.archivedAt?.getTime() ?? null,
            encryptionMode: v.encryptionMode === "plain" ? "plain" : "e2ee",
            ...projectSessionMetadataForRecipient({
                session: v,
                recipient: {
                    type: "shared",
                    accountId: userId,
                    ownerAccountMode: ownerAccountModes.get(v.accountId),
                },
            }),
            viewer,
            lastViewedSessionSeq: projectLegacyViewerLastViewedSessionSeqV1({ readState: viewer.readState, visibleSessionSeq: publicationProjection.seq }),
            unreadSince: projectLegacyViewerUnreadSinceV1(viewer.readState),
            ...liveFacts,
            dataEncryptionKey:
                v.encryptionMode === "plain"
                    ? null
                    : projectViewerSessionDataKey(v),
            lastMessage: null,
            owner: share.sharedByUserId,
            ownerProfile: toShareUserProfile(share.sharedByUser),
            accessLevel: share.accessLevel,
            canApprovePermissions: share.canApprovePermissions,
        };
    };

    const sessions: ReturnType<typeof projectLegacyRow>[] = [];
    let metadataUpgradeRequiredCount = 0;
    for (const row of projectedRows) {
        try {
            sessions.push(projectLegacyRow(row));
        } catch (error) {
            // Same per-row refusal the current list projection applies: an
            // unmigrated historical share is omitted with the count below,
            // never a request-wide refusal of every other readable row.
            if (!isSessionMetadataPrivacyUpgradeRequiredError(error)) throw error;
            metadataUpgradeRequiredCount += 1;
        }
    }
    return {
        sessions,
        ...(metadataUpgradeRequiredCount > 0 ? { metadataUpgradeRequiredCount } : {}),
    };
}
