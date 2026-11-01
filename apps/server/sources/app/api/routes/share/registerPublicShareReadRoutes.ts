import { type Fastify } from "../../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { logPublicShareAccess, getUserAgent } from "@/app/share/accessLogger";
import { PROFILE_SELECT, toShareUserProfile } from "@/app/share/types";
import { createHash } from "crypto";
import { auth } from "@/app/auth/auth";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import { inTx, type Tx } from "@/storage/inTx";
import * as privacyKit from "privacy-kit";
import { tryParsePersistedEncryptedDataKeyEnvelopeV1 } from "./encryptedDataKeyValidation";
import {
    createPublicShareMessagesAccessToken,
    PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER,
    requirePublicShareAccessGrantSecret,
    resolvePublicShareUseLimit,
    validatePublicShareMessagesAccessToken,
} from "./publicShareMessageAccessGrant";

const PublicShareConsentQuerySchema = z.object({
    consent: z.union([
        z.literal(true),
        z.literal(false),
        z.literal("true"),
        z.literal("false"),
        z.literal("0"),
        z.literal(0),
    ]).transform((value) => value === true || value === "true").optional(),
}).optional();

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

interface PublicShareUseRecord {
    id: string;
    maxUses: number | null;
    expiresAt: Date | null;
    isConsentRequired: boolean;
}

async function consumePublicShareUse(
    tx: Tx,
    publicShare: PublicShareUseRecord,
    tokenHash: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
    const useLimit = resolvePublicShareUseLimit(publicShare.maxUses);
    if (useLimit.type === "invalid") return false;
    const consumed = await tx.publicSessionShare.updateMany({
        where: {
            id: publicShare.id,
            tokenHash,
            maxUses: publicShare.maxUses,
            expiresAt: publicShare.expiresAt,
            isConsentRequired: publicShare.isConsentRequired,
            ...(useLimit.type === "capped" ? {
                useCount: { lt: useLimit.maxUses },
            } : {}),
        },
        data: { useCount: { increment: 1 } },
    });
    return consumed.count === 1;
}

export function registerPublicShareReadRoutes(app: Fastify): void {
    /**
     * Access session via public share token (no auth required)
     *
     * If isConsentRequired is true, client must pass consent=true query param
     */
    app.get('/v1/public-share/:token', {
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "share.public.read"),
        },
        schema: {
            params: z.object({
                token: z.string()
            }),
            querystring: PublicShareConsentQuerySchema,
        }
    }, async (request, reply) => {
        const { token } = request.params;
        const { consent } = request.query || {};
        const tokenHashDigest = createHash('sha256').update(token, 'utf8').digest();
        const tokenHash: Uint8Array<ArrayBuffer> = new Uint8Array(tokenHashDigest.byteLength);
        tokenHash.set(tokenHashDigest);
        const tokenHashHex = tokenHashDigest.toString("hex");

        // Optional auth: never call `app.authenticate()` here because it sends a reply on failure,
        // which can cause "Reply was already sent" issues for public routes.
        const userId = await getOptionalAuthenticatedUserId(request);
        const ipAddress = request.ip;
        const userAgent = getUserAgent(request.headers);

        // Use transaction to atomically check limits and increment use count
        const result = await inTx(async (tx) => {
            // Check access and get full public share data
            const publicShare = await tx.publicSessionShare.findUnique({
                where: { tokenHash },
                select: {
                    id: true,
                    sessionId: true,
                    expiresAt: true,
                    maxUses: true,
                    isConsentRequired: true,
                    encryptedDataKey: true,
                }
            });

            if (!publicShare) {
                return { error: 'Public share not found or expired' };
            }

            // Check if expired
            if (publicShare.expiresAt && publicShare.expiresAt < new Date()) {
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

            const useLimit = resolvePublicShareUseLimit(publicShare.maxUses);
            if (useLimit.type === "invalid") {
                return { error: 'Public share not found or expired' };
            }

            const session = await tx.session.findUnique({
                where: { id: publicShare.sessionId },
                select: {
                    id: true,
                    seq: true,
                    encryptionMode: true,
                    createdAt: true,
                    updatedAt: true,
                    metadata: true,
                    metadataVersion: true,
                    agentState: true,
                    agentStateVersion: true,
                    active: true,
                    lastActiveAt: true,
                    account: {
                        select: PROFILE_SELECT,
                    },
                },
            });
            if (!session) {
                return { error: 'Public share not found or expired' };
            }
            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
            let encryptedDataKey: Uint8Array<ArrayBuffer> | null = null;
            if (sessionEncryptionMode === "e2ee") {
                const parsedEncryptedDataKey = tryParsePersistedEncryptedDataKeyEnvelopeV1(publicShare.encryptedDataKey);
                if (parsedEncryptedDataKey.type === "error") {
                    return { error: "Public share not found or expired" };
                }
                encryptedDataKey = parsedEncryptedDataKey.encryptedDataKey;
            }

            const consumed = await consumePublicShareUse(tx, publicShare, tokenHash);
            if (!consumed) {
                return { error: 'Public share not found or expired' };
            }
            await logPublicShareAccess(
                publicShare.id,
                userId,
                publicShare.isConsentRequired ? ipAddress : undefined,
                publicShare.isConsentRequired ? userAgent : undefined,
                tx,
            );
            const messagesAccessToken = useLimit.type === "capped"
                ? createPublicShareMessagesAccessToken({
                    secret: requirePublicShareAccessGrantSecret(),
                    publicShareId: publicShare.id,
                    sessionId: publicShare.sessionId,
                    tokenHashHex,
                })
                : undefined;

            return {
                success: true,
                publicShareId: publicShare.id,
                session,
                isConsentRequired: publicShare.isConsentRequired,
                encryptedDataKey,
                messagesAccessToken,
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

        const session = result.session;
        const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
        const encryptedDataKeyB64 =
            sessionEncryptionMode === "plain"
                ? null
                : result.encryptedDataKey
                    ? privacyKit.encodeBase64(result.encryptedDataKey)
                    : null;
        if (sessionEncryptionMode === "e2ee" && !encryptedDataKeyB64) {
            return reply.code(404).send({ error: "Public share not found or expired" });
        }

        return reply.send({
            session: {
                id: session.id,
                seq: session.seq,
                encryptionMode: sessionEncryptionMode,
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
            encryptedDataKey: encryptedDataKeyB64,
            isConsentRequired: result.isConsentRequired,
            messagesAccessToken: result.messagesAccessToken,
        });
    });

    /**
     * Get messages for a public share token (no auth required, read-only)
     */
    app.get('/v1/public-share/:token/messages', {
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "share.public.messages"),
        },
        schema: {
            params: z.object({
                token: z.string()
            }),
            querystring: PublicShareConsentQuerySchema,
        }
    }, async (request, reply) => {
        const { token } = request.params;
        const { consent } = request.query || {};
        const tokenHash = createHash('sha256').update(token, 'utf8').digest();
        const tokenHashHex = tokenHash.toString("hex");
        const messageAccessTokenHeader = request.headers[PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER];
        const messagesAccessToken = Array.isArray(messageAccessTokenHeader)
            ? messageAccessTokenHeader[0]
            : messageAccessTokenHeader;

        // Optional auth: never call `app.authenticate()` here because it sends a reply on failure,
        // which can cause "Reply was already sent" issues for public routes.
        const userId = await getOptionalAuthenticatedUserId(request);

        const accessResult = await inTx(async (tx) => {
            const publicShare = await tx.publicSessionShare.findUnique({
                where: { tokenHash },
                select: {
                    id: true,
                    sessionId: true,
                    expiresAt: true,
                    maxUses: true,
                    isConsentRequired: true,
                    encryptedDataKey: true,
                }
            });

            if (!publicShare) {
                return { error: 'Public share not found or expired' };
            }

            if (publicShare.expiresAt && publicShare.expiresAt < new Date()) {
                return { error: 'Public share not found or expired' };
            }

            if (publicShare.isConsentRequired && !consent) {
                return {
                    error: 'Consent required',
                    requiresConsent: true,
                    sessionId: publicShare.sessionId,
                };
            }

            const useLimit = resolvePublicShareUseLimit(publicShare.maxUses);
            if (useLimit.type === "invalid") {
                return { error: 'Public share not found or expired' };
            }

            if (useLimit.type === "capped") {
                const hasMessageAccess = validatePublicShareMessagesAccessToken({
                    secret: requirePublicShareAccessGrantSecret(),
                    token: messagesAccessToken,
                    publicShareId: publicShare.id,
                    sessionId: publicShare.sessionId,
                    tokenHashHex,
                });
                if (!hasMessageAccess) {
                    return { error: 'Public share not found or expired' };
                }
            }

            const session = await tx.session.findUnique({
                where: { id: publicShare.sessionId },
                select: { encryptionMode: true },
            });
            if (!session) {
                return { error: 'Public share not found or expired' };
            }
            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
            if (sessionEncryptionMode === "e2ee") {
                const parsedEncryptedDataKey = tryParsePersistedEncryptedDataKeyEnvelopeV1(publicShare.encryptedDataKey);
                if (parsedEncryptedDataKey.type === "error") {
                    return { error: "Public share not found or expired" };
                }
            }

            const pageSize = 150;
            const fetchedMessages = await tx.sessionMessage.findMany({
                where: { sessionId: publicShare.sessionId, sidechainId: null },
                // Canonical transcript order is seq, not wall-clock: createdAt can
                // disagree with seq (imported/migrated sessions, clock skew, out-of-order
                // writes), and selecting the newest page by createdAt silently omits
                // newer transcript rows under the page cap.
                orderBy: { seq: 'desc' },
                take: pageSize + 1,
                select: {
                    id: true,
                    seq: true,
                    localId: true,
                    messageRole: true,
                    content: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });

            const hasMore = fetchedMessages.length > pageSize;
            const messages = hasMore ? fetchedMessages.slice(0, pageSize) : fetchedMessages;
            return { success: true, messages, hasMore };
        });

        if ('error' in accessResult) {
            if (accessResult.requiresConsent) {
                const session = await db.session.findUnique({
                    where: { id: accessResult.sessionId },
                    select: {
                        account: {
                            select: PROFILE_SELECT
                        }
                    }
                });

                return reply.code(403).send({
                    error: 'Consent required',
                    requiresConsent: true,
                    sessionId: accessResult.sessionId,
                    owner: session?.account ? toShareUserProfile(session.account) : null
                });
            }
            return reply.code(404).send({ error: accessResult.error });
        }

        return reply.send({
            messages: accessResult.messages.map((v) => {
                const messageRole = parseSessionMessageRole(v.messageRole);
                return {
                    id: v.id,
                    seq: v.seq,
                    ...(messageRole ? { messageRole } : {}),
                    content: v.content,
                    localId: v.localId,
                    createdAt: v.createdAt.getTime(),
                    updatedAt: v.updatedAt.getTime()
                };
            }),
            hasMore: accessResult.hasMore,
        });
    });
}
