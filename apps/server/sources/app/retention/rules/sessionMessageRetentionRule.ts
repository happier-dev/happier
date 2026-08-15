import type { Prisma } from '@prisma/client';

import { activityCache } from '@/app/presence/sessionCache';
import { db } from '@/storage/db';

const DEFAULT_MIN_TAIL_MESSAGES = 500;

type RetentionSessionMessageSession = Readonly<{
    id: string;
    seq: number | null;
    lastViewedSessionSeq: number | null;
    latestReadyEventSeq: number | null;
}>;

export type SessionMessageRetentionCursor = Readonly<{
    sessionId: string;
    afterSeq: number | null;
    afterMessageId: string | null;
}>;

function positiveIntOrDefault(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value));
}

function positiveFloor(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return null;
    return Math.floor(value);
}

export function resolveSessionMessagePreserveFromSeq(
    session: RetentionSessionMessageSession,
    minTailMessages: number,
): number {
    const floors: number[] = [];
    const seq = positiveFloor(session.seq);
    if (seq !== null) {
        floors.push(Math.max(1, seq - minTailMessages + 1));
    }
    const lastViewedSessionSeq = positiveFloor(session.lastViewedSessionSeq);
    if (lastViewedSessionSeq !== null) {
        floors.push(lastViewedSessionSeq);
    }
    const latestReadyEventSeq = positiveFloor(session.latestReadyEventSeq);
    if (latestReadyEventSeq !== null) {
        floors.push(latestReadyEventSeq);
    }
    return floors.length > 0 ? Math.min(...floors) : 1;
}

function staleInactiveSessionWhere(cutoff: Date): Prisma.SessionWhereInput {
    return {
        active: false,
        updatedAt: { lt: cutoff },
        lastActiveAt: { lt: cutoff },
    };
}

async function pruneSessionMessagePage(params: {
    cutoff: Date;
    sessionPageSize: number;
    deleteLimit: number;
    dryRun: boolean;
    minTailMessages?: number;
    startCursor?: SessionMessageRetentionCursor | null;
}): Promise<{
    deleted: number;
    candidatesExamined: number;
    nextCursor: SessionMessageRetentionCursor | null;
    hasMore: boolean;
}> {
    const sessionPageSize = positiveIntOrDefault(params.sessionPageSize, 1);
    const deleteLimit = positiveIntOrDefault(params.deleteLimit, 1);
    const minTailMessages = positiveIntOrDefault(params.minTailMessages, DEFAULT_MIN_TAIL_MESSAGES);
    const sessionWhere = staleInactiveSessionWhere(params.cutoff);
    const resumesWithinSession = params.startCursor !== null
        && params.startCursor !== undefined
        && params.startCursor.afterSeq !== null
        && params.startCursor.afterMessageId !== null;
    const sessions = await db.session.findMany({
        where: {
            ...sessionWhere,
            ...(params.startCursor
                ? { id: resumesWithinSession ? { gte: params.startCursor.sessionId } : { gt: params.startCursor.sessionId } }
                : null),
        },
        orderBy: { id: 'asc' },
        take: sessionPageSize,
        select: {
            id: true,
            seq: true,
            lastViewedSessionSeq: true,
            latestReadyEventSeq: true,
        },
    });

    let deleted = 0;
    let candidatesExamined = 0;
    let nextCursor = params.startCursor ?? null;
    for (const session of sessions) {
        if (deleted >= deleteLimit) break;
        if (activityCache.isSessionObservedActive(session.id)) {
            nextCursor = { sessionId: session.id, afterSeq: null, afterMessageId: null };
            continue;
        }

        const preserveFromSeq = resolveSessionMessagePreserveFromSeq(session, minTailMessages);
        if (preserveFromSeq <= 1) {
            nextCursor = { sessionId: session.id, afterSeq: null, afterMessageId: null };
            continue;
        }

        const remaining = deleteLimit - deleted;
        const resumesThisSession = resumesWithinSession && params.startCursor?.sessionId === session.id;
        const rows: Array<{ id: string; seq: number }> = await db.sessionMessage.findMany({
            where: {
                sessionId: session.id,
                seq: { lt: preserveFromSeq },
                createdAt: { lt: params.cutoff },
                ...(resumesThisSession
                    ? {
                        OR: [
                            { seq: { gt: params.startCursor!.afterSeq! } },
                            { seq: params.startCursor!.afterSeq!, id: { gt: params.startCursor!.afterMessageId! } },
                        ],
                    }
                    : null),
            },
            orderBy: [{ seq: 'asc' }, { id: 'asc' }],
            take: remaining,
            select: { id: true, seq: true },
        });
        candidatesExamined += rows.length;
        if (rows.length === 0) {
            nextCursor = { sessionId: session.id, afterSeq: null, afterMessageId: null };
            continue;
        }
        const lastRow = rows[rows.length - 1]!;
        nextCursor = {
            sessionId: session.id,
            afterSeq: lastRow.seq,
            afterMessageId: lastRow.id,
        };
        if (params.dryRun) {
            deleted += rows.length;
        } else {
            const result = await db.sessionMessage.deleteMany({
                where: {
                    id: { in: rows.map((row) => row.id) },
                    sessionId: session.id,
                    seq: { lt: preserveFromSeq },
                    createdAt: { lt: params.cutoff },
                    session: { is: staleInactiveSessionWhere(params.cutoff) },
                },
            });
            deleted += result.count;
        }
        if (rows.length === remaining) {
            return { deleted, candidatesExamined, nextCursor, hasMore: true };
        }
        nextCursor = { sessionId: session.id, afterSeq: null, afterMessageId: null };
    }

    return {
        deleted,
        candidatesExamined,
        nextCursor,
        hasMore: sessions.length === sessionPageSize,
    };
}

export async function pruneSessionMessagesOnce(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    minTailMessages?: number;
}): Promise<{ deleted: number }> {
    const limit = positiveIntOrDefault(params.batchSize, 1);
    const result = await pruneSessionMessagePage({
        cutoff: params.cutoff,
        sessionPageSize: limit,
        deleteLimit: limit,
        dryRun: params.dryRun,
        minTailMessages: params.minTailMessages,
    });
    return { deleted: result.deleted };
}

export async function runSessionMessageRetentionRule(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    maxDeletesPerRulePerRun: number;
    maxCandidatesPerRulePerRun?: number;
    shouldContinue?: () => boolean;
    startCursor?: SessionMessageRetentionCursor | null;
}): Promise<{
    deleted: number;
    candidatesExamined: number;
    hasMore: boolean;
    nextCursor: SessionMessageRetentionCursor | null;
}> {
    const sessionPageSize = positiveIntOrDefault(params.batchSize, 1);
    const maxDeletes = positiveIntOrDefault(params.maxDeletesPerRulePerRun, sessionPageSize);
    const maxCandidates = positiveIntOrDefault(params.maxCandidatesPerRulePerRun, maxDeletes);
    let deleted = 0;
    let candidatesExamined = 0;
    let nextCursor = params.startCursor ?? null;
    let hasMore = false;
    let yielded = false;

    while (deleted < maxDeletes && candidatesExamined < maxCandidates) {
        if (params.shouldContinue && !params.shouldContinue()) {
            yielded = true;
            break;
        }
        const remainingCandidates = maxCandidates - candidatesExamined;
        const page = await pruneSessionMessagePage({
            cutoff: params.cutoff,
            sessionPageSize,
            deleteLimit: Math.min(maxDeletes - deleted, remainingCandidates),
            dryRun: params.dryRun,
            startCursor: nextCursor,
        });
        deleted += page.deleted;
        candidatesExamined += page.candidatesExamined;
        nextCursor = page.nextCursor;
        hasMore = page.hasMore;
        if (!hasMore || !nextCursor) break;
    }

    return {
        deleted,
        candidatesExamined,
        hasMore: yielded || hasMore || deleted >= maxDeletes || candidatesExamined >= maxCandidates,
        nextCursor,
    };
}
