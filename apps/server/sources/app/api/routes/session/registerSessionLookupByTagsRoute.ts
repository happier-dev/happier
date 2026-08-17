import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
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
    readSessionMetadataOwnerAccountMode,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import {
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";

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
                426: z.unknown(),
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
        if (
            sessions.some((session) =>
                session.metadataLayoutVersion
                    === SESSION_METADATA_LAYOUT_VERSION_V1)
            && !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            )
        ) {
            return;
        }

        try {
            const requiresOwnerAccountMode = sessions.some(
                (session) => session.metadataLayoutVersion
                    === SESSION_METADATA_LAYOUT_VERSION_V1,
            );
            const ownerAccountMode = requiresOwnerAccountMode
                ? await readSessionMetadataOwnerAccountMode(
                    db,
                    userId,
                )
                : undefined;
            return reply.send({
                sessions: sessions.map((session) =>
                    mapV2SessionOwnerRow(
                        session,
                        ownerAccountMode,
                    )),
            });
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }
    });
}
