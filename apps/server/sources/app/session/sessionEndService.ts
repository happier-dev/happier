import { refreshSessionParticipantBadgePushes } from "@/app/activity/refreshAccountActivityBadgePushes";
import { didSessionActivityBadgeContributionChange } from "@/app/activity/accountActivityBadge";
import {
    buildSessionActivityEphemeral,
    buildUpdateSessionUpdate,
    type ClientConnection,
    eventRouter,
} from "@/app/events/eventRouter";
import { activityCache } from "@/app/presence/sessionCache";
import { db } from "@/storage/db";
import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1 } from "@happier-dev/protocol";
import { applySessionTurnMutation } from "./sessionWriteService";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { buildLegacySessionEndMutationIdentifier } from "./turns/legacySessionTurnIdentifiers";
import { markSessionParticipantsChanged, type SessionParticipantCursor } from "./changeTracking/markSessionParticipantsChanged";

const SESSION_END_STALE_WINDOW_MS = 1000 * 60 * 10;

function resolveSessionEndTime(rawTime: number, now: number): number {
    let time = Number.isFinite(rawTime) ? Math.max(0, Math.floor(rawTime)) : now;
    if (time > now) {
        time = now;
    }
    if (time < now - SESSION_END_STALE_WINDOW_MS) {
        return now;
    }
    return time;
}

function readMillis(value: unknown): number | null {
    if (typeof value === "bigint") {
        const millis = Number(value);
        return Number.isFinite(millis) ? millis : null;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (value instanceof Date) {
        const millis = value.getTime();
        return Number.isFinite(millis) ? millis : null;
    }
    return null;
}

function resolveLatestSessionActivityTime(session: {
    latestTurnStatusObservedAt?: unknown;
    meaningfulActivityAt?: unknown;
}): number | null {
    const candidates = [
        readMillis(session.latestTurnStatusObservedAt),
        readMillis(session.meaningfulActivityAt),
    ].filter((value): value is number => value !== null);
    if (candidates.length === 0) return null;
    return Math.max(...candidates);
}

export type ApplySessionEndResult =
    | { ok: true; applied: boolean; projection: SessionEndProjection }
    | { ok: false; error: "session-not-found" | "turn-terminalization-failed" };

type SessionEndProjection = Readonly<{
    active?: false;
    activeAt?: number;
    latestTurnId?: string | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
}>;

type SessionTurnTerminalizationResult = Awaited<ReturnType<typeof applySessionTurnMutation>>;

function didTurnTerminalizationKeepSessionInProgress(turnResult: SessionTurnTerminalizationResult | null | undefined): boolean {
    return turnResult !== null
        && turnResult !== undefined
        && turnResult.ok === true
        && turnResult.didApply === false
        && turnResult.latestTurnStatus === "in_progress";
}

export async function applySessionEnd(params: {
    actorUserId: string;
    sessionId: string;
    time: number;
    skipSenderConnection?: ClientConnection;
}): Promise<ApplySessionEndResult> {
    const { actorUserId, sessionId } = params;
    const now = Date.now();
    const observedTime = Number.isFinite(params.time)
        ? Math.max(0, Math.min(Math.floor(params.time), now))
        : now;
    const time = resolveSessionEndTime(params.time, now);
    const session = await db.session.findUnique({
        where: { id: sessionId, accountId: actorUserId },
        select: {
            id: true,
            seq: true,
            pendingCount: true,
            lastViewedSessionSeq: true,
            pendingPermissionRequestCount: true,
            pendingUserActionRequestCount: true,
            latestTurnId: true,
            latestTurnStatus: true,
            latestTurnStatusObservedAt: true,
            lastRuntimeIssue: true,
            meaningfulActivityAt: true,
            active: true,
            archivedAt: true,
        },
    });
    if (!session) {
        return { ok: false, error: "session-not-found" };
    }

    const latestActivityTime = resolveLatestSessionActivityTime(session);
    if (session.active && latestActivityTime !== null && observedTime < latestActivityTime) {
        return { ok: true, applied: false, projection: {} };
    }

    let turnResult: Awaited<ReturnType<typeof applySessionTurnMutation>> | null = null;
    if (session.latestTurnId && session.latestTurnStatus === "in_progress") {
        turnResult = await applySessionTurnMutation({
            actorUserId,
            mutation: {
                v: 1,
                sessionId,
                mutationId: buildLegacySessionEndMutationIdentifier({ sessionId, time }),
                action: "end_session",
                turnId: session.latestTurnId,
                observedAt: time,
            },
        });
        if (!turnResult || !turnResult.ok) {
            return { ok: false, error: "turn-terminalization-failed" };
        }
    }

    const didMarkInactive = session.active && !didTurnTerminalizationKeepSessionInProgress(turnResult);
    if (didMarkInactive) {
        activityCache.markSessionInactive(sessionId, actorUserId, time);
        await db.session.update({
            where: { id: sessionId },
            data: {
                lastActiveAt: new Date(time),
                active: false,
                thinking: false,
                thinkingAt: new Date(time),
            },
        });
    }

    const sessionProjection: SessionEndProjection = {
        ...(didMarkInactive
            ? {
                active: false,
                activeAt: time,
            }
            : {}),
        ...(turnResult?.ok && turnResult.didApply
            ? {
                latestTurnId: turnResult.latestTurnId,
                latestTurnStatus: turnResult.latestTurnStatus,
                latestTurnStatusObservedAt: turnResult.latestTurnStatusObservedAt,
                lastRuntimeIssue: turnResult.lastRuntimeIssue,
            }
            : {}),
    };
    const hasSessionProjection = Object.keys(sessionProjection).length > 0;
    const participantCursors: SessionParticipantCursor[] =
        turnResult?.ok && turnResult.didApply
            ? turnResult.participantCursors
            : didMarkInactive
                ? await markSessionParticipantsChanged({
                    tx: db,
                    sessionId,
                    hint: {
                        sessionEnd: true,
                        ...sessionProjection,
                    },
                })
                : [];

    if (hasSessionProjection) {
        await Promise.all(participantCursors.map(async ({ accountId, cursor }) => {
            const payload = buildUpdateSessionUpdate(
                sessionId,
                cursor,
                randomKeyNaked(12),
                undefined,
                undefined,
                sessionProjection,
            );
            eventRouter.emitUpdate({
                userId: accountId,
                payload,
                recipientFilter: { type: "all-interested-in-session", sessionId },
                ...(accountId === actorUserId && params.skipSenderConnection
                    ? { skipSenderConnection: params.skipSenderConnection }
                    : {}),
            });
        }));
    }

    if (!didMarkInactive) {
        return { ok: true, applied: Boolean(turnResult?.ok && turnResult.didApply), projection: sessionProjection };
    }

    await refreshSessionParticipantBadgePushes({
        badgeAttentionChanged: didSessionActivityBadgeContributionChange(session, {
            ...session,
            active: false,
        }),
        participantCursors: participantCursors.length > 0 ? participantCursors : [{ accountId: actorUserId }],
    });

    eventRouter.emitEphemeral({
        userId: actorUserId,
        payload: buildSessionActivityEphemeral(sessionId, false, time, false),
        recipientFilter: { type: "user-scoped-only" },
    });

    return { ok: true, applied: true, projection: sessionProjection };
}
