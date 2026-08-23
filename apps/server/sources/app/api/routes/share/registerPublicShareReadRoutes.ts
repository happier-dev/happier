import { type Fastify } from "../../types";
import { z } from "zod";
import { logPublicShareAccess, getIpAddress, getUserAgent } from "@/app/share/accessLogger";
import { PROFILE_SELECT, toShareUserProfile } from "@/app/share/types";
import { createHash } from "crypto";
import { auth } from "@/app/auth/auth";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { parseSessionMessageRole } from "@/app/session/messageRole/resolveSessionMessageRole";
import {
    buildShareableSessionMessagePublicationWhere,
    isSessionTranscriptShareable,
    projectSessionTranscriptPublicationPreview,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import { inTx, type Tx } from "@/storage/inTx";
import { tryParseEncryptedDataKeyV0Bytes } from "./encryptedDataKeyValidation";
import {
    createPublicShareMessagesAccessToken,
    PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER,
    requirePublicShareAccessGrantSecret,
    resolvePublicShareUseLimit,
    validatePublicShareMessagesAccessToken,
} from "./publicShareMessageAccessGrant";
import {
    createSessionMetadataPrivacyUpgradeRequiredResponse,
    isSessionMetadataPrivacyUpgradeRequiredError,
    projectSessionMetadataForRecipient,
    readSessionMetadataOwnerAccountMode,
    SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_CODE,
    SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_MESSAGE,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import {
    captureAccountStoredContentCompatibilityForHttpRequest,
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
    readAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { SESSION_METADATA_LAYOUT_VERSION_V1 } from "@happier-dev/protocol";

const PublicShareConsentSchema = z.union([
    z.literal(true),
    z.literal(false),
    z.literal("true"),
    z.literal("false"),
    z.literal("0"),
    z.literal(0),
]).transform((value) => value === true || value === "true").optional();

const PublicShareConsentQuerySchema = z.object({
    consent: PublicShareConsentSchema,
}).optional();

/**
 * Public shares page exactly like an ordinary transcript read: newest page first, then
 * `beforeSeq` walks backwards while `hasMore`/`nextBeforeSeq` describe the remainder.
 * A single unpaged read silently began a long conversation mid-sentence.
 */
const PUBLIC_SHARE_MESSAGES_DEFAULT_PAGE_ROWS = 150;
const PUBLIC_SHARE_MESSAGES_MAX_PAGE_ROWS = 500;

const PublicShareMessagesQuerySchema = z.object({
    consent: PublicShareConsentSchema,
    beforeSeq: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(PUBLIC_SHARE_MESSAGES_MAX_PAGE_ROWS).optional(),
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

type PublicShareUseRecord = Readonly<{
    id: string;
    maxUses: number | null;
    expiresAt: Date | null;
    isConsentRequired: boolean;
}>;

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
        const ipAddress = getIpAddress(request.headers);
        const userAgent = getUserAgent(request.headers);
        captureAccountStoredContentCompatibilityForHttpRequest(request);
        const supportsCurrentProtocol =
            readAccountStoredContentCompatibilityForHttpRequest(request)
                .supportsCurrentProtocol;

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
                    encryptedDataKey: true
                }
            });

            if (!publicShare) {
                return { error: 'Public share not found or expired' };
            }

            // Check if expired
            if (publicShare.expiresAt && publicShare.expiresAt < new Date()) {
                return { error: 'Public share not found or expired' };
            }

            const session = await tx.session.findUnique({
                where: { id: publicShare.sessionId },
                select: {
                    id: true,
                    encryptionMode: true,
                    createdAt: true,
                    updatedAt: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    active: true,
                    lastActiveAt: true,
                    account: {
                        select: PROFILE_SELECT,
                    },
                    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                },
            });
            if (!session) {
                return { error: 'Public share not found or expired' };
            }
            if (
                session.metadataLayoutVersion
                    === SESSION_METADATA_LAYOUT_VERSION_V1
                && !supportsCurrentProtocol
            ) {
                return {
                    error: "Client upgrade required",
                    clientUpgradeRequired: true as const,
                };
            }
            if (!isSessionTranscriptShareable(session)) {
                return {
                    error: 'Transcript unavailable',
                    code: 'session_transcript_unavailable' as const,
                };
            }
            let metadataProjection;
            try {
                const ownerAccountMode = session.metadataLayoutVersion
                    === SESSION_METADATA_LAYOUT_VERSION_V1
                    ? await readSessionMetadataOwnerAccountMode(
                        tx,
                        session.accountId,
                    )
                    : undefined;
                metadataProjection = projectSessionMetadataForRecipient({
                    session,
                    recipient: {
                        type: "shared",
                        accountId: null,
                        ownerAccountMode,
                    },
                });
            } catch (error) {
                if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                    return {
                        error: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_MESSAGE,
                        code: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_CODE,
                        privacyUpgradeRequired: true as const,
                    };
                }
                throw error;
            }

            // Check consent requirement
            if (publicShare.isConsentRequired && !consent) {
                return {
                    error: 'Consent required',
                    requiresConsent: true,
                    publicShareId: publicShare.id,
                    sessionId: publicShare.sessionId,
                    owner: toShareUserProfile(session.account),
                };
            }

            const useLimit = resolvePublicShareUseLimit(publicShare.maxUses);
            if (useLimit.type === "invalid") {
                return { error: 'Public share not found or expired' };
            }

            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
            let encryptedDataKey: Uint8Array<ArrayBuffer> | null = null;
            if (sessionEncryptionMode === "e2ee") {
                const parsedEncryptedDataKey = tryParseEncryptedDataKeyV0Bytes(publicShare.encryptedDataKey);
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
                sessionId: publicShare.sessionId,
                isConsentRequired: publicShare.isConsentRequired,
                encryptedDataKey,
                messagesAccessToken,
                session,
                metadataProjection,
            };
        });

        // Handle errors from transaction
        if ('error' in result) {
            if (
                "clientUpgradeRequired" in result
                && result.clientUpgradeRequired
            ) {
                await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                    request,
                    reply,
                );
                return;
            }
            if ('privacyUpgradeRequired' in result && result.privacyUpgradeRequired) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            if (result.requiresConsent) {
                return reply.code(403).send({
                    error: result.error,
                    requiresConsent: true,
                    sessionId: result.sessionId,
                    owner: result.owner,
                });
            }
            return reply.code(404).send({
                error: result.error,
                ...('code' in result ? { code: result.code } : {}),
            });
        }

        const session = result.session;
        const publicationProjection = projectSessionTranscriptPublicationPreview({
            seq: session.seq,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            lastActiveAt: session.lastActiveAt,
        }, session);

        const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
        const encryptedDataKeyB64 =
            sessionEncryptionMode === "plain"
                ? null
                : result.encryptedDataKey
                    ? Buffer.from(result.encryptedDataKey).toString("base64")
                    : null;
        if (sessionEncryptionMode === "e2ee" && !encryptedDataKeyB64) {
            return reply.code(404).send({ error: "Public share not found or expired" });
        }

        return reply.send({
            session: {
                id: session.id,
                seq: publicationProjection.seq,
                encryptionMode: sessionEncryptionMode,
                createdAt: session.createdAt.getTime(),
                updatedAt: publicationProjection.updatedAt,
                active: publicationProjection.hasLiveFacts && session.active,
                activeAt: publicationProjection.activeAt,
                ...result.metadataProjection,
            },
            owner: toShareUserProfile(session.account),
            accessLevel: 'view',
            encryptedDataKey: encryptedDataKeyB64,
            isConsentRequired: result.isConsentRequired,
            messagesAccessToken: result.messagesAccessToken
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
            querystring: PublicShareMessagesQuerySchema,
        }
    }, async (request, reply) => {
        const { token } = request.params;
        const { consent, beforeSeq, limit: requestedLimit } = request.query || {};
        const limit = requestedLimit ?? PUBLIC_SHARE_MESSAGES_DEFAULT_PAGE_ROWS;
        const tokenHash = createHash('sha256').update(token, 'utf8').digest();
        const tokenHashHex = tokenHash.toString("hex");
        const messageAccessTokenHeader = request.headers[PUBLIC_SHARE_MESSAGES_ACCESS_TOKEN_HEADER];
        const messagesAccessToken = Array.isArray(messageAccessTokenHeader)
            ? messageAccessTokenHeader[0]
            : messageAccessTokenHeader;

        // Optional auth: never call `app.authenticate()` here because it sends a reply on failure,
        // which can cause "Reply was already sent" issues for public routes.
        await getOptionalAuthenticatedUserId(request);

        const accessResult = await inTx(async (tx) => {
            const publicShare = await tx.publicSessionShare.findUnique({
                where: { tokenHash },
                select: {
                    id: true,
                    sessionId: true,
                    expiresAt: true,
                    maxUses: true,
                    isConsentRequired: true,
                    encryptedDataKey: true
                }
            });

            if (!publicShare) {
                return { error: 'Public share not found or expired' };
            }

            // Check if expired
            if (publicShare.expiresAt && publicShare.expiresAt < new Date()) {
                return { error: 'Public share not found or expired' };
            }

            const session = await tx.session.findUnique({
                where: { id: publicShare.sessionId },
                select: {
                    encryptionMode: true,
                    account: {
                        select: PROFILE_SELECT,
                    },
                    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                },
            });
            if (!session) {
                return { error: 'Public share not found or expired' };
            }
            if (!isSessionTranscriptShareable(session)) {
                return {
                    error: 'Transcript unavailable',
                    code: 'session_transcript_unavailable' as const,
                };
            }

            // Check consent requirement
            if (publicShare.isConsentRequired && !consent) {
                return {
                    error: 'Consent required',
                    requiresConsent: true,
                    sessionId: publicShare.sessionId,
                    owner: toShareUserProfile(session.account),
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

            const sessionEncryptionMode: "e2ee" | "plain" = session.encryptionMode === "plain" ? "plain" : "e2ee";
            if (sessionEncryptionMode === "e2ee") {
                const parsedEncryptedDataKey = tryParseEncryptedDataKeyV0Bytes(publicShare.encryptedDataKey);
                if (parsedEncryptedDataKey.type === "error") {
                    return { error: "Public share not found or expired" };
                }
            }

            const fetchedMessages = await tx.sessionMessage.findMany({
                where: buildShareableSessionMessagePublicationWhere({
                    where: {
                        sessionId: publicShare.sessionId,
                        sidechainId: null,
                        ...(beforeSeq === undefined ? {} : { seq: { lt: beforeSeq } }),
                    },
                    publication: session,
                }),
                orderBy: { seq: 'desc' },
                // One extra row so `hasMore` is observed rather than guessed.
                take: limit + 1,
                select: {
                    id: true,
                    seq: true,
                    localId: true,
                    messageRole: true,
                    content: true,
                    createdAt: true,
                    updatedAt: true
                }
            });
            const hasMore = fetchedMessages.length > limit;
            const messages = hasMore ? fetchedMessages.slice(0, limit) : fetchedMessages;
            return {
                success: true,
                sessionId: publicShare.sessionId,
                messages,
                hasMore,
            };
        });

        if ('error' in accessResult) {
            if (accessResult.requiresConsent) {
                return reply.code(403).send({
                    error: 'Consent required',
                    requiresConsent: true,
                    sessionId: accessResult.sessionId,
                    owner: accessResult.owner,
                });
            }
            return reply.code(404).send({
                error: accessResult.error,
                ...('code' in accessResult ? { code: accessResult.code } : {}),
            });
        }

        const pageMessages = accessResult.messages;
        return reply.send({
            messages: pageMessages.map((v) => {
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
            // Descending page: the LAST row is the oldest one served, so the next older
            // page starts strictly below it.
            nextBeforeSeq: accessResult.hasMore && pageMessages.length > 0
                ? pageMessages[pageMessages.length - 1]!.seq
                : null,
        });
    });
}
