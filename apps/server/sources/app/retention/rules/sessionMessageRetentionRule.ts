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
    afterSessionId?: string | null;
}): Promise<{ deleted: number; lastSessionId: string | null; hasMoreSessions: boolean }> {
    const sessionPageSize = positiveIntOrDefault(params.sessionPageSize, 1);
    const deleteLimit = positiveIntOrDefault(params.deleteLimit, 1);
    const minTailMessages = positiveIntOrDefault(params.minTailMessages, DEFAULT_MIN_TAIL_MESSAGES);
    const sessionWhere = staleInactiveSessionWhere(params.cutoff);
    const sessions = await db.session.findMany({
        where: {
            ...sessionWhere,
            ...(params.afterSessionId ? { id: { gt: params.afterSessionId } } : {}),
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
    for (const session of sessions) {
        if (deleted >= deleteLimit) break;
        if (activityCache.isSessionObservedActive(session.id)) {
            continue;
        }

        const preserveFromSeq = resolveSessionMessagePreserveFromSeq(session, minTailMessages);
        if (preserveFromSeq <= 1) {
            continue;
        }

        const remaining = deleteLimit - deleted;
        const rows = await db.sessionMessage.findMany({
            where: {
                sessionId: session.id,
                seq: { lt: preserveFromSeq },
                createdAt: { lt: params.cutoff },
            },
            orderBy: { seq: 'asc' },
            take: remaining,
            select: { id: true },
        });
        if (rows.length === 0) {
            continue;
        }
        if (params.dryRun) {
            deleted += rows.length;
            continue;
        }

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

    return {
        deleted,
        lastSessionId: sessions[sessions.length - 1]?.id ?? null,
        hasMoreSessions: sessions.length === sessionPageSize,
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
}): Promise<{ deleted: number }> {
    const sessionPageSize = positiveIntOrDefault(params.batchSize, 1);
    const maxDeletes = positiveIntOrDefault(params.maxDeletesPerRulePerRun, sessionPageSize);
    let deleted = 0;
    let afterSessionId: string | null = null;

    while (deleted < maxDeletes) {
        const page = await pruneSessionMessagePage({
            cutoff: params.cutoff,
            sessionPageSize,
            deleteLimit: maxDeletes - deleted,
            dryRun: params.dryRun,
            afterSessionId,
        });
        deleted += page.deleted;
        if (!page.hasMoreSessions || !page.lastSessionId) break;
        afterSessionId = page.lastSessionId;
    }

    return { deleted };
}
