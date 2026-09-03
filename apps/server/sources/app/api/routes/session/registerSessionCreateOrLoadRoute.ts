import {
    buildNewSessionUpdate,
    buildUpdateSessionUpdate,
    eventRouter,
} from "@/app/events/eventRouter";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    markSessionParticipantsChanged,
    type SessionParticipantCursor,
} from "@/app/session/changeTracking/markSessionParticipantsChanged";
import { afterTx, inTx } from "@/storage/inTx";
import { log } from "@/utils/logging/log";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { z } from "zod";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import {
    isSessionEncryptionModeAllowedByStoragePolicy,
    resolveEffectiveDefaultAccountEncryptionMode,
} from "@happier-dev/protocol";
import { resolveRequestedSessionModeRejectionCode } from "@/app/session/encryptionRejectionCodes";
import { mapStoredSessionRuntimeActivityProjection } from "./v2SessionListRows";
import { mapPendingActivationAuthorization } from "@/app/session/pending/pendingActivationAuthorization";

import { type Fastify } from "../../types";

type ExistingSessionLoadUpdate = Readonly<{
    sessionId: string;
    meaningfulActivityAt: number;
    unarchived: boolean;
    participantCursors: ReadonlyArray<SessionParticipantCursor>;
}>;

export function registerSessionCreateOrLoadRoute(app: Fastify) {
    app.post('/v1/sessions', {
        schema: {
            body: z.object({
                tag: z.string(),
                metadata: z.string(),
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish(),
                encryptionMode: z.enum(["e2ee", "plain"]).optional(),
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { tag, metadata, agentState, dataEncryptionKey } = request.body;
        const requestedEncryptionMode = request.body.encryptionMode;
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

        const resolved = await inTx(async (tx) => {
            const existing = await tx.session.findFirst({
                where: {
                    accountId: userId,
                    tag: tag,
                },
            });

            if (existing) {
                log(
                    { module: "session-create", sessionId: existing.id, userId, tag },
                    `Found existing session: ${existing.id} for tag ${tag}`,
                );
                if (existing.active && existing.archivedAt === null) {
                    return { session: existing, loadUpdate: null, resolution: "existing" as const };
                }

                const meaningfulActivityAt = Date.now();
                const meaningfulActivityAtDate = new Date(meaningfulActivityAt);
                const unarchived = existing.archivedAt !== null;
                const loadData = {
                    meaningfulActivityAt: meaningfulActivityAtDate,
                    ...(unarchived ? { archivedAt: null } : {}),
                } as const;
                let session;
                if (unarchived) {
                    const transitioned = await tx.session.updateMany({
                        where: { id: existing.id, archivedAt: existing.archivedAt },
                        data: loadData,
                    });
                    if (transitioned.count === 1) {
                        session = await tx.session.findUniqueOrThrow({ where: { id: existing.id } });
                    } else {
                        const concurrent = await tx.session.findUniqueOrThrow({ where: { id: existing.id } });
                        if (concurrent.archivedAt !== null) {
                            throw new Error("Concurrent session unarchive did not converge");
                        }
                        session = await tx.session.update({
                            where: { id: existing.id },
                            data: { meaningfulActivityAt: meaningfulActivityAtDate },
                        });
                    }
                } else {
                    session = await tx.session.update({
                        where: { id: existing.id },
                        data: loadData,
                    });
                }
                const participantCursors = await markSessionParticipantsChanged({
                    tx,
                    sessionId: existing.id,
                    hint: {
                        sessionStart: true,
                        meaningfulActivityAt,
                        ...(unarchived ? { archivedAt: null } : {}),
                    },
                });

                return {
                    session,
                    resolution: "existing" as const,
                    loadUpdate: {
                        sessionId: existing.id,
                        meaningfulActivityAt,
                        unarchived,
                        participantCursors,
                    } satisfies ExistingSessionLoadUpdate,
                };
            }

            log({ module: "session-create", userId, tag }, `Creating new session for user ${userId} with tag ${tag}`);

            const account = await tx.account.findUnique({
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

            const createdAt = new Date();
            const created = await tx.session.create({
                data: {
                    accountId: userId,
                    tag,
                    encryptionMode: effectiveEncryptionMode,
                    metadata,
                    agentState: agentState ?? null,
                    createdAt,
                    meaningfulActivityAt: createdAt,
                    dataEncryptionKey:
                        effectiveEncryptionMode === "plain"
                            ? undefined
                            : dataEncryptionKey
                                ? new Uint8Array(Buffer.from(dataEncryptionKey, "base64"))
                                : undefined,
                },
            });

            const cursor = await markAccountChanged(tx, { accountId: userId, kind: "session", entityId: created.id });

            afterTx(tx, () => {
                const runtimeActivityProjection = mapStoredSessionRuntimeActivityProjection(created);
                const updatePayload = buildNewSessionUpdate({
                    id: created.id,
                    seq: created.seq,
                    metadata: created.metadata,
                    metadataVersion: created.metadataVersion,
                    agentState: created.agentState,
                    agentStateVersion: created.agentStateVersion,
                    dataEncryptionKey: created.dataEncryptionKey,
                    active: created.active,
                    lastActiveAt: created.lastActiveAt,
                    createdAt: created.createdAt,
                    updatedAt: created.updatedAt,
                    meaningfulActivityAt: created.meaningfulActivityAt,
                    ...runtimeActivityProjection,
                }, cursor, randomKeyNaked(12));
                log(
                    {
                        module: "session-create",
                        userId,
                        sessionId: created.id,
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
            });

            return { session: created, loadUpdate: null, resolution: "created" as const };
        });

        const loadUpdate = resolved.loadUpdate;
        if (loadUpdate) {
            const projection = {
                meaningfulActivityAt: loadUpdate.meaningfulActivityAt,
                ...(loadUpdate.unarchived ? { archivedAt: null } : {}),
            };
            await Promise.all(loadUpdate.participantCursors.map(async ({ accountId, cursor }) => {
                const payload = buildUpdateSessionUpdate(
                    loadUpdate.sessionId,
                    cursor,
                    randomKeyNaked(12),
                    undefined,
                    undefined,
                    projection,
                );
                eventRouter.emitUpdate({
                    userId: accountId,
                    payload,
                    recipientFilter: {
                        type: "all-interested-in-session",
                        sessionId: loadUpdate.sessionId,
                    },
                });
            }));
        }

        const resolvedSession = resolved.session;
        log({ module: "session-create", sessionId: resolvedSession.id, userId }, `Session resolved: ${resolvedSession.id}`);
        return reply.send({
            resolution: resolved.resolution,
            session: {
                id: resolvedSession.id,
                seq: resolvedSession.seq,
                encryptionMode: resolvedSession.encryptionMode,
                metadata: resolvedSession.metadata,
                metadataVersion: resolvedSession.metadataVersion,
                agentState: resolvedSession.agentState,
                agentStateVersion: resolvedSession.agentStateVersion,
                dataEncryptionKey: resolvedSession.dataEncryptionKey
                    ? Buffer.from(resolvedSession.dataEncryptionKey).toString("base64")
                    : null,
                pendingCount: resolvedSession.pendingCount,
                pendingBlockedCount: resolvedSession.pendingBlockedCount,
                pendingVersion: resolvedSession.pendingVersion,
                pendingActivationAuthorization: mapPendingActivationAuthorization(resolvedSession),
                ...mapStoredSessionRuntimeActivityProjection(resolvedSession),
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
