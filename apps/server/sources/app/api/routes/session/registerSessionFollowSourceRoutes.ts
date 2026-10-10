import {
    ListSessionFollowSourcesResponseSchema,
    RemoveSessionFollowSourceResponseSchema,
    SessionFollowSourcesErrorResponseSchema,
    SetSessionFollowSourceRequestSchema,
    SetSessionFollowSourceResponseSchema,
    SessionFollowSourceProjectionRequestV1Schema,
    SessionFollowSourceProjectionResponseV1Schema,
} from "@happier-dev/protocol";
import { z } from "zod";

import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import {
    listSessionFollowSources,
    removeSessionFollowSource,
    setSessionFollowSource,
    projectSessionFollowSourceForRunnerInTx,
    type SessionFollowSourceFailure,
} from "@/app/session/follow/sessionFollowEdgeService";
import { inTx } from "@/storage/inTx";
import { type Fastify } from "../../types";
import { PRESENT_USER_REQUIRED_ERROR } from "@/app/api/utils/apiTokenRouteAdmission";

const destinationParamsSchema = z.object({
    destinationSessionId: z.string().min(1),
}).strict();

const sourceParamsSchema = destinationParamsSchema.extend({
    sourceSessionId: z.string().min(1),
}).strict();

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
    session_archived: 409,
};

const errorResponses = {
    400: SessionFollowSourcesErrorResponseSchema,
    403: SessionFollowSourcesErrorResponseSchema,
    404: SessionFollowSourcesErrorResponseSchema,
    409: SessionFollowSourcesErrorResponseSchema,
} as const;

export function registerSessionFollowSourceRoutes(app: Fastify) {
    const requireFeature = createServerFeatureGatePreHandler(
        "sessions.following",
        process.env,
        { error: "feature_unavailable" },
    );

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
                403: z.object({ error: z.literal(PRESENT_USER_REQUIRED_ERROR) }).strict(),
                404: z.union([
                    z.object({ error: z.literal("session_follow_source_unavailable") }).strict(),
                    z.object({ error: z.literal("feature_unavailable") }).strict(),
                ]),
            },
        },
    }, async (request, reply) => {
        const params = destinationParamsSchema.safeParse(request.params);
        const body = SessionFollowSourceProjectionRequestV1Schema.safeParse(request.body);
        const principal = request.sessionRuntimePrincipal;
        if (!params.success || !body.success || !principal) {
            return reply.code(404).send({ error: "session_follow_source_unavailable" });
        }
        const projection = await inTx(async (tx) => await projectSessionFollowSourceForRunnerInTx(tx, {
            principal,
            destinationSessionId: params.data.destinationSessionId,
            request: body.data,
        }), { readOnly: true });
        if (!projection) return reply.code(404).send({ error: "session_follow_source_unavailable" });
        return reply.send(projection);
    });

    app.get("/v2/sessions/:destinationSessionId/follows/sessions", {
        preHandler: [app.authenticate, requireFeature],
        schema: {
            params: destinationParamsSchema,
            response: { 200: ListSessionFollowSourcesResponseSchema, ...errorResponses },
        },
    }, async (request, reply) => {
        const params = destinationParamsSchema.safeParse(request.params);
        if (!params.success) return reply.code(400).send({ error: "invalid_parameters" });

        const result = await listSessionFollowSources({
            accountId: request.userId,
            destinationSessionId: params.data.destinationSessionId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
        return reply.send({ sources: [...result.value] });
    });

    app.put("/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId", {
        preHandler: [app.authenticate, requireFeature],
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
            mode: body.data.mode,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
        return reply.send(result.value);
    });

    app.delete("/v2/sessions/:destinationSessionId/follows/sessions/:sourceSessionId", {
        preHandler: [app.authenticate, requireFeature],
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
