import { eventRouter } from "@/app/events/eventRouter";
import { Fastify } from "../../types";
import { z } from "zod";
import { db, isPrismaErrorCode } from "@/storage/db";
import { log } from "@/utils/logging/log";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { buildNewMachineUpdate, buildUpdateMachineUpdate } from "@/app/events/eventRouter";
import { activityCache } from "@/app/presence/sessionCache";
import { afterTx, inTx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { timingSafeEqual } from "node:crypto";

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

function serializeMachineRow(row: {
    id: string;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    seq: number;
    active: boolean;
    lastActiveAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}) {
    return {
        id: row.id,
        metadata: row.metadata,
        metadataVersion: row.metadataVersion,
        daemonState: row.daemonState,
        daemonStateVersion: row.daemonStateVersion,
        dataEncryptionKey: row.dataEncryptionKey ? Buffer.from(row.dataEncryptionKey).toString('base64') : null,
        seq: row.seq,
        active: row.active,
        activeAt: row.lastActiveAt.getTime(),  // Return as activeAt for API consistency
        revokedAt: row.revokedAt ? row.revokedAt.getTime() : null,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
}

export function machinesRoutes(app: Fastify) {
    app.post('/v1/machines', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string(),
                metadata: z.string(), // Encrypted metadata
                daemonState: z.string().optional(), // Encrypted daemon state
                dataEncryptionKey: z.string().nullish()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, metadata, daemonState, dataEncryptionKey } = request.body;

        // Check if machine exists (like sessions do)
        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (machine) {
            if (machine.revokedAt) {
                return reply.code(410).send({ error: 'machine_revoked' });
            }

            const nextDataEncryptionKey =
                dataEncryptionKey === null
                    ? null
                    : typeof dataEncryptionKey === 'string'
                        ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64'))
                        : undefined;

            const wantsMetadataUpdate = metadata !== machine.metadata;
            const wantsDaemonStateUpdate = typeof daemonState === 'string' && daemonState !== (machine.daemonState ?? null);
            const wantsDataEncryptionKeyUpdate =
                nextDataEncryptionKey !== undefined
                && !bytesEqual(machine.dataEncryptionKey ?? null, nextDataEncryptionKey);

            if (!wantsMetadataUpdate && !wantsDaemonStateUpdate && !wantsDataEncryptionKeyUpdate) {
                // Machine exists and payload matches - just return it.
                // Note: This checks the pre-tx row (which may be slightly stale under concurrency),
                // but the response is still safe and consistent for the authenticated account.
                log({ module: 'machines', machineId: id, userId }, 'Found existing machine');
                return reply.send({
                    machine: {
                        ...serializeMachineRow(machine),
                    }
                });
            }

            log({ module: 'machines', machineId: id, userId }, 'Updating existing machine');

            const updated = await inTx(async (tx) => {
                const current = await tx.machine.findFirst({
                    where: {
                        accountId: userId,
                        id,
                    },
                });
                if (!current) return null;
                if (current.revokedAt) return { error: 'machine_revoked' as const };

                const currentWantsMetadataUpdate = metadata !== current.metadata;
                const currentWantsDaemonStateUpdate =
                    typeof daemonState === 'string' && daemonState !== (current.daemonState ?? null);
                const currentWantsDataEncryptionKeyUpdate =
                    nextDataEncryptionKey !== undefined
                    && !bytesEqual(current.dataEncryptionKey ?? null, nextDataEncryptionKey);

                if (!currentWantsMetadataUpdate && !currentWantsDaemonStateUpdate && !currentWantsDataEncryptionKeyUpdate) {
                    return current;
                }

                const updatedMachine = await tx.machine.update({
                    where: { accountId_id: { accountId: userId, id } },
                    data: {
                        ...(currentWantsMetadataUpdate
                            ? { metadata, metadataVersion: { increment: 1 } }
                            : {}),
                        ...(currentWantsDaemonStateUpdate
                            ? { daemonState, daemonStateVersion: { increment: 1 } }
                            : {}),
                        ...(currentWantsDataEncryptionKeyUpdate
                            ? { dataEncryptionKey: nextDataEncryptionKey }
                            : {}),
                    },
                });

                await markAccountChanged(tx, { accountId: userId, kind: 'machine', entityId: updatedMachine.id });

                return updatedMachine;
            });

            if (!updated) {
                // Machine disappeared between the initial lookup and the transaction.
                return reply.code(404).send({ error: "machine_not_found" });
            }

            if ('error' in updated && updated.error === 'machine_revoked') {
                return reply.code(410).send({ error: 'machine_revoked' });
            }

            return reply.send({
                machine: {
                    ...serializeMachineRow(updated),
                }
            });
        } else {
            // Create new machine
            log({ module: 'machines', machineId: id, userId }, 'Creating new machine');

            let newMachine;
            try {
                newMachine = await inTx(async (tx) => {
                    const created = await tx.machine.create({
                        data: {
                            id,
                            accountId: userId,
                            metadata,
                            metadataVersion: 1,
                            daemonState: daemonState || null,
                            daemonStateVersion: daemonState ? 1 : 0,
                            dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined,
                            // Default to offline - in case the user does not start daemon
                            active: false,
                            // lastActiveAt and activeAt defaults to now() in schema
                        }
                    });

                    const cursor = await markAccountChanged(tx, { accountId: userId, kind: 'machine', entityId: created.id });

                    afterTx(tx, () => {
                        // Emit both new-machine and update-machine events for backward compatibility.
                        // IMPORTANT: Both share the same cursor (one durable change).
                        const newMachinePayload = buildNewMachineUpdate(created, cursor, randomKeyNaked(12));
                        eventRouter.emitUpdate({
                            userId,
                            payload: newMachinePayload,
                            recipientFilter: { type: 'user-scoped-only' }
                        });

                        const machineMetadata = { version: 1, value: metadata };
                        const updatePayload = buildUpdateMachineUpdate(created.id, cursor, randomKeyNaked(12), machineMetadata);
                        eventRouter.emitUpdate({
                            userId,
                            payload: updatePayload,
                            recipientFilter: { type: 'machine-scoped-only', machineId: created.id }
                        });
                    });

                    return created;
                });
            } catch (e) {
                // Concurrency safety: multiple clients may race to create the same machine (e.g. daemon + session spawns).
                // If we lost the race, fetch the winner row and return it instead of surfacing a 500.
                if (isPrismaErrorCode(e, 'P2002')) {
                    const existingSameAccount = await db.machine.findFirst({ where: { accountId: userId, id } });
                    if (existingSameAccount) {
                        if (existingSameAccount.revokedAt) {
                            return reply.code(410).send({ error: 'machine_revoked' });
                        }
                        log({ module: 'machines', machineId: id, userId }, 'Machine created concurrently; returning existing machine');
                        return reply.send({
                            machine: {
                                ...serializeMachineRow(existingSameAccount),
                            },
                        });
                    }

                    // Unique violation but no row for this account: id is owned elsewhere.
                    log({ module: 'machines', machineId: id, userId }, 'Machine id conflict: machine id belongs to another account');
                    return reply
                        .code(409)
                        .send({ error: 'machine_id_conflict', message: 'This machine id is already registered to another account' });
                }
                throw e;
            }

            return reply.send({
                machine: {
                    ...serializeMachineRow(newMachine),
                }
            });
        }
    });

    // POST /v1/machines/:id/revoke - revoke/forget a machine and invalidate its access.
    app.post('/v1/machines/:id/revoke', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string(),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const result = await inTx(async (tx) => {
            const machine = await tx.machine.findFirst({
                where: {
                    accountId: userId,
                    id,
                },
            });
            if (!machine) return { kind: 'not_found' as const };

            const now = new Date();
            const revokedAt = machine.revokedAt ?? now;

            const updated = await tx.machine.update({
                where: { accountId_id: { accountId: userId, id } },
                data: {
                    active: false,
                    revokedAt,
                },
            });

            await tx.accessKey.deleteMany({
                where: {
                    accountId: userId,
                    machineId: id,
                },
            });

            await tx.automationAssignment.deleteMany({
                where: {
                    machineId: id,
                },
            });

            const cursor = await markAccountChanged(tx, { accountId: userId, kind: 'machine', entityId: updated.id });

            afterTx(tx, () => {
                const updatePayload = buildUpdateMachineUpdate(
                    updated.id,
                    cursor,
                    randomKeyNaked(12),
                    undefined,
                    undefined,
                    { active: false, revokedAt: revokedAt.getTime() },
                );
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'user-scoped-only' },
                });
                activityCache.invalidateMachine(updated.id);
            });

            return { kind: 'ok' as const, machine: updated };
        });

        if (result.kind === 'not_found') {
            return reply.code(404).send({ error: 'machine_not_found' });
        }

        return reply.send({ machine: serializeMachineRow(result.machine) });
    });


    // Machines API
    app.get('/v1/machines', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const machines = await db.machine.findMany({
            where: { accountId: userId },
            orderBy: { lastActiveAt: 'desc' }
        });

        return machines.map(serializeMachineRow);
    });

    // GET /v1/machines/:id - Get single machine by ID
    app.get('/v1/machines/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        return {
            machine: {
                ...serializeMachineRow(machine),
            }
        };
    });

}
