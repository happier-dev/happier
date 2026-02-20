import { type Fastify } from "../../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { isSessionOwner } from "@/app/share/accessControl";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import {
    eventRouter,
    buildPublicShareCreatedUpdate,
    buildPublicShareUpdatedUpdate,
    buildPublicShareDeletedUpdate,
} from "@/app/events/eventRouter";
import { createHash } from "crypto";
import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";

export function registerPublicShareOwnerRoutes(app: Fastify): void {
    /**
     * Create or update public share for a session
     */
    app.post('/v1/sessions/:sessionId/public-share', {
        preHandler: app.authenticate,
        config: {
            rateLimit: {
                max: 10,
                timeWindow: '1 minute'
            }
        },
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                token: z.string().optional(), // client-generated token (required when creating or rotating)
                encryptedDataKey: z.string().optional(), // base64 encoded (required when creating or rotating)
                expiresAt: z.number().optional(), // timestamp
                maxUses: z.number().int().positive().optional(),
                isConsentRequired: z.boolean().optional() // require consent for detailed logging
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { token, encryptedDataKey, expiresAt, maxUses, isConsentRequired } = request.body;

        // Only owner can create public shares
        if (!await isSessionOwner(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const result = await inTx(async (tx) => {
            const session = await tx.session.findUnique({
                where: { id: sessionId },
                select: { encryptionMode: true },
            });
            if (!session) {
                return { type: 'error' as const, error: 'session not found' as const };
            }
            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";

            const existing = await tx.publicSessionShare.findUnique({
                where: { sessionId }
            });

            let publicShare;
            const isUpdate = !!existing;

            if (existing) {
                const shouldRotateToken = typeof token === 'string' && token.length > 0;
                if (shouldRotateToken && sessionEncryptionMode === "e2ee" && !encryptedDataKey) {
                    return { type: 'error' as const, error: 'encryptedDataKey required when rotating token' as const };
                }
                const nextTokenHash = shouldRotateToken ? createHash('sha256').update(token!, 'utf8').digest() : null;

                publicShare = await tx.publicSessionShare.update({
                    where: { sessionId },
                    data: {
                        ...(nextTokenHash ? { tokenHash: nextTokenHash } : {}),
                        ...(sessionEncryptionMode === "plain"
                            ? { encryptedDataKey: null }
                            : encryptedDataKey
                                ? { encryptedDataKey: new Uint8Array(Buffer.from(encryptedDataKey, 'base64')) }
                                : {}),
                        expiresAt: expiresAt ? new Date(expiresAt) : null,
                        maxUses: maxUses ?? null,
                        isConsentRequired: isConsentRequired ?? false,
                        ...(nextTokenHash ? { useCount: 0 } : {}),
                    }
                });
            } else {
                if (!token) {
                    return { type: 'error' as const, error: 'token required' as const };
                }
                if (sessionEncryptionMode === "e2ee" && !encryptedDataKey) {
                    return { type: 'error' as const, error: 'encryptedDataKey required' as const };
                }
                const tokenHash = createHash('sha256').update(token, 'utf8').digest();

                publicShare = await tx.publicSessionShare.create({
                    data: {
                        sessionId,
                        createdByUserId: userId,
                        tokenHash,
                        encryptedDataKey:
                            sessionEncryptionMode === "plain"
                                ? null
                                : new Uint8Array(Buffer.from(encryptedDataKey!, 'base64')),
                        expiresAt: expiresAt ? new Date(expiresAt) : null,
                        maxUses: maxUses ?? null,
                        isConsentRequired: isConsentRequired ?? false
                    }
                });
            }

            const shareCursor = await markAccountChanged(tx, { accountId: userId, kind: 'share', entityId: sessionId });
            const sessionCursor = await markAccountChanged(tx, { accountId: userId, kind: 'session', entityId: sessionId });
            const cursor = Math.max(shareCursor, sessionCursor);

            afterTx(tx, () => {
                const updatePayload = isUpdate
                    ? buildPublicShareUpdatedUpdate(publicShare, cursor, randomKeyNaked(12))
                    : buildPublicShareCreatedUpdate({ ...publicShare, token: token! }, cursor, randomKeyNaked(12));

                eventRouter.emitUpdate({
                    userId: userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId }
                });
            });

            return { type: 'ok' as const, publicShare };
        });

        if (result.type === 'error') {
            return reply.code(400).send({ error: result.error });
        }
        const publicShare = result.publicShare;

        return reply.send({
            publicShare: {
                id: publicShare.id,
                token: token ?? null,
                expiresAt: publicShare.expiresAt?.getTime() ?? null,
                maxUses: publicShare.maxUses,
                useCount: publicShare.useCount,
                isConsentRequired: publicShare.isConsentRequired,
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

        // Only owner can view public share settings
        if (!await isSessionOwner(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const publicShare = await db.publicSessionShare.findUnique({
            where: { sessionId }
        });

        if (!publicShare) {
            return reply.send({ publicShare: null });
        }

        return reply.send({
            publicShare: {
                id: publicShare.id,
                token: null,
                expiresAt: publicShare.expiresAt?.getTime() ?? null,
                maxUses: publicShare.maxUses,
                useCount: publicShare.useCount,
                isConsentRequired: publicShare.isConsentRequired,
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

        // Only owner can delete public share
        if (!await isSessionOwner(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const deleted = await inTx(async (tx) => {
            const existing = await tx.publicSessionShare.findUnique({
                where: { sessionId }
            });

            if (!existing) {
                return false;
            }

            await tx.publicSessionShare.delete({
                where: { sessionId }
            });

            const shareCursor = await markAccountChanged(tx, { accountId: userId, kind: 'share', entityId: sessionId });
            const sessionCursor = await markAccountChanged(tx, { accountId: userId, kind: 'session', entityId: sessionId });
            const cursor = Math.max(shareCursor, sessionCursor);

            afterTx(tx, () => {
                const updatePayload = buildPublicShareDeletedUpdate(
                    sessionId,
                    cursor,
                    randomKeyNaked(12)
                );

                eventRouter.emitUpdate({
                    userId: userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'all-interested-in-session', sessionId }
                });
            });

            return true;
        });

        if (!deleted) {
            return reply.code(404).send({ error: 'Share not found' });
        }

        return reply.send({ success: true });
    });
}
