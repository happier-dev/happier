import { buildNewSessionUpdate, eventRouter } from "@/app/events/eventRouter";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { afterTx, inTx } from "@/storage/inTx";
import { log } from "@/utils/logging/log";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { z } from "zod";

import { type Fastify } from "../../types";

export function registerSessionCreateOrLoadRoute(app: Fastify) {
    app.post('/v1/sessions', {
        schema: {
            body: z.object({
                tag: z.string(),
                metadata: z.string(),
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { tag, metadata, dataEncryptionKey } = request.body;

        const resolvedSession = await inTx(async (tx) => {
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
                return existing;
            }

            log({ module: "session-create", userId, tag }, `Creating new session for user ${userId} with tag ${tag}`);
            const created = await tx.session.create({
                data: {
                    accountId: userId,
                    tag,
                    metadata,
                    dataEncryptionKey: dataEncryptionKey
                        ? new Uint8Array(Buffer.from(dataEncryptionKey, "base64"))
                        : undefined,
                },
            });

            const cursor = await markAccountChanged(tx, { accountId: userId, kind: "session", entityId: created.id });

            afterTx(tx, () => {
                const updatePayload = buildNewSessionUpdate(created, cursor, randomKeyNaked(12));
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

            return created;
        });

        log({ module: "session-create", sessionId: resolvedSession.id, userId }, `Session resolved: ${resolvedSession.id}`);
        return reply.send({
            session: {
                id: resolvedSession.id,
                seq: resolvedSession.seq,
                metadata: resolvedSession.metadata,
                metadataVersion: resolvedSession.metadataVersion,
                agentState: resolvedSession.agentState,
                agentStateVersion: resolvedSession.agentStateVersion,
                dataEncryptionKey: resolvedSession.dataEncryptionKey
                    ? Buffer.from(resolvedSession.dataEncryptionKey).toString("base64")
                    : null,
                pendingCount: resolvedSession.pendingCount,
                pendingVersion: resolvedSession.pendingVersion,
                active: resolvedSession.active,
                activeAt: resolvedSession.lastActiveAt.getTime(),
                createdAt: resolvedSession.createdAt.getTime(),
                updatedAt: resolvedSession.updatedAt.getTime(),
                lastMessage: null
            }
        });
    });
}
