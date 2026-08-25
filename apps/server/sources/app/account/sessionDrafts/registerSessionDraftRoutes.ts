import {
    SESSION_DRAFT_ROUTE_LIST,
    SESSION_DRAFT_ROUTE_MUTATE,
    SESSION_DRAFT_ROUTE_READ,
    SessionDraftListRequestV1Schema,
    SessionDraftListResponseV1Schema,
    SessionDraftMutateRequestV1Schema,
    SessionDraftMutateResponseV1Schema,
    SessionDraftReadRequestV1Schema,
    SessionDraftReadResponseV1Schema,
    SessionDraftRouteErrorResponseV1Schema,
} from "@happier-dev/protocol";

import { type Fastify } from "@/app/api/types";

import { listSessionDrafts, mutateSessionDraft, readSessionDraft } from "./sessionDraftService";

export function registerSessionDraftRoutes(app: Fastify): void {
    app.post(SESSION_DRAFT_ROUTE_READ, {
        preHandler: app.authenticate,
        schema: {
            body: SessionDraftReadRequestV1Schema,
            response: { 200: SessionDraftReadResponseV1Schema },
        },
    }, async (request, reply) => reply.send(await readSessionDraft({
        accountId: request.userId,
        address: request.body.address,
    })));

    app.post(SESSION_DRAFT_ROUTE_LIST, {
        preHandler: app.authenticate,
        schema: {
            body: SessionDraftListRequestV1Schema,
            response: { 200: SessionDraftListResponseV1Schema },
        },
    }, async (request, reply) => reply.send(await listSessionDrafts({
        accountId: request.userId,
        ...request.body,
    })));

    app.post(SESSION_DRAFT_ROUTE_MUTATE, {
        preHandler: app.authenticate,
        schema: {
            body: SessionDraftMutateRequestV1Schema,
            response: {
                200: SessionDraftMutateResponseV1Schema,
                400: SessionDraftRouteErrorResponseV1Schema,
                404: SessionDraftRouteErrorResponseV1Schema,
            },
        },
    }, async (request, reply) => {
        const result = await mutateSessionDraft({ accountId: request.userId, ...request.body });
        if (result.status === "invalidContentMode") {
            return reply.code(400).send({ error: "invalid_content_mode" });
        }
        if (result.status === "invalidAddressBinding") {
            return reply.code(400).send({ error: "invalid_address_binding" });
        }
        if (result.status === "sessionUnavailable") {
            return reply.code(404).send({ error: "session_unavailable" });
        }
        return reply.send(result);
    });
}
