import { type Fastify } from "../../types";
import { db } from "@/storage/db";
import { z } from "zod";
import {
    areFriends,
    buildCurrentSessionParticipantWhere,
    canManagePermissionDelegation,
    canManageSharing,
    canManageSharingInTx,
} from "@/app/share/accessControl";
import { ShareAccessLevel } from "@/storage/prisma";
import { PROFILE_SELECT, toShareUserProfile } from "@/app/share/types";
import { eventRouter, buildSessionSharedUpdate, buildSessionShareUpdatedUpdate, buildSessionShareRevokedUpdate } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { tombstoneSessionDraftForLifecycleInTx } from "@/app/account/sessionDrafts/sessionDraftService";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { tryParseDirectShareEncryptedDataKey } from "./directShareEncryptedDataKeyValidation";
import {
    isSessionTranscriptShareable,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import {
    createSessionMetadataPrivacyUpgradeRequiredResponse,
    isSessionMetadataPrivacyUpgradeRequiredError,
    projectSessionMetadataForRecipient,
    readSessionMetadataOwnerAccountMode,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import {
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
    readAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { SESSION_METADATA_LAYOUT_VERSION_V1 } from "@happier-dev/protocol";

function resolveEffectiveShareApprovalCapability(input: Readonly<{
    accessLevel: ShareAccessLevel;
    requestedCanApprovePermissions?: boolean;
    existingCanApprovePermissions?: boolean;
}>): boolean {
    if (input.accessLevel === "view") return false;
    return input.requestedCanApprovePermissions ?? input.existingCanApprovePermissions ?? false;
}

/**
 * Session sharing API routes
 */
export function shareRoutes(app: Fastify) {

    /**
     * Get all shares for a session (owner/admin only)
     */
    app.get('/v1/sessions/:sessionId/shares', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        // Only owner or admin can view shares
        if (!await canManageSharing(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const session = await db.session.findFirst({
            where: buildCurrentSessionParticipantWhere({
                userId,
                sessionId,
                minimumAccess: "admin",
            }),
            select: {
                ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                shares: {
                    include: {
                        sharedWithUser: {
                            select: PROFILE_SELECT,
                        },
                    },
                    orderBy: { createdAt: 'desc' },
                },
            },
        });
        if (!session || (
            session.accountId !== userId
            && !isSessionTranscriptShareable(session)
        )) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        return reply.send({
            shares: session.shares.map(share => ({
                id: share.id,
                sharedWithUser: toShareUserProfile(share.sharedWithUser),
                accessLevel: share.accessLevel,
                canApprovePermissions: share.canApprovePermissions,
                createdAt: share.createdAt.getTime(),
                updatedAt: share.updatedAt.getTime()
            }))
        });
    });

    /**
     * Share session with a user
     */
    app.post('/v1/sessions/:sessionId/shares', {
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "share.session.create"),
        },
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                userId: z.string(),
                accessLevel: z.enum(['view', 'edit', 'admin']),
                canApprovePermissions: z.boolean().optional(),
                encryptedDataKey: z.string().optional(),
            })
        }
    }, async (request, reply) => {
        const ownerId = request.userId;
        const { sessionId } = request.params;
        const { userId, accessLevel, canApprovePermissions, encryptedDataKey } = request.body;

        // Only owner or admin can create shares
        if (!await canManageSharing(ownerId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }
        if (canApprovePermissions === true) {
            if (accessLevel === 'view') {
                return reply.code(400).send({ error: 'Permission approvals require edit or admin access' });
            }
            if (!await canManagePermissionDelegation(ownerId, sessionId)) {
                return reply.code(403).send({ error: 'Forbidden' });
            }
        }

        // Cannot share with yourself
        if (userId === ownerId) {
            return reply.code(400).send({ error: 'Cannot share with yourself' });
        }

        // Verify target user exists and get their public key
        const targetUser = await db.account.findUnique({
            where: { id: userId },
            select: { id: true }
        });

        if (!targetUser) {
            return reply.code(404).send({ error: 'User not found' });
        }

        // Check if users are friends
        if (!await areFriends(ownerId, userId)) {
            return reply.code(403).send({ error: 'Can only share with friends' });
        }

        const effectiveCanApprovePermissions = resolveEffectiveShareApprovalCapability({
            accessLevel: accessLevel as ShareAccessLevel,
            requestedCanApprovePermissions: canApprovePermissions,
        });
        const supportsCurrentProtocol =
            readAccountStoredContentCompatibilityForHttpRequest(request)
                .supportsCurrentProtocol;

        const share = await inTx(async (tx) => {
            if (!await canManageSharingInTx(tx, {
                userId: ownerId,
                sessionId,
                requirePermissionDelegation: canApprovePermissions === true,
            })) {
                return { type: "forbidden" as const };
            }
            const currentSession = await tx.session.findUnique({
                where: { id: sessionId },
                select: {
                    id: true,
                    encryptionMode: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    ...SESSION_TRANSCRIPT_PUBLICATION_SELECT,
                },
            });
            if (!currentSession) {
                return { type: "not-found" as const };
            }
            if (
                currentSession.metadataLayoutVersion
                    === SESSION_METADATA_LAYOUT_VERSION_V1
                && !supportsCurrentProtocol
            ) {
                return {
                    type: "client-upgrade-required" as const,
                };
            }
            try {
                const ownerAccountMode = currentSession.metadataLayoutVersion
                    === SESSION_METADATA_LAYOUT_VERSION_V1
                    ? await readSessionMetadataOwnerAccountMode(
                        tx,
                        currentSession.accountId,
                    )
                    : undefined;
                projectSessionMetadataForRecipient({
                    session: currentSession,
                    recipient: {
                        type: "shared",
                        accountId: null,
                        ownerAccountMode,
                    },
                });
            } catch (error) {
                if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                    return { type: "privacy-error" as const };
                }
                throw error;
            }
            if (!isSessionTranscriptShareable(currentSession)) {
                return { type: "publication-error" as const };
            }
            const sessionEncryptionMode: "e2ee" | "plain" =
                currentSession.encryptionMode === "plain" ? "plain" : "e2ee";
            let encryptedDataKeyBytes: Uint8Array<ArrayBuffer> | null = null;
            if (sessionEncryptionMode === "e2ee") {
                if (typeof encryptedDataKey !== "string" || encryptedDataKey.length === 0) {
                    return { type: "invalid-key" as const, error: "encryptedDataKey required" };
                }
                const parsedEncryptedDataKey = tryParseDirectShareEncryptedDataKey(encryptedDataKey);
                if (parsedEncryptedDataKey.type === "error") {
                    return { type: "invalid-key" as const, error: parsedEncryptedDataKey.error };
                }
                encryptedDataKeyBytes = parsedEncryptedDataKey.encryptedDataKey;
            }
            const share = await tx.sessionShare.upsert({
                where: {
                    sessionId_sharedWithUserId: {
                        sessionId,
                        sharedWithUserId: userId
                    }
                },
                create: {
                    sessionId,
                    sharedByUserId: ownerId,
                    sharedWithUserId: userId,
                    accessLevel: accessLevel as ShareAccessLevel,
                    canApprovePermissions: effectiveCanApprovePermissions,
                    encryptedDataKey: encryptedDataKeyBytes
                },
                update: {
                    accessLevel: accessLevel as ShareAccessLevel,
                    ...(accessLevel === "view" || canApprovePermissions !== undefined
                        ? { canApprovePermissions: effectiveCanApprovePermissions }
                        : {}),
                    encryptedDataKey: encryptedDataKeyBytes
                },
                include: {
                    sharedWithUser: {
                        select: PROFILE_SELECT
                    },
                    sharedByUser: {
                        select: PROFILE_SELECT
                    }
                }
            });

            await markAccountChanged(tx, { accountId: ownerId, kind: 'share', entityId: sessionId });
            const recipientShareCursor = await markAccountChanged(tx, { accountId: userId, kind: 'share', entityId: sessionId });
            const recipientSessionCursor = await markAccountChanged(tx, { accountId: userId, kind: 'session', entityId: sessionId });
            const recipientCursor = Math.max(recipientShareCursor, recipientSessionCursor);

            afterTx(tx, () => {
                const updatePayload = buildSessionSharedUpdate(share, recipientCursor, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId: userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'all-user-authenticated-connections' }
                });
            });

            return { type: "ok" as const, share };
        });
        if (share.type === "forbidden") {
            return reply.code(403).send({ error: "Forbidden" });
        }
        if (share.type === "privacy-error") {
            return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
        }
        if (share.type === "client-upgrade-required") {
            await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            );
            return;
        }
        if (share.type === "not-found") {
            return reply.code(404).send({ error: "Session not found" });
        }
        if (share.type === "publication-error") {
            return reply.code(409).send({
                error: "Session transcript is not shareable",
                code: "session_transcript_not_shareable",
            });
        }
        if (share.type === "invalid-key") {
            return reply.code(400).send({ error: share.error });
        }

        return reply.send({
            share: {
                id: share.share.id,
                sharedWithUser: toShareUserProfile(share.share.sharedWithUser),
                accessLevel: share.share.accessLevel,
                canApprovePermissions: share.share.canApprovePermissions,
                createdAt: share.share.createdAt.getTime(),
                updatedAt: share.share.updatedAt.getTime()
            }
        });
    });

    /**
     * Update share access level
     */
    app.patch('/v1/sessions/:sessionId/shares/:shareId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                shareId: z.string()
            }),
            body: z.object({
                accessLevel: z.enum(['view', 'edit', 'admin']).optional(),
                canApprovePermissions: z.boolean().optional(),
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, shareId } = request.params;
        const { accessLevel, canApprovePermissions } = request.body;

        // Only owner or admin can update shares
        if (!await canManageSharing(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        if (canApprovePermissions !== undefined) {
            if (!await canManagePermissionDelegation(userId, sessionId)) {
                return reply.code(403).send({ error: 'Forbidden' });
            }
        }

        const existing = await db.sessionShare.findFirst({
            where: { id: shareId, sessionId },
            select: { accessLevel: true, canApprovePermissions: true },
        });
        if (!existing) {
            return reply.code(404).send({ error: 'Share not found' });
        }

        const nextAccessLevel = accessLevel ?? existing.accessLevel;
        if (canApprovePermissions === true && nextAccessLevel === 'view') {
            return reply.code(400).send({ error: 'Permission approvals require edit or admin access' });
        }
        const nextCanApprovePermissions = resolveEffectiveShareApprovalCapability({
            accessLevel: nextAccessLevel as ShareAccessLevel,
            requestedCanApprovePermissions: canApprovePermissions,
            existingCanApprovePermissions: existing.canApprovePermissions,
        });

        const result = await inTx(async (tx) => {
            if (!await canManageSharingInTx(tx, {
                userId,
                sessionId,
                requirePermissionDelegation: canApprovePermissions !== undefined,
            })) {
                return { type: "forbidden" as const };
            }
            const share = await tx.sessionShare.update({
                where: { id: shareId },
                data: {
                    ...(accessLevel !== undefined ? { accessLevel: accessLevel as ShareAccessLevel } : {}),
                    ...(accessLevel === "view" || canApprovePermissions !== undefined
                        ? { canApprovePermissions: nextCanApprovePermissions }
                        : {}),
                },
                include: {
                    sharedWithUser: {
                        select: PROFILE_SELECT
                    }
                }
            });

            await markAccountChanged(tx, { accountId: userId, kind: 'share', entityId: sessionId });
            const recipientShareCursor = await markAccountChanged(tx, { accountId: share.sharedWithUserId, kind: 'share', entityId: sessionId });
            const recipientSessionCursor = await markAccountChanged(tx, { accountId: share.sharedWithUserId, kind: 'session', entityId: sessionId });
            const recipientCursor = Math.max(recipientShareCursor, recipientSessionCursor);

            afterTx(tx, () => {
                const updatePayload = buildSessionShareUpdatedUpdate(
                    share.id,
                    share.sessionId,
                    share.accessLevel,
                    share.canApprovePermissions,
                    share.updatedAt,
                    recipientCursor,
                    randomKeyNaked(12)
                );
                eventRouter.emitUpdate({
                    userId: share.sharedWithUserId,
                    payload: updatePayload,
                    recipientFilter: { type: 'all-user-authenticated-connections' }
                });
            });

            return { type: "ok" as const, share };
        });

        if (result.type === "forbidden") {
            return reply.code(403).send({ error: "Forbidden" });
        }

        return reply.send({
            share: {
                id: result.share.id,
                sharedWithUser: toShareUserProfile(result.share.sharedWithUser),
                accessLevel: result.share.accessLevel,
                canApprovePermissions: result.share.canApprovePermissions,
                createdAt: result.share.createdAt.getTime(),
                updatedAt: result.share.updatedAt.getTime()
            }
        });
    });

    /**
     * Delete share (revoke access)
     */
    app.delete('/v1/sessions/:sessionId/shares/:shareId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                shareId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, shareId } = request.params;

        // Only owner or admin can delete shares
        if (!await canManageSharing(userId, sessionId)) {
            return reply.code(403).send({ error: 'Forbidden' });
        }

        const result = await inTx(async (tx) => {
            if (!await canManageSharingInTx(tx, { userId, sessionId })) {
                return { type: "forbidden" as const };
            }
            const share = await tx.sessionShare.findFirst({
                where: { id: shareId, sessionId }
            });

            if (!share) {
                return { type: "not-found" as const };
            }

            await tx.sessionShare.delete({
                where: { id: shareId }
            });

            await tombstoneSessionDraftForLifecycleInTx(tx, {
                accountId: share.sharedWithUserId,
                sessionId,
            });

            await markAccountChanged(tx, { accountId: userId, kind: 'share', entityId: sessionId });
            const recipientShareCursor = await markAccountChanged(tx, { accountId: share.sharedWithUserId, kind: 'share', entityId: sessionId });
            const recipientSessionCursor = await markAccountChanged(tx, { accountId: share.sharedWithUserId, kind: 'session', entityId: sessionId });
            const recipientCursor = Math.max(recipientShareCursor, recipientSessionCursor);

            afterTx(tx, async () => {
                const updatePayload = buildSessionShareRevokedUpdate(
                    share.id,
                    share.sessionId,
                    recipientCursor,
                    randomKeyNaked(12)
                );
                eventRouter.emitUpdate({
                    userId: share.sharedWithUserId,
                    payload: updatePayload,
                    recipientFilter: { type: 'all-user-authenticated-connections' }
                });
            });

            return { type: "ok" as const, share };
        });

        if (result.type === "forbidden") {
            return reply.code(403).send({ error: "Forbidden" });
        }
        if (result.type === "not-found") {
            return reply.code(404).send({ error: 'Share not found' });
        }

        return reply.send({ success: true });
    });
}
