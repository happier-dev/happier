import type { Prisma } from "@prisma/client";
import { isSessionPersonallyTrackedV1 } from '@happier-dev/protocol/sessions/personal/tracking';
import { projectViewerReadStateV1, resolveSessionPersonalRelevanceV1 } from '@happier-dev/protocol/sessions';
import { resolveSessionEffectiveNotificationV1 } from '@happier-dev/protocol/sessions/personal/eventEligibility';
import { resolveSessionPersonalAttentionV1 } from '@happier-dev/protocol/sessions/personal/attention';
import { type SessionViewerProjectionV1 } from '@happier-dev/protocol/sessions/personal/viewer';
import { projectSessionFollowDefaultRelationshipsV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';

import { inReadSnapshot, type Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import type { AccountRecipientEnvelopeReadinessReadScope } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import {
    buildSessionAccessProjectionSelect,
    buildSessionAccessProjectionSelectForAccounts,
    projectEffectiveSessionAccess,
    type EffectiveSessionAccess,
    type SessionAccessProjectionContext,
} from "@/app/session/access/sessionAccess";
import { resolveEffectiveSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import { applySessionTranscriptPublicationCeilingToProjection, resolveSessionTranscriptPublicationCeiling } from "@/app/session/sessionTranscriptPublicationPolicy";
import { parseStoredSessionRuntimeIssue, parseStoredSessionTurnTranscriptAnchors } from "@/app/session/turns/parseSessionTurnState";
import {
    createSessionDataKeyEnvelopeViewerSelect,
    resolveViewerSessionNotificationContentAvailability,
} from "@/app/session/encryption/sessionDataKeyEnvelopePersistence";
import {
    loadSessionPersonalDiscussionFactsInTx,
    QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
    type SessionPersonalDiscussionFacts,
} from "./discussionFacts";
import { projectSessionFollowFacts } from "./followFacts";
import { loadSessionRuleReadStatesInTx, type SessionRuleReadStates } from "./readState";

/** Select only the requesting Account's private relations beside canonical access facts. */
export function createSessionPersonalProjectionSelect(accountId: string, context: SessionAccessProjectionContext = {}) {
    return {
        ...buildSessionAccessProjectionSelect(accountId, context),
        archivedAt: true,
        responsibleAccountId: true,
        latestReadyEventSeq: true,
        latestTurnId: true,
        latestTurnStatus: true,
        lastRuntimeIssue: true,
        pendingBlockedCount: true,
        pendingPermissionRequestCount: true,
        pendingSharedActionConfirmationCount: true,
        pendingUserActionRequestCount: true,
        // Lane 04's derived authenticated-authorship projection, bounded by its
        // `[authorAccountId, sessionId]` index. Existence is the whole fact; no
        // transcript row, content, or count is read here.
        messages: { where: { authorAccountId: accountId }, take: 1, select: { id: true } },
        accountReadStates: { where: { accountId }, select: { accountId: true, lastViewedSessionSeq: true, unreadSince: true } },
        accountFollows: { where: { accountId }, select: { accountId: true, following: true, includeInVoice: true,
            followPolicy: true, notifyOnce: true, hasPersistentFollow: true } },
        sessionPins: { where: { accountId }, select: { accountId: true } },
        sessionAttentionStandings: { where: { accountId }, select: { accountId: true, standing: true, remindAt: true } },
        ...createSessionDataKeyEnvelopeViewerSelect({ viewerAccountId: accountId }),
    } as const satisfies Prisma.SessionSelect;
}

/** Content-free subset for exact attention membership and badge counting. */
export function createSessionPersonalAttentionProjectionSelect(accountId: string) {
    return createSessionPersonalAttentionProjectionSelectForAccounts([accountId]);
}

/**
 * The set-oriented sibling used by Account-grouped badge counting. Every
 * viewer-private relation is restricted to the requested Accounts while the
 * access projection stays owned by Lane 04's canonical multi-Account select.
 */
export function createSessionPersonalAttentionProjectionSelectForAccounts(accountIds: readonly string[]) {
    const ids = [...new Set(accountIds)];
    return {
        ...buildSessionAccessProjectionSelectForAccounts(ids),
        archivedAt: true,
        responsibleAccountId: true,
        latestReadyEventSeq: true,
        latestTurnId: true,
        latestTurnStatus: true,
        lastRuntimeIssue: true,
        pendingBlockedCount: true,
        pendingPermissionRequestCount: true,
        pendingSharedActionConfirmationCount: true,
        pendingUserActionRequestCount: true,
        accountReadStates: {
            where: { accountId: { in: ids } },
            select: { accountId: true, lastViewedSessionSeq: true, unreadSince: true },
        },
        accountFollows: {
            where: { accountId: { in: ids } },
            select: { accountId: true, following: true, followPolicy: true, notifyOnce: true, hasPersistentFollow: true },
        },
        sessionAttentionStandings: {
            where: { accountId: { in: ids } },
            select: { accountId: true, standing: true, remindAt: true },
        },
    } as const satisfies Prisma.SessionSelect;
}

type SelectedSessionPersonalProjectionRow = Prisma.SessionGetPayload<{ select: ReturnType<typeof createSessionPersonalProjectionSelect> }>;
type SelectedSessionPersonalAttentionProjectionRow = Prisma.SessionGetPayload<{
    select: ReturnType<typeof createSessionPersonalAttentionProjectionSelect>;
}>;
export type SessionPersonalAttentionProjectionRow = Omit<SelectedSessionPersonalAttentionProjectionRow, "responsibleAccountId">
    & Partial<Pick<SelectedSessionPersonalAttentionProjectionRow, "responsibleAccountId">>;
export type SessionPersonalProjectionRow = Omit<SelectedSessionPersonalProjectionRow, "responsibleAccountId">
    & Partial<Pick<SelectedSessionPersonalProjectionRow, "responsibleAccountId">>;

/** Exact current failed turns only, shared by row, badge and coordinator batches. */
export async function loadSessionLatestFailureSequencesInTx(
    tx: Pick<Tx, "sessionTurn">,
    rows: readonly Readonly<{ id: string; latestTurnId: string | null; latestTurnStatus: string | null }>[],
    observedSequences?: ReadonlyMap<string, number | null>,
): Promise<ReadonlyMap<string, number>> {
    const failures = rows.flatMap(row => !observedSequences?.has(row.id) && row.latestTurnStatus === "failed" && row.latestTurnId
        ? [{ sessionId: row.id, turnId: row.latestTurnId }] : []);
    const sequences = new Map<string, number>();
    for (const row of rows) {
        const observed = observedSequences?.get(row.id);
        if (typeof observed === "number") sequences.set(row.id, observed);
    }
    // Two identity binds per pair plus status and Prisma's OFFSET bind; the existing
    // portable provider boundary owns chunking, never a Session-history limit.
    for (const chunk of portableQueryChunks({ values: failures, bindingsPerValue: 2, fixedBindings: 2 })) {
        const turns = await tx.sessionTurn.findMany({
            where: { status: "failed", OR: [...chunk] },
            select: { sessionId: true, transcriptAnchorsJson: true },
        });
        for (const turn of turns) {
            const seq = parseStoredSessionTurnTranscriptAnchors(turn.transcriptAnchorsJson)?.endSeqInclusive;
            if (typeof seq === "number") sequences.set(turn.sessionId, seq);
        }
    }
    return sequences;
}

export function resolveSessionAttentionStandingProjectionFacts(
    standing: Readonly<{ standing: boolean; remindAt: Date | null }> | null | undefined,
    now: number,
): Readonly<{
    attentionStanding: 'none' | 'positive' | 'negative';
    explicitAttention: boolean;
    reminderDue: boolean;
}> {
    const remindAt = standing?.remindAt ?? null;
    const hasReminder = remindAt !== null;
    return {
        attentionStanding: hasReminder ? 'none' : standing ? standing.standing ? 'positive' : 'negative' : 'none',
        explicitAttention: standing?.standing === true || hasReminder,
        reminderDue: remindAt !== null && remindAt.getTime() <= now,
    };
}

/**
 * Pure composition of authorized storage facts into the one Protocol personal
 * decision.
 *
 * Discussion facts arrive as an explicit argument because they live in Lane 05's
 * own store and require a cross-model cursor comparison no `Session` select can
 * express. A caller with no conversation facts to compose passes
 * `QUIET_SESSION_PERSONAL_DISCUSSION_FACTS` deliberately rather than defaulting
 * into a silent "no discussions" claim.
 */
function projectSessionViewerAttentionState(params: Readonly<{
    row: SessionPersonalAttentionProjectionRow;
    latestFailureSeq: number | null;
    viewerAccountId: string;
    discussion: SessionPersonalDiscussionFacts;
    contentAvailable: boolean;
    qualifiedTeamIds?: ReadonlySet<string>;
    /** Exact access already admitted by the canonical point-operation owner. */
    effectiveAccess?: EffectiveSessionAccess;
    now?: number;
}>) {
    const { row, viewerAccountId, discussion } = params;
    const now = params.now ?? Date.now();
    const access = params.effectiveAccess ?? projectEffectiveSessionAccess(row, viewerAccountId, {
        qualifiedTeamIds: params.qualifiedTeamIds,
    });
    const follow = projectSessionFollowFacts(row.accountFollows?.find(value => value.accountId === viewerAccountId) ?? null);
    const tracked = isSessionPersonallyTrackedV1({ ownerAccountId: row.accountId, viewerAccountId, followFacts: follow });
    const sequences = applySessionTranscriptPublicationCeilingToProjection({ seq: row.seq, latestReadyEventSeq: row.latestReadyEventSeq }, row);
    const readRow = row.accountReadStates?.find(value => value.accountId === viewerAccountId);
    // The viewer's own frontier row is always that viewer's data: it exists only
    // through owner initialization, Follow entry, or the viewer's own explicit
    // mark-read/mark-unread, so it projects whether or not owner-or-Follow
    // tracking currently holds. `tracked` still gates attention, badges and
    // automatic stamping below.
    const readState = projectViewerReadStateV1({
        tracked: tracked || readRow !== undefined,
        row: readRow ? { lastViewedSessionSeq: readRow.lastViewedSessionSeq, unreadSince: readRow.unreadSince?.getTime() ?? null } : null,
        visibleSessionSeq: sequences.seq,
    });
    const standing = row.sessionAttentionStandings?.find(value => value.accountId === viewerAccountId);
    const standingFacts = resolveSessionAttentionStandingProjectionFacts(standing, now);
    const ownedByMe = row.accountId === viewerAccountId;
    const responsible = row.responsibleAccountId === viewerAccountId;
    const live = resolveSessionTranscriptPublicationCeiling(row) === null;
    const issue = live ? parseStoredSessionRuntimeIssue(row.lastRuntimeIssue) : null;
    const hasPrimarySessionFailure = row.latestTurnStatus === "failed" && issue?.scope === "primary_session" && issue.status === "failed";
    const latestFailureSeq = hasPrimarySessionFailure && params.latestFailureSeq !== null
        && params.latestFailureSeq <= sequences.seq ? params.latestFailureSeq : null;
    const attention = resolveSessionPersonalAttentionV1({
        tracked, accessible: access?.capabilities.readTranscript === true, accountSuspended: false,
        contentAvailable: params.contentAvailable,
        visibleSessionSeq: sequences.seq, readState,
        latestReadyEventSeq: sequences.latestReadyEventSeq ?? null,
        latestFailureSeq,
        hasPrimarySessionFailure,
        pendingBlockedCount: live ? row.pendingBlockedCount : 0,
        pendingPermissionRequestCount: live ? row.pendingPermissionRequestCount + row.pendingSharedActionConfirmationCount : 0,
        pendingUserActionRequestCount: live ? row.pendingUserActionRequestCount : 0,
        capabilities: {
            canSubmitAgentInput: access?.capabilities.submitAgentInput === true,
            canApprovePermissions: access?.capabilities.approveRuntimePermissions === true,
        },
        responsible,
        discussion: { hasUnread: discussion.hasUnread, hasMention: discussion.hasMention },
        attentionStanding: standingFacts.attentionStanding,
        reminderDue: standingFacts.reminderDue,
        onceDelivery: follow.onceDelivery,
    });
    return { access, attention, follow, latestFailureSeq, now, ownedByMe, readState, responsible, standing };
}

/** Content-free personal facts for exact attention, badges and coordinator summaries. */
export function projectSessionViewerAttention(params: Readonly<{
    row: SessionPersonalAttentionProjectionRow;
    latestFailureSeq: number | null;
    viewerAccountId: string;
    discussion: SessionPersonalDiscussionFacts;
    qualifiedTeamIds?: ReadonlySet<string>;
    now?: number;
}>) {
    // Availability changes only `presentation`; these callers consume only
    // membership/reasons and deliberately do not select content or key bytes.
    return projectSessionViewerAttentionState({ ...params, contentAvailable: false }).attention;
}

/** Exact membership for bounded content-free attention and badge scans. */
export function doesSessionViewerNeedAttention(params: Parameters<typeof projectSessionViewerAttention>[0]) {
    return projectSessionViewerAttention(params).needsAttention;
}

export function projectSessionViewer(params: Readonly<{
    row: SessionPersonalProjectionRow;
    latestFailureSeq: number | null;
    ruleReadStates?: SessionRuleReadStates;
    viewerAccountId: string;
    discussion: SessionPersonalDiscussionFacts;
    qualifiedTeamIds?: ReadonlySet<string>;
    /** Exact access already admitted by the canonical point-operation owner. */
    effectiveAccess?: EffectiveSessionAccess;
    recipientReadiness?: AccountRecipientEnvelopeReadinessReadScope;
    now?: number;
}>): SessionViewerProjectionV1 {
    const { row, viewerAccountId, discussion } = params;
    const state = projectSessionViewerAttentionState({
        ...params,
        contentAvailable: resolveViewerSessionNotificationContentAvailability(row, params.recipientReadiness),
    });
    return {
        readState: state.readState,
        ...(params.ruleReadStates?.length ? { ruleReadStates: params.ruleReadStates } : {}),
        latestFailureSeq: state.latestFailureSeq,
        follow: { ...state.follow, ...(state.access && row.responsibleAccountId !== undefined ? {
            defaultRelationships: projectSessionFollowDefaultRelationshipsV1({ responsibleForMe: state.responsible,
                relationshipKinds: state.access.relationshipKinds }),
        } : {}) },
        notification: resolveSessionEffectiveNotificationV1({ facts: state.follow, isSessionOwner: state.ownedByMe }),
        relevance: resolveSessionPersonalRelevanceV1({
            ownedByMe: state.ownedByMe, responsibleForMe: state.responsible,
            // The bounded relationship the access owner actually applied, not a
            // raw share scan: a share the publication/horizon rules excluded is
            // not a genuine direct share.
            sharedDirectlyWithMe: !state.ownedByMe && state.access?.relationshipKinds.includes("direct") === true,
            // Human-origin authorship is the existential OR of Lane 04's
            // transcript fact and Lane 05's discussion fact; an Agent row that
            // merely records an execution or requesting Account is in neither.
            authoredByMe: (row.messages?.length ?? 0) > 0 || discussion.authored,
            mentionedInDiscussion: discussion.mentioned,
            followedByMe: state.follow.follows,
            followOnce: Boolean(state.follow.once || state.follow.onceDelivery),
            pinnedByMe: row.sessionPins?.some(value => value.accountId === viewerAccountId) === true,
            explicitAttention: resolveSessionAttentionStandingProjectionFacts(
                state.standing,
                state.now,
            ).explicitAttention,
        }),
        // Existing mentions that are already read remain relevance, never
        // ongoing attention; the state above used baseline-derived facts only.
        attention: state.attention,
    };
}

/** Current Account/access admission also protects private read acknowledgments and push candidates. */
export async function loadSessionViewerProjection(params: Readonly<{ accountId: string; sessionId: string; authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication }>): Promise<SessionViewerProjectionV1 | null> {
    return inReadSnapshot(async tx => {
        const accessResolution = await resolveEffectiveSessionAccessWhere({
            tx,
            accountId: params.accountId,
            capability: "readTranscript",
            mode: "effective_access_v1",
            authentication: params.authentication,
        });
        const row = await tx.session.findFirst({
            where: { AND: [{ id: params.sessionId }, accessResolution.where] },
            select: createSessionPersonalProjectionSelect(params.accountId),
        });
        if (!row) return null;
        const failureSequences = await loadSessionLatestFailureSequencesInTx(tx, [row]);
        const ruleReadStates = await loadSessionRuleReadStatesInTx(tx, {
            ...params, rows: [row], collectiveAccessSnapshot: accessResolution.collectiveAccessSnapshot,
        });
        const discussion = await loadSessionPersonalDiscussionFactsInTx(tx, {
            accountId: params.accountId,
            sessionIds: [params.sessionId],
        });
        return projectSessionViewer({
            row,
            latestFailureSeq: failureSequences.get(row.id) ?? null,
            ruleReadStates: ruleReadStates.get(row.id),
            viewerAccountId: params.accountId,
            discussion: discussion.get(params.sessionId) ?? QUIET_SESSION_PERSONAL_DISCUSSION_FACTS,
            qualifiedTeamIds: accessResolution.qualifiedTeamIds,
        });
    });
}
