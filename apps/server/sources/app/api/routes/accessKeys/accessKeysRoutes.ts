import { Fastify } from "../../types";
import { z } from "zod";
import { log } from "@/utils/logging/log";
import { inTx } from "@/storage/inTx";
import {
    createSessionMachineAccessKeyInTx,
    readSessionMachineAccessKeyInTx,
    readSessionMachineBindingStateInTx,
    updateSessionMachineAccessKeyDataInTx,
} from "@/app/accessKeys/sessionMachineAccessKeyMutations";

export function accessKeysRoutes(app: Fastify) {
    // Get Access Key API
    app.get('/v1/access-keys/:sessionId/:machineId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                machineId: z.string()
            }),
            response: {
                200: z.object({
                    accessKey: z.object({
                        data: z.string(),
                        dataVersion: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number()
                    }).nullable()
                }),
                404: z.object({
                    error: z.literal('Session or machine not found')
                }),
                500: z.object({
                    error: z.literal('Failed to get access key')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, machineId } = request.params;
        const binding = { accountId: userId, machineId, sessionId };

        try {
            const resolved = await inTx(async tx => {
                if (await readSessionMachineBindingStateInTx(tx, binding) !== "available") return { available: false as const, accessKey: null };
                return { available: true as const, accessKey: await readSessionMachineAccessKeyInTx(tx, binding) };
            });
            if (!resolved.available) {
                return reply.code(404).send({ error: 'Session or machine not found' });
            }
            const { accessKey } = resolved;

            if (!accessKey) {
                return reply.send({ accessKey: null });
            }

            return reply.send({
                accessKey: {
                    data: accessKey.data,
                    dataVersion: accessKey.dataVersion,
                    createdAt: accessKey.createdAt.getTime(),
                    updatedAt: accessKey.updatedAt.getTime()
                }
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to get access key: ${error}`);
            return reply.code(500).send({ error: 'Failed to get access key' });
        }
    });

    // Create Access Key API
    app.post('/v1/access-keys/:sessionId/:machineId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                machineId: z.string()
            }),
            body: z.object({
                data: z.string()
            }),
            response: {
                200: z.object({
                    success: z.boolean(),
                    accessKey: z.object({
                        data: z.string(),
                        dataVersion: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number()
                    }).optional(),
                    error: z.string().optional()
                }),
                404: z.object({
                    error: z.literal('Session or machine not found')
                }),
                409: z.object({
                    error: z.literal('Access key already exists')
                }),
                500: z.object({
                    error: z.literal('Failed to create access key')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, machineId } = request.params;
        const { data } = request.body;

        try {
            const created = await inTx(tx => createSessionMachineAccessKeyInTx(tx, {
                accountId: userId, machineId, sessionId, data,
            }));

            if (!created.ok) {
                return created.reason === "binding-not-found"
                    ? reply.code(404).send({ error: 'Session or machine not found' })
                    : reply.code(409).send({ error: 'Access key already exists' });
            }

            if (created.created) {
                log({ module: 'access-keys', userId, sessionId, machineId }, 'Created new access key');
            }

            return reply.send({
                success: true,
                accessKey: {
                    data: created.accessKey.data,
                    dataVersion: created.accessKey.dataVersion,
                    createdAt: created.accessKey.createdAt.getTime(),
                    updatedAt: created.accessKey.updatedAt.getTime()
                }
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to create access key: ${error}`);
            return reply.code(500).send({ error: 'Failed to create access key' });
        }
    });

    // Update Access Key API
    app.put('/v1/access-keys/:sessionId/:machineId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
                machineId: z.string()
            }),
            body: z.object({
                data: z.string(),
                expectedVersion: z.number().int().min(0)
            }),
            response: {
                200: z.union([
                    z.object({
                        success: z.literal(true),
                        version: z.number()
                    }),
                    z.object({
                        success: z.literal(false),
                        error: z.literal('version-mismatch'),
                        currentVersion: z.number(),
                        currentData: z.string()
                    })
                ]),
                404: z.object({
                    error: z.literal('Access key not found')
                }),
                500: z.object({
                    success: z.literal(false),
                    error: z.literal('Failed to update access key')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, machineId } = request.params;
        const { data, expectedVersion } = request.body;

        try {
            const updated = await inTx(tx => updateSessionMachineAccessKeyDataInTx(tx, {
                accountId: userId,
                machineId,
                sessionId,
                data,
                expectedVersion,
            }));

            if (!updated.ok) {
                if (updated.reason === "not-found") {
                    return reply.code(404).send({ error: 'Access key not found' });
                }
                return reply.code(200).send({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: updated.currentVersion,
                    currentData: updated.currentData
                });
            }

            log({ module: 'access-keys', userId, sessionId, machineId }, `Updated access key to version ${updated.version}`);

            return reply.send({
                success: true,
                version: updated.version
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to update access key: ${error}`);
            return reply.code(500).send({
                success: false,
                error: 'Failed to update access key'
            });
        }
    });
}
