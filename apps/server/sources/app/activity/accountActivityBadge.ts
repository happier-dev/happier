import { inReadSnapshot, type Tx } from "@/storage/inTx";
import { QUIET_SESSION_PERSONAL_ATTENTION_V1, resolveSessionPersonalAttentionV1, type SessionPersonalAttentionProjectionV1 } from '@happier-dev/protocol/sessions/personal/attention';
import { projectViewerReadStateV1, type ViewerReadStateV1 } from '@happier-dev/protocol/sessions';

import {
    resolveEffectiveSessionAccessWhere,
    resolveSessionCollectiveAccessSnapshotsInTx,
} from "@/app/session/access/sessionAccessWhere";
import {
    countAccountPersonalAttentionRowsForAccountsInTx,
    type SessionPersonalAttentionAccountAdmission,
} from "@/app/session/personal/queries";
import { backgroundDeliveryAuthentication, type SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { readLiveNativeRequestCounts } from "@/app/session/personal/pendingRequestAttention";
import { parseStoredSessionRuntimeIssue } from "@/app/session/turns/parseSessionTurnState";
import {
    applySessionTranscriptPublicationCeilingToProjection,
    resolveSessionTranscriptPublicationCeiling,
    type SessionTranscriptPublicationFields,
} from "@/app/session/sessionTranscriptPublicationPolicy";

/**
 * Session-level facts that can change whether a Session is *capable* of
 * contributing to somebody's badge. This is a scheduling signal, not the count:
 * viewer read state is deliberately absent because a cursor move already
 * schedules its own Account, and mixing the two is what let a shared cursor
 * decide other Accounts' badges.
 */
export type SessionActivityBadgeInputs = SessionTranscriptPublicationFields & Readonly<{
    seq?: number | null;
    pendingCount?: number | null;
    pendingBlockedCount?: number | null;
    lastViewedSessionSeq?: number | null;
    pendingPermissionRequestCount?: number | null;
    pendingUserActionRequestCount?: number | null;
    latestReadyEventSeq?: number | null;
    latestFailureSeq?: number | null;
    latestTurnStatus?: string | null;
    lastRuntimeIssue?: string | null;
    active?: boolean | null;
    archivedAt?: Date | null;
}>;

/** One viewer's badge inputs for one Session. */
export type SessionViewerBadgeInputs = SessionActivityBadgeInputs & Readonly<{
    viewerReadState: ViewerReadStateV1;
    /** Owner-or-active-Follow. Without it the Session is quiet for this viewer. */
    tracked: boolean;
    accessible?: boolean;
    responsible?: boolean;
    capabilities?: Readonly<{ canSubmitAgentInput: boolean; canApprovePermissions: boolean }>;
    /**
     * Lane 05's baseline-derived conversation facts for this viewer. Absent for
     * a caller that carries only Session-level facts; the canonical count query
     * composes them through the personal owner's projection.
     */
    discussion?: Readonly<{ hasUnread: boolean; hasMention: boolean }>;
    attentionStanding?: "none" | "positive" | "negative";
    reminderDue?: boolean;
}>;

function normalizeCount(value: number | null | undefined): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function hasCanonicalPrimarySessionFailure(session: SessionActivityBadgeInputs): boolean {
    if (session.latestTurnStatus !== "failed") return false;
    const issue = parseStoredSessionRuntimeIssue(session.lastRuntimeIssue);
    return issue !== null && issue.scope === "primary_session" && issue.status === "failed";
}

/**
 * Projects one Session row plus one viewer relation into the canonical personal
 * attention decision. Badge counting, list confirmation and Activity therefore
 * share one derivation instead of three that disagreed about blocked pending
 * delivery, ready-after-read and what counts as a runtime failure.
 */
export function resolveSessionViewerActivityAttention(
    session: SessionViewerBadgeInputs,
): SessionPersonalAttentionProjectionV1 {
    // Activity and app badges are active-corpus surfaces. Keep that storage
    // policy at this adapter rather than suppressing archived rows requested
    // by the archive list inside the canonical attention resolver.
    if (session.archivedAt !== null && session.archivedAt !== undefined) {
        return QUIET_SESSION_PERSONAL_ATTENTION_V1;
    }
    const hasLiveFacts = resolveSessionTranscriptPublicationCeiling(session) === null;
    const nativeRequests = readLiveNativeRequestCounts(session, hasLiveFacts);
    const projection = applySessionTranscriptPublicationCeilingToProjection({
        seq: typeof session.seq === "number" ? session.seq : 0,
        latestReadyEventSeq: typeof session.latestReadyEventSeq === "number" ? session.latestReadyEventSeq : null,
    }, session);
    const capabilities = session.capabilities ?? { canSubmitAgentInput: true, canApprovePermissions: true };

    return resolveSessionPersonalAttentionV1({
        tracked: session.tracked,
        accessible: session.accessible ?? true,
        accountSuspended: false,
        contentAvailable: true,
        visibleSessionSeq: Math.max(0, Math.trunc(projection.seq)),
        readState: session.viewerReadState,
        latestReadyEventSeq: typeof projection.latestReadyEventSeq === "number"
            ? projection.latestReadyEventSeq
            : null,
        hasPrimarySessionFailure: hasLiveFacts && hasCanonicalPrimarySessionFailure(session),
        latestFailureSeq: hasLiveFacts ? session.latestFailureSeq ?? null : null,
        pendingBlockedCount: hasLiveFacts ? normalizeCount(session.pendingBlockedCount) : 0,
        pendingPermissionRequestCount: normalizeCount(nativeRequests.permission),
        pendingUserActionRequestCount: normalizeCount(nativeRequests.userAction),
        capabilities,
        responsible: session.responsible ?? false,
        discussion: session.discussion ?? { hasUnread: false, hasMention: false },
        attentionStanding: session.attentionStanding ?? "none",
        reminderDue: session.reminderDue === true,
    });
}

export function computeSessionContributesToActivityBadge(session: SessionViewerBadgeInputs): boolean {
    return resolveSessionViewerActivityAttention(session).needsAttention;
}

/**
 * Whether a Session-level change is worth recomputing tracked Accounts' badges.
 * It compares operational attention presence, never ordinary transcript sequence
 * advances or count changes that keep attention present (owner D6, 2026-11-04).
 * The read owner schedules its own Account directly when a frontier moves.
 */
export function didSessionActivityBadgeSignalChange(
    before: SessionActivityBadgeInputs,
    after: SessionActivityBadgeInputs,
): boolean {
    const signal = (session: SessionActivityBadgeInputs) => {
        const hasLiveFacts = resolveSessionTranscriptPublicationCeiling(session) === null;
        const nativeRequests = readLiveNativeRequestCounts(session, hasLiveFacts);
        const projection = applySessionTranscriptPublicationCeilingToProjection({
            seq: typeof session.seq === "number" ? session.seq : 0,
            latestReadyEventSeq: typeof session.latestReadyEventSeq === "number" ? session.latestReadyEventSeq : null,
        }, session);
        return [
            session.archivedAt ? 1 : 0,
            typeof projection.latestReadyEventSeq === "number" ? projection.latestReadyEventSeq : -1,
            hasLiveFacts && hasCanonicalPrimarySessionFailure(session) ? 1 : 0,
            hasLiveFacts && normalizeCount(session.pendingBlockedCount) > 0 ? 1 : 0,
            normalizeCount(nativeRequests.permission) > 0 ? 1 : 0,
            normalizeCount(nativeRequests.userAction) > 0 ? 1 : 0,
        ].join(":");
    };
    return signal(before) !== signal(after);
}

/**
 * Whether one viewer's badge contribution changes as its own frontier moves.
 * Read state is viewer-private, so this comparison is always scoped to the one
 * Account whose cursor moved.
 */
export function didViewerActivityBadgeContributionChange(
    session: SessionActivityBadgeInputs,
    beforeLastViewedSessionSeq: number | null | undefined,
    afterLastViewedSessionSeq: number | null | undefined,
): boolean {
    const visibleSessionSeq = Math.max(0, Math.trunc(
        applySessionTranscriptPublicationCeilingToProjection(
            { seq: typeof session.seq === "number" ? session.seq : 0 },
            session,
        ).seq,
    ));
    const contributes = (cursor: number | null | undefined): boolean =>
        computeSessionContributesToActivityBadge({
            ...session,
            tracked: true,
            viewerReadState: projectViewerReadStateV1({
                tracked: true,
                row: typeof cursor === "number" ? { lastViewedSessionSeq: cursor, unreadSince: null } : null,
                visibleSessionSeq,
            }),
        });
    return contributes(beforeLastViewedSessionSeq) !== contributes(afterLastViewedSessionSeq);
}

/**
 * Count viewer-private Session and first-class Discussion attention for
 * background badge refresh, deduplicating counted Session anchors.
 *
 * Background refresh presents no credential, so it reads the one access owner
 * with the evidence it actually has. A restricted Team therefore contributes to
 * a recipient's badge only while it qualifies without evidence; owner, direct
 * and inherited-authentication arms are unaffected.
 */
export async function computeAccountActivityBadgeCounts(
    accountIds: ReadonlyArray<string>,
): Promise<Map<string, number>> {
    return await computeAccountActivityBadgeCountsForAuthentication(
        accountIds,
        backgroundDeliveryAuthentication(),
    );
}

/** Request-bound badge snapshot using that request's exact verified credential evidence. */
export async function computeAuthenticatedAccountActivityBadgeCount(
    accountId: string,
    authentication: SessionAccessAuthentication,
): Promise<number> {
    return (await computeAccountActivityBadgeCountsForAuthentication(
        [accountId],
        authentication,
    )).get(accountId) ?? 0;
}

async function computeAccountActivityBadgeCountsForAuthentication(
    accountIds: ReadonlyArray<string>,
    authentication: SessionAccessAuthentication,
): Promise<Map<string, number>> {
    return await inReadSnapshot(async (tx) => await computeAccountActivityBadgeCountsInTx(tx, accountIds, authentication));
}

/**
 * The counting owner itself, for a caller that already holds the transaction the
 * count must be consistent with.
 */
export async function computeAccountActivityBadgeCountsInTx(
    tx: Tx,
    accountIds: ReadonlyArray<string>,
    authentication: SessionAccessAuthentication,
): Promise<Map<string, number>> {
    const ids = [...new Set(accountIds.filter(id => id.trim().length > 0))];
    const counts = new Map(ids.map((accountId) => [accountId, 0]));
    if (ids.length === 0) return counts;

    const activeAccounts = await tx.account.findMany({
        where: { id: { in: ids }, status: "active" },
        select: { id: true },
    });
    const activeAccountIds = activeAccounts.map((account) => account.id);
    if (activeAccountIds.length === 0) return counts;

    // One batch is one credential context, so its memberships and Team
    // qualification are read once here instead of once per Account below.
    const collectiveAccessSnapshots = await resolveSessionCollectiveAccessSnapshotsInTx(tx, {
        accountIds: activeAccountIds,
        authentication,
    });
    const admissions: SessionPersonalAttentionAccountAdmission[] = [];
    for (const accountId of activeAccountIds) {
        const collectiveAccessSnapshot = collectiveAccessSnapshots.get(accountId);
        const access = await resolveEffectiveSessionAccessWhere({
            tx,
            accountId,
            capability: "readTranscript",
            mode: "effective_access_v1",
            authentication,
            ...(collectiveAccessSnapshot ? { collectiveAccessSnapshot } : {}),
        });
        admissions.push({
            accountId,
            accessWhere: access.where,
            qualifiedTeamIds: access.qualifiedTeamIds,
        });
    }

    const grouped = await countAccountPersonalAttentionRowsForAccountsInTx(tx, {
        admissions,
        authentication,
    });
    for (const accountId of activeAccountIds) {
        counts.set(accountId, grouped.get(accountId) ?? 0);
    }
    return counts;
}
