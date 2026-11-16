import { inReadSnapshot, inTx } from "@/storage/inTx";
import { z } from "zod/mini";
import { type Fastify } from "../../types";
import { changesRequestsCounter, changesReturnedChangesCounter } from "@/app/monitoring/metrics/index";
import { debug, warn } from "@/utils/logging/log";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { readAccountStoredContentCompatibilityForHttpRequest } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { resolveSessionHostReferenceForAuthenticationInTx } from "@/app/session/pluginCollectionHostReferenceAdapter";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { asServerProtocolZod } from "@/app/api/utils/protocolComposableZodAdapter";
import { SessionIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { ACCOUNT_CHANGES_PAGE_LIMIT_V1, ChangeKindSchema, CHANGES_AFTER_CURSOR_HTTP_HEADER } from '@happier-dev/protocol/changes';
import { readAccountChangesPage } from "@/app/changes/readAccountChangesPage";

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
                limit: z._default(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(500)), ACCOUNT_CHANGES_PAGE_LIMIT_V1),
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
        const limit = request.query?.limit ?? ACCOUNT_CHANGES_PAGE_LIMIT_V1;
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

        const read = await readAccountChangesPage({
            accountId: userId, after, limit, sessionId, compatibility,
            ...(selectedKinds === undefined ? {} : { kinds: selectedKinds }),
            readAuthentication: () => readSessionAccessAuthenticationFromRequest(request),
        });
        if (read.status === 'account-not-found') {
            // Should be impossible for authenticated requests, but keep the contract explicit.
            changesRequestsCounter.inc({ result: 'account-not-found' });
            warn({ module: 'changes', userId: userIdRedacted }, 'Authenticated /v2/changes request missing account row');
            return reply.code(404).send({ error: 'account-not-found' });
        }

        if (read.status === 'cursor-gone') {
            changesRequestsCounter.inc({ result: 'cursor-gone' });
            warn(
                { module: 'changes', userId: userIdRedacted, after, currentCursor: read.currentCursor, changesFloor: read.changesFloor, reason: read.reason },
                'Client cursor requires snapshot resync'
            );
            return reply.code(410).send({ error: 'cursor-gone', currentCursor: read.currentCursor });
        }
        if (read.status === 'authentication-unavailable') {
            changesRequestsCounter.inc({ result: 'authentication-unavailable' });
            return reply.code(503).send({ error: 'session_access_authentication_unavailable' });
        }
        const { page } = read;
        const nextCursor = page.nextCursor;

        changesRequestsCounter.inc({ result: 'ok' });
        changesReturnedChangesCounter.inc(page.changes.length);
        debug(
            { module: 'changes', userId: userIdRedacted, after, nextCursor, returned: page.changes.length, limit },
            'Served /v2/changes'
        );

        return reply.send(page);
    });
}
