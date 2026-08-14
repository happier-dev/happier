import { readFromSimpleCache, writeToSimpleCache } from '@/storage/cache/simpleCache';
import { db } from '@/storage/db';

const SIDECHAIN_RETENTION_CURSOR_KEY = 'server.retention.session-sidechain-messages.cursor.v1';

type SidechainCursor = Readonly<{
    sessionId: string;
    sidechainId: string;
}>;

function positiveIntOrDefault(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(1, Math.floor(value));
}

function parseCursor(value: string | null): SidechainCursor | null {
    if (value === null) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error(`${SIDECHAIN_RETENTION_CURSOR_KEY} contains invalid JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${SIDECHAIN_RETENTION_CURSOR_KEY} contains an invalid cursor`);
    }
    const candidate = parsed as Record<string, unknown>;
    if (candidate.v === 1 && candidate.sessionId === null && candidate.sidechainId === null) {
        return null;
    }
    if (
        candidate.v !== 1
        || typeof candidate.sessionId !== 'string'
        || candidate.sessionId.length === 0
        || typeof candidate.sidechainId !== 'string'
        || candidate.sidechainId.length === 0
    ) {
        throw new Error(`${SIDECHAIN_RETENTION_CURSOR_KEY} contains an invalid cursor`);
    }
    return {
        sessionId: candidate.sessionId,
        sidechainId: candidate.sidechainId,
    };
}

async function writeCursor(cursor: SidechainCursor | null): Promise<void> {
    await writeToSimpleCache(
        SIDECHAIN_RETENTION_CURSOR_KEY,
        cursor === null
            ? JSON.stringify({ v: 1, sessionId: null, sidechainId: null })
            : JSON.stringify({ v: 1, sessionId: cursor.sessionId, sidechainId: cursor.sidechainId }),
    );
}

async function readCursor(): Promise<SidechainCursor | null> {
    return parseCursor(await readFromSimpleCache(SIDECHAIN_RETENTION_CURSOR_KEY));
}

async function findFirstSidechainAfter(cursor: SidechainCursor | null): Promise<SidechainCursor | null> {
    if (cursor) {
        const sameSession = await db.sessionMessage.findFirst({
            where: {
                sessionId: cursor.sessionId,
                sidechainId: { gt: cursor.sidechainId },
            },
            orderBy: [{ sidechainId: 'asc' }, { seq: 'asc' }],
            select: { sessionId: true, sidechainId: true },
        });
        if (sameSession?.sidechainId) {
            return { sessionId: sameSession.sessionId, sidechainId: sameSession.sidechainId };
        }
    }

    const nextSession = await db.sessionMessage.findFirst({
        where: {
            sidechainId: { not: null },
            ...(cursor ? { sessionId: { gt: cursor.sessionId } } : {}),
        },
        orderBy: [{ sessionId: 'asc' }, { sidechainId: 'asc' }, { seq: 'asc' }],
        select: { sessionId: true, sidechainId: true },
    });
    if (!nextSession?.sidechainId) return null;
    return { sessionId: nextSession.sessionId, sidechainId: nextSession.sidechainId };
}

async function readLatestSidechainCreatedAt(cursor: SidechainCursor): Promise<Date | null> {
    const latest = await db.sessionMessage.findFirst({
        where: cursor,
        orderBy: { seq: 'desc' },
        select: { createdAt: true },
    });
    return latest?.createdAt ?? null;
}

async function countDryRunRows(params: {
    cursor: SidechainCursor;
    limit: number;
}): Promise<number> {
    let counted = 0;
    let afterSeq: number | null = null;

    while (counted < params.limit) {
        const pageLimit = Math.min(100, params.limit - counted);
        const rows: Array<{ seq: number }> = await db.sessionMessage.findMany({
            where: {
                ...params.cursor,
                ...(afterSeq === null ? {} : { seq: { gt: afterSeq } }),
            },
            orderBy: { seq: 'asc' },
            take: pageLimit,
            select: { seq: true },
        });
        if (rows.length === 0) break;
        counted += rows.length;
        afterSeq = rows[rows.length - 1]?.seq ?? null;
        if (rows.length < pageLimit) break;
    }

    return counted;
}

async function deleteExpiredSidechainBatch(params: {
    cursor: SidechainCursor;
    cutoff: Date;
    limit: number;
}): Promise<number> {
    const rows = await db.sessionMessage.findMany({
        where: params.cursor,
        orderBy: { seq: 'asc' },
        take: params.limit,
        select: { id: true },
    });
    if (rows.length === 0) return 0;

    return await db.$transaction(async (tx) => {
        const latest = await tx.sessionMessage.findFirst({
            where: params.cursor,
            orderBy: { seq: 'desc' },
            select: { createdAt: true },
        });
        if (!latest || latest.createdAt >= params.cutoff) return 0;

        const result = await tx.sessionMessage.deleteMany({
            where: {
                id: { in: rows.map((row) => row.id) },
                ...params.cursor,
                createdAt: { lt: params.cutoff },
            },
        });
        return result.count;
    });
}

async function sidechainStillExpired(params: {
    cursor: SidechainCursor;
    cutoff: Date;
}): Promise<boolean> {
    const latestCreatedAt = await readLatestSidechainCreatedAt(params.cursor);
    return latestCreatedAt !== null && latestCreatedAt < params.cutoff;
}

export async function runSessionSidechainMessageRetentionRule(params: {
    cutoff: Date;
    batchSize: number;
    dryRun: boolean;
    maxDeletesPerRulePerRun: number;
}): Promise<{ deleted: number }> {
    const batchSize = positiveIntOrDefault(params.batchSize, 1);
    const maxDeletes = positiveIntOrDefault(params.maxDeletesPerRulePerRun, batchSize);
    const persistedCursor = await readCursor();
    let scanCursor = persistedCursor;
    let lastCompletedCursor = persistedCursor;
    let deleted = 0;
    let scanned = 0;

    while (scanned < batchSize && deleted < maxDeletes) {
        const candidate = await findFirstSidechainAfter(scanCursor);
        if (!candidate) {
            lastCompletedCursor = null;
            break;
        }
        scanCursor = candidate;
        scanned += 1;

        const latestCreatedAt = await readLatestSidechainCreatedAt(candidate);
        if (latestCreatedAt === null || latestCreatedAt >= params.cutoff) {
            lastCompletedCursor = candidate;
            continue;
        }

        if (params.dryRun) {
            deleted += await countDryRunRows({
                cursor: candidate,
                limit: maxDeletes - deleted,
            });
            lastCompletedCursor = candidate;
            continue;
        }

        let madeProgress = false;
        while (deleted < maxDeletes) {
            const limit = Math.min(batchSize, maxDeletes - deleted);
            const batchDeleted = await deleteExpiredSidechainBatch({
                cursor: candidate,
                cutoff: params.cutoff,
                limit,
            });
            if (batchDeleted === 0) break;
            madeProgress = true;
            deleted += batchDeleted;
            if (batchDeleted < limit) break;
        }

        const remainsExpired = await sidechainStillExpired({ cursor: candidate, cutoff: params.cutoff });
        if (remainsExpired) {
            // Keep the persisted cursor before this sidechain so the next sweep resumes it. A zero
            // progress result also stops the run instead of spinning on a contended or raced row.
            if (!madeProgress || deleted >= maxDeletes) break;
            continue;
        }
        lastCompletedCursor = candidate;
    }

    if (!params.dryRun) {
        await writeCursor(lastCompletedCursor);
    }

    return { deleted };
}
