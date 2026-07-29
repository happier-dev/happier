import { buildNewSessionUpdate, eventRouter } from "@/app/events/eventRouter";
import { markAccountChangedAfterCommit } from "@/app/changes/markAccountChangedAfterCommit";
import { inTx } from "@/storage/inTx";
import { db, isPrismaErrorCode } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { z } from "zod";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    isSessionEncryptionModeAllowedByStoragePolicy,
    isSessionOwnerMetadataCiphertextV1,
    resolveEffectiveDefaultAccountEncryptionMode,
    SESSION_METADATA_LAYOUT_VERSION_V1,
} from "@happier-dev/protocol";
import { resolveRequestedSessionModeRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { applySessionTranscriptPublicationCeiling } from "@/app/session/sessionTranscriptPublicationPolicy";
import { initializeExternalLinkedSessionStorage } from "@/app/session/externalLinkedSessionStorageInitialization";
import {
    createSessionMetadataPrivacyUpgradeRequiredResponse,
    projectSessionMetadataForRecipient,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";

import { type Fastify } from "../../types";

export function registerSessionCreateOrLoadRoute(app: Fastify) {
    app.post('/v1/sessions', {
        schema: {
            body: z.union([z.object({
                tag: z.string(),
                metadata: z.string(),
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish(),
                encryptionMode: z.enum(["e2ee", "plain"]).optional(),
                currentStorageState: z.literal("machine_only").optional(),
            }).strict(), z.object({
                tag: z.string(),
                metadataLayoutVersion: z.literal(SESSION_METADATA_LAYOUT_VERSION_V1),
                sharedMetadata: z.object({ ciphertext: z.string().min(1) }).strict(),
                ownerMetadata: z.object({
                    ciphertext: z.string().refine(isSessionOwnerMetadataCiphertextV1),
                }).strict(),
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish(),
                encryptionMode: z.enum(["e2ee", "plain"]).optional(),
                currentStorageState: z.literal("machine_only").optional(),
            }).strict()])
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const layoutOneRequest =
            "sharedMetadata" in request.body
                ? request.body
                : null;
        const isLayoutOneRequest = layoutOneRequest !== null;
        const {
            tag,
            agentState,
            dataEncryptionKey,
        } = request.body;
        const metadata =
            "sharedMetadata" in request.body
                ? request.body.sharedMetadata.ciphertext
                : request.body.metadata;
        const requestedEncryptionMode = request.body.encryptionMode;
        const requestedStorageState = request.body.currentStorageState;
        const policy = readEncryptionFeatureEnv(process.env);

        if (
            (requestedEncryptionMode === "plain" || requestedEncryptionMode === "e2ee") &&
            !isSessionEncryptionModeAllowedByStoragePolicy(policy.storagePolicy, requestedEncryptionMode)
        ) {
            return reply.code(400).send({
                error: "invalid-params",
                code: resolveRequestedSessionModeRejectionCode({ storagePolicy: policy.storagePolicy }),
            });
        }

        const account = await db.account.findUnique({
            where: { id: userId },
            select: { encryptionMode: true },
        });
        const accountEncryptionMode: "e2ee" | "plain" = account?.encryptionMode === "plain" ? "plain" : "e2ee";

        const defaultEncryptionMode = resolveEffectiveDefaultAccountEncryptionMode(
            policy.storagePolicy,
            policy.defaultAccountMode,
        );

        const requestedOrAccountOrDefault: "e2ee" | "plain" =
            requestedEncryptionMode === "plain" || requestedEncryptionMode === "e2ee"
                ? requestedEncryptionMode
                : accountEncryptionMode ?? defaultEncryptionMode;

        const effectiveEncryptionMode: "e2ee" | "plain" =
            policy.storagePolicy === "required_e2ee"
                ? "e2ee"
                : policy.storagePolicy === "plaintext_only"
                    ? "plain"
                    : requestedOrAccountOrDefault;

        if (
            isLayoutOneRequest
            && effectiveEncryptionMode === "plain"
            && dataEncryptionKey != null
        ) {
            return reply.code(400).send({
                error: "invalid-params",
            });
        }

        let createdFresh = false;
        let resolvedSession;
        if (isLayoutOneRequest) {
            const existing = await db.session.findUnique({
                where: {
                    accountId_tag: {
                        accountId: userId,
                        tag,
                    },
                },
            });
            if (
                !existing
                || (existing.metadataLayoutVersion ?? 0)
                    !== SESSION_METADATA_LAYOUT_VERSION_V1
                || typeof existing.ownerMetadata !== "string"
                || !isSessionOwnerMetadataCiphertextV1(existing.ownerMetadata)
                || existing.encryptionMode !== effectiveEncryptionMode
                || (
                    requestedStorageState === "machine_only"
                        ? existing.currentStorageState !== "machine_only"
                        : existing.currentStorageState !== "hosted"
                )
            ) {
                return reply.code(409).send(
                    createSessionMetadataPrivacyUpgradeRequiredResponse(),
                );
            }
            resolvedSession = existing;
        } else {
            try {
                resolvedSession = await inTx(async (tx) => {
                    log({ module: "session-create", userId, tag }, `Creating new session for user ${userId} with tag ${tag}`);

                    const createdAt = new Date();
                    const created = await tx.session.create({
                        data: {
                            accountId: userId,
                            tag,
                            encryptionMode: effectiveEncryptionMode,
                            metadata,
                            agentState: agentState ?? null,
                            createdAt,
                            lastActiveAt: createdAt,
                            meaningfulActivityAt: createdAt,
                            ...(requestedStorageState ? { currentStorageState: requestedStorageState } : {}),
                            dataEncryptionKey:
                                effectiveEncryptionMode === "plain"
                                    ? undefined
                                    : dataEncryptionKey
                                        ? new Uint8Array(Buffer.from(dataEncryptionKey, "base64"))
                                        : undefined,
                        },
                    });
                    createdFresh = true;
                    return created;
                });
            } catch (error) {
                if (!isPrismaErrorCode(error, "P2002")) {
                    throw error;
                }
                const existing = await db.session.findUnique({
                    where: {
                        accountId_tag: {
                            accountId: userId,
                            tag,
                        },
                    },
                });
                if (!existing) {
                    throw error;
                }
                if (
                    (existing.metadataLayoutVersion ?? 0)
                        >= SESSION_METADATA_LAYOUT_VERSION_V1
                ) {
                    return reply.code(409).send(
                        createSessionMetadataPrivacyUpgradeRequiredResponse(),
                    );
                }
                resolvedSession = existing;
                if (
                    requestedStorageState === "machine_only"
                    && existing.currentStorageState !== "machine_only"
                ) {
                    const initialized = await initializeExternalLinkedSessionStorage(db, existing);
                    if (!initialized.ok) {
                        return reply.code(409).send({
                            error: "storage-state-conflict",
                            code: "session_storage_state_conflict",
                        });
                    }
                    resolvedSession = { ...existing, currentStorageState: initialized.session.currentStorageState };
                }
                log(
                    { module: "session-create", sessionId: existing.id, userId, tag },
                    `Found existing session after unique-create race: ${existing.id} for tag ${tag}`,
                );
            }
        }

        if (createdFresh) {
            const cursor = await markAccountChangedAfterCommit({
                accountId: userId,
                kind: "session",
                entityId: resolvedSession.id,
            });
            const updatePayload = buildNewSessionUpdate(resolvedSession, cursor, randomKeyNaked(12));
            log(
                {
                    module: "session-create",
                    userId,
                    sessionId: resolvedSession.id,
                    updateType: "new-session",
                    updateId: updatePayload.id,
                    updateSeq: updatePayload.seq,
                },
                "Emitting new-session update to user-scoped connections",
            );
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: "user-scoped-only" },
            });
        }
        log({ module: "session-create", sessionId: resolvedSession.id, userId }, `Session resolved: ${resolvedSession.id}`);
        const metadataProjection =
            resolvedSession.metadataLayoutVersion
                === SESSION_METADATA_LAYOUT_VERSION_V1
                ? projectSessionMetadataForRecipient({
                    session: resolvedSession,
                    recipientAccountId: userId,
                })
                : {
                    metadata: resolvedSession.metadata,
                    metadataVersion: resolvedSession.metadataVersion,
                    agentState: resolvedSession.agentState,
                    agentStateVersion: resolvedSession.agentStateVersion,
                };
        return reply.send({
            created: createdFresh,
            session: {
                id: resolvedSession.id,
                seq: applySessionTranscriptPublicationCeiling(resolvedSession.seq, resolvedSession),
                encryptionMode: resolvedSession.encryptionMode,
                ...metadataProjection,
                dataEncryptionKey: resolvedSession.dataEncryptionKey
                    ? Buffer.from(resolvedSession.dataEncryptionKey).toString("base64")
                    : null,
                pendingCount: resolvedSession.pendingCount,
                pendingBlockedCount: resolvedSession.pendingBlockedCount,
                pendingVersion: resolvedSession.pendingVersion,
                active: resolvedSession.active,
                activeAt: resolvedSession.lastActiveAt.getTime(),
                createdAt: resolvedSession.createdAt.getTime(),
                updatedAt: resolvedSession.updatedAt.getTime(),
                meaningfulActivityAt: (resolvedSession.meaningfulActivityAt ?? resolvedSession.createdAt).getTime(),
                lastMessage: null
            }
        });
    });
}
