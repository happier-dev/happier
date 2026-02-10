import { buildNewSessionUpdate, eventRouter } from "@/app/events/eventRouter";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { afterTx, inTx } from "@/storage/inTx";
import { db } from "@/storage/db";
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

        const session = await db.session.findFirst({
            where: {
                accountId: userId,
                tag: tag
            }
        });
        if (session) {
            log({ module: 'session-create', sessionId: session.id, userId, tag }, `Found existing session: ${session.id} for tag ${tag}`);
            return reply.send({
                session: {
                    id: session.id,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    pendingCount: session.pendingCount,
                    pendingVersion: session.pendingVersion,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    lastMessage: null
                }
            });
        }

        log({ module: 'session-create', userId, tag }, `Creating new session for user ${userId} with tag ${tag}`);
        const createdSession = await inTx(async (tx) => {
            const created = await tx.session.create({
                data: {
                    accountId: userId,
                    tag,
                    metadata,
                    dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined,
                },
            });

            const cursor = await markAccountChanged(tx, { accountId: userId, kind: 'session', entityId: created.id });

            afterTx(tx, () => {
                const updatePayload = buildNewSessionUpdate(created, cursor, randomKeyNaked(12));
                log({
                    module: 'session-create',
                    userId,
                    sessionId: created.id,
                    updateType: 'new-session',
                    updateId: updatePayload.id,
                    updateSeq: updatePayload.seq,
                }, 'Emitting new-session update to user-scoped connections');
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'user-scoped-only' },
                });
            });

            return created;
        });

        log({ module: 'session-create', sessionId: createdSession.id, userId }, `Session created: ${createdSession.id}`);
        return reply.send({
            session: {
                id: createdSession.id,
                seq: createdSession.seq,
                metadata: createdSession.metadata,
                metadataVersion: createdSession.metadataVersion,
                agentState: createdSession.agentState,
                agentStateVersion: createdSession.agentStateVersion,
                dataEncryptionKey: createdSession.dataEncryptionKey ? Buffer.from(createdSession.dataEncryptionKey).toString('base64') : null,
                pendingCount: createdSession.pendingCount,
                pendingVersion: createdSession.pendingVersion,
                active: createdSession.active,
                activeAt: createdSession.lastActiveAt.getTime(),
                createdAt: createdSession.createdAt.getTime(),
                updatedAt: createdSession.updatedAt.getTime(),
                lastMessage: null
            }
        });
    });
}
