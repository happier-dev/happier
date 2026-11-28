import { z } from 'zod';
import {
    computeSessionLeavesAt,
    decodeV2SessionListCursorV1,
    encodeV2SessionListCursorV1,
    V2SessionRecordSchema,
} from '@happier-dev/protocol';

import { resolveAccountPlan, resolveLimitTable } from '@/app/plans/accountLimits';
import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { cloudTranscriptSessionWhere, retentionEligibleSessionWhere } from '@/app/retention/retentionEligibleSessionWhere';
import { DEFAULT_RETENTION_NOTICE_DAYS, isRetentionNoticeWindowOpen, resolveRetentionNoticeRule, RETENTION_DAY_MS } from '@/app/retention/retentionNotice';
import { resolveApiHotEndpointRateLimit } from '@/app/api/utils/apiRateLimitCatalog';
import { db } from '@/storage/db';

import type { Fastify } from '../../types';
import { createV2SessionListRowSelect, mapV2SessionListRow } from './v2SessionListRows';

const SUMMARY_WINDOW_DAYS = 90;
const RULE_SCHEMA = z.object({
    retentionDays: z.number().int().positive(),
    noticeDays: z.number().int().positive(),
    floorAt: z.number().int(),
});
const ERROR_SCHEMA = z.object({ error: z.string() });
const PAGE_QUERY = z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
}).optional();

async function readNoticeRule(accountId: string, now: Date) {
    const policy = readRetentionPolicyFromEnv(process.env);
    if (!policy.enabled || policy.startsAt === undefined) return null;
    const table = resolveLimitTable(process.env);
    if (!table.ok) return null;
    const account = await db.account.findUnique({ where: { id: accountId }, select: { plan: true, planEndsAt: true } });
    if (!account) return null;
    const resolved = resolveAccountPlan({ account, table, now });
    const graceEndsAt = resolved.graceEndsAt?.getTime() ?? null;
    const remainingGrace = graceEndsAt === null ? null : graceEndsAt - now.getTime();
    const noticeDays = policy.noticeDays ?? DEFAULT_RETENTION_NOTICE_DAYS;
    return resolveRetentionNoticeRule({
        policy,
        graceEndsAt: graceEndsAt ?? resolved.previousGraceEndsAt?.getTime(),
        retentionDays: remainingGrace !== null && remainingGrace <= noticeDays * RETENTION_DAY_MS
            ? table.base.sessionRetentionDays
            : resolved.limits.sessionRetentionDays,
    });
}

function latestActivityMs(updatedAt: Date, lastActiveAt: Date) {
    return Math.max(updatedAt.getTime(), lastActiveAt.getTime());
}

export function registerSessionLeavingRoutes(app: Fastify) {
    app.get('/v2/sessions/leaving', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'sessions.list') },
        schema: {
            querystring: PAGE_QUERY,
            response: {
                200: z.object({
                    rule: RULE_SCHEMA,
                    count: z.number().int(),
                    newestLeavesAt: z.number().int().nullable(),
                    sessions: z.array(z.intersection(V2SessionRecordSchema, z.object({ leavesAt: z.number().int() }))),
                    nextCursor: z.string().nullable(),
                }),
                400: ERROR_SCHEMA,
                404: ERROR_SCHEMA,
            },
        },
    }, async (request, reply) => {
        const now = new Date();
        const userId = request.userId;
        const rule = await readNoticeRule(request.userId, now);
        if (!rule) return reply.code(404).send({ error: 'Retention notice unavailable' });

        const { limit = 50, cursor } = request.query ?? {};
        const afterId = cursor ? decodeV2SessionListCursorV1(cursor) : null;
        if (cursor && !afterId) return reply.code(400).send({ error: 'Invalid cursor format' });
        if (!isRetentionNoticeWindowOpen(rule, now)) {
            return reply.send({ rule, count: 0, newestLeavesAt: null, sessions: [], nextCursor: null });
        }

        const cutoff = new Date(now.getTime() + (rule.noticeDays - rule.retentionDays) * RETENTION_DAY_MS + 1);
        const where = { accountId: userId, ...retentionEligibleSessionWhere(cutoff) };
        const [totals, rows] = await Promise.all([
            db.session.aggregate({ where, _count: true, _max: { updatedAt: true, lastActiveAt: true } }),
            db.session.findMany({
                where: { ...where, ...(afterId ? { id: { gt: afterId } } : {}) },
                select: createV2SessionListRowSelect({ userId }),
                orderBy: { id: 'asc' },
                take: limit + 1,
            }),
        ]);
        const { updatedAt, lastActiveAt } = totals._max;
        const page = rows.slice(0, limit);
        return reply.send({
            rule,
            count: totals._count,
            newestLeavesAt: updatedAt && lastActiveAt
                ? computeSessionLeavesAt(latestActivityMs(updatedAt, lastActiveAt), rule)
                : null,
            sessions: page.map(row => ({
                ...mapV2SessionListRow({ row, userId }),
                leavesAt: computeSessionLeavesAt(latestActivityMs(row.updatedAt, row.lastActiveAt), rule),
            })),
            nextCursor: rows.length > limit ? encodeV2SessionListCursorV1(page[page.length - 1]!.id) : null,
        });
    });

    app.get('/v2/sessions/retention-summary', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, 'sessions.list') },
        schema: {
            response: {
                200: z.object({
                    rule: RULE_SCHEMA.nullable(),
                    windowDays: z.literal(SUMMARY_WINDOW_DAYS),
                    sessions: z.number().int(),
                    ticks: z.array(z.object({
                        atMs: z.number().int(),
                        messages: z.number().int(),
                        pinned: z.boolean(),
                        leaving: z.boolean(),
                    })),
                    pinnedOlderThanCutoff: z.number().int(),
                }),
            },
        },
    }, async (request, reply) => {
        const now = new Date();
        const policyRule = await readNoticeRule(request.userId, now);
        const rule = policyRule && isRetentionNoticeWindowOpen(policyRule, now) ? policyRule : null;
        const windowStartMs = now.getTime() - SUMMARY_WINDOW_DAYS * RETENTION_DAY_MS;
        const olderThan = rule ? new Date(now.getTime() - rule.retentionDays * RETENTION_DAY_MS) : null;
        const rows = await db.session.findMany({
            where: {
                accountId: request.userId,
                ...cloudTranscriptSessionWhere(),
                OR: [
                    { updatedAt: { gte: new Date(windowStartMs) } },
                    ...(olderThan ? [{
                        updatedAt: { lt: olderThan },
                        lastActiveAt: { lt: olderThan },
                        sessionPins: { some: {} },
                    }] : []),
                ],
            },
            select: {
                updatedAt: true,
                lastActiveAt: true,
                seq: true,
                active: true,
                sessionPins: { take: 1, select: { sessionId: true } },
            },
            orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        });
        let pinnedOlderThanCutoff = 0;
        const ticks = rows.flatMap(row => {
            const atMs = row.updatedAt.getTime();
            const activity = latestActivityMs(row.updatedAt, row.lastActiveAt);
            const pinned = row.sessionPins.length > 0;
            if (pinned && olderThan !== null && activity < olderThan.getTime()) pinnedOlderThanCutoff++;
            if (atMs < windowStartMs) return [];
            const leaving = Boolean(rule && !pinned && !row.active
                && computeSessionLeavesAt(activity, rule) <= now.getTime() + rule.noticeDays * RETENTION_DAY_MS);
            return [{ atMs, messages: row.seq, pinned, leaving }];
        });
        return reply.send({ rule, windowDays: SUMMARY_WINDOW_DAYS, sessions: ticks.length, ticks, pinnedOlderThanCutoff });
    });
}
