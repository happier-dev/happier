import { type Fastify } from "../../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { resolveSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { createSessionMetadataPrivacyUpgradeRequiredResponse } from "@/app/session/metadata/sessionMetadataRecipientProjection";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { writeSessionPublicShare, deleteSessionPublicShare } from "@/app/share/storedContentPublicShare";
import { resolveStoredContentPublicShareOrigin } from "@/app/share/storedContentPublicShareOrigin";

export function registerPublicShareOwnerRoutes(app: Fastify): void {
    /**
     * Create or update the public-link desired state for a Session.
     * An exact retry returns the stored state without resetting usage,
     * advancing timestamps, or publishing duplicate invalidations.
     */
    app.post('/v1/sessions/:sessionId/public-share', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "share.public.manage"),
        },
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                lookupId: z.string().min(1).optional(), // fragment-link lookup capability (required when creating or rotating)
                keyDerivation: z.literal("fragment_v1").optional(),
                encryptedDataKey: z.string().optional(), // base64 encoded (required when creating or rotating)
                expiresAt: z.number().optional(), // timestamp
                maxUses: z.number().int().positive().optional(),
                isConsentRequired: z.boolean().optional(), // require consent for detailed logging
                networkOff: z.boolean().optional(),
            }).strict()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const { lookupId, encryptedDataKey, expiresAt, maxUses, isConsentRequired, networkOff } = request.body;

        // Only owner can create public shares
        const admission = await resolveSessionAccessForOperation(db, {
            accountId: userId,
            sessionId,
            authentication,
            capability: "managePublicLink",
        });
        if (admission.status !== "allowed" || !admission.access.capabilities.managePublicLink) {
            return reply.code(403).send({ error: 'session_access_forbidden' });
        }

        const result = await writeSessionPublicShare({ userId, sessionId, authentication, lookupId, encryptedDataKey, expiresAt, maxUses, isConsentRequired, networkOff });

        if (result.type === "forbidden") {
            return reply.code(403).send({ error: "session_access_forbidden" });
        }
        if (result.type === 'publication-error') {
            return reply.code(409).send({ error: result.error, code: result.code });
        }
        if (result.type === "external-sharing-error") {
            return reply.code(
                result.error === "session_access_authentication_unavailable"
                    ? 503
                    : result.error === "session_access_external_sharing_requires_team_admin"
                    || result.error === "session_access_external_sharing_disabled"
                    || result.error === "session_access_authentication_required"
                    ? 403
                    : 409,
            )
                .send({ error: result.error });
        }
        if (result.type === "privacy-error") {
            return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
        }
        if (result.type === 'error') {
            return reply.code(result.error === "public_share_isolation_unavailable" ? 503 : 400).send({ error: result.error });
        }
        const publicShare = result.publicShare;

        return reply.send({
            ...(publicShare.keyDerivation === "fragment_v1" ? { isolatedOrigin: resolveStoredContentPublicShareOrigin(publicShare.id) } : {}),
            publicShare: {
                id: publicShare.id,
                keyDerivation: publicShare.keyDerivation,
                token: lookupId ?? null,
                expiresAt: publicShare.expiresAt?.getTime() ?? null,
                maxUses: publicShare.maxUses,
                useCount: publicShare.useCount,
                isConsentRequired: publicShare.isConsentRequired,
                networkOff: publicShare.networkOff,
                createdAt: publicShare.createdAt.getTime(),
                updatedAt: publicShare.updatedAt.getTime()
            }
        });
    });

    /**
     * Get public share info for a session
     */
    app.get('/v1/sessions/:sessionId/public-share', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const authentication = readSessionAccessAuthenticationFromRequest(request);

        // Only owner can view public share settings
        const admission = await resolveSessionAccessForOperation(db, {
            accountId: userId,
            sessionId,
            authentication,
            capability: "managePublicLink",
        });
        if (admission.status !== "allowed" || !admission.access.capabilities.managePublicLink) {
            return reply.code(403).send({ error: 'session_access_forbidden' });
        }

        const publicShare = await db.publicSessionShare.findUnique({
            where: { sessionId }
        });

        if (!publicShare) {
            return reply.send({ publicShare: null });
        }

        return reply.send({
            ...(publicShare.keyDerivation === "fragment_v1" ? { isolatedOrigin: resolveStoredContentPublicShareOrigin(publicShare.id) } : {}),
            publicShare: {
                id: publicShare.id,
                keyDerivation: publicShare.keyDerivation,
                token: null,
                expiresAt: publicShare.expiresAt?.getTime() ?? null,
                maxUses: publicShare.maxUses,
                useCount: publicShare.useCount,
                isConsentRequired: publicShare.isConsentRequired,
                networkOff: publicShare.networkOff,
                createdAt: publicShare.createdAt.getTime(),
                updatedAt: publicShare.updatedAt.getTime()
            }
        });
    });

    /**
     * Delete public share (disable public link)
     */
    app.delete('/v1/sessions/:sessionId/public-share', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const authentication = readSessionAccessAuthenticationFromRequest(request);

        const result = await deleteSessionPublicShare({ userId, sessionId, authentication });
        if (result.type === "forbidden") {
            return reply.code(403).send({ error: "session_access_forbidden" });
        }
        if (result.type === "not-found") {
            return reply.code(404).send({ error: 'Share not found' });
        }

        return reply.send({ success: true });
    });
}
