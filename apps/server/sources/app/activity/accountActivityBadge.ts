import { db } from "@/storage/db";

export type SessionActivityBadgeInputs = Readonly<{
    seq?: number | null;
    pendingCount?: number | null;
    lastViewedSessionSeq?: number | null;
    pendingPermissionRequestCount?: number | null;
    pendingUserActionRequestCount?: number | null;
    active?: boolean | null;
    archivedAt?: Date | null;
}>;

type SessionActivityBadgeRow = Readonly<{
    accountId: string;
    seq: number | null;
    pendingCount: number | null;
    lastViewedSessionSeq: number | null;
    pendingPermissionRequestCount: number | null;
    pendingUserActionRequestCount: number | null;
    active: boolean;
    archivedAt: Date | null;
}>;

export function computeSessionContributesToActivityBadge(session: SessionActivityBadgeInputs): boolean {
    if (session.active === false) return false;
    if (session.archivedAt) return false;

    const seq = typeof session.seq === "number" ? session.seq : 0;
    const lastViewedSessionSeq = typeof session.lastViewedSessionSeq === "number" ? session.lastViewedSessionSeq : null;
    const pendingCount = typeof session.pendingCount === "number" ? session.pendingCount : 0;
    const pendingPermissionRequestCount =
        typeof session.pendingPermissionRequestCount === "number" ? session.pendingPermissionRequestCount : 0;
    const pendingUserActionRequestCount =
        typeof session.pendingUserActionRequestCount === "number" ? session.pendingUserActionRequestCount : 0;

    const hasUnread =
        typeof lastViewedSessionSeq === "number"
            ? seq > lastViewedSessionSeq
            : seq > 0;
    return hasUnread || pendingCount > 0 || pendingPermissionRequestCount > 0 || pendingUserActionRequestCount > 0;
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
            accountId: true,
            seq: true,
            pendingCount: true,
            lastViewedSessionSeq: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
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
