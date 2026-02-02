import { db } from "@/storage/db";
import { z } from "zod";
import { type Fastify } from "../types";
import { changesRequestsCounter, changesReturnedChangesCounter } from "@/app/monitoring/metrics2";
import { debug, warn } from "@/utils/log";

function redactIdForLogs(id: string): string {
    if (id.length <= 8) return `${id.slice(0, 2)}…`;
    return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export function changesRoutes(app: Fastify) {
    app.get('/v2/cursor', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    cursor: z.number().int().min(0),
                    changesFloor: z.number().int().min(0),
                }),
                404: z.object({ error: z.literal('account-not-found') }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const account = await db.account.findUnique({
            where: { id: userId },
            select: { seq: true, changesFloor: true },
        });
        if (!account) {
            changesRequestsCounter.inc({ result: 'account-not-found' });
            return reply.code(404).send({ error: 'account-not-found' });
        }
        changesRequestsCounter.inc({ result: 'ok' });
        return reply.send({ cursor: account.seq, changesFloor: account.changesFloor });
    });

    app.get('/v2/changes', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                after: z.coerce.number().int().min(0).optional(),
                limit: z.coerce.number().int().min(1).max(500).default(200),
            }).optional(),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const userIdRedacted = redactIdForLogs(userId);
        const after = request.query?.after ?? 0;
        const limit = request.query?.limit ?? 200;

        const account = await db.account.findUnique({
            where: { id: userId },
            select: { seq: true, changesFloor: true },
        });
        if (!account) {
            // Should be impossible for authenticated requests, but keep the contract explicit.
            changesRequestsCounter.inc({ result: 'account-not-found' });
            warn({ module: 'changes', userId: userIdRedacted }, 'Authenticated /v2/changes request missing account row');
            return reply.code(404).send({ error: 'account-not-found' });
        }

        // Cursor safety: if a client somehow has a cursor from the future (e.g. restored from a different account),
        // require a snapshot rebuild.
        if (after > account.seq) {
            changesRequestsCounter.inc({ result: 'cursor-gone' });
            warn(
                { module: 'changes', userId: userIdRedacted, after, currentCursor: account.seq, changesFloor: account.changesFloor, reason: 'cursor-in-future' },
                'Client cursor is in the future; snapshot resync required'
            );
            return reply.code(410).send({ error: 'cursor-gone', currentCursor: account.seq });
        }

        // Prune safety: if the server has pruned orphaned AccountChange rows (e.g. deleted sessions),
        // clients behind the prune floor must do a snapshot rebuild to avoid missing deletion signals.
        if (after < account.changesFloor) {
            changesRequestsCounter.inc({ result: 'cursor-gone' });
            warn(
                { module: 'changes', userId: userIdRedacted, after, currentCursor: account.seq, changesFloor: account.changesFloor, reason: 'cursor-behind-floor' },
                'Client cursor is behind changesFloor; snapshot resync required'
            );
            return reply.code(410).send({ error: 'cursor-gone', currentCursor: account.seq });
        }

        const rows = await db.accountChange.findMany({
            where: {
                accountId: userId,
                cursor: { gt: after },
            },
            orderBy: [
                { cursor: 'asc' },
                { kind: 'asc' },
                { entityId: 'asc' },
            ],
            take: limit,
            select: {
                cursor: true,
                kind: true,
                entityId: true,
                changedAt: true,
                hint: true,
            },
        });

        const nextCursor = rows.length > 0 ? rows[rows.length - 1]!.cursor : after;

        changesRequestsCounter.inc({ result: 'ok' });
        changesReturnedChangesCounter.inc(rows.length);
        debug(
            { module: 'changes', userId: userIdRedacted, after, nextCursor, returned: rows.length, limit },
            'Served /v2/changes'
        );

        return reply.send({
            changes: rows.map((row) => ({
                cursor: row.cursor,
                kind: row.kind,
                entityId: row.entityId,
                changedAt: row.changedAt.getTime(),
                hint: row.hint ?? null,
            })),
            nextCursor,
        });
    });
}
