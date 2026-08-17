import { db } from "@/storage/db";
import { z } from "zod";
import { type Fastify } from "../../types";
import { changesRequestsCounter, changesReturnedChangesCounter } from "@/app/monitoring/metrics/index";
import { debug, warn } from "@/utils/logging/log";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { readAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { sessionPluginCollectionHostReferenceAdapter } from "@/app/session/pluginCollectionHostReferenceAdapter";
import { asServerProtocolZod } from "@/app/api/utils/protocolComposableZodAdapter";
import { SessionIdSchema } from "@happier-dev/protocol/sessions";

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
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "changes"),
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
                sessionAccessSessionId: asServerProtocolZod(SessionIdSchema).optional(),
            }).optional(),
        },
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "changes"),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const userIdRedacted = redactIdForLogs(userId);
        const after = request.query?.after ?? 0;
        const limit = request.query?.limit ?? 200;
        const sessionAccessSessionId = request.query?.sessionAccessSessionId;

        const compatibility = readAccountStoredContentCompatibilityForHttpRequest(request);
        if (
            sessionAccessSessionId !== undefined
            && compatibility.supportsSessionAccessWitnessProtocol
        ) {
            const probe = await db.$transaction(async (tx) => {
                const account = await tx.account.findUnique({
                    where: { id: userId },
                    select: { seq: true },
                });
                if (!account) return null;
                const access = await sessionPluginCollectionHostReferenceAdapter.resolveInTx({
                    tx,
                    accountId: userId,
                    targetId: sessionAccessSessionId,
                });
                return {
                    v: 1 as const,
                    sessionId: sessionAccessSessionId,
                    throughCursor: account.seq,
                    status: access.status === 'available' ? 'available' as const : 'unavailable' as const,
                };
            });
            if (!probe) {
                changesRequestsCounter.inc({ result: 'account-not-found' });
                warn({ module: 'changes', userId: userIdRedacted }, 'Authenticated Session access probe missing account row');
                return reply.code(404).send({ error: 'account-not-found' });
            }
            changesRequestsCounter.inc({ result: 'ok' });
            changesReturnedChangesCounter.inc(0);
            debug(
                { module: 'changes', userId: userIdRedacted, nextCursor: probe.throughCursor, returned: 0, limit, exactSessionAccessProbe: true },
                'Served exact Session access probe through /v2/changes',
            );
            return reply.send({
                changes: [],
                nextCursor: probe.throughCursor,
                sessionAccessProbe: probe,
            });
        }

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

        // AccountChange retention deletes a row and advances changesFloor in
        // one Account-fenced transaction. This second read closes the reader
        // side of that boundary: a poll that read an older floor but fetched
        // rows after the retention commit must reset instead of checkpointing
        // a later exact change without its required full invalidation.
        const currentAccount = await db.account.findUnique({
            where: { id: userId },
            select: { seq: true, changesFloor: true },
        });
        if (currentAccount && after < currentAccount.changesFloor) {
            changesRequestsCounter.inc({ result: 'cursor-gone' });
            warn(
                { module: 'changes', userId: userIdRedacted, after, currentCursor: currentAccount.seq, changesFloor: currentAccount.changesFloor, reason: 'cursor-behind-floor-after-rows' },
                'Client cursor crossed changesFloor while /v2/changes was being read; snapshot resync required'
            );
            return reply.code(410).send({ error: 'cursor-gone', currentCursor: currentAccount.seq });
        }

        const nextCursor = rows.length > 0 ? rows[rows.length - 1]!.cursor : after;
        const visibleRows = compatibility.supportsPluginDataProtocol
            ? rows
            : rows.filter((row) => row.kind !== 'pluginDomain');
        const sessionChangeCursors = new Map<string, number>();
        if (compatibility.supportsSessionAccessWitnessProtocol) {
            for (const row of visibleRows) {
                if (row.kind !== 'session') continue;
                const sessionId = row.entityId.trim();
                if (sessionId.length === 0) continue;
                // The feed is cursor-ordered. One page can contain several
                // changes for an exact Session; its latest change is the one
                // canonical access fact needed by the bounded witness.
                sessionChangeCursors.set(sessionId, row.cursor);
            }
        }
        const sessionAccessWitness = compatibility.supportsSessionAccessWitnessProtocol
            ? {
                v: 1 as const,
                throughCursor: nextCursor,
                entries: await Promise.all(
                    [...sessionChangeCursors.entries()].map(async ([sessionId, cursor]) => {
                        const access = await sessionPluginCollectionHostReferenceAdapter.resolveInTx({
                            tx: db,
                            accountId: userId,
                            targetId: sessionId,
                        });
                        return {
                            sessionId,
                            cursor,
                            status: access.status === 'available' ? 'available' as const : 'unavailable' as const,
                        };
                    }),
                ),
            }
            : undefined;

        changesRequestsCounter.inc({ result: 'ok' });
        changesReturnedChangesCounter.inc(visibleRows.length);
        debug(
            { module: 'changes', userId: userIdRedacted, after, nextCursor, returned: visibleRows.length, limit },
            'Served /v2/changes'
        );

        return reply.send({
            changes: visibleRows.map((row) => ({
                cursor: row.cursor,
                kind: row.kind,
                entityId: row.entityId,
                changedAt: row.changedAt.getTime(),
                hint: row.hint ?? null,
            })),
            nextCursor,
            ...(sessionAccessWitness === undefined ? {} : { sessionAccessWitness }),
        });
    });
}
