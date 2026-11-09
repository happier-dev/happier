import { inReadSnapshot, inTx, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/config/databaseProvider";
import { z } from "zod/mini";
import { type Fastify } from "../../types";
import { changesRequestsCounter, changesReturnedChangesCounter } from "@/app/monitoring/metrics/index";
import { debug, warn } from "@/utils/logging/log";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { readAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    resolveSessionHostReferenceForAuthenticationInTx,
    resolveSessionHostReferencesForAuthenticationInTx,
} from "@/app/session/pluginCollectionHostReferenceAdapter";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { asServerProtocolZod } from "@/app/api/utils/protocolComposableZodAdapter";
import { SessionIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { ChangeKindSchema, CHANGES_AFTER_CURSOR_HTTP_HEADER } from '@happier-dev/protocol/changes';
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
                    cursor: z.number().check(z.int(), z.minimum(0)),
                    changesFloor: z.number().check(z.int(), z.minimum(0)),
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
        }), { readOnly: true, singleStatementRead: true });
        if (!account) {
            changesRequestsCounter.inc({ result: 'account-not-found' });
            return reply.code(404).send({ error: 'account-not-found' });
        }
        changesRequestsCounter.inc({ result: 'ok' });
        return reply.send({ cursor: account.seq, changesFloor: account.changesFloor });
    });

    app.get('/v2/changes', {
        preHandler: [async (request, reply) => {
            if (request.query?.sessionAccessSessionId !== undefined
                && (request.query?.sessionId !== undefined || request.query?.kinds !== undefined)) {
                return reply.code(400).send({ error: 'invalid_params' });
            }
        }, app.authenticate],
        schema: {
            headers: z.looseObject({
                [CHANGES_AFTER_CURSOR_HTTP_HEADER]: z.optional(z.coerce.number().check(z.int(), z.minimum(0))),
            }),
            querystring: z.optional(z.object({
                after: z.optional(z.coerce.number().check(z.int(), z.minimum(0))),
                limit: z._default(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(500)), 200),
                sessionId: z.optional(asServerProtocolZod(SessionIdSchema)),
                sessionAccessSessionId: z.optional(asServerProtocolZod(SessionIdSchema)),
                kinds: z.optional(z.string()),
            })),
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
        const headerAfter = request.headers?.[CHANGES_AFTER_CURSOR_HTTP_HEADER];
        if (headerAfter !== undefined && request.query?.after !== undefined && headerAfter !== request.query.after) {
            return reply.code(400).send({ error: 'invalid_params' });
        }
        const after = headerAfter ?? request.query?.after ?? 0;
        reply.header('Cache-Control', 'no-store');
        if (headerAfter !== undefined) reply.header(CHANGES_AFTER_CURSOR_HTTP_HEADER, String(headerAfter));
        const limit = request.query?.limit ?? 200;
        const sessionId = request.query?.sessionId;
        const sessionAccessSessionId = request.query?.sessionAccessSessionId;
        const parsedKinds = request.query?.kinds === undefined
            ? undefined
            : z.array(ChangeKindSchema).safeParse(request.query.kinds.split(','));
        if (parsedKinds !== undefined && !parsedKinds.success) {
            return reply.code(400).send({ error: 'invalid_params' });
        }
        const kinds = parsedKinds?.data;
        const selectedKinds = sessionId === undefined
            ? kinds
            : kinds === undefined ? ['session', 'share'] : kinds.filter(kind => kind === 'session' || kind === 'share');
        const hasSelection = selectedKinds !== undefined;

        const compatibility = readAccountStoredContentCompatibilityForHttpRequest(request);
        if (request.authTokenKind === "api_token" && sessionAccessSessionId !== undefined
            && compatibility.supportsSessionAccessWitnessProtocol !== true) {
            return reply.code(403).send({ error: "credential_scope_denied" });
        }
        if (
            sessionAccessSessionId !== undefined
            && compatibility.supportsSessionAccessWitnessProtocol
        ) {
            const probe = await inReadSnapshot(async (tx) => {
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
            });
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

        // Each statement must see newly committed retention/access changes.
        // READ COMMITTED preserves those fresh phases on one admitted connection;
        // a repeatable snapshot would conceal the final changesFloor update.
        const readPage = async (read: <T>(operation: (tx: Tx) => Promise<T>) => Promise<T>) => {
            const account = await read(tx => tx.account.findUnique({
                where: { id: userId },
                select: { seq: true, changesFloor: true },
            }));
            if (!account) return { status: 'account-not-found' } as const;
            if (after > account.seq) return { status: 'cursor-gone', account, reason: 'cursor-in-future' } as const;
            if (after < account.changesFloor) return { status: 'cursor-gone', account, reason: 'cursor-behind-floor' } as const;

            const rows = await read(tx => tx.accountChange.findMany({
                where: {
                    accountId: userId,
                    cursor: { gt: after, ...(hasSelection ? { lte: account.seq } : {}) },
                    ...(sessionId === undefined ? {} : { entityId: sessionId }),
                    ...(selectedKinds === undefined ? {} : { kind: { in: selectedKinds } }),
                },
                orderBy: [{ cursor: 'asc' }, { kind: 'asc' }, { entityId: 'asc' }],
                take: limit,
                select: { cursor: true, kind: true, entityId: true, changedAt: true, hint: true },
            }));
            // Retention advances the floor and removes rows atomically. Keep
            // this second, fresh read after rows, even within one transaction.
            const currentAccount = await read(tx => tx.account.findUnique({
                where: { id: userId },
                select: { seq: true, changesFloor: true },
            }));
            if (currentAccount && after < currentAccount.changesFloor) {
                return { status: 'cursor-gone', account: currentAccount, reason: 'cursor-behind-floor-after-rows' } as const;
            }
            const visibleRows = rows.filter(row => {
                if (row.kind === 'pluginDomain') return compatibility.supportsPluginDataProtocol;
                if (row.kind === 'machinePool') return compatibility.supportsMachinePoolChangeProtocol;
                if (row.kind === 'savedSecretResource') return compatibility.supportsSavedSecretResourceChangeProtocol;
                return true;
            });
            const pendingSessionIds = [...new Set(visibleRows.flatMap(row =>
                row.kind === 'session' && canProjectPendingExecutionRunTargets(row.hint) ? [row.entityId] : [],
            ))];
            const pendingTargets = pendingSessionIds.length === 0 ? [] : await read(tx => listQueuedExecutionRunPendingTargetsForSessions({
                accountId: userId, sessionIds: pendingSessionIds, reader: tx,
            }));
            const sessionChangeCursors = new Map<string, number>();
            const sessionAccessResolutions = [];
            if (compatibility.supportsSessionAccessWitnessProtocol) {
                for (const row of visibleRows) {
                    const id = row.entityId.trim();
                    // Only the latest cursor for an exact Session needs its
                    // canonical access fact; advisory kinds do not grant access.
                    if (row.kind === 'session' && id.length > 0) sessionChangeCursors.set(id, row.cursor);
                }
                // One batched access read for the page, not one per changed Session.
                const resolutions = sessionChangeCursors.size === 0 ? new Map()
                    : await read(tx => resolveSessionHostReferencesForAuthenticationInTx({
                        tx, accountId: userId, targetIds: [...sessionChangeCursors.keys()],
                        authentication: readSessionAccessAuthenticationFromRequest(request),
                    }));
                for (const [id, cursor] of sessionChangeCursors) {
                    sessionAccessResolutions.push({ sessionId: id, cursor,
                        resolution: resolutions.get(id) ?? { status: 'unavailable' as const },
                    });
                }
            }
            return { status: 'ok', account, rows, visibleRows, pendingTargets,
                sessionAccessResolutions: compatibility.supportsSessionAccessWitnessProtocol ? sessionAccessResolutions : undefined,
            } as const;
        };
        // SQLite has no READ COMMITTED transaction: retain its separate fresh
        // phase snapshots. The domain decisions above remain one shared path.
        const page = getDbProviderFromEnv(process.env, 'postgres') === 'sqlite'
            ? await readPage(operation => inReadSnapshot(operation))
            : await inTx(tx => readPage(operation => operation(tx)), { readOnly: true, isolationLevel: 'ReadCommitted' });
        if (page.status === 'account-not-found') {
            // Should be impossible for authenticated requests, but keep the contract explicit.
            changesRequestsCounter.inc({ result: 'account-not-found' });
            warn({ module: 'changes', userId: userIdRedacted }, 'Authenticated /v2/changes request missing account row');
            return reply.code(404).send({ error: 'account-not-found' });
        }

        if (page.status === 'cursor-gone') {
            changesRequestsCounter.inc({ result: 'cursor-gone' });
            warn(
                { module: 'changes', userId: userIdRedacted, after, currentCursor: page.account.seq, changesFloor: page.account.changesFloor, reason: page.reason },
                'Client cursor requires snapshot resync'
            );
            return reply.code(410).send({ error: 'cursor-gone', currentCursor: page.account.seq });
        }
        const { account, rows, visibleRows, pendingTargets, sessionAccessResolutions } = page;

        // A selected read only materializes the requested AccountChange kinds
        // and/or exact Session. Once that result is shorter than the requested
        // page, the Account snapshot proves every cursor through `account.seq`
        // was examined; advance directly instead of paging unrelated activity.
        // A full page retains its last row cursor so the next page cannot skip
        // another selected change.
        const nextCursor = hasSelection && rows.length < limit
            ? account.seq
            : rows.length > 0 ? rows[rows.length - 1]!.cursor : after;
        const pendingRunIdsBySessionId = new Map<string, string[]>();
        for (const target of pendingTargets) {
            const existing = pendingRunIdsBySessionId.get(target.sessionId);
            if (existing) existing.push(target.runId);
            else pendingRunIdsBySessionId.set(target.sessionId, [target.runId]);
        }
        // A Team authentication refusal is per Session, decided by the Session
        // access owner for this credential: that Session's entry is unavailable
        // (as the Session list omits it) and the rest of the Account feed stays
        // readable. Refusing the whole page would stall every change kind for a
        // credential that retrying cannot qualify.
        // An unavailable accepted method (Home outage, unreadable fact) is not a
        // refusal: access is indeterminate, and a witnessed `unavailable` would
        // purge the Session and advance the cursor past it. Never acknowledge
        // that page; the client's changes retry owner replays it.
        if (sessionAccessResolutions?.some(({ resolution }) => resolution.status === 'authentication_unavailable')) {
            changesRequestsCounter.inc({ result: 'authentication-unavailable' });
            return reply.code(503).send({ error: 'session_access_authentication_unavailable' });
        }
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
