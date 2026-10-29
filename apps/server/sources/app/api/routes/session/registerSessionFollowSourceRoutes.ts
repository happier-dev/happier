import { GetOtherSessionFollowSourceResponseSchema, ListSessionFollowSourcesResponseSchema, RemoveSessionFollowSourceResponseSchema, SessionFollowSourcesErrorResponseSchema, SetSessionFollowSourceRequestSchema, SetSessionFollowSourceResponseSchema, SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { parseOtherFollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/followSourceRefTransportV1';
import { SessionFollowSourceProjectionRequestV1Schema, SessionFollowSourceProjectionResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { SessionFollowObserveInactiveRequestV1Schema, SessionFollowObserveInactiveResponseV1Schema,
    SessionFollowObserveSourceRoutesRequestV1Schema, SessionFollowObserveSourceRoutesResponseV1Schema,
    SessionFollowSourceOccurrenceRoutesRequestV1Schema, SessionFollowSourceOccurrenceRoutesResponseV1Schema,
    SessionFollowRunOccurrenceRoutesQueryV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { z } from "zod/mini";
import { FollowListActionOutputV1Schema } from '@happier-dev/protocol/sessions/follow/actions';
import { FollowListPageQueryV1Schema, FollowListQueryV1Schema, parseFollowListQueryV1, type FollowListRequestV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowListV1';

import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import {
    listSessionFollowSources,
    listSessionFollowers,
    listOtherSessionFollowers,
    removeSessionFollowSource,
    removeOtherSessionFollowSource,
    setSessionFollowSource,
    setOtherSessionFollowSource,
    projectSessionFollowSourceForRunner,
    observePendingSessionFollowForInactiveDestination,
    observeSessionFollowSourceRoutes,
    observeFollowSourceOccurrenceRoutes,
    invalidateRunFollowDestinationsInTx,
    type SessionFollowSourceFailure,
    type RunFollowOccurrenceUnavailableCode,
} from "@/app/session/follow/sessionFollowEdgeService";
import { type Fastify } from "../../types";
import { PRESENT_USER_REQUIRED_ERROR } from "@/app/api/utils/apiTokenRouteAdmission";
import { AccountRouteAuthenticationForbiddenResponseSchema } from "@/app/api/utils/enableAuthentication";
import { readCurrentExecutionRunFollowSource } from '@/app/session/follow/executionRunFollowSource';
import { inTx } from '@/storage/inTx';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';

const destinationParamsSchema = z.strictObject({
    destinationSessionId: z.string().check(z.minLength(1)),
});
const occurrenceParamsSchema = z.strictObject({ sourceSessionId: z.string().check(z.minLength(1)) });
const otherSourceQuerySchema = z.strictObject({ sourceRef: z.string().check(z.minLength(1)) });
const otherFollowersQuerySchema = z.strictObject({ ...otherSourceQuerySchema.shape, ...FollowListPageQueryV1Schema.shape });

const sourceParamsSchema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(destinationParamsSchema, {
    sourceSessionId: z.string().check(z.minLength(1)),
}));

/**
 * The one closed failure mapping for the Follow source resource.
 *
 * Both absent and unreadable Sessions collapse into `session_not_found` so the
 * response is never an existence oracle, and no audience identity or reason
 * detail about inaccessible content is returned. Missing key material or a
 * missing runtime is a derived waiting state after a successful authorized set,
 * never an HTTP failure.
 */
const FAILURE_STATUS: Readonly<Record<SessionFollowSourceFailure, 400 | 403 | 404 | 409>> = {
    invalid_parameters: 400,
    session_follow_same_session: 400,
    session_not_found: 404,
    account_inactive: 403,
    session_follow_source_forbidden: 403,
    session_follow_source_unavailable: 409,
    session_archived: 409,
};

const errorResponses = {
    400: SessionFollowSourcesErrorResponseSchema,
    403: z.union([SessionFollowSourcesErrorResponseSchema, AccountRouteAuthenticationForbiddenResponseSchema]),
    404: SessionFollowSourcesErrorResponseSchema,
    409: SessionFollowSourcesErrorResponseSchema,
} as const;

export function registerSessionFollowSourceRoutes(app: Fastify) {
    const requireFeature = createServerFeatureGatePreHandler(
        "sessions.following",
        process.env,
        { error: "feature_unavailable" },
    );

    app.get(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.otherFollowers, {
        preHandler: [app.authenticate, requireFeature],
        config: { allowApiToken: true, apiTokenSessionAction: 'follow.list', restrictedCredentialBinding: {
            scope: 'account', allowSessionRuntime: false,
        } },
        schema: { querystring: otherFollowersQuerySchema,
            response: { 200: FollowListActionOutputV1Schema, ...errorResponses } },
    }, async (request, reply) => {
        const query = otherFollowersQuerySchema.safeParse(request.query);
        const source = query.success ? parseOtherFollowSourceRefV1(query.data.sourceRef) : null;
        if (!source || !query.success) return reply.code(400).send({ error: 'invalid_parameters' });
        const result = await listOtherSessionFollowers({ app, accountId: request.userId, source,
            authentication: readSessionAccessAuthenticationFromRequest(request), cursor: query.data.cursor, limit: query.data.limit });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });

    app.get(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.otherSource, {
        preHandler: [app.authenticate, requireFeature],
        config: { apiTokenSessionAction: 'follow.get', restrictedCredentialBinding: {
            scope: 'session', session: 'params.destinationSessionId', allowSessionRuntime: false,
        } },
        schema: { params: destinationParamsSchema, querystring: otherSourceQuerySchema,
            response: { 200: GetOtherSessionFollowSourceResponseSchema, ...errorResponses } },
    }, async (request, reply) => {
        const params = destinationParamsSchema.safeParse(request.params);
        const query = otherSourceQuerySchema.safeParse(request.query);
        const source = query.success ? parseOtherFollowSourceRefV1(query.data.sourceRef) : null;
        if (!params.success || !source) return reply.code(400).send({ error: 'invalid_parameters' });
        const result = await listSessionFollowSources({ app, accountId: request.userId, source,
            destinationSessionId: params.data.destinationSessionId,
            authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (!result.ok) return reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
        return reply.send(GetOtherSessionFollowSourceResponseSchema.parse({ source: result.value.sources.find(row => 'source' in row
            && JSON.stringify(row.source) === JSON.stringify(source)) ?? null }));
    });

    app.put(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.otherSource, {
        preHandler: [app.authenticate, requireFeature],
        config: { apiTokenSessionAction: 'follow.set', restrictedCredentialBinding: {
            scope: 'session', session: 'params.destinationSessionId', allowSessionRuntime: false,
        } },
        schema: { params: destinationParamsSchema, querystring: otherSourceQuerySchema,
            response: { 200: SetSessionFollowSourceResponseSchema, ...errorResponses } },
    }, async (request, reply) => {
        const params = destinationParamsSchema.safeParse(request.params);
        const query = otherSourceQuerySchema.safeParse(request.query);
        const source = query.success ? parseOtherFollowSourceRefV1(query.data.sourceRef) : null;
        const body = SetSessionFollowSourceRequestSchema.safeParse(request.body);
        if (!params.success || !source || !body.success) return reply.code(400).send({ error: 'invalid_parameters' });
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const executionRunFrontier = source.kind === 'execution_run'
            ? await readCurrentExecutionRunFollowSource({ app, accountId: request.userId,
                ...source, authentication }) : null;
        const result = await setOtherSessionFollowSource({ accountId: request.userId,
            destinationSessionId: params.data.destinationSessionId, source, policy: body.data.policy,
            authentication, ...(executionRunFrontier?.ok ? { executionRunFrontier: executionRunFrontier.value } : {}) });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });

    app.delete(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.otherSource, {
        preHandler: [app.authenticate, requireFeature],
        config: { apiTokenSessionAction: 'follow.remove', restrictedCredentialBinding: {
            scope: 'session', session: 'params.destinationSessionId', allowSessionRuntime: false,
        } },
        schema: { params: destinationParamsSchema, querystring: otherSourceQuerySchema,
            response: { 200: RemoveSessionFollowSourceResponseSchema, ...errorResponses } },
    }, async (request, reply) => {
        const params = destinationParamsSchema.safeParse(request.params);
        const query = otherSourceQuerySchema.safeParse(request.query);
        const source = query.success ? parseOtherFollowSourceRefV1(query.data.sourceRef) : null;
        if (!params.success || !source) return reply.code(400).send({ error: 'invalid_parameters' });
        const result = await removeOtherSessionFollowSource({ accountId: request.userId,
            destinationSessionId: params.data.destinationSessionId, source,
            authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });

    app.get(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.followers, {
        preHandler: [app.authenticate, requireFeature],
        config: { apiTokenSessionAction: 'follow.list', restrictedCredentialBinding: {
            scope: 'session', session: 'params.sourceSessionId', allowSessionRuntime: false,
        } },
        schema: { params: occurrenceParamsSchema, querystring: FollowListPageQueryV1Schema,
            response: { 200: FollowListActionOutputV1Schema, ...errorResponses } },
    }, async (request, reply) => {
        const params = occurrenceParamsSchema.safeParse(request.params);
        const query = FollowListPageQueryV1Schema.safeParse(request.query);
        if (!params.success || !query.success) return reply.code(400).send({ error: 'invalid_parameters' });
        const result = await listSessionFollowers({ accountId: request.userId, sourceSessionId: params.data.sourceSessionId,
            authentication: readSessionAccessAuthenticationFromRequest(request), ...query.data });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });

    app.post(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.runOccurrenceRoutes, {
        preHandler: [app.authenticate, requireFeature],
        schema: { response: { 200: SessionFollowSourceOccurrenceRoutesResponseV1Schema,
            204: z.null(),
            400: SessionFollowSourceOccurrenceRoutesResponseV1Schema,
            403: z.union([SessionFollowSourceOccurrenceRoutesResponseV1Schema, AccountRouteAuthenticationForbiddenResponseSchema]),
            409: SessionFollowSourceOccurrenceRoutesResponseV1Schema } },
    }, async (request, reply) => {
        const body = SessionFollowSourceOccurrenceRoutesRequestV1Schema.safeParse(request.body);
        const query = SessionFollowRunOccurrenceRoutesQueryV1Schema.safeParse(request.query ?? {});
        request.followSourceRoute = { resultCode: 'invalid_request' };
        if (!body.success || !query.success) return reply.code(400).send({ ok: false, v: 1, error: 'invalid_request' });
        const source = 'original' in body.data ? body.data.original.source : body.data.source;
        const sourceIdentity = { sourceKind: source.kind,
            ...('sessionId' in source ? { sourceSessionId: source.sessionId } : {}),
            ...('runId' in source ? { sourceRunId: source.runId } : {}),
            ...('machineId' in source ? { sourceMachineId: source.machineId } : {}),
            ...('discussionId' in source ? { sourceDiscussionId: source.discussionId } : {}),
            ...(source.kind === 'execution_run' && query.data.releaseReason ? { releaseReason: query.data.releaseReason } : {}) };
        request.followSourceRoute = { ...sourceIdentity, resultCode: 'unknown' };
        if (request.externalActionExecutionAuthorized === true
            || request.authTokenKind !== 'account' && request.authTokenKind !== 'terminal') {
            request.followSourceRoute = { ...sourceIdentity, resultCode: 'forbidden' };
            return reply.code(403).send({ ok: false, v: 1, error: 'forbidden' });
        }
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const outputRef = 'original' in body.data
            ? 'output' in body.data.original ? body.data.original.output.outputRef : undefined
            : 'outputRef' in body.data ? body.data.outputRef : undefined;
        const frontier = source.kind === 'execution_run' ? await readCurrentExecutionRunFollowSource({ app,
            accountId: request.userId, authentication, ...source,
            ...(outputRef ? { outputRefs: [outputRef] } : {}) }) : null;
        let occurrenceReadCode: RunFollowOccurrenceUnavailableCode | undefined;
        const result = await observeFollowSourceOccurrenceRoutes({ accountId: request.userId, authentication, request: body.data,
            ...(frontier?.ok ? { executionRunFrontier: frontier.value } : {}),
            onUnavailable: code => { occurrenceReadCode = code; } });
        const sourceTargetMachineId = frontier?.ok ? frontier.value.target.machineId : frontier?.targetMachineId;
        request.followSourceRoute = { ...sourceIdentity, resultCode: result === null || result.ok ? 'ok' : result.error,
            ...(sourceTargetMachineId ? { sourceTargetMachineId } : {}),
            ...(frontier && !frontier.ok && frontier.rpcCode ? { sourceRpcCode: frontier.rpcCode } : {}),
            ...(frontier && !frontier.ok ? { sourceReadCode: frontier.code }
                : occurrenceReadCode ? { sourceReadCode: occurrenceReadCode } : frontier ? { sourceReadCode: 'ready' } : {}) };
        // An exact retained-source notification also wakes foreign receiver
        // evaluators through the existing content-free Session change feed.
        // Source-only catch-up reads do not publish another invalidation.
        if (result?.ok && 'original' in body.data && source.kind === 'execution_run'
            && !('output' in body.data.original)) await inTx(async tx => {
            await acquireSessionAccountCursorLocksInTx(tx, 'sessionId' in source ? [source.sessionId] : []);
            await invalidateRunFollowDestinationsInTx(tx, source);
        });
        // The opt-in preserves prior strict readers. The hint only scopes a
        // held read's recovery; a later request repeats all source admission.
        const response = result && !result.ok && result.error === 'source_unavailable'
            && source.kind === 'execution_run' && 'sessionId' in source
            && query.data.includeTargetMachineId === 'true' && sourceTargetMachineId
            ? { ...result, targetMachineId: sourceTargetMachineId } : result;
        return response === null ? reply.code(204).send(null) : response.ok ? reply.send(response)
            : reply.code(response.error === 'source_unavailable' ? 409 : 403).send(response);
    });

    app.post(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.occurrenceRoutes, {
        preHandler: [app.authenticate, requireFeature],
        schema: {
            params: occurrenceParamsSchema,
            response: { 200: SessionFollowObserveSourceRoutesResponseV1Schema,
                400: SessionFollowObserveSourceRoutesResponseV1Schema,
                403: z.union([SessionFollowObserveSourceRoutesResponseV1Schema, AccountRouteAuthenticationForbiddenResponseSchema]),
                404: z.strictObject({ error: z.literal('feature_unavailable') }) },
        },
    }, async (request, reply) => {
        const params = occurrenceParamsSchema.safeParse(request.params);
        const body = SessionFollowObserveSourceRoutesRequestV1Schema.safeParse(request.body);
        if (!params.success || !body.success) return reply.code(400).send({ ok: false, v: 1, error: 'invalid_request' });
        if (request.externalActionExecutionAuthorized === true
            || request.authTokenKind !== 'account' && request.authTokenKind !== 'terminal') {
            return reply.code(403).send({ ok: false, v: 1, error: 'forbidden' });
        }
        const result = await observeSessionFollowSourceRoutes({ accountId: request.userId,
            sourceSessionId: params.data.sourceSessionId, request: body.data,
            authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result) : reply.code(403).send(result);
    });

    app.post(SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.inactiveObservations, {
        preHandler: [app.authenticate, requireFeature],
        schema: {
            params: destinationParamsSchema,
            response: {
                200: SessionFollowObserveInactiveResponseV1Schema,
                400: SessionFollowObserveInactiveResponseV1Schema,
                403: z.union([SessionFollowObserveInactiveResponseV1Schema, AccountRouteAuthenticationForbiddenResponseSchema]),
                404: z.strictObject({ error: z.literal('feature_unavailable') }),
            },
        },
    }, async (request, reply) => {
        const params = destinationParamsSchema.safeParse(request.params);
        const body = SessionFollowObserveInactiveRequestV1Schema.safeParse(request.body);
        if (!params.success || !body.success) return reply.code(400).send({ ok: false, v: 1, error: 'invalid_request' });
        if (request.externalActionExecutionAuthorized === true
            || request.authTokenKind !== 'account' && request.authTokenKind !== 'terminal') {
            return reply.code(403).send({ ok: false, v: 1, error: 'forbidden' });
        }
        return reply.send(await observePendingSessionFollowForInactiveDestination({
            accountId: request.userId,
            destinationSessionId: params.data.destinationSessionId,
            machineId: body.data.machineId,
            installationId: body.data.installationId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        }));
    });

    app.post("/v2/sessions/:destinationSessionId/follows/source-projection", {
        preHandler: [app.authenticate, requireFeature],
        config: {
            restrictedCredentialBinding: { scope: "session", session: "params.destinationSessionId" },
        },
        schema: {
            params: destinationParamsSchema,
            body: SessionFollowSourceProjectionRequestV1Schema,
            response: {
                200: SessionFollowSourceProjectionResponseV1Schema,
                403: z.strictObject({ error: z.literal(PRESENT_USER_REQUIRED_ERROR) }),
                404: z.union([
                    z.strictObject({ error: z.literal("session_follow_source_unavailable") }),
                    z.strictObject({ error: z.literal("feature_unavailable") }),
                ]),
            },
        },
    }, async (request, reply) => {
        const params = destinationParamsSchema.safeParse(request.params);
        const body = SessionFollowSourceProjectionRequestV1Schema.safeParse(request.body);
        if (!params.success || !body.success) {
            return reply.code(404).send({ error: "session_follow_source_unavailable" });
        }
        const projection = await projectSessionFollowSourceForRunner({
            principal: request.sessionRuntimePrincipal ?? { kind: 'destination_runtime', destinationRuntimeAccountId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request) },
            destinationSessionId: params.data.destinationSessionId,
            request: body.data,
        });
        if (!projection) return reply.code(404).send({ error: "session_follow_source_unavailable" });
        return reply.send(projection);
    });

    app.get("/v2/sessions/:destinationSessionId/follows/sessions", {
        preHandler: [app.authenticate, requireFeature],
        config: { apiTokenSessionAction: 'follow.list',
            restrictedCredentialBinding: { scope: 'session', session: 'params.destinationSessionId', allowSessionRuntime: false } },
        schema: {
            params: destinationParamsSchema,
            querystring: FollowListQueryV1Schema,
            response: { 200: ListSessionFollowSourcesResponseSchema, ...errorResponses },
        },
    }, async (request, reply) => {
        const params = destinationParamsSchema.safeParse(request.params);
        let query: FollowListRequestV1;
        try { query = parseFollowListQueryV1(request.query); }
        catch { return reply.code(400).send({ error: 'invalid_parameters' }); }
        if (!params.success) return reply.code(400).send({ error: "invalid_parameters" });

        const result = await listSessionFollowSources({
            app,
            accountId: request.userId,
            destinationSessionId: params.data.destinationSessionId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
            ...query,
        });
        if (!result.ok) return reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
        return reply.send(ListSessionFollowSourcesResponseSchema.parse(result.value));
    });

    app.put("/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId", {
        preHandler: [app.authenticate, requireFeature],
        config: { apiTokenSessionAction: 'follow.set', restrictedCredentialBinding: {
            scope: 'session', session: 'params.destinationSessionId', additionalSessions: ['params.sourceSessionId'], allowSessionRuntime: false,
        } },
        schema: {
            params: sourceParamsSchema,
            // The body is parsed inside the handler so an unexpected field maps to
            // this resource's closed `invalid_parameters` code instead of the
            // framework's generic validation envelope.
            response: { 200: SetSessionFollowSourceResponseSchema, ...errorResponses },
        },
    }, async (request, reply) => {
        const params = sourceParamsSchema.safeParse(request.params);
        const body = SetSessionFollowSourceRequestSchema.safeParse(request.body);
        if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_parameters" });

        const result = await setSessionFollowSource({
            accountId: request.userId,
            destinationSessionId: params.data.destinationSessionId,
            sourceSessionId: params.data.sourceSessionId,
            policy: body.data.policy,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
        return reply.send(result.value);
    });

    app.delete("/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId", {
        preHandler: [app.authenticate, requireFeature],
        config: { apiTokenSessionAction: 'follow.remove', restrictedCredentialBinding: {
            scope: 'session', session: 'params.destinationSessionId', additionalSessions: ['params.sourceSessionId'], allowSessionRuntime: false,
        } },
        schema: {
            params: sourceParamsSchema,
            response: { 200: RemoveSessionFollowSourceResponseSchema, ...errorResponses },
        },
    }, async (request, reply) => {
        const params = sourceParamsSchema.safeParse(request.params);
        if (!params.success) return reply.code(400).send({ error: "invalid_parameters" });

        const result = await removeSessionFollowSource({
            accountId: request.userId,
            destinationSessionId: params.data.destinationSessionId,
            sourceSessionId: params.data.sourceSessionId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
        return reply.send(result.value);
    });
}
