import { z } from "zod";
import {
    SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1,
    SessionBoardMutationV1Schema,
    SessionBoardMutationResultV1Schema,
    SessionBoardErrorV1Schema,
    SessionBoardFeatureGateErrorV1Schema,
    sessionBoardMutationUsesLayoutV1,
    type SessionBoardMutationV1,
} from "@happier-dev/protocol/sessions/board";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { Fastify } from "../../types";
import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { mutateSessionBoard } from "@/app/session/board/service";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";

function sessionBoardRouteErrorHandler(
    error: FastifyError,
    _request: FastifyRequest,
    reply: FastifyReply,
): unknown {
    if (error.validation) {
        return reply.code(400).send({ error: "session_board_invalid" });
    }
    return reply.send(error);
}

export function isSessionBoardExternalActionEffectAllowed(input: Readonly<{
    authTokenKind?: FastifyRequest["authTokenKind"];
    externalActionExecutionAuthorized?: boolean;
    externalActionRootActionId?: string;
    externalActionEffectActionId?: string;
    externalActionExecutionTarget?: FastifyRequest["externalActionExecutionTarget"];
    sessionId: string;
    operation: SessionBoardMutationV1["operation"];
}>): boolean {
    if (input.authTokenKind !== "api_token") return true;
    if (input.externalActionExecutionAuthorized !== true) return false;
    const target = input.externalActionExecutionTarget;
    if (target?.kind !== "session" || target.sessionId !== input.sessionId) return false;
    let actionId: string;
    switch (input.operation) {
        case "upsert_item":
            actionId = "session.board.item.upsert";
            break;
        case "remove_item":
            actionId = "session.board.item.remove";
            break;
        case "update_layout":
            actionId = "session.board.layout.update";
            break;
    }
    return input.externalActionRootActionId === actionId
        && input.externalActionEffectActionId === actionId;
}

export function registerSessionBoardRoutes(app: Fastify) {
    const rateLimit = resolveApiHotEndpointRateLimit(process.env, "session.board");
    const gateBoardLayout = createServerFeatureGatePreHandler("sessions.board");
    app.put(SESSION_BOARD_MUTATION_SERVER_TRANSPORT_V1.path, {
        preHandler: [app.authenticate, async (request: FastifyRequest<{ Body: SessionBoardMutationV1 }>, reply) => {
            // Fastify's strict body validation runs before preHandler admission.
            if (sessionBoardMutationUsesLayoutV1(request.body)) return gateBoardLayout(request, reply);
        }],
        config: {
            rateLimit,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
        errorHandler: sessionBoardRouteErrorHandler,
        schema: {
            params: z.object({ sessionId: z.string().min(1) }),
            body: SessionBoardMutationV1Schema,
            response: {
                200: SessionBoardMutationResultV1Schema,
                400: SessionBoardErrorV1Schema,
                403: SessionBoardErrorV1Schema,
                404: z.union([SessionBoardErrorV1Schema, SessionBoardFeatureGateErrorV1Schema]),
                409: SessionBoardErrorV1Schema,
            },
        },
    }, async (request, reply) => {
        if (!isSessionBoardExternalActionEffectAllowed({
            authTokenKind: request.authTokenKind,
            externalActionExecutionAuthorized: request.externalActionExecutionAuthorized,
            externalActionRootActionId: request.externalActionRootActionId,
            externalActionEffectActionId: request.externalActionEffectActionId,
            externalActionExecutionTarget: request.externalActionExecutionTarget,
            sessionId: request.params.sessionId,
            operation: request.body.operation,
        })) {
            return reply.code(403).send({ error: "session_board_forbidden" });
        }
        const result = await mutateSessionBoard({
            actorUserId: request.userId,
            sessionId: request.params.sessionId,
            mutation: request.body,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (result.ok) return reply.send(result.result);
        const error = result.result.error;
        return reply.code(error === "session_board_invalid" ? 400 : error === "session_board_forbidden" ? 403 : error === "session_board_item_not_found" || error === "not_found" ? 404 : 409).send(result.result);
    });
}
