import { db } from "@/storage/db";
import {
    applySessionTranscriptPublicationCeilingToProjection,
    resolveSessionTranscriptPublicationCeiling,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
    type SessionTranscriptPublicationFields,
} from "@/app/session/sessionTranscriptPublicationPolicy";

export type SessionActivityBadgeInputs = SessionTranscriptPublicationFields & Readonly<{
    seq?: number | null;
    pendingCount?: number | null;
    pendingBlockedCount?: number | null;
    lastViewedSessionSeq?: number | null;
    pendingPermissionRequestCount?: number | null;
    pendingUserActionRequestCount?: number | null;
    latestTurnStatus?: string | null;
    lastRuntimeIssue?: string | null;
    active?: boolean | null;
    archivedAt?: Date | null;
}>;

type SessionActivityBadgeRow = Readonly<{
    accountId: string;
    seq: number | null;
    currentStorageState: string;
    acceptedThroughServerSeq: number | null;
    materializationPublicationId: string | null;
    materializedThroughSourceAt: bigint | null;
    publishedThroughServerSeq: number | null;
    pendingCount: number | null;
    pendingBlockedCount: number | null;
    lastViewedSessionSeq: number | null;
    pendingPermissionRequestCount: number | null;
    pendingUserActionRequestCount: number | null;
    latestTurnStatus: string | null;
    lastRuntimeIssue: string | null;
    active: boolean;
    archivedAt: Date | null;
}>;

export function computeSessionContributesToActivityBadge(session: SessionActivityBadgeInputs): boolean {
    const hasLiveFacts = resolveSessionTranscriptPublicationCeiling(session) === null;
    if (hasLiveFacts && session.active === false) return false;
    if (session.archivedAt) return false;

    const publicationProjection = applySessionTranscriptPublicationCeilingToProjection({
        seq: typeof session.seq === "number" ? session.seq : 0,
        lastViewedSessionSeq:
            typeof session.lastViewedSessionSeq === "number"
                ? session.lastViewedSessionSeq
                : session.lastViewedSessionSeq ?? null,
    }, session);
    const seq = publicationProjection.seq;
    const lastViewedSessionSeq = publicationProjection.lastViewedSessionSeq;
    const pendingPermissionRequestCount =
        hasLiveFacts && typeof session.pendingPermissionRequestCount === "number"
            ? session.pendingPermissionRequestCount
            : 0;
    const pendingUserActionRequestCount =
        hasLiveFacts && typeof session.pendingUserActionRequestCount === "number"
            ? session.pendingUserActionRequestCount
            : 0;
    const pendingBlockedCount =
        hasLiveFacts && typeof session.pendingBlockedCount === "number"
            ? session.pendingBlockedCount
            : 0;
    const hasFailedPrimaryRuntimeIssue =
        hasLiveFacts
        && session.latestTurnStatus === "failed"
        && typeof session.lastRuntimeIssue === "string"
        && session.lastRuntimeIssue.trim().length > 0;

    const hasUnread =
        typeof lastViewedSessionSeq === "number"
            ? seq > lastViewedSessionSeq
            : seq > 0;
    return hasFailedPrimaryRuntimeIssue
        || hasUnread
        || pendingPermissionRequestCount > 0
        || pendingUserActionRequestCount > 0
        || pendingBlockedCount > 0;
}

export function didSessionActivityBadgeContributionChange(
    before: SessionActivityBadgeInputs,
    after: SessionActivityBadgeInputs,
): boolean {
    return computeSessionContributesToActivityBadge(before) !== computeSessionContributesToActivityBadge(after);
}

export async function computeAccountActivityBadgeCounts(accountIds: ReadonlyArray<string>): Promise<Map<string, number>> {
    const normalizedAccountIds = [...new Set(accountIds.filter((accountId) => typeof accountId === "string" && accountId.trim().length > 0))];
    const counts = new Map<string, number>();
    for (const accountId of normalizedAccountIds) {
        counts.set(accountId, 0);
    }
    if (normalizedAccountIds.length === 0) return counts;

    const sessions = await db.session.findMany({
        where: {
            accountId: { in: normalizedAccountIds },
            active: true,
            archivedAt: null,
        },
        select: {
            ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
            pendingCount: true,
            pendingBlockedCount: true,
            lastViewedSessionSeq: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            latestTurnStatus: true,
            lastRuntimeIssue: true,
            active: true,
            archivedAt: true,
        },
    });

    for (const session of sessions satisfies ReadonlyArray<SessionActivityBadgeRow>) {
        if (!computeSessionContributesToActivityBadge(session)) continue;
        counts.set(session.accountId, (counts.get(session.accountId) ?? 0) + 1);
    }

    return counts;
}
