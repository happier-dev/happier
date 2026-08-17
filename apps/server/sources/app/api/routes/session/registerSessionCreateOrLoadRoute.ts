import { buildNewSessionUpdate, eventRouter } from "@/app/events/eventRouter";
import { markAccountChangedAfterCommit } from "@/app/changes/markAccountChangedAfterCommit";
import { inTx } from "@/storage/inTx";
import { db, isPrismaErrorCode } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { z } from "zod";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    encodeSessionOwnerMetadataEnvelopeV1,
    isSessionEncryptionModeAllowedByStoragePolicy,
    SessionOrganizationPlacementV1Schema,
    SessionOwnerMetadataEnvelopeV1Schema,
    SessionSharedMetadataV1Schema,
    resolveEffectiveDefaultAccountEncryptionMode,
    SESSION_METADATA_LAYOUT_VERSION_V1,
    validateSessionOwnerMetadataEnvelopeForAccountModeV1,
} from "@happier-dev/protocol";
import { resolveRequestedSessionModeRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { applySessionTranscriptPublicationCeiling } from "@/app/session/sessionTranscriptPublicationPolicy";
import { initializeExternalLinkedSessionStorage } from "@/app/session/externalLinkedSessionStorageInitialization";
import {
    createSessionMetadataPrivacyUpgradeRequiredResponse,
    isSessionMetadataPrivacyUpgradeRequiredError,
    projectSessionMetadataForRecipient,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import {
    parsePersistedSessionOwnerMetadataEnvelopeV1,
} from "@/app/session/metadata/sessionOwnerMetadataPersistence";
import {
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import {
    applySessionCreationPlacementInTx,
    readSessionOrganizationPlacementInTx,
} from "@/app/session/organization/organizationMutations";

import { type Fastify } from "../../types";

class SessionCreationPlacementError extends Error {
    constructor(readonly code: "invalid-folder" | "invalid-session-tags") {
        super(code);
        this.name = "SessionCreationPlacementError";
    }
}

function isExistingSessionStorageCompatibleWithCreateRequest(params: Readonly<{
    requestedStorageState: "machine_only" | undefined;
    existingStorageState: string;
}>): boolean {
    if (params.requestedStorageState !== "machine_only") {
        return params.existingStorageState === "hosted";
    }

    // `machine_only` declares external storage authority at creation time. A
    // concurrent materializer may advance that same authority before this
    // create-or-load request observes the row, so its successor states remain
    // valid loads. Hosted and legacy/unknown rows are not admitted here.
    return params.existingStorageState === "machine_only"
        || params.existingStorageState === "server_partial"
        || params.existingStorageState === "snapshot_complete";
}

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
                ownerMetadata: SessionOwnerMetadataEnvelopeV1Schema,
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish(),
                encryptionMode: z.enum(["e2ee", "plain"]).optional(),
                currentStorageState: z.literal("machine_only").optional(),
                organizationPlacement: SessionOrganizationPlacementV1Schema.optional(),
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
            isLayoutOneRequest
            && !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                request,
                reply,
            )
        ) {
            if (!reply.sent) {
                return reply.code(409).send(
                    createSessionMetadataPrivacyUpgradeRequiredResponse(),
                );
            }
            return;
        }

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
            select: {
                publicKey: true,
                encryptionMode: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
            },
        });
        const accountCurrentness = account
            ? deriveAccountEncryptionCurrentnessFromRow(account)
            : null;
        if (accountCurrentness?.status !== "ready") {
            return reply.code(400).send({
                error: "invalid-params",
            });
        }
        const accountEncryptionMode =
            accountCurrentness.currentness.encryptionMode;

        if (
            isLayoutOneRequest
            && !validateSessionOwnerMetadataEnvelopeForAccountModeV1({
                accountMode: accountEncryptionMode,
                envelope: layoutOneRequest.ownerMetadata,
            }).ok
        ) {
            return reply.code(400).send({ error: "invalid-params" });
        }

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
            !isLayoutOneRequest
            && effectiveEncryptionMode === "plain"
        ) {
            if (
                !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                    request,
                    reply,
                )
            ) {
                return;
            }
            return reply.code(409).send(
                createSessionMetadataPrivacyUpgradeRequiredResponse(),
            );
        }

        if (
            effectiveEncryptionMode === "plain"
            && dataEncryptionKey != null
        ) {
            return reply.code(400).send({
                error: "invalid-params",
            });
        }

        let createdFresh = false;
        let resolvedSession;
        let resolvedOwnerAccountMode = accountEncryptionMode;
        let resolvedOrganizationPlacement: {
            folderId: string | null;
            tagIds: string[];
        } | undefined;
        if (isLayoutOneRequest) {
            let layoutOneResult;
            try {
                layoutOneResult = await inTx(async (tx) => {
                await acquireAccountSessionOwnerMetadataFenceInTx(
                    tx,
                    userId,
                );
                const fencedAccount = await tx.account.findUnique({
                    where: { id: userId },
                    select: {
                        publicKey: true,
                        encryptionMode: true,
                        contentPublicKey: true,
                        contentPublicKeySig: true,
                    },
                });
                if (!fencedAccount) return null;
                const fencedCurrentness =
                    deriveAccountEncryptionCurrentnessFromRow(
                        fencedAccount,
                    );
                if (fencedCurrentness.status === "inconsistent") {
                    return null;
                }
                const fencedAccountMode =
                    fencedCurrentness.currentness.encryptionMode;
                const fencedRequestedOrDefault =
                    requestedEncryptionMode
                    ?? fencedAccountMode
                    ?? defaultEncryptionMode;
                const fencedEffectiveMode =
                    policy.storagePolicy === "required_e2ee"
                        ? "e2ee"
                        : policy.storagePolicy === "plaintext_only"
                            ? "plain"
                            : fencedRequestedOrDefault;
                if (
                    !validateSessionOwnerMetadataEnvelopeForAccountModeV1({
                        accountMode: fencedAccountMode,
                        envelope: layoutOneRequest.ownerMetadata,
                    }).ok
                    || (
                        fencedEffectiveMode === "plain"
                        && (
                            !SessionSharedMetadataV1Schema.safeParse(
                                (() => {
                                    try {
                                        return JSON.parse(metadata);
                                    } catch {
                                        return null;
                                    }
                                })(),
                            ).success
                            || (
                                agentState != null
                                && (() => {
                                    try {
                                        const parsed = JSON.parse(agentState);
                                        return typeof parsed !== "object"
                                            || parsed === null
                                            || Array.isArray(parsed);
                                    } catch {
                                        return true;
                                    }
                                })()
                            )
                        )
                    )
                ) {
                    return { invalid: true } as const;
                }
                const existing = await tx.session.findUnique({
                    where: {
                        accountId_tag: {
                            accountId: userId,
                            tag,
                        },
                    },
                });
                if (existing) {
                    const storedOwnerEnvelope =
                        parsePersistedSessionOwnerMetadataEnvelopeV1({
                            metadataLayoutVersion:
                                existing.metadataLayoutVersion ?? 0,
                            accountMode: fencedAccountMode,
                            ownerMetadata: existing.ownerMetadata,
                            allowRetainedDevelopmentCiphertext: true,
                        });
                    if (
                        (existing.metadataLayoutVersion ?? 0)
                            === SESSION_METADATA_LAYOUT_VERSION_V1
                        && !validateSessionOwnerMetadataEnvelopeForAccountModeV1({
                            accountMode: fencedAccountMode,
                            envelope: storedOwnerEnvelope,
                        }).ok
                    ) {
                        return { privacyError: true } as const;
                    }
                    return {
                        existing,
                        ownerAccountMode: fencedAccountMode,
                        organizationPlacement:
                            await readSessionOrganizationPlacementInTx(tx, {
                                accountId: userId,
                                sessionId: existing.id,
                            }),
                    } as const;
                }
                const createdAt = new Date();
                const created = await tx.session.create({
                    data: {
                        accountId: userId,
                        tag,
                        encryptionMode: fencedEffectiveMode,
                        metadata,
                        metadataLayoutVersion:
                            SESSION_METADATA_LAYOUT_VERSION_V1,
                        ownerMetadata:
                            encodeSessionOwnerMetadataEnvelopeV1(
                                layoutOneRequest.ownerMetadata,
                            ),
                        agentState: agentState ?? null,
                        createdAt,
                        lastActiveAt: createdAt,
                        meaningfulActivityAt: createdAt,
                        ...(requestedStorageState
                            ? {
                                currentStorageState:
                                    requestedStorageState,
                            }
                            : {}),
                        dataEncryptionKey:
                            fencedEffectiveMode === "plain"
                                ? undefined
                                : dataEncryptionKey
                                    ? new Uint8Array(Buffer.from(
                                        dataEncryptionKey,
                                        "base64",
                                    ))
                        : undefined,
                    },
                });
                let organizationPlacement = {
                    folderId: null as string | null,
                    tagIds: [] as string[],
                };
                const requestedPlacement = layoutOneRequest.organizationPlacement;
                if (
                    requestedPlacement
                    && (
                        requestedPlacement.folderId !== null
                        || requestedPlacement.tagIds.length > 0
                    )
                ) {
                    const appliedPlacement =
                        await applySessionCreationPlacementInTx(tx, {
                            accountId: userId,
                            sessionId: created.id,
                            folderId: requestedPlacement.folderId,
                            tagIds: requestedPlacement.tagIds,
                        });
                    if ("error" in appliedPlacement) {
                        throw new SessionCreationPlacementError(
                            appliedPlacement.error,
                        );
                    }
                    organizationPlacement = appliedPlacement;
                }
                return {
                    created,
                    ownerAccountMode: fencedAccountMode,
                    organizationPlacement,
                } as const;
                });
            } catch (error) {
                if (error instanceof SessionCreationPlacementError) {
                    return reply.code(400).send({
                        error: "invalid-params",
                        code: "invalid-session-organization-placement",
                    });
                }
                if (!isPrismaErrorCode(error, "P2002")) {
                    throw error;
                }

                // A competing Layout-1 create can pass the initial lookup and
                // lose the unique `(accountId, tag)` insert. It must rejoin the
                // winner's atomic placement rather than retrying a placement
                // write of its own.
                layoutOneResult = await inTx(async (tx) => {
                    await acquireAccountSessionOwnerMetadataFenceInTx(
                        tx,
                        userId,
                    );
                    const fencedAccount = await tx.account.findUnique({
                        where: { id: userId },
                        select: {
                            publicKey: true,
                            encryptionMode: true,
                            contentPublicKey: true,
                            contentPublicKeySig: true,
                        },
                    });
                    if (!fencedAccount) return { invalid: true } as const;
                    const fencedCurrentness =
                        deriveAccountEncryptionCurrentnessFromRow(
                            fencedAccount,
                        );
                    if (fencedCurrentness.status === "inconsistent") {
                        return { invalid: true } as const;
                    }

                    const existing = await tx.session.findUnique({
                        where: {
                            accountId_tag: {
                                accountId: userId,
                                tag,
                            },
                        },
                    });
                    if (!existing) return { raceLost: true } as const;

                    const ownerAccountMode =
                        fencedCurrentness.currentness.encryptionMode;
                    const storedOwnerEnvelope =
                        parsePersistedSessionOwnerMetadataEnvelopeV1({
                            metadataLayoutVersion:
                                existing.metadataLayoutVersion ?? 0,
                            accountMode: ownerAccountMode,
                            ownerMetadata: existing.ownerMetadata,
                            allowRetainedDevelopmentCiphertext: true,
                        });
                    if (
                        (existing.metadataLayoutVersion ?? 0)
                            === SESSION_METADATA_LAYOUT_VERSION_V1
                        && !validateSessionOwnerMetadataEnvelopeForAccountModeV1({
                            accountMode: ownerAccountMode,
                            envelope: storedOwnerEnvelope,
                        }).ok
                    ) {
                        return { privacyError: true } as const;
                    }
                    return {
                        existing,
                        ownerAccountMode,
                        organizationPlacement:
                            await readSessionOrganizationPlacementInTx(tx, {
                                accountId: userId,
                                sessionId: existing.id,
                            }),
                    } as const;
                });
                if ("raceLost" in layoutOneResult) {
                    throw error;
                }
            }
            if (!layoutOneResult || "invalid" in layoutOneResult) {
                return reply.code(400).send({ error: "invalid-params" });
            }
            if ("privacyError" in layoutOneResult) {
                return reply.code(409).send(
                    createSessionMetadataPrivacyUpgradeRequiredResponse(),
                );
            }
            if ("created" in layoutOneResult) {
                createdFresh = true;
                resolvedSession = layoutOneResult.created;
                resolvedOrganizationPlacement =
                    layoutOneResult.organizationPlacement;
            } else {
                const existing = layoutOneResult.existing;
                if (
                    (existing.metadataLayoutVersion ?? 0)
                        !== SESSION_METADATA_LAYOUT_VERSION_V1
                    || existing.encryptionMode
                        !== effectiveEncryptionMode
                    || !isExistingSessionStorageCompatibleWithCreateRequest({
                        requestedStorageState,
                        existingStorageState: existing.currentStorageState,
                    })
                ) {
                    return reply.code(409).send(
                        createSessionMetadataPrivacyUpgradeRequiredResponse(),
                    );
                }
                resolvedSession = existing;
                resolvedOrganizationPlacement =
                    layoutOneResult.organizationPlacement;
            }
            resolvedOwnerAccountMode =
                layoutOneResult.ownerAccountMode;
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
                    if (
                        !await enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
                            request,
                            reply,
                        )
                    ) {
                        return;
                    }
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

        if (!resolvedSession) {
            return reply.code(500).send({
                error: "failed-to-resolve-session",
            });
        }

        let metadataProjection: ReturnType<
            typeof projectSessionMetadataForRecipient
        >;
        try {
            metadataProjection = projectSessionMetadataForRecipient({
                session: {
                    ...resolvedSession,
                    accountId: userId,
                },
                recipient: {
                    type: "owner",
                    accountId: userId,
                    accountMode: resolvedOwnerAccountMode,
                },
            });
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(
                    createSessionMetadataPrivacyUpgradeRequiredResponse(),
                );
            }
            throw error;
        }

        if (createdFresh) {
            const cursor = await markAccountChangedAfterCommit({
                accountId: userId,
                kind: "session",
                entityId: resolvedSession.id,
            });
            const updatePayload = buildNewSessionUpdate(
                resolvedSession,
                cursor,
                randomKeyNaked(12),
                metadataProjection,
            );
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
        return reply.send({
            created: createdFresh,
            ...(resolvedOrganizationPlacement
                ? { organizationPlacement: resolvedOrganizationPlacement }
                : {}),
            session: {
                id: resolvedSession.id,
                seq: applySessionTranscriptPublicationCeiling(resolvedSession.seq, resolvedSession),
                encryptionMode: resolvedSession.encryptionMode,
                ...metadataProjection,
                ...(metadataProjection.metadataLayoutVersion
                    === SESSION_METADATA_LAYOUT_VERSION_V1
                    ? { share: null }
                    : {}),
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
