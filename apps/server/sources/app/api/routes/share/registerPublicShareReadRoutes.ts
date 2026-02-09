import { type Fastify } from "../../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { logPublicShareAccess, getIpAddress, getUserAgent } from "@/app/share/accessLogger";
import { PROFILE_SELECT, toShareUserProfile } from "@/app/share/types";
import { createHash } from "crypto";
import { auth } from "@/app/auth/auth";

async function getOptionalAuthenticatedUserId(request: any): Promise<string | null> {
    const authHeader = request?.headers?.authorization;
    if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
        return null;
    }

    try {
        const token = authHeader.substring(7);
        const verified = await auth.verifyToken(token);
        return verified?.userId ?? null;
    } catch {
        return null;
    }
}

export function registerPublicShareReadRoutes(app: Fastify): void {
    /**
     * Access session via public share token (no auth required)
     *
     * If isConsentRequired is true, client must pass consent=true query param
     */
    app.get('/v1/public-share/:token', {
        config: {
            rateLimit: {
                max: 10,
                timeWindow: '1 minute'
            }
        },
        schema: {
            params: z.object({
                token: z.string()
            }),
            querystring: z.object({
                consent: z.coerce.boolean().optional()
            }).optional()
        }
    }, async (request, reply) => {
        const { token } = request.params;
        const { consent } = request.query || {};
        const tokenHash = createHash('sha256').update(token, 'utf8').digest();

        // Optional auth: never call `app.authenticate()` here because it sends a reply on failure,
        // which can cause "Reply was already sent" issues for public routes.
        const userId = await getOptionalAuthenticatedUserId(request);

        // Use transaction to atomically check limits and increment use count
        const result = await db.$transaction(async (tx) => {
            // Check access and get full public share data
            const publicShare = await tx.publicSessionShare.findUnique({
                where: { tokenHash },
                select: {
                    id: true,
                    sessionId: true,
                    expiresAt: true,
                    maxUses: true,
                    useCount: true,
                    isConsentRequired: true,
                    encryptedDataKey: true,
                    blockedUsers: userId ? {
                        where: { userId },
                        select: { id: true }
                    } : undefined
                }
            });

            if (!publicShare) {
                return { error: 'Public share not found or expired' };
            }

            // Check if expired
            if (publicShare.expiresAt && publicShare.expiresAt < new Date()) {
                return { error: 'Public share not found or expired' };
            }

            // Check if max uses exceeded (before incrementing)
            if (publicShare.maxUses && publicShare.useCount >= publicShare.maxUses) {
                return { error: 'Public share not found or expired' };
            }

            // Check if user is blocked
            if (userId && publicShare.blockedUsers && publicShare.blockedUsers.length > 0) {
                return { error: 'Public share not found or expired' };
            }

            // Check consent requirement
            if (publicShare.isConsentRequired && !consent) {
                return {
                    error: 'Consent required',
                    requiresConsent: true,
                    publicShareId: publicShare.id,
                    sessionId: publicShare.sessionId
                };
            }

            // Increment use count atomically
            await tx.publicSessionShare.update({
                where: { id: publicShare.id },
                data: { useCount: { increment: 1 } }
            });

            return {
                success: true,
                publicShareId: publicShare.id,
                sessionId: publicShare.sessionId,
                isConsentRequired: publicShare.isConsentRequired,
                encryptedDataKey: publicShare.encryptedDataKey
            };
        });

        // Handle errors from transaction
        if ('error' in result) {
            if (result.requiresConsent) {
                // Get owner info even when consent is required
                const session = await db.session.findUnique({
                    where: { id: result.sessionId },
                    select: {
                        account: {
                            select: PROFILE_SELECT
                        }
                    }
                });

                return reply.code(403).send({
                    error: result.error,
                    requiresConsent: true,
                    sessionId: result.sessionId,
                    owner: session?.account ? toShareUserProfile(session.account) : null
                });
            }
            return reply.code(404).send({ error: result.error });
        }

        // Log access (only log IP/UA if consent was given)
        const ipAddress = result.isConsentRequired ? getIpAddress(request.headers) : undefined;
        const userAgent = result.isConsentRequired ? getUserAgent(request.headers) : undefined;
        await logPublicShareAccess(result.publicShareId, userId, ipAddress, userAgent);

        // Get session info with owner profile
        const session = await db.session.findUnique({
            where: { id: result.sessionId },
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                active: true,
                lastActiveAt: true,
                account: {
                    select: PROFILE_SELECT
                }
            }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        return reply.send({
            session: {
                id: session.id,
                seq: session.seq,
                createdAt: session.createdAt.getTime(),
                updatedAt: session.updatedAt.getTime(),
                active: session.active,
                activeAt: session.lastActiveAt.getTime(),
                metadata: session.metadata,
                metadataVersion: session.metadataVersion,
                agentState: session.agentState,
                agentStateVersion: session.agentStateVersion
            },
            owner: toShareUserProfile(session.account),
            accessLevel: 'view',
            encryptedDataKey: Buffer.from(result.encryptedDataKey).toString('base64'),
            isConsentRequired: result.isConsentRequired
        });
    });

    /**
     * Get messages for a public share token (no auth required, read-only)
     *
     * NOTE: Does not increment useCount (useCount is incremented on /v1/public-share/:token).
     */
    app.get('/v1/public-share/:token/messages', {
        config: {
            rateLimit: {
                max: 20,
                timeWindow: '1 minute'
            }
        },
        schema: {
            params: z.object({
                token: z.string()
            }),
            querystring: z.object({
                consent: z.coerce.boolean().optional()
            }).optional()
        }
    }, async (request, reply) => {
        const { token } = request.params;
        const { consent } = request.query || {};
        const tokenHash = createHash('sha256').update(token, 'utf8').digest();

        // Optional auth: never call `app.authenticate()` here because it sends a reply on failure,
        // which can cause "Reply was already sent" issues for public routes.
        const userId = await getOptionalAuthenticatedUserId(request);

        const publicShare = await db.publicSessionShare.findUnique({
            where: { tokenHash },
            select: {
                id: true,
                sessionId: true,
                expiresAt: true,
                maxUses: true,
                useCount: true,
                isConsentRequired: true,
                blockedUsers: userId ? {
                    where: { userId },
                    select: { id: true }
                } : undefined
            }
        });

        if (!publicShare) {
            return reply.code(404).send({ error: 'Public share not found or expired' });
        }

        // Check if expired
        if (publicShare.expiresAt && publicShare.expiresAt < new Date()) {
            return reply.code(404).send({ error: 'Public share not found or expired' });
        }

        // Check if max uses exceeded
        if (publicShare.maxUses && publicShare.useCount >= publicShare.maxUses) {
            return reply.code(404).send({ error: 'Public share not found or expired' });
        }

        // Check if user is blocked
        if (userId && publicShare.blockedUsers && publicShare.blockedUsers.length > 0) {
            return reply.code(404).send({ error: 'Public share not found or expired' });
        }

        // Check consent requirement
        if (publicShare.isConsentRequired && !consent) {
            const session = await db.session.findUnique({
                where: { id: publicShare.sessionId },
                select: {
                    account: {
                        select: PROFILE_SELECT
                    }
                }
            });

            return reply.code(403).send({
                error: 'Consent required',
                requiresConsent: true,
                sessionId: publicShare.sessionId,
                owner: session?.account ? toShareUserProfile(session.account) : null
            });
        }

        const messages = await db.sessionMessage.findMany({
            where: { sessionId: publicShare.sessionId },
            orderBy: { createdAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                localId: true,
                content: true,
                createdAt: true,
                updatedAt: true
            }
        });

        return reply.send({
            messages: messages.map((v) => ({
                id: v.id,
                seq: v.seq,
                content: v.content,
                localId: v.localId,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime()
            }))
        });
    });
}
