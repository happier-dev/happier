import {
    SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2,
    SessionLookupByTagsRequestV2Schema,
    SessionLookupByTagsResponseV2Schema,
} from "@happier-dev/protocol";
import { z } from "zod";

import { db } from "@/storage/db";
import { type Fastify } from "../../types";
import {
    createV2SessionOwnerRowSelect,
    mapV2SessionOwnerRow,
} from "./v2SessionListRows";
import {
    createSessionMetadataPrivacyUpgradeRequiredResponse,
    isSessionMetadataPrivacyUpgradeRequiredError,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";

export function registerSessionLookupByTagsRoute(app: Fastify) {
    app.post("/v2/sessions/lookup-by-tags", {
        preHandler: app.authenticate,
        schema: {
            body: SessionLookupByTagsRequestV2Schema,
            response: {
                200: SessionLookupByTagsResponseV2Schema,
                409: z.object({
                    error: z.literal("Session metadata privacy upgrade required"),
                    code: z.literal("metadata_privacy_upgrade_required"),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const sessions = await db.session.findMany({
            where: {
                accountId: userId,
                tag: { in: request.body.tags },
            },
            orderBy: { tag: "asc" },
            take: SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2,
            select: createV2SessionOwnerRowSelect(),
        });

        try {
            return reply.send({
                sessions: sessions.map(mapV2SessionOwnerRow),
            });
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }
    });
}
