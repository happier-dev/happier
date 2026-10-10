import { inTx } from "@/storage/inTx";
import { z } from "zod";
import { type Fastify } from "../../types";
import { changesRequestsCounter, changesReturnedChangesCounter } from "@/app/monitoring/metrics/index";
import { debug, warn } from "@/utils/logging/log";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { readAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { resolveSessionHostReferenceForAuthenticationInTx } from "@/app/session/pluginCollectionHostReferenceAdapter";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { asServerProtocolZod } from "@/app/api/utils/protocolComposableZodAdapter";
import { SessionIdSchema } from "@happier-dev/protocol/sessions";
import { listQueuedExecutionRunPendingTargetsForSessions } from "@/app/session/pending/pendingMessageService";

function redactIdForLogs(id: string): string {
    if (id.length <= 8) return `${id.slice(0, 2)}…`;
    return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function isPendingStateChangeHint(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const hint = value as Record<string, unknown>;
    return typeof hint.pendingCount === "number"
        && Number.isSafeInteger(hint.pendingCount)
        && hint.pendingCount >= 0
        && typeof hint.pendingVersion === "number"
        && Number.isSafeInteger(hint.pendingVersion)
        && hint.pendingVersion >= 0;
}

function canProjectPendingExecutionRunTargets(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value !== "object" || Array.isArray(value)) return false;
    const hint = value as Record<string, unknown>;
    return !(hint.v === 1 && hint.lifecycle === "deleted");
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
            allowApiToken: true,
            allowScopedApiToken: true,
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "changes"),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const account = await inTx(tx => tx.account.findUnique({
            where: { id: userId },
            select: { seq: true, changesFloor: true },
        }), { readOnly: true });
        if (!account) {
            changesRequestsCounter.inc({ result: 'account-not-found' });
            return reply.code(404).send({ error: 'account-not-found' });
        }
        changesRequestsCounter.inc({ result: 'ok' });
        return reply.send({ cursor: account.seq, changesFloor: account.changesFloor });
    });

    app.get('/v2/changes', {
        preHandler: [async (request, reply) => {
            if (request.query?.sessionId !== undefined && request.query?.sessionAccessSessionId !== undefined) {
                return reply.code(400).send({ error: 'invalid_params' });
            }
        }, app.authenticate],
        schema: {
            querystring: z.object({
                after: z.coerce.number().int().min(0).optional(),
                limit: z.coerce.number().int().min(1).max(500).default(200),
                sessionId: asServerProtocolZod(SessionIdSchema).optional(),
                sessionAccessSessionId: asServerProtocolZod(SessionIdSchema).optional(),
            }).optional(),
        },
        config: {
            allowApiToken: true,
            allowScopedApiToken: true,
            apiTokenSessionAction: "session.transcript.get",
            restrictedCredentialBinding: { scope: "session", session: ["query.sessionId", "query.sessionAccessSessionId"] },
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "changes"),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const userIdRedacted = redactIdForLogs(userId);
        const after = request.query?.after ?? 0;
        const limit = request.query?.limit ?? 200;
        const sessionId = request.query?.sessionId;
        const sessionAccessSessionId = request.query?.sessionAccessSessionId;

        const compatibility = readAccountStoredContentCompatibilityForHttpRequest(request);
        if (request.authTokenKind === "api_token" && sessionAccessSessionId !== undefined
            && compatibility.supportsSessionAccessWitnessProtocol !== true) {
            return reply.code(403).send({ error: "credential_scope_denied" });
        }
        if (
            sessionAccessSessionId !== undefined
            && compatibility.supportsSessionAccessWitnessProtocol
        ) {
            const probe = await inTx(async (tx) => {
                const account = await tx.account.findUnique({
                    where: { id: userId },
                    select: { seq: true },
                });
                if (!account) return null;
                const access = await resolveSessionHostReferenceForAuthenticationInTx({
                    tx,
                    accountId: userId,
                    targetId: sessionAccessSessionId,
                    authentication: readSessionAccessAuthenticationFromRequest(request),
                });
                return {
                    v: 1 as const,
                    sessionId: sessionAccessSessionId,
                    throughCursor: account.seq,
                    status: access.status,
                };
            }, { readOnly: true });
            if (!probe) {
                changesRequestsCounter.inc({ result: 'account-not-found' });
                warn({ module: 'changes', userId: userIdRedacted }, 'Authenticated Session access probe missing account row');
                return reply.code(404).send({ error: 'account-not-found' });
            }
            if (probe.status === 'authentication_required') {
                changesRequestsCounter.inc({ result: 'authentication-required' });
                // Existing clients interpret this carrier's 403 as global
                // Account authentication failure. Keep Team reauthentication
                // recoverable through the ordinary retry path.
                return reply.code(503).send({ error: 'session_access_authentication_required' });
            }
            if (probe.status === 'authentication_unavailable') {
                changesRequestsCounter.inc({ result: 'authentication-unavailable' });
                return reply.code(503).send({ error: 'session_access_authentication_unavailable' });
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
                sessionAccessProbe: {
                    ...probe,
                    status: probe.status === 'available' ? 'available' as const : 'unavailable' as const,
                },
            });
        }

        const account = await inTx(tx => tx.account.findUnique({
            where: { id: userId },
            select: { seq: true, changesFloor: true },
        }), { readOnly: true });
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

        const rows = await inTx(tx => tx.accountChange.findMany({
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
        }), { readOnly: true });

        // AccountChange retention deletes a row and advances changesFloor in
        // one Account-fenced transaction. This second read closes the reader
        // side of that boundary: a poll that read an older floor but fetched
        // rows after the retention commit must reset instead of checkpointing
        // a later exact change without its required full invalidation.
        const currentAccount = await inTx(tx => tx.account.findUnique({
            where: { id: userId },
            select: { seq: true, changesFloor: true },
        }), { readOnly: true });
        if (currentAccount && after < currentAccount.changesFloor) {
            changesRequestsCounter.inc({ result: 'cursor-gone' });
            warn(
                { module: 'changes', userId: userIdRedacted, after, currentCursor: currentAccount.seq, changesFloor: currentAccount.changesFloor, reason: 'cursor-behind-floor-after-rows' },
                'Client cursor crossed changesFloor while /v2/changes was being read; snapshot resync required'
            );
            return reply.code(410).send({ error: 'cursor-gone', currentCursor: currentAccount.seq });
        }

        const nextCursor = rows.length > 0 ? rows[rows.length - 1]!.cursor : after;
        // Exact Session selectors and compatibility can withhold rows, while
        // `nextCursor` stays derived from the raw page so even an empty filtered
        // page progresses through unrelated Account activity.
        const visibleRows = rows.filter((row) => {
            if (sessionId !== undefined && (
                (row.kind !== 'session' && row.kind !== 'share') || row.entityId !== sessionId
            )) return false;
            if (row.kind === 'pluginDomain') return compatibility.supportsPluginDataProtocol;
            if (row.kind === 'machinePool') return compatibility.supportsMachinePoolChangeProtocol;
            if (row.kind === 'savedSecretResource') return compatibility.supportsSavedSecretResourceChangeProtocol;
            return true;
        });
        const pendingSessionIds = [...new Set(visibleRows.flatMap((row) =>
            row.kind === 'session' && canProjectPendingExecutionRunTargets(row.hint)
                ? [row.entityId]
                : [],
        ))];
        const pendingTargets = await inTx(tx => listQueuedExecutionRunPendingTargetsForSessions({
            accountId: userId,
            sessionIds: pendingSessionIds,
            reader: tx,
        }), { readOnly: true });
        const pendingRunIdsBySessionId = new Map<string, string[]>();
        for (const target of pendingTargets) {
            const existing = pendingRunIdsBySessionId.get(target.sessionId);
            if (existing) existing.push(target.runId);
            else pendingRunIdsBySessionId.set(target.sessionId, [target.runId]);
        }
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
        const sessionAccessResolutions = compatibility.supportsSessionAccessWitnessProtocol
            ? await Promise.all(
                [...sessionChangeCursors.entries()].map(async ([sessionId, cursor]) => ({
                    sessionId,
                    cursor,
                    resolution: await inTx(tx => resolveSessionHostReferenceForAuthenticationInTx({
                        tx,
                        accountId: userId,
                        targetId: sessionId,
                        authentication: readSessionAccessAuthenticationFromRequest(request),
                    }), { readOnly: true }),
                })),
            )
            : undefined;
        const authenticationRequired = sessionAccessResolutions?.some(({ resolution }) =>
            resolution.status === 'authentication_required');
        if (authenticationRequired) {
            changesRequestsCounter.inc({ result: 'authentication-required' });
            return reply.code(503).send({ error: 'session_access_authentication_required' });
        }
        const authenticationUnavailable = sessionAccessResolutions?.some(({ resolution }) =>
            resolution.status === 'authentication_unavailable');
        if (authenticationUnavailable) {
            changesRequestsCounter.inc({ result: 'authentication-unavailable' });
            return reply.code(503).send({ error: 'session_access_authentication_unavailable' });
        }
        // Durable purge authority requires determinate access for every Session
        // on the page. The early returns above preserve retry custody by never
        // acknowledging an authentication-indeterminate change page.
        const sessionAccessWitness = sessionAccessResolutions !== undefined
            ? {
                v: 1 as const,
                throughCursor: nextCursor,
                entries: sessionAccessResolutions.map(({ sessionId, cursor, resolution }) => ({
                    sessionId,
                    cursor,
                    status: resolution.status === 'available' ? 'available' as const : 'unavailable' as const,
                })),
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
                hint: row.kind === 'session' && canProjectPendingExecutionRunTargets(row.hint)
                    ? {
                        ...(isPendingStateChangeHint(row.hint) || (row.hint && typeof row.hint === 'object' && !Array.isArray(row.hint))
                            ? row.hint
                            : {}),
                        pendingExecutionRunIds: pendingRunIdsBySessionId.get(row.entityId) ?? [],
                    }
                    : row.hint ?? null,
            })),
            nextCursor,
            ...(sessionAccessWitness === undefined ? {} : { sessionAccessWitness }),
        });
    });
}
